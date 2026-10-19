// @ts-nocheck
/** Harmless IPC integration actor. Product parents are virtual; log/journal descriptors are real. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { connectObservationCollector } from '../../scripts/lib/observation-handoff.mjs';
import { collectProductPreparation } from '../../scripts/lib/product-collector-controller.mjs';
import { CollectionEntry } from '../../scripts/lib/product-entry-custody.mjs';
import { RootGuard, ProductJournal } from '../../scripts/lib/product-collector-files.mjs';
import { observationDigest } from '../../scripts/lib/windows-observation-approval.mjs';
import { closeEntries, digest } from '../../scripts/lib/product-collector-evidence.mjs';
const { manifest, nonce, cohort, fault } = JSON.parse(process.argv[2]);
const remote = await connectObservationCollector(manifest, nonce, cohort, { ownerCheck: () => {} }),
    entry = new CollectionEntry({
        nonce,
        cohort: JSON.stringify(cohort),
        events: remote.events,
        requireIPC: true,
        requireCohort: true,
    }),
    root = path.join(manifest.outputRoot, 'collector');
fs.mkdirSync(root);
const guard = new RootGuard(root),
    journal = new ProductJournal(guard, path.join(root, 'journal.jsonl'));
let evidenceSealed = false;
const ports = {
    owner: { fixtureOnly: true },
    manifestSHA256: observationDigest(manifest),
    lease: remote.ports.lease,
    journal,
    verify: remote.ports.verify,
    record(name, value) {
        assert(!evidenceSealed);
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        guard.write(name, bytes);
        return { name, bytes: bytes.length, sha256: digest(bytes) };
    },
    async finalEvidenceClosed(receipt, outcome) {
        evidenceSealed = true;
        await remote.ports.finalEvidenceClosed(receipt, outcome);
    },
    evidenceComplete: () => true,
    begin(spec, allocate) {
        const job = allocate(),
            child = Object.assign(new EventEmitter(), { pid: 100 + spec.ordinal, connected: true });
        const logs = ['stdout', 'stderr'].map((stream) => ({
            fd: fs.openSync(path.join(root, `parent-${spec.ordinal}.${stream}.log`), 'wx'),
            errors: [],
            attempted: false,
        }));
        queueMicrotask(() => {
            child.emit('spawn');
            child.emit('exit', fault === 'product' ? 1 : 0, null);
            child.emit('close', fault === 'product' ? 1 : 0, null);
        });
        return {
            child,
            job,
            argv: ['virtual-product-parent'],
            cwd: root,
            setup() {},
            cancel() {},
            closeLogs: () => closeEntries(logs),
            inspect: async () => ({
                valid: fault !== 'product',
                ownershipComplete: true,
                error: fault === 'product' ? 'CRC mismatch' : null,
                observation: {
                    status:
                        fault === 'product'
                            ? 'PRODUCT_OWNERSHIP_INTEGRITY_FAILURE'
                            : 'COMPLETE_RAW_OBSERVATION',
                    memoryQualified: false,
                },
            }),
        };
    },
    summary() {},
    holdUnknown: async (value) => {
        throw Error('Unexpected fixture hold ' + JSON.stringify(value));
    },
};
const result = await collectProductPreparation(manifest, ports, {
    entry,
    events: remote.events,
    supervisorNonce: nonce,
    startedAt: cohort.startedAt,
});
await new Promise((resolve) => setTimeout(resolve, 150));
entry.dispose({ closed: true });
remote.ports.dispose();
process.exitCode = fault === 'product' ? 1 : 0;
process.disconnect();
