import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SshSession } from '../backend/ssh/session';
import { NativeConsoleJournal } from '../electron/console-journal';
import { FlowRunner, type FlowBackend, type FlowState } from '../src/features/automation/runner';
import { sshConsoleBackend } from '../src/features/automation/capture/console-backend';
import { validatePlan, type AutomationPlan, type AutomationRecord } from '../shared/automation';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
const ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# ', 'fixture:/# '] };
const plan = (): AutomationPlan => ({
    transport: 'ssh',
    ssh: { mode: 'console', ready, completion: ready },
    steps: [
        {
            id: 'cd',
            name: 'Change directory',
            enabled: true,
            command: 'cd /',
            delaySeconds: 0,
            ssh: { intent: 'script' },
        },
        {
            id: 'confirm',
            name: 'Wait for input',
            enabled: true,
            command: 'confirm-fixture',
            delaySeconds: 0,
            ssh: {
                intent: 'script',
                completion: {
                    role: 'intermediate-input-prompt',
                    literals: ['Proceed fixture [Enter]? '],
                },
            },
        },
        {
            id: 'enter1',
            name: 'First Enter',
            enabled: true,
            command: '',
            delaySeconds: 0,
            ssh: { intent: 'send-enter' },
        },
        {
            id: 'enter2',
            name: 'Second Enter',
            enabled: true,
            command: '',
            delaySeconds: 0,
            ssh: { intent: 'send-enter' },
        },
        {
            id: 'pwd',
            name: 'Read directory',
            enabled: true,
            command: 'pwd',
            delaySeconds: 0,
            ssh: { intent: 'script' },
        },
    ],
    timeoutSeconds: 3,
    repeatSeconds: 1,
    start: null,
    serial: { lineEnding: 'none', prompt: '', timestampPrefix: '' },
});
async function fixture(t: import('node:test').TestContext) {
    const model = consoleFixture(),
        server = await gatewayFixture(undefined, model),
        session = new SshSession(),
        profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-flow-')),
        store = await NativeConsoleJournal.open(profile, { profileOwned: true });
    t.after(async () => {
        session.disconnect();
        await server.close();
        await store.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-flow-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    await session.connect(server.options, async (key) => key === server.pinned);
    const transport = {
        automationConnection: () => session.automationConnection,
        automationConsole: (request: import('../shared/console-rpc').ConsoleRpcRequest) =>
            session.automationConsole(request, 'local-client', async () => store),
    };
    return { model, session, store, transport };
}
test(
    'whole-flow console keeps one shell across Script/Enter/Enter/Script and repeats, and joins storage cleanup',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t),
            states: FlowState[] = [],
            records: AutomationRecord[] = [];
        const runner = new FlowRunner(
            (state) => states.push(state),
            (record) => {
                records.push(record);
                assert.equal(record.exitCode, null);
                assert.equal(record.completion, 'prompt-observed');
                assert.ok(record.consoleCapture);
                if (records.length === 10) runner.stop();
            },
        );
        const backend = sshConsoleBackend(
            f.transport,
            'local-client',
            { endpoint: 'owned loopback' },
            () => f.session.isConnected,
        );
        const input = plan(),
            running = runner.start(input, backend);
        input.steps[0].command = 'wrong changed draft';
        await running;
        assert.equal(states.at(-1)!.state, 'finished');
        assert.equal(records.length, 10);
        assert.equal(new Set(records.map((r) => r.runId)).size, 2);
        assert.equal(f.model.state.opens, 1);
        assert.equal(f.model.state.closes, 1);
        assert.deepEqual(f.model.state.commands, [
            'cd /',
            'confirm-fixture',
            '',
            '',
            'pwd',
            'cd /',
            'confirm-fixture',
            '',
            '',
            'pwd',
        ]);
        assert.equal(f.session.consoleBusy, false);
        assert.equal(f.store.resourceClosed, true);
        assert.equal(runner.busy, false);
    },
);
test(
    'cancellation while the open reply is delayed still cancels the late owner and sends no command',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t);
        let release!: () => void, entered!: () => void;
        const held = new Promise<void>((r) => {
                release = r;
            }),
            started = new Promise<void>((r) => {
                entered = r;
            });
        const transport = {
            ...f.transport,
            automationConsole: async (
                request: import('../shared/console-rpc').ConsoleRpcRequest,
            ) => {
                const reply = await f.transport.automationConsole(request);
                if (request.action === 'open') {
                    entered();
                    await held;
                }
                return reply;
            },
        };
        const states: FlowState[] = [],
            runner = new FlowRunner(
                (state) => states.push(state),
                () => assert.fail('Cancelled readiness cannot produce an outcome'),
            );
        const input = plan();
        input.repeatSeconds = null;
        const running = runner.start(
            input,
            sshConsoleBackend(
                transport,
                'local-client',
                { endpoint: 'owned loopback' },
                () => f.session.isConnected,
            ),
        );
        await started;
        runner.cancel();
        release();
        await running;
        assert.equal(states.at(-1)!.state, 'paused');
        assert.deepEqual(f.model.state.inputs, []);
        assert.equal(f.session.consoleBusy, false);
        assert.equal(f.store.resourceClosed, true);
        assert.equal(runner.cleanupPending, false);
    },
);
function independent(): AutomationPlan {
    const input = plan();
    delete input.ssh;
    input.steps = [{ id: 'one', name: 'One', enabled: true, command: 'pwd', delaySeconds: 0 }];
    input.repeatSeconds = null;
    return input;
}
function backend(overrides: Partial<FlowBackend> = {}): FlowBackend {
    return {
        target: { endpoint: 'fixture' },
        connection: () => 'connection',
        available: () => true,
        acquire: () => () => {},
        execute: async () => ({
            stdout: '',
            stderr: '',
            completion: 'exit',
            exitCode: 0,
            truncated: false,
            chunks: [],
        }),
        ...overrides,
    };
}
test('failed cleanup retains the lease and refuses a new arm until one acknowledged explicit retry', async () => {
    let releases = 0,
        closes = 0;
    const states: FlowState[] = [],
        runner = new FlowRunner(
            (state) => states.push(state),
            () => {},
        ),
        adapter = backend({
            acquire: () => () => {
                releases++;
            },
            finishFlow: async () => {
                if (++closes === 1) throw Error('Actual close unacknowledged');
            },
        });
    await runner.start(independent(), adapter);
    assert.equal(runner.cleanupPending, true);
    assert.equal(runner.busy, true);
    assert.equal(releases, 0);
    assert.equal(states.at(-1)!.cleanupPending, true);
    assert.ok(states.every((state) => state.state !== 'finished'));
    assert.throws(() => runner.start(independent(), adapter), /awaiting cleanup/);
    await Promise.all([runner.retryCleanup(), runner.retryCleanup()]);
    assert.equal(closes, 2);
    assert.equal(releases, 1);
    assert.equal(runner.busy, false);
    assert.equal(runner.cleanupPending, false);
});

test('finished is emitted only after actual flow close and lease release', async () => {
    let close!: () => void,
        entered!: () => void,
        releases = 0;
    const held = new Promise<void>((resolve) => {
        close = resolve;
    });
    const closing = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const states: (FlowState & { leaseReleased: boolean; busy: boolean })[] = [];
    const runner = new FlowRunner(
        (state) => {
            states.push({ ...state, leaseReleased: releases === 1, busy: runner.busy });
        },
        () => {},
    );
    const task = runner.start(
        independent(),
        backend({
            acquire: () => () => {
                releases++;
            },
            finishFlow: async () => {
                entered();
                await held;
            },
        }),
    );
    await closing;
    try {
        assert.equal(runner.busy, true);
        assert.equal(releases, 0);
        assert.ok(
            states.every((state) => state.state !== 'finished'),
            'Finished was published before actual close',
        );
        assert.equal(states.at(-1)!.state, 'running');
    } finally {
        close();
        await task;
    }
    assert.equal(states.at(-1)!.state, 'finished');
    assert.equal(states.at(-1)!.leaseReleased, true);
    assert.equal(states.at(-1)!.busy, false);
});
test('a closed incomplete capture is a storage failure without fabricating pending resource ownership', async () => {
    let releases = 0;
    const states: FlowState[] = [],
        runner = new FlowRunner(
            (state) => states.push(state),
            () => {},
        );
    await runner.start(
        independent(),
        backend({
            acquire: () => () => {
                releases++;
            },
            finishFlow: async () => ({ failure: 'Console capture incomplete (io).' }),
        }),
    );
    assert.equal(states.at(-1)!.state, 'paused');
    assert.match(states.at(-1)!.message, /capture incomplete/);
    assert.equal(runner.cleanupPending, false);
    assert.equal(runner.busy, false);
    assert.equal(releases, 1);
});
test('asynchronous preparation preserves the original freshness baseline and never dispatches after a stall', async () => {
    let mono = 0,
        executions = 0,
        finishes = 0;
    const states: FlowState[] = [],
        runner = new FlowRunner(
            (state) => states.push(state),
            () => {},
            { local: () => mono, mono: () => mono, sleep: async () => {} },
        );
    await runner.start(
        independent(),
        backend({
            prepare: async () => {
                mono += 3000;
            },
            execute: async () => {
                executions++;
                throw Error('must not run');
            },
            finishFlow: async (reason) => {
                assert.equal(reason, 'cancelled');
                finishes++;
            },
        }),
    );
    assert.equal(executions, 0);
    assert.equal(finishes, 1);
    assert.equal(states.at(-1)!.state, 'paused');
    assert.match(states.at(-1)!.message, /slept|stalled/);
});
test('legacy disabled blank scripts stay compatible; console input intent and criteria remain explicit', () => {
    const legacy = independent();
    legacy.steps.push({
        id: 'disabled',
        name: 'Disabled',
        enabled: false,
        command: '',
        delaySeconds: 0,
    });
    assert.equal(validatePlan(legacy).ssh, undefined);
    const invalid = plan();
    delete invalid.steps[0].ssh;
    assert.throws(() => validatePlan(invalid), /explicit Script/);
    const blank = plan();
    blank.steps[0].command = '';
    assert.throws(() => validatePlan(blank), /Script requires/);
    const enter = plan();
    enter.steps[0].ssh = { intent: 'send-enter' };
    enter.steps[0].command = '';
    assert.equal(validatePlan(enter).steps[0].ssh!.intent, 'send-enter');
});
