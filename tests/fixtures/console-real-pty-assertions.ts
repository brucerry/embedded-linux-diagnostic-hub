import { createOwnershipHold } from '../../scripts/lib/product-entry-custody.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { osPtyFixture } from './os-pty';
import { gatewayFixture } from './gateway';
import { SshSession } from '../../backend/ssh/session';
import type { PersistentSshConsole } from '../../backend/ssh/persistent-console';
import { NativeConsoleJournal } from '../../electron/console-journal';
import { bytesBase64 } from '../../shared/capture-store';
import type { ConsoleSegment } from '../../shared/console-journal';

export async function exerciseRealPtyAssertions(
    options: Parameters<typeof osPtyFixture>[0] & {
        journalParent?: string;
        requireNative?: boolean;
        skip?: (reason: string) => void;
        diagnostic?: (value: string) => void;
    } = {},
) {
    let held: unknown;
    const holdUnknown =
        options.holdUnknown ??
        ((reason: unknown) => {
            held ??= createOwnershipHold(
                { kind: 'pty-assertions-custody-unknown', reason: String(reason) },
                () => {},
            );
        });
    options = { ...options, holdUnknown };
    options.signal?.throwIfAborted();
    const pty = await osPtyFixture(options).catch((e) => {
        holdUnknown(e);
        throw e;
    });
    if (!pty) {
        if (options.requireNative) throw Error('Installed Windows/MSYS PTY runtime unavailable');
        options.skip?.('Installed Windows/MSYS PTY runtime unavailable; no install.');
        return;
    }
    const session = new SshSession(),
        temp = options.journalParent ?? path.resolve(os.tmpdir());
    let server: Awaited<ReturnType<typeof gatewayFixture>> | undefined,
        store: NativeConsoleJournal | undefined,
        profile: string | undefined,
        profileIdentity: import('node:fs').BigIntStats | undefined;
    let actor: PersistentSshConsole | undefined;
    const cleanup = async () => {
        const errors: unknown[] = [];
        for (const close of [
            () => actor?.cancel(),
            () => session.disconnect(),
            () => pty.close(),
            () => server?.close(),
            () => store?.close(),
        ])
            try {
                await close();
            } catch (e) {
                errors.push(e);
            }
        if (errors.length) {
            const error = new AggregateError(errors, 'PTY/journal cleanup closure unknown');
            options.holdUnknown?.(error);
            throw error;
        }
        options.diagnostic?.(
            JSON.stringify({
                scope: 'Actual installed Windows/MSYS Bash + winpty OS PTY through SSH; not Linux/ash/DUT',
                ...pty.state,
                inputs: pty.state.inputs.map((b) => b.toString('base64')),
            }),
        );
        if (!profile) return;
        if (!profileIdentity) {
            holdUnknown('PTY journal identity unknown');
            throw Error('PTY journal identity unknown');
        }
        assert.ok(
            profile.startsWith(temp + path.sep) &&
                path.basename(profile).startsWith('hub-pty-journal-'),
        );
        const current = await fs.lstat(profile, { bigint: true });
        assert.equal(current.dev, profileIdentity.dev);
        assert.equal(current.ino, profileIdentity.ino);
        assert.equal(await fs.realpath(profile), profile);
        options.check?.();
        await fs.rm(profile, { recursive: true, force: true });
    };
    const abort = () => {
        void actor?.cancel().catch(options.holdUnknown ?? (() => {}));
        session.disconnect();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        const admit = () => {
            options.signal?.throwIfAborted();
            options.check?.();
        };
        admit();
        server = await gatewayFixture(undefined, { attachShell: pty.attachShell }).catch((e) => {
            holdUnknown(e);
            throw e;
        });
        admit();
        profile = await fs.mkdtemp(path.join(temp, 'hub-pty-journal-'));
        profileIdentity = await fs.lstat(profile, { bigint: true });
        admit();
        store = await NativeConsoleJournal.open(profile, { profileOwned: true }).catch((e) => {
            holdUnknown(e);
            throw e;
        });
        admit();
        await session.connect(
            { ...server.options, auth: 'password' },
            async (key) => key === server!.pinned,
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
    } finally {
        options.signal?.removeEventListener('abort', abort);
        await cleanup();
    }
}
