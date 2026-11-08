/** Synthetic raw Git/worktree input only. No Git, filesystem, process or runtime observation. */
import {
    gitObjectID,
    sourceDigest,
    sourceFingerprintInventory,
} from '../../scripts/lib/committed-source-bridge.mjs';

export function syntheticSourceFixture() {
    const files = new Map([
        ['source.txt', { mode: '100644', bytes: Buffer.from('synthetic source bytes\n') }],
    ]);
    const objects = new Map<string, { oid: string; type: string; bytes: Buffer }>();
    const object = (type: string, bytes: Buffer) => {
        const oid = gitObjectID(type, bytes);
        objects.set(oid, { oid, type, bytes: Buffer.from(bytes) });
        return oid;
    };
    const file = files.get('source.txt')!;
    const blob = object('blob', file.bytes);
    const sourceTree = object(
        'tree',
        Buffer.concat([Buffer.from('100644 source.txt\0'), Buffer.from(blob, 'hex')]),
    );
    const sourceCommit = object(
        'commit',
        Buffer.from(
            `tree ${sourceTree}\nauthor Synthetic <fixture@example.invalid> 0 +0000\n` +
                'committer Synthetic <fixture@example.invalid> 0 +0000\n\nSynthetic source only.\n',
        ),
    );
    const expected = { sourceCommit, sourceTree };
    const index = [{ path: 'source.txt', mode: '100644', oid: blob, stage: 0 }];
    const inventory = [
        {
            path: 'source.txt',
            mode: '100644',
            blob,
            bytes: file.bytes.length,
            sha256: sourceDigest(file.bytes),
            fingerprinted: true,
        },
    ];
    const fingerprint = sourceFingerprintInventory(inventory);
    const record = {
        schemaVersion: 1,
        kind: 'committed-source-inventory',
        status: 'collected-non-qualifying-source-bridge',
        qualification: false,
        releaseAcceptance: false,
        ...expected,
        sourceFingerprint: fingerprint,
        inventorySHA256: sourceDigest(JSON.stringify(inventory)),
        fileCount: 1,
        fingerprintedFileCount: 1,
        worktreePasses: 2,
        modeEvidence: 'git-owner-executable-bit',
        scope: 'Observed checkout/index/bytes mapped to supplied immutable Git identities; no artifact or release verdict.',
        inventory,
    };
    const calls = { state: 0, objects: 0, entries: 0, file: 0 };
    const provider = {
        async state() {
            calls.state++;
            return { ...expected, index: index.map((item) => ({ ...item })) };
        },
        async objects(ids: string[]) {
            calls.objects++;
            return ids.map((id) => {
                const item = objects.get(id);
                if (!item) throw Error('Missing synthetic Git object.');
                return { ...item, bytes: Buffer.from(item.bytes) };
            });
        },
        async entries(relative: string) {
            calls.entries++;
            const prefix = relative ? relative + '/' : '';
            const entries = new Map<string, string>();
            for (const full of files.keys()) {
                if (!full.startsWith(prefix)) continue;
                const rest = full.slice(prefix.length),
                    slash = rest.indexOf('/');
                entries.set(
                    slash < 0 ? rest : rest.slice(0, slash),
                    slash < 0 ? 'file' : 'directory',
                );
            }
            return [...entries].map(([name, kind]) => ({ name, kind }));
        },
        async file(relative: string) {
            calls.file++;
            const item = files.get(relative);
            if (!item) throw Error('Missing synthetic source file.');
            return { mode: item.mode, bytes: Buffer.from(item.bytes) };
        },
    };
    return { expected, provider, record, fingerprint, files, objects, index, calls };
}
