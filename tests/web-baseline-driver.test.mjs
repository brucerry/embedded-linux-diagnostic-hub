// Inert protocol/process fixtures only. No browser, child or listener starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    driverLaunchPlan,
    startWebDriver,
    runWebBaseline,
    requestLocalDriver,
    WEB_BASELINE_HOST,
    WEB_BASELINE_BOUNDS,
    WebBaselineFailure,
} from '../scripts/lib/web-baseline-driver.mjs';

const fixture = {
    schemaVersion: 1,
    results: [{ stdout: 'retained stdout\n', stderr: 'retained stderr\n' }],
};
const selection = {
    stateDirectory: '/private/state',
    fixtureFile: '/private/state/report.json',
    fixture,
};
const normal = {
    spawned: true,
    exited: true,
    childClosed: true,
    stdoutClosed: true,
    stderrClosed: true,
    stdoutEnded: true,
    stderrEnded: true,
    normalExit: true,
    failure: false,
    uncertain: false,
};
function harness(options = {}) {
    const calls = [],
        events = [],
        timers = new Map();
    let next = 0,
        uncertain = false,
        stderr = false,
        validations = 0,
        closeCount = 0;
    let resolveClosure;
    const closed = new Promise((resolve) => {
        resolveClosure = resolve;
    });
    const origin = 'http://127.0.0.1:3000',
        prefix = '/artifact/';
    const driver = {
        ready: options.ready ?? Promise.resolve({ port: 3001 }),
        closed,
        snapshot: () => ({ uncertain }),
        async request(method, target, body) {
            calls.push({ method, target, body });
            if (options.fail === target) {
                uncertain = true;
                throw Error('fixture request failure');
            }
            if (target === '/status') return { ready: true };
            if (target === '/session' && method === 'POST')
                return {
                    sessionId: options.badSession ? undefined : 'owned-session',
                    capabilities: {
                        browserVersion: options.badVersion ? '0.0.0.0' : WEB_BASELINE_HOST.version,
                        chrome: { chromedriverVersion: WEB_BASELINE_HOST.version + ' (fixture)' },
                    },
                };
            if (target.endsWith('/execute/async')) {
                return body.script.includes('NOT CONNECTED')
                    ? { disconnected: true, bridgeAbsent: true }
                    : { imported: true, readOnly: true };
            }
            if (target.endsWith('/execute/sync')) {
                if (body.args?.length)
                    return { 'element-6066-11e4-a52e-4f735466cecf': body.args[0] };
                return {
                    title: 'Kernel & architecture',
                    imported: true,
                    output: options.badUI
                        ? 'wrong fixture output'
                        : fixture.results[0][stderr ? 'stderr' : 'stdout'],
                };
            }
            if (target.endsWith('/stderr/click')) stderr = true;
            if (target.endsWith('/url') && method === 'GET') return origin + prefix;
            if (method === 'DELETE') events.push('session-quit');
            if (target === '/shutdown') {
                events.push('service-shutdown');
                if (!options.delayClose) {
                    events.push('driver-closed');
                    resolveClosure(normal);
                }
            }
            return null;
        },
    };
    const archive = {
        host: {
            snapshot: () => ({ closeCount }),
            async listen() {
                events.push('host-listen');
                return { origin, prefix };
            },
            async close() {
                closeCount++;
                events.push('host-close');
                if (options.hostCloseFails) throw Error('host fixture close');
            },
        },
        async revalidate() {
            validations++;
            events.push('readback');
            if (options.archiveMismatch && validations === 1) throw Error('archive mismatch');
            return {};
        },
    };
    const ports = {
        archive,
        now: () => options.elapsed?.() ?? 0,
        setTimer(fn) {
            const id = ++next;
            timers.set(id, fn);
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        startDriver() {
            events.push('driver-start');
            return driver;
        },
    };
    return {
        ports,
        calls,
        events,
        timers,
        closeCount: () => closeCount,
        closeDriver() {
            events.push('driver-closed');
            resolveClosure(normal);
        },
    };
}
test('service launch uses only fixed local-default arguments and complete isolated environment', () => {
    const p = driverLaunchPlan('/private/state');
    assert.equal(p.executable, WEB_BASELINE_HOST.driver);
    assert.deepEqual(p.args, ['--port=0']);
    assert.deepEqual(Object.keys(p.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TZ']);
    assert.equal(p.options.env.HOME, '/private/state');
    assert.throws(() => driverLaunchPlan('/private/../state'));
});
test('synthetic same-archive UI sequence joins quit, service closure and final readback', async () => {
    const h = harness();
    const r = await runWebBaseline(selection, h.ports);
    assert.equal(r.result, 'passed');
    assert.equal(r.qualification, 'public-baseline-only');
    assert.equal(r.releaseAcceptance, false);
    assert.equal(r.descendantRetirement, 'not-observed');
    assert.equal(h.events[0], 'readback');
    assert.ok(h.events.indexOf('driver-closed') < h.events.indexOf('host-close'));
    assert.equal(h.events.at(-1), 'readback');
    const create = h.calls.find((c) => c.target === '/session').body.capabilities.alwaysMatch;
    assert.equal(create['goog:chromeOptions'].binary, WEB_BASELINE_HOST.chrome);
    assert.deepEqual(create['goog:chromeOptions'].args, [
        '--headless=new',
        '--user-data-dir=/private/state/profile',
        '--no-first-run',
        '--no-default-browser-check',
    ]);
    assert.ok(!JSON.stringify(create).includes('no-sandbox'));
    assert.equal(h.calls.filter((c) => c.method === 'DELETE').length, 1);
    assert.equal(h.calls.filter((c) => c.target === '/shutdown').length, 1);
    assert.equal(h.timers.size, 0);
});
test('changed archive refuses before service allocation', async () => {
    const h = harness({ archiveMismatch: true });
    await assert.rejects(runWebBaseline(selection, h.ports), (e) => e.stage === 'archive-readback');
    assert.ok(!h.events.includes('driver-start'));
    assert.equal(h.calls.length, 0);
});
test('known UI mismatch fails while performing one normal owned close', async () => {
    const h = harness({ badUI: true });
    await assert.rejects(
        runWebBaseline(selection, h.ports),
        (e) => e.stage === 'fixture-ui' && e.owner.snapshot().closed,
    );
    assert.equal(h.calls.filter((c) => c.method === 'DELETE').length, 1);
    assert.equal(h.closeCount(), 1);
});
test('unexpected browser version never becomes a UI pass', async () => {
    const h = harness({ badVersion: true });
    await assert.rejects(
        runWebBaseline(selection, h.ports),
        (e) => e.stage === 'sandboxed-browser-startup',
    );
    assert.equal(h.calls.filter((c) => c.method === 'DELETE').length, 1);
    assert.ok(!h.calls.some((c) => c.target.endsWith('/value')));
});
test('a denied sandboxed session remains nonpassing with no fallback or second launch', async () => {
    // A protocol denial is injected; no sandbox or browser process is exercised.
    const h = harness({ fail: '/session' });
    await assert.rejects(
        runWebBaseline(selection, h.ports),
        (e) => e.stage === 'sandboxed-browser-startup' && !e.owner.snapshot().closed,
    );
    const creates = h.calls.filter((c) => c.target === '/session');
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].body.capabilities.alwaysMatch['goog:chromeOptions'].args, [
        '--headless=new',
        '--user-data-dir=/private/state/profile',
        '--no-first-run',
        '--no-default-browser-check',
    ]);
    assert.equal(h.events.filter((e) => e === 'driver-start').length, 1);
    assert.ok(!h.calls.some((c) => c.target.endsWith('/value')));
    assert.ok(!h.calls.some((c) => c.method === 'DELETE' || c.target === '/shutdown'));
    assert.equal(h.closeCount(), 0);
});
test('missing original session identity retains uncertain browser/service custody', async () => {
    const h = harness({ badSession: true });
    await assert.rejects(
        runWebBaseline(selection, h.ports),
        (e) => e.owner.snapshot().sessionUnknown && !e.owner.snapshot().closed,
    );
    assert.ok(!h.calls.some((c) => c.method === 'DELETE' || c.target === '/shutdown'));
    assert.equal(h.closeCount(), 0);
});
for (const target of ['/session/owned-session', '/shutdown']) {
    test('uncertain close request is never submitted twice: ' + target, async () => {
        const h = harness({ fail: target });
        await assert.rejects(runWebBaseline(selection, h.ports), WebBaselineFailure);
        assert.equal(h.calls.filter((c) => c.target === target).length, 1);
        assert.equal(h.closeCount(), 0);
    });
}
test('host close failure is retained and never retried', async () => {
    const h = harness({ hostCloseFails: true });
    await assert.rejects(runWebBaseline(selection, h.ports), (e) => !e.owner.snapshot().closed);
    assert.equal(h.closeCount(), 1);
    assert.equal(h.calls.filter((c) => c.target === '/shutdown').length, 1);
});
test('delayed direct service close must arrive before host close or pass', async () => {
    const h = harness({ delayClose: true });
    let done = false;
    const operation = runWebBaseline(selection, h.ports).then((r) => {
        done = true;
        return r;
    });
    for (let i = 0; i < 200 && !h.events.includes('service-shutdown'); i++) await Promise.resolve();
    assert.ok(h.events.includes('service-shutdown'));
    assert.equal(done, false);
    assert.equal(h.closeCount(), 0);
    h.closeDriver();
    assert.equal((await operation).result, 'passed');
});
test('deadline retains late driver startup without another action', async () => {
    let resume;
    const ready = new Promise((resolve) => {
        resume = resolve;
    });
    const h = harness({ ready });
    const operation = runWebBaseline(selection, h.ports);
    for (let i = 0; i < 50 && !h.events.includes('driver-start'); i++) await Promise.resolve();
    assert.ok(h.events.includes('driver-start'));
    for (const fn of [...h.timers.values()]) fn();
    await assert.rejects(
        operation,
        (e) => e.owner.snapshot().timedOut && !e.owner.snapshot().closed,
    );
    resume({ port: 3001 });
    await Promise.resolve();
    assert.equal(h.calls.length, 0);
    assert.equal(h.closeCount(), 0);
});
test('fixture path outside the owned private state is refused before effects', async () => {
    const h = harness();
    await assert.rejects(
        runWebBaseline({ ...selection, fixtureFile: '/other/report.json' }, h.ports),
    );
    assert.deepEqual(h.events, []);
});
test('queued work rechecks the deadline before its first actual dispatch', async () => {
    let reads = 0;
    const h = harness({ elapsed: () => (++reads < 3 ? 0 : WEB_BASELINE_BOUNDS.workMs + 1) });
    await assert.rejects(runWebBaseline(selection, h.ports), (e) => e.owner.snapshot().timedOut);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.calls, []);
});

function fakeChild() {
    const child = new EventEmitter();
    child.pid = 123;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
}
test('driver owner requires actual direct events and both pipe closures', async () => {
    const child = fakeChild();
    const owner = startWebDriver('/private/state', { launch: () => child });
    child.emit('spawn');
    child.stdout.emit('data', Buffer.from('ChromeDriver was started successfully on port 3001.\n'));
    assert.deepEqual(await owner.ready, { port: 3001 });
    let settled = false;
    owner.closed.then(() => {
        settled = true;
    });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await Promise.resolve();
    assert.equal(settled, false);
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.stdout.emit('close');
    child.stderr.emit('close');
    assert.equal((await owner.closed).normalExit, true);
});
test('stream bound failure keeps custody and prevents requests', async () => {
    const child = fakeChild();
    const owner = startWebDriver('/private/state', { launch: () => child });
    child.emit('spawn');
    child.stderr.emit('data', Buffer.alloc(WEB_BASELINE_BOUNDS.driverStreamBytes + 1));
    await assert.rejects(owner.ready, WebBaselineFailure);
    assert.equal(owner.snapshot().uncertain, true);
    await assert.rejects(owner.request('GET', '/status'));
});
test('HTTP adapter is loopback-only, bounded and joins request/response closure', async () => {
    const req = new EventEmitter(),
        res = new EventEmitter();
    res.statusCode = 200;
    req.end = (body) => {
        assert.equal(body.length, 0);
        queueMicrotask(() => {
            req.emit('response', res);
            res.emit('data', Buffer.from('{"value":{"ready":true}}'));
            res.emit('end');
            res.emit('close');
            req.emit('close');
        });
    };
    const result = await requestLocalDriver(3001, 'GET', '/status', undefined, (options) => {
        assert.equal(options.hostname, '127.0.0.1');
        assert.equal(options.agent, false);
        assert.equal(options.path, '/status');
        return req;
    });
    assert.deepEqual(result, { ready: true });
    assert.throws(() => requestLocalDriver(3001, 'GET', '/unreviewed'));
});
test('failed request-stop dispatch is consumed once and cannot manufacture closure', async () => {
    const req = new EventEmitter();
    let timer,
        stops = 0;
    req.end = () => {};
    req.destroy = () => {
        stops++;
        throw Error('benign fixture stop rejection');
    };
    const operation = requestLocalDriver(3001, 'GET', '/status', undefined, () => req, {
        setTimer(fn) {
            timer = fn;
            return 1;
        },
        clearTimer() {},
    });
    timer();
    timer();
    await assert.rejects(operation, /not acknowledged/);
    assert.equal(stops, 1);
});
