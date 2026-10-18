import { createOwnershipHold } from '../../scripts/lib/product-entry-custody.mjs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installedPtyIdentity, ptyBridgeArguments } from './winpty-identity';
import { finalPtyClosure } from './pty-closure';
import type { Session } from 'ssh2';

/** Real installed Windows/MSYS PTY, with a test-owned normal interactive HOME/.bashrc. */
export async function osPtyFixture(
    options: {
        homeParent?: string;
        expectedRuntime?: Record<string, { path: string; sha256: string }>;
        signal?: AbortSignal;
        holdUnknown?: (reason: unknown) => void;
        registerChild?: (child: ChildProcessWithoutNullStreams, stop: () => void) => void;
        check?: () => void;
    } = {},
) {
    if (process.platform !== 'win32') return null;
    let hold: unknown;
    const holdUnknown = (reason: unknown) => {
        if (options.holdUnknown) options.holdUnknown(reason);
        else
            hold ??= createOwnershipHold(
                { kind: 'real-pty-closure-unknown', reason: String(reason) },
                () => {},
            );
    };
    options.signal?.throwIfAborted();
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
    const roots = [path.resolve(path.dirname(git), '..'), path.resolve(path.dirname(git), '../..')];
    let gitRoot = roots[0];
    for (const candidate of roots)
        try {
            await fs.access(path.join(candidate, 'usr/bin/winpty.dll'));
            gitRoot = candidate;
            break;
        } catch {}
    const binary = path.join(gitRoot, 'usr', 'bin'),
        dll = path.join(binary, 'winpty.dll'),
        cygpath = path.join(binary, 'cygpath.exe'),
        bash = path.join(binary, 'bash.exe'),
        agent = path.join(binary, 'winpty-agent.exe');
    try {
        for (const file of [git, pwsh, dll, cygpath, bash, agent]) {
            const s = await fs.lstat(file);
            if (!s.isFile() || s.isSymbolicLink()) return null;
        }
    } catch {
        return null;
    }
    let toolIdentities;
    try {
        toolIdentities = Object.fromEntries(
            await Promise.all(
                Object.entries({ git, pwsh, dll, cygpath, bash, agent }).map(
                    async ([name, file]) => [name, await installedPtyIdentity(file)],
                ),
            ),
        );
    } catch {
        return null;
    }
    if (options.expectedRuntime)
        for (const [fixture, bound] of Object.entries({
            git: 'git',
            pwsh: 'powershell',
            bash: 'bash',
            cygpath: 'cygpath',
            dll: 'winptyDll',
            agent: 'winptyAgent',
        })) {
            const a = toolIdentities[fixture],
                b = options.expectedRuntime[bound];
            if (!b || a.path !== b.path || a.sha256 !== b.sha256)
                throw Error('PTY bound runtime changed: ' + fixture);
        }
    const bashExecutable = toolIdentities.bash.path;
    options.signal?.throwIfAborted();
    options.check?.();
    const temp = options.homeParent
            ? await fs.realpath(options.homeParent)
            : path.resolve(os.tmpdir()),
        home = await fs.mkdtemp(path.join(temp, 'hub-real-pty-'));
    const homeIdentity = await fs.lstat(home, { bigint: true });
    options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
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
        toolIdentities,
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
            options.signal?.throwIfAborted();
            options.check?.();
            const child = spawn(
                toolIdentities.pwsh.path,
                ptyBridgeArguments(
                    bashExecutable,
                    path.resolve('tests/fixtures/winpty-bridge.ps1'),
                    home,
                ),
                {
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        HOME: homeUnix,
                        HUB_TEST_WINPTY_DLL: toolIdentities.dll.path,
                        HUB_TEST_WINPTY_BASH: bashExecutable,
                        HUB_TEST_WINPTY_AGENT: toolIdentities.agent.path,
                        HUB_TEST_WINPTY_IDENTITIES: JSON.stringify(toolIdentities),
                        PATH: binary + ';' + path.join(gitRoot, 'bin') + ';' + process.env.PATH,
                    },
                },
            );
            options.registerChild?.(child, () => child.stdin.end());
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
            const stopShell = () => {
                child.stdin.end();
                child.stdout.resume();
            };
            channel.on('end', stopShell);
            channel.on('close', stopShell);
            child.stderr.on('data', (bytes: Buffer) => {
                if (Buffer.byteLength(state.stderr) + bytes.length > 65536) {
                    if (!state.helperErrors.includes('Helper diagnostics exceeded bound.'))
                        state.helperErrors.push('Helper diagnostics exceeded bound.');
                    child.stdin.end();
                    holdUnknown('PTY diagnostic output bound');
                } else state.stderr += bytes.toString();
            });
            const pending = new Promise<void>((resolve, reject) => {
                let actualExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
                child.once('exit', (code, signal) => (actualExit = { code, signal }));
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
                    try {
                        assertExit();
                        finalPtyClosure(state.stderr);
                        resolve();
                    } catch (e) {
                        holdUnknown(e);
                        reject(e);
                    }
                    function assertExit() {
                        if (!actualExit || actualExit.code !== code || actualExit.signal !== signal)
                            throw Error('PTY outer exit/pipe-close mismatch');
                    }
                });
            });
            closed.add(pending);
            void pending.then(
                () => closed.delete(pending),
                () => {},
            );
            channel.resume();
        });
    };
    options.signal?.addEventListener(
        'abort',
        () => {
            for (const child of children) child.stdin.end();
        },
        { once: true },
    );
    let closeTask: Promise<void> | undefined;
    return {
        attachShell,
        state,
        home,
        async settled() {
            await Promise.all([...closed]);
        },
        close() {
            return (closeTask ??= (async () => {
                for (const child of children) child.stdin.end();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        Promise.all([...closed]),
                        new Promise<never>(
                            (_, reject) =>
                                (timer = setTimeout(
                                    () => reject(Error('PTY cooperative closure unknown')),
                                    10000,
                                )),
                        ),
                    ]);
                } catch (e) {
                    holdUnknown(e);
                    throw e;
                } finally {
                    clearTimeout(timer);
                }
                if (state.opens > 0) finalPtyClosure(state.stderr);
                options.check?.();
                assertOwned();
                const current = await fs.lstat(home, { bigint: true });
                if (
                    current.dev !== homeIdentity.dev ||
                    current.ino !== homeIdentity.ino ||
                    (await fs.realpath(home)) !== home
                ) {
                    holdUnknown('PTY HOME replaced');
                    throw Error('PTY HOME replaced');
                }
                await fs.rm(home, { recursive: true, force: true });
            })());
        },
    };
    function assertOwned() {
        if (!home.startsWith(temp + path.sep) || !path.basename(home).startsWith('hub-real-pty-'))
            throw Error('Unsafe fixture cleanup.');
    }
}
