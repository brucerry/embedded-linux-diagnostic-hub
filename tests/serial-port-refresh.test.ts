import assert from 'node:assert/strict';
import test from 'node:test';
import { createSerialPortRefresh } from '../src/features/serial/port-refresh.ts';

interface Port {
    id: string;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function harness() {
    const requests: ReturnType<typeof deferred<Port[]>>[] = [];
    const published: Port[][] = [];
    const owner = createSerialPortRefresh(
        () => {
            const request = deferred<Port[]>();
            requests.push(request);
            return request.promise;
        },
        (ports) => published.push(ports),
    );
    return { owner, requests, published };
}

test('one refresh preserves array/port identity and performs no transport actions', async () => {
    let transportCalls = 0;
    const port = {
        id: 'authorized',
        open: () => transportCalls++,
        close: () => transportCalls++,
        forget: () => transportCalls++,
        getInfo: () => transportCalls++,
    };
    const ports = [port];
    const h = harness();
    const completed = h.owner.refresh();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.published, []);
    h.requests[0].resolve(ports);
    await completed;
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0], ports);
    assert.equal(h.published[0][0], port);
    assert.equal(transportCalls, 0);
});

test('older completion cannot overwrite a newer accepted list, including an empty list', async () => {
    const h = harness();
    const old = h.owner.refresh();
    const current = h.owner.refresh();
    h.requests[1].resolve([]);
    await current;
    h.requests[0].resolve([{ id: 'unplugged' }]);
    await old;
    assert.deepEqual(h.published, [[]]);
});

test('older completion is ignored while the latest request is still pending', async () => {
    const h = harness();
    const old = h.owner.refresh();
    const current = h.owner.refresh();
    h.requests[0].resolve([{ id: 'outdated' }]);
    await old;
    assert.deepEqual(h.published, []);
    h.requests[1].resolve([{ id: 'current' }]);
    await current;
    assert.deepEqual(h.published, [[{ id: 'current' }]]);
});

test('latest rejection keeps the accepted list and does not admit an older success', async () => {
    const h = harness();
    const accepted = h.owner.refresh();
    h.requests[0].resolve([{ id: 'accepted' }]);
    await accepted;
    const old = h.owner.refresh();
    const current = h.owner.refresh();
    h.requests[2].reject(Error('discovery failed'));
    await current;
    h.requests[1].resolve([{ id: 'outdated' }]);
    await old;
    assert.deepEqual(h.published, [[{ id: 'accepted' }]]);
});

test('superseded rejection is consumed without preventing the current success', async () => {
    const h = harness();
    const old = h.owner.refresh();
    const current = h.owner.refresh();
    h.requests[0].reject(Error('superseded failure'));
    await old;
    h.requests[1].resolve([{ id: 'current' }]);
    await current;
    assert.deepEqual(h.published, [[{ id: 'current' }]]);
});

test('a fresh refresh can recover after an asynchronous discovery failure', async () => {
    const h = harness();
    const failed = h.owner.refresh();
    h.requests[0].reject(Error('unavailable'));
    await failed;
    assert.deepEqual(h.published, []);
    const recovered = h.owner.refresh();
    h.requests[1].resolve([{ id: 'recovered' }]);
    await recovered;
    assert.deepEqual(h.published, [[{ id: 'recovered' }]]);
});

test('a synchronous loader exception is consumed and a later refresh remains usable', async () => {
    let calls = 0;
    const published: Port[][] = [];
    const owner = createSerialPortRefresh<Port>(
        () => {
            if (++calls === 1) throw Error('synchronous failure');
            return Promise.resolve([{ id: 'recovered' }]);
        },
        (ports) => published.push(ports),
    );
    await owner.refresh();
    assert.deepEqual(published, []);
    await owner.refresh();
    assert.equal(calls, 2);
    assert.deepEqual(published, [[{ id: 'recovered' }]]);
});

test('disposing an owner invalidates every pending reply', async () => {
    const h = harness();
    const old = h.owner.refresh();
    const current = h.owner.refresh();
    h.owner.dispose();
    h.requests[1].resolve([{ id: 'late-current' }]);
    h.requests[0].resolve([{ id: 'late-old' }]);
    await Promise.all([old, current]);
    assert.deepEqual(h.published, []);
});

test('dispose is idempotent and retained callbacks cannot initiate later reads', async () => {
    const h = harness();
    const callback = h.owner.refresh;
    h.owner.dispose();
    h.owner.dispose();
    await callback();
    await h.owner.refresh();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.published, []);
});

test('replacement effect lifetime cannot be overwritten by an earlier lifetime', async () => {
    const oldRequest = deferred<Port[]>();
    const newRequest = deferred<Port[]>();
    const published: Port[][] = [];
    const oldOwner = createSerialPortRefresh(
        () => oldRequest.promise,
        (ports) => published.push(ports),
    );
    const old = oldOwner.refresh();
    oldOwner.dispose();
    const newOwner = createSerialPortRefresh(
        () => newRequest.promise,
        (ports) => published.push(ports),
    );
    const current = newOwner.refresh();
    newRequest.resolve([{ id: 'new-lifetime' }]);
    await current;
    oldRequest.resolve([{ id: 'old-lifetime' }]);
    await old;
    assert.deepEqual(published, [[{ id: 'new-lifetime' }]]);
});

test('a pending rejection after dispose is consumed and cannot publish', async () => {
    const h = harness();
    const completed = h.owner.refresh();
    h.owner.dispose();
    h.requests[0].reject(Error('late discovery failure'));
    await completed;
    assert.deepEqual(h.published, []);
});

test('three overlapping refresh triggers publish only the newest request', async () => {
    const h = harness();
    const mount = h.owner.refresh();
    const hotplug = h.owner.refresh();
    const chooser = h.owner.refresh();
    h.requests[1].resolve([{ id: 'hotplug' }]);
    await hotplug;
    h.requests[2].resolve([{ id: 'chooser' }]);
    await chooser;
    h.requests[0].resolve([{ id: 'mount' }]);
    await mount;
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.published, [[{ id: 'chooser' }]]);
});
