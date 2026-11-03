import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bindPage, boundSpan, type PageContext } from './fixtures/automation-page-arm-callbacks';
import { bindHeader, clockSpans } from './fixtures/header-clock-callbacks';
import type { FlowBackend, FlowRunner } from '../src/features/automation/runner';
import type { AutomationPlan } from '../shared/automation';

const pageSource = readFileSync('src/features/automation/AutomationPage.tsx', 'utf8');
const pageFixture = readFileSync('tests/fixtures/automation-page-arm-callbacks.ts', 'utf8');
assert.ok(pageSource.includes(boundSpan));
assert.ok(pageFixture.slice(pageFixture.indexOf('export function bindPage('))
    .includes(boundSpan.trim()));
const clockSource = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
const clockFixture = readFileSync('tests/fixtures/header-clock-callbacks.ts', 'utf8');
const headerBinding = clockFixture.split('export function bindHeader')[1]
    .split('export function bindRestore')[0];
for (const span of [clockSpans[0], clockSpans[2]]) {
    assert.ok(clockSource.includes(span));
    assert.ok(headerBinding.includes(span.trim()));
}
assert.ok(readFileSync('src/app/App.tsx', 'utf8').includes('clockAdmission={clock}'));

function gate<T>() {
    let settled = false;
    let yes!: (value: T) => void, no!: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => { yes = resolve; no = reject; });
    return {
        promise, get settled() { return settled; },
        resolve(value: T) { assert.equal(settled, false); settled = true; yes(value); },
        reject(error: Error) { assert.equal(settled, false); settled = true; no(error); },
    };
}
async function until(check: () => boolean) {
    for (let i = 0; i < 256; i++) { if (check()) return; await Promise.resolve(); }
    assert.fail('Bounded Page/header memory work did not settle.');
}

for (const transport of ['ssh', 'serial'] as const)
    for (const outcome of ['held-release', 'rejected-acquisition'] as const)
        test(`${transport} cancelled pre-arm keeps actual clock fence through ${outcome}`, async () => {
            const pending: ReturnType<typeof gate<string>>[] = [], tasks: Promise<void>[] = [];
            const releaseOld = gate<void>(), liveLeases = new Set<string>(), released: string[] = [];
            const resumes: (() => void)[] = [], timers = new Map<number, () => void>();
            let reads = 0, runnerStarts = 0, repositories = 0, headerState: any = { sample: null };
            const header: any = {
                generation: 1, reset: 0, blocked: false, visible: true,
                transport: { async readDeviceClock() {
                    assert.ok(++reads <= 4);
                    return { status: 'available', sample: { date: '2028-02-29', time: '12:00:00',
                        epochSeconds: 1835438400, utcOffsetMinutes: 0, zone: 'UTC',
                        bootId: null, uptimeSeconds: null } };
                } },
                retained: { current: { sample: null } }, freshness: { current: 0 },
                flight: { current: null }, queued: { current: null }, refresh: { current: null },
                reservation: { current: null }, observed: { current: { uptime: null } },
                document: { visibilityState: 'visible' },
                setState(value: any) { headerState = typeof value === 'function' ? value(headerState) : value; },
                setInterval(callback: () => void, delay: number) {
                    assert.equal(delay, 60_000); assert.equal(timers.size, 0);
                    timers.set(1, callback); return 1;
                },
                clearInterval(id: number) { assert.ok(timers.delete(id)); },
            };
            const owner = bindHeader(header);
            const ui = { error: '', running: false, inspection: null as unknown, busy: [] as boolean[] };
            const active = { automationConnection: () => 'memory-connection' };
            const onBusy = (value: boolean) => { ui.busy.push(value); };
            const plan: AutomationPlan = {
                transport, steps: [{ id: 'one', name: 'Synthetic', enabled: true,
                    command: 'never transmitted', delaySeconds: 0 }], timeoutSeconds: 10,
                repeatSeconds: 30, start: null, serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
                ...(transport === 'ssh' ? { ssh: { mode: 'independent-script' as const } } : {}),
            };
            const runner = { busy: false, cleanupPending: false, cancel() {},
                async start() { runnerStarts++; assert.fail('No cancelled pre-arm may run.'); },
            } as unknown as FlowRunner;
            const backend = { connection: () => 'memory-connection', available: () => true,
                target: { endpoint: 'synthetic' } } as FlowBackend;
            const ctx: PageContext = {
                cleanupClock: { current: undefined }, cleanupActivity: { current: undefined },
                cleanupConsoleResults: { current: undefined }, consoleResultsAdmission: { current: null },
                pendingClockSamples: { current: 0 }, manualClockSample: { current: null },
                runner: { current: runner }, arming: { current: false }, armAttempt: { current: null },
                activityEpoch: { current: 0 }, flowInspectionId: { current: null },
                props: { clockAdmission: { async quiesce() {
                    const resume = await owner.quiesce(); resumes.push(resume); return resume;
                } }, connected: true, transport: active, serial: { current: { generation: 1,
                    label: 'synthetic Serial' }, framing: 'synthetic' }, target: { endpoint: 'synthetic' },
                    busy: false, blocked: false, onBusy },
                latest: { current: { transport: active, connected: true, blocked: false, onBusy } },
                fieldIssues: [], focusIssue: () => assert.fail('Valid fixture'), build: () => plan,
                hidden: false, connected: true, captureActionBusy: false,
                desktop: {
                    acquireAutomationActivity() {
                        assert.ok(pending.length < 3);
                        const reply = gate<string>(); pending.push(reply); return reply.promise;
                    },
                    async releaseAutomationActivity(id) {
                        assert.ok(liveLeases.has(id)); released.push(id);
                        if (id === 'old-release') await releaseOld.promise;
                        assert.ok(liveLeases.delete(id));
                    },
                },
                setError: (value) => { ui.error = value; }, setRunning: (value) => { ui.running = value; },
                setState: () => {}, setFlowInspection: (value) => { ui.inspection = value; },
                openCaptureRepository: async () => { repositories++; return {}; },
                openConsoleJournal: async () => assert.fail('No storage'),
                sample: async () => assert.fail('No manual sample'),
                serialCaptureBackend: () => backend, sshCaptureBackend: () => backend,
                sshConsoleBackend: () => assert.fail('No console mode'),
            };
            const page = () => bindPage(ctx);
            const start = () => { const task = page().start(); tasks.push(task); return task; };
            const grant = (index: number, id: string) => {
                assert.equal(liveLeases.has(id), false); liveLeases.add(id); pending[index].resolve(id);
            };
            const blocked = async () => {
                await start();
                assert.equal(ui.error, 'Wait for the current clock reader admission.');
                assert.equal(pending.length, 1); assert.equal(repositories, 1);
                assert.equal(ctx.arming.current, false); assert.equal(ui.running, false);
                assert.equal(header.reservation.current, oldToken);
                for (const callback of timers.values()) callback();
                assert.equal(reads, 1);
            };
            let oldToken: symbol;
            try {
                await until(() => header.flight.current === null);
                start(); await until(() => pending.length === 1);
                oldToken = header.reservation.current; assert.ok(oldToken);
                page().cancel();
                assert.equal(ui.running, false); assert.equal(header.reservation.current, oldToken);
                if (outcome === 'held-release') {
                    grant(0, 'old-release'); await until(() => released.length === 1);
                    assert.ok(liveLeases.has('old-release'));
                }
                await blocked(); await blocked(); // Repeated denied Starts cannot steal the fence.
                if (outcome === 'held-release') releaseOld.resolve();
                else pending[0].reject(Error('Cancelled acquisition error must stay hidden'));
                await tasks[0]; await until(() => header.flight.current === null);
                assert.equal(header.reservation.current, null); assert.equal(reads, 2);
                assert.equal(ui.error, 'Wait for the current clock reader admission.');
                assert.equal(liveLeases.size, 0); assert.equal(runnerStarts, 0);
                start(); await until(() => pending.length === 2);
                const newToken = header.reservation.current;
                assert.ok(newToken && newToken !== oldToken); assert.equal(ui.error, '');
                assert.equal(ui.running, true); assert.equal(ctx.arming.current, true);
                resumes[0](); // A duplicate old-token completion cannot retire the current owner.
                assert.equal(header.reservation.current, newToken); assert.equal(reads, 2);
                page().cancel(); grant(1, 'new-cancelled-release'); await tasks.at(-1);
                await until(() => header.flight.current === null);
                assert.equal(header.reservation.current, null); assert.equal(reads, 3);
                assert.equal(runnerStarts, 0); assert.equal(liveLeases.size, 0);
                assert.equal(ui.running, false); assert.equal(ctx.arming.current, false);
            } finally {
                if (ctx.arming.current) page().cancel();
                if (!releaseOld.settled) releaseOld.resolve();
                pending.forEach((reply, index) => { if (!reply.settled) grant(index, `teardown-${index}`); });
                await Promise.all(tasks); await until(() => header.flight.current === null);
                owner.cleanup?.();
                assert.equal(header.reservation.current, null); assert.equal(liveLeases.size, 0);
                assert.equal(timers.size, 0); assert.equal(header.refresh.current, null);
            }
        });
