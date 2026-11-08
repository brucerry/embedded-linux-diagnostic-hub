import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Client } from 'ssh2';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import { NativeCaptureStore } from '../electron/capture-store';
import { captureToRepository } from '../shared/automation-capture';
import { CAPTURE_STORAGE, type CaptureRepository } from '../shared/capture-store';
import { captureStreamingCommand } from '../backend/ssh/automation-stream';
import { SshStreamHost } from '../backend/ssh/stream-host';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import { sshCaptureBackend } from '../src/features/automation/capture/ssh-backend';
import { SshStreamClient } from '../src/features/automation/capture/ssh-stream-client';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}
async function until(check: () => boolean) {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
        if (check()) return;
        await new Promise<void>((r) => setTimeout(r, 5));
    }
    assert.fail('Expected fixture boundary was not reached.');
}
async function repository(t: TestContext) {
    const temp = path.resolve(os.tmpdir());
    const profile = await fs.mkdtemp(path.join(temp, 'hub-ssh-review-'));
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    t.after(async () => {
        await store.close();
        assert.ok(profile.startsWith(temp + path.sep));
        assert.ok(path.basename(profile).startsWith('hub-ssh-review-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    return store;
}
const plan: AutomationPlan = {
    transport: 'ssh',
    steps: [{ id: 'one', name: 'One', enabled: true, command: 'fixture', delaySeconds: 0 }],
    timeoutSeconds: 10,
    repeatSeconds: null,
    start: null,
    serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
};
const header = {
    transport: 'ssh' as const,
    receiveTimeSource: 'local-client' as const,
    runId: 'review-run',
    stepId: 'one',
    name: 'Fixture',
    command: 'fixture',
    startedAt: '2026-10-15T12:00:00.000Z',
};
const result = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    completion: 'exit',
    truncated: false,
    chunks: [],
    previewClipped: false,
};

for (const boundary of [
    'capability-first',
    'clock-success',
    'clock-failure',
    'storage',
    'capability-final',
]) {
    for (const timerFirst of [false, true]) {
        test(
            `freshness: ${boundary}, watchdog ${timerFirst ? 'before' : 'after'} resumed continuation`,
            { timeout: 5000 },
            async (t) => {
                const store = await repository(t),
                    gate = deferred();
                let entered = false,
                    starts = 0,
                    caps = 0,
                    local = Date.parse(header.startedAt),
                    mono = 0;
                let watch: (() => void) | undefined,
                    watchRemoved = 0;
                const states: FlowState[] = [],
                    rows: AutomationRecord[] = [];
                const held = async () => {
                    entered = true;
                    await gate.promise;
                };
                const wrapped = new Proxy(store, {
                    get(target, key) {
                        if (key === 'begin')
                            return async (...args: Parameters<CaptureRepository['begin']>) => {
                                if (boundary === 'storage') await held();
                                return target.begin(...args);
                            };
                        const value = Reflect.get(target, key);
                        return typeof value === 'function' ? value.bind(target) : value;
                    },
                }) as CaptureRepository;
                const backend = sshCaptureBackend(
                    {
                        automationConnection: () => 'review-connection-01',
                        async automationStream(r) {
                            if (r.action === 'capabilities') {
                                caps++;
                                if (
                                    (boundary === 'capability-first' && caps === 1) ||
                                    (boundary === 'capability-final' && caps === 2)
                                )
                                    await held();
                                return {
                                    protocol: 1,
                                    independentStream: 1,
                                    receiveTimeSource: 'local-client',
                                    frameBytes: CAPTURE_STORAGE.frameBytes,
                                    backlogBytes: CAPTURE_STORAGE.backlogBytes,
                                    epoch: 'a'.repeat(32),
                                };
                            }
                            if (r.action === 'start') {
                                starts++;
                                return { protocol: 1, capability: 'b'.repeat(64) };
                            }
                            if (r.action === 'read')
                                return { protocol: 1, type: 'end', id: r.id, capture: result };
                            return { ok: true };
                        },
                    },
                    wrapped,
                    'local-client',
                    { endpoint: 'synthetic' },
                    () => true,
                    async () => {
                        await held();
                        if (boundary === 'clock-failure')
                            throw Error('Optional sample unavailable.');
                        return {
                            deviceEpochMs: local,
                            sampledLocalMs: local,
                            sampledMonoMs: mono,
                            uncertaintyMs: 0,
                            zone: 'UTC',
                            source: 'fixture',
                            connection: 'review-connection-01',
                        };
                    },
                );
                const runner = new FlowRunner(
                    (s) => states.push(s),
                    (r) => rows.push(r),
                    {
                        local: () => local,
                        mono: () => mono,
                        sleep: async () => {},
                        watch: (fn) => {
                            watch = fn;
                            return () => {
                                watchRemoved++;
                            };
                        },
                    },
                );
                const pending = runner.start(
                    { ...plan, captureDeviceTime: boundary.startsWith('clock') },
                    backend,
                );
                await until(() => entered);
                local += 10000;
                mono += 10000;
                if (timerFirst) watch!();
                gate.resolve();
                await pending;
                if (!timerFirst) watch!();
                assert.equal(starts, 0, 'No start after stale asynchronous preparation.');
                assert.equal(states.at(-1)?.state, 'paused');
                assert.match(states.at(-1)!.message, /slept|stalled|clock changed/);
                assert.equal(watchRemoved, 1);
                assert.equal(runner.busy, false);
                assert.equal(rows.length, 1);
            },
        );
    }
}

test(
    'freshness: a healthy long storage await keeps ticking and starts exactly once',
    { timeout: 5000 },
    async (t) => {
        const store = await repository(t),
            gate = deferred();
        let entered = false,
            starts = 0,
            local = Date.parse(header.startedAt),
            mono = 0;
        let watch: (() => void) | undefined;
        const wrapped = new Proxy(store, {
            get(target, key) {
                if (key === 'begin')
                    return async (...args: Parameters<CaptureRepository['begin']>) => {
                        entered = true;
                        await gate.promise;
                        return target.begin(...args);
                    };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }) as CaptureRepository;
        const states: FlowState[] = [];
        const backend = sshCaptureBackend(
            {
                automationConnection: () => 'healthy-connection-01',
                async automationStream(r) {
                    if (r.action === 'capabilities')
                        return {
                            protocol: 1,
                            independentStream: 1,
                            receiveTimeSource: 'local-client',
                            frameBytes: CAPTURE_STORAGE.frameBytes,
                            backlogBytes: CAPTURE_STORAGE.backlogBytes,
                            epoch: 'a'.repeat(32),
                        };
                    if (r.action === 'start') {
                        starts++;
                        return { protocol: 1, capability: 'b'.repeat(64) };
                    }
                    if (r.action === 'read')
                        return { protocol: 1, type: 'end', id: r.id, capture: result };
                    return { ok: true };
                },
            },
            wrapped,
            'local-client',
            { endpoint: 'synthetic' },
            () => true,
        );
        const runner = new FlowRunner(
            (s) => states.push(s),
            () => {},
            {
                local: () => local,
                mono: () => mono,
                sleep: async () => {},
                watch: (fn) => {
                    watch = fn;
                    return () => {};
                },
            },
        );
        const pending = runner.start(plan, backend);
        await until(() => entered);
        for (let i = 0; i < 50; i++) {
            local += 200;
            mono += 200;
            watch!();
        }
        gate.resolve();
        await pending;
        assert.equal(starts, 1);
        assert.equal(states.at(-1)?.state, 'finished');
    },
);

class Channel extends PassThrough {
    stderr = new PassThrough({ autoDestroy: false, emitClose: false });
    closeRequested = false;
    constructor() {
        super({ autoDestroy: false, emitClose: false });
    }
    close() {
        this.closeRequested = true;
        return this;
    }
}
async function cancelFixture(t: TestContext, mode: 'read-held' | 'flush-held' | 'read-fails') {
    const store = await repository(t),
        channel = new Channel(),
        connection = new EventEmitter();
    Object.assign(connection, {
        exec: (_: string, cb: (e: null, c: Channel) => void) => cb(null, channel),
    });
    const backendCancel = new AbortController(),
        cancel = new AbortController(),
        gate = deferred();
    let reading = false,
        flushing = false,
        completed = false,
        finalized = false;
    const host = new SshStreamHost(
        async (request, sink, complete, fence) => {
            complete(
                await captureStreamingCommand(
                    connection as unknown as Client,
                    request.command,
                    request.timeoutMs,
                    backendCancel.signal,
                    sink,
                ),
            );
            completed = true;
            await fence;
            finalized = true;
        },
        () => backendCancel.abort(),
    );
    const client = new SshStreamClient(async (r) => {
        if (r.action === 'read' && !reading) {
            reading = true;
            if (mode !== 'flush-held') await gate.promise;
            if (mode === 'read-fails') throw Error('Synthetic read delivery failed.');
        }
        return host.dispatch(r);
    }, 'local-client');
    const wrapped = new Proxy(store, {
        get(target, key) {
            if (key === 'append' && mode === 'flush-held')
                return async (...args: Parameters<CaptureRepository['append']>) => {
                    flushing = true;
                    await gate.promise;
                    return target.append(...args);
                };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as CaptureRepository;
    const pending = captureToRepository(wrapped, header, cancel.signal, (sink, signal) =>
        client.execute(
            {
                id: 'review-cancel-command-01',
                connection: 'review-cancel-connection-01',
                command: 'fixture',
                timeoutMs: 3000,
            },
            sink,
            signal,
        ),
    );
    t.after(() => {
        gate.resolve();
        host.clear();
        channel.emit('close');
        channel.destroy();
        channel.stderr.destroy();
    });
    await until(() => reading);
    return {
        store,
        channel,
        host,
        client,
        pending,
        cancel,
        gate,
        flushing: () => flushing,
        completed: () => completed,
        finalized: () => finalized,
    };
}

for (const stream of ['stdout', 'stderr'] as const) {
    test(
        `cancel: unsent 23-byte ${stream} observation becomes an explicit gap`,
        { timeout: 5000 },
        async (t) => {
            const f = await cancelFixture(t, 'read-held'),
                bytes = Buffer.alloc(23, 65);
            (stream === 'stdout' ? f.channel : f.channel.stderr).emit('data', bytes);
            await new Promise<void>((r) => setImmediate(r));
            f.cancel.abort();
            f.channel.emit('close');
            f.gate.resolve();
            const capture = await f.pending;
            assert.equal(capture.stored.state, 'incomplete');
            assert.equal(capture.stored.observedBytes, 23);
            assert.equal(capture.stored.committedBytes, 0);
            assert.equal(capture.stored.failure?.code, 'io');
            assert.equal(capture.completion, 'storage-error');
            assert.equal(f.completed(), true);
            assert.equal(f.finalized(), false);
            await f.client.finalize();
            assert.equal(f.finalized(), true);
            assert.equal(
                (await f.store.page()).records.find((r) => r.id === capture.stored.id)
                    ?.observedBytes,
                23,
            );
        },
    );
}

for (const first of ['stdout', 'stderr'] as const) {
    test(
        `cancel: unsent ${first} and queued other stream are both accounted`,
        { timeout: 5000 },
        async (t) => {
            const f = await cancelFixture(t, 'read-held');
            const streams =
                first === 'stdout' ? [f.channel, f.channel.stderr] : [f.channel.stderr, f.channel];
            streams[0].emit('data', Buffer.alloc(23, 65));
            streams[1].emit('data', Buffer.alloc(17, 66));
            await new Promise<void>((r) => setImmediate(r));
            f.cancel.abort();
            f.channel.emit('close');
            f.gate.resolve();
            const capture = await f.pending;
            assert.equal(capture.stored.state, 'incomplete');
            assert.equal(capture.stored.observedBytes, 40);
            assert.equal(capture.stored.committedBytes, 0);
            assert.equal(capture.stored.failure?.code, 'io');
            await f.client.finalize();
        },
    );
}

for (const queued of [false, true]) {
    test(
        `cancel: sent stdout persists through held flush${queued ? ' and queued stderr reports a gap' : ' without double counting'}`,
        { timeout: 5000 },
        async (t) => {
            const f = await cancelFixture(t, 'flush-held');
            f.channel.emit('data', Buffer.alloc(23, 65));
            if (queued) f.channel.stderr.emit('data', Buffer.alloc(17, 66));
            await until(f.flushing);
            f.cancel.abort();
            f.channel.emit('close');
            let finalized = false;
            const final = f.client.finalize().then(() => {
                finalized = true;
            });
            await new Promise<void>((r) => setImmediate(r));
            assert.equal(finalized, false, 'No ownership release before pending raw persistence.');
            f.gate.resolve();
            const capture = await f.pending;
            await final;
            assert.equal(capture.stored.committedBytes, 23);
            assert.equal(capture.stored.observedBytes, queued ? 40 : 23);
            assert.equal(capture.stored.state, queued ? 'incomplete' : 'complete');
            assert.equal(capture.stored.failure?.code, queued ? 'io' : undefined);
        },
    );
}

test(
    'delivery failure after start marks possible loss without inventing an observed count',
    { timeout: 5000 },
    async (t) => {
        const f = await cancelFixture(t, 'read-fails');
        f.channel.emit('data', Buffer.alloc(23, 65));
        await new Promise<void>((r) => setImmediate(r));
        f.gate.resolve();
        await until(() => f.channel.closeRequested);
        f.channel.emit('close');
        const capture = await f.pending;
        assert.equal(capture.stored.state, 'incomplete');
        assert.equal(capture.stored.failure?.code, 'io');
        assert.equal(
            capture.stored.observedBytes,
            0,
            'Transport failure prevents a verified count; zero is a lower bound.',
        );
        await f.client.finalize();
    },
);
