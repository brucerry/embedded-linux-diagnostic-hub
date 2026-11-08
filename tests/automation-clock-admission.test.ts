import { assertCallbackSource } from './fixtures/source-bound-callbacks';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GatewayClient } from '../src/services/GatewayClient';
import {
    FlowRunner,
    type FlowBackend,
    type FlowState,
    type RunClock,
} from '../src/features/automation/runner';
import { validatePlan, type AutomationPlan } from '../shared/automation';
import { bindHeader, bindRestore, bindSample, clockSpans } from './fixtures/header-clock-callbacks';
import { bindPage, type PageContext, boundSpan } from './fixtures/automation-page-arm-callbacks';
const hookSource = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
assertCallbackSource('src/hooks/useDeviceClock.ts', hookSource);
const pageSource = readFileSync('src/features/automation/AutomationPage.tsx', 'utf8');
assertCallbackSource('src/features/automation/AutomationPage.tsx', pageSource);
for (const span of clockSpans.slice(0, 3)) assert.ok(hookSource.includes(span));
assert.ok(pageSource.includes(clockSpans[3]) && pageSource.includes(boundSpan));
assert.ok(readFileSync('src/app/App.tsx', 'utf8').includes('clockAdmission={clock}'));
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
        release = r;
    });
    return { promise, release };
}
async function until(check: () => boolean) {
    for (let i = 0; i < 1024; i++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded memory clock work did not settle');
}
type Mode = 'normal' | 'cancel-drain' | 'replace' | 'cancel-flow' | 'cleanup-retry';
async function memoryScope(mode: Mode, verify: (f: any) => Promise<void>) {
    const keys = [
        'fetch',
        'window',
        'location',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
    ] as const;
    const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key)),
        beforeTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
    const timers = new Map<number, () => void>(),
        events = new Map<string, Set<unknown>>();
    let timerId = 0,
        sessionOrdinal = 0,
        mono = 11000,
        sleeps = 0,
        commands = 0,
        acquires = 0,
        releases = 0;
    const origin = Date.UTC(2028, 1, 29, 12),
        deviceOrigin = origin - 90000,
        readGates = [gate(), gate()],
        finish = gate(),
        leases = new Set<string>();
    const requests: { session: string; signal: AbortSignal; settled: boolean }[] = [],
        tasks: Promise<void>[] = [],
        reasons: string[] = [],
        states: FlowState[] = [],
        records: unknown[] = [];
    const clock: RunClock = {
        local: () => origin + mono,
        mono: () => mono,
        sleep: async (ms, signal) => {
            assert.ok(!signal.aborted);
            assert.ok(ms > 0 && ms <= 250);
            assert.ok(++sleeps < 128);
            mono += ms;
            assert.ok(mono < 30000);
            await Promise.resolve();
        },
    };
    const response = () => {
        const stamp = new Date(deviceOrigin + Math.floor(mono / 1000) * 1000).toISOString();
        return {
            status: 'available',
            sample: {
                date: stamp.slice(0, 10),
                time: stamp.slice(11, 19),
                epochSeconds: Date.parse(stamp) / 1000,
                utcOffsetMinutes: 0,
                zone: 'UTC',
                bootId: null,
                uptimeSeconds: null,
            },
        };
    };
    const setTimer = (f: () => void) => {
            assert.ok(timerId < 32);
            const id = ++timerId;
            timers.set(id, f);
            return id;
        },
        clearTimer = (id: number) => {
            assert.ok(timers.delete(id));
        };
    const windowMemory = {
        addEventListener(type: string, f: unknown) {
            const set = events.get(type) ?? new Set();
            set.add(f);
            events.set(type, set);
        },
        removeEventListener(type: string, f: unknown) {
            events.get(type)?.delete(f);
        },
    };
    let client: GatewayClient | undefined,
        header: any,
        owner: ReturnType<typeof bindHeader> | undefined,
        ctx: PageContext | undefined,
        runner: FlowRunner | undefined;
    const ui = { running: false, error: '', inspection: null as unknown, busy: [] as boolean[] };
    const fetchMemory: typeof fetch = async (input, init) => {
        const u = new URL(String(input));
        assert.equal(u.origin, 'https://memory.invalid');
        if (u.pathname === '/api/health') return Response.json({ connectionCancellation: true });
        if (u.pathname === '/api/sessions' && init?.method === 'POST')
            return Response.json({
                sessionId: String.fromCharCode(97 + sessionOrdinal++).repeat(32),
            });
        const match = /^\/api\/sessions\/([ab]{32})(\/clock)?$/.exec(u.pathname);
        assert.ok(match, 'Unexpected synthetic request ' + u.pathname);
        if (!match[2]) {
            assert.equal(init?.method, 'DELETE');
            return Response.json({});
        }
        assert.ok(init?.signal instanceof AbortSignal);
        const req = { session: match[1], signal: init.signal, settled: false };
        requests.push(req);
        assert.ok(requests.length <= 8);
        try {
            if (requests.length === 2) await readGates[0].promise;
            if (requests.length === 3 && mode === 'cancel-flow') await readGates[1].promise;
            if (req.signal.aborted)
                throw new DOMException('Synthetic acknowledged abort', 'AbortError');
            return Response.json(response());
        } finally {
            req.settled = true;
        }
    };
    try {
        const values = [
            fetchMemory,
            windowMemory,
            { protocol: 'https:' },
            setTimer,
            clearTimer,
            setTimer,
            clearTimer,
        ];
        keys.forEach((key, i) =>
            Object.defineProperty(globalThis, key, {
                configurable: true,
                writable: true,
                value: values[i],
            }),
        );
        Object.defineProperty(AbortSignal, 'timeout', {
            configurable: true,
            writable: true,
            value: () => new AbortController().signal,
        });
        client = new GatewayClient({
            url: 'https://memory.invalid',
            token: 'synthetic-placeholder-token-'.repeat(2),
        });
        const connect = () =>
            client!.connect(
                {
                    host: 'synthetic-device',
                    port: 22,
                    username: 'synthetic-user',
                    auth: 'password',
                    password: 'synthetic-placeholder',
                },
                String(sessionOrdinal + 1).repeat(32),
            );
        await connect();
        const initialConnection = client.automationConnection();
        header = {
            generation: 1,
            transport: client,
            reset: 0,
            blocked: false,
            visible: true,
            retained: { current: { sample: null } },
            setState: (_s: unknown) => {},
            flight: { current: null },
            queued: { current: null },
            refresh: { current: null },
            reservation: { current: null },
            observed: { current: { generation: 1, uptime: null } },
            document: { visibilityState: 'visible' },
            setInterval: setTimer,
            clearInterval: clearTimer,
        };
        owner = bindHeader(header);
        await until(() => requests.length === 1 && header.flight.current === null);
        bindRestore(header)();
        await until(() => requests.length === 2 && header.flight.current !== null);
        const sample = bindSample({
            props: { transport: client },
            transport: 'ssh',
            Date: { now: clock.local },
            performance: { now: clock.mono },
        });
        const input: AutomationPlan = {
            transport: 'ssh',
            steps: [
                {
                    id: 'one',
                    name: 'One',
                    enabled: true,
                    command: 'synthetic never transmitted',
                    delaySeconds: 0,
                },
            ],
            timeoutSeconds: 10,
            repeatSeconds: null,
            serial: { lineEnding: 'CR', prompt: '', timestampPrefix: '' },
            start: {
                clock: 'device',
                zone: 'UTC',
                epochMs: deviceOrigin + 16000,
                calibration: {
                    source: 'SSH fixed read-only clock sample (date)',
                    connection: initialConnection,
                    deviceEpochMs: deviceOrigin,
                    sampledLocalMs: origin,
                    sampledMonoMs: 0,
                    uncertaintyMs: 1000,
                    zone: 'UTC UTC0 minutes',
                },
            },
        };
        runner = new FlowRunner(
            (s) => {
                states.push(s);
                ui.running =
                    Boolean(s.cleanupPending) ||
                    ['waiting', 'running', 'delaying'].includes(s.state);
            },
            (r) => {
                records.push(r);
            },
            clock,
        );
        const onBusy = (v: boolean) => ui.busy.push(v);
        ctx = {
            cleanupClock: { current: undefined },
            pendingClockSamples: { current: 0 },
            manualClockSample: { current: null },
            runner: { current: runner },
            arming: { current: false },
            armAttempt: { current: null },
            activityEpoch: { current: 0 },
            flowInspectionId: { current: null },
            cleanupActivity: { current: undefined },
            cleanupConsoleResults: { current: undefined },
            consoleResultsAdmission: { current: null },
            props: {
                clockAdmission: owner,
                connected: true,
                transport: client,
                serial: { current: { generation: 1, label: 'unused' }, framing: 'unused' },
                target: { endpoint: 'synthetic' },
                busy: false,
                blocked: false,
                onBusy,
            },
            latest: {
                current: {
                    transport: client,
                    connected: true,
                    blocked: false,
                    onBusy,
                    target: { endpoint: 'synthetic' },
                },
            },
            fieldIssues: [],
            focusIssue: () => assert.fail('Valid input'),
            build: () => validatePlan(input),
            hidden: false,
            connected: true,
            captureActionBusy: false,
            desktop: {
                async acquireAutomationActivity() {
                    const id = 'lease-' + ++acquires;
                    assert.equal(leases.size, 0);
                    leases.add(id);
                    return id;
                },
                async releaseAutomationActivity(id) {
                    assert.ok(leases.delete(id));
                    releases++;
                },
            },
            setError: (v) => {
                ui.error = v;
            },
            setRunning: (v) => {
                ui.running = v;
            },
            setState: (s) => states.push(s),
            setFlowInspection: (v) => {
                ui.inspection = v;
            },
            openCaptureRepository: async () => ({}),
            openConsoleJournal: async () => assert.fail('No storage'),
            sample: async () => assert.fail('Only captured backend sample producer may read'),
            serialCaptureBackend: () => assert.fail('No Serial'),
            sshConsoleBackend: () => assert.fail('No console'),
            sshCaptureBackend: () => {
                const backend: FlowBackend = {
                    connection: () => client!.automationConnection(),
                    available: () => Boolean(client!.automationConnection()),
                    target: { endpoint: 'synthetic' },
                    acquire: () => () => {},
                    sampleClock: () => sample(client),
                    execute: async () => {
                        assert.equal(mono, 16000);
                        assert.equal(commands, 0);
                        commands++;
                        return {
                            stdout: 'synthetic',
                            stderr: '',
                            exitCode: 0,
                            completion: 'exit',
                            truncated: false,
                            chunks: [],
                        };
                    },
                    finishFlow: async (reason) => {
                        reasons.push(reason);
                        if (mode === 'cleanup-retry' && reasons.length === 1)
                            throw Error('Synthetic owned close remains unacknowledged');
                        await finish.promise;
                    },
                };
                return backend;
            },
        };
        const page = () => bindPage(ctx!);
        const start = () => {
            const task = page().start();
            tasks.push(task);
            return task;
        };
        await verify({
            client,
            connect,
            get header() {
                return header;
            },
            get owner() {
                return owner;
            },
            ctx,
            runner,
            ui,
            states,
            records,
            requests,
            readGates,
            finish,
            leases,
            reasons,
            page,
            start,
            advance() {
                mono += 1000;
            },
            get commands() {
                return commands;
            },
            get acquires() {
                return acquires;
            },
            get releases() {
                return releases;
            },
            async replaceHeader() {
                owner?.cleanup?.();
                header = { ...header, generation: 2 };
                owner = bindHeader(header);
                ctx!.props.clockAdmission = owner;
            },
        });
    } finally {
        try {
            if (ctx && (ctx.arming.current || runner?.busy)) bindPage(ctx).cancel();
            readGates.forEach((g) => g.release());
            finish.release();
            await Promise.all(tasks);
            if (runner?.cleanupPending && ctx) bindPage(ctx).cancel();
            if (runner) await until(() => !runner!.busy);
            if (header) await until(() => header.reservation.current === null);
            owner?.cleanup?.();
            await client?.disconnect();
            if (header) await until(() => header.flight.current === null);
            assert.equal(leases.size, 0);
            assert.equal(timers.size, 0);
            for (const set of events.values()) assert.equal(set.size, 0);
        } finally {
            keys.forEach((key, i) => {
                if (before[i]) Object.defineProperty(globalThis, key, before[i]!);
                else Reflect.deleteProperty(globalThis, key);
            });
            Object.defineProperty(AbortSignal, 'timeout', beforeTimeout);
            keys.forEach((key, i) =>
                assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), before[i]),
            );
            assert.deepEqual(
                Object.getOwnPropertyDescriptor(AbortSignal, 'timeout'),
                beforeTimeout,
            );
        }
    }
}
for (const mode of ['normal', 'cancel-drain', 'replace', 'cancel-flow', 'cleanup-retry'] as const)
    test(`header clock admission preserves ${mode} ownership without shared calibration replies`, async () =>
        memoryScope(mode, async (f) => {
            const task = f.start();
            await until(() => f.header.reservation.current !== null);
            assert.equal(f.acquires, 0);
            assert.equal(f.commands, 0);
            assert.equal(f.requests.length, 2);
            bindRestore(f.header)();
            assert.equal(f.requests.length, 2);
            if (mode === 'cancel-drain') {
                f.page().cancel();
                assert.equal(f.requests[1].signal.aborted, false);
                assert.ok(f.header.reservation.current);
                f.readGates[0].release();
                await task;
                await until(() => f.header.flight.current === null);
                assert.equal(f.acquires, 0);
                assert.equal(f.commands, 0);
                assert.equal(f.header.reservation.current, null);
                return;
            }
            if (mode === 'replace') {
                await f.client.disconnect();
                assert.equal(f.requests[1].signal.aborted, true);
                await f.connect();
                await f.replaceHeader();
                assert.equal(f.requests.length, 2);
                f.readGates[0].release();
                await task;
                await until(() => f.header.flight.current === null);
                assert.equal(f.commands, 0);
                assert.match(f.ui.error, /eligibility changed/);
                assert.equal(f.requests[2].session, 'b'.repeat(32));
                assert.equal(f.acquires, f.releases);
                return;
            }
            f.advance();
            f.readGates[0].release();
            if (mode === 'cancel-flow') {
                await until(() => f.requests.length === 3);
                assert.equal(f.requests[2].signal.aborted, false);
                f.page().cancel();
                assert.equal(f.requests[2].signal.aborted, false);
                f.readGates[1].release();
                await until(() => f.reasons.length === 1);
                assert.equal(f.commands, 0);
            } else await until(() => f.reasons.length === 1);
            assert.equal(f.acquires, 1);
            assert.equal(f.releases, 0);
            assert.ok(f.header.reservation.current);
            assert.equal(f.requests.length, 3);
            bindRestore(f.header)();
            assert.equal(f.requests.length, 3);
            if (mode === 'cleanup-retry') {
                await task;
                assert.equal(f.runner.cleanupPending, true);
                f.page().cancel();
                await until(() => f.reasons.length === 2);
                assert.ok(f.header.reservation.current);
            } else assert.equal(f.runner.busy, true);
            f.finish.release();
            await task;
            await until(
                () =>
                    f.header.reservation.current === null &&
                    f.releases === 1 &&
                    f.header.flight.current === null,
            );
            assert.equal(f.commands, mode === 'cancel-flow' ? 0 : 1);
            assert.equal(f.records.length, mode === 'cancel-flow' ? 0 : 1);
            assert.equal(f.runner.busy, false);
            assert.equal(f.runner.cleanupPending, false);
            assert.ok(f.requests.length >= 4);
            if (mode === 'normal') {
                const oldResume = await f.owner.quiesce();
                oldResume();
                await until(() => f.header.flight.current === null);
                const currentResume = await f.owner.quiesce();
                try {
                    const token = f.header.reservation.current,
                        count = f.requests.length;
                    oldResume();
                    assert.equal(f.header.reservation.current, token);
                    assert.equal(f.requests.length, count);
                } finally {
                    currentResume();
                }
                await until(() => f.header.flight.current === null);
            }
        }));
