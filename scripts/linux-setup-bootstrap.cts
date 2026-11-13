/** Fixed packaged download -> original-record/census validation -> prepared installer bridge.
 * This is unsigned selected-release integrity and ordinary user consent, never authentication
 * or lifecycle qualification. Portable AppRun and old review-only entry remain separate. */
import path from 'node:path';
import nativeFS, { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    planLinuxPermanentEnvelope,
    prepareLinuxPermanentEnvelope,
} from './lib/linux-setup-envelope';
import {
    createLinuxEnvelopeDisk,
    sameLinuxEnvelopeFileIdentity,
    checkedLinuxEnvelopeIdentity,
} from './lib/linux-setup-envelope-disk.mjs';
import {
    validateLinuxObservationRecords,
    normalizeLinuxPackagerCensus,
} from './lib/linux-release-observation';
import { observeLinuxGzipTar, linuxObservationWindow } from './lib/linux-archive-members.mjs';
import { linuxPermanentArguments } from '../electron/linux-permanent-setup';

const fs = {
    lstat: nativeFS.promises.lstat.bind(nativeFS.promises),
    realpath: nativeFS.promises.realpath.bind(nativeFS.promises),
    open: nativeFS.promises.open.bind(nativeFS.promises),
};
const now = performance.now.bind(performance);
const retained = new Set<object>();
const ownerStates = new WeakMap<
    object,
    {
        stage: string;
        failed: boolean;
        firstFailureSet: boolean;
        firstFailure?: unknown;
        handles: Set<import('node:fs/promises').FileHandle>;
        pending: Set<object>;
        originals: { release: Buffer | null; build: Buffer | null; census: unknown };
        envelope: unknown;
        envelopeComplete: boolean;
        mainPhase: 'not-entered' | 'publishing' | 'retired';
        postRetirementFailure?: { value: unknown };
        child: ReturnType<typeof spawn> | null;
        childSubmitted: boolean;
        stdout: Buffer[];
        stderr: Buffer[];
        stdoutBytes: number;
        stderrBytes: number;
        exitObserved: boolean;
        closeObserved: boolean;
        stdoutEOF: boolean;
        stderrEOF: boolean;
        diagnosticFailure?: { value: unknown };
        exitCode: number | null;
        signal: string | null;
        timer: ReturnType<typeof setTimeout> | null;
    }
>();
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const normal = (value: string) =>
    value.startsWith('/') &&
    value.length <= 240 &&
    value !== '/' &&
    path.posix.normalize(value) === value &&
    !/[\\\x00-\x1f\x7f]/.test(value);
const need = (yes: unknown, code: string) => {
    if (!yes) throw Error(code);
};
/** Closed arguments configure this fixed bridge; paths/flags do not confer operation authority. */
export function linuxSetupBootstrapArguments(
    args: string[],
): Readonly<Record<string, string | boolean>> {
    const value: Record<string, string | boolean> = {};
    const required = [
        'archive',
        'release-record',
        'build-record',
        'envelope-directory',
        'install-directory',
    ];
    for (let at = 0; at < args.length; at++) {
        const flag = args[at];
        need(typeof flag === 'string' && flag.startsWith('--'), 'LINUX_BOOTSTRAP_ARGUMENT');
        const name = flag.slice(2),
            key = name === 'no-menu' ? 'menu' : name;
        need(!Object.hasOwn(value, key), 'LINUX_BOOTSTRAP_ARGUMENT');
        if ([...required, 'version', 'operation'].includes(name)) {
            const selected = args[++at];
            need(
                typeof selected === 'string' &&
                    selected.length > 0 &&
                    selected.length <= 240 &&
                    !selected.startsWith('--'),
                'LINUX_BOOTSTRAP_ARGUMENT',
            );
            if (name === 'operation')
                need(
                    ['install', 'repair', 'update'].includes(selected),
                    'LINUX_BOOTSTRAP_ARGUMENT',
                );
            else if (name !== 'version') need(normal(selected), 'LINUX_BOOTSTRAP_ARGUMENT');
            value[key] = selected;
        } else {
            need(
                ['menu', 'no-menu', 'terminal', 'no-launch'].includes(name),
                'LINUX_BOOTSTRAP_ARGUMENT',
            );
            value[key] = name !== 'no-menu';
        }
    }
    need(
        required.every((name) => typeof value[name] === 'string'),
        'LINUX_BOOTSTRAP_ARGUMENT',
    );
    need(
        new Set(required.map((name) => value[name])).size === required.length,
        'LINUX_BOOTSTRAP_ARGUMENT',
    );
    return Object.freeze({ operation: 'install', ...value });
}
/** Finite private-custody summary only. Raw records, paths, handles and first failure stay private. */
export function linuxSetupBootstrapDiagnostics(owner: object) {
    const s = ownerStates.get(owner);
    need(s, 'LINUX_BOOTSTRAP_OWNER');
    const closed = s!.exitObserved && s!.closeObserved && s!.stdoutEOF && s!.stderrEOF;
    const retainedUnknown =
        s!.failed &&
        (s!.handles.size > 0 ||
            s!.pending.size > 0 ||
            (s!.envelope !== null && !s!.envelopeComplete) ||
            (s!.childSubmitted && !closed));
    return Object.freeze({
        stage: s!.stage,
        failed: s!.failed,
        retainedUnknown,
        pending: s!.pending.size,
        retainedFDs: s!.handles.size,
        firstFailureRetained: s!.firstFailureSet,
        childSubmitted: s!.childSubmitted,
        exitObserved: s!.exitObserved,
        closeObserved: s!.closeObserved,
        stdoutEOF: s!.stdoutEOF,
        stderrEOF: s!.stderrEOF,
    });
}
/** One actual source envelope and one prepared-runtime installer child; no relaunch/retry/cleanup. */
export async function linuxSetupBootstrapEntry(args: string[]) {
    const selected = linuxSetupBootstrapArguments(args);
    need(
        process.platform === 'linux' &&
            process.arch === 'x64' &&
            process.versions.electron &&
            process.env.ELECTRON_RUN_AS_NODE === '1' &&
            process.getuid &&
            process.geteuid,
        'LINUX_BOOTSTRAP_RUNTIME',
    );
    const uid = process.getuid!(),
        home = process.env.HOME ?? '',
        sourceRoot = path.posix.dirname(process.execPath);
    need(
        uid > 0 &&
            uid === process.geteuid!() &&
            normal(home) &&
            normal(sourceRoot) &&
            sourceRoot.startsWith(home + '/') &&
            process.argv[1] === sourceRoot + '/resources/linux-setup-bootstrap.cjs',
        'LINUX_BOOTSTRAP_RUNTIME',
    );
    for (const key of ['archive', 'release-record', 'build-record', 'envelope-directory'])
        need((selected[key] as string).startsWith(home + '/'), 'LINUX_BOOTSTRAP_CONTAINMENT');
    const owner = Object.freeze({});
    const state: NonNullable<ReturnType<typeof ownerStates.get>> = {
        stage: 'records',
        failed: false,
        firstFailureSet: false,
        handles: new Set(),
        pending: new Set(),
        originals: { release: null, build: null, census: null },
        envelope: null,
        envelopeComplete: false,
        mainPhase: 'not-entered',
        child: null,
        childSubmitted: false,
        stdout: [],
        stderr: [],
        stdoutBytes: 0,
        stderrBytes: 0,
        exitObserved: false,
        closeObserved: false,
        stdoutEOF: false,
        stderrEOF: false,
        exitCode: null,
        signal: null,
        timer: null,
    };
    ownerStates.set(owner, state);
    retained.add(owner); // Before the first filesystem/asynchronous effect.
    const started = now(),
        until = started + 120000;
    let activeUntil = until;
    const fail = (error: unknown) => {
        state.failed = true;
        if (!state.firstFailureSet) {
            state.firstFailureSet = true;
            state.firstFailure = error;
        }
    };
    const gate = () =>
        need(
            !state.failed && now() >= started && now() < activeUntil,
            'LINUX_BOOTSTRAP_DEADLINE_OR_UNKNOWN',
        );
    async function effect<T>(operation: () => Promise<T>, adopt: (value: T) => void = () => {}) {
        gate();
        const pending = {};
        state.pending.add(pending);
        try {
            gate();
            const value = await operation();
            adopt(value);
            state.pending.delete(pending);
            gate();
            return value;
        } catch (error) {
            fail(error);
            throw error;
        }
    }
    async function ancestry(directory: string) {
        let cursor = '/';
        for (const leaf of ['', ...directory.split('/').filter(Boolean)]) {
            cursor = path.posix.join(cursor, leaf);
            const st = checkedLinuxEnvelopeIdentity(await effect(() => fs.lstat(cursor)));
            need(
                st.isDirectory() &&
                    !st.isSymbolicLink() &&
                    (st.uid === uid || st.uid === 0) &&
                    (st.mode & 0o7022) === 0 &&
                    (await effect(() => fs.realpath(cursor))) === cursor,
                'LINUX_BOOTSTRAP_PARENT',
            );
        }
    }
    async function open(file: string, cap: number) {
        await ancestry(path.posix.dirname(file));
        const before = checkedLinuxEnvelopeIdentity(await effect(() => fs.lstat(file)));
        need(
            before.isFile() &&
                !before.isSymbolicLink() &&
                before.uid === uid &&
                before.nlink === 1 &&
                Number.isSafeInteger(before.size) &&
                before.size > 0 &&
                before.size <= cap &&
                (before.mode & 0o7022) === 0,
            'LINUX_BOOTSTRAP_INPUT',
        );
        const handle = await effect(
            () => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
            (value) => state.handles.add(value),
        );
        need(
            sameLinuxEnvelopeFileIdentity(before, await effect(() => handle.stat())) &&
                (await effect(() => fs.realpath('/proc/self/fd/' + handle.fd))) === file,
            'LINUX_BOOTSTRAP_INPUT_CHANGED',
        );
        return { handle, before, file };
    }
    async function close(input: Awaited<ReturnType<typeof open>>) {
        need(
            sameLinuxEnvelopeFileIdentity(input.before, await effect(() => input.handle.stat())) &&
                sameLinuxEnvelopeFileIdentity(
                    input.before,
                    await effect(() => fs.lstat(input.file)),
                ),
            'LINUX_BOOTSTRAP_INPUT_CHANGED',
        );
        await effect(
            () => input.handle.close(),
            () => state.handles.delete(input.handle),
        );
    }
    async function small(file: string) {
        const input = await open(file, 65536),
            bytes = Buffer.alloc(input.before.size + 1);
        let used = 0;
        while (used < bytes.length) {
            const part = await effect(() =>
                input.handle.read(bytes, used, bytes.length - used, used),
            );
            need(
                Number.isSafeInteger(part.bytesRead) &&
                    part.bytesRead >= 0 &&
                    part.bytesRead <= bytes.length - used,
                'LINUX_BOOTSTRAP_READ',
            );
            if (!part.bytesRead) break;
            used += part.bytesRead;
        }
        need(used === input.before.size, 'LINUX_BOOTSTRAP_READ');
        await close(input);
        return bytes.subarray(0, used);
    }
    try {
        need((await effect(() => fs.realpath(home))) === home, 'LINUX_BOOTSTRAP_HOME');
        const releaseBytes = await small(selected['release-record'] as string);
        state.originals.release = releaseBytes;
        const buildBytes = await small(selected['build-record'] as string);
        state.originals.build = buildBytes;
        const release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes)),
            build = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buildBytes));
        need(
            build &&
                typeof build.version === 'string' &&
                /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(build.version) &&
                typeof build.commit === 'string' &&
                /^[a-f0-9]{40}$/.test(build.commit),
            'LINUX_BOOTSTRAP_RECORD',
        );
        if (selected.version)
            need(
                (selected.version as string).replace(/^v/, '') === build.version,
                'LINUX_BOOTSTRAP_VERSION',
            );
        const archiveName = 'Diagnostic-Hub-linux-x64.tar.gz';
        const archive = await open(selected.archive as string, 2 * 1024 ** 3);
        const expected = { bytes: archive.before.size, sha256: build.assets?.[archiveName] };
        need(
            typeof expected.sha256 === 'string' && /^[a-f0-9]{64}$/.test(expected.sha256),
            'LINUX_BOOTSTRAP_ARCHIVE',
        );
        const requestId = randomBytes(16).toString('hex');
        const window = linuxObservationWindow({
            requestId,
            startedMs: started,
            deadlineMs: until,
            now: () => {
                gate();
                return now();
            },
        });
        state.stage = 'archive';
        async function* chunks() {
            let position = 0;
            for (;;) {
                const bytes = Buffer.alloc(65536);
                const part = await effect(() =>
                    archive.handle.read(
                        bytes,
                        0,
                        Math.min(bytes.length, expected.bytes - position + 1),
                        position,
                    ),
                );
                need(
                    Number.isSafeInteger(part.bytesRead) &&
                        part.bytesRead >= 0 &&
                        part.bytesRead <= bytes.length,
                    'LINUX_BOOTSTRAP_READ',
                );
                if (!part.bytesRead) return;
                position += part.bytesRead;
                yield Buffer.from(bytes.subarray(0, part.bytesRead));
            }
        }
        const census = await observeLinuxGzipTar(chunks(), expected, window);
        state.originals.census = census;
        await close(archive);
        const mapped = normalizeLinuxPackagerCensus(census, archiveName);
        const files = mapped.payloadEntries
            .filter((row: any) => row.kind === 'file')
            .map((row: any) => ({
                path: row.path,
                bytes: row.bytes,
                sha256: row.sha256,
                mode: row.mode,
            }))
            .sort((a: any, b: any) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const input = {
            platform: 'linux',
            arch: 'x64',
            uid,
            euid: uid,
            home,
            sourceRoot,
            outputRoot: selected['envelope-directory'] as string,
            archivePath: selected.archive as string,
            archive: { asset: archiveName, ...expected },
            layout: 'flat-linux-portable',
            version: build.version,
            sourceCommit: build.commit,
            files,
            inventorySHA256: hash(JSON.stringify(files)),
        };
        const plan = planLinuxPermanentEnvelope(input);
        validateLinuxObservationRecords(
            plan,
            {
                repository: 'brucerry/embedded-linux-diagnostic-hub',
                tag: release.tag_name,
                version: build.version,
                sourceCommit: build.commit,
                archiveSHA256: expected.sha256,
                archiveBytes: expected.bytes,
                releaseRecordSHA256: hash(releaseBytes),
                buildRecordSHA256: hash(buildBytes),
            },
            releaseBytes,
            buildBytes,
        );
        const choiceArgs = [
            '--install-directory',
            selected['install-directory'] as string,
            '--version',
            build.version,
            '--operation',
            selected.operation as string,
        ];
        if (Object.hasOwn(selected, 'menu'))
            choiceArgs.push(selected.menu ? '--menu' : '--no-menu');
        if (selected.terminal) choiceArgs.push('--terminal');
        if (selected['no-launch']) choiceArgs.push('--no-launch');
        linuxPermanentArguments(choiceArgs); // Existing product grammar; only the explicit selected operation, no inferred fallback.
        state.stage = 'preparing';
        const disk = createLinuxEnvelopeDisk();
        state.envelope = { disk, plan };
        const prepared = await effect(
            () => prepareLinuxPermanentEnvelope(input, disk),
            (value) => {
                if (value.status === 'prepared-install-envelope') state.envelopeComplete = true;
            },
        );
        need(prepared.status === 'prepared-install-envelope', 'LINUX_BOOTSTRAP_PREPARE_RETAINED');
        need(state.handles.size === 0 && state.pending.size === 0, 'LINUX_BOOTSTRAP_PENDING');
        state.stage = 'prepared-installer';
        // A separate installer-child wait budget; the original archive window is never renewed.
        activeUntil = now() + 120000;
        const executable = path.posix.join(plan.outputRoot, 'app/diagnostic-hub'),
            entry = path.posix.join(plan.outputRoot, 'app/resources/linux-setup-install.cjs');
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            LD_LIBRARY_PATH: path.posix.join(plan.outputRoot, 'app/usr/lib'),
        };
        for (const key of [
            'NODE_OPTIONS',
            'NODE_PATH',
            'APPIMAGE',
            'APPDIR',
            'PORTABLE_EXECUTABLE_FILE',
            'PORTABLE_EXECUTABLE_DIR',
            'PORTABLE_EXECUTABLE_APP_FILENAME',
        ])
            delete env[key];
        // Capture submission before the only spawn, and the returned child before any listener gate.
        state.childSubmitted = true;
        const child = spawn(executable, [entry, ...choiceArgs], {
            cwd: plan.outputRoot,
            env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        state.child = child;
        const code = await new Promise<number>((resolve, reject) => {
            const timer = (state.timer = setTimeout(
                () => {
                    fail(Error('LINUX_BOOTSTRAP_CHILD_DEADLINE'));
                    reject(Error('LINUX_BOOTSTRAP_CHILD_RETAINED'));
                },
                Math.max(1, activeUntil - now()),
            ));
            const refuse = (error: unknown) => {
                if (state.mainPhase === 'retired') {
                    state.postRetirementFailure ??= { value: error }; // Protocol incident after this main owner's final fence.
                    return;
                }
                fail(error);
                clearTimeout(timer);
                reject(Error('LINUX_BOOTSTRAP_CHILD_RETAINED'));
            };
            child.on('error', refuse);
            for (const name of ['stdout', 'stderr'] as const) {
                const stream = child[name]!,
                    byteKey = name === 'stdout' ? 'stdoutBytes' : 'stderrBytes',
                    eofKey = name === 'stdout' ? 'stdoutEOF' : 'stderrEOF';
                stream.on('error', refuse);
                stream.on('data', (raw: Buffer) => {
                    try {
                        gate();
                        const bytes = Buffer.from(raw);
                        state[byteKey] += bytes.length;
                        need(state[byteKey] <= 65536, 'LINUX_BOOTSTRAP_STREAM_CAP');
                        state[name].push(bytes);
                    } catch (error) {
                        refuse(error);
                    }
                });
                stream.once('end', () => {
                    state[eofKey] = true;
                });
            }
            child.once('exit', (status, signal) => {
                state.exitObserved = true;
                state.exitCode = status;
                state.signal = signal;
            });
            child.once('close', () => {
                clearTimeout(timer);
                state.closeObserved = true;
                try {
                    gate();
                    need(
                        state.exitObserved &&
                            state.stdoutEOF &&
                            state.stderrEOF &&
                            state.signal === null &&
                            Number.isSafeInteger(state.exitCode) &&
                            state.exitCode! >= 0 &&
                            state.exitCode! <= 255,
                        'LINUX_BOOTSTRAP_CHILD_CLOSURE',
                    );
                    resolve(state.exitCode!);
                } catch (error) {
                    refuse(error);
                }
            });
        });
        state.stage = code === 0 ? 'completed-installer-child' : 'installer-refused';
        return { exitCode: code, owner };
    } catch (error) {
        fail(error);
        return { exitCode: 78, owner };
    }
}
if (typeof require !== 'undefined' && require.main === module) {
    // Establish output event containment before any filesystem/child operation.
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    const report = (owner: object, message: string) => {
        try {
            process.stdout.write(message);
        } catch (failure) {
            const state = ownerStates.get(owner);
            if (state && !state.diagnosticFailure) state.diagnosticFailure = { value: failure };
        }
    };
    void linuxSetupBootstrapEntry(process.argv.slice(2))
        .then(({ exitCode, owner }) => {
            const state = ownerStates.get(owner)!;
            state.mainPhase = 'publishing'; // A bounded synchronous publication owner, not a new wait window.
            const diagnostics = linuxSetupBootstrapDiagnostics(owner);
            if (diagnostics.retainedUnknown) {
                // The keeper precedes fallible diagnostics. Reporting cannot abandon custody.
                setInterval(() => {}, 60000);
                report(
                    owner,
                    'Linux permanent setup retained unresolved sources or child ownership. Preserve scratch.\n',
                );
                return;
            }
            report(
                owner,
                exitCode === 0
                    ? 'Linux installer child completed; source envelope and prior artifacts remain retained.\n'
                    : diagnostics.childSubmitted
                      ? 'Linux installer child refused; source envelope remains retained.\n'
                      : 'Linux permanent source preparation refused; downloaded sources remain retained.\n',
            );
            // A child/stream incident raised while that report ran cannot retroactively
            // reject its settled promise, but this live final fence must observe it.
            const final = linuxSetupBootstrapDiagnostics(owner);
            if (final.retainedUnknown) {
                setInterval(() => {}, 60000);
                report(
                    owner,
                    'Linux permanent setup retained a late unresolved ownership incident. Preserve scratch.\n',
                );
                return;
            }
            process.exitCode = state.failed || state.diagnosticFailure ? 78 : exitCode;
            state.mainPhase = 'retired'; // Later protocol incidents are recorded privately, without new actuation/hold.
        })
        .catch(() => {
            try {
                process.stderr.write(
                    'Linux permanent bootstrap arguments or runtime unavailable.\n',
                );
            } catch {
                /* best-effort fixed diagnostic only */
            }
            process.exitCode = 78;
        });
}
