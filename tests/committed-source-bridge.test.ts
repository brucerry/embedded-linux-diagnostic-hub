import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
    observeSourceBridge,
    verifySourceBridge,
    validateSourceBridge,
    verifyAndBindDiagnosticSource,
    sourceFingerprintInventory,
    sourceDigest,
    gitObjectID,
    parseSourceBridge,
    SOURCE_LIMITS,
    SOURCE_EXCLUSIONS,
} from '../scripts/lib/committed-source-bridge.mjs';
import {
    readStableSourceFile,
    writeSourceBridge,
    localSourceProvider,
} from '../scripts/lib/committed-source-provider.mjs';
import { createSourceBinding } from '../scripts/lib/product-supervisor-contract.mjs';

type File = { bytes: Buffer; mode: string };
function fixture(
    input: Record<string, string | { text: string; mode: string }> = {
        'a/x': 'directory-first',
        'a-z': 'file-second',
        'normal.txt': 'source',
    },
) {
    const committed = new Map<string, File>(
        Object.entries(input).map(([p, text]) => [
            p,
            {
                bytes: Buffer.from(typeof text === 'string' ? text : text.text),
                mode: typeof text === 'string' ? '100644' : text.mode,
            },
        ]),
    );
    const files = new Map(
        [...committed].map(([p, row]) => [p, { ...row, bytes: Buffer.from(row.bytes) }]),
    );
    const objects = new Map<string, { oid: string; type: string; bytes: Buffer }>();
    const object = (type: string, bytes: Buffer) => {
        const oid = gitObjectID(type, bytes);
        objects.set(oid, { oid, type, bytes });
        return oid;
    };
    const index: { path: string; mode: string; oid: string; stage: number }[] = [];
    function tree(prefix: string): string {
        const names = new Map<string, { directory: boolean; mode: string; oid?: string }>();
        for (const [full, row] of committed) {
            if (!full.startsWith(prefix)) continue;
            const rest = full.slice(prefix.length),
                slash = rest.indexOf('/');
            if (slash >= 0) names.set(rest.slice(0, slash), { directory: true, mode: '40000' });
            else {
                const oid = object('blob', row.bytes);
                index.push({ path: full, mode: row.mode, oid, stage: 0 });
                names.set(rest, { directory: false, mode: row.mode, oid });
            }
        }
        const entries = [...names].map(([name, row]) => ({
            name,
            mode: row.mode,
            oid: row.directory ? tree(prefix + name + '/') : row.oid!,
        }));
        entries.sort((a, b) =>
            Buffer.compare(
                Buffer.from(a.name + (a.mode === '40000' ? '/' : '\0')),
                Buffer.from(b.name + (b.mode === '40000' ? '/' : '\0')),
            ),
        );
        return object(
            'tree',
            Buffer.concat(
                entries.map((entry) =>
                    Buffer.concat([
                        Buffer.from(entry.mode + ' ' + entry.name + '\0'),
                        Buffer.from(entry.oid, 'hex'),
                    ]),
                ),
            ),
        );
    }
    const sourceTree = tree('');
    const commit = (root: string, extra = '') =>
        object(
            'commit',
            Buffer.from(
                `tree ${root}\n${extra}author Synthetic <fixture@example.invalid> 0 +0000\ncommitter Synthetic <fixture@example.invalid> 0 +0000\n\nSynthetic only.\n`,
            ),
        );
    const expected = { sourceCommit: commit(sourceTree), sourceTree };
    const kinds = new Map<string, string>(),
        calls = { state: 0, files: 0 };
    let stateHook: (() => void) | undefined,
        fileHook: ((relative: string, count: number) => void) | undefined;
    const provider = {
        async state() {
            calls.state++;
            stateHook?.();
            return { ...expected, index: structuredClone(index) };
        },
        async objects(ids: string[]) {
            return ids.map((oid) => {
                const value = objects.get(oid);
                if (!value) throw Error('missing object');
                return { ...value, bytes: Buffer.from(value.bytes) };
            });
        },
        async entries(relative: string) {
            const prefix = relative ? relative + '/' : '',
                entries = new Map<string, string>();
            for (const full of files.keys()) {
                if (!full.startsWith(prefix)) continue;
                const rest = full.slice(prefix.length),
                    slash = rest.indexOf('/');
                entries.set(
                    slash < 0 ? rest : rest.slice(0, slash),
                    slash < 0 ? 'file' : 'directory',
                );
            }
            return [...entries].map(([name, kind]) => ({
                name,
                kind: kinds.get(prefix + name) ?? kind,
            }));
        },
        async file(relative: string) {
            const file = files.get(relative);
            if (!file) throw Error('missing file');
            const result = { mode: file.mode, bytes: Buffer.from(file.bytes) };
            calls.files++;
            fileHook?.(relative, calls.files);
            return result;
        },
    };
    return {
        expected,
        provider,
        files,
        committed,
        objects,
        index,
        kinds,
        calls,
        object,
        commit,
        stateHook: (hook: () => void) => {
            stateHook = hook;
        },
        fileHook: (hook: (p: string, count: number) => void) => {
            fileHook = hook;
        },
    };
}
async function legacyFingerprint(f: ReturnType<typeof fixture>) {
    const file = path.resolve('tests/fixtures/memory-resource-identity.ts');
    const source = fs
        .readFileSync(file, 'utf8')
        .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href));
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const module = { exports: {} as any },
        root = '/synthetic-source';
    const realRequire = createRequire(import.meta.url);
    const fake = {
        readdir: async (full: string) =>
            (await f.provider.entries(full === root ? '' : full.slice(root.length + 1))).map(
                (item) => ({
                    name: item.name,
                    isSymbolicLink: () => item.kind === 'symlink',
                    isDirectory: () => item.kind === 'directory',
                }),
            ),
        readFile: async (full: string) => f.files.get(full.slice(root.length + 1))!.bytes,
    };
    const context = vm.createContext({ Buffer, process: { argv: [] }, console });
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context)(
        (id: string) => (id === 'node:fs/promises' ? fake : realRequire(id)),
        module,
        module.exports,
    );
    return module.exports.sourceFingerprint(root);
}

test('immutable Git closure, exact index and two worktree passes produce only a diagnostic bridge', async () => {
    const f = fixture(),
        record = await observeSourceBridge(f.expected, f.provider);
    assert.equal(record.qualification, false);
    assert.equal(record.releaseAcceptance, false);
    assert.equal(record.fileCount, 3);
    assert.equal(f.calls.files, 6);
    assert.equal(f.calls.state, 3);
    assert.equal(record.sourceFingerprint, await legacyFingerprint(f));
    await verifySourceBridge(record, f.expected, f.provider);
    const binding = createSourceBinding({
        ...f.expected,
        sourceBridgeSHA256: sourceDigest(JSON.stringify(record) + '\n'),
        sourceSHA256: record.sourceFingerprint,
        jobNonce: '11111111-1111-1111-1111-111111111111',
        adapterSHA256: 'a'.repeat(64),
        observerSHA256: 'b'.repeat(64),
        lane: 'gateway',
        gcMode: 'normal',
        viewer: false,
        component: false,
        calibration: false,
    });
    const combined = await verifyAndBindDiagnosticSource(record, binding, f.expected, f.provider);
    assert.equal(combined.qualification, false);
    assert.equal(combined.sourceCommit, f.expected.sourceCommit);
    await assert.rejects(
        verifyAndBindDiagnosticSource(
            record,
            { ...binding, sourceSHA256: 'c'.repeat(64) },
            f.expected,
            f.provider,
        ),
    );
});

test('fingerprint preserves DFS/UTF16 ordering and basename exclusions exactly', async () => {
    const f = fixture({
        'a/x': 'one',
        'a-z': 'two',
        '\u{10000}': 'surrogate-first',
        '\ue000': 'bmp-second',
        'validation/kept': 'tracked-excluded',
        'nested/dist': 'excluded-file',
        'nested/test-results/log': 'tracked-excluded-too',
        'nested/visible': 'included',
    });
    f.files.set('node_modules', { mode: '100644', bytes: Buffer.from('unobserved') });
    f.kinds.set('node_modules', 'symlink');
    f.files.set('nested/dist-web/generated', { mode: '100644', bytes: Buffer.from('unobserved') });
    const record = await observeSourceBridge(f.expected, f.provider);
    assert.equal(record.sourceFingerprint, await legacyFingerprint(f));
    assert.equal(record.fileCount, 8);
    assert.equal(record.fingerprintedFileCount, 5);
    const flat = record.inventory
        .filter((item: any) => item.fingerprinted)
        .map((item: any) => item.path + '\0' + item.sha256 + '\n')
        .join('');
    assert.notEqual(record.sourceFingerprint, sourceDigest(flat));
});

test('every excluded basename remains ignored at root and nested depth while executable/empty files are inventoried', async () => {
    const f = fixture({
        visible: 'source',
        'nested/visible': 'nested',
        executable: { text: '', mode: '100755' },
    });
    for (const item of SOURCE_EXCLUSIONS) {
        f.files.set(item + '/untracked', {
            mode: '100644',
            bytes: Buffer.from('outside observation'),
        });
        f.files.set('nested/' + item + '/untracked', {
            mode: '100644',
            bytes: Buffer.from('outside observation'),
        });
    }
    const record = await observeSourceBridge(f.expected, f.provider);
    assert.equal(record.sourceFingerprint, await legacyFingerprint(f));
    assert.equal(record.fileCount, 3);
    assert.equal(record.fingerprintedFileCount, 3);
    assert.equal(record.inventory.find((row: any) => row.path === 'executable')?.mode, '100755');
    assert.equal(Object.isFrozen(record.inventory), true);
    assert.equal(Object.isFrozen(record), true);
});

for (const mode of [
    'same-size-dirty',
    'crlf',
    'missing',
    'extra-ignored-by-git-only',
    'extra-directory',
    'executable',
    'symlink',
    'special',
    'directory-alias',
    'excluded-dirty',
    'excluded-missing',
    'staged',
    'unmerged',
    'missing-index',
]) {
    test('source refuses ' + mode, async () => {
        const f = fixture({
            normal: 'source',
            'dir/file': 'data',
            'validation/tracked': 'excluded',
        });
        if (mode === 'same-size-dirty') f.files.get('normal')!.bytes = Buffer.from('forged');
        if (mode === 'crlf') f.files.get('normal')!.bytes = Buffer.from('source\r\n');
        if (mode === 'missing') f.files.delete('normal');
        if (mode === 'extra-ignored-by-git-only')
            f.files.set('ignored.log', { mode: '100644', bytes: Buffer.from('extra') });
        if (mode === 'extra-directory')
            f.provider.entries = async (relative) =>
                relative ? [] : [{ name: 'empty-extra', kind: 'directory' }];
        if (mode === 'executable') f.files.get('normal')!.mode = '100755';
        if (mode === 'symlink' || mode === 'special') f.kinds.set('normal', mode);
        if (mode === 'directory-alias') f.kinds.set('dir', 'symlink');
        if (mode === 'excluded-dirty')
            f.files.get('validation/tracked')!.bytes = Buffer.from('changed');
        if (mode === 'excluded-missing') f.files.delete('validation/tracked');
        if (mode === 'staged') f.index[0].oid = 'a'.repeat(40);
        if (mode === 'unmerged') f.index[0].stage = 2;
        if (mode === 'missing-index') f.index.pop();
        await assert.rejects(observeSourceBridge(f.expected, f.provider));
    });
}

test('source changed between passes or index snapshots cannot become a bridge', async () => {
    const f = fixture();
    f.stateHook(() => {
        if (f.calls.state === 2) f.files.get('normal.txt')!.bytes = Buffer.from('late change');
    });
    await assert.rejects(observeSourceBridge(f.expected, f.provider), /Dirty source/);
    const g = fixture();
    g.stateHook(() => {
        if (g.calls.state === 3) g.index[0].stage = 1;
    });
    await assert.rejects(observeSourceBridge(g.expected, g.provider), /Unmerged/);
    const h = fixture();
    const state = h.provider.state;
    h.provider.state = async () => ({ ...(await state()), sourceCommit: 'e'.repeat(40) });
    await assert.rejects(observeSourceBridge(h.expected, h.provider), /HEAD/);
});

for (const mode of [
    'object-bytes',
    'object-type',
    'object-id',
    'missing-object',
    'swapped-tree',
    'duplicate-tree-header',
]) {
    test('raw Git identity refuses ' + mode, async () => {
        const f = fixture();
        const commit = f.objects.get(f.expected.sourceCommit)!;
        if (mode === 'object-bytes')
            commit.bytes = Buffer.from(
                commit.bytes.toString().replace('Synthetic only.', 'Changed commit message.'),
            );
        if (mode === 'object-type') commit.type = 'blob';
        if (mode === 'object-id') commit.oid = 'e'.repeat(40);
        if (mode === 'missing-object') f.objects.delete(f.expected.sourceCommit);
        if (mode === 'swapped-tree') f.expected.sourceTree = 'e'.repeat(40);
        if (mode === 'duplicate-tree-header')
            f.expected.sourceCommit = f.commit(
                f.expected.sourceTree,
                'tree ' + f.expected.sourceTree + '\n',
            );
        await assert.rejects(observeSourceBridge(f.expected, f.provider));
    });
}

test('malformed, ambiguous, unsupported and noncanonical Git tree entries are refused even with valid object hashes', async () => {
    for (const raw of [
        Buffer.from('100644 truncated'),
        Buffer.concat([Buffer.from('120000 link\0'), Buffer.alloc(20)]),
        Buffer.concat([Buffer.from('160000 submodule\0'), Buffer.alloc(20)]),
        Buffer.concat([Buffer.from('100644 ../escape\0'), Buffer.alloc(20)]),
        Buffer.concat([Buffer.from('100644 back\\slash\0'), Buffer.alloc(20)]),
        Buffer.concat([Buffer.from('100644 '), Buffer.from([0xff, 0]), Buffer.alloc(20)]),
        Buffer.concat([
            Buffer.from('100644 a\0'),
            Buffer.alloc(20),
            Buffer.from('100644 a\0'),
            Buffer.alloc(20),
        ]),
        Buffer.concat([
            Buffer.from('100644 A\0'),
            Buffer.alloc(20),
            Buffer.from('100644 a\0'),
            Buffer.alloc(20),
        ]),
        Buffer.concat([
            Buffer.from('100644 z\0'),
            Buffer.alloc(20),
            Buffer.from('100644 a\0'),
            Buffer.alloc(20),
        ]),
    ]) {
        const f = fixture();
        f.expected.sourceTree = f.object('tree', raw);
        f.expected.sourceCommit = f.commit(f.expected.sourceTree);
        await assert.rejects(observeSourceBridge(f.expected, f.provider));
    }
});

test('schema self-consistency cannot replace independent raw Git/worktree verification', async () => {
    const f = fixture(),
        original = await observeSourceBridge(f.expected, f.provider),
        forged = JSON.parse(JSON.stringify(original));
    forged.inventory[0].sha256 = 'a'.repeat(64);
    forged.sourceFingerprint = sourceFingerprintInventory(forged.inventory);
    forged.inventorySHA256 = sourceDigest(JSON.stringify(forged.inventory));
    validateSourceBridge(forged, f.expected);
    await assert.rejects(
        verifySourceBridge(forged, f.expected, f.provider),
        /independently observed/,
    );
    for (const update of [
        { qualification: true },
        { releaseAcceptance: true },
        { schemaVersion: 2 },
        { extra: true },
        { sourceCommit: 'e'.repeat(40) },
    ])
        assert.throws(() => validateSourceBridge({ ...original, ...update }, f.expected));
    await assert.rejects(
        observeSourceBridge({ sourceCommit: undefined, sourceTree: undefined }, f.provider),
    );
    const bytes = Buffer.from(JSON.stringify(original) + '\n');
    assert.equal(parseSourceBridge(bytes).qualification, false);
    for (const bad of [
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
        Buffer.from('{"x":1,"x":2}\n'),
        Buffer.from(' {"x":1}\n'),
        Buffer.from([0xff]),
    ])
        assert.throws(() => parseSourceBridge(bad));
});

function memoryFs() {
    let bytes = Buffer.from('source'),
        sequence = 0,
        position = 0;
    const calls: string[] = [],
        hooks = new Map<string, () => void>();
    const created = new Set<string>();
    const state = {
        ino: 1,
        mode: 0o100644,
        nlink: 1,
        mtimeMs: 1,
        ctimeMs: 1,
        symlink: false,
        directory: false,
    };
    const hit = (name: string) => {
        calls.push(name);
        hooks.get(name)?.();
    };
    const info = () => ({
        ...state,
        size: bytes.length,
        dev: 1,
        isFile: () => !state.directory,
        isDirectory: () => state.directory,
        isSymbolicLink: () => state.symlink,
    });
    const filesystem = {
        async realpath(file: string) {
            hit('realpath');
            return file;
        },
        async lstat() {
            hit('lstat');
            return info();
        },
        async mkdir() {
            state.directory = true;
        },
        async open(_file: string, flags: string) {
            hit('open');
            if (flags === 'wx') {
                if (created.has(_file)) throw Error('EEXIST');
                created.add(_file);
            }
            position = 0;
            return {
                async stat() {
                    hit('stat');
                    return info();
                },
                async read(buffer: Buffer, offset: number, length: number) {
                    hit('read');
                    const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
                    bytes.copy(buffer, offset, position, position + bytesRead);
                    position += bytesRead;
                    return { bytesRead };
                },
                async writeFile(value: string) {
                    hit('write');
                    bytes = Buffer.from(value);
                },
                async sync() {
                    hit('sync');
                },
                async close() {
                    hit('close');
                },
            };
        },
    };
    return {
        filesystem,
        hooks,
        state,
        calls,
        replace: (value: string) => {
            bytes = Buffer.from(value);
        },
    };
}
test('native byte adapter refuses aliases/races/growth and retains read/close failures', async () => {
    const good = memoryFs();
    assert.equal(
        (await readStableSourceFile('/synthetic', 'file', 100, good.filesystem)).bytes.toString(),
        'source',
    );
    for (const mode of ['symlink', 'hardlink', 'inode-race', 'mtime-race', 'growth', 'special']) {
        const f = memoryFs();
        if (mode === 'symlink') f.state.symlink = true;
        if (mode === 'hardlink') f.state.nlink = 2;
        if (mode === 'special') f.state.directory = true;
        if (mode === 'inode-race')
            f.hooks.set('open', () => {
                f.state.ino++;
            });
        if (mode === 'mtime-race')
            f.hooks.set('read', () => {
                f.state.mtimeMs++;
            });
        if (mode === 'growth') f.hooks.set('read', () => f.replace('x'.repeat(101)));
        await assert.rejects(readStableSourceFile('/synthetic', 'file', 100, f.filesystem));
    }
    const f = memoryFs(),
        first = Error('read-primary'),
        last = Error('close-secondary');
    f.hooks.set('read', () => {
        throw first;
    });
    f.hooks.set('close', () => {
        throw last;
    });
    await assert.rejects(
        readStableSourceFile('/synthetic', 'file', 100, f.filesystem),
        (e: any) => e instanceof AggregateError && e.cause === first && e.errors[1] === last,
    );
});

test('native Git mode classification uses only the owner execute bit', async () => {
    for (const [mode, expected] of [
        [0o100655, '100644'],
        [0o100654, '100644'],
        [0o100744, '100755'],
        [0o100644, '100644'],
    ] as const) {
        const f = memoryFs();
        f.state.mode = mode;
        assert.equal(
            (await readStableSourceFile('/synthetic', 'file', 100, f.filesystem)).mode,
            expected,
        );
    }
});

function gitFixture() {
    const f = fixture(),
        calls: { args: string[]; options: any }[] = [];
    let config = '',
        metadataOverride: string | undefined,
        bodyOverride: Buffer | undefined;
    const execute = (_command: string, args: string[], options: any) => {
        calls.push({ args, options });
        const rev = args.indexOf('rev-parse');
        if (rev >= 0) {
            const query = args[rev + 1];
            if (query === '--show-toplevel') return Buffer.from('/synthetic\n');
            if (query === '--show-object-format') return Buffer.from('sha1\n');
            if (query === '--show-prefix') return Buffer.from('');
            return Buffer.from(
                args.at(-1) === 'HEAD'
                    ? f.expected.sourceCommit + '\n'
                    : f.expected.sourceTree + '\n',
            );
        }
        if (args.includes('config')) return Buffer.from(config);
        if (args.includes('ls-files'))
            return Buffer.from(
                f.index
                    .map((entry) => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`)
                    .join(''),
            );
        const ids = String(options.input).trim().split('\n');
        if (args.includes('--batch-check'))
            return Buffer.from(
                metadataOverride ??
                    ids
                        .map((id) => {
                            const o = f.objects.get(id)!;
                            return `${id} ${o.type} ${o.bytes.length}\n`;
                        })
                        .join(''),
            );
        if (args.includes('--batch'))
            return (
                bodyOverride ??
                Buffer.concat(
                    ids.flatMap((id) => {
                        const o = f.objects.get(id)!;
                        return [
                            Buffer.from(`${id} ${o.type} ${o.bytes.length}\n`),
                            o.bytes,
                            Buffer.from('\n'),
                        ];
                    }),
                )
            );
        throw Error('Unexpected mocked Git operation.');
    };
    const options = {
        execute: execute as any,
        filesystem: { realpath: async (file: string) => file } as any,
        platform: 'linux' as const,
        environment: {},
    };
    return {
        ...f,
        calls,
        options,
        config: (value: string) => {
            config = value;
        },
        metadata: (value: string) => {
            metadataOverride = value;
        },
        body: (value: Buffer) => {
            bodyOverride = value;
        },
    };
}
test('local Git seam disables helpers/network and checks effective configuration and size headers before bodies', async () => {
    const f = gitFixture(),
        provider = await localSourceProvider('/synthetic', f.options);
    const state = await provider.state();
    assert.deepEqual(state.index, f.index);
    const [object] = await provider.objects([f.expected.sourceCommit]);
    assert.equal(object.oid, f.expected.sourceCommit);
    for (const { args, options } of f.calls) {
        assert.ok(args.includes('--no-replace-objects') && args.includes('--no-pager'));
        assert.ok(
            args.includes('core.fsmonitor=false') && args.includes('core.untrackedCache=false'),
        );
        assert.ok(!args.some((arg) => arg.startsWith('core.hooksPath')));
        assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
        assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(options.shell, false);
        assert.equal(options.timeout, 30000);
        assert.ok(options.maxBuffer > 0);
    }
    const config = f.calls.find((call) => call.args.includes('config'))!;
    assert.ok(config.args.includes('--includes'));
    assert.ok(!config.args.includes('--local'));
    assert.ok(
        f.calls.findIndex((call) => call.args.includes('--batch-check')) <
            f.calls.findIndex((call) => call.args.includes('--batch')),
    );
    const partial = gitFixture();
    partial.config('remote.fixture.promisor\n');
    await assert.rejects(localSourceProvider('/synthetic', partial.options), /promisor/);
    assert.ok(!partial.calls.some((call) => call.args.includes('cat-file')));
    await assert.rejects(
        localSourceProvider('/synthetic', { ...f.options, environment: { GIT_DIR: 'foreign' } }),
        /Ambient Git/,
    );
    await assert.rejects(
        localSourceProvider('/synthetic', { ...f.options, platform: 'win32' }),
        /unsupported/,
    );
});
test('Git metadata bounds, malformed bodies and subprocess failures fail before unsupported collection', async () => {
    for (const mode of [
        'blob',
        'tree',
        'commit',
        'aggregate',
        'missing',
        'truncated-body',
        'changed-body-header',
        'extra-body',
    ]) {
        const f = gitFixture(),
            provider = await localSourceProvider('/synthetic', f.options);
        let ids = [f.expected.sourceCommit];
        if (['blob', 'tree', 'commit'].includes(mode))
            f.metadata(
                `${ids[0]} ${mode} ${SOURCE_LIMITS[mode as 'blob' | 'tree' | 'commit'] + 1}\n`,
            );
        if (mode === 'aggregate') {
            ids = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(40, '0'));
            f.metadata(ids.map((id) => `${id} blob ${SOURCE_LIMITS.blob}\n`).join(''));
        }
        if (mode === 'missing') f.metadata(`${ids[0]} missing\n`);
        if (mode === 'truncated-body') f.body(Buffer.from(`${ids[0]} commit 12\nshort`));
        if (mode === 'changed-body-header') f.body(Buffer.from(`${ids[0]} blob 0\n\n`));
        if (mode === 'extra-body') {
            const o = f.objects.get(ids[0])!;
            f.body(
                Buffer.concat([
                    Buffer.from(`${o.oid} ${o.type} ${o.bytes.length}\n`),
                    o.bytes,
                    Buffer.from('\nextra'),
                ]),
            );
        }
        await assert.rejects(provider.objects(ids));
        if (['blob', 'tree', 'commit', 'aggregate', 'missing'].includes(mode))
            assert.ok(!f.calls.some((call) => call.args.includes('--batch')));
    }
    const f = gitFixture();
    await assert.rejects(
        localSourceProvider('/synthetic', {
            ...f.options,
            execute: (() => {
                throw Object.assign(Error('private stderr must not escape'), { status: 128 });
            }) as any,
        }),
        /Read-only Git operation failed/,
    );
});

test('source limits reject depth, names, file counts, aggregate bytes and oversized immutable objects', async () => {
    const deep = fixture({ ['x/'.repeat(33) + 'f']: 'x' });
    await assert.rejects(observeSourceBridge(deep.expected, deep.provider), /depth bound/);
    const long = fixture({ ['x'.repeat(256)]: 'x' });
    await assert.rejects(observeSourceBridge(long.expected, long.provider), /name byte bound/);
    const base = fixture(),
        original = await observeSourceBridge(base.expected, base.provider);
    const many = JSON.parse(JSON.stringify(original));
    many.inventory = Array.from({ length: SOURCE_LIMITS.files + 1 }, (_, i) => ({
        ...original.inventory[0],
        path: 'f' + i,
    }));
    assert.throws(() => validateSourceBridge(many, base.expected), /file bound/);
    const aggregate = JSON.parse(JSON.stringify(original));
    aggregate.inventory = Array.from({ length: 9 }, (_, i) => ({
        ...original.inventory[0],
        path: 'f' + i,
        bytes: SOURCE_LIMITS.blob,
    }));
    assert.throws(() => validateSourceBridge(aggregate, base.expected), /byte bound/);
    for (const type of ['commit', 'tree', 'blob'] as const) {
        const f = fixture();
        const id =
            type === 'commit'
                ? f.expected.sourceCommit
                : type === 'tree'
                  ? f.expected.sourceTree
                  : f.index[0].oid;
        f.objects.get(id)!.bytes = Buffer.alloc(SOURCE_LIMITS[type] + 1);
        await assert.rejects(observeSourceBridge(f.expected, f.provider), /Git object byte bound/);
    }
    assert.throws(() =>
        parseSourceBridge(
            Buffer.from(JSON.stringify({ oversized: 'x'.repeat(SOURCE_LIMITS.metadata) }) + '\n'),
        ),
    );
    const metadata = JSON.parse(JSON.stringify(original));
    const prefix = Array(16).fill('p'.repeat(250)).join('/');
    metadata.inventory = Array.from({ length: 1000 }, (_, i) => ({
        path: prefix + '/f' + String(i).padStart(4, '0'),
        mode: '100644',
        blob: gitObjectID('blob', Buffer.alloc(0)),
        bytes: 0,
        sha256: sourceDigest(''),
        fingerprinted: true,
    }));
    metadata.fileCount = 1000;
    metadata.fingerprintedFileCount = 1000;
    metadata.sourceFingerprint = sourceFingerprintInventory(metadata.inventory);
    metadata.inventorySHA256 = sourceDigest(JSON.stringify(metadata.inventory));
    assert.ok(Buffer.byteLength(JSON.stringify(metadata)) > SOURCE_LIMITS.metadata);
    assert.throws(() => validateSourceBridge(metadata, base.expected), /metadata bound/);
});

test('raw tree entry and repeated shared-subtree expansion limits are enforced before workspace reads', async () => {
    const entry = (mode: string, name: string, id: string) =>
        Buffer.concat([Buffer.from(mode + ' ' + name + '\0'), Buffer.from(id, 'hex')]);
    const f = fixture(),
        blob = f.index[0].oid;
    f.expected.sourceTree = f.object(
        'tree',
        Buffer.concat(
            Array.from({ length: SOURCE_LIMITS.entries + 1 }, (_, i) =>
                entry('100644', 'f' + String(i).padStart(5, '0'), blob),
            ),
        ),
    );
    f.expected.sourceCommit = f.commit(f.expected.sourceTree);
    await assert.rejects(observeSourceBridge(f.expected, f.provider), /Git tree entry bound/);
    const g = fixture(),
        leaf = g.object('tree', entry('100644', 'file', g.index[0].oid)),
        chain = g.object('tree', entry('40000', 'next', leaf));
    const middle = g.object(
        'tree',
        Buffer.concat(
            Array.from({ length: 100 }, (_, i) =>
                entry('40000', 'd' + String(i).padStart(3, '0'), chain),
            ),
        ),
    );
    g.expected.sourceTree = g.object(
        'tree',
        Buffer.concat(
            Array.from({ length: 100 }, (_, i) =>
                entry('40000', 'p' + String(i).padStart(3, '0'), middle),
            ),
        ),
    );
    g.expected.sourceCommit = g.commit(g.expected.sourceTree);
    await assert.rejects(observeSourceBridge(g.expected, g.provider), /closure expansion bound/);
    assert.equal(g.calls.files, 0);
});
test('exclusive source metadata write attempts sync/close and preserves primary failures', async () => {
    const f = memoryFs(),
        errors = [Error('write'), Error('sync'), Error('close')];
    ['write', 'sync', 'close'].forEach((stage, i) =>
        f.hooks.set(stage, () => {
            throw errors[i];
        }),
    );
    await assert.rejects(
        writeSourceBridge(
            '/synthetic',
            'validation/bridge.json',
            { qualification: false },
            f.filesystem,
        ),
        (e: any) => e instanceof AggregateError && e.cause === errors[0] && e.errors.length === 3,
    );
    assert.deepEqual(f.calls.slice(-3), ['write', 'sync', 'close']);
    await assert.rejects(
        writeSourceBridge(
            '/synthetic',
            'validation/bridge.json',
            { qualification: false },
            f.filesystem,
        ),
        /EEXIST/,
    );
    await assert.rejects(writeSourceBridge('/synthetic', '../foreign.json', {}, f.filesystem));
});
