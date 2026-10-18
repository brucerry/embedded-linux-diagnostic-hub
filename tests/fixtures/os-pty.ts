import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from 'ssh2';

/** Real installed Windows/MSYS PTY, with a test-owned normal interactive HOME/.bashrc. */
export async function osPtyFixture() {
    if (process.platform !== 'win32') return null;
    // Discover installed tools on the actual host. No personal cache paths or installation.
    const find = (name: string) => {
        const result = spawnSync('where.exe', [name], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 2000,
            maxBuffer: 8192,
        });
        if (result.error || result.status !== 0) return null;
        return (
            result.stdout
                .split(/\r?\n/)
                .find((file) => path.isAbsolute(file) && !/["\r\n]/.test(file)) ?? null
        );
    };
    const git = find('git.exe'),
        pwsh = find('pwsh.exe');
    if (!git || !pwsh) return null; // Explicit unsupported caller result; never mandatory native proof.
    const gitRoot = path.resolve(path.dirname(git), '..');
    const binary = path.join(gitRoot, 'usr', 'bin'),
        dll = path.join(binary, 'winpty.dll'),
        cygpath = path.join(binary, 'cygpath.exe'),
        bash = path.join(binary, 'bash.exe');
    try {
        for (const file of [git, pwsh, dll, cygpath, bash]) {
            const s = await fs.lstat(file);
            if (!s.isFile() || s.isSymbolicLink()) return null;
        }
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
                    '"' + bash + '" --noprofile -i',
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
                        HUB_TEST_WINPTY_DLL: dll,
                        PATH: binary + ';' + path.join(gitRoot, 'bin') + ';' + process.env.PATH,
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
