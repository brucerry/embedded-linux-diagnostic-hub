// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    bindObservationDirectory,
    requireObservationDirectoryIdentity,
} from './observation-paths.mjs';
import { closedObservationSecurityRefusal } from './observation-security.mjs';
import { observationInventory } from './observation-accounting.mjs';
import {
    readStreamedDurableArtifacts,
    artifactLines,
    digest,
} from './product-collector-evidence.mjs';
import { ancestryIdentity, checkAncestry, metadataIdentity } from './windows-preflight.mjs';
import {
    validatePilotBinding,
    bindingDigest,
    ptyObservationMode,
    pilotBindingMode,
} from './hosted-pilot-contract.mjs';
import { parsePtyObservationScope } from './pty-observation-scope.mjs';
export function preserveObservationPty(
    root,
    expected,
    { sourceRoot, host, canonicalTemp, ownerCheck, hold, io = fs, identity = metadataIdentity },
) {
    try {
        const ancestry = ancestryIdentity(root);
        ownerCheck(root);
        const tree = observationInventory(root, { io });
        assert(tree.bytes <= 8 * 1024 ** 2, 'Retained PTY evidence exceeds shared8MiB');
        const specs = [...tree.files].map(([file, row]) => ({
            name: path.relative(root, file).replaceAll('\\', '/'),
            path: file,
            max: Math.max(1, row.bytes),
        }));
        for (let i = 0; i < specs.length; i += 16)
            ownerCheck.many(specs.slice(i, i + 16).map((r) => r.path));
        const durable = readStreamedDurableArtifacts(specs, {
            io,
            check: () => checkAncestry(ancestry),
        });
        if (!durable.durability.complete) {
            hold({ phase: 'pty-evidence-durability-unknown', durability: durable.durability });
            throw Error('PTY evidence durability/closure unproved');
        }
        assert(durable.raw['pilot.jsonl'], 'Actual owned PTY binding journal required');
        let owned, closed, result;
        for (const line of artifactLines(durable.raw['pilot.jsonl'], 65536)) {
            const row = JSON.parse(line.toString());
            if (row.stage === 'pilot-owned.json') {
                assert(!owned);
                owned = row.data;
            }
            if (row.stage === 'pilot-real-os-pty-closed.json') {
                assert(!closed);
                closed = row.data;
            }
            if (row.stage === 'pilot-result') {
                assert(!result);
                result = row.data;
            }
        }
        assert(owned && closed && result);
        const b = owned.binding;
        assert.equal(bindingDigest(b), owned.bindingSHA256);
        validatePilotBinding(b, b.startedAt);
        assert.equal(pilotBindingMode(b), ptyObservationMode);
        assert.equal(b.sourceSHA256, expected.sourceSHA256);
        assert.equal(b.scopeSHA256, expected.scopeSHA256);
        assert.equal(b.pilotPolicySHA256, expected.policySHA256);
        assert.equal(
            digest(
                io.readFileSync(
                    path.join(sourceRoot, 'scripts/lib/hosted-pty-observation-policy.json'),
                ),
            ),
            expected.policySHA256,
        );
        parsePtyObservationScope(
            Buffer.from(expected.scopeJSON),
            expected.scopeSHA256,
            expected.sourceSHA256,
            expected.policySHA256,
        );
        for (const key of ['repository', 'run', 'attempt', 'commit'])
            assert.equal(b.host[key], host[key]);
        ownerCheck.many([canonicalTemp, b.roots.canonicalTemp.path]);
        const tempBinding = bindObservationDirectory(canonicalTemp, b.roots.canonicalTemp.path, {
            identity,
        });
        const temp = requireObservationDirectoryIdentity(
            canonicalTemp,
            b.roots.canonicalTemp.path,
            identity,
        );
        assert.equal(temp.dev, b.roots.canonicalTemp.dev);
        assert.equal(temp.ino, b.roots.canonicalTemp.ino);
        const evidence = identity(root);
        assert.equal(evidence.path, b.roots.evidenceRoot.path);
        assert.equal(evidence.dev, b.roots.evidenceRoot.dev);
        assert.equal(evidence.ino, b.roots.evidenceRoot.ino);
        assert.equal(closed.bindingSHA256, owned.bindingSHA256);
        assert(
            closed.proof.descendantsClosed &&
                closed.proof.leafReceiptsClosed &&
                closed.proof.logsClosed,
        );
        assert.equal(result.bindingSHA256, owned.bindingSHA256);
        assert.equal(result.passed, true);
        assert.equal(result.collectionApproval, false);
        tempBinding.check();
        checkAncestry(ancestry);
        return {
            bindingSHA256: owned.bindingSHA256,
            sourceSHA256: b.sourceSHA256,
            scopeSHA256: b.scopeSHA256,
            policySHA256: b.pilotPolicySHA256,
            ancestry,
            tempAncestries: tempBinding.ancestries,
            root: identity(root),
            files: durable.inventory.map((r) => ({
                path: r.name,
                bytes: r.bytes,
                sha256: r.sha256,
            })),
            durable: true,
            closed: true,
        };
    } catch (error) {
        // A proved input-only refusal owns no query process or raw evidence descriptor.
        // All trust/receipt failures and uncertain query/read closure still retain custody.
        if (!closedObservationSecurityRefusal(error))
            hold({ phase: 'pty-source-scope-or-closure-invalid', error: String(error) });
        throw error;
    }
}
