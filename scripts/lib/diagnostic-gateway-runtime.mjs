import assert from 'node:assert/strict';
import path from 'node:path';
import { startDiagnosticGatewayHealth } from './diagnostic-gateway-http.mjs';

const retained = new Set();
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
    return { promise, resolve, reject };
};
export const GATEWAY_RUNTIME_BOUNDS = Object.freeze({ totalMs: 45000, startupMs: 10000, shutdownMs: 10000, streamBytes: 65536, streamChunks: 1024 });
export function gatewayInstallPlan(nodePath, npmPath, directory, owner) {
    for (const p of [nodePath, npmPath, directory]) assert.ok(p.startsWith('/') && path.posix.normalize(p) === p && !/[\\\x00-\x20\x7f]/.test(p));
    assert.equal(npmPath, path.dirname(path.dirname(nodePath)) + '/lib/node_modules/npm/bin/npm-cli.js');
    assert.match(owner, /^[a-f0-9]{32}$/);
    return Object.freeze({ role: 'install', owner, id: 1, cwd: directory + '/install', command: Object.freeze([
        nodePath, npmPath, 'ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0',
        '--global=false', '--workspaces=false', '--registry=https://registry.npmjs.org', '--prefix=' + directory + '/install',
        '--cache=' + directory + '/cache', '--userconfig=' + directory + '/config/user.npmrc', '--globalconfig=' + directory + '/config/global.npmrc',
    ]) });
}

/** Actual raw child/HTTP orchestration through explicit ports. The supplied final-byte observer
 * independently owns its installation census and child observations. No default IO or group proof.
 */
export function startDiagnosticGatewayRuntime(input, ports) {
    assert.deepEqual(Object.keys(input).sort(), ['nodePath', 'port', 'root', 'token', 'version']);
    assert.equal(input.port, 58731); assert.match(input.token, /^[a-f0-9]{64}$/); assert.equal(input.version, '0.6.0');
    for (const p of [input.root, input.nodePath]) assert.ok(p.startsWith('/') && path.posix.normalize(p) === p && !/[\\\x00-\x20\x7f]/.test(p));
    for (const k of ['launch', 'request', 'setTimer', 'clearTimer', 'now']) assert.equal(typeof ports[k], 'function');
    assert.equal(typeof ports.observer.observeChild, 'function'); ports = Object.freeze({ ...ports });
    const selected = { ...input }, result = deferred(), closed = deferred(), ready = deferred(), listeners = [], timers = new Set(), unknown = new Set(), requests = new Set();
    const rows = [], started = ports.now(); assert.ok(Number.isFinite(started) && started >= 0);
    const output = { stdout: { bytes: 0, chunks: 0, closed: false, data: [] }, stderr: { bytes: 0, chunks: 0, closed: false, data: [] } };
    let child, observed, primary, spawned = false, exited = false, childClosed = false, readySeen = false, closeIntent = false, signalRequested = false, signalAck = false, finishing = false, retired = false, flowDone = false;
    let code = null, signal = null, closeCode = null, closeSignal = null, startupTimer;
    const snapshot = () => Object.freeze({ spawned, exited, childClosed, readySeen, signalRequested, signalAck, flowDone,
        stdoutClosed: output.stdout.closed, stderrClosed: output.stderr.closed, requestOwners: requests.size,
        listeners: listeners.length, timers: timers.size, unknownOperations: unknown.size, failed: Boolean(primary), retired,
        wholeGroupRetirement: null, releaseAcceptance: false });
    const owner = Object.freeze({ result: result.promise, closed: closed.promise, snapshot }); retained.add(owner);
    function fail(reason) {
        if (retired) return; primary ??= Error(reason); ready.reject(primary);
        result.reject(Object.assign(Error('Gateway runtime diagnostic failed or remains held.', { cause: primary }), { owner }));
    }
    function sync(v, wanted) {
        if (v === wanted) return; unknown.add(v); try { if (typeof v?.then === 'function') Promise.resolve(v).catch(() => {}); } catch {}
        throw Error('Unsupported synchronous runtime port.');
    }
    function on(target, event, callback) { listeners.push({ target, event, callback }); sync(target.on(event, callback), target); }
    function timer(ms, callback) {
        const lease = { handle: undefined }; timers.add(lease); lease.handle = ports.setTimer(callback, ms);
        if (lease.handle === undefined || typeof lease.handle?.then === 'function') { unknown.add(lease.handle); if (typeof lease.handle?.then === 'function') Promise.resolve(lease.handle).catch(() => {}); throw Error('Unsupported runtime timer.'); }
        return lease;
    }
    function clear(lease) { if (!lease || !timers.has(lease)) return; sync(ports.clearTimer(lease.handle), undefined); timers.delete(lease); }
    function normalClose() {
        closeIntent = true;
        if (!spawned || exited || signalRequested || !child) return;
        signalRequested = true; // Before dispatch; never retry an uncertain signal.
        try { signalAck = child.kill('SIGTERM'); assert.equal(signalAck, true); timer(GATEWAY_RUNTIME_BOUNDS.shutdownMs, () => fail('Normal close deadline exceeded.')); }
        catch { fail('Normal shutdown request unacknowledged.'); }
    }
    async function finish() {
        if (finishing || !flowDone || !childClosed || !output.stdout.closed || !output.stderr.closed || !observed) return;
        finishing = true;
        try {
            await observed.joined;
            for (const lease of requests) { assert.ok(lease.owner); await lease.owner.closed; requests.delete(lease); }
            assert.equal(unknown.size, 0);
            for (const lease of [...timers]) clear(lease);
            while (listeners.length) { const row = listeners.at(-1); sync(row.target.off(row.event, row.callback), row.target); listeners.pop(); }
            const elapsedMs = ports.now() - started;
            if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > GATEWAY_RUNTIME_BOUNDS.totalMs) fail('Runtime observation budget exceeded.');
            if (!spawned || !exited || !signalRequested || !signalAck || code !== 0 || signal !== null || closeCode !== code || closeSignal !== signal) fail('Normal direct-child lifecycle incomplete.');
            if (!primary) {
                const observation = await observed.completion;
                assert.deepEqual(rows.map((r) => r.status), [200, 401, 403]);
                assert.equal(requests.size, 0);
                const receipt = { schema: 'same-run-gateway-runtime-diagnostic-v1', status: 'cli-health-auth-and-direct-close-observed',
                    checks: rows, elapsedMs, normalSignalRequests: 1, directChildClosed: true,
                    stdoutBytes: output.stdout.bytes, stderrBytes: output.stderr.bytes,
                    observationSHA256: observation.sha256, installedFiles: observation.record.installation.files.length,
                    wholeGroupRetirement: null, gatewayInternalOwnership: null, loadedCodeIdentity: null,
                    endpointProvenance: 'trusted-disposable-runner-and-owned-child-readiness-not-kernel-attestation', releaseAcceptance: false };
                retired = true; retained.delete(owner); closed.resolve(snapshot()); result.resolve({ receipt, observation });
            } else { retired = true; retained.delete(owner); closed.resolve(snapshot()); }
        } catch { fail('Runtime final observation or observer retirement failed.'); }
    }
    try {
        timer(GATEWAY_RUNTIME_BOUNDS.totalMs, () => { fail('Total runtime deadline exceeded.'); normalClose(); });
        startupTimer = timer(GATEWAY_RUNTIME_BOUNDS.startupMs, () => fail('Gateway startup deadline exceeded.'));
        const env = { PATH: path.dirname(selected.nodePath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production',
            HUB_GATEWAY_HOST: '127.0.0.1', HUB_GATEWAY_PORT: String(selected.port), HUB_GATEWAY_TOKEN: selected.token,
            HUB_ALLOWED_ORIGINS: 'http://127.0.0.1', HUB_TARGETS_JSON: JSON.stringify([{ host: '127.0.0.1', port: 1, fingerprint: 'SHA256:' + 'A'.repeat(43) }]) };
        child = ports.launch(selected.nodePath, [selected.root + '/dist-gateway/main.cjs'], { cwd: selected.root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        if (typeof child?.then === 'function') { unknown.add(child); Promise.resolve(child).catch(() => {}); throw Error('Unsupported asynchronous launch.'); }
        assert.ok(child && child.stdin === null && child.exitCode === null && child.signalCode === null);
        observed = ports.observer.observeChild(child); observed.completion.catch(() => fail('Final-byte child observation failed.'));
        on(child, 'error', () => fail('Gateway child error.'));
        on(child, 'spawn', () => {
            try {
                assert.ok(!spawned && Number.isSafeInteger(child.pid) && child.pid > 0);
                assert.equal(child.spawnfile, selected.nodePath); assert.deepEqual(child.spawnargs, [selected.nodePath, selected.root + '/dist-gateway/main.cjs']);
                spawned = true; if (closeIntent) normalClose();
            } catch { fail('Gateway child identity unsupported.'); }
        });
        on(child, 'exit', (c, s) => { if (exited || !spawned || !signalRequested || c !== 0 || s !== null) fail('Unexpected Gateway exit.'); exited = true; code = c; signal = s; void finish(); });
        on(child, 'close', (c, s) => { if (childClosed) fail('Duplicate Gateway close.'); childClosed = true; closeCode = c; closeSignal = s; void finish(); });
        for (const name of ['stdout', 'stderr']) {
            const stream = output[name]; assert.ok(child[name]);
            on(child[name], 'error', () => fail('Gateway output error.'));
            on(child[name], 'data', (b) => {
                if (!Buffer.isBuffer(b) || stream.closed || !b.length) { fail('Unsupported Gateway output.'); return; }
                if (primary) return;
                if (stream.bytes + b.length > GATEWAY_RUNTIME_BOUNDS.streamBytes || stream.chunks >= GATEWAY_RUNTIME_BOUNDS.streamChunks) { fail('Gateway output bound exceeded.'); return; }
                stream.bytes += b.length; stream.chunks++;
                if (name === 'stdout' && !readySeen) {
                    stream.data.push(Buffer.from(b));
                    const line = Buffer.from(`Diagnostic Hub gateway listening on 127.0.0.1:${selected.port}. Place behind HTTPS for website use.\n`);
                    if (Buffer.concat(stream.data).includes(line)) {
                        if (!spawned) { fail('Readiness preceded owned spawn.'); return; }
                        try { clear(startupTimer); readySeen = true; stream.data.length = 0; ready.resolve(); } catch { fail('Startup observer cleanup unacknowledged.'); }
                    }
                }
            });
            on(child[name], 'close', () => { if (stream.closed) fail('Duplicate Gateway output close.'); stream.closed = true; void finish(); });
        }
        void (async () => {
            try {
                await ready.promise;
                for (const role of ['healthy', 'no-token', 'bad-origin']) {
                    if (primary) throw primary;
                    const lease = { owner: null }; requests.add(lease);
                    const request = startDiagnosticGatewayHealth({ port: selected.port, token: selected.token, version: selected.version, role }, ports); lease.owner = request;
                    const row = await request.result; await request.closed; requests.delete(lease); rows.push(row);
                }
            } catch { fail('Gateway health/auth check failed.'); }
            finally { flowDone = true; normalClose(); void finish(); }
        })();
    } catch { fail('Gateway runtime acquisition unacknowledged.'); normalClose(); }
    return owner;
}
