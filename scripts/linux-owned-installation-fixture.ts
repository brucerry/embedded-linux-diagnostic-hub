/** Fixed on-host qualification fixture, not an installer admission or published-release producer.
 * Requires two genuine same-source packages. This file is inert when imported. */
import fs, { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { spawn } from 'node:child_process';
import { observeOwnedChild } from './lib/owned-child.mjs';
import { observeLinuxGzipTar, linuxObservationWindow } from './lib/linux-archive-members.mjs';
import { normalizeLinuxPackagerCensus } from './lib/linux-release-observation.ts';
import {
    planLinuxPermanentEnvelope,
    prepareLinuxPermanentEnvelope,
} from './lib/linux-setup-envelope.ts';
import { createLinuxEnvelopeDisk } from './lib/linux-setup-envelope-disk.mjs';
import { validateLinuxReviewCapability } from './lib/linux-review-package.mjs';
import {
    validateInstallationManifest,
    validateInstallationRecord,
} from '../shared/installation.ts';

const A = '0.6.0-qualification.0',
    B = '0.6.0';
const sha = (x: Buffer | string) => createHash('sha256').update(x).digest('hex');
const need = (x: unknown, reason: string) => {
    if (!x) throw Error(reason);
};
const normal = (x: string) =>
    x.startsWith('/') &&
    !x.endsWith('/') &&
    x.length <= 220 &&
    path.posix.normalize(x) === x &&
    !/[\\\x00-\x1f\x7f]/.test(x);
const inside = (a: string, b: string) => b.startsWith(a + '/');
const same = (a: fs.Stats, b: fs.Stats) =>
    ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
        (k) => a[k as keyof fs.Stats] === b[k as keyof fs.Stats],
    );
const owners = new Set<object>();

export function linuxOwnedFixtureArguments(args: string[]) {
    const value: Record<string, string> = {};
    const keys = ['a-appdir', 'a-archive', 'b-appdir', 'b-archive', 'fixture-root'];
    for (let at = 0; at < args.length; at += 2) {
        const key = args[at]?.slice(2),
            selected = args[at + 1];
        need(
            args[at]?.startsWith('--') &&
                keys.includes(key) &&
                !Object.hasOwn(value, key) &&
                typeof selected === 'string' &&
                normal(selected),
            'FIXTURE_ARGUMENT',
        );
        value[key] = selected;
    }
    need(
        Object.keys(value).length === keys.length &&
            new Set(Object.values(value)).size === keys.length,
        'FIXTURE_ARGUMENT',
    );
    return Object.freeze(value);
}

/** Finite fixed review matching is shared with memory controls; it does not grant consent. */
export function linuxOwnedFixtureReview(
    text: string,
    operation: string,
    target: string,
    version: string,
    appData: string,
) {
    const lines = text.replace(/\r\n/g, '\n');
    const prefix =
        '\nDiagnostic Hub Linux setup\nOperation: ' +
        operation +
        '\nApplication: ' +
        target +
        '\nCandidate version: ' +
        version +
        '\nInstalled version: ';
    const installed =
        operation === 'install' ? 'none' : B === version ? (operation === 'update' ? A : B) : A;
    const tail =
        '\nPrevious payloads are retained. No Finalize or removal is performed.\nType "apply menu" or "apply no-menu" to apply this operation; Enter/cancel leaves everything unchanged: ';
    if (
        !lines.startsWith(
            prefix + installed + '\nSettings/reports: ' + appData + '/DiagnosticHub/profiles/',
        )
    )
        return false;
    const rest = lines.slice(
        (prefix + installed + '\nSettings/reports: ' + appData + '/DiagnosticHub/profiles/').length,
    );
    return (
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(rest) &&
        rest.slice(36) === tail
    );
}

export async function runLinuxOwnedInstallationFixture(args: string[]) {
    const selected = linuxOwnedFixtureArguments(args);
    const uid = process.getuid?.(),
        home = process.env.HOME ?? '';
    need(
        process.platform === 'linux' &&
            process.arch === 'x64' &&
            uid &&
            uid === process.geteuid?.() &&
            normal(home) &&
            Number(process.versions.napi) >= 8,
        'FIXTURE_HOST',
    );
    const root = selected['fixture-root'];
    need(
        Object.values(selected).every((x) => inside(home, x)) &&
            Object.values(selected)
                .filter((x) => x !== root)
                .every((x) => !inside(root, x) && !inside(x, root)),
        'FIXTURE_CONTAINMENT',
    );
    const state = {
        failed: false,
        firstSet: false,
        first: undefined as unknown,
        phase: 'host',
        retired: false,
        lateFailure: null as { value: unknown } | null,
        fds: new Set<number>(),
        pending: new Set<object>(),
        returns: [] as unknown[],
        childSubmitted: false,
        child: null as ReturnType<typeof spawn> | null,
        envelopes: [] as {
            disk: ReturnType<typeof createLinuxEnvelopeDisk>;
            plan: ReturnType<typeof planLinuxPermanentEnvelope>;
            census: unknown;
            complete: boolean;
        }[],
        transcript: [] as unknown[],
        keeper: null as ReturnType<typeof setInterval> | null,
    };
    owners.add(state); // Before filesystem, child, native or preparation effects.
    const fail = (x: unknown) => {
        state.failed = true;
        if (!state.firstSet) {
            state.firstSet = true;
            state.first = x;
        }
    };
    const unknown = () =>
        state.fds.size > 0 ||
        state.pending.size > 0 ||
        state.childSubmitted ||
        state.child !== null ||
        state.envelopes.some((x) => !x.complete);
    const hold = () => {
        state.keeper ??= setInterval(() => {}, 60000);
    };
    const started = performance.now(),
        until = started + 9 * 60000;
    const gate = () =>
        need(
            !state.failed && performance.now() >= started && performance.now() < until,
            'FIXTURE_FROZEN_OR_DEADLINE',
        );
    const timer = setTimeout(() => {
        fail(Error('FIXTURE_DEADLINE'));
        if (unknown()) hold();
    }, until - started);
    function ancestry(directory: string) {
        gate();
        let full = '/';
        for (const component of ['', ...directory.split('/').filter(Boolean)]) {
            full = path.posix.join(full, component);
            const s = fs.lstatSync(full);
            need(
                s.isDirectory() &&
                    !s.isSymbolicLink() &&
                    Number.isSafeInteger(s.dev) &&
                    s.dev >= 0 &&
                    Number.isSafeInteger(s.ino) &&
                    s.ino > 0 &&
                    [0, uid].includes(s.uid) &&
                    !(s.mode & 0o7022) &&
                    fs.realpathSync(full) === full,
                'FIXTURE_PARENT',
            );
        }
    }
    function open(file: string, cap: number, systemTool = false, allowEmpty = false) {
        gate();
        ancestry(path.posix.dirname(file));
        const before = fs.lstatSync(file);
        need(
            before.isFile() &&
                !before.isSymbolicLink() &&
                (systemTool ? [0, uid].includes(before.uid) : before.uid === uid) &&
                before.nlink === 1 &&
                Number.isSafeInteger(before.ino) &&
                before.ino > 0 &&
                Number.isSafeInteger(before.size) &&
                before.size >= (allowEmpty ? 0 : 1) &&
                before.size <= cap &&
                !(before.mode & 0o7022),
            'FIXTURE_INPUT',
        );
        const fd = fs.openSync(
            file,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        state.fds.add(fd);
        need(
            same(before, fs.fstatSync(fd)) && fs.realpathSync('/proc/self/fd/' + fd) === file,
            'FIXTURE_INPUT_CHANGED',
        );
        return { fd, before, file };
    }
    function close(input: ReturnType<typeof open>) {
        gate();
        need(
            same(input.before, fs.fstatSync(input.fd)) &&
                same(input.before, fs.lstatSync(input.file)),
            'FIXTURE_INPUT_CHANGED',
        );
        fs.closeSync(input.fd);
        state.fds.delete(input.fd);
        gate();
    }
    function bytes(file: string, cap: number, allowEmpty = false) {
        const input = open(file, cap, false, allowEmpty),
            out = Buffer.alloc(input.before.size + 1);
        let at = 0;
        for (;;) {
            gate();
            const n = fs.readSync(input.fd, out, at, out.length - at, at);
            need(n >= 0 && at + n <= input.before.size, 'FIXTURE_READ_BOUND');
            if (!n) break;
            at += n;
        }
        need(at === input.before.size, 'FIXTURE_READ_SHORT');
        close(input);
        return Buffer.from(out.subarray(0, at));
    }
    function digest(file: string, cap: number, systemTool = false) {
        const input = open(file, cap, systemTool, true),
            hash = createHash('sha256'),
            chunk = Buffer.alloc(65536);
        let at = 0;
        for (;;) {
            gate();
            const n = fs.readSync(
                input.fd,
                chunk,
                0,
                Math.min(chunk.length, input.before.size - at + 1),
                at,
            );
            need(n >= 0 && at + n <= input.before.size, 'FIXTURE_READ_BOUND');
            if (!n) break;
            hash.update(chunk.subarray(0, n));
            at += n;
        }
        need(at === input.before.size, 'FIXTURE_READ_SHORT');
        close(input);
        return { bytes: at, sha256: hash.digest('hex') };
    }
    function tree(directory: string, maximumFiles = 20032) {
        ancestry(directory);
        const result: { path: string; mode: number; bytes: number; sha256: string }[] = [],
            directories: { path: string; mode: number }[] = [];
        let total = 0;
        function walk(current: string, relative: string) {
            gate();
            const before = fs.lstatSync(current);
            ancestry(current);
            for (const leaf of fs.readdirSync(current).sort()) {
                need(
                    leaf !== '.' && leaf !== '..' && !/[\\\x00-\x1f\x7f]/.test(leaf),
                    'FIXTURE_TREE_NAME',
                );
                const file = path.posix.join(current, leaf),
                    named = relative ? relative + '/' + leaf : leaf,
                    s = fs.lstatSync(file);
                if (s.isDirectory()) {
                    need(directories.length < maximumFiles, 'FIXTURE_TREE_COUNT');
                    directories.push({ path: named, mode: s.mode & 0o7777 });
                    walk(file, named);
                } else {
                    need(result.length < maximumFiles, 'FIXTURE_TREE_COUNT');
                    const value = digest(file, 2 * 1024 ** 3);
                    total += value.bytes;
                    need(total <= 2 * 1024 ** 3, 'FIXTURE_TREE_BYTES');
                    result.push({ path: named, mode: s.mode & 0o7777, ...value });
                }
            }
            need(same(before, fs.lstatSync(current)), 'FIXTURE_TREE_CHANGED');
        }
        walk(directory, '');
        return {
            files: result.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)),
            directories: directories.sort((x, y) =>
                x.path < y.path ? -1 : x.path > y.path ? 1 : 0,
            ),
        };
    }
    function write(name: string, value: unknown) {
        gate();
        const raw = Buffer.isBuffer(value)
            ? value
            : Buffer.from(JSON.stringify(value, null, 2) + '\n');
        const file = path.posix.join(root, name);
        ancestry(path.posix.dirname(file));
        const fd = fs.openSync(
            file,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        state.fds.add(fd);
        fs.writeFileSync(fd, raw);
        fs.fsyncSync(fd);
        need(fs.fstatSync(fd).size === raw.length, 'FIXTURE_WRITE');
        fs.closeSync(fd);
        state.fds.delete(fd);
        need(bytes(file, raw.length, true).equals(raw), 'FIXTURE_WRITE_READBACK');
        return { path: file, bytes: raw.length, sha256: sha(raw) };
    }
    async function effect<T>(call: () => Promise<T>) {
        gate();
        need(state.returns.length < 50000, 'FIXTURE_OPERATION_BOUND');
        const owner = { returned: false, value: undefined as unknown };
        state.pending.add(owner);
        state.returns.push(owner);
        try {
            const value = await call();
            owner.value = value;
            owner.returned = true;
            state.pending.delete(owner);
            gate();
            return value;
        } catch (error) {
            fail(error);
            throw error;
        }
    }
    try {
        ancestry(home);
        ancestry(path.posix.dirname(root));
        need(fs.readlinkSync('/proc/self/exe') === process.execPath, 'FIXTURE_PROC_EXECUTABLE');
        const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const commit = bytes(repo + '/.git/HEAD', 256)
            .toString('utf8')
            .trim();
        need(
            /^[a-f0-9]{40}$/.test(commit) && commit === process.env.GITHUB_SHA,
            'FIXTURE_DETACHED_SOURCE',
        );
        const runId = process.env.GITHUB_RUN_ID,
            runAttempt = process.env.GITHUB_RUN_ATTEMPT;
        need(
            process.env.GITHUB_REPOSITORY === 'brucerry/embedded-linux-diagnostic-hub' &&
                typeof runId === 'string' &&
                /^[1-9][0-9]{0,31}$/.test(runId) &&
                runAttempt === '1',
            'FIXTURE_ACTUAL_RUN_CONTEXT',
        );
        const python = fs.realpathSync('/usr/bin/python3');
        const nodeDisk = digest(process.execPath, 256 * 1024 ** 2, true),
            pythonDisk = digest(python, 64 * 1024 ** 2, true);
        const driverDisk = digest(fileURLToPath(import.meta.url), 65536),
            companionDisk = digest(repo + '/scripts/linux-owned-installation-pty.py', 65536);
        need(!fs.existsSync(root), 'FIXTURE_NOT_FRESH');
        fs.mkdirSync(root, { mode: 0o700 });
        for (const leaf of ['records', 'operations', 'config', 'data'])
            fs.mkdirSync(root + '/' + leaf, { mode: 0o700 });
        write('records/source.json', {
            sourceCommit: commit,
            runId,
            runAttempt,
            controlledA: A,
            currentB: B,
            rendererBuildLiteralVersion: B,
            allCodeLiteralsOverriddenForA: false,
            publishedRelease: false,
            fixtureOnly: true,
            tools: {
                node: {
                    version: process.versions.node,
                    napi: process.versions.napi,
                    executable: process.execPath,
                    ...nodeDisk,
                },
                python: { executable: python, ...pythonDisk },
                driver: driverDisk,
                companion: companionDisk,
                identityScope:
                    'nominal-disk-and-runtime-observations-not-physical-loaded-byte-proof',
            },
        });
        async function prepare(role: 'a' | 'b', version: string) {
            state.phase = 'prepare-' + role;
            const sourceRoot = selected[role + '-appdir'],
                archivePath = selected[role + '-archive'];
            const archive = digest(archivePath, 2 * 1024 ** 3),
                input = open(archivePath, 2 * 1024 ** 3);
            const deadline = Math.min(until, performance.now() + 120000);
            const window = linuxObservationWindow({
                requestId: randomBytes(16).toString('hex'),
                startedMs: performance.now(),
                deadlineMs: deadline,
                now: () => {
                    gate();
                    return performance.now();
                },
            });
            async function* chunks() {
                let at = 0;
                for (;;) {
                    gate();
                    const raw = Buffer.alloc(65536),
                        n = fs.readSync(
                            input.fd,
                            raw,
                            0,
                            Math.min(raw.length, input.before.size - at + 1),
                            at,
                        );
                    need(n >= 0 && at + n <= input.before.size, 'FIXTURE_ARCHIVE_READ');
                    if (!n) return;
                    at += n;
                    yield raw.subarray(0, n);
                }
            }
            const census = await effect(() => observeLinuxGzipTar(chunks(), archive, window));
            write('records/' + role + '-census.json', census);
            close(input);
            const mapped = normalizeLinuxPackagerCensus(census, 'Diagnostic-Hub-linux-x64.tar.gz');
            const files = mapped.payloadEntries
                .filter((row: any) => row.kind === 'file')
                .map((row: any) => ({
                    path: row.path,
                    bytes: row.bytes,
                    sha256: row.sha256,
                    mode: row.mode,
                }))
                .sort((x: any, y: any) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
            const settings = {
                platform: 'linux',
                arch: 'x64',
                uid,
                euid: uid,
                home,
                sourceRoot,
                outputRoot: root + '/envelope-' + role,
                archivePath,
                archive: { asset: 'Diagnostic-Hub-linux-x64.tar.gz', ...archive },
                layout: 'flat-linux-portable',
                version,
                sourceCommit: commit,
                files,
                inventorySHA256: sha(JSON.stringify(files)),
            };
            const plan = planLinuxPermanentEnvelope(settings);
            const capRaw = bytes(sourceRoot + '/resources/linux-setup-review.json', 4096),
                capability = validateLinuxReviewCapability(
                    JSON.parse(capRaw.toString('utf8')),
                    version,
                );
            const { extractFile } = await import('@electron/asar'); // Data-only ASAR inspection, not application evaluation.
            const packageRaw = extractFile(sourceRoot + '/resources/app.asar', 'package.json');
            need(packageRaw.length <= 65536, 'FIXTURE_ASAR_CAP');
            const pkg = JSON.parse(packageRaw.toString('utf8'));
            need(
                pkg.name === 'embedded-linux-diagnostic-hub' && pkg.version === version,
                'FIXTURE_ACTUAL_VERSION',
            );
            write('records/' + role + '-package.json', packageRaw);
            write('records/' + role + '-capability.json', capRaw);
            const disk = createLinuxEnvelopeDisk(),
                envelopeOwner = { disk, plan, census, complete: false };
            state.envelopes.push(envelopeOwner);
            const result = await effect(() =>
                prepareLinuxPermanentEnvelope(settings, {
                    admit: (p) => effect(() => disk.admit(p)),
                    verifyInput: (p) => effect(() => disk.verifyInput(p)),
                    createRoot: (p) => effect(() => disk.createRoot(p)),
                    copyFile: (p, f) => effect(() => disk.copyFile(p, f)),
                    writeDescriptor: (p, b) => effect(() => disk.writeDescriptor(p, b)),
                    verifyOutput: (p) => effect(() => disk.verifyOutput(p)),
                }),
            );
            write('records/' + role + '-preparation.json', result);
            need(result.status === 'prepared-install-envelope', 'FIXTURE_PREPARATION_REFUSED');
            envelopeOwner.complete = true;
            return plan;
        }
        const a = await prepare('a', A),
            b = await prepare('b', B);
        const target = root + '/installed',
            appData = root + '/config',
            dataHome = root + '/data';
        function payload(directory: string, plan: typeof a) {
            const originalManifest = bytes(
                    directory + '/.diagnostic-hub-release.json',
                    4 * 1024 * 1024,
                ),
                manifest = validateInstallationManifest(
                    JSON.parse(originalManifest.toString('utf8')),
                );
            need(
                JSON.stringify(manifest) === JSON.stringify(plan.manifest),
                'FIXTURE_INSTALLED_MANIFEST',
            );
            const originalRecord = bytes(directory + '/.diagnostic-hub-installation.json', 16384),
                record = validateInstallationRecord(JSON.parse(originalRecord.toString('utf8')));
            need(
                record.profile === 'dedicated' && record.manifestSHA256 === sha(originalManifest),
                'FIXTURE_INSTALLED_RECORD',
            );
            const originalOwner = bytes(directory + '/.diagnostic-hub-ownership.json', 16384),
                owned = JSON.parse(originalOwner.toString('utf8'));
            need(
                owned.root === target &&
                    owned.installationId === record.installationId &&
                    Array.isArray(owned.integrations) &&
                    owned.integrations.length === 0 &&
                    owned.options &&
                    Object.keys(owned.options).sort().join(',') === 'desktop,launch,startMenu' &&
                    Object.values(owned.options).every((x) => x === false),
                'FIXTURE_OWNED_SCOPE',
            );
            const observed = tree(directory);
            const expected = [
                ...manifest.files.map((f) => f.path),
                '.diagnostic-hub-release.json',
                '.diagnostic-hub-installation.json',
                '.diagnostic-hub-ownership.json',
            ].sort();
            need(
                JSON.stringify(observed.files.map((x) => x.path)) === JSON.stringify(expected),
                'FIXTURE_COMPLETE_INSTALLED_TREE',
            );
            need(
                JSON.stringify(observed.directories.map((x) => x.path)) ===
                    JSON.stringify(['app', ...plan.directories.map((x) => 'app/' + x)].sort()) &&
                    observed.directories.every((x) => x.mode === 0o700),
                'FIXTURE_COMPLETE_INSTALLED_DIRECTORIES',
            );
            for (const f of manifest.files) {
                if (f.kind !== 'file') throw Error('FIXTURE_REGULAR_PAYLOAD');
                const actual = observed.files.find((x) => x.path === f.path)!;
                const source = plan.files.find((x) => 'app/' + x.path === f.path);
                need(
                    source &&
                        actual.bytes === f.bytes &&
                        actual.sha256 === f.sha256 &&
                        actual.mode === source.mode,
                    'FIXTURE_INSTALLED_PAYLOAD',
                );
            }
            return { originalManifest, originalRecord, originalOwner, record, observed };
        }
        function snapshot(label: string, plan: typeof a) {
            state.phase = 'readback-' + label;
            const captured = payload(target, plan),
                record = captured.record;
            const work = root + '/.DiagnosticHub-maintenance-' + sha(target).slice(0, 20);
            const journal = bytes(work + '/journal.json', 8192),
                j = JSON.parse(journal.toString('utf8'));
            need(
                j.root === target &&
                    j.uid === uid &&
                    ['candidate-active', 'rolled-back'].includes(j.phase),
                'FIXTURE_JOURNAL',
            );
            write('records/' + label + '-manifest.json', captured.originalManifest);
            write('records/' + label + '-installation.json', captured.originalRecord);
            write('records/' + label + '-ownership.json', captured.originalOwner);
            write('records/' + label + '-journal.json', journal);
            write('records/' + label + '-payload.json', {
                files: captured.observed,
                installationId: record.installationId,
                phase: j.phase,
                profile: appData + '/DiagnosticHub/profiles/' + record.installationId,
            });
            return { ...captured, journal: j, work };
        }
        async function operation(op: 'install' | 'update' | 'rollback', plan: typeof a) {
            gate();
            state.phase = op;
            const folder = root + '/operations/' + op;
            fs.mkdirSync(folder, { mode: 0o700 });
            const request = write('operations/' + op + '/request.json', {
                schema: 1,
                operation: op,
                version: plan.version,
                fixtureRoot: root,
                envelope: plan.outputRoot,
                target,
                appData,
                dataHome,
                sourceCommit: commit,
                uid,
            });
            const companion = repo + '/scripts/linux-owned-installation-pty.py';
            need(
                digest(companion, 65536).sha256 === companionDisk.sha256 &&
                    digest(python, 64 * 1024 ** 2, true).sha256 === pythonDisk.sha256,
                'FIXTURE_TOOL_CHANGED',
            );
            const submission = {
                executable: python,
                argv: [
                    '-I',
                    '-B',
                    companion,
                    '--request',
                    request.path,
                    '--sha256',
                    request.sha256,
                ],
                cwd: folder,
                runId,
                runAttempt,
                pythonSHA256: pythonDisk.sha256,
                companionSHA256: companionDisk.sha256,
            };
            write('operations/' + op + '/submission.json', submission);
            state.childSubmitted = true; // Issued before spawn: a throwing submission has no authoritative noncreation acknowledgement.
            const child = spawn(submission.executable, submission.argv, {
                cwd: folder,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    PATH: '/usr/bin:/bin',
                    HOME: home,
                    LANG: 'C.UTF-8',
                    LC_ALL: 'C.UTF-8',
                    TMPDIR: folder,
                },
            });
            state.child = child;
            state.transcript.push({ child, submission }); // Before any await/listener observation.
            let stdout = Buffer.alloc(0),
                stderr = Buffer.alloc(0),
                outEOF = false,
                errEOF = false;
            for (const key of ['stdout', 'stderr'] as const) {
                child[key].on('error', (error) => {
                    if (state.retired) {
                        state.lateFailure ??= { value: error };
                        return;
                    }
                    fail(error);
                    if (unknown()) hold();
                });
                child[key].on('data', (raw) => {
                    if (state.retired) {
                        state.lateFailure ??= { value: Error('FIXTURE_POST_RETIREMENT_DATA') };
                        return;
                    }
                    try {
                        gate();
                        const chunk = Buffer.from(raw);
                        if (key === 'stdout') stdout = Buffer.concat([stdout, chunk]);
                        else stderr = Buffer.concat([stderr, chunk]);
                        need(stdout.length <= 16384 && stderr.length <= 16384, 'FIXTURE_CHILD_CAP');
                    } catch (error) {
                        fail(error);
                        if (unknown()) hold();
                    }
                });
                child[key].once('end', () => {
                    if (key === 'stdout') outEOF = true;
                    else errEOF = true;
                });
            }
            const observer = observeOwnedChild(child, {
                totalMs: 150000,
                reserveMs: 1000,
                requestStop: () => {
                    fail(Error('FIXTURE_PTY_UNKNOWN'));
                    hold();
                },
            });
            const result = await observer.outcome;
            if (result.exitObserved && result.closeObserved && outEOF && errEOF) {
                state.child = null;
                state.childSubmitted = false;
            }
            write('operations/' + op + '/child.json', result);
            write('operations/' + op + '/stdout.bin', stdout);
            if (stderr.length) write('operations/' + op + '/stderr.bin', stderr);
            need(
                !state.failed &&
                    result.spawnObserved &&
                    result.exitObserved &&
                    result.closeObserved &&
                    result.code === 0 &&
                    result.closeCode === 0 &&
                    result.signal === null &&
                    result.closeSignal === null &&
                    !result.timedOut &&
                    result.error === null &&
                    outEOF &&
                    errEOF &&
                    stderr.length === 0,
                'FIXTURE_PTY_CLOSURE',
            );
            const response = JSON.parse(stdout.toString('utf8'));
            need(
                response.operation === op &&
                    response.helperExit === 0 &&
                    response.waitpidObserved === true &&
                    response.ptyEOF === true &&
                    response.consentSent === true &&
                    response.noSignals === true,
                'FIXTURE_PTY_RESULT',
            );
            state.child = null;
        }
        await operation('install', a);
        const initial = snapshot('installed-a', a);
        const profileBefore = tree(appData);
        write('records/profile-before.json', profileBefore);
        await operation('update', b);
        const updated = snapshot('updated-b', b);
        need(
            updated.record.installationId === initial.record.installationId &&
                updated.journal.previousSHA256 ===
                    sha(bytes(root + '/records/installed-a-manifest.json', 4 * 1024 * 1024)),
            'FIXTURE_UPDATE_IDENTITY',
        );
        const previous = payload(updated.work + '/previous-' + updated.journal.transactionId, a);
        need(
            previous.originalManifest.equals(initial.originalManifest) &&
                previous.originalRecord.equals(initial.originalRecord) &&
                previous.originalOwner.equals(initial.originalOwner),
            'FIXTURE_PREVIOUS_ORIGINALS',
        );
        write('records/previous-a-payload.json', previous.observed);
        await operation('rollback', b);
        const rolled = snapshot('rolled-back-a', a);
        need(
            rolled.record.installationId === initial.record.installationId &&
                rolled.journal.phase === 'rolled-back',
            'FIXTURE_ROLLBACK_IDENTITY',
        );
        need(
            rolled.originalManifest.equals(initial.originalManifest) &&
                rolled.originalRecord.equals(initial.originalRecord) &&
                rolled.originalOwner.equals(initial.originalOwner),
            'FIXTURE_RESTORED_ORIGINALS',
        );
        const retained = payload(updated.work + '/stage-' + updated.journal.transactionId, b);
        need(
            retained.originalManifest.equals(updated.originalManifest) &&
                retained.originalRecord.equals(updated.originalRecord) &&
                retained.originalOwner.equals(updated.originalOwner),
            'FIXTURE_RETAINED_CANDIDATE',
        );
        write('records/retained-b-payload.json', retained.observed);
        const profileAfter = tree(appData);
        need(
            JSON.stringify(profileAfter) === JSON.stringify(profileBefore),
            'FIXTURE_PROFILE_PRESERVATION',
        );
        write('records/profile-after.json', profileAfter);
        need(
            bytes(repo + '/.git/HEAD', 256)
                .toString('utf8')
                .trim() === commit,
            'FIXTURE_SOURCE_CHANGED',
        );
        state.phase = 'complete';
        clearTimeout(timer);
        const result = {
            status: 'completed-controlled-install-update-rollback',
            sourceCommit: commit,
            runId,
            runAttempt,
            versions: [A, B],
            installedAppLaunched: false,
            menuCreated: false,
            cleanupPerformed: false,
            releaseAcceptance: false,
        };
        write('records/final.json', result);
        state.retired = true;
        return result;
    } catch (error) {
        fail(error);
        if (unknown()) hold();
        else {
            clearTimeout(timer);
            state.retired = true;
        }
        return { status: 'retained-nonpassing', phase: state.phase, releaseAcceptance: false };
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const reporting = { failed: false, first: undefined as unknown };
    const reportFailed = (error: unknown) => {
        if (!reporting.failed) {
            reporting.failed = true;
            reporting.first = error;
        }
        process.exitCode = 1;
    };
    const phaseOf = (result: unknown) => {
        if (!result || typeof result !== 'object' || utilTypes.isProxy(result)) return 'unknown';
        const own = Object.getOwnPropertyDescriptor(result, 'phase');
        const phases = [
            'host',
            'prepare-a',
            'prepare-b',
            'install',
            'update',
            'rollback',
            'readback-installed-a',
            'readback-updated-b',
            'readback-rolled-back-a',
            'complete',
        ];
        return own &&
            Object.hasOwn(own, 'value') &&
            typeof own.value === 'string' &&
            phases.includes(own.value)
            ? own.value
            : 'unknown';
    };
    const nonpassing = (phase: string) => {
        try {
            process.stdout.write(
                '::error title=Linux owned installation fixture::outcome=nonpassing phase=' +
                    phase +
                    '\n',
            );
        } catch (error) {
            reportFailed(error);
        }
    };
    process.stdout.on('error', reportFailed);
    process.stderr.on('error', reportFailed);
    void runLinuxOwnedInstallationFixture(process.argv.slice(2))
        .then((result) => {
            try {
                process.stdout.write(JSON.stringify(result) + '\n');
            } catch (error) {
                reportFailed(error);
            }
            if (
                result.status !== 'completed-controlled-install-update-rollback' ||
                reporting.failed
            ) {
                process.exitCode = 1;
                nonpassing(
                    result.status === 'completed-controlled-install-update-rollback'
                        ? 'complete'
                        : phaseOf(result),
                );
            }
        })
        .catch(() => {
            try {
                process.stderr.write('Fixed Linux fixture input refused before ownership.\n');
            } catch (error) {
                reportFailed(error);
            }
            process.exitCode = 1;
            nonpassing('unknown');
        });
}
