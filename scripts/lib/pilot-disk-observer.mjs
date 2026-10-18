import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pilotLimits } from './hosted-pilot-contract.mjs';
/** Periodic logical-size observations only. Transient inter-sample writes are not bounded or disproved. */
export class PilotDiskObserver {
    constructor(
        roots,
        {
            clock = () => Number(process.hrtime.bigint() / 1000000n),
            check = () => {},
            emit = () => {},
            stop = () => {},
        } = {},
    ) {
        this.roots = roots;
        this.clock = clock;
        this.check = check;
        this.emit = emit;
        this.stop = stop;
        this.samples = [];
        this.peak = 0;
        this.last = null;
        this.failed = null;
    }
    scan(stage) {
        const start = this.clock();
        let trees = [];
        try {
            this.check();
            for (const root of this.roots) {
                let bytes = 0,
                    files = 0;
                const walk = (dir) => {
                    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
                        const p = path.join(dir, d.name),
                            s = fs.lstatSync(p);
                        assert(!s.isSymbolicLink());
                        if (s.isDirectory()) walk(p);
                        else {
                            assert(s.isFile() && s.nlink === 1);
                            bytes += s.size;
                            files++;
                            assert(files <= 8192, 'Observed file threshold exceeded.');
                        }
                    }
                };
                if (root.optional && !fs.existsSync(root.path)) {
                    trees.push({
                        root: root.path,
                        kind: root.kind,
                        bytes: 0,
                        files: 0,
                        availability: 'absent-at-observation',
                    });
                    continue;
                }
                const rootStat = fs.lstatSync(root.path);
                assert(
                    rootStat.isDirectory() &&
                        !rootStat.isSymbolicLink() &&
                        fs.realpathSync(root.path) === root.path,
                );
                walk(root.path);
                trees.push({ root: root.path, kind: root.kind, bytes, files });
            }
            const payload = trees
                    .filter((t) => t.kind !== 'evidence')
                    .reduce((n, t) => n + t.bytes, 0),
                evidence = trees
                    .filter((t) => t.kind === 'evidence')
                    .reduce((n, t) => n + t.bytes, 0),
                end = this.clock(),
                row = {
                    stage,
                    atMs: end,
                    scanMs: end - start,
                    gapMs: this.last === null ? null : end - this.last,
                    trees,
                    jobBytes: payload + evidence,
                    measuredPeakLowerBound: (this.peak = Math.max(this.peak, payload + evidence)),
                    hardNativeDiskCap: false,
                    transientPeakKnown: false,
                    capacityQualifiedForFullPair: false,
                };
            this.last = end;
            row.thresholdExceeded =
                trees.filter((t) => t.kind !== 'evidence').reduce((n, t) => n + t.files, 0) >
                    pilotLimits.treeFiles ||
                payload > pilotLimits.treeBytes ||
                evidence > pilotLimits.evidenceBytes ||
                row.jobBytes > pilotLimits.jobBytes ||
                row.jobBytes > pilotLimits.cohortBytes;
            assert(this.samples.length < 1024, 'Observer row bound.');
            this.samples.push(row);
            this.emit(row);
            if (row.thresholdExceeded) {
                const error = Error('Observed threshold exceeded.');
                error.observedThresholdExceeded = true;
                error.observation = row;
                throw error;
            }
            return row;
        } catch (e) {
            this.failed ??= String(e);
            this.stop(e);
            if (!e.observedThresholdExceeded)
                this.emit({
                    stage,
                    availability: 'scan-failed',
                    atMs: this.clock(),
                    scanMs: this.clock() - start,
                    trees,
                    error: String(e).slice(0, 1024),
                    hardNativeDiskCap: false,
                    transientPeakKnown: false,
                    capacityQualifiedForFullPair: false,
                });
            throw e;
        }
    }
    snapshot() {
        return {
            samples: this.samples.length,
            measuredPeakLowerBound: this.peak,
            failed: this.failed,
            hardNativeDiskCap: false,
            transientPeakKnown: false,
            capacityQualifiedForFullPair: false,
        };
    }
}
