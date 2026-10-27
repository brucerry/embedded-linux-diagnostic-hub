import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from 'ssh2';

/** Real installed Windows/MSYS PTY, with a test-owned normal interactive HOME/.bashrc. */
export async function osPtyFixture() {
    if (process.platform !== 'win32') return null;
    const dll = 'C:/Program Files/Git/usr/bin/winpty.dll';
    const cygpath = 'C:/Program Files/Git/usr/bin/cygpath.exe';
    const pwsh =
        'C:/Users/bruce/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
    try {
        await fs.access(dll);
        await fs.access(pwsh);
        await fs.access(cygpath);
    } catch {
        return null;
    }
    const temp = path.resolve(os.tmpdir()),
        home = await fs.mkdtemp(path.join(temp, 'hub-real-pty-'));
    const converted = spawnSync(cygpath, ['-au', home], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 8192,
    });
    const homeUnix = converted.stdout?.trim();
    if (
        converted.status !== 0 ||
        converted.error ||
        !homeUnix?.startsWith('/') ||
        /[\r\n]/.test(homeUnix)
    ) {
        if (!home.startsWith(temp + path.sep) || !path.basename(home).startsWith('hub-real-pty-'))
            throw Error('Unsafe fixture cleanup.');
        await fs.rm(home, { recursive: true, force: true });
        throw Error(
            'Installed MSYS test HOME resolution failed: ' +
                String(converted.error ?? converted.stderr),
        );
    }
    await fs.writeFile(
        path.join(home, '.bashrc'),
        [
            "PS1='hub-pty:\\w#'",
            'HISTFILE=/dev/null',
            'alias ll=\'printf "REAL_NORMAL_ALIAS\\n"\'',
            "fixture_hi() { printf 'REAL_NORMAL_FUNCTION\\n'; }",
            "printf 'REAL_OS_INTERACTIVE_INIT\\n'",
            '',
        ].join('\n'),
    );
    const state = {
        opens: 0,
        closes: 0,
        inputs: [] as Buffer[],
        stderr: '',
        outputBytes: 0,
        outputTail: '',
        homeUnix,
        helperErrors: [] as string[],
    };
    const children = new Set<ChildProcessWithoutNullStreams>();
    const closed = new Set<Promise<void>>();
    const attachShell = (session: Session) => {
        session.on('pty', (accept) => accept?.());
        session.on('shell', (accept) => {
            const channel = accept();
            state.opens++;
            const child = spawn(
                pwsh,
                [
                    '-NoProfile',
                    '-File',
                    path.resolve('tests/fixtures/winpty-bridge.ps1'),
                    '-CommandLine',
                    '"C:/Program Files/Git/usr/bin/bash.exe" --noprofile -i',
                    '-WorkingDirectory',
                    home,
                    '-DeadlineMs',
                    '15000',
                ],
                {
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        HOME: homeUnix,
                        PATH:
                            'C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\bin;' +
                            process.env.PATH,
                    },
                },
            );
            children.add(child);
            channel.on('error', () => {});
            child.stdin.on('error', () => {});
            child.stdout.on('data', (bytes: Buffer) => {
                state.outputBytes += bytes.length;
                state.outputTail = (state.outputTail + bytes.toString()).slice(-4096);
                if (!channel.destroyed && !channel.write(bytes)) child.stdout.pause();
            });
            channel.on('drain', () => child.stdout.resume());
            channel.on('data', (bytes: Buffer) => {
                if (state.inputs.length >= 64) {
                    child.stdin.end();
                    channel.close();
                    return;
                }
                state.inputs.push(Buffer.from(bytes));
                if (!child.stdin.write(bytes)) channel.pause();
            });
            child.stdin.on('drain', () => channel.resume());
            channel.on('end', () => child.stdin.end());
            channel.on('close', () => child.stdin.end());
            child.stderr.on('data', (bytes: Buffer) => {
                state.stderr += bytes.toString();
                if (Buffer.byteLength(state.stderr) > 65536) {
                    state.helperErrors.push('Helper diagnostics exceeded bound.');
                    child.kill();
                }
            });
            const pending = new Promise<void>((resolve) => {
                child.once('error', (error) => {
                    state.helperErrors.push(error.message);
                    channel.close();
                });
                child.once('close', (code, signal) => {
                    children.delete(child);
                    state.closes++;
                    if (code !== 0) state.helperErrors.push('Helper ended ' + code + '/' + signal);
                    if (!channel.destroyed) {
                        if (code !== null) channel.exit(code);
                        channel.end();
                        channel.close();
                    }
                    resolve();
                });
            });
            closed.add(pending);
            void pending.finally(() => closed.delete(pending));
            channel.resume();
        });
    };
    return {
        attachShell,
        state,
        home,
        async settled() {
            await Promise.all([...closed]);
        },
        async close() {
            for (const child of children) child.stdin.end();
            const deadline = setTimeout(() => {
                for (const child of children) child.kill();
            }, 2000);
            try {
                await Promise.all([...closed]);
            } finally {
                clearTimeout(deadline);
            }
            assertOwned();
            await fs.rm(home, { recursive: true, force: true });
        },
    };
    function assertOwned() {
        if (!home.startsWith(temp + path.sep) || !path.basename(home).startsWith('hub-real-pty-'))
            throw Error('Unsafe fixture cleanup.');
    }
}
