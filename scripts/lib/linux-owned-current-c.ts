/** Fixed C continuation. Only the producer's captured operations touch the host or mint results. */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
    fixturePublishedSeal,
    fixtureRemovalRecords,
    fixtureRecordedEntry,
    fixtureLedgerFiles,
    fixtureSnapshotCap,
    fixtureB,
    fixtureC,
    type FixtureEntry,
} from './linux-owned-fixture-records.ts';
import type { LinuxOwnedCurrentBFixtureContext } from '../linux-owned-installation-fixture.ts';

export interface LinuxOwnedCurrentCFixtureContext {
    host: LinuxOwnedCurrentBFixtureContext['host'];
    root: string;
    appData: string;
    dataHome: string;
    sourceCommit: string;
    runId: string;
    runAttempt: string;
    readonly deadlineMs: number;
    copies: unknown;
    records: unknown;
    revalidateCopies(): void;
    capturePublishedC(): unknown;
    revalidateAfterUninstall(): unknown;
    writeSecondSealUninstallRecord(value: Buffer): { path: string; bytes: number; sha256: string };
}

/** Captured original-owner services for this one fixed fixture. No default host ports exist. */
export interface OwnedCurrentCServices {
    fixtureRoot: string;
    root: string;
    work: string;
    appData: string;
    uid: number;
    installationId: string;
    transactionB: string;
    sourceCommit: string;
    runId: string;
    runAttempt: string;
    gate(): void;
    checked<T>(call: () => T): T;
    copies(): void;
    bytes(file: string, cap: number): Buffer;
    tree(
        directory: string,
        maximumFiles: number,
        bindIdentities: boolean,
    ): ReturnType<FixedCurrentCOperations['maintenance']>;
    write(name: string, value: unknown): { path: string; bytes: number; sha256: string };
    ancestry(directory: string): void;
    lstat(file: string): Stats;
    names(directory: string): string[];
    payloadB(): Payload;
    payloadC(): Payload;
    previousB(): Payload;
    update: FixedCurrentCOperations['update'];
    writeFinal: FixedCurrentCOperations['writeFinal'];
}

/** Only fixed B/C ledger, profile and removal paths are constructed here. Every read/write
 * delegates to the producer's original FD owner, gates and fixed final writer. */
export async function runOwnedCurrentC(services: OwnedCurrentCServices, originalB: Payload) {
    const io = Object.freeze({ ...services });
    io.gate();
    need(
        io.root === io.fixtureRoot + '/installed' &&
            io.appData === io.fixtureRoot + '/config' &&
            io.work === io.fixtureRoot + '/.DiagnosticHub-maintenance-' + sha(io.root).slice(0, 20),
        'FIXTURE_C_FIXED_ROOTS',
    );
    const same = (a: Stats, b: Stats) =>
        ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
            (key) => a[key as keyof Stats] === b[key as keyof Stats],
        );
    const captured = (file: string, name: string, cap: number) => {
        io.gate();
        const before = io.lstat(file),
            raw = io.bytes(file, cap);
        need(same(before, io.lstat(file)), 'FIXTURE_C_CAPTURE_CHANGED');
        return { entry: fixtureRecordedEntry(name, before, raw), raw };
    };
    const readSeal = (tx: string, anchorFile: string, anchorName: string) => {
        need(
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(tx),
            'FIXTURE_SEAL_TRANSACTION',
        );
        const ledger = io.work + '-finalize-' + tx,
            entries: FixtureEntry[] = [],
            records: Record<string, Buffer> = {};
        io.ancestry(ledger);
        io.ancestry(ledger + '/disposal');
        const before = io.lstat(ledger),
            disposal = io.lstat(ledger + '/disposal');
        const census = () => {
            io.gate();
            need(
                equal(io.names(ledger).sort(), [...fixtureLedgerFiles, 'disposal'].sort()) &&
                    io.names(ledger + '/disposal').length === 0,
                'FIXTURE_SEAL_CENSUS',
            );
        };
        census();
        for (const name of fixtureLedgerFiles) {
            const file = captured(
                ledger + '/' + name,
                name,
                name === 'snapshot.json' ? fixtureSnapshotCap : 8192,
            );
            records[name] = file.raw;
            entries.push(file.entry);
        }
        entries.push(fixtureRecordedEntry('disposal', disposal), fixtureRecordedEntry('', before));
        const anchor = captured(anchorFile, anchorName, 8192);
        for (const entry of entries.slice(0, 6)) {
            const fresh = captured(
                ledger + '/' + entry.path,
                entry.path,
                entry.path === 'snapshot.json' ? fixtureSnapshotCap : 8192,
            );
            need(
                equal(fresh.entry, entry) && fresh.raw.equals(records[entry.path]),
                'FIXTURE_SEAL_CHANGED',
            );
        }
        const lastAnchor = captured(anchorFile, anchorName, 8192);
        need(
            equal(lastAnchor.entry, anchor.entry) && lastAnchor.raw.equals(anchor.raw),
            'FIXTURE_SEAL_ANCHOR_CHANGED',
        );
        census();
        need(
            same(before, io.lstat(ledger)) && same(disposal, io.lstat(ledger + '/disposal')),
            'FIXTURE_SEAL_CHANGED',
        );
        return { entries, records, anchor };
    };
    let updatedC: Awaited<ReturnType<FixedCurrentCOperations['update']>> | null = null;
    const selectedC = () => {
        io.gate();
        need(updatedC, 'FIXTURE_C_UPDATE_REQUIRED');
        return updatedC!;
    };
    const emitted: { path: string; bytes: number; sha256: string }[] = [];
    const copies = () => {
        io.copies();
        for (const original of emitted) {
            const raw = io.bytes(original.path, original.bytes);
            need(
                raw.length === original.bytes && sha(raw) === original.sha256,
                'FIXTURE_C_ORIGINAL_RECORD_CHANGED',
            );
        }
    };
    const emit = (name: 'current-c-binding' | 'current-c-published', data: unknown) => {
        const record = io.write('records/' + name + '.json', {
            sourceCommit: io.sourceCommit,
            runId: io.runId,
            runAttempt: io.runAttempt,
            ...(name === 'current-c-binding'
                ? {
                      currentVersion: fixtureC,
                      rendererBuildLiteralVersion: fixtureB,
                      shippingVersionChanged: false,
                      releaseAcceptance: false,
                  }
                : {}),
            data,
        });
        emitted.push(record);
        copies();
        return record;
    };
    const operations: FixedCurrentCOperations = {
        root: io.root,
        uid: io.uid,
        installationId: io.installationId,
        transactionB: io.transactionB,
        checked: (call) =>
            io.checked(() => {
                copies();
                return call();
            }),
        copies,
        originals: () => ({
            a: io.bytes(io.fixtureRoot + '/records/installed-a-journal.json', 8192),
            b: io.bytes(io.fixtureRoot + '/records/updated-b-journal.json', 8192),
            c: updatedC ? io.bytes(io.fixtureRoot + '/records/updated-c-journal.json', 8192) : null,
        }),
        readSeal: (group) => {
            io.gate();
            if (group === 'b-live' || group === 'b-completed')
                return readSeal(
                    io.transactionB,
                    io.work + (group === 'b-live' ? '/journal.json' : '/completed-journal.json'),
                    'completed-journal.json',
                );
            const tx = selectedC().journal.transactionId;
            return group === 'b-saved'
                ? readSeal(
                      io.transactionB,
                      io.work + '-finalize-' + tx + '/original-completed-journal.json',
                      'completed-journal.json',
                  )
                : readSeal(
                      tx,
                      (group === 'c-live' ? io.work : io.work + '-uninstall/original-maintenance') +
                          '/journal.json',
                      'journal.json',
                  );
        },
        profile: () => JSON.stringify(io.tree(io.appData, 20032, true)),
        maintenance: (group) =>
            io.tree(
                group === 'live' ? io.work : io.work + '-uninstall/original-maintenance',
                20032,
                true,
            ),
        payload: (group) =>
            group === 'b' ? io.payloadB() : group === 'c' ? io.payloadC() : io.previousB(),
        update: async () => {
            updatedC = await io.update();
            io.gate();
            return updatedC;
        },
        removalReadback: () => {
            io.gate();
            const removal = io.work + '-uninstall';
            io.ancestry(removal);
            io.ancestry(removal + '/disposal');
            need(
                equal(io.names(removal).sort(), [
                    'disposal',
                    'original-maintenance',
                    'snapshot.json',
                    'state.json',
                ]) &&
                    !io.names(io.fixtureRoot).includes('installed') &&
                    !io.names(io.fixtureRoot).includes(io.work.slice(io.fixtureRoot.length + 1)) &&
                    io.names(removal + '/disposal').length === 0,
                'FIXTURE_C_UNINSTALL_BOUNDARY',
            );
            return {
                snapshot: io.bytes(removal + '/snapshot.json', fixtureSnapshotCap),
                state: io.bytes(removal + '/state.json', 8192),
            };
        },
        writeBinding: (data) => emit('current-c-binding', data),
        writePublished: (data) => emit('current-c-published', data),
        writeFinal: io.writeFinal,
    };
    return runFixedCurrentC(Object.freeze(operations), originalB);
}

type Payload = { originalManifest: Buffer; originalRecord: Buffer; originalOwner: Buffer };
type SealCapture = {
    records: Record<string, Buffer>;
    entries: FixtureEntry[];
    anchor: { entry: FixtureEntry; raw: Buffer };
};
export interface FixedCurrentCOperations {
    root: string;
    uid: number;
    installationId: string;
    transactionB: string;
    checked<T>(call: () => T): T;
    copies(): void;
    originals(): { a: Buffer; b: Buffer; c: Buffer | null };
    readSeal(group: 'b-live' | 'b-completed' | 'b-saved' | 'c-live' | 'c-removed'): SealCapture;
    profile(): string;
    maintenance(group: 'live' | 'removed'): {
        files: unknown;
        directories: unknown;
        identity?: Record<string, unknown>;
    };
    payload(group: 'b' | 'c' | 'previous-b'): Payload;
    update(): Promise<
        Payload & {
            journal: { transactionId: string; previousSHA256: string };
            installationId: string;
        }
    >;
    removalReadback(): { snapshot: Buffer; state: Buffer };
    writeBinding(data: unknown): unknown;
    writePublished(data: unknown): unknown;
    writeFinal(value: Buffer): { path: string; bytes: number; sha256: string };
}
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const need = (value: unknown, code: string) => {
    if (!value) throw Error(code);
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const payloadEqual = (a: Payload, b: Payload) =>
    a.originalManifest.equals(b.originalManifest) &&
    a.originalRecord.equals(b.originalRecord) &&
    a.originalOwner.equals(b.originalOwner);

export async function runFixedCurrentC(ports: FixedCurrentCOperations, originalB: Payload) {
    const ops = Object.freeze({ ...ports }); // Capture the fixed producer callbacks once.
    ops.copies();
    const originals = ops.originals();
    const bSeal = (group: 'b-live' | 'b-completed' | 'b-saved') => {
        const read = ops.readSeal(group),
            descriptor = fixturePublishedSeal({
                ...read,
                root: ops.root,
                uid: ops.uid,
                installationId: ops.installationId,
                transactionId: ops.transactionB,
                candidate: originals.b,
                completed: originals.a,
            });
        return { descriptor, records: read.records, anchor: read.anchor.raw };
    };
    const publishedB = bSeal('b-live'),
        beforeProfile = ops.profile();
    need(payloadEqual(ops.payload('b'), originalB), 'FIXTURE_B_CURRENT_CHANGED');
    const updatedC = await ops.update();
    ops.copies(); // A late return cannot issue another stage after its original owner freezes.
    need(
        updatedC.installationId === ops.installationId &&
            updatedC.journal.previousSHA256 === sha(originalB.originalManifest) &&
            ops.profile() === beforeProfile,
        'FIXTURE_C_UPDATE_IDENTITY',
    );
    need(payloadEqual(ops.payload('previous-b'), originalB), 'FIXTURE_C_PREVIOUS_ORIGINALS');
    const candidateC = ops.originals().c;
    need(candidateC, 'FIXTURE_C_ORIGINAL_REQUIRED');
    const checkB = (group: 'b-completed' | 'b-saved') =>
        need(equal(bSeal(group), publishedB), 'FIXTURE_B_SEAL_CHANGED');
    checkB('b-completed');
    const binding = ops.writeBinding({ journal: updatedC.journal, parent: publishedB.descriptor });
    let published: ReturnType<typeof bSeal> | null = null,
        profile: string | null = null,
        maintenance: ReturnType<FixedCurrentCOperations['maintenance']> | null = null,
        captureIssued = false,
        removed = false;
    const readPublished = (group: 'c-live' | 'c-removed') => {
        checkB('b-saved');
        const read = ops.readSeal(group),
            descriptor = fixturePublishedSeal({
                ...read,
                root: ops.root,
                uid: ops.uid,
                installationId: ops.installationId,
                transactionId: updatedC.journal.transactionId,
                candidate: candidateC!,
                completed: publishedB.anchor,
                parent: publishedB.descriptor,
                parentSnapshotSHA256: sha(publishedB.records['snapshot.json']),
            }),
            fresh = { descriptor, records: read.records, anchor: read.anchor.raw };
        if (published) need(equal(fresh, published), 'FIXTURE_C_SEAL_CHANGED');
        return fresh; // Producer capture finishes with C anchor readback, after the B chain.
    };
    const capturePublishedC = () =>
        ops.checked(() => {
            need(!captureIssued, 'FIXTURE_C_CAPTURE_ONCE');
            captureIssued = true;
            need(payloadEqual(ops.payload('c'), updatedC), 'FIXTURE_C_CURRENT_CHANGED');
            published = readPublished('c-live');
            profile = ops.profile();
            maintenance = ops.maintenance('live');
            readPublished('c-live');
            return ops.writePublished({
                binding,
                parent: publishedB,
                current: published,
                maintenance,
                profile: JSON.parse(profile),
            });
        });
    const revalidateAfterUninstall = () =>
        ops.checked(() => {
            need(published && profile !== null && maintenance, 'FIXTURE_C_PUBLISHED_REQUIRED');
            const read = ops.removalReadback(),
                result = fixtureRemovalRecords(read.snapshot, read.state, {
                    root: ops.root,
                    uid: ops.uid,
                    transactionId: updatedC.journal.transactionId,
                    confirmed: published!.anchor,
                    current: published!.descriptor,
                    parent: publishedB.descriptor,
                    manifest: updatedC.originalManifest,
                    record: updatedC.originalRecord,
                    owner: updatedC.originalOwner,
                });
            readPublished('c-removed');
            const kept = ops.maintenance('removed');
            need(
                equal(kept.files, maintenance!.files) &&
                    equal(kept.directories, maintenance!.directories) &&
                    ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].every(
                        (key) => kept.identity![key] === maintenance!.identity![key],
                    ),
                'FIXTURE_C_MAINTENANCE_CHANGED',
            );
            need(ops.profile() === profile, 'FIXTURE_C_PROFILE_CHANGED');
            removed = true;
            return result;
        });
    return {
        records: { binding, parent: publishedB },
        capturePublishedC,
        revalidateAfterUninstall,
        writeSecondSealUninstallRecord: (value: Buffer) =>
            ops.checked(() => {
                need(removed, 'FIXTURE_C_UNINSTALL_REQUIRED');
                revalidateAfterUninstall();
                return ops.writeFinal(value);
            }),
    };
}
