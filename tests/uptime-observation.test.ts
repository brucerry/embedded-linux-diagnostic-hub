import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { deviceRebooted, type DeviceClockResponse } from '../shared/diagnostics/device-clock';
import { parseUptimeSeconds } from '../shared/diagnostics/metrics';
import { bindHeader, clockSpans } from './fixtures/header-clock-callbacks';

const source = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
const start = source.indexOf('        const previous = observed.current;');
const end = source.indexOf('    }, [generation, uptime]);');
assert(start >= 0 && end > start);
const body = source.slice(start, end);
assert(body.includes('if (uptime !== null || previous.generation !== generation)'));
assert(body.endsWith('            observed.current = { generation, uptime };\n'));
const effect = new Function('observed', 'generation', 'uptime', 'deviceRebooted', 'refresh', body);
// Header admission/read callbacks are unchanged, and the verbatim fixture must
// match them before it can qualify this new uptime-trigger path.
const fixture = readFileSync('tests/fixtures/header-clock-callbacks.ts', 'utf8');
const headerBinding = fixture.split('export function bindHeader')[1].split('export function bindRestore')[0];
for (const span of [clockSpans[0], clockSpans[2]]) {
    assert(source.includes(span));
    assert(headerBinding.includes(span.trim()));
}

type Observed = { current: { generation?: number; uptime: number | null } };
function sequence() {
    const observed: Observed = { current: { uptime: null } };
    let calls = 0;
    return {
        observed, calls: () => calls,
        step(generation: number | undefined, uptime: number | null) {
            effect(observed, generation, uptime, deviceRebooted, { current: () => { calls++; } });
        },
    };
}

test('100 -> unknown -> 10 within one generation retains the valid baseline and refreshes once', () => {
    const s = sequence();
    s.step(7, parseUptimeSeconds('100.0 99'));
    for (const text of ['', ' \t\r\n', '1e3 0']) {
        s.step(7, parseUptimeSeconds(text));
        assert.equal(s.observed.current.uptime, 100);
        assert.equal(s.calls(), 0);
    }
    s.step(7, parseUptimeSeconds('10.0 2'));
    assert.equal(s.calls(), 1);
    assert.equal(s.observed.current.uptime, 10);
    s.step(7, null); s.step(7, 10); s.step(7, 11);
    assert.equal(s.calls(), 1, 'No repeated rollback from the retired old baseline');
});

test('unknown readings across generation or disconnect boundaries do not retain another connection baseline', () => {
    const s = sequence();
    s.step(7, 100); s.step(8, null);
    assert.deepEqual(s.observed.current, { generation: 8, uptime: null });
    s.step(8, 10);
    assert.equal(s.calls(), 0);
    s.step(undefined, null);
    assert.deepEqual(s.observed.current, { generation: undefined, uptime: null });
    s.step(7, 1);
    assert.equal(s.calls(), 0, 'Returning generation value has a new baseline after disconnect');
});

test('initial unknown and genuine zero remain distinct while later valid observations update the baseline', () => {
    const s = sequence();
    s.step(7, null); s.step(7, null); s.step(7, 0); s.step(7, null); s.step(7, 0);
    assert.equal(s.calls(), 0);
    assert.equal(s.observed.current.uptime, 0);
    s.step(7, 100); s.step(7, null); s.step(7, 1);
    assert.equal(s.calls(), 1);
    assert.equal(s.observed.current.uptime, 1);
});

function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
async function until(check: () => boolean) {
    for (let i = 0; i < 128; i++) { if (check()) return; await Promise.resolve(); }
    assert.fail('Bounded fake clock callbacks did not settle');
}
function response(uptimeSeconds: number): DeviceClockResponse {
    return { status: 'available', sample: {
        date: '2028-02-29', time: '12:00:00', epochSeconds: 1835438400,
        utcOffsetMinutes: 0, zone: 'UTC', bootId: null, uptimeSeconds,
    } };
}
function memory() {
    const observed: Observed = { current: { uptime: null } };
    const requests: ReturnType<typeof gate<DeviceClockResponse>>[] = [];
    const timers = new Map<number, () => void>();
    let ordinal = 0;
    let state: Record<string, unknown> = { status: 'disconnected', sample: null };
    const context = {
        generation: 7, reset: 0, blocked: false, visible: true, observed,
        transport: { readDeviceClock() {
            assert(requests.length < 4);
            const request = gate<DeviceClockResponse>(); requests.push(request);
            return request.promise;
        } },
        retained: { current: { sample: null } }, freshness: { current: 0 },
        flight: { current: null as Promise<void> | null }, queued: { current: null },
        refresh: { current: null }, reservation: { current: null as symbol | null },
        document: { visibilityState: 'visible' },
        setState(next: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>)) {
            state = typeof next === 'function' ? next(state) : next;
        },
        setInterval(callback: () => void, delay: number) {
            assert.equal(delay, 60_000); assert.equal(timers.size, 0);
            const id = ++ordinal; timers.set(id, callback); return id;
        },
        clearInterval(id: number) { assert(timers.delete(id)); },
    };
    const owner = bindHeader(context);
    return {
        context, requests, owner, state: () => state,
        observe(uptime: number | null) { effect(observed, 7, uptime, deviceRebooted, context.refresh); },
        async settle(index: number, value: DeviceClockResponse) {
            const pending = context.flight.current;
            assert(pending && requests[index]);
            requests[index].resolve(value); await pending; await Promise.resolve();
        },
        async close() {
            owner.cleanup?.();
            requests.forEach(r => r.resolve({ status: 'unavailable', reason: 'failed' }));
            await until(() => context.flight.current === null);
            assert.equal(timers.size, 0); assert.equal(context.refresh.current, null);
            assert.equal(context.queued.current, null); assert.equal(context.reservation.current, null);
        },
    };
}

test('rollback through unknown evidence cannot bypass a held clock owner and fresh calendar boot evidence still clears the baseline', async () => {
    const m = memory();
    let release: (() => void) | undefined;
    try {
        await m.settle(0, response(100)); m.observe(100);
        release = await m.owner.quiesce();
        const token = m.context.reservation.current;
        assert(token); assert.equal(m.state().status, 'stale');
        m.observe(null); m.observe(10);
        assert.equal(m.context.observed.current.uptime, 10);
        assert.equal(m.context.reservation.current, token);
        assert.equal(m.requests.length, 1, 'Actual refresh callback respects admission');
        release(); release();
        assert.equal(m.requests.length, 2, 'Only the matching release resumes a read');
        await m.settle(1, response(10));
        assert.equal(m.state().status, 'current');
        assert.equal(m.context.observed.current.uptime, null, 'Fresh calendar already observed the boot change');
        m.observe(null); m.observe(9);
        assert.equal(m.requests.length, 2, 'Unknown input cannot resurrect the pre-boot baseline');
    } finally { release?.(); await m.close(); }
});

test('rollback refresh joins the existing read and multiple observations cannot create overlapping reads', async () => {
    const m = memory();
    try {
        m.observe(100); m.observe(null); m.observe(10); m.observe(null); m.observe(5);
        assert.equal(m.requests.length, 1);
        assert(m.context.queued.current);
        await m.settle(0, response(100));
        await until(() => m.requests.length === 2);
        assert.equal(m.context.observed.current.uptime, 5);
        await m.settle(1, response(5));
        assert.equal(m.requests.length, 2);
        assert.equal(m.context.flight.current, null);
    } finally { await m.close(); }
});
