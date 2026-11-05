import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { observeSourceBridge, sourceDigest } from './committed-source-bridge.mjs';
import { requireObservedClosure } from './owned-child.mjs';
import { startDiagnosticGatewayHealth } from './diagnostic-gateway-http.mjs';

export const RAW_CLI_REFERENCE = Object.freeze({ sourceCommit: '760dba0c7ab9f44b8eb7e00a4b53923272ea488a',
    sourceTree: '596e7f87fd8ef697e2f5b1509b342c0edddce7ec', runId: '41990160342', jobId: '127120220376', attempt: '1',
    receiptSHA256: '93c09e75f5f719a3ede713eadf6014d75a892979fe8e171b8e822790f50ecd9c',
    productionInventorySHA256: '14c3f8cb832fc751c0676ccdb16cecc747e2c3eac0d0ef31d0182b462f9d9325', productionFiles: 213 });
export const INSTRUMENTED_ENTRY = 'tests/fixtures/instrumented-gateway-check-entry.ts';
const observerPath = 'scripts/lib/instrumented-gateway-observer.mjs', retained = new Set();
const directories = ['src/', 'shared/', 'electron/', 'backend/', 'gateway/', 'public/'];
const files = ['package.json', 'package-lock.json', 'vite.config.mts', 'index.html', 'tsconfig.json', 'LICENSE', '.env.gateway.example', 'docs/gateway.md'];
function productionInventory(bridge) {
    return bridge.inventory.filter((r) => files.includes(r.path) || directories.some((p) => r.path.startsWith(p)))
        .map(({ path, mode, blob, bytes, sha256 }) => ({ path, mode, blob, bytes, sha256 }));
}
const absolute = (p) => assert.ok(typeof p === 'string' && p.length <= 4096 && Buffer.byteLength(p) <= 4096 && p.startsWith('/') && path.posix.normalize(p) === p && !/[\\\x00-\x20\x7f]/.test(p));
const tools = (v) => {
    assert.deepEqual(Object.keys(v).sort(), ['esbuildEntryBytes', 'esbuildEntryFormat', 'esbuildPath', 'esbuildSHA256', 'nodePath', 'nodeSHA256']);
    for (const k of ['esbuildPath', 'nodePath']) absolute(v[k]);
    for (const k of ['esbuildSHA256', 'nodeSHA256']) assert.match(v[k], /^[a-f0-9]{64}$/);
    assert.ok(Buffer.isBuffer(v.esbuildEntryBytes) && v.esbuildEntryBytes.length > 0 && v.esbuildEntryBytes.length <= 65536);
    assert.equal(sourceDigest(v.esbuildEntryBytes), v.esbuildSHA256); assert.equal(v.esbuildEntryFormat, 'node-script');
    assert.ok(['#!/usr/bin/env node\n','#!/usr/bin/env node\r\n','#!/usr/bin/node\n','#!/usr/bin/node\r\n']
        .some((s) => v.esbuildEntryBytes.subarray(0,Buffer.byteLength(s)).equals(Buffer.from(s))));
    const { esbuildEntryBytes: _bytes, ...observed } = v;
    return Object.freeze(observed);
};

/** Non-shipping producer through explicit admitted ports. Actual source is re-observed, not accepted
 * as a serialized bridge claim. A direct command acknowledgement does not prove service/group trust.
 */
export async function prepareInstrumentedGatewayCheck(input, ports) {
    assert.deepEqual(Object.keys(input).sort(), ['root', 'sourceCommit', 'sourceTree']); absolute(input.root);
    const selected = { sourceCommit: input.sourceCommit, sourceTree: input.sourceTree };
    for (const k of ['execute', 'readArtifact', 'scriptSnapshot', 'observeToolchain']) assert.equal(typeof ports[k], 'function');
    const owner = { phase: 'source', pending: null, failed: false, wholeGroupRetirement: null }; retained.add(owner);
    try {
        const bridge = await observeSourceBridge(selected, ports.sourceProvider);
        const production = productionInventory(bridge);
        assert.equal(production.length, RAW_CLI_REFERENCE.productionFiles);
        assert.equal(sourceDigest(JSON.stringify(production)), RAW_CLI_REFERENCE.productionInventorySHA256,
            'Production bytes differ from the independently frozen raw-CLI source.');
        for (const p of [INSTRUMENTED_ENTRY, observerPath, 'tests/fixtures/instrumented-gateway-entry.ts'])
            assert.ok(bridge.inventory.some((r) => r.path === p));
        const toolchain = tools(await ports.observeToolchain());
        assert.equal(toolchain.esbuildPath, input.root + '/node_modules/esbuild/bin/esbuild');
        const artifactPath = input.root + '/validation/gateway-ownership/instrumented/ownership.cjs';
        absolute(artifactPath); absolute(input.root + '/' + INSTRUMENTED_ENTRY);
        const plan = Object.freeze({ owner: randomBytes(16).toString('hex'), id: 1, role: 'build', cwd: input.root,
            command: Object.freeze([toolchain.nodePath, toolchain.esbuildPath, input.root + '/' + INSTRUMENTED_ENTRY,
                '--bundle', '--platform=node', '--format=cjs', '--outfile=' + artifactPath, '--external:ssh2']) });
        owner.phase = 'building'; owner.pending = plan;
        const acknowledgement = await ports.execute(plan);
        assert.deepEqual(Object.keys(acknowledgement).sort(), ['command', 'cwd', 'id', 'lifecycle', 'owner', 'role']);
        for (const k of ['owner', 'id', 'role', 'cwd', 'command']) assert.deepEqual(acknowledgement[k], plan[k]);
        assert.deepEqual(Object.keys(acknowledgement.lifecycle).sort(), ['closeCode','closeObserved','closeSignal','code','elapsedMs','error',
            'exitObserved','killErrors','pid','signal','spawnObserved','terminationRequested','timedOut']);
        for (const k of ['spawnObserved','exitObserved','closeObserved']) assert.equal(acknowledgement.lifecycle[k],true);
        for (const k of ['timedOut','terminationRequested']) assert.equal(acknowledgement.lifecycle[k],false);
        requireObservedClosure(acknowledgement.lifecycle);
        assert.equal(acknowledgement.lifecycle.code, 0); assert.equal(acknowledgement.lifecycle.terminationRequested, false);
        assert.deepEqual(acknowledgement.lifecycle.killErrors, []);
        assert.ok(Number.isFinite(acknowledgement.lifecycle.elapsedMs) && acknowledgement.lifecycle.elapsedMs >= 0 && acknowledgement.lifecycle.elapsedMs <= 480000);
        owner.pending = null; owner.phase = 'readback';
        assert.deepEqual(await observeSourceBridge(selected, ports.sourceProvider), bridge);
        assert.deepEqual(tools(await ports.observeToolchain()), toolchain);
        const observedArtifact = await ports.readArtifact(artifactPath, 32 * 1024 ** 2);
        assert.ok(Buffer.isBuffer(observedArtifact));
        assert.ok(observedArtifact.length > 0 && observedArtifact.length <= 32 * 1024 ** 2);
        const artifact = Buffer.from(observedArtifact);
        assert.ok(artifact.length > 0 && artifact.length <= 32 * 1024 ** 2);
        const supplied = await ports.scriptSnapshot();
        assert.ok(supplied instanceof Map && supplied.size > 0 && supplied.size <= 512);
        const scripts = new Map(), inventory = []; let total = 0;
        for (const [file, bytes] of supplied) {
            absolute(file); assert.ok(file.startsWith(path.dirname(artifactPath) + '/'));
            assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 ** 2); total += bytes.length; assert.ok(total <= 64 * 1024 ** 2);
            const copy = Buffer.from(bytes); scripts.set(file, copy); inventory.push({ path: file, bytes: copy.length, sha256: sourceDigest(copy) });
        }
        inventory.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        assert.ok(scripts.get(artifactPath)?.equals(artifact), 'Artifact differs from the prelaunch script snapshot.');
        assert.deepEqual(await observeSourceBridge(selected, ports.sourceProvider), bridge);
        assert.deepEqual(tools(await ports.observeToolchain()), toolchain);
        const selection = Object.freeze({ ...selected, artifactPath, artifactSHA256: sourceDigest(artifact),
            observerSHA256: bridge.inventory.find((r) => r.path === observerPath).sha256 });
        const binding = Object.freeze({ kind: 'separate-instrumented-gateway-build-byte-binding-v1', source: selected,
            sourceBridgeSHA256: sourceDigest(JSON.stringify(bridge) + '\n'), rawCLIReference: { ...RAW_CLI_REFERENCE },
            productionComparison: '213-source-files-match-frozen-raw-CLI-inventory', toolchain,
            entrySHA256: bridge.inventory.find((r) => r.path === INSTRUMENTED_ENTRY).sha256,
            observerSHA256: selection.observerSHA256, artifactPath, artifactSHA256: selection.artifactSHA256,
            artifactBytes: artifact.length, scriptInventory: inventory, scriptInventorySHA256: sourceDigest(JSON.stringify(inventory)),
            commandAcknowledgementSHA256: sourceDigest(JSON.stringify(acknowledgement)),
            provenance: 'local-source-command-and-byte-consistency-not-service-attestation', buildProvenanceVerified: false,
            wholeGroupRetirement: null, releaseAcceptance: false });
        owner.phase = 'prepared'; retained.delete(owner);
        return Object.freeze({ binding, selection, scripts });
    } catch (error) { owner.failed = true; owner.phase = 'failed'; throw Object.assign(Error('Instrumented build preparation failed; uncertain custody retained.', { cause: error }), { owner }); }
}

/** One instrumented ownership workload, no process/listener/session defaults. Native ports are
 * supplied by the separate non-shipping entry. Does not qualify the unmodified CLI by transfer.
 */
export function startInstrumentedGatewayCheck(prepared, token, ports) {
    assert.match(token, /^[a-f0-9]{64}$/);
    for (const k of ['prepare', 'request', 'setTimer', 'clearTimer', 'now']) assert.equal(typeof ports[k], 'function');
    ports = Object.freeze({ ...ports });
    const binding = structuredClone(prepared.binding), selection = { ...prepared.selection }, scripts = new Map();
    assert.equal(binding.kind, 'separate-instrumented-gateway-build-byte-binding-v1');
    assert.deepEqual(selection, { ...binding.source, artifactPath: binding.artifactPath, artifactSHA256: binding.artifactSHA256, observerSHA256: binding.observerSHA256 });
    assert.equal(binding.releaseAcceptance, false); assert.equal(binding.buildProvenanceVerified, false);
    assert.deepEqual(binding.rawCLIReference, RAW_CLI_REFERENCE);
    assert.equal(sourceDigest(JSON.stringify(binding.scriptInventory)), binding.scriptInventorySHA256);
    for (const row of binding.scriptInventory) {
        const b = prepared.scripts.get(row.path); assert.ok(Buffer.isBuffer(b) && b.length === row.bytes && sourceDigest(b) === row.sha256);
        scripts.set(row.path, Buffer.from(b));
    }
    assert.equal(scripts.size, prepared.scripts.size); assert.equal(sourceDigest(scripts.get(selection.artifactPath)), selection.artifactSHA256);
    let resolveResult, rejectResult, resolveClosed;
    const result = new Promise((yes,no) => { resolveResult = yes; rejectResult = no; }); result.catch(() => {});
    const closed = new Promise((yes) => { resolveClosed = yes; });
    let bootstrap, health, timer, timerCleared = false, primary, closeTask, closeIssued = false, retired = false, phase = 'prepared', unknown;
    const started = ports.now(); assert.ok(Number.isFinite(started));
    const snapshot = () => Object.freeze({ phase, failed: Boolean(primary), bootstrapHeld: Boolean(bootstrap),
        requestHeld: Boolean(health && !health.snapshot().retired), timerHeld: timer !== undefined && !timerCleared, unknownOperation: Boolean(unknown), retired,
        wholeGroupRetirement: null, releaseAcceptance: false });
    const owner = Object.freeze({ result, closed, snapshot }); retained.add(owner);
    const fail = (reason) => {
        if (retired) return; primary ??= Error(reason); phase = 'failed';
        rejectResult(Object.assign(Error('Separate instrumented ownership check failed or remains held.', { cause: primary }), { owner }));
    };
    function close() {
        if (closeIssued || !bootstrap) return closeTask;
        closeIssued = true;
        try { closeTask = bootstrap.close(); } catch { unknown = true; throw Error('Close dispatch unacknowledged.'); }
        if (!closeTask || typeof closeTask.then !== 'function' || typeof closeTask.catch !== 'function') { unknown = closeTask ?? true; throw Error('Unsupported close lifetime.'); }
        closeTask.catch(() => {}); return closeTask;
    }
    void (async () => {
        let before, afterHealth, observation, healthResult;
        try {
            timer = ports.setTimer(() => { fail('Instrumented ownership deadline exceeded.'); try { close(); } catch { fail('Close request unacknowledged.'); } }, 45000);
            if (timer === undefined || typeof timer?.then === 'function') { unknown = timer ?? true; if (typeof timer?.then === 'function') Promise.resolve(timer).catch(() => {}); throw Error('Unsupported timer.'); }
            phase = 'starting';
            bootstrap = ports.prepare(selection, scripts);
            if (typeof bootstrap?.then === 'function') { unknown = bootstrap; Promise.resolve(bootstrap).catch(() => {}); throw Error('Unsupported asynchronous bootstrap acquisition.'); }
            assert.ok(bootstrap && ['start','listen','sample','close','snapshot'].every((k) => typeof bootstrap[k] === 'function'));
            assert.ok(!primary);
            await bootstrap.start({ token, origins: ['http://127.0.0.1'], targets: [{ host: '127.0.0.1', port: 1, fingerprint: 'SHA256:' + 'A'.repeat(43) }] });
            assert.ok(!primary);
            const address = await bootstrap.listen(0); assert.ok(!primary);
            assert.equal(address.host, '127.0.0.1'); assert.ok(Number.isInteger(address.port) && address.port >= 1024 && address.port <= 65535);
            before = bootstrap.sample(); assert.equal(before.stopping, false); assert.equal(before.serverListening, true); assert.equal(before.cleanupTimers, 1);
            phase = 'health'; health = startDiagnosticGatewayHealth({ port: address.port, role: 'healthy', token, version: '0.6.0' }, ports);
            healthResult = await health.result; await health.closed; assert.ok(!primary);
            afterHealth = bootstrap.sample(); assert.equal(afterHealth.stopping, false); assert.equal(afterHealth.serverListening, true); assert.equal(afterHealth.cleanupTimers, 1);
            // Client-side close is not a server-side join. Preserve this actual active sample;
            // only the product close acknowledgement below authoritatively joins its counters.
        } catch { fail('Instrumented startup, source observation or workload failed.'); }
        finally {
            let localClosed = false;
            try {
                if (!bootstrap || unknown) throw Error('Unknown bootstrap or timer custody.');
                try { observation = await close(); } catch { fail('Instrumented close reported failure.'); }
                assert.equal(bootstrap.snapshot().localRetirementAcknowledged, true);
                await bootstrap.retirement;
                if (health) await health.closed;
                const state = bootstrap.snapshot();
                assert.equal(state.localRetirementAcknowledged, true); assert.equal(state.productHeld, false); assert.equal(state.factoryHeld, false);
                assert.equal(state.serverListenerHeld, false); assert.equal(state.unknownServerOperations, 0);
                assert.equal(state.loader.observerRetired, true); assert.equal(state.loader.pendingCallbacks, 0); assert.equal(state.loader.unknownOperations, 0);
                const clearResult = ports.clearTimer(timer);
                if (clearResult !== undefined) {
                    unknown = { clearResult };
                    if (typeof clearResult?.then === 'function') Promise.resolve(clearResult).catch(() => {});
                    throw Error('Timer retirement unacknowledged.');
                }
                timerCleared = true;
                localClosed = true;
                if (!primary) {
                    const record = observation.record;
                    assert.ok(Buffer.isBuffer(observation.bytes) && observation.bytes.length <= 4 * 1024 ** 2);
                    assert.equal(sourceDigest(observation.bytes), observation.sha256);
                    assert.ok(observation.bytes.equals(Buffer.from(JSON.stringify(record) + '\n')));
                    assert.equal(record.instrumented, true); assert.equal(record.productCloseAcknowledged, true); assert.equal(record.localObserverRetirementAcknowledged, true);
                    assert.equal(record.buildProvenanceVerified, false); assert.equal(record.releaseAcceptance, false); assert.equal(record.processGroupRetirement, null);
                    assert.deepEqual(record.sourceSelection, selection);
                    assert.deepEqual(record.compiled.selected, selection); assert.equal(record.compiled.observerRetired, true);
                    assert.ok(record.compiled.compiledScripts.some((r) => r.path === selection.artifactPath && r.sha256 === selection.artifactSHA256));
                    assert.equal(record.productCountersAfterClose.stopping, true); assert.equal(record.productCountersAfterClose.serverListening, false);
                    for (const [key,value] of Object.entries(record.productCountersAfterClose)) if (!['stopping','serverListening'].includes(key)) assert.equal(value,0);
                    const elapsedMs = ports.now() - started; assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 45000);
                    const receipt = { schema: 'separate-instrumented-gateway-ownership-check-v1', instrumented: true,
                        source: binding.source, rawCLIReference: binding.rawCLIReference, evidenceSeparation: 'this-instrumented-build-only-no-transfer-to-raw-CLI',
                        bindingSHA256: sourceDigest(JSON.stringify(binding) + '\n'), artifactSHA256: selection.artifactSHA256,
                        before, afterHealth, afterClose: record.productCountersAfterClose, health: healthResult,
                        observerRecordSHA256: observation.sha256, compiledScripts: record.compiled.compiledScripts.length,
                        productCloseAcknowledged: true, localObserverRetired: true, elapsedMs,
                        wholeGroupRetirement: null, shippedCLIBehavior: null, shippingPerformance: null, shippingGC: null, releaseAcceptance: false };
                    const bytes = Buffer.from(JSON.stringify(receipt) + '\n'); assert.ok(bytes.length <= 16384);
                    scripts.clear(); retired = true; phase = 'local-owners-closed'; retained.delete(owner); resolveClosed(snapshot()); resolveResult({ receipt, bytes });
                } else { scripts.clear(); retired = true; retained.delete(owner); resolveClosed(snapshot()); }
            } catch {
                fail('Instrumented close, record validation or observer retirement failed.');
                if (localClosed) { scripts.clear(); retired = true; retained.delete(owner); resolveClosed(snapshot()); }
            }
        }
    })();
    return owner;
}
