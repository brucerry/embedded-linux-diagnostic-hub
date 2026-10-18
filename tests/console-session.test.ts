import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SshSession } from '../backend/ssh/session';
import { NativeConsoleJournal } from '../electron/console-journal';
import type { ConsoleRepository, ConsoleSegment } from '../shared/console-journal';
import { bytesBase64 } from '../shared/capture-store';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
const ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
const id = () => randomUUID().replaceAll('-', '');
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { resolve, promise };
}
async function fixture(t: import('node:test').TestContext) {
    const shell = consoleFixture(),
        server = await gatewayFixture(undefined, {
            attachShell: shell.attachShell,
            exec: shell.exec,
        });
    const session = new SshSession(),
        profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-console-session-'));
    const store = await NativeConsoleJournal.open(profile, { profileOwned: true });
    const actors: ReturnType<SshSession['createAutomationConsole']>[] = [];
    t.after(async () => {
        for (const bound of actors) await bound.actor.cancel().catch(() => {});
        session.disconnect();
        await server.close();
        await store.close();
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('hub-console-session-'));
        await fs.rm(profile, { recursive: true, force: true });
    });
    const connect = () =>
        session.connect(
            { ...server.options, auth: 'password' },
            async (key) => key === server.pinned,
        );
    await connect();
    const bind = (journal: ConsoleRepository = store, fresh = () => {}) => {
        const value = session.createAutomationConsole(journal, session.automationConnection, fresh);
        actors.push(value);
        return value;
    };
    const open = (bound: ReturnType<typeof bind>) =>
        bound.actor.open(
            {
                flowId: 'session-flow',
                startedAt: new Date().toISOString(),
                target: bound.target,
                receiveTimeSource: 'local-client',
                ready,
            },
            bound.signal,
            2500,
        );
    const command = (text: string): Extract<ConsoleSegment, { kind: 'command' }> => ({
        kind: 'command',
        runId: 'run',
        stepId: 'step',
        ordinal: 1,
        name: 'Fixture command',
        input: { intent: 'script', command: text },
        requestBase64: bytesBase64(Buffer.from(text + '\r')),
        criterion: ready,
    });
    const run = () =>
        session.runAutomation({
            id: id(),
            connection: session.automationConnection,
            command: 'pwd',
            timeoutMs: 1000,
        });
    return { session, store, shell, bind, open, command, connect, run };
}
test(
    'Session lease spans idle time and console finish leaves the separate Terminal usable',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            terminalId = id();
        await f.session.openTerminal({ id: terminalId, rows: 40, cols: 120 }, (event) => {
            if (event.type === 'data')
                f.session.getTerminal(terminalId).acknowledge(event.sequence);
        });
        const terminal = f.session.getTerminal(terminalId),
            bound = f.bind();
        await f.open(bound);
        assert.equal(f.session.consoleBusy, true);
        await assert.rejects(f.session.collect(), /paused for automation/);
        await assert.rejects(f.run(), /Wait for/);
        await assert.rejects(
            terminal.write(bytesBase64(Buffer.from('pwd\r'))),
            /paused during Automation/,
        );
        assert.equal(f.shell.state.opens, 2);
        const result = await bound.actor.step(f.command('pwd'), 2000);
        assert.equal(result.exitCode, null);
        assert.equal(result.completion, 'prompt-observed');
        await bound.actor.finish();
        assert.equal(f.session.consoleBusy, false);
        assert.equal(f.store.resourceClosed, true);
        assert.equal(f.session.getTerminal(terminalId), terminal);
        await terminal.write(bytesBase64(Buffer.from('pwd\r')));
        terminal.close();
    },
);
test(
    'disconnect/reconnect keeps the old lease until actual storage close and never sends stale input',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            closing = gate(),
            release = gate();
        const guarded = new Proxy(f.store, {
            get(target, key) {
                if (key === 'close')
                    return async () => {
                        closing.resolve();
                        await release.promise;
                        await target.close();
                    };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const bound = f.bind(guarded);
        await f.open(bound);
        const oldConnection = f.session.automationConnection;
        f.session.disconnect();
        await closing.promise;
        assert.equal(f.session.consoleBusy, true);
        await f.connect();
        assert.notEqual(f.session.automationConnection, oldConnection);
        await assert.rejects(f.run(), /Wait for/);
        await assert.rejects(bound.actor.step(f.command('pwd'), 1000), /unavailable|stopped/i);
        assert.deepEqual(f.shell.state.inputs, []);
        release.resolve();
        await bound.actor.close();
        assert.equal(f.session.consoleBusy, false);
        assert.equal(f.store.resourceClosed, true);
        const result = await f.run();
        assert.equal(result.completion, 'exit');
        assert.equal(result.exitCode, 0);
    },
);
test(
    'the original freshness callback is checked after durable preparation and before input',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t);
        let stale = false,
            checks = 0;
        const bound = f.bind(f.store, () => {
            checks++;
            if (stale) throw Error('Original arm is stale');
        });
        await f.open(bound);
        stale = true;
        await assert.rejects(bound.actor.step(f.command('pwd'), 2000), /Original arm is stale/);
        assert.ok(checks > 1);
        assert.deepEqual(f.shell.state.inputs, []);
        assert.equal(f.session.consoleBusy, false);
        assert.equal(f.store.resourceClosed, true);
    },
);
