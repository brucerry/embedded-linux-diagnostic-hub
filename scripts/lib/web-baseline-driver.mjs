// Public hosted baseline only. Import is inert; no final-Web or release admission.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

export const WEB_BASELINE_HOST = Object.freeze({
    chrome: '/opt/google/chrome/chrome',
    driver: '/usr/local/share/chromedriver-linux64/chromedriver',
    version: '157.0.8103.50',
});
export const WEB_BASELINE_BOUNDS = Object.freeze({
    totalMs: 120000,
    workMs: 90000,
    requestMs: 25000,
    requests: 100,
    responseBytes: 256 * 1024,
    driverStreamBytes: 1024 * 1024,
});
const retained = new Set();
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const absolute = (p) =>
    typeof p === 'string' &&
    p.startsWith('/') &&
    path.posix.normalize(p) === p &&
    !/[\\\x00-\x20\x7f]/.test(p);
const keys = (v, names) => assert.deepEqual(Object.keys(v).sort(), [...names].sort());

export class WebBaselineFailure extends Error {
    constructor(stage, owner) {
        super('Public Web baseline refused: ' + stage);
        this.stage = stage;
        this.owner = owner;
    }
}

/** Fixed default local-only service. Do not add allowed-ips: that enables remote
 * binding in ChromeDriver. No inherited browser flags or sandbox-disable switch.
 * Parent directories and executable identity must be admitted before this port.
 */
export function driverLaunchPlan(stateDirectory) {
    assert.ok(absolute(stateDirectory));
    return Object.freeze({
        executable: WEB_BASELINE_HOST.driver,
        args: Object.freeze(['--port=0']),
        options: Object.freeze({
            cwd: stateDirectory,
            stdio: Object.freeze(['ignore', 'pipe', 'pipe']),
            env: Object.freeze({
                PATH: '/usr/bin:/bin',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                TZ: 'UTC',
                HOME: stateDirectory,
            }),
        }),
    });
}

/** Real HTTP adapter, callable only after a separately owned driver reports its
 * port. No DNS, proxy, redirect, retry, remote endpoint or caller-supplied headers.
 * Request/response closure is joined; an uncertain request is never a pass.
 */
export function requestLocalDriver(
    port,
    method,
    target,
    body,
    request = http.request,
    clock = { setTimer: setTimeout, clearTimer: clearTimeout },
) {
    assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
    assert.ok(['GET', 'POST', 'DELETE'].includes(method));
    assert.match(
        target,
        /^\/(?:status|shutdown|session(?:\/[A-Za-z0-9_-]{1,128}(?:\/(?:url|timeouts|execute\/(?:sync|async)|element\/[A-Za-z0-9_.:-]{1,256}\/(?:click|value)))?)?)$/,
    );
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    assert.ok(bytes.length <= WEB_BASELINE_BOUNDS.responseBytes);
    return new Promise((resolve, reject) => {
        let response,
            ended = false,
            requestClosed = false,
            responseClosed = false,
            failure,
            stopRequested = false;
        const chunks = [];
        let count = 0,
            responseChunks = 0;
        const finish = () => {
            if (!requestClosed || (response && !responseClosed)) return;
            clock.clearTimer(timer);
            if (failure || !ended || !response || response.statusCode !== 200) {
                reject(Error('Driver request failed or closure is uncertain.'));
                return;
            }
            try {
                const value = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
                );
                assert.ok(value && Object.hasOwn(value, 'value') && !value.value?.error);
                resolve(value.value);
            } catch {
                reject(Error('Driver response is unsupported.'));
            }
        };
        const req = request({
            hostname: '127.0.0.1',
            port,
            method,
            path: target,
            agent: false,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': bytes.length,
            },
        });
        const stop = () => {
            failure = true;
            if (stopRequested) return;
            stopRequested = true;
            try {
                req.destroy(Error('Driver request stopped.'));
            } catch {
                clock.clearTimer(timer);
                reject(Error('Driver request stop was not acknowledged.'));
            }
        };
        const timer = clock.setTimer(stop, WEB_BASELINE_BOUNDS.requestMs);
        req.on('error', () => {
            failure = true;
        });
        req.on('close', () => {
            requestClosed = true;
            finish();
        });
        req.on('response', (res) => {
            response = res;
            res.on('data', (b) => {
                count += b.length;
                responseChunks++;
                if (responseChunks > 4096 || count > WEB_BASELINE_BOUNDS.responseBytes) {
                    stop();
                } else chunks.push(Buffer.from(b));
            });
            res.on('error', () => {
                failure = true;
            });
            res.on('end', () => {
                ended = true;
            });
            res.on('close', () => {
                responseClosed = true;
                finish();
            });
        });
        req.end(bytes);
    });
}

/** Adopt the direct service before awaiting startup. Output is private/bounded;
 * only its fixed startup port is parsed. No signal, forced stream close or retry.
 */
export function startWebDriver(stateDirectory, ports) {
    const plan = driverLaunchPlan(stateDirectory);
    let child,
        port,
        spawned = false,
        exited = false,
        childClosed = false,
        code,
        signal;
    let failure = false,
        uncertain = false,
        pending = 0;
    const streams = {
        stdout: { bytes: 0, ended: false, closed: false, chunks: 0 },
        stderr: { bytes: 0, ended: false, closed: false, chunks: 0 },
    };
    let prefix = '',
        resolveReady,
        rejectReady,
        resolveClosed;
    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    ready.catch(() => {});
    const closed = new Promise((resolve) => {
        resolveClosed = resolve;
    });
    const snapshot = () => ({
        acquired: Boolean(child),
        pid: child?.pid ?? null,
        spawned,
        exited,
        childClosed,
        stdoutClosed: streams.stdout.closed,
        stderrClosed: streams.stderr.closed,
        stdoutEnded: streams.stdout.ended,
        stderrEnded: streams.stderr.ended,
        normalExit: exited && code === 0 && signal === null,
        failure,
        uncertain,
        pendingRequests: pending,
        descendantRetirement: 'not-observed',
    });
    const owner = Object.freeze({
        ready,
        closed,
        snapshot,
        async request(method, target, body) {
            assert.ok(port && !failure && !childClosed && pending === 0);
            pending++;
            try {
                return await (ports.request ?? requestLocalDriver)(port, method, target, body);
            } catch {
                failure = true;
                uncertain = true;
                throw new WebBaselineFailure('driver-request', owner);
            } finally {
                pending--;
            }
        },
    });
    retained.add(owner);
    const fail = () => {
        failure = true;
        uncertain = true;
        rejectReady(new WebBaselineFailure('driver-start', owner));
    };
    const finish = () => {
        if (!childClosed || !streams.stdout.closed || !streams.stderr.closed) return;
        if (
            !spawned ||
            !exited ||
            !streams.stdout.ended ||
            !streams.stderr.ended ||
            code !== 0 ||
            signal !== null
        )
            failure = true;
        resolveClosed(snapshot());
        if (!failure && pending === 0) retained.delete(owner);
        rejectReady(new WebBaselineFailure('driver-early-close', owner));
    };
    try {
        child = ports.launch(plan.executable, [...plan.args], {
            ...plan.options,
            env: { ...plan.options.env },
            stdio: [...plan.options.stdio],
        });
        child.on('spawn', () => {
            if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
                fail();
                return;
            }
            spawned = true;
            if (port) resolveReady({ port });
        });
        child.on('error', fail);
        child.on('exit', (c, s) => {
            exited = true;
            code = c;
            signal = s;
        });
        child.on('close', (c, s) => {
            childClosed = true;
            if (c !== code || s !== signal) fail();
            finish();
        });
        for (const name of ['stdout', 'stderr']) {
            child[name].on('data', (b) => {
                streams[name].bytes += b.length;
                streams[name].chunks++;
                if (
                    streams[name].bytes > WEB_BASELINE_BOUNDS.driverStreamBytes ||
                    streams[name].chunks > 4096
                ) {
                    fail();
                    return;
                }
                if (name === 'stdout' && !port) {
                    prefix += b.toString('utf8');
                    const match =
                        /(?:^|\n)ChromeDriver was started successfully on port ([1-9][0-9]{0,4})\.\r?\n/.exec(
                            prefix,
                        );
                    if (match) {
                        port = Number(match[1]);
                        if (port > 65535) {
                            fail();
                            return;
                        }
                        prefix = '';
                        if (spawned) resolveReady({ port });
                    }
                }
            });
            child[name].on('error', fail);
            child[name].on('end', () => {
                streams[name].ended = true;
            });
            child[name].on('close', () => {
                streams[name].closed = true;
                finish();
            });
        }
    } catch {
        fail();
    }
    return owner;
}

const bootScript = `const done=arguments[arguments.length-1], end=performance.now()+18000;
function check(){const ok=document.body?.innerText.includes('NOT CONNECTED');
if(ok)return done({disconnected:true,bridgeAbsent:typeof window.diagnosticHub==='undefined'});
if(performance.now()>end)return done(null);setTimeout(check,50);}check();`;
const importedScript = `const done=arguments[arguments.length-1],end=performance.now()+18000;
function check(){const text=document.body?.innerText||'';
if(text.includes('IMPORTED REPORT'))return done({imported:true,readOnly:text.includes('Historical SSH evidence opened locally. No device connection or upload.')});
if(performance.now()>end)return done(null);setTimeout(check,50);}check();`;
const findScript = `const kind=arguments[0];
if(kind==='input')return document.querySelector('input[aria-label="Import diagnostic report"]');
if(kind==='diagnostics')return [...document.querySelectorAll('.primary-nav button')].find(x=>/^Diagnostics \\d+$/.test(x.textContent.trim()));
if(kind==='identity')return [...document.querySelectorAll('.probe-card')].find(x=>[...x.querySelectorAll('h1,h2,h3,h4')].some(h=>h.textContent.trim()==='Kernel & architecture'));
if(kind==='stderr')return [...document.querySelectorAll('[role="dialog"] [role="tab"]')].find(x=>x.textContent.trim()==='Standard error');
return null;`;
const outputScript = `const dialog=document.querySelector('[role="dialog"]');
return dialog&&{title:dialog.getAttribute('aria-label')||dialog.querySelector('h1,h2,h3,h4')?.textContent?.trim(),
imported:dialog.innerText.includes('Imported evidence'),output:dialog.querySelector('.evidence-output')?.textContent};`;

/** Explicit original archive and driver ports. Benign fixtures test orchestration;
 * they never become a platform qualification record. No final-Web observer forged.
 */
export async function runWebBaseline(selection, ports) {
    keys(selection, ['stateDirectory', 'fixtureFile', 'fixture']);
    assert.ok(absolute(selection.stateDirectory) && absolute(selection.fixtureFile));
    assert.ok(selection.fixtureFile.startsWith(selection.stateDirectory + '/'));
    const fixture = structuredClone(selection.fixture);
    assert.equal(fixture.schemaVersion, 1);
    assert.equal(fixture.results.length, 1);
    const expected = fixture.results[0];
    for (const key of ['stdout', 'stderr'])
        assert.ok(typeof expected[key] === 'string' && expected[key].length < 65536);
    let stage = 'archive-readback',
        session,
        driver,
        binding,
        timedOut = false,
        closed = false,
        closeAttempted = false,
        sessionUnknown = false;
    const stages = [],
        pending = new Set(),
        started = ports.now();
    assert.ok(Number.isFinite(started) && started >= 0);
    let requests = 0;
    const owner = Object.freeze({
        snapshot: () => ({
            stage,
            stages: [...stages],
            timedOut,
            closed,
            pending: pending.size,
            sessionKnown: Boolean(session),
            sessionUnknown,
            closeAttempted,
            driver: driver?.snapshot() ?? null,
            host: ports.archive.host.snapshot(),
            qualification: 'public-baseline-only',
            releaseAcceptance: false,
        }),
    });
    retained.add(owner);
    async function bounded(operation, work = true) {
        const observedNow = ports.now();
        assert.ok(Number.isFinite(observedNow) && observedNow >= started);
        const remaining =
            started +
            (work ? WEB_BASELINE_BOUNDS.workMs : WEB_BASELINE_BOUNDS.totalMs) -
            observedNow;
        if (remaining <= 0 || timedOut) {
            timedOut = true;
            throw new WebBaselineFailure('deadline', owner);
        }
        const dispatchDeadline =
            started + (work ? WEB_BASELINE_BOUNDS.workMs : WEB_BASELINE_BOUNDS.totalMs);
        const task = Promise.resolve().then(() => {
            const dispatchNow = ports.now();
            assert.ok(Number.isFinite(dispatchNow) && dispatchNow >= observedNow);
            if (timedOut || dispatchNow >= dispatchDeadline) {
                timedOut = true;
                throw new WebBaselineFailure('deadline', owner);
            }
            return operation();
        });
        pending.add(task);
        task.then(
            () => pending.delete(task),
            () => pending.delete(task),
        );
        let timer;
        try {
            return await Promise.race([
                task,
                new Promise((_, reject) => {
                    timer = ports.setTimer(() => {
                        timedOut = true;
                        reject(new WebBaselineFailure('deadline', owner));
                    }, remaining);
                }),
            ]);
        } finally {
            ports.clearTimer(timer);
        }
    }
    async function command(method, suffix, body, closing = false) {
        assert.ok(++requests <= WEB_BASELINE_BOUNDS.requests);
        return bounded(() => driver.request(method, suffix, body), !closing);
    }
    const execute = (script, args = [], async = false) =>
        command('POST', '/session/' + session + '/execute/' + (async ? 'async' : 'sync'), {
            script,
            args,
        });
    async function element(kind) {
        const value = await execute(findScript, [kind]);
        assert.ok(value && typeof value[elementKey] === 'string');
        assert.match(value[elementKey], /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/);
        return value[elementKey];
    }
    async function closeOwned() {
        // Unknown native request/timeout remains held. Never repeat a submission.
        assert.ok(
            !closeAttempted &&
                !sessionUnknown &&
                !timedOut &&
                pending.size === 0 &&
                !driver.snapshot().uncertain,
        );
        closeAttempted = true;
        if (session) await command('DELETE', '/session/' + session, undefined, true);
        await command('GET', '/shutdown', undefined, true);
        const end = await bounded(() => driver.closed, false);
        assert.ok(
            end.spawned &&
                end.exited &&
                end.childClosed &&
                end.stdoutClosed &&
                end.stderrClosed &&
                end.stdoutEnded &&
                end.stderrEnded &&
                end.normalExit &&
                !end.failure &&
                !end.uncertain,
        );
        await bounded(() => ports.archive.host.close(), false);
        await bounded(() => ports.archive.revalidate(), false);
        closed = true;
        retained.delete(owner);
    }
    try {
        await bounded(() => ports.archive.revalidate());
        binding = await bounded(() => ports.archive.host.listen());
        assert.match(binding.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
        assert.match(binding.prefix, /^\/(?:[A-Za-z0-9_-]+\/)+$/);
        stages.push(stage);
        stage = 'sandboxed-browser-startup';
        driver = ports.startDriver(selection.stateDirectory);
        await bounded(() => driver.ready);
        const status = await command('GET', '/status');
        assert.equal(status.ready, true);
        // Paths/arguments are fixed; no acceptInsecureCerts/sandbox/automation fallback.
        sessionUnknown = true;
        const created = await command('POST', '/session', {
            capabilities: {
                alwaysMatch: {
                    browserName: 'chrome',
                    acceptInsecureCerts: false,
                    'goog:chromeOptions': {
                        binary: WEB_BASELINE_HOST.chrome,
                        args: [
                            '--headless=new',
                            '--user-data-dir=' + selection.stateDirectory + '/profile',
                            '--no-first-run',
                            '--no-default-browser-check',
                        ],
                    },
                },
            },
        });
        assert.match(created.sessionId, /^[A-Za-z0-9_-]{1,128}$/);
        session = created.sessionId;
        sessionUnknown = false;
        assert.equal(created.capabilities.browserVersion, WEB_BASELINE_HOST.version);
        assert.ok(
            created.capabilities.chrome?.chromedriverVersion?.startsWith(
                WEB_BASELINE_HOST.version + ' ',
            ),
        );
        await command('POST', '/session/' + session + '/timeouts', {
            script: 20000,
            pageLoad: 20000,
            implicit: 0,
        });
        await command('POST', '/session/' + session + '/url', {
            url: binding.origin + binding.prefix,
        });
        assert.deepEqual(await execute(bootScript, [], true), {
            disconnected: true,
            bridgeAbsent: true,
        });
        stages.push(stage);
        stage = 'fixture-ui';
        const input = await element('input');
        await command('POST', '/session/' + session + '/element/' + input + '/value', {
            text: selection.fixtureFile,
        });
        assert.deepEqual(await execute(importedScript, [], true), {
            imported: true,
            readOnly: true,
        });
        for (const kind of ['diagnostics', 'identity']) {
            const id = await element(kind);
            await command('POST', '/session/' + session + '/element/' + id + '/click', {});
        }
        let output = await execute(outputScript);
        assert.equal(output.title, 'Kernel & architecture');
        assert.equal(output.imported, true);
        assert.equal(output.output, expected.stdout);
        const stderr = await element('stderr');
        await command('POST', '/session/' + session + '/element/' + stderr + '/click', {});
        output = await execute(outputScript);
        assert.equal(output.output, expected.stderr);
        assert.equal(
            await command('GET', '/session/' + session + '/url'),
            binding.origin + binding.prefix,
        );
        stages.push(stage);
        stage = 'exact-input-and-close';
        await closeOwned();
        stages.push(stage);
        return Object.freeze({
            result: 'passed',
            qualification: 'public-baseline-only',
            stages: [...stages],
            requests,
            directClosure: true,
            descendantRetirement: 'not-observed',
            releaseAcceptance: false,
        });
    } catch {
        // A completed UI assertion may still be followed by one ordinary owned quit.
        // Uncertain/late request results, missing handles or close failures stay held.
        if (
            driver &&
            !closeAttempted &&
            !sessionUnknown &&
            !timedOut &&
            !driver.snapshot().uncertain &&
            pending.size === 0
        ) {
            try {
                await closeOwned();
            } catch {
                /* retained custody, no cleanup retry */
            }
        } else if (!driver && pending.size === 0 && !timedOut) {
            try {
                await bounded(() => ports.archive.host.close(), false);
                closed = true;
                retained.delete(owner);
            } catch {
                /* retained */
            }
        }
        throw new WebBaselineFailure(stage, owner);
    }
}
