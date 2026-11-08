import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DeviceClockResponse } from '../shared/diagnostics/device-clock';
import type { DeviceClockState } from '../src/hooks/useDeviceClock';
import {
    bindHeader,
    bindClockState,
    clockSpans,
    clockStateSpan,
} from './fixtures/header-clock-callbacks';

const source = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
for (const span of [clockSpans[0], clockSpans[2], clockStateSpan]) assert.ok(source.includes(span));
const fixture = readFileSync('tests/fixtures/header-clock-callbacks.ts', 'utf8');
const headerBinding = fixture
    .split('export function bindHeader')[1]
    .split('export function bindRestore')[0];
for (const span of [clockSpans[0], clockSpans[2]]) assert.ok(headerBinding.includes(span.trim()));
assert.ok(fixture.split('export function bindClockState')[1].includes(clockStateSpan));
const display = readFileSync('src/components/DeviceClock.tsx', 'utf8');
assert.ok(display.includes("status === 'stale'") && display.includes('Stale'));
assert.ok(display.includes('sample.time.slice(0, 5)'));

function gate<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function until(check: () => boolean) {
    for (let i = 0; i < 64; i++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded memory callbacks did not settle');
}
function response(time: string): DeviceClockResponse {
    return {
        status: 'available',
        sample: {
            date: '2028-02-29',
            time,
            epochSeconds: Date.parse(`2028-02-29T${time}Z`) / 1000,
            utcOffsetMinutes: 0,
            zone: 'UTC',
            bootId: null,
            uptimeSeconds: null,
        },
    };
}
type MemoryState = DeviceClockState & { generation?: number; reset?: number; transport?: unknown };
function memory() {
    const requests: { provider: object; reply: ReturnType<typeof gate<DeviceClockResponse>> }[] =
        [];
    const timers = new Map<number, () => void>();
    let ordinal = 0;
    let state: MemoryState = { status: 'disconnected', sample: null };
    const provider = () => {
        const value = {
            readDeviceClock() {
                assert.ok(requests.length < 12);
                const reply = gate<DeviceClockResponse>();
                requests.push({ provider: value, reply });
                return reply.promise;
            },
        };
        return value;
    };
    const context = {
        transport: provider() as { readDeviceClock?(): Promise<DeviceClockResponse> } | null,
        generation: 1 as number | undefined,
        reset: 0,
        blocked: false,
        visible: true,
        retained: { current: { sample: null } },
        freshness: { current: 0 },
        flight: { current: null as Promise<void> | null },
        queued: { current: null },
        refresh: { current: null as (() => void) | null },
        reservation: { current: null as symbol | null },
        observed: { current: { uptime: null } },
        document: { visibilityState: 'visible' },
        setState(next: MemoryState | ((current: MemoryState) => MemoryState)) {
            state = typeof next === 'function' ? next(state) : next;
        },
        setInterval(callback: () => void, delay: number) {
            assert.equal(delay, 60_000);
            assert.ok(timers.size < 2);
            const id = ++ordinal;
            timers.set(id, callback);
            return id;
        },
        clearInterval(id: number) {
            assert.ok(timers.delete(id));
        },
    };
    let owner = bindHeader(context);
    return {
        context,
        requests,
        provider,
        view: () => bindClockState({ ...context, state, quiesce: owner.quiesce }),
        quiesce: () => owner.quiesce(),
        minute: () => {
            assert.equal(timers.size, 1);
            for (const callback of timers.values()) callback();
        },
        rebind() {
            owner.cleanup?.();
            owner = bindHeader(context);
        },
        async settle(index: number, reply: DeviceClockResponse | Error) {
            const pending = context.flight.current;
            assert.ok(pending);
            assert.ok(requests[index]);
            if (reply instanceof Error) requests[index].reply.reject(reply);
            else requests[index].reply.resolve(reply);
            await pending;
            await Promise.resolve();
        },
        async close() {
            owner.cleanup?.();
            for (const request of requests)
                request.reply.resolve({ status: 'unavailable', reason: 'failed' });
            await until(() => context.flight.current === null);
            assert.equal(timers.size, 0);
            assert.equal(context.queued.current, null);
            assert.equal(context.refresh.current, null);
            assert.equal(context.reservation.current, null);
        },
    };
}

test('retained time stays stale through admission, release, failed refresh and successful fresh retry', async () => {
    const m = memory();
    try {
        await m.settle(0, response('12:00:59'));
        assert.equal(m.view().status, 'current');
        const release = await m.quiesce();
        assert.equal(m.view().status, 'stale');
        m.minute(); // Minute boundary is a deterministic callback, not a wall-clock wait.
        assert.equal(m.requests.length, 1);
        assert.equal(m.view().sample?.time, '12:00:59');
        release();
        assert.equal(m.requests.length, 2);
        assert.equal(m.view().status, 'stale');
        await m.settle(1, new Error('Synthetic clock failure'));
        assert.equal(m.view().status, 'stale');
        assert.equal(m.view().sample?.time, '12:00:59');
        m.minute();
        assert.equal(m.view().status, 'stale');
        await m.settle(2, response('12:02:00'));
        assert.equal(m.view().status, 'current');
        assert.equal(m.view().sample?.time, '12:02:00');
        m.minute();
        await m.settle(3, { status: 'unavailable', reason: 'failed' });
        assert.equal(m.view().status, 'stale');
        assert.equal(m.view().sample?.time, '12:02:00');
    } finally {
        await m.close();
    }
});

test('pre-admission reply drains without making the retained sample current', async () => {
    const m = memory();
    try {
        let admitted = false;
        const admission = m.quiesce().then((release) => {
            admitted = true;
            return release;
        });
        await Promise.resolve();
        assert.equal(admitted, false);
        assert.equal(m.view().status, 'loading');
        await m.settle(0, response('12:00:00'));
        const release = await admission;
        assert.equal(m.view().status, 'stale');
        assert.equal(m.view().sample?.time, '12:00:00');
        release();
        assert.equal(m.view().status, 'stale');
        await m.settle(1, response('12:01:00'));
        assert.equal(m.view().status, 'current');
    } finally {
        await m.close();
    }
});

test('reacquiring during resumed refresh invalidates that reply and stale release cannot free the new owner', async () => {
    const m = memory();
    try {
        await m.settle(0, response('12:00:00'));
        const oldRelease = await m.quiesce();
        oldRelease();
        assert.equal(m.view().status, 'stale');
        const admission = m.quiesce();
        const token = m.context.reservation.current;
        await assert.rejects(m.quiesce(), /current clock reader admission/);
        oldRelease();
        assert.equal(m.context.reservation.current, token);
        assert.equal(m.requests.length, 2);
        await m.settle(1, response('12:01:00'));
        const release = await admission;
        assert.equal(m.view().status, 'stale');
        assert.equal(m.view().sample?.time, '12:01:00');
        oldRelease();
        assert.equal(m.context.reservation.current, token);
        release();
        assert.equal(m.view().status, 'stale');
        await m.settle(2, response('12:02:00'));
        assert.equal(m.view().status, 'current');
    } finally {
        await m.close();
    }
});

test('provider identity, generation and reset prevent old-context samples or replies from appearing current', async () => {
    const m = memory();
    try {
        await m.settle(0, response('12:00:00'));
        m.minute();
        const replacement = m.provider();
        m.context.transport = replacement;
        assert.equal(m.view().status, 'loading');
        assert.equal(m.view().sample, null);
        m.rebind();
        assert.equal(m.requests.length, 2); // New context joins the old read without sharing its result.
        await m.settle(1, response('11:00:00'));
        assert.equal(m.requests.length, 3);
        assert.equal(m.requests[2].provider, replacement);
        assert.equal(m.view().status, 'loading');
        assert.equal(m.view().sample, null);
        await m.settle(2, response('13:00:00'));
        assert.equal(m.view().status, 'current');
        assert.equal(m.view().sample?.time, '13:00:00');
        m.context.generation = 2;
        assert.equal(m.view().sample, null);
        m.rebind();
        await m.settle(3, response('14:00:00'));
        assert.equal(m.view().status, 'current');
        m.context.reset++;
        assert.equal(m.view().sample, null);
        m.rebind();
        await m.settle(4, response('15:00:00'));
        assert.equal(m.view().sample?.time, '15:00:00');
        m.context.transport = null;
        assert.equal(m.view().status, 'disconnected');
        m.rebind();
        assert.equal(m.view().sample, null);
    } finally {
        await m.close();
    }
});

test('no sample remains loading while held or reading, unavailable on failure, and current only after valid success', async () => {
    const m = memory();
    try {
        assert.equal(m.view().status, 'loading');
        await m.settle(0, { status: 'unavailable', reason: 'failed' });
        assert.equal(m.view().status, 'unavailable');
        assert.equal(m.view().sample, null);
        const release = await m.quiesce();
        assert.equal(m.view().status, 'loading');
        release();
        assert.equal(m.view().status, 'loading');
        await m.settle(1, {
            status: 'available',
            sample: { date: 'invalid' },
        } as DeviceClockResponse);
        assert.equal(m.view().status, 'unavailable');
        assert.equal(m.view().sample, null);
        m.minute();
        await m.settle(2, response('12:01:00'));
        assert.equal(m.view().status, 'current');
        m.context.transport = {};
        m.rebind();
        assert.equal(m.view().status, 'unavailable');
        assert.equal(m.view().sample, null);
        const reads = m.requests.length;
        const unsupportedRelease = await m.quiesce();
        assert.equal(m.view().status, 'loading');
        unsupportedRelease();
        assert.equal(m.requests.length, reads);
        assert.equal(m.view().status, 'unavailable');
    } finally {
        await m.close();
    }
});

test('same-provider reconnect and reset discard pending old-context replies before their own fresh read', async () => {
    const m = memory();
    try {
        const provider = m.context.transport;
        await m.settle(0, response('12:00:00'));
        m.minute(); // Generation1 read remains physically owned while the UI moves to generation2.
        m.context.generation = 2;
        assert.equal(m.view().status, 'loading');
        assert.equal(m.view().sample, null);
        m.rebind();
        assert.equal(m.requests.length, 2);
        await m.settle(1, response('11:00:00'));
        assert.equal(m.requests.length, 3);
        assert.equal(m.requests[2].provider, provider);
        assert.equal(m.view().status, 'loading');
        assert.equal(m.view().sample, null);
        await m.settle(2, response('13:00:00'));
        assert.equal(m.view().status, 'current');
        assert.equal(m.view().sample?.time, '13:00:00');

        m.minute(); // Reset while the next read is pending must not reuse its sample or failure.
        m.context.reset++;
        assert.equal(m.view().status, 'loading');
        assert.equal(m.view().sample, null);
        m.rebind();
        assert.equal(m.requests.length, 4);
        await m.settle(3, new Error('Synthetic old-reset read failure'));
        assert.equal(m.requests.length, 5);
        assert.equal(m.requests[4].provider, provider);
        assert.equal(m.view().status, 'loading');
        assert.equal(m.view().sample, null);
        await m.settle(4, response('14:00:00'));
        assert.equal(m.view().status, 'current');
        assert.equal(m.view().sample?.time, '14:00:00');
    } finally {
        await m.close();
    }
});
