import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { osPtyFixture } from './fixtures/os-pty';
import { gatewayFixture } from './fixtures/gateway';
import { SshSession } from '../backend/ssh/session';
import type { PersistentSshConsole } from '../backend/ssh/persistent-console';
import { NativeConsoleJournal } from '../electron/console-journal';
import { bytesBase64 } from '../shared/capture-store';
import type { ConsoleSegment } from '../shared/console-journal';

test(
    'existing real Bash/winpty OS PTY through pinned loopback SSH preserves normal aliases, cwd and explicit Enter',
    { timeout: 25000 },
    async (t) => {
        const pty = await osPtyFixture();
        if (!pty) {
            t.skip('Installed Windows/MSYS PTY runtime unavailable; no install.');
            return;
        }
        const server = await gatewayFixture(undefined, { attachShell: pty.attachShell }),
            session = new SshSession();
        const temp = path.resolve(os.tmpdir()),
            profile = await fs.mkdtemp(path.join(temp, 'hub-pty-journal-'));
        const store = await NativeConsoleJournal.open(profile, { profileOwned: true });
        let actor: PersistentSshConsole | undefined;
        t.after(async () => {
            await actor?.cancel().catch(() => {});
            session.disconnect();
            await pty.close();
            await server.close();
            await store.close();
            t.diagnostic(
                JSON.stringify({
                    scope: 'Actual installed Windows/MSYS Bash + winpty OS PTY through SSH; not Linux/ash/DUT',
                    ...pty.state,
                    inputs: pty.state.inputs.map((b) => b.toString('base64')),
                }),
            );
            assert.ok(
                profile.startsWith(temp + path.sep) &&
                    path.basename(profile).startsWith('hub-pty-journal-'),
            );
            await fs.rm(profile, { recursive: true, force: true });
        });
        await session.connect(
            { ...server.options, auth: 'password' },
            async (key) => key === server.pinned,
        );
        const bound = session.createAutomationConsole(
            store,
            session.automationConnection,
            () => {},
        );
        actor = bound.actor;
        await actor.open(
            {
                flowId: 'real-os-pty',
                startedAt: new Date().toISOString(),
                receiveTimeSource: 'local-client',
                target: bound.target,
                ready: { role: 'shell-prompt', literals: ['hub-pty:~#'] },
            },
            bound.signal,
            7000,
        );
        assert.equal(session.consoleBusy, true);
        await assert.rejects(session.collect(), /paused for automation/);
        await assert.rejects(
            session.runAutomation({
                id: crypto.randomUUID().replaceAll('-', ''),
                connection: session.automationConnection,
                command: 'pwd',
                timeoutMs: 1000,
            }),
            /Wait for/,
        );
        await assert.rejects(
            session.openTerminal(
                { id: crypto.randomUUID().replaceAll('-', ''), cols: 120, rows: 40 },
                () => {},
            ),
            /owned Automation console/,
        );
        const step = (
            command: string,
            ordinal: number,
            literal = 'hub-pty:/#',
            enter = false,
            role: 'shell-prompt' | 'intermediate-input-prompt' = 'shell-prompt',
        ): Extract<ConsoleSegment, { kind: 'command' }> => ({
            kind: 'command',
            runId: 'real-pty-run',
            stepId: 'step-' + ordinal,
            ordinal,
            name: 'Step ' + ordinal,
            input: { intent: enter ? 'send-enter' : 'script', command },
            requestBase64: bytesBase64(Buffer.from(enter ? '\r' : command + '\r')),
            criterion: { role, literals: [literal] },
        });
        await actor.step(step('cd /', 1), 3000);
        await actor.step(step('pwd', 2), 3000);
        await actor.step(step('ll', 3), 3000);
        await actor.step(step('fixture_hi', 4), 3000);
        await actor.step(
            step(
                "read -p 'OS_CONFIRM [Enter]?'; printf 'REAL_CONFIRMED\\n'",
                5,
                'OS_CONFIRM [Enter]?',
                false,
                'intermediate-input-prompt',
            ),
            3000,
        );
        assert.equal(pty.state.inputs.length, 5);
        await actor.step(step('', 6, 'hub-pty:/#', true), 3000);
        await actor.step(step('', 7, 'hub-pty:/#', true), 3000);
        await actor.step(step('pwd', 8), 3000);
        const capture = await actor.finish();
        assert.equal(capture?.state, 'complete');
        assert.equal(session.consoleBusy, false);
        await pty.settled();
        assert.equal(pty.state.opens, 1);
        assert.equal(pty.state.closes, 1);
        assert.deepEqual(pty.state.helperErrors, []);
        assert.match(pty.state.stderr, /HUB_OS_PTY_CLOSE .*"outputDrained":true/);
        const reader = await NativeConsoleJournal.open(profile, { profileOwned: true });
        let text = '',
            outcomes = 0;
        try {
            for await (const item of reader.read(capture!.header.id))
                if (item.kind === 'record') {
                    if (item.record.kind === 'observation')
                        text += Buffer.from(item.record.base64, 'base64').toString();
                    if (item.record.kind === 'outcome') {
                        outcomes++;
                        assert.equal(item.record.exitCode, null);
                    }
                }
        } finally {
            await reader.close();
        }
        assert.match(text, /REAL_NORMAL_ALIAS/);
        assert.match(text, /REAL_NORMAL_FUNCTION/);
        assert.match(text, /REAL_CONFIRMED/);
        assert.equal(outcomes, 8);
        assert.equal(
            Buffer.concat(pty.state.inputs).toString(),
            "cd /\rpwd\rll\rfixture_hi\rread -p 'OS_CONFIRM [Enter]?'; printf 'REAL_CONFIRMED\\n'\r\r\rpwd\r",
        );
    },
);
