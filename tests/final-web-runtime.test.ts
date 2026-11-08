import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readbackFixture } from './fixtures/archive-readback-memory';
import {
    createFinalWebHost,
    observeFinalWebStartup,
    FinalWebObservationFailure,
} from '../scripts/lib/final-web-runtime.mjs';
import { openWebArchiveBytes } from '../scripts/lib/inner-archive-inspection.mjs';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tick = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
};
const deferred = () => {
    let resolve!: (v?: any) => void, reject!: (v: any) => void;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
async function fixture() {
    const f = await readbackFixture('web'),
        bytes = f.files.get('web-build.json')!,
        record = JSON.parse(bytes.toString()),
        archive = f.files.get(record.archive.name)!;
    const server: any = new EventEmitter();
    let handler: any, closeCallback: any, listenCallback: any;
    const controls: any = {
        heldListen: false,
        heldClose: false,
        closeError: null,
        address: { address: '127.0.0.1', port: 43123 },
    };
    server.listen = (port: number, address: string, callback: any) => {
        assert.equal(port, 0);
        assert.equal(address, '127.0.0.1');
        listenCallback = callback;
        if (!controls.heldListen) callback();
    };
    server.address = () => controls.address;
    server.close = (callback: any) => {
        closeCallback = callback;
        if (!controls.heldClose) callback(controls.closeError);
    };
    const context = f.selection.context;
    const host = createFinalWebHost(
        archive,
        bytes,
        context,
        {},
        {
            createServer(h: any) {
                handler = h;
                return server;
            },
        },
    );
    function request(url: string, method = 'GET') {
        const res: any = new EventEmitter();
        res.writeHead = (status: number, headers: any = {}) => {
            res.status = status;
            res.headers = headers;
            return res;
        };
        res.end = (b?: Buffer) => {
            res.body = Buffer.from(b ?? '');
            res.emit('finish');
            res.emit('close');
            return res;
        };
        res.destroy = () => res.emit('close');
        handler({ url, method }, res);
        return res;
    }
    return {
        ...f,
        context,
        host,
        server,
        controls,
        request,
        record,
        archive,
        bytes,
        handleRequest: (...args: any[]) => handler(...args),
        releaseListen: () => listenCallback(),
        releaseClose: () => closeCallback(controls.closeError),
    };
}
const observer = { runId: '111', runAttempt: '1', jobId: '222', toolingCommit: 'c'.repeat(40) };
function fakePage(f: any, engine = 'chromium') {
    const p: any = new EventEmitter();
    const controls: any = {
        status: 200,
        badResource: false,
        runtimeError: false,
        heldBody: null,
        offFailure: false,
        hidden: false,
    };
    let url = 'about:blank';
    const selectors: any[] = [];
    p.url = () => url;
    p.isClosed = () => false;
    p.context = () => ({
        browser: () => ({
            browserType: () => ({ name: () => engine }),
            version: () => 'synthetic-browser-version',
        }),
    });
    const off = p.off.bind(p);
    p.off = (name: string, fn: any) => {
        if (controls.offFailure) throw Error('synthetic detach failure');
        return off(name, fn);
    };
    p.getByRole = (role: string, options: any) => ({
        waitFor: async (state: any) => {
            selectors.push({ role, options, state });
            if (controls.hidden) throw Error('synthetic control unavailable');
        },
    });
    p.goto = async (target: string, options: any) => {
        assert.deepEqual(options, { waitUntil: 'networkidle', timeout: 30000 });
        url = target;
        const doc = f.request('/artifact/');
        const response = {
            url: () => target,
            status: () => controls.status,
            body: async () => Buffer.from(doc.body),
        };
        p.emit('response', response);
        const resource = f.request('/artifact/assets/main.js');
        p.emit('response', {
            url: () => target + 'assets/main.js',
            status: () => 200,
            body: async () => {
                if (controls.heldBody) await controls.heldBody;
                return controls.badResource ? Buffer.from('substituted') : resource.body;
            },
        });
        if (controls.runtimeError) p.emit('pageerror', Error('do not emit this raw error'));
        return response;
    };
    return {
        page: p,
        controls,
        selectors,
        setURL: (next: string) => {
            url = next;
        },
    };
}
test('checked member bytes are immutable snapshots, not extracted or executable code', async () => {
    const f = await fixture(),
        h = openWebArchiveBytes(f.archive, f.record),
        original = h.read('index.html');
    f.archive.fill(0);
    const copy = h.read('index.html');
    copy.fill(1);
    assert.deepEqual(h.read('index.html'), original);
    const facts = h.inspection();
    facts.payload[0].sha256 = 'bad';
    assert.notEqual(h.inspection().payload[0].sha256, 'bad');
    assert.throws(() => h.read('../index.html'));
});
test('archive host serves unchanged HTML/modules/worker bytes and HEAD without fallback routes', async () => {
    const f = await fixture();
    await f.host.listen();
    for (const row of f.record.payload) {
        const response = f.request('/artifact/' + row.path);
        assert.equal(response.status, 200);
        assert.equal(hash(response.body), row.sha256);
        assert.equal(response.headers['Content-Length'], row.bytes);
    }
    assert.equal(f.request('/artifact/index.html', 'HEAD').body.length, 0);
    assert.equal(f.request('/artifact/api/made-up').status, 404);
    assert.equal(f.request('/artifact/', 'POST').status, 405);
    await f.host.close();
    assert.equal(f.host.snapshot().phase, 'closed');
});
for (const url of [
    '/../index.html',
    '/artifact/../index.html',
    '/artifact/%2e%2e/index.html',
    '/artifact/%2Findex.html',
    '/artifact/%5cindex.html',
    '/artifact/%00index.html',
    '/artifact/%ZZ',
    '/artifact/index.html#fragment',
])
    test('host rejects unsafe URL ' + url, async () => {
        const f = await fixture();
        await f.host.listen();
        assert.equal(f.request(url).status, 400);
        await f.host.close();
    });
test('bad archive or different selected source cannot allocate an HTTP host', async () => {
    const f = await fixture();
    let allocations = 0;
    const ports = {
        createServer() {
            allocations++;
            throw Error('must not allocate');
        },
    };
    const bad = Buffer.from(f.archive);
    bad[0] ^= 1;
    assert.throws(() => createFinalWebHost(bad, f.bytes, f.context, {}, ports));
    assert.throws(() =>
        createFinalWebHost(
            f.archive,
            f.bytes,
            { ...f.context, sourceCommit: 'f'.repeat(40) },
            {},
            ports,
        ),
    );
    assert.equal(allocations, 0);
});
test('normal close joins admitted bind and each owned socket acknowledgement without destroy', async () => {
    const f = await fixture();
    f.controls.heldListen = true;
    const listen = f.host.listen();
    const socket: any = new EventEmitter();
    socket.destroy = () => assert.fail('forced socket destruction');
    f.server.emit('connection', socket);
    let closed = false;
    const closing = f.host.close().then(() => (closed = true));
    await tick();
    assert.equal(closed, false);
    f.releaseListen();
    await listen;
    await tick();
    assert.equal(closed, false);
    socket.emit('close');
    await closing;
    assert.equal(f.host.snapshot().phase, 'closed');
});
test('rejected host close is retained without automatic retry or a fabricated closed state', async () => {
    const f = await fixture();
    await f.host.listen();
    f.controls.closeError = Error('synthetic close');
    const close = f.host.close();
    await assert.rejects(close, /synthetic close/);
    assert.equal(f.host.snapshot().phase, 'failed');
    assert.equal(f.host.close(), close);
});
for (const engine of ['chromium', 'firefox', 'webkit'])
    test(
        'public startup adapter emits exact artifact observations for reported ' +
            engine +
            ' without private hooks',
        async () => {
            const f = await fixture();
            await f.host.listen();
            const p = fakePage(f, engine);
            const out = await observeFinalWebStartup(f.host, p.page, observer);
            assert.equal(out.sha256, hash(out.bytes));
            assert.deepEqual(JSON.parse(out.bytes.toString()), out.record);
            assert.equal(out.record.archive.sha256, f.record.archive.sha256);
            assert.equal(out.record.selectedSource.commit, f.context.sourceCommit);
            assert.equal(out.record.observer.engineReported, engine);
            assert.equal(out.record.observations.resources.length, 2);
            assert.deepEqual(out.record.observations.adapterInstalledHooks, []);
            for (const key of [
                'executableIdentity',
                'gatewayRuntime',
                'productOwnership',
                'processRetirement',
                'reviewedPolicy',
                'normalGC',
                'forcedGC',
            ] as const)
                assert.equal(out.record[key], null);
            assert.equal(out.record.releaseAcceptance, false);
            assert.deepEqual(
                p.selectors.map((r: any) => r.options.name),
                ['Connect target device', 'Device time'],
            );
            assert.equal(p.page.listenerCount('response'), 0);
            await f.host.close();
        },
    );
for (const mode of ['badResource', 'runtimeError', 'hidden', 'offFailure'])
    test('startup fails honestly and retains inspection custody on ' + mode, async () => {
        const f = await fixture();
        await f.host.listen();
        const p = fakePage(f);
        p.controls[mode] = true;
        await assert.rejects(observeFinalWebStartup(f.host, p.page, observer), (error: any) => {
            assert.ok(error instanceof FinalWebObservationFailure);
            assert.equal(error.custody.snapshot().browserProcessRetirement, 'not-observed');
            if (mode === 'offFailure')
                assert.equal(error.custody.snapshot().callbacksDetached, false);
            return true;
        });
        await f.host.close();
    });
test('held resource-body acknowledgement prevents observation completion', async () => {
    const f = await fixture();
    await f.host.listen();
    const p = fakePage(f),
        d = deferred();
    p.controls.heldBody = d.promise;
    let complete = false;
    const operation = observeFinalWebStartup(f.host, p.page, observer).then((v) => {
        complete = true;
        return v;
    });
    await tick();
    assert.equal(complete, false);
    d.resolve();
    await operation;
    await f.host.close();
});
test('unissued host, replacement page reuse and unsupported reported engine fail before navigation', async () => {
    const f = await fixture();
    await f.host.listen();
    const p = fakePage(f);
    await assert.rejects(observeFinalWebStartup({}, p.page, observer), /Unissued/);
    const unsupported = fakePage(f, 'unknown');
    await assert.rejects(observeFinalWebStartup(f.host, unsupported.page, observer));
    await observeFinalWebStartup(f.host, p.page, observer);
    await assert.rejects(
        observeFinalWebStartup(f.host, p.page, observer),
        /already admitted|fresh owned page/,
    );
    await f.host.close();
});

test('navigation reuses the already owned response body instead of an unreserved second read', async () => {
    const f = await fixture();
    await f.host.listen();
    const p = fakePage(f);
    let reads = 0;
    p.page.goto = async (target: string) => {
        p.setURL(target);
        const r = {
            url: () => target,
            status: () => 200,
            body: async () => {
                reads++;
                return f.request('/artifact/').body;
            },
        };
        p.page.emit('response', r);
        return r;
    };
    const out = await observeFinalWebStartup(f.host, p.page, observer);
    assert.equal(reads, 1);
    assert.equal(out.record.observations.responseObjectsRead, 1);
    await f.host.close();
});
test('a response emitted while host is closing remains owned until close acknowledgement', async () => {
    const f = await fixture();
    await f.host.listen();
    f.controls.heldClose = true;
    let closed = false;
    const closing = f.host.close().then(() => (closed = true));
    await tick();
    const res: any = new EventEmitter();
    res.writeHead = () => res;
    res.end = () => res;
    res.destroy = () => {};
    f.handleRequest({ url: '/artifact/', method: 'GET' }, res);
    f.releaseClose();
    await tick();
    assert.equal(closed, false);
    assert.equal(f.host.snapshot().responses, 1);
    res.emit('close');
    await closing;
    assert.equal(closed, true);
});

test('concurrent body reads reserve declared bytes before an over-budget read can begin', async () => {
    const f = await fixture();
    await f.host.listen();
    const p = fakePage(f),
        gate = deferred();
    let reads = 0;
    const index = f.record.payload.find((r: any) => r.path === 'index.html'),
        main = f.record.payload.find((r: any) => r.path === 'assets/main.js');
    p.page.goto = async (target: string) => {
        p.setURL(target);
        const doc = {
            url: () => target,
            status: () => 200,
            body: async () => f.request('/artifact/').body,
        };
        p.page.emit('response', doc);
        for (let n = 0; n < 3; n++)
            p.page.emit('response', {
                url: () => target + 'assets/main.js',
                status: () => 200,
                body: async () => {
                    reads++;
                    await gate.promise;
                    return f.request('/artifact/assets/main.js').body;
                },
            });
        return doc;
    };
    const operation = observeFinalWebStartup(f.host, p.page, observer, {
        maxResponseBytes: index.bytes + 2 * main.bytes,
        maxResponses: 10,
    });
    await tick();
    assert.equal(reads, 2);
    gate.resolve();
    await assert.rejects(operation, FinalWebObservationFailure);
    await f.host.close();
});

test('prepared host closes its in-memory custody before any listener allocation', async () => {
    const f = await fixture();
    assert.equal((await f.host.close()).phase, 'closed');
    assert.throws(() => f.host.listen());
});
test('response error is held through actual response closure without an unhandled error event', async () => {
    const f = await fixture();
    await f.host.listen();
    f.controls.heldClose = true;
    const closing = f.host.close();
    await tick();
    const res: any = new EventEmitter();
    res.writeHead = () => res;
    res.end = () => res;
    res.destroy = () => {};
    f.handleRequest({ url: '/artifact/', method: 'GET' }, res);
    res.emit('error', Error('synthetic transport error'));
    assert.equal(f.host.snapshot().failure, true);
    f.releaseClose();
    let retired = false;
    closing.then(() => (retired = true));
    await tick();
    assert.equal(retired, false);
    res.emit('close');
    await closing;
});
test('host closure before final evidence produces a custody-bearing failure instead of a bare assertion', async () => {
    const f = await fixture();
    await f.host.listen();
    const p = fakePage(f);
    p.page.getByRole = () => ({ waitFor: async () => f.host.close() });
    await assert.rejects(observeFinalWebStartup(f.host, p.page, observer), (error: any) => {
        assert.ok(error instanceof FinalWebObservationFailure);
        assert.equal(error.custody.snapshot().responseReadsPending, 0);
        return true;
    });
});

for (const mode of ['requestfailed', 'crash', 'close', 'url-drift', 'silent-closed'])
    test('startup rejects ' + mode + ' even while an owned resource read is pending', async () => {
        const f = await fixture();
        await f.host.listen();
        const p = fakePage(f),
            hold = deferred();
        p.controls.heldBody = hold.promise;
        const operation = observeFinalWebStartup(f.host, p.page, observer);
        await tick();
        if (mode === 'url-drift') {
            p.setURL('https://untrusted.invalid/private?do-not-report=secret');
            p.page.emit('framenavigated', {});
            // A transient return cannot erase the observed drift.
            p.setURL('http://127.0.0.1:43123/artifact/');
        } else if (mode === 'silent-closed') p.page.isClosed = () => true;
        else p.page.emit(mode, { arbitrary: 'must not appear in evidence' });
        let settled = false;
        operation.catch(() => {
            settled = true;
        });
        await tick();
        assert.equal(settled, false, 'Pending body remains owned after failure.');
        hold.resolve();
        await assert.rejects(operation, (error: any) => {
            assert.ok(error instanceof FinalWebObservationFailure);
            assert.equal(error.custody.snapshot().callbacksDetached, true);
            assert.equal(error.custody.snapshot().responseReadsPending, 0);
            return true;
        });
        for (const event of [
            'pageerror',
            'response',
            'requestfailed',
            'crash',
            'close',
            'framenavigated',
        ])
            assert.equal(p.page.listenerCount(event), 0);
        await f.host.close();
    });
test('silent final URL drift and a state change during listener removal cannot pass', async () => {
    for (const duringDetach of [false, true]) {
        const f = await fixture();
        await f.host.listen();
        const p = fakePage(f);
        if (duringDetach) {
            const off = p.page.off.bind(p.page);
            p.page.off = (event: string, callback: any) => {
                p.setURL('about:blank');
                return off(event, callback);
            };
        } else
            p.page.getByRole = () => ({
                waitFor: async () => {
                    p.setURL('about:blank');
                },
            });
        await assert.rejects(
            observeFinalWebStartup(f.host, p.page, observer),
            FinalWebObservationFailure,
        );
        await f.host.close();
    }
});
