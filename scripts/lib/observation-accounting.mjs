import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    soakPhysicalLimits,
    inspectSoakPhysical,
    inspectSoakCollector,
} from './soak-physical-budget.mjs';
export const observationSharedCredits = Object.freeze({
    parent: 4 * 1024 ** 2,
    collector: 4 * 1024 ** 2,
});
assert.equal(
    observationSharedCredits.parent + observationSharedCredits.collector,
    soakPhysicalLimits.collector,
);
/** Bounded read-only census. These are apparent-byte observations, never external-writer quotas. */
export function observationInventory(
    root,
    { exclude = () => false, io = fs, optional = false } = {},
) {
    const files = new Map();
    let bytes = 0,
        allocatedBytes = 0,
        allocationKnown = true;
    function walk(directory) {
        for (const name of io.readdirSync(directory).sort()) {
            const file = path.join(directory, name);
            if (exclude(file)) continue;
            const s = io.lstatSync(file, { bigint: true });
            assert(!s.isSymbolicLink(), 'Observation census alias');
            if (s.isDirectory()) walk(file);
            else {
                assert(
                    s.isFile() && s.nlink === 1n && files.size < 8192,
                    'Observation census file/alias bound',
                );
                const size = Number(s.size);
                assert(Number.isSafeInteger(size));
                bytes += size;
                const allocated =
                    typeof s.blocks === 'bigint' && (s.blocks > 0n || s.size === 0n)
                        ? Number(s.blocks * 512n)
                        : null;
                if (allocated === null) allocationKnown = false;
                else allocatedBytes += allocated;
                files.set(file, {
                    identity: String(s.dev) + '/' + String(s.ino),
                    bytes: size,
                    allocatedBytes: allocated,
                });
            }
        }
    }
    if (optional && !io.existsSync(root)) return { files, bytes: 0, allocatedBytes: 0 };
    walk(root);
    return { files, bytes, allocatedBytes: allocationKnown ? allocatedBytes : null };
}
export function observationSharedInventory(root, prerequisiteRoots = []) {
    const collection = path.join(root, 'collection'),
        collector = path.join(collection, 'collector'),
        security = path.join(collection, 'collector-security');
    const parent = observationInventory(root, {
        exclude: (file) => file === collector || file === security,
    });
    let parentBytes = parent.bytes,
        parentAllocatedBytes = parent.allocatedBytes,
        count = parent.files.size;
    for (const p of prerequisiteRoots) {
        const value = observationInventory(p);
        parentBytes += value.bytes;
        count += value.files.size;
        parentAllocatedBytes =
            parentAllocatedBytes === null || value.allocatedBytes === null
                ? null
                : parentAllocatedBytes + value.allocatedBytes;
    }
    const inner = observationInventory(collector, {
        optional: true,
        exclude: (file) =>
            path.dirname(file) === collector &&
            (/^job-[01]$/.test(path.basename(file)) ||
                /^parent-[01]\.(stdout|stderr)\.log$/.test(path.basename(file))),
    });
    const queries = observationInventory(security, { optional: true });
    count += inner.files.size + queries.files.size;
    assert(count <= 8192, 'Shared evidence file bound');
    const collectorAllocatedBytes =
        inner.allocatedBytes === null || queries.allocatedBytes === null
            ? null
            : inner.allocatedBytes + queries.allocatedBytes;
    return {
        parentBytes,
        collectorBytes: inner.bytes + queries.bytes,
        innerBytes: inner.bytes,
        extraCollectorBytes: parentBytes + queries.bytes,
        totalBytes: parentBytes + inner.bytes + queries.bytes,
        parentAllocatedBytes,
        collectorAllocatedBytes,
        totalAllocatedBytes:
            parentAllocatedBytes === null || collectorAllocatedBytes === null
                ? null
                : parentAllocatedBytes + collectorAllocatedBytes,
        files: count,
    };
}
export function admitObservationShared(root, prerequisiteRoots, writer, bytes = 0) {
    assert(['parent', 'collector'].includes(writer) && Number.isSafeInteger(bytes) && bytes >= 0);
    const s = observationSharedInventory(root, prerequisiteRoots);
    assert(
        s.parentBytes + (writer === 'parent' ? bytes : 0) <= observationSharedCredits.parent,
        'Observation parent shared credit',
    );
    assert(
        s.collectorBytes + (writer === 'collector' ? bytes : 0) <=
            observationSharedCredits.collector,
        'Observation collector shared credit',
    );
    return s;
}
export class ObservationAccounting {
    constructor(root, canonicalTemp, { io = fs, prerequisiteRoots = [] } = {}) {
        this.root = root;
        this.tmp = canonicalTemp;
        this.io = io;
        this.active = null;
        this.started = new Set();
        this.external = [0, 0];
        this.externalOwners = new Map();
        this.polls = 0;
        this.minimumFree = null;
        this.externalPeak = 0;
        this.closed = false;
        // The fresh closed PTY gate is a separate finite prerequisite, retained outside the pair.
        this.prerequisiteRoots = [...prerequisiteRoots];
        this.exclude = (file) =>
            [root, ...this.prerequisiteRoots].some(
                (p) => file === p || file.startsWith(p + path.sep),
            );
        this.baseline = observationInventory(canonicalTemp, { io, exclude: this.exclude });
        this.baselineBytes = this.baseline.bytes;
    }
    free() {
        const s = this.io.statfsSync(this.tmp, { bigint: true }),
            n = Number(s.bavail * s.bsize);
        this.minimumFree = Math.min(this.minimumFree ?? n, n);
        return n;
    }
    admit() {
        assert(this.free() >= 2 * 1024 ** 3, 'Observation free-space admission requires2GiB');
        return this.scan();
    }
    sharedBytes() {
        return admitObservationShared(this.root, this.prerequisiteRoots, 'parent');
    }
    externalGrowth(assign = false) {
        const next = observationInventory(this.tmp, { io: this.io, exclude: this.exclude });
        let growth = 0;
        const charged = [0, 0];
        for (const [file, row] of next.files) {
            const old = this.baseline.files.get(file),
                bytes =
                    old?.identity === row.identity ? Math.max(0, row.bytes - old.bytes) : row.bytes;
            growth += bytes;
            if (bytes && assign) {
                const key = file + '\0' + row.identity;
                if (!this.externalOwners.has(key)) {
                    assert(this.active !== null, 'Unattributed external growth');
                    assert(this.externalOwners.size < 8192);
                    this.externalOwners.set(key, this.active);
                }
                charged[this.externalOwners.get(key)] += bytes;
            }
        }
        if (assign) this.external = charged;
        return growth;
    }
    start(ordinal) {
        assert(this.active === null && [0, 1].includes(ordinal) && !this.started.has(ordinal));
        this.scan();
        this.started.add(ordinal);
        this.active = ordinal;
        this.scan();
    }
    end(ordinal) {
        assert.equal(this.active, ordinal);
        this.scan();
        this.active = null;
    }
    scan() {
        assert(!this.closed);
        assert(this.free() >= 128 * 1024 ** 2, 'Observation free-space pressure');
        for (const ordinal of this.started) {
            const s = this.io.lstatSync(
                path.join(this.root, 'collection', 'collector', 'job-' + ordinal),
            );
            assert(
                s.isDirectory() && !s.isSymbolicLink(),
                'Started observation tree missing/rebound',
            );
        }
        const growth = this.externalGrowth(true);
        this.externalPeak = Math.max(this.externalPeak, growth);
        const shared = this.sharedBytes();
        const collector = path.join(this.root, 'collection', 'collector');
        const result = this.io.existsSync(collector)
            ? inspectSoakCollector(collector, {
                  extraCollectorBytes: shared.extraCollectorBytes,
                  externalAuxiliary: this.external,
              })
            : { bytes: shared.totalBytes, collectorBytes: shared.totalBytes, jobs: [] };
        this.polls++;
        this.latest = {
            ...result,
            sharedBytes: shared.totalBytes,
            sharedAllocation: shared,
            externalAuxiliary: [...this.external],
            externalGrowth: growth,
        };
        return this.latest;
    }
    snapshot() {
        return {
            polls: this.polls,
            minimumFreeBytes: this.minimumFree,
            externalPeakApparentBytes: this.externalPeak,
            externalAuxiliary: [...this.external],
            latest: this.latest ?? null,
            declaredRoots: [this.root, ...this.prerequisiteRoots, this.tmp],
            sharedCredits: observationSharedCredits,
            baselineExternalBytes: this.baselineBytes,
            betweenPollPeakProved: false,
            filesystemQuotaClaim: false,
            limitation:
                'Each external file identity growth belongs to the job that first observed it, counted once at current size above baseline. Other host writes are guarded by disposable-host/free-space admission; no whole-machine allocation coverage is claimed.',
        };
    }
}
