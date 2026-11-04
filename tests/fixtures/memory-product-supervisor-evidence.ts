import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireObservedClosure } from '../../scripts/lib/owned-child.mjs';
import {
    productClock,
    type ProductClock,
    type ProductJob,
    type ProductRunOwner,
} from './memory-product-owner';

export const timelineLimit = 512 * 1024 ** 2;
export const metadataLimit = 32 * 1024;
export type EvidenceReference = { name: string; bytes: number; sha256: string };
export interface SupervisorEvidenceIO {
    hash(name: string, maximum: number): Promise<EvidenceReference>;
    json(name: string, maximum: number): Promise<{ reference: EvidenceReference; value: unknown }>;
    write(name: string, value: unknown): Promise<void>;
}
type Info = {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    nlink: number;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
};
type Handle = {
    stat(): Promise<Info>;
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
    ): Promise<{ bytesRead: number }>;
    writeFile(bytes: string): Promise<unknown>;
    sync(): Promise<unknown>;
    close(): Promise<unknown>;
};
export type EvidenceFileSystem = {
    lstat(file: string): Promise<Info>;
    realpath(file: string): Promise<string>;
    open(file: string, flags: string): Promise<Handle>;
};
const filenames = ['timeline.jsonl', 'child-evidence.json', 'supervisor-evidence.json'];
export async function assertSupervisorDirectory(
    directory: string,
    filesystem: EvidenceFileSystem = fs,
) {
    const info = await filesystem.lstat(directory);
    assert.ok(
        info.isDirectory() && !info.isSymbolicLink(),
        'Supervisor evidence directory is aliased.',
    );
    assert.equal(
        await filesystem.realpath(directory),
        directory,
        'Supervisor evidence path is not canonical.',
    );
}
function regular(info: Info) {
    assert.ok(
        info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
        'Supervisor evidence requires a regular single-link file.',
    );
}
function unchanged(before: Info, after: Info) {
    regular(after);
    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)
        assert.equal(after[field], before[field], 'Supervisor evidence changed during read.');
}
function throwFailures(errors: unknown[], message: string) {
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, message, { cause: errors[0] });
}
/** Fixed names, exclusive writes and file sync/close. No overwrite, cleanup or qualification. */
export function supervisorEvidenceIO(
    directory: string,
    filesystem: EvidenceFileSystem = fs,
): SupervisorEvidenceIO {
    assert.ok(path.isAbsolute(directory));
    const file = (name: string) => {
        assert.ok(filenames.includes(name), 'Unsupported supervisor evidence filename.');
        return path.join(directory, name);
    };
    const checkDirectory = () => assertSupervisorDirectory(directory, filesystem);
    async function read(name: string, maximum: number, collect: boolean) {
        await checkDirectory();
        assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= timelineLimit);
        const target = file(name);
        const before = await filesystem.lstat(target);
        regular(before);
        assert.ok(
            before.size > 0 && before.size <= maximum,
            'Supervisor evidence size bound exceeded.',
        );
        const handle = await filesystem.open(target, 'r');
        const errors: unknown[] = [];
        let result: { reference: EvidenceReference; contents: Buffer } | undefined;
        try {
            unchanged(before, await handle.stat());
            const hash = createHash('sha256'),
                buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1));
            const chunks: Buffer[] = [];
            let bytes = 0;
            for (;;) {
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    Math.min(buffer.length, maximum + 1 - bytes),
                    null,
                );
                assert.ok(
                    Number.isSafeInteger(bytesRead) && bytesRead >= 0 && bytesRead <= buffer.length,
                );
                if (!bytesRead) break;
                bytes += bytesRead;
                assert.ok(bytes <= maximum, 'Supervisor evidence grew beyond its byte bound.');
                hash.update(buffer.subarray(0, bytesRead));
                if (collect) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            }
            assert.equal(bytes, before.size, 'Supervisor evidence length changed.');
            unchanged(before, await handle.stat());
            unchanged(before, await filesystem.lstat(target));
            result = {
                reference: { name, bytes, sha256: hash.digest('hex') },
                contents: Buffer.concat(chunks),
            };
        } catch (error) {
            errors.push(error);
        }
        try {
            await handle.close();
        } catch (error) {
            errors.push(error);
        }
        throwFailures(errors, 'Supervisor evidence read/close failed.');
        assert.ok(result);
        return result;
    }
    return {
        async hash(name, maximum) {
            return (await read(name, maximum, false)).reference;
        },
        async json(name, maximum) {
            assert.ok(maximum <= metadataLimit);
            const result = await read(name, maximum, true);
            return {
                reference: result.reference,
                value: JSON.parse(result.contents.toString('utf8')),
            };
        },
        async write(name, value) {
            await checkDirectory();
            assert.ok(name !== 'timeline.jsonl');
            const bytes = JSON.stringify(value) + '\n';
            assert.ok(
                Buffer.byteLength(bytes) <= metadataLimit,
                'Supervisor metadata size bound exceeded.',
            );
            const handle = await filesystem.open(file(name), 'wx');
            const errors: unknown[] = [];
            try {
                await handle.writeFile(bytes);
            } catch (error) {
                errors.push(error);
            }
            // Attempt sync and close even after a failed write; retain the first failure.
            try {
                await handle.sync();
            } catch (error) {
                errors.push(error);
            }
            try {
                await handle.close();
            } catch (error) {
                errors.push(error);
            }
            throwFailures(errors, 'Supervisor evidence write/sync/close failed.');
        },
    };
}

export function supervisorArguments(raw: string[], child: boolean) {
    for (const reserved of ['child', 'product-job', 'supervisor-output']) {
        const count = raw.filter(
            (arg) => arg === '--' + reserved || arg.startsWith('--' + reserved + '='),
        ).length;
        assert.equal(
            count,
            child ? 1 : 0,
            'Externally supplied or duplicate reserved supervisor argument: ' + reserved,
        );
    }
}
/** Generated output is excluded by the unchanged source fingerprint rules. */
export function supervisorDestination(repository: string, destination: string) {
    const resolved = path.resolve(destination),
        relative = path.relative(path.join(repository, 'validation'), resolved);
    assert.ok(
        !relative.startsWith('..') && !path.isAbsolute(relative),
        'Supervisor evidence must stay under validation/.',
    );
    return resolved;
}

/** Parent allocates the directory before spawn; child cannot choose a foreign run directory. */
export function supervisorOutput(
    destination: string,
    directory: string,
    lane: string,
    gcMode: string,
    job: ProductJob,
) {
    assert.ok(['desktop', 'browser', 'gateway'].includes(lane));
    assert.ok(['normal', 'forced'].includes(gcMode));
    assert.ok(path.isAbsolute(directory));
    assert.equal(path.dirname(directory), path.resolve(destination));
    assert.match(
        path.basename(directory),
        new RegExp(`^${lane}-${gcMode}-${job.nonce}-[A-Za-z0-9]{6}$`),
    );
    return directory;
}

/** Called only after the child timeline sync/close and actual descendant joins. */
export async function finishProductEvidence(
    owner: ProductRunOwner,
    io: SupervisorEvidenceIO,
    clock: ProductClock = productClock,
) {
    try {
        assert.ok(
            clock.now() < owner.job.deadlineMs,
            'Child evidence handoff exceeded the existing total deadline.',
        );
        const timeline = await io.hash('timeline.jsonl', timelineLimit);
        await io.write('child-evidence.json', {
            schemaVersion: 1,
            kind: 'product-child-closed-timeline',
            qualification: false,
            nonce: owner.job.nonce,
            timeline,
            ownerCompletion: 'not-asserted',
        });
        assert.ok(
            clock.now() < owner.job.deadlineMs,
            'Child evidence handoff exceeded the existing total deadline.',
        );
        // finish() validates custody and disconnects IPC. Never send evidence after this call.
        owner.finish(true);
    } catch (error) {
        owner.hold(error);
        throw error;
    }
}

export type SupervisorLifecycle = {
    pid: number | null;
    spawnObserved: boolean;
    exitObserved: boolean;
    closeObserved: boolean;
    code: number | null;
    signal: string | null;
    closeCode: number | null;
    closeSignal: string | null;
    error: string | null;
    timedOut: boolean;
    terminationRequested: boolean;
    killErrors: string[];
    elapsedMs: number;
};
/** Observations only. Even a complete normal lifecycle is never release acceptance. */
export async function writeSupervisorEvidence(
    job: ProductJob,
    lifecycle: SupervisorLifecycle | null,
    io: SupervisorEvidenceIO,
    initialFailure?: unknown,
) {
    const failures: string[] = [];
    const retain = (error: unknown) => failures.push(String(error).slice(0, 1024));
    if (initialFailure !== undefined) retain(initialFailure);
    let childEvidence: EvidenceReference | null = null,
        timeline: EvidenceReference | null = null;
    let lifecycleValid = false;
    const snapshot = lifecycle ? { ...lifecycle, killErrors: [...lifecycle.killErrors] } : null;
    try {
        requireObservedClosure(snapshot);
        assert.ok(snapshot);
        for (const field of ['spawnObserved', 'exitObserved', 'closeObserved'] as const)
            assert.equal(snapshot[field], true);
        assert.equal(
            snapshot.code,
            0,
            'Product supervisor child did not exit normally with code zero.',
        );
        assert.equal(snapshot.terminationRequested, false);
        assert.deepEqual(snapshot.killErrors, []);
        assert.ok(Number.isFinite(snapshot.elapsedMs) && snapshot.elapsedMs >= 0);
        lifecycleValid = true;
    } catch (error) {
        retain(error);
    }
    if (lifecycleValid)
        try {
            const observed = await io.json('child-evidence.json', metadataLimit);
            const value = observed.value as Record<string, any>;
            assert.deepEqual(Object.keys(value).sort(), [
                'kind',
                'nonce',
                'ownerCompletion',
                'qualification',
                'schemaVersion',
                'timeline',
            ]);
            assert.equal(value.schemaVersion, 1);
            assert.equal(value.kind, 'product-child-closed-timeline');
            assert.equal(value.qualification, false);
            assert.equal(value.nonce, job.nonce, 'Foreign product evidence nonce.');
            assert.equal(value.ownerCompletion, 'not-asserted');
            const actual = await io.hash('timeline.jsonl', timelineLimit);
            assert.deepEqual(value.timeline, actual, 'Closed child timeline bytes differ.');
            childEvidence = observed.reference;
            timeline = actual;
        } catch (error) {
            retain(error);
        }
    const record = {
        schemaVersion: 1,
        kind: 'product-supervisor-observation',
        qualification: false,
        releaseAcceptance: false,
        status: failures.length
            ? 'invalid-non-qualifying-supervisor-evidence'
            : 'collected-non-qualifying-supervisor-evidence',
        job,
        lifecycle: snapshot,
        childEvidence,
        timeline,
        failures,
        scope: 'Observed supervisor lifecycle and closed child evidence only; no product or release verdict.',
    };
    await io.write('supervisor-evidence.json', record);
    return record;
}
