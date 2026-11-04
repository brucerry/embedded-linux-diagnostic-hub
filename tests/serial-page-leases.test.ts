import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { AutomationActivity } from '../electron/automation-activity';
import { SerialSession } from '../src/features/serial/session';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import { FlowRunner, type FlowState } from '../src/features/automation/runner';
import type { FlowInspection } from '../src/features/automation/flow/inspection';
import { validatePlan, type AutomationPlan, type AutomationRecord } from '../shared/automation';
import {
    appendFrames,
    newCapture,
    sealedCapture,
    type CaptureRepository,
    type StoredCapture,
} from '../shared/capture-store';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';
import type { DeviceClockState } from '../src/hooks/useDeviceClock';
import type { DeviceClockResponse } from '../shared/diagnostics/device-clock';
import { bindPage, boundSpan, type PageContext } from './fixtures/automation-page-arm-callbacks';
import { bindHeader, bindRestore, clockSpans } from './fixtures/header-clock-callbacks';
import { bindPageRunnerChanged } from './fixtures/automation-page-runner-change';

// Only pinned source files are read; no runtime storage implementation is loaded.
const pageSource = readFileSync('src/features/automation/AutomationPage.tsx', 'utf8');
const hookSource = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
const pageFixture = readFileSync('tests/fixtures/automation-page-arm-callbacks.ts', 'utf8');
const changeFixture = readFileSync('tests/fixtures/automation-page-runner-change.ts', 'utf8');
const headerFixture = readFileSync('tests/fixtures/header-clock-callbacks.ts', 'utf8');
const callbackStart = pageSource.indexOf(
    '            (next) => {',
    pageSource.indexOf('runner.current = new FlowRunner('),
);
const callbackEnd = pageSource.indexOf('            async (r) => {', callbackStart);
assert.ok(callbackStart > 0 && callbackEnd > callbackStart);
assert.ok(changeFixture.includes(pageSource.slice(callbackStart, callbackEnd)));
assert.ok(pageSource.includes(boundSpan));
const boundStart = pageFixture.indexOf(
    '    const invalidateManualClockSample',
    pageFixture.indexOf('export function bindPage('),
);
assert.equal(
    pageFixture.slice(boundStart, pageFixture.indexOf('\n return {start', boundStart)).trim(),
    boundSpan.trim(),
);
for (const span of clockSpans.slice(0, 3)) {
    assert.ok(hookSource.includes(span));
    assert.ok(
        headerFixture.slice(headerFixture.indexOf('export function bindHeader(')).includes(span),
    );
}

function gate() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function jobs() {
    for (let i = 0; i < 128; i++) await Promise.resolve();
}
async function until(check: () => boolean, name: string) {
    for (let i = 0; i < 1024 && !check(); i++) await Promise.resolve();
    assert.ok(check(), name + ' within 1024 microtask turns');
}
function observe(promise: Promise<unknown>) {
    const result: { done: boolean; error?: unknown } = { done: false };
    void promise.then(
        () => {
            result.done = true;
        },
        (error: unknown) => {
            result.error = error;
            result.done = true;
        },
    );
    return result;
}
function portFixture() {
    const write = gate(),
        close = gate();
    let receive!: ReadableStreamDefaultController<Uint8Array>, rejectClose: Error | undefined;
    const counts = { opens: 0, writes: 0, closeCalls: 0, closeAcks: 0 };
    const payloads: Uint8Array[] = [];
    const readable = () =>
        new ReadableStream<Uint8Array>({
            start(c) {
                receive = c;
            },
        });
    const port: LocalSerialPort = {
        readable: null,
        writable: null,
        async open() {
            assert.equal(++counts.opens, 1);
            this.readable = readable();
            this.writable = new WritableStream<Uint8Array>({
                async write(bytes) {
                    assert.equal(++counts.writes, 1);
                    payloads.push(Uint8Array.from(bytes));
                    await write.promise;
                },
            });
        },
        async close() {
            assert.ok(++counts.closeCalls <= 2);
            assert.equal(this.readable?.locked, false);
            assert.equal(this.writable?.locked, false);
            const failure = rejectClose;
            rejectClose = undefined;
            if (failure) throw failure;
            await close.promise;
            counts.closeAcks++;
            this.readable = null;
            this.writable = null;
        },
        getInfo: () => ({}),
    };
    return {
        port,
        write,
        close,
        counts,
        payloads,
        push: (value: string) => receive.enqueue(new TextEncoder().encode(value)),
        break() {
            const before = receive;
            port.readable = readable();
            before.error(Object.assign(Error('synthetic read break'), { name: 'BreakError' }));
        },
        failNextClose(error: Error) {
            rejectClose = error;
        },
    };
}

test('actual Serial cleanup keeps Page leases and stale retry completion cannot resume a replacement clock owner', async (t) => {
    const ports = [portFixture(), portFixture()],
        releaseReplyA = gate(),
        secondHeaderRead = gate();
    const captures = new Map<string, StoredCapture>(),
        raw: Uint8Array[] = [],
        records: AutomationRecord[] = [];
    const states: FlowState[] = [],
        busy: boolean[] = [],
        errors: string[] = [],
        activityIDs: string[] = [],
        releasedIDs: string[] = [],
        throttle: boolean[] = [];
    const tasks: ReturnType<typeof observe>[] = [],
        intervals = new Map<number, () => void>();
    let mono = 11000,
        headerReads = 0,
        receives = 0,
        serialStarts = 0,
        begins = 0,
        releaseRepliesPending = 0;
    let inspection: FlowInspection | null = null,
        running = false;
    const session = new SerialSession(async () => {
        assert.ok(++receives <= 2);
    }, 50);
    const activity = new AutomationActivity(
        (value) => throttle.push(value),
        () => assert.fail('No interruption'),
        () => false,
    );
    const track = (promise: Promise<unknown>) => {
        const task = observe(promise);
        tasks.push(task);
        return task;
    };
    const forbidden = (name: string): never => {
        throw Error('Forbidden storage IO: ' + name);
    };
    const repository: CaptureRepository = {
        async begin(header) {
            assert.ok(++begins <= 2);
            const capture = newCapture(
                '00000000-0000-4000-8000-' + begins.toString(16).padStart(12, '0'),
                begins,
                header,
            );
            captures.set(capture.id, capture);
            return structuredClone(capture);
        },
        async append(id, frames) {
            for (const frame of frames) {
                assert.ok(frame.bytes.length <= 64);
                raw.push(Uint8Array.from(frame.bytes));
            }
            const capture = appendFrames(captures.get(id)!, frames);
            captures.set(id, capture);
            return structuredClone(capture);
        },
        async seal(id, observed, reason) {
            const capture = sealedCapture(captures.get(id)!, observed, reason);
            captures.set(id, capture);
            return structuredClone(capture);
        },
        fail: async () => forbidden('fail'),
        page: async () => forbidden('page'),
        read: () => forbidden('read'),
        delete: async () => forbidden('delete'),
        close: async () => forbidden('close'),
        pin: async () => forbidden('pin'),
        record: async () => forbidden('record'),
        result: async () => forbidden('result'),
    };
    let headerState: DeviceClockState = { status: 'loading', sample: null };
    const headerTransport = {
        automationConnection: () => 'memory-header-connection',
        async readDeviceClock(): Promise<DeviceClockResponse> {
            assert.ok(++headerReads <= 3);
            if (headerReads === 2) await secondHeaderRead.promise;
            return {
                status: 'available',
                sample: {
                    date: '2028-02-29',
                    time: '12:00:00',
                    epochSeconds: Date.UTC(2028, 1, 29, 12) / 1000,
                    utcOffsetMinutes: 0,
                    zone: 'UTC',
                    bootId: null,
                    uptimeSeconds: null,
                },
            };
        },
    };
    const header = {
        generation: 1,
        transport: headerTransport,
        reset: 0,
        blocked: false,
        visible: true,
        retained: { current: { sample: null } },
        freshness: { current: 0 },
        flight: { current: null as Promise<void> | null },
        queued: { current: null as (() => void) | null },
        refresh: { current: null as (() => void) | null },
        reservation: { current: null as symbol | null },
        observed: { current: { generation: 1, uptime: null } },
        document: { visibilityState: 'visible' },
        setState(next: DeviceClockState | ((value: DeviceClockState) => DeviceClockState)) {
            headerState = typeof next === 'function' ? next(headerState) : next;
        },
        setInterval(callback: () => void) {
            assert.equal(intervals.size, 0);
            intervals.set(1, callback);
            return 1;
        },
        clearInterval(id: number) {
            assert.ok(intervals.delete(id));
        },
    };
    const onBusy = (value: boolean) => {
        assert.ok(busy.length < 40);
        busy.push(value);
    };
    const latest = {
        current: {
            transport: headerTransport,
            connected: true,
            blocked: false,
            onBusy,
            target: { endpoint: 'memory SSH header only' },
        },
    };
    const flowInspectionId = { current: null as string | null };
    const setState = (state: FlowState) => {
        assert.ok(states.length < 40);
        states.push(state);
    };
    const setRunning = (value: boolean) => {
        running = value;
    };
    const setFlowInspection = (
        value: FlowInspection | null | ((value: FlowInspection | null) => FlowInspection | null),
    ) => {
        inspection = typeof value === 'function' ? value(inspection) : value;
    };
    const runner = new FlowRunner(
        bindPageRunnerChanged({
            flowInspectionId,
            latest,
            setState,
            setRunning,
            setFlowInspection,
        }),
        async (record) => {
            assert.ok(records.length < 2);
            records.push(record);
        },
        {
            local: () => Date.UTC(2028, 1, 29, 12) + mono,
            mono: () => mono,
            async sleep() {
                throw Error('No runner sleep');
            },
        },
    );
    const draft: AutomationPlan = {
        transport: 'serial',
        start: null,
        timeoutSeconds: 300,
        repeatSeconds: null,
        captureDeviceTime: false,
        serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
        steps: [
            { id: 'one', name: 'First', command: 'synthetic', enabled: true, delaySeconds: 0 },
            { id: 'never', name: 'Never', command: 'never', enabled: true, delaySeconds: 0 },
        ],
    };
    let clockOwner: ReturnType<typeof bindHeader> | undefined,
        ctx: PageContext | undefined,
        unsubscribe: (() => void) | undefined;
    const savedNow = performance.now,
        savedDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    const savedSet = globalThis.setTimeout,
        savedClear = globalThis.clearTimeout;
    const advance = async (ms: number) => {
        mono += ms;
        t.mock.timers.tick(ms);
        await jobs();
    };
    const poll = () => {
        intervals.forEach((callback) => callback());
        bindRestore(header)();
    };
    const failures: unknown[] = [];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    Object.defineProperty(performance, 'now', {
        value: () => mono,
        configurable: true,
        writable: true,
    });
    try {
        clockOwner = bindHeader(header);
        await until(() => headerReads === 1 && header.flight.current === null, 'initial header');
        ctx = {
            cleanupClock: { current: undefined },
            cleanupActivity: { current: undefined },
            cleanupConsoleResults: { current: undefined },
            consoleResultsAdmission: { current: null },
            pendingClockSamples: { current: 0 },
            manualClockSample: { current: null },
            runner: { current: runner },
            arming: { current: false },
            armAttempt: { current: null },
            activityEpoch: { current: 0 },
            flowInspectionId,
            props: {
                clockAdmission: clockOwner,
                connected: true,
                transport: headerTransport,
                serial: session,
                target: latest.current.target,
                busy: false,
                blocked: false,
                onBusy,
            },
            latest,
            fieldIssues: [],
            focusIssue: () => assert.fail('Valid draft'),
            build: () => validatePlan(draft),
            hidden: false,
            connected: false,
            captureActionBusy: false,
            desktop: {
                async acquireAutomationActivity() {
                    const id = activity.acquire();
                    activityIDs.push(id);
                    assert.ok(activityIDs.length <= 2);
                    return id;
                },
                async releaseAutomationActivity(id) {
                    assert.equal(releasedIDs.includes(id), false);
                    releasedIDs.push(id);
                    activity.release(id);
                    releaseRepliesPending++;
                    try {
                        if (id === activityIDs[0]) await releaseReplyA.promise;
                    } finally {
                        releaseRepliesPending--;
                    }
                },
            },
            setError: (error) => {
                assert.ok(errors.length < 12);
                errors.push(error);
            },
            setState,
            setRunning,
            setFlowInspection,
            openCaptureRepository: async () => repository,
            openConsoleJournal: async () => assert.fail('No console storage'),
            sample: async () => assert.fail('No calibration in Serial'),
            sshConsoleBackend: () => assert.fail('No console backend'),
            sshCaptureBackend: () => assert.fail('No SSH backend'),
            serialCaptureBackend: (...args) => {
                assert.strictEqual(args[0], session);
                assert.strictEqual(args[1], repository);
                assert.ok(++serialStarts <= 2);
                return serialCaptureBackend(session, repository);
            },
        };
        unsubscribe = session.subscribe((status) => {
            ctx!.connected = status.state === 'connected';
        });
        const page = () => bindPage(ctx!);
        const connect = async (index: number) => {
            session.select(ports[index].port, 'synthetic UART ' + index);
            await session.connect(DEFAULT_SERIAL_SETTINGS);
        };
        const breakFlow = async (index: number) => {
            await until(() => ports[index].counts.writes === 1, 'Serial input');
            ports[index].push('prefix-' + index + '\r\n');
            await until(() => receives === index + 1, 'Serial observation');
            await jobs();
            ports[index].break();
            await jobs();
            await until(() => records.length === index + 1, 'failed capture record');
        };
        await connect(0);
        const armA = track(page().start());
        await until(() => ports[0].counts.writes === 1, 'run A');
        const tokenA = header.reservation.current;
        assert.ok(tokenA);
        poll();
        assert.equal(headerReads, 1);
        await breakFlow(0);
        page().cancel();
        await advance(51);
        await until(() => armA.done, 'A cleanup adoption');
        assert.equal(armA.error, undefined);
        assert.equal(runner.cleanupPending, true);
        assert.equal(running, true);
        assert.equal(ctx.cleanupActivity.current, activityIDs[0]);
        assert.equal(header.reservation.current, tokenA);
        assert.ok(ctx.cleanupClock.current);
        poll();
        assert.equal(headerReads, 1);
        assert.equal(releasedIDs.length, 0);
        page().cancel();
        await advance(51);
        await until(
            () => errors.at(-1)?.includes('UART BreakError') ?? false,
            'pending retry diagnostic',
        );
        assert.equal(releasedIDs.length, 0);
        assert.equal(header.reservation.current, tokenA);
        poll();
        assert.equal(headerReads, 1);
        ports[0].write.reject(Error('synthetic write failure'));
        await jobs();
        page().cancel();
        await until(
            () => errors.at(-1)?.includes('synthetic write failure') ?? false,
            'rejected cleanup',
        );
        assert.equal(runner.cleanupPending, true);
        assert.equal(releasedIDs.length, 0);
        const closeError = Error('synthetic port close rejected');
        ports[0].failNextClose(closeError);
        const failedClose = track(session.close());
        await until(() => failedClose.done, 'close rejection');
        assert.strictEqual(failedClose.error, closeError);
        page().cancel();
        await until(
            () => errors.at(-1)?.includes(closeError.message) ?? false,
            'Page close-error diagnostic',
        );
        assert.equal(ctx.cleanupActivity.current, activityIDs[0]);
        assert.equal(header.reservation.current, tokenA);
        poll();
        assert.equal(headerReads, 1);
        const closingA = track(session.close());
        await until(() => ports[0].counts.closeCalls === 2, 'explicit close retry');
        page().cancel();
        page().cancel();
        await jobs();
        assert.equal(releasedIDs.length, 0);
        assert.equal(headerReads, 1);
        ports[0].close.resolve();
        await until(
            () => closingA.done && releaseRepliesPending === 1 && headerReads === 2,
            'A proof then delayed reply',
        );
        assert.equal(closingA.error, undefined);
        assert.equal(session.isOwned, false);
        assert.deepEqual(releasedIDs, [activityIDs[0]]);
        assert.equal(header.reservation.current, null);
        assert.ok(header.flight.current);
        assert.equal(headerState.status, 'stale');
        // Native release was handled; its reply is still pending. Local admission resumed
        // only A's clock token after positive Serial retirement; duplicate retries coalesce.
        await connect(1);
        const armB = track(page().start());
        await jobs();
        const tokenB = header.reservation.current;
        assert.ok(tokenB && tokenB !== tokenA);
        assert.equal(ports[1].counts.writes, 0, 'B must drain the current header read');
        secondHeaderRead.resolve();
        await until(() => ports[1].counts.writes === 1, 'B after header drain');
        assert.notEqual(activityIDs[1], activityIDs[0]);
        await breakFlow(1);
        await advance(51);
        await until(() => armB.done, 'B cleanup adoption');
        const resumeB = ctx.cleanupClock.current;
        assert.ok(resumeB);
        assert.equal(ctx.cleanupActivity.current, activityIDs[1]);
        assert.equal(header.reservation.current, tokenB);
        assert.equal(runner.cleanupPending, true);
        releaseReplyA.resolve();
        await until(() => releaseRepliesPending === 0, 'old release reply');
        await jobs();
        assert.equal(ctx.cleanupActivity.current, activityIDs[1]);
        assert.strictEqual(ctx.cleanupClock.current, resumeB);
        assert.equal(header.reservation.current, tokenB);
        assert.equal(runner.busy, true);
        assert.equal(running, true);
        assert.equal(busy.at(-1), true);
        assert.equal(throttle.at(-1), false);
        assert.throws(() => activity.acquire(), /already owns/);
        poll();
        assert.equal(headerReads, 2);
        assert.deepEqual(releasedIDs, [activityIDs[0]]);
        const closingB = track(session.close());
        page().cancel();
        ports[1].write.resolve();
        await advance(25);
        await until(() => ports[1].counts.closeCalls === 1, 'B close requested');
        assert.equal(closingB.done, false);
        assert.equal(header.reservation.current, tokenB);
        ports[1].close.resolve();
        await until(
            () =>
                closingB.done &&
                !runner.busy &&
                ctx!.cleanupClock.current === undefined &&
                header.flight.current === null,
            'B proof and Page release',
        );
        assert.equal(closingB.error, undefined);
        assert.equal(ctx.cleanupActivity.current, undefined);
        assert.equal(header.reservation.current, null);
        assert.deepEqual(releasedIDs, activityIDs);
        assert.equal(headerReads, 3);
        assert.equal(headerState.status, 'current');
        assert.equal(running, false);
        assert.deepEqual(throttle, [false, true, false, true]);
        assert.equal(records.length, 2);
        assert.notEqual(records[0].runId, records[1].runId);
        for (let i = 0; i < 2; i++) {
            assert.equal(records[i].completion, 'transport-error');
            assert.equal(records[i].exitCode, null);
            assert.deepEqual(ports[i].payloads, [new TextEncoder().encode('synthetic\r')]);
            assert.deepEqual(raw[i], new TextEncoder().encode('prefix-' + i + '\r\n'));
            assert.equal(ports[i].counts.opens, 1);
        }
        t.diagnostic(
            JSON.stringify({
                runs: 2,
                captures: begins,
                headerReads,
                activityAcquires: activityIDs.length,
                activityReleases: releasedIDs.length,
                staleReplyPreservedB: true,
                closeAttempts: ports.map((port) => port.counts.closeCalls),
                mountedReact: false,
                nativeIPC: false,
            }),
        );
    } catch (error) {
        failures.push(error);
    } finally {
        ports.forEach((port) => {
            port.write.resolve();
            port.close.resolve();
        });
        secondHeaderRead.resolve();
        releaseReplyA.resolve();
        try {
            runner.cancel();
            const close = track(session.close(true));
            await jobs();
            if (!close.done) await advance(25);
            await until(() => close.done, 'fixture port close');
            if (close.error) throw close.error;
            if (runner.cleanupPending && ctx) bindPage(ctx).cancel();
            await advance(101);
            await until(() => !runner.busy && releaseRepliesPending === 0, 'owned Page retirement');
            for (const task of tasks) await until(() => task.done, 'tracked memory task');
            await until(
                () => header.reservation.current === null && header.flight.current === null,
                'clock retirement',
            );
            assert.equal(session.isOwned, false);
            assert.equal(ctx?.cleanupActivity.current, undefined);
            assert.equal(ctx?.cleanupClock.current, undefined);
        } catch (error) {
            failures.push(error);
        } finally {
            unsubscribe?.();
            clockOwner?.cleanup?.();
            assert.equal(intervals.size, 0);
            if (savedDescriptor) Object.defineProperty(performance, 'now', savedDescriptor);
            else assert.equal(Reflect.deleteProperty(performance, 'now'), true);
            assert.strictEqual(performance.now, savedNow);
            assert.deepEqual(Object.getOwnPropertyDescriptor(performance, 'now'), savedDescriptor);
            t.mock.timers.reset();
            assert.strictEqual(globalThis.setTimeout, savedSet);
            assert.strictEqual(globalThis.clearTimeout, savedClear);
        }
    }
    if (failures.length) {
        for (const error of failures)
            t.diagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error));
        throw new AggregateError(
            failures,
            'Serial/Page lease contract or fixture retirement failed',
        );
    }
});
