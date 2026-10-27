import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FlowRunner, type RunClock, type FlowState } from '../src/features/automation/runner';
import { SerialSession } from '../src/features/serial/session';
import { serialCaptureBackend } from '../src/features/automation/capture/serial-backend';
import { NativeCaptureStore } from '../electron/capture-store';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';
import type { AutomationPlan, AutomationRecord } from '../shared/automation';
import { deferred, until } from './fixtures/serial-capture';

const encode = (text: string) => new TextEncoder().encode(text);
const plan = (commands = ['first', 'second']): AutomationPlan => ({
    transport: 'serial',
    start: null,
    timeoutSeconds: 1,
    repeatSeconds: null,
    captureDeviceTime: true,
    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: 'CLOCK=' },
    steps: commands.map((command, index) => ({
        id: 'step-' + index,
        name: command,
        command,
        enabled: true,
        delaySeconds: 0,
    })),
});

for (const mode of [
    'healthy ticks',
    'resume before watchdog',
    'watchdog during persistence',
] as const)
    test('result persistence retains the runner watchdog: ' + mode, async () => {
        const commit = deferred(),
            entered = deferred();
        let local = Date.UTC(2026, 9, 15),
            mono = 0,
            watch: (() => void) | undefined,
            calls = 0,
            releases = 0;
        const clock: RunClock = {
            local: () => local,
            mono: () => mono,
            sleep: async (ms, signal) => {
                local += ms;
                mono += ms;
                watch?.();
                if (signal.aborted) throw Error('Cancelled.');
            },
            watch(callback) {
                watch = callback;
                return () => {
                    watch = undefined;
                };
            },
        };
        const states: FlowState[] = [],
            runner = new FlowRunner(
                (state) => states.push(state),
                async () => {
                    if (calls === 1) {
                        entered.resolve();
                        await commit.promise;
                    }
                },
                clock,
            );
        const pending = runner.start(plan(), {
            connection: () => 'same',
            available: () => true,
            acquire: () => () => {
                releases++;
            },
            target: { endpoint: 'synthetic' },
            execute: async () => {
                calls++;
                return {
                    stdout: '',
                    stderr: '',
                    exitCode: null,
                    completion: 'prompt-observed',
                    truncated: false,
                    chunks: [],
                };
            },
        });
        await entered.promise;
        if (mode === 'healthy ticks')
            for (let tick = 0; tick < 40; tick++) {
                local += 250;
                mono += 250;
                watch?.();
            }
        else {
            local += 10000;
            mono += 10000;
            if (mode === 'watchdog during persistence') {
                watch?.();
                local += 250;
                mono += 250;
                watch?.();
            }
        }
        assert.equal(releases, 0);
        assert.equal(runner.busy, true);
        commit.resolve();
        await pending;
        assert.equal(calls, mode === 'healthy ticks' ? 2 : 1);
        assert.equal(states.at(-1)!.state, mode === 'healthy ticks' ? 'finished' : 'paused');
        if (mode !== 'healthy ticks') assert.match(states.at(-1)!.message, /timer stalled|slept/);
        assert.equal(releases, 1);
        assert.equal(watch, undefined);
    });

async function fixture(
    t: TestContext,
    consume: (bytes: Uint8Array, generation: number) => Promise<void> = async () => {},
) {
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-serial-reviewed-')),
        store = await NativeCaptureStore.open(profile, { profileOwned: true });
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const writes: Uint8Array[] = [],
        port: LocalSerialPort = {
            readable: null,
            writable: null,
            async open() {
                this.readable = new ReadableStream({
                    start(controller) {
                        input = controller;
                    },
                });
                this.writable = new WritableStream({
                    write(bytes) {
                        writes.push(Uint8Array.from(bytes));
                    },
                });
            },
            async close() {
                this.readable = null;
                this.writable = null;
            },
            getInfo: () => ({}),
        };
    const session = new SerialSession(consume);
    session.select(port, 'synthetic reviewed UART');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    t.after(async () => {
        await session.close();
        await store.close();
        assert.ok(
            path.resolve(profile).startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-serial-reviewed-'),
        );
        await fs.rm(profile, { recursive: true, force: true });
    });
    return {
        store,
        session,
        writes,
        push: (bytes: Uint8Array) => input.enqueue(Uint8Array.from(bytes)),
    };
}

test('prompt completion waits for terminal delivery and queued continuation before another Serial command can start', async (t) => {
    const display = deferred();
    let deliveries = 0;
    const f = await fixture(t, async () => {
        if (++deliveries === 1) await display.promise;
    });
    const rows: AutomationRecord[] = [],
        runner = new FlowRunner(
            () => {},
            (row) => {
                rows.push(row);
            },
        ),
        p = plan();
    p.timeoutSeconds = 3;
    const pending = runner.start(p, serialCaptureBackend(f.session, f.store));
    try {
        await until(() => f.writes.length === 1);
        f.push(encode('FIRST\r\nboard# '));
        f.push(encode('OLD-CONTINUATION\r\nboard# '));
        await until(() => deliveries === 1);
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(f.writes.length, 1);
        assert.equal(rows.length, 0);
        display.resolve();
        await until(() => f.writes.length === 2);
        assert.equal(rows.length, 1);
        assert.match(rows[0].stdout, /OLD-CONTINUATION/);
        f.push(encode('NEW-RESPONSE\r\nboard# '));
        await pending;
        assert.equal(rows.length, 2);
        assert.equal(rows[1].stdout, 'NEW-RESPONSE\r\nboard# ');
        for (const row of rows) assert.equal(row.completion, 'prompt-observed');
    } finally {
        display.resolve();
        runner.cancel();
        await pending;
    }
});

test('Cancel cannot re-arm Serial while an earlier terminal delivery is still pending', async (t) => {
    const display = deferred();
    let entered = false,
        delivered = false;
    const f = await fixture(t, async () => {
            entered = true;
            await display.promise;
            delivered = true;
        }),
        runner = new FlowRunner(
            () => {},
            () => {},
        ),
        pending = runner.start(plan(['first']), serialCaptureBackend(f.session, f.store));
    try {
        await until(() => f.writes.length === 1);
        f.push(encode('FIRST\r\nboard# '));
        await until(() => entered);
        runner.cancel();
        await pending;
        assert.throws(() => f.session.acquireAutomation(), /pending/);
        display.resolve();
        await until(() => delivered);
        let release: (() => void) | undefined;
        await until(() => {
            try {
                release = f.session.acquireAutomation();
                return true;
            } catch {
                return false;
            }
        });
        release!();
        assert.equal(f.writes.length, 1);
    } finally {
        display.resolve();
        runner.cancel();
        await pending;
    }
});

for (const scenario of [
    'timeout tail',
    'cancel tail',
    'preserve complete on timeout',
    'preserve complete on cancel',
    'split UTF-8 tail',
    'terminated split UTF-8',
    'invalid suffix',
    'incomplete UTF-8 suffix',
] as const)
    test('Serial device time requires a terminated logical line: ' + scenario, async (t) => {
        let deliveries = 0;
        const f = await fixture(t, async () => {
                deliveries++;
            }),
            rows: AutomationRecord[] = [],
            runner = new FlowRunner(
                () => {},
                (row) => {
                    rows.push(row);
                },
            ),
            p = plan(['clock']);
        const split = scenario.includes('UTF-8');
        if (split) p.serial.timestampPrefix = '\u23f1=';
        const pending = runner.start(p, serialCaptureBackend(f.session, f.store));
        await until(() => f.writes.length === 1);
        const prior = 'CLOCK=2026-10-15T05:00:00.000Z\r\n',
            tail = p.serial.timestampPrefix + '2026-10-15T05:00:01.000Z';
        if (scenario.startsWith('preserve')) f.push(encode(prior));
        if (scenario === 'incomplete UTF-8 suffix') {
            f.push(new Uint8Array([...encode(tail), 0xe2]));
        } else if (split) {
            const bytes = encode(tail);
            f.push(bytes.subarray(0, 1));
            f.push(bytes.subarray(1));
        } else f.push(encode(tail));
        if (scenario === 'terminated split UTF-8') f.push(encode('\nboard# '));
        if (scenario === 'invalid suffix') f.push(encode('invalid-suffix\nboard# '));
        if (scenario.includes('cancel')) {
            await until(() => deliveries >= 1);
            runner.cancel();
        }
        await pending;
        assert.equal(rows.length, 1);
        const expected = scenario.startsWith('preserve')
            ? '2026-10-15T05:00:00.000Z'
            : scenario === 'terminated split UTF-8'
              ? '2026-10-15T05:00:01.000Z'
              : null;
        assert.equal(rows[0].deviceTime?.value ?? null, expected);
        assert.equal(
            rows[0].completion,
            scenario.includes('cancel')
                ? 'cancelled'
                : scenario === 'terminated split UTF-8' || scenario === 'invalid suffix'
                  ? 'prompt-observed'
                  : 'timeout',
        );
    });
