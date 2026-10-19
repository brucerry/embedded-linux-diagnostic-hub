// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const MiB = 1024 ** 2;
export const soakPhysicalLimits = Object.freeze({
    capture: 48 * MiB,
    profile: 128 * MiB,
    artifact: 128 * MiB,
    timeline: 64 * MiB,
    streams: 2 * MiB,
    auxiliary: 32 * MiB,
    cleanup: 10 * MiB,
    job: 416 * MiB,
    work: 406 * MiB,
    cohort: 840 * MiB,
    collector: 8 * MiB,
});
const partitions = [
    'capture',
    'profile',
    'artifact',
    'timeline',
    'streams',
    'auxiliary',
    'cleanup',
];
/** Explicit policy admission, not a filesystem quota or a claim about Chromium growth. */
export class SoakPhysicalReservations {
    constructor() {
        this.held = new Map();
        this.failure = null;
        this.cleanup = false;
    }
    enterCleanup() {
        this.cleanup = true;
    }
    reserve(owner, partition, bytes) {
        if (this.failure && !this.cleanup) throw this.failure;
        try {
            assert(
                partitions.includes(partition) &&
                    Number.isSafeInteger(bytes) &&
                    bytes >= 0 &&
                    !this.held.has(owner),
            );
            assert((partition === 'cleanup') === this.cleanup, 'Physical partition phase');
            const totals = this.totals();
            assert(
                totals[partition] + bytes <= soakPhysicalLimits[partition],
                'Soak physical partition: ' + partition,
            );
            assert(
                totals.total + bytes <=
                    (this.cleanup ? soakPhysicalLimits.job : soakPhysicalLimits.work),
                'Soak physical job',
            );
            if (partition === 'artifact')
                assert(
                    ![...this.held.values()].some((v) => v.partition === 'artifact'),
                    'One live artifact slot',
                );
            const token = Object.freeze({ owner, partition, bytes });
            this.held.set(owner, token);
            return token;
        } catch (error) {
            this.failure ??= error;
            throw error;
        }
    }
    // The owner supplies actual retirement proof; absence alone does not prove descriptor closure.
    retire(token, { descriptorClosed, producersJoined, paths, io = fs }) {
        assert(
            this.held.get(token.owner) === token &&
                descriptorClosed === true &&
                producersJoined === true &&
                Array.isArray(paths) &&
                paths.length > 0,
            'Unproved physical retirement',
        );
        for (const file of paths) {
            try {
                io.lstatSync(file);
                assert.fail('Physical output still present');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        this.held.delete(token.owner);
    }
    totals() {
        const totals = Object.fromEntries(partitions.map((k) => [k, 0]));
        totals.total = 0;
        for (const token of this.held.values()) {
            totals[token.partition] += token.bytes;
            totals.total += token.bytes;
        }
        return totals;
    }
}
export function classifySoakFile(relative) {
    const parts = relative.replaceAll('\\', '/').split('/');
    assert(parts.length && parts.every((p) => p && p !== '.' && p !== '..'), 'Soak physical path');
    const profile = parts.indexOf('profile');
    if (profile >= 0) {
        // The disposable MEMORY-journal catalog belongs to other profile files. Only capture
        // folders (including their real atomic temporaries) belong to authoritative capture data.
        return parts[profile + 1] === 'captures-v1' &&
            parts[profile + 2] &&
            !parts[profile + 2].startsWith('.')
            ? 'capture'
            : 'profile';
    }
    if (parts.includes('native-downloads') || parts.includes('browser-downloads'))
        return 'artifact';
    const name = parts.at(-1);
    if (name === 'timeline.jsonl') return 'timeline';
    if (/(?:stdout|stderr)\.log$/.test(name)) return 'streams';
    if (parts.includes('cleanup-evidence') || name === 'native-will-quit.json') return 'cleanup';
    return 'auxiliary';
}
/** One census counts each file once. Unknown aliases and concurrently changed identities refuse. */
export function inspectSoakPhysical(
    root,
    { cleanup = false, io = fs, extraStreams = 0, extraAuxiliary = 0 } = {},
) {
    const totals = Object.fromEntries(partitions.map((k) => [k, 0]));
    totals.streams = extraStreams;
    totals.auxiliary = extraAuxiliary;
    assert(Number.isSafeInteger(extraStreams) && extraStreams >= 0);
    assert(
        Number.isSafeInteger(extraAuxiliary) &&
            extraAuxiliary >= 0 &&
            extraAuxiliary <= soakPhysicalLimits.auxiliary,
    );
    const files = {},
        identities = new Map();
    let count = 0;
    function walk(directory) {
        for (const name of io.readdirSync(directory).sort()) {
            const file = path.join(directory, name),
                before = io.lstatSync(file, { bigint: true });
            assert(!before.isSymbolicLink(), 'Soak tree alias');
            if (before.isDirectory()) {
                walk(file);
                continue;
            }
            assert(
                before.isFile() && ++count <= 8192 && before.nlink >= 1n && before.nlink <= 2n,
                'Soak tree file/alias bound',
            );
            const relative = path.relative(root, file).replaceAll('\\', '/'),
                partition = classifySoakFile(relative),
                bytes = Number(before.size);
            assert(Number.isSafeInteger(bytes) && bytes <= 128 * MiB, 'Soak per-file refusal');
            const identity = before.dev + '/' + before.ino;
            const prior = identities.get(identity);
            if (prior) {
                assert(
                    partition === 'artifact' &&
                        prior.partition === partition &&
                        prior.bytes === bytes &&
                        prior.links === before.nlink,
                    'Foreign physical alias',
                );
                prior.paths.push(relative);
            } else {
                identities.set(identity, {
                    partition,
                    bytes,
                    links: before.nlink,
                    paths: [relative],
                    allocatedBytes:
                        typeof before.blocks === 'bigint' &&
                        (before.blocks > 0n || before.size === 0n)
                            ? Number(before.blocks * 512n)
                            : null,
                });
                totals[partition] += bytes;
            }
            assert(
                totals[partition] <= soakPhysicalLimits[partition],
                'Soak physical partition: ' + partition,
            );
            const after = io.lstatSync(file, { bigint: true });
            for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'])
                assert(before[key] === after[key], 'Soak inventory changed during census');
            files[relative] = { bytes, partition };
        }
    }
    walk(root);
    for (const group of identities.values()) {
        if (group.links === 1n) {
            assert(group.paths.length === 1);
            continue;
        }
        assert(
            group.partition === 'artifact' &&
                group.links === 2n &&
                group.paths.length === 2 &&
                path.dirname(group.paths[0]) === path.dirname(group.paths[1]),
            'Unaccounted hardlink ownership',
        );
        assert(
            group.paths.some((p) =>
                /^\.diagnostic-hub-export-[a-f0-9-]+\.tmp$/.test(path.basename(p)),
            ) &&
                group.paths.some((p) =>
                    /^report-[a-zA-Z0-9-]+\.(json|csv|md|txt)$/.test(path.basename(p)),
                ),
            'Unreviewed artifact alias',
        );
    }
    const bytes = partitions.reduce((sum, k) => sum + totals[k], 0);
    assert(
        totals.streams <= soakPhysicalLimits.streams &&
            bytes <= (cleanup ? soakPhysicalLimits.job : soakPhysicalLimits.work),
        'Soak physical job',
    );
    const allocated = [...identities.values()].map((v) => v.allocatedBytes),
        allocatedBytes = allocated.every((v) => v !== null)
            ? allocated.reduce((sum, v) => sum + v, 0)
            : null;
    return {
        bytes,
        totals,
        files,
        allocatedBytes,
        allocationObservationUnsupported: allocatedBytes === null,
        apparentBytesOnly: true,
        betweenPollPeakProved: false,
    };
}
export function inspectSoakCohort(jobs, collectorBytes) {
    assert(
        Array.isArray(jobs) &&
            jobs.length <= 2 &&
            jobs.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= soakPhysicalLimits.job),
    );
    assert(
        Number.isSafeInteger(collectorBytes) &&
            collectorBytes >= 0 &&
            collectorBytes <= soakPhysicalLimits.collector,
        'Soak collector overhead',
    );
    const bytes = jobs.reduce((a, b) => a + b, collectorBytes);
    assert(bytes <= soakPhysicalLimits.cohort, 'Soak cohort');
    return bytes;
}

// Only the soak harness registers a scope. Finite pilots have no scope and retain their limits.
const scopes = new Map();
export function registerSoakPhysicalScope(root) {
    root = path.resolve(root);
    assert(!scopes.has(root), 'Duplicate soak disk owner');
    const reservations = new SoakPhysicalReservations();
    for (const partition of ['capture', 'profile', 'timeline', 'streams', 'auxiliary'])
        reservations.reserve(partition, partition, soakPhysicalLimits[partition]);
    const scope = {
        root,
        reservations,
        inspect() {
            return inspectSoakPhysical(root, { cleanup: reservations.cleanup });
        },
        enterCleanup() {
            reservations.enterCleanup();
            reservations.reserve('cleanup', 'cleanup', soakPhysicalLimits.cleanup);
        },
    };
    scopes.set(root, scope);
    return scope;
}
export function reserveSoakArtifact(directory) {
    const absolute = path.resolve(directory),
        scope = [...scopes.values()].find(
            (s) => absolute === s.root || absolute.startsWith(s.root + path.sep),
        );
    if (!scope) return { retire() {} };
    scope.inspect();
    const token = scope.reservations.reserve(
        Symbol('artifact'),
        'artifact',
        soakPhysicalLimits.artifact,
    );
    return {
        retire(paths, proof) {
            scope.reservations.retire(token, { ...proof, paths });
            scope.inspect();
        },
    };
}

/** Collector overhead excludes job trees and their explicitly attributed parent streams. */
export function inspectSoakCollector(
    root,
    { extraCollectorBytes = 0, externalAuxiliary = [0, 0] } = {},
) {
    const jobs = [];
    assert(Number.isSafeInteger(extraCollectorBytes) && extraCollectorBytes >= 0);
    let collectorBytes = extraCollectorBytes;
    for (const name of fs.readdirSync(root).sort()) {
        const file = path.join(root, name),
            s = fs.lstatSync(file);
        assert(!s.isSymbolicLink(), 'Collector alias');
        if (s.isDirectory()) {
            assert(/^job-[01]$/.test(name), 'Unknown collector directory');
            const ordinal = name.slice(4);
            const extraStreams = ['stdout', 'stderr'].reduce((sum, stream) => {
                const log = fs.lstatSync(path.join(root, `parent-${ordinal}.${stream}.log`));
                assert(log.isFile() && !log.isSymbolicLink() && log.nlink === 1);
                return sum + log.size;
            }, 0);
            jobs.push(
                inspectSoakPhysical(file, {
                    cleanup: true,
                    extraStreams,
                    extraAuxiliary: externalAuxiliary[Number(ordinal)],
                }).bytes,
            );
        } else {
            assert(s.isFile() && s.nlink === 1, 'Collector file alias');
            if (!/^parent-[01]\.(stdout|stderr)\.log$/.test(name)) collectorBytes += s.size;
        }
    }
    return { jobs, collectorBytes, bytes: inspectSoakCohort(jobs, collectorBytes) };
}
