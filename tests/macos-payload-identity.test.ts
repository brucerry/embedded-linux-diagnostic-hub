import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    inventoryMacPayload,
    macPayloadIdentity,
    sampleMacArchive,
    validateMacPayloadIdentity,
    validateMacInstalledPayloadSample,
    MAC_PAYLOAD_LIMITS,
} from '../scripts/lib/macos-payload-identity.mjs';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function rows() {
    return [
        ...['Contents', 'Contents/MacOS', 'Contents/Resources'].map((path) => ({
            path,
            kind: 'directory',
            mode: 0o755,
        })),
        { path: 'Contents/Info.plist', kind: 'file', bytes: 5, sha256: sha('plist'), mode: 0o644 },
        {
            path: 'Contents/MacOS/Diagnostic Hub',
            kind: 'file',
            bytes: 4,
            sha256: sha('main'),
            mode: 0o755,
        },
        {
            path: 'Contents/Resources/app.asar',
            kind: 'file',
            bytes: 4,
            sha256: sha('asar'),
            mode: 0o644,
        },
    ];
}
test('complete payload identity is stable across ordering and binds main, ASAR, modes and all named files', () => {
    const a = rows(),
        identity = macPayloadIdentity(a);
    validateMacPayloadIdentity(identity, macPayloadIdentity([...a].reverse()));
    assert.equal(identity.executableSHA256, sha('main'));
    assert.equal(identity.asarSHA256, sha('asar'));
    assert.equal(identity.bytes, 13);
    assert.equal(identity.entries, 6);
    assert.equal(identity.files, 3);
    for (const change of [
        (v: any[]) => {
            v[4].sha256 = sha('evil');
        },
        (v: any[]) => {
            v[4].mode = 0o700;
        },
        (v: any[]) => {
            v[3].bytes++;
        },
    ]) {
        const b = structuredClone(a);
        change(b);
        assert.throws(() => validateMacPayloadIdentity(macPayloadIdentity(b), identity));
    }
});
for (const [label, change] of [
    [
        'missing directory',
        (v: any[]) => {
            v.splice(0, 1);
        },
    ],
    [
        'main not executable',
        (v: any[]) => {
            v[4].mode = 0o644;
        },
    ],
    [
        'duplicate',
        (v: any[]) => {
            v.push(v[3]);
        },
    ],
    [
        'case alias',
        (v: any[]) => {
            v.push({ ...v[3], path: 'Contents/info.plist' });
        },
    ],
    [
        'escaping file',
        (v: any[]) => {
            v[3].path = '../outside';
        },
    ],
    [
        'escaping link',
        (v: any[]) => {
            v.push({ path: 'escape', kind: 'symlink', target: '../outside' });
        },
    ],
    [
        'special permission',
        (v: any[]) => {
            v[4].mode = 0o4755;
        },
    ],
    [
        'oversize file',
        (v: any[]) => {
            v[4].bytes = MAC_PAYLOAD_LIMITS.fileBytes + 1;
        },
    ],
] as const)
    test('inventory refuses ' + label, () => {
        const a = rows();
        change(a);
        assert.throws(() => macPayloadIdentity(a));
    });

async function owned(t: any) {
    const parent = await realpath(os.tmpdir()),
        root = await mkdtemp(path.join(parent, 'hub-mac-payload-'));
    t.after(async () => {
        assert.equal(path.dirname(root), parent);
        assert.ok(path.basename(root).startsWith('hub-mac-payload-'));
        await rm(root, { recursive: true });
    });
    return root;
}
async function populate(root: string) {
    await mkdir(path.join(root, 'Contents/MacOS'), { recursive: true });
    await mkdir(path.join(root, 'Contents/Resources'));
    await writeFile(
        path.join(root, 'Contents/MacOS/Diagnostic Hub'),
        'INERT_DATA_NOT_EXECUTABLE_CODE',
        { mode: 0o755 },
    );
    await writeFile(path.join(root, 'Contents/Info.plist'), 'synthetic plist data', {
        mode: 0o644,
    });
    await writeFile(path.join(root, 'Contents/Resources/app.asar'), Buffer.alloc(70001, 42), {
        mode: 0o644,
    });
}
test('real owned scratch files produce independent full-byte inventory and detect changed main bytes', async (t) => {
    const root = await owned(t),
        a = path.join(root, 'a.app'),
        b = path.join(root, 'b.app');
    await populate(a);
    await populate(b);
    const original = macPayloadIdentity(await inventoryMacPayload(a));
    validateMacPayloadIdentity(macPayloadIdentity(await inventoryMacPayload(b)), original);
    assert.equal(original.asarSHA256, sha(Buffer.alloc(70001, 42)));
    await writeFile(
        path.join(b, 'Contents/MacOS/Diagnostic Hub'),
        'ALTERED_DATA_NOT_EXECUTABLE_CODE',
    );
    const changed = macPayloadIdentity(await inventoryMacPayload(b));
    assert.notEqual(changed.inventorySHA256, original.inventorySHA256);
    assert.throws(() => validateMacPayloadIdentity(changed, original));
});
test('real archive byte sampler hashes only inert fixture bytes and joins its descriptor', async (t) => {
    const root = await owned(t),
        file = path.join(root, 'inert.zip'),
        bytes = Buffer.alloc(70001, 9);
    await writeFile(file, bytes);
    assert.deepEqual(await sampleMacArchive(file), { bytes: bytes.length, sha256: sha(bytes) });
});
test('owned safe links are inventoried as links while escaping links and hardlinked files refuse', async (t) => {
    const root = await owned(t),
        app = path.join(root, 'a.app');
    await populate(app);
    await symlink('app.asar', path.join(app, 'Contents/Resources/alias'));
    assert.equal(
        (await inventoryMacPayload(app)).find((r: any) => r.path.endsWith('/alias'))?.kind,
        'symlink',
    );
    await writeFile(path.join(root, 'outside'), 'INERT_OUTSIDE_OWNED_CANARY');
    await symlink('../outside', path.join(app, 'escape'));
    await assert.rejects(inventoryMacPayload(app), /escapes bundle/);
    // Separate fresh bundle; neither retained/user data nor the escaping-link fixture is removed early.
    const other = path.join(root, 'b.app');
    await populate(other);
    await link(path.join(other, 'Contents/Info.plist'), path.join(other, 'Contents/extra'));
    await assert.rejects(inventoryMacPayload(other));
});
function archiveIO(change: string) {
    const bytes = Buffer.from('DATA'),
        stat = () => ({
            dev: 1n,
            ino: 2n,
            size: 4n,
            mode: 0o100644n,
            nlink: 1n,
            mtimeNs: 1n,
            ctimeNs: 1n,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
        });
    let closed = 0;
    const io = {
        realpath: async (p: string) => p,
        lstat: async () => stat(),
        open: async () => ({
            stat: async () => ({ ...stat(), ino: change === 'replacement' ? 3n : 2n }),
            read: async (buffer: Buffer, offset: number, length: number, at: number) => {
                if (change === 'read-and-close') throw Error('read refused');
                if (change === 'growth') {
                    buffer.fill(1, offset, offset + length);
                    return { bytesRead: length };
                }
                const n = Math.min(length, bytes.length - at);
                bytes.copy(buffer, offset, at, at + n);
                return { bytesRead: n };
            },
            close: async () => {
                closed++;
                if (['close', 'read-and-close'].includes(change)) throw Error('close refused');
            },
        }),
    };
    return { io, closed: () => closed };
}
for (const change of ['replacement', 'growth', 'close', 'read-and-close'])
    test('descriptor failure refuses without losing close acknowledgement: ' + change, async () => {
        const f = archiveIO(change);
        await assert.rejects(sampleMacArchive('/synthetic/archive', f.io as any));
        assert.equal(f.closed(), 1);
    });
test('sample consumer binds source, archive and inventory but cannot issue native qualification', () => {
    const expected = {
        caseId: 'macos-bundle:install',
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        archive: { name: 'Diagnostic-Hub-macos-arm64.zip', bytes: 1, sha256: sha('zip') },
        payloadIdentity: macPayloadIdentity(rows()),
    };
    const value = {
        schemaVersion: 1,
        kind: 'macos-installed-payload-sample',
        ...expected,
        qualification: false,
    };
    validateMacInstalledPayloadSample(value, expected);
    for (const update of [
        { sourceCommit: 'c'.repeat(40) },
        { archive: { ...expected.archive, sha256: sha('wrong') } },
        { payloadIdentity: { ...expected.payloadIdentity, executableSHA256: sha('wrong') } },
        { qualification: true },
    ])
        assert.throws(() => validateMacInstalledPayloadSample({ ...value, ...update }, expected));
});
test('shipping producer measures input and extracted archive, then publishes identity only after equality and final hash', async () => {
    const source = await readFile('scripts/package-macos.mjs', 'utf8');
    const input = source.indexOf('const originalPayload ='),
        archive = source.indexOf("execFileSync('/usr/bin/ditto'"),
        extract = source.indexOf("['-x', '-k', destination, roundtrip]"),
        compare = source.search(/assert\.deepEqual\(\s*payloadIdentity,\s*originalPayload/),
        publish = source.indexOf('manifest.payloadIdentity =');
    assert.ok(
        input > 0 && input < archive && archive < extract && extract < compare && compare < publish,
    );
    assert.ok(source.includes('await sampleMacArchive(destination)'));
    assert.ok(
        source.indexOf("await writeFile(\n    path.resolve('release', macManifest(arch))") >
            publish,
    );
});
