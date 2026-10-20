import { createOwnershipHold } from '../../scripts/lib/product-entry-custody.mjs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    preparePtyBridge,
    verifyPreparedPtyBridge,
    verifyPreparedPtyBridgeSync,
    ptyLoadObservation,
    verifyPtyProcessBirth,
} from '../../scripts/lib/pty-bridge-preparation.mjs';
import { installedPtyIdentity, ptyBridgeArguments } from './winpty-identity';
import { finalPtyClosure } from './pty-closure';
import { ptyTerminalObservation, ptyCompileObservation } from './pty-terminal-observation.mjs';
import type { Session } from 'ssh2';

/** Real installed Windows/MSYS PTY, with a test-owned normal interactive HOME/.bashrc. */
export async function osPtyFixture(
    options: {
        homeParent?: string;
        timeline?: any;
        bridgePreparation?: {
            deadline: number;
            cleanupDeadline: number;
            startup: any;
            context: { sourceSHA256: string; bindingSHA256: string; nonce: string; root: string };
            cancel: (reason: unknown) => void;
            emit: (stage: string, data: any) => Promise<void>;
        };
        maxOpenings?: 1;
        expectedRuntime?: Record<string, { path: string; sha256: string }>;
        signal?: AbortSignal;
        holdUnknown?: (reason: unknown) => void;
        registerChild?: (child: ChildProcessWithoutNullStreams, stop: () => void) => void;
        check?: () => void;
        diagnostic?: (value: string) => void;
        terminalDiagnostic?: (value: unknown) => Promise<void> | void;
        ownedChildIdentity?: (
            child: ChildProcessWithoutNullStreams,
        ) => { created: string } | undefined;
    } = {},
) {
    if (process.platform !== 'win32') return null;
    if (
        options.bridgePreparation &&
        (!options.signal || !options.terminalDiagnostic || !options.registerChild)
    )
        throw Error(
            'Owned prepared PTY requires cancellation, child custody and durable load evidence',
        );
    let hold: unknown;
    const holdUnknown = (reason: unknown) => {
        if (options.holdUnknown) options.holdUnknown(reason);
        else
            hold ??= createOwnershipHold(
                { kind: 'real-pty-closure-unknown', reason: String(reason) },
                () => {},
            );
    };
    const timing = (phase: string, extra: Record<string, unknown> = {}) => {
        if (!options.diagnostic) return;
        try {
            options.diagnostic(
                JSON.stringify({
                    schema: 1,
                    kind: 'pty-timing',
                    phase,
                    clockDomain: 'node-performance',
                    monoMs: performance.now(),
                    pid: process.pid,
                    ...extra,
                }),
            );
        } catch (error) {
            holdUnknown(error);
        }
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
    const discoveryPhase = options.timeline?.begin('tool-discovery');
    const git = find('git.exe'),
        pwsh = find('pwsh.exe');
    options.timeline?.end(discoveryPhase);
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
    const identityPhase = options.timeline?.begin('tool-identities');
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
    options.timeline?.end(identityPhase);
    const homePhase = options.timeline?.begin('home');
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
    const helperEnvironment = {
        ...process.env,
        HOME: homeUnix,
        HUB_TEST_WINPTY_DLL: toolIdentities.dll.path,
        HUB_TEST_WINPTY_BASH: bashExecutable,
        HUB_TEST_WINPTY_AGENT: toolIdentities.agent.path,
        HUB_TEST_WINPTY_IDENTITIES: JSON.stringify(toolIdentities),
        PATH: binary + ';' + path.join(gitRoot, 'bin') + ';' + process.env.PATH,
    };
    options.timeline?.end(homePhase);
    let prepared: Awaited<ReturnType<typeof preparePtyBridge>> | undefined;
    if (options.bridgePreparation) {
        const compilerPhase = options.timeline?.begin('compiler');
        const scope = options.bridgePreparation;
        const compileTemp = path.join(home, 'compiler-temp');
        await fs.mkdir(compileTemp);
        prepared = await preparePtyBridge({
            ...scope,
            timeline: options.timeline,
            signal: options.signal!,
            hold: holdUnknown,
            check: () => {
                options.signal?.throwIfAborted();
                options.check?.();
            },
            executable: toolIdentities.pwsh.path,
            expectedCompiler: toolIdentities.pwsh,
            args: [
                ...ptyBridgeArguments(
                    bashExecutable,
                    path.resolve('tests/fixtures/winpty-bridge.ps1'),
                    home,
                ),
                '-CompileOnly',
                '-AssemblyOutput',
                path.join(home, 'winpty-bridge.dll'),
            ],
            env: { ...helperEnvironment, TMP: compileTemp, TEMP: compileTemp },
            compileTemp,
            artifactPath: path.join(home, 'winpty-bridge.dll'),
            inputs: [
                path.resolve('tests/fixtures/winpty-bridge.cs'),
                path.resolve('tests/fixtures/winpty-bridge.ps1'),
            ],
        });
        options.timeline?.end(compilerPhase);
    }
    if (options.diagnostic) {
        const source = [];
        for (const relative of [
            'tests/fixtures/winpty-bridge.ps1',
            'tests/fixtures/winpty-bridge.cs',
            'tests/fixtures/os-pty.ts',
            'tests/fixtures/console-real-pty-assertions.ts',
            'backend/ssh/persistent-console.ts',
            'backend/ssh/session.ts',
            'src/features/automation/serial-completion.ts',
        ]) {
            options.check?.();
            const bytes = await fs.readFile(path.resolve(relative));
            source.push({
                path: relative,
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            });
        }
        timing('fixture-preparation-complete', { source, toolIdentities });
    }
    let firstStdout = false;
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
    const children = new Map<ChildProcessWithoutNullStreams, () => void>();
    let compileObservations = 0;
    let loadObservations = 0;
    const preparedLoadTasks = new Set<Promise<unknown>>();
    const loadedConsumers = new Map<ChildProcessWithoutNullStreams, any>();
    let preparedEvidenceFailure: unknown;
    const terminalObservers = new Set<ReturnType<typeof ptyTerminalObservation>>();
    const closed = new Set<Promise<void>>();
    const attachShell = (session: Session) => {
        session.on('pty', (accept) => accept?.());
        session.on('shell', (accept) => {
            if (options.maxOpenings === 1 && state.opens !== 0) {
                const error = Error(
                    'PTY-only permits one helper invocation; repeated opening refused.',
                );
                holdUnknown(error);
                throw error;
            }
            const admit = () => {
                options.signal?.throwIfAborted();
                options.check?.();
                options.signal?.throwIfAborted();
                if (
                    options.bridgePreparation &&
                    Number(process.hrtime.bigint() / 1000000n) >= options.bridgePreparation.deadline
                )
                    throw Error('PTY preparation absolute deadline');
            };
            admit();
            if (prepared) {
                try {
                    verifyPreparedPtyBridgeSync(prepared);
                } catch (error) {
                    holdUnknown(error);
                    throw error;
                }
            }
            admit();
            const channel = accept();
            state.opens++;
            admit();
            const child = spawn(
                toolIdentities.pwsh.path,
                ptyBridgeArguments(
                    bashExecutable,
                    path.resolve('tests/fixtures/winpty-bridge.ps1'),
                    home,
                    prepared?.artifact.path,
                ),
                {
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: {
                        ...helperEnvironment,
                        ...(prepared
                            ? {
                                  HUB_TEST_WINPTY_ASSEMBLY: JSON.stringify(prepared.artifact),
                                  HUB_TEST_WINPTY_PREPARED_INPUTS: JSON.stringify(prepared.inputs),
                                  HUB_TEST_WINPTY_PREPARED: JSON.stringify(prepared),
                              }
                            : {}),
                    },
                },
            );
            let stopping = false,
                compileSeen = false;
            const terminal = options.terminalDiagnostic
                ? ptyTerminalObservation({
                      child,
                      channel,
                      identity: () => options.ownedChildIdentity?.(child),
                      stopping: () => stopping,
                      emit: options.terminalDiagnostic,
                      hold: holdUnknown,
                  })
                : undefined;
            if (terminal) terminalObservers.add(terminal);
            const stopShell = () => {
                const first = !stopping;
                const wasPaused = child.stdout.isPaused();
                stopping = true;
                // EOF requests and every later output callback share this terminal drain state.
                try {
                    child.stdin.end();
                } finally {
                    child.stdout.resume();
                }
                if (first) {
                    terminal?.event('stop-requested');
                    terminal?.snapshot('stop');
                }
                if (first)
                    timing('bridge-stop-drain', {
                        childPid: child.pid,
                        wasPaused,
                        stdoutPaused: child.stdout.isPaused(),
                        stdoutEnded: child.stdout.readableEnded,
                        stderrEnded: child.stderr.readableEnded,
                    });
            };
            options.registerChild?.(child, stopShell);
            options.diagnostic?.(JSON.stringify({ phase: 'pty-bridge-spawn', pid: child.pid }));
            children.set(child, stopShell);
            channel.on('error', () => {});
            child.stdin.on('error', () => {});
            child.stdout.on('data', (bytes: Buffer) => {
                if (!firstStdout) {
                    firstStdout = true;
                    timing('firststdout-observed', { childPid: child.pid, bytes: bytes.length });
                }
                state.outputBytes += bytes.length;
                state.outputTail = (state.outputTail + bytes.toString()).slice(-4096);
                if (stopping || channel.destroyed || channel.writableEnded) {
                    terminal?.event('stdout-data', {
                        bytes: bytes.length,
                        disposition: 'discarded',
                    });
                    return;
                }
                terminal?.event('stdout-data', {
                    bytes: bytes.length,
                    disposition: 'channel-write',
                });
                if (!channel.write(bytes)) {
                    child.stdout.pause();
                    terminal?.event('write-false');
                }
            });
            channel.on('drain', () => {
                terminal?.event('channel-drain');
                child.stdout.resume();
            });
            channel.on('data', (bytes: Buffer) => {
                if (stopping) {
                    terminal?.event('input-discard', { bytes: bytes.length });
                    return;
                }
                if (state.inputs.length >= 64) {
                    stopShell();
                    channel.close();
                    return;
                }
                state.inputs.push(Buffer.from(bytes));
                if (!child.stdin.write(bytes)) channel.pause();
            });
            child.stdin.on('drain', () => channel.resume());
            channel.on('end', () => {
                terminal?.event('channel-end');
                stopShell();
            });
            channel.on('close', () => {
                terminal?.event('channel-close');
                stopShell();
            });
            child.stderr.on('data', (bytes: Buffer) => {
                terminal?.event('stderr-data', { bytes: bytes.length });
                if (Buffer.byteLength(state.stderr) + bytes.length > 65536) {
                    if (!state.helperErrors.includes('Helper diagnostics exceeded bound.'))
                        state.helperErrors.push('Helper diagnostics exceeded bound.');
                    stopShell();
                    holdUnknown('PTY diagnostic output bound');
                } else {
                    state.stderr += bytes.toString();
                    if (options.terminalDiagnostic) {
                        try {
                            const fact = prepared
                                ? ptyLoadObservation(state.stderr, child.pid, prepared)
                                : ptyCompileObservation(state.stderr, child.pid);
                            if (fact && !compileSeen) {
                                compileSeen = true;
                                if (prepared) {
                                    loadObservations++;
                                    loadedConsumers.set(child, fact);
                                } else compileObservations++;
                                const task = Promise.resolve(
                                    options.terminalDiagnostic({
                                        ...fact,
                                        ownedRootIdentity:
                                            options.ownedChildIdentity?.(child) ?? null,
                                        authority:
                                            'Call observation only; no custody-release authority.',
                                    }),
                                );
                                if (prepared) preparedLoadTasks.add(task);
                                void task.catch((error) => {
                                    if (prepared) preparedEvidenceFailure ??= error;
                                    holdUnknown(error);
                                });
                            }
                        } catch (error) {
                            if (prepared) preparedEvidenceFailure ??= error;
                            holdUnknown(error);
                        }
                    }
                    for (let offset = 0; offset < bytes.length; offset += 4096)
                        options.diagnostic?.(
                            JSON.stringify({
                                phase: 'pty-bridge-stderr',
                                pid: child.pid,
                                base64: bytes.subarray(offset, offset + 4096).toString('base64'),
                            }),
                        );
                }
            });
            const pending = new Promise<void>((resolve, reject) => {
                let actualExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
                child.once('exit', (code, signal) => {
                    actualExit = { code, signal };
                    terminal?.event('process-exit');
                    terminal?.snapshot('exit', { code, signal });
                    options.diagnostic?.(
                        JSON.stringify({
                            phase: 'pty-bridge-exit',
                            pid: child.pid,
                            code,
                            signal,
                            stopRequested: stopping,
                            stdoutPaused: child.stdout.isPaused(),
                            stdoutEnded: child.stdout.readableEnded,
                            stderrEnded: child.stderr.readableEnded,
                        }),
                    );
                });
                child.once('error', (error) => {
                    state.helperErrors.push(error.message);
                    channel.close();
                });
                child.once('close', (code, signal) => {
                    children.delete(child);
                    terminal?.event('outer-close');
                    terminal?.snapshot('close', { code, signal });
                    options.diagnostic?.(
                        JSON.stringify({
                            phase: 'pty-bridge-pipe-close',
                            pid: child.pid,
                            code,
                            signal,
                        }),
                    );
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
            for (const [child, stop] of children) {
                options.diagnostic?.(
                    JSON.stringify({
                        phase: 'pty-cancel-request',
                        pid: child.pid,
                        stdinEOFRequested: true,
                        closureProven: false,
                    }),
                );
                stop();
            }
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
                for (const stop of children.values()) stop();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        (async () => {
                            await Promise.all([...closed]);
                            await Promise.all([...preparedLoadTasks]);
                            if (prepared)
                                for (const [consumer, receipt] of loadedConsumers) {
                                    const row =
                                        options.bridgePreparation!.startup.children.get(consumer);
                                    if (!row) throw Error('Prepared consumer is not owned');
                                    await row.identityTask;
                                    verifyPtyProcessBirth(
                                        consumer.pid,
                                        receipt.createdFileTime,
                                        row.identity,
                                    );
                                }
                        })(),
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
                    for (const terminal of terminalObservers) {
                        terminal.event(
                            String(e).includes('PTY cooperative closure unknown')
                                ? 'fixture-timeout'
                                : 'fixture-failure',
                        );
                        terminal.snapshot('final', {
                            outcome: 'unknown',
                            error: String(e).slice(0, 512),
                        });
                    }
                    throw e;
                } finally {
                    clearTimeout(timer);
                }
                for (const terminal of terminalObservers) {
                    terminal.event('fixture-join');
                    terminal.snapshot('final', { outcome: 'outer-close-observed' });
                }
                if (preparedEvidenceFailure) throw preparedEvidenceFailure;
                if (
                    (prepared && loadObservations !== state.opens) ||
                    (!prepared && options.terminalDiagnostic && compileObservations !== state.opens)
                ) {
                    const error = Error(
                        'Complete compile/load receipt missing; diagnostic evidence remains unknown.',
                    );
                    holdUnknown(error);
                    throw error;
                }
                if (state.opens > 0) finalPtyClosure(state.stderr);
                options.check?.();
                assertOwned();
                if (prepared) await verifyPreparedPtyBridge(prepared);
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
