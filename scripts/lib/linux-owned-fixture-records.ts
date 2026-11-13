/** Captured-data checks only. No IO, clocks, command ports or context authority. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
    validateInstallationManifest,
    validateInstallationRecord,
} from '../../shared/installation.ts';

const need = (value: unknown, code: string) => {
    if (!value) throw Error(code);
};
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const fixtureA = '0.6.0-qualification.0',
    fixtureB = '0.6.0',
    fixtureC = '0.6.1-qualification.0';
export function fixtureArguments(args: string[]) {
    const value: Record<string, string> = {},
        keys = ['a-appdir', 'a-archive', 'b-appdir', 'b-archive', 'fixture-root'];
    for (let at = 0; at < args.length; at += 2) {
        const key = args[at]?.slice(2),
            selected = args[at + 1];
        need(
            args[at]?.startsWith('--') &&
                (keys.includes(key) || ['c-appdir', 'c-archive', 'scenario'].includes(key)) &&
                !Object.hasOwn(value, key) &&
                typeof selected === 'string' &&
                (key === 'scenario'
                    ? ['current-b', 'current-b-with-c'].includes(selected)
                    : selected.startsWith('/') &&
                      !selected.endsWith('/') &&
                      selected.length <= 220 &&
                      path.posix.normalize(selected) === selected &&
                      !/[\\\x00-\x1f\x7f]/.test(selected)),
            'FIXTURE_ARGUMENT',
        );
        value[key] = selected;
    }
    if (value.scenario === 'current-b-with-c') keys.push('c-appdir', 'c-archive');
    need(
        keys.every((key) => Object.hasOwn(value, key)) &&
            Object.keys(value).length ===
                keys.length + (Object.hasOwn(value, 'scenario') ? 1 : 0) &&
            new Set(keys.map((key) => value[key])).size === keys.length,
        'FIXTURE_ARGUMENT',
    );
    return Object.freeze(value);
}
export function fixtureReview(
    text: string,
    operation: string,
    target: string,
    version: string,
    appData: string,
) {
    const lines = text.replace(/\r\n/g, '\n'),
        prefix =
            '\nDiagnostic Hub Linux setup\nOperation: ' +
            operation +
            '\nApplication: ' +
            target +
            '\nCandidate version: ' +
            version +
            '\nInstalled version: ',
        installed =
            operation === 'install'
                ? 'none'
                : version === fixtureC && operation === 'update'
                  ? fixtureB
                  : fixtureB === version
                    ? operation === 'update'
                        ? fixtureA
                        : fixtureB
                    : fixtureA,
        tail =
            '\nPrevious payloads are retained. No Finalize or removal is performed.\nType "apply menu" or "apply no-menu" to apply this operation; Enter/cancel leaves everything unchanged: ',
        before = prefix + installed + '\nSettings/reports: ' + appData + '/DiagnosticHub/profiles/';
    if (!lines.startsWith(before)) return false;
    const rest = lines.slice(before.length);
    return (
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(rest) &&
        rest.slice(36) === tail
    );
}
export function fixturePayloadMetadata(
    originalManifest: Buffer,
    originalRecord: Buffer,
    originalOwner: Buffer,
    expected: unknown,
    target: string,
) {
    const manifest = validateInstallationManifest(JSON.parse(originalManifest.toString('utf8'))),
        record = validateInstallationRecord(JSON.parse(originalRecord.toString('utf8'))),
        owned = JSON.parse(originalOwner.toString('utf8'));
    need(JSON.stringify(manifest) === JSON.stringify(expected), 'FIXTURE_INSTALLED_MANIFEST');
    need(
        record.profile === 'dedicated' && record.manifestSHA256 === sha(originalManifest),
        'FIXTURE_INSTALLED_RECORD',
    );
    need(
        owned.root === target &&
            owned.installationId === record.installationId &&
            Array.isArray(owned.integrations) &&
            owned.integrations.length === 0 &&
            owned.options &&
            Object.keys(owned.options).sort().join(',') === 'desktop,launch,startMenu' &&
            Object.values(owned.options).every((x) => x === false),
        'FIXTURE_OWNED_SCOPE',
    );
    return { manifest, record };
}
export function fixtureEnvelopeInventory(plan: any, observed: any) {
    const expected = [
        ...plan.files.map((file: any) => ({
            path: 'app/' + file.path,
            bytes: file.bytes,
            sha256: file.sha256,
            mode: file.mode,
        })),
        {
            path: 'diagnostic-hub-setup-payload.json',
            bytes: Buffer.byteLength(plan.descriptor),
            sha256: plan.descriptorSHA256,
            mode: 0o600,
        },
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    need(
        JSON.stringify(
            observed.files.map((file: any) => ({
                path: file.path,
                bytes: file.bytes,
                sha256: file.sha256,
                mode: file.mode,
            })),
        ) === JSON.stringify(expected),
        'FIXTURE_RETAINED_COPY_CHANGED',
    );
}
export type FixtureEntry = {
    path: string;
    kind: 'file' | 'directory';
    dev: number;
    ino: number;
    uid: number;
    mode: number;
    bytes?: number;
    sha256?: string;
};
export type FixtureLedger = { entries: FixtureEntry[]; anchor: FixtureEntry };
export const fixtureLedgerFiles = [
    'original-completed-journal.json',
    'original-journal.json',
    'seal-intent.json',
    'snapshot.json',
    'state.json',
    'unconfirmed-journal.json',
] as const;
export const fixtureSnapshotCap = 4 * 1024 ** 2 * 6 + 131072;
export function fixturePayloadInventory(manifest: any, plan: any, observed: any) {
    const expected = [
        ...manifest.files.map((f: any) => f.path),
        '.diagnostic-hub-release.json',
        '.diagnostic-hub-installation.json',
        '.diagnostic-hub-ownership.json',
    ].sort();
    need(
        JSON.stringify(observed.files.map((x: any) => x.path)) === JSON.stringify(expected),
        'FIXTURE_COMPLETE_INSTALLED_TREE',
    );
    need(
        JSON.stringify(observed.directories.map((x: any) => x.path)) ===
            JSON.stringify(['app', ...plan.directories.map((x: string) => 'app/' + x)].sort()) &&
            observed.directories.every((x: any) => x.mode === 0o700),
        'FIXTURE_COMPLETE_INSTALLED_DIRECTORIES',
    );
    for (const f of manifest.files) {
        if (f.kind !== 'file') throw Error('FIXTURE_REGULAR_PAYLOAD');
        const actual = observed.files.find((x: any) => x.path === f.path)!;
        const source = plan.files.find((x: any) => 'app/' + x.path === f.path);
        need(
            source &&
                actual.bytes === f.bytes &&
                actual.sha256 === f.sha256 &&
                actual.mode === source.mode,
            'FIXTURE_INSTALLED_PAYLOAD',
        );
    }
}
export function fixtureRecordedEntry(name: string, info: any, raw?: Buffer): FixtureEntry {
    return {
        path: name,
        kind: raw ? 'file' : 'directory',
        dev: info.dev,
        ino: info.ino,
        uid: info.uid,
        mode: info.mode,
        ...(raw ? { bytes: raw.length, sha256: sha(raw) } : {}),
    };
}
const keys = (value: any, names: string[]) =>
    need(
        value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).sort().join(',') === names.sort().join(','),
        'FIXTURE_RECORD_KEYS',
    );
export function fixtureCompact(raw: Buffer, cap: number): any {
    need(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= cap, 'FIXTURE_RECORD_BOUND');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    need(Buffer.from(JSON.stringify(value)).equals(raw), 'FIXTURE_RECORD_PARTIAL');
    return value;
}
export function fixtureRemovalRecords(
    raw: Buffer,
    progressRaw: Buffer,
    expected: {
        root: string;
        uid: number;
        transactionId: string;
        confirmed: Buffer;
        current: FixtureLedger;
        parent: FixtureLedger;
        manifest: Buffer;
        record: Buffer;
        owner: Buffer;
    },
) {
    const saved = fixtureCompact(raw, fixtureSnapshotCap),
        progress = fixtureCompact(progressRaw, 8192);
    keys(saved, [
        'schemaVersion',
        'root',
        'host',
        'removalOwner',
        'initial',
        'entries',
        'maintenance',
        'originals',
        'confirmedCleanup',
    ]);
    keys(progress, ['schemaVersion', 'snapshotSHA256', 'phase', 'index', 'leaf']);
    need(
        saved.schemaVersion === 1 &&
            saved.root === expected.root &&
            saved.host.uid === expected.uid &&
            saved.initial.journal.transactionId === expected.transactionId &&
            JSON.stringify(saved.initial.journal) === expected.confirmed.toString('utf8') &&
            JSON.stringify(saved.confirmedCleanup) ===
                JSON.stringify({ ...expected.current, parent: expected.parent }) &&
            progress.schemaVersion === 1 &&
            progress.snapshotSHA256 === sha(raw) &&
            progress.phase === 'complete' &&
            Array.isArray(saved.entries) &&
            saved.entries.length > 0 &&
            saved.entries.length <= 20010 &&
            progress.index === saved.entries.length &&
            progress.leaf === 'source',
        'FIXTURE_C_UNINSTALL_RECORD',
    );
    need(
        Array.isArray(saved.originals) && saved.originals.length === 3,
        'FIXTURE_C_UNINSTALL_ORIGINALS',
    );
    for (const [name, bytes] of [
        ['.diagnostic-hub-release.json', expected.manifest],
        ['.diagnostic-hub-installation.json', expected.record],
        ['.diagnostic-hub-ownership.json', expected.owner],
    ] as const) {
        const found = saved.originals.filter((item: any) => item.path === name);
        need(
            found.length === 1 &&
                found[0].base64 === bytes.toString('base64') &&
                found[0].sha256 === sha(bytes),
            'FIXTURE_C_UNINSTALL_ORIGINALS',
        );
    }
    return { snapshotSHA256: sha(raw), state: progress };
}
export function fixturePublishedSeal(input: {
    records: Record<string, Buffer>;
    entries: FixtureEntry[];
    anchor: { entry: FixtureEntry; raw: Buffer };
    root: string;
    uid: number;
    installationId: string;
    transactionId: string;
    candidate: Buffer;
    completed: Buffer;
    parent?: FixtureLedger;
    parentSnapshotSHA256?: string;
}): FixtureLedger {
    const {
        records,
        entries,
        anchor,
        root,
        uid,
        installationId,
        transactionId,
        candidate,
        completed,
        parent,
    } = input;
    need(entries.length === 8, 'FIXTURE_SEAL_CENSUS');
    const seen = new Set<string>();
    for (const [at, item] of entries.entries()) {
        const file = at < 6;
        keys(item, [
            'path',
            'kind',
            'dev',
            'ino',
            'uid',
            'mode',
            ...(file ? ['bytes', 'sha256'] : []),
        ]);
        need(
            item.path === [...fixtureLedgerFiles, 'disposal', ''][at] &&
                item.kind === (file ? 'file' : 'directory') &&
                Number.isSafeInteger(item.dev) &&
                item.dev >= 0 &&
                Number.isSafeInteger(item.ino) &&
                item.ino > 0 &&
                item.uid === uid &&
                item.mode === (file ? 0o100600 : 0o40700) &&
                !seen.has(item.dev + ':' + item.ino),
            'FIXTURE_SEAL_ENTRY',
        );
        seen.add(item.dev + ':' + item.ino);
        if (file) {
            const raw = records[item.path],
                cap = item.path === 'snapshot.json' ? fixtureSnapshotCap : 8192;
            need(
                Buffer.isBuffer(raw) &&
                    raw.length > 0 &&
                    raw.length <= cap &&
                    item.bytes === raw.length &&
                    item.sha256 === sha(raw),
                'FIXTURE_SEAL_BYTES',
            );
        }
    }
    const snapshot = fixtureCompact(records['snapshot.json'], fixtureSnapshotCap),
        state = fixtureCompact(records['state.json'], 8192),
        intent = fixtureCompact(records['seal-intent.json'], 8192),
        original = fixtureCompact(candidate, 8192),
        prior = fixtureCompact(completed, 8192),
        confirmed = Buffer.from(JSON.stringify({ ...original, phase: 'candidate-confirmed' }));
    keys(snapshot, [
        'schemaVersion',
        'configuration',
        'initial',
        'entries',
        'originals',
        ...(parent ? ['parent'] : []),
    ]);
    need(
        snapshot.schemaVersion === 1 &&
            snapshot.configuration.root === root &&
            snapshot.configuration.host.uid === uid &&
            snapshot.configuration.transactionId === transactionId &&
            snapshot.configuration.installationId === installationId &&
            Array.isArray(snapshot.entries) &&
            snapshot.entries.length > 0 &&
            snapshot.entries.length <= 20010 &&
            JSON.stringify(snapshot.initial.journal) === JSON.stringify(original) &&
            snapshot.initial.history.journalOriginal.base64 === candidate.toString('base64') &&
            snapshot.initial.history.journalOriginal.sha256 === sha(candidate) &&
            snapshot.initial.history.completed.base64 === completed.toString('base64') &&
            snapshot.initial.history.completed.sha256 === sha(completed) &&
            original.root === root &&
            original.uid === uid &&
            original.installationId === installationId &&
            original.transactionId === transactionId &&
            original.phase === 'candidate-active' &&
            prior.root === root &&
            prior.uid === uid &&
            prior.installationId === installationId,
        'FIXTURE_SEAL_SNAPSHOT',
    );
    need(
        parent
            ? JSON.stringify(snapshot.parent) === JSON.stringify(parent) &&
                  snapshot.initial.history.cleanup?.snapshotSHA256 === input.parentSnapshotSHA256 &&
                  !snapshot.initial.history.cleanup?.initial?.history?.cleanup
            : !snapshot.initial.history.cleanup,
        'FIXTURE_SEAL_PARENT',
    );
    keys(state, ['schemaVersion', 'snapshotSHA256', 'phase', 'index', 'leaf']);
    need(
        state.schemaVersion === 1 &&
            state.snapshotSHA256 === sha(records['snapshot.json']) &&
            state.phase === 'complete' &&
            state.index === snapshot.entries.length &&
            state.leaf === 'source',
        'FIXTURE_SEAL_INCOMPLETE',
    );
    keys(intent, [
        'schemaVersion',
        'root',
        'installationId',
        'transactionId',
        'uid',
        'snapshotSHA256',
        'original',
        'staged',
    ]);
    need(
        intent.schemaVersion === 1 &&
            intent.root === root &&
            intent.installationId === installationId &&
            intent.transactionId === transactionId &&
            intent.uid === uid &&
            intent.snapshotSHA256 === state.snapshotSHA256,
        'FIXTURE_SEAL_INTENT',
    );
    const stable = (value: FixtureEntry) => {
        const { path: _path, ...rest } = value;
        return rest;
    };
    keys(anchor.entry, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
    need(
        anchor.entry.path === (parent ? 'journal.json' : 'completed-journal.json') &&
            anchor.entry.kind === 'file' &&
            anchor.entry.uid === uid &&
            anchor.entry.mode === 0o100600 &&
            ['dev', 'ino'].every((k) => Number.isSafeInteger(anchor.entry[k as 'dev' | 'ino'])) &&
            anchor.entry.dev >= 0 &&
            anchor.entry.ino > 0 &&
            !seen.has(anchor.entry.dev + ':' + anchor.entry.ino) &&
            anchor.entry.bytes === confirmed.length &&
            anchor.entry.sha256 === sha(confirmed) &&
            anchor.raw.equals(confirmed),
        'FIXTURE_SEAL_ANCHOR',
    );
    for (const [name, wanted] of [
        ['original-journal.json', candidate],
        ['unconfirmed-journal.json', candidate],
        ['original-completed-journal.json', completed],
    ] as const)
        need(records[name].equals(wanted), 'FIXTURE_SEAL_ORIGINAL');
    keys(intent.original, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
    keys(intent.staged, ['path', 'kind', 'dev', 'ino', 'uid', 'mode', 'bytes', 'sha256']);
    need(
        intent.original.path === 'journal.json' &&
            intent.staged.path === 'confirmed-journal.json' &&
            JSON.stringify(stable(intent.original)) === JSON.stringify(stable(entries[5])) &&
            JSON.stringify(stable(intent.staged)) === JSON.stringify(stable(anchor.entry)),
        'FIXTURE_SEAL_INODE',
    );
    if (parent)
        need(
            JSON.stringify(stable(parent.anchor)) === JSON.stringify(stable(entries[0])),
            'FIXTURE_SEAL_PARENT_ANCHOR',
        );
    return { entries, anchor: anchor.entry };
}
