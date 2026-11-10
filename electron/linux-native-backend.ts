import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { Stats, Dir } from 'node:fs';
import { physicalFS } from './physical-fs.ts';
import {
    checkedLinuxModelPlan,
    checkedLinuxModelConfiguration,
    checkedLinuxModelView,
    linuxModelReviewSHA256,
    type LinuxModelPlan,
    type LinuxModelConfiguration,
    type LinuxModelScope,
    type LinuxModelView,
    type LinuxModelSource,
    type LinuxModelPayload,
    type LinuxModelJournal,
    type LinuxModelParent,
    type LinuxModelKernel,
    type LinuxModelLease,
    type LinuxReservationIdentity,
    type LinuxMemoryEffects,
    type LinuxRetainedGeneration,
    MAX_LINUX_RETAINED_GENERATIONS,
} from './linux-transaction-model.ts';
import {
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
    INSTALLATION_MANIFEST,
    MAX_INSTALLATION_MANIFEST_BYTES,
    validateInstallationRecord,
    validateInstallationManifest,
    type InstallationManifest,
} from '../shared/installation.ts';
import { SETUP_OWNER, SETUP_PAYLOAD } from './installation-maintenance.ts';
import { createLinuxInitialUninstall } from './linux-initial-uninstall.ts';
import {
    checkedLinuxMenuRecord,
    desiredLinuxMenu,
    linuxMenuPaths,
    prepareLinuxMenuJournal,
    assertLinuxMenuAdvance,
    assertLinuxMenuPhase,
    sameLinuxMenu,
    type LinuxMenuFile,
    type LinuxMenuRecord,
    type LinuxMenuView,
} from './linux-menu-ownership.ts';

export interface LinuxNativeOps {
    platform: string;
    arch: string;
    pid: number;
    uid(): number;
    euid(): number;
    executable: string;
    now(): number;
    uuid(): string;
    fs: Pick<
        typeof physicalFS,
        | 'constants'
        | 'openSync'
        | 'fstatSync'
        | 'lstatSync'
        | 'readSync'
        | 'writeSync'
        | 'closeSync'
        | 'ftruncateSync'
        | 'fsyncSync'
        | 'mkdirSync'
        | 'readlinkSync'
        | 'realpathSync'
        | 'opendirSync'
        | 'statfsSync'
    >;
    server(): Server;
    later(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    cancel(timer: ReturnType<typeof setTimeout>): void;
    /** Linux renameat2(RENAME_NOREPLACE) equivalent over pinned parent FDs; no Node rename fallback. */
    moveNoReplace:
        | null
        | ((
              sourceParentFD: number,
              sourceName: string,
              destinationParentFD: number,
              destinationName: string,
          ) => void);
    /** ABI2 only. Concrete removal admits only a freshly quarantined/verified private slot. */
    unlinkOwned?: null | import('./linux-rename-noreplace.ts').LinuxUnlinkOwned;
}
export interface LinuxNativeWindow {
    startedMs: number;
    deadlineMs: number;
}
export type LinuxUnqualifiedEffects = Omit<LinuxMemoryEffects, 'kind'> & {
    kind: 'native-unqualified';
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const sameInode = (a: Stats, b: Stats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink;
const stable = (a: Stats, b: Stats) =>
    sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const inside = (root: string, file: string) => file === root || file.startsWith(root + '/');
const id = (stat: Stats) => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
const normalPath = (text: string) =>
    typeof text === 'string' &&
    text.startsWith('/') &&
    path.posix.normalize(text) === text &&
    !/[\\\x00-\x1f\x7f]/.test(text);
const PROC_TEXT = 8192,
    MAX_PIDS = 4096,
    MAX_ENTRIES = 20010;
function defaultOps(): LinuxNativeOps {
    return {
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uid: () => process.getuid!(),
        euid: () => process.geteuid!(),
        executable: process.execPath,
        now: () => performance.now(),
        uuid: randomUUID,
        fs: physicalFS,
        server: () => createServer({ pauseOnConnect: true, allowHalfOpen: false }),
        later: (callback, milliseconds) => setTimeout(callback, milliseconds),
        cancel: clearTimeout,
        moveNoReplace: null,
    };
}
/** Parse stat field22 after the final comm terminator; no command line or environment is read. */
export function linuxProcIdentity(text: string, pid: number) {
    if (Buffer.byteLength(text) > PROC_TEXT || !text.startsWith(pid + ' ('))
        throw Error('NATIVE_PROC_IDENTITY');
    const split = text.lastIndexOf(') '),
        fields = text
            .slice(split + 2)
            .trim()
            .split(/\s+/);
    if (
        split < 0 ||
        fields.length < 20 ||
        !/^[A-Za-z]$/.test(fields[0]) ||
        !/^[1-9][0-9]{0,19}$/.test(fields[19])
    )
        throw Error('NATIVE_PROC_IDENTITY');
    return { state: fields[0], startTicks: fields[19] };
}

/** Concrete built-in operations, inert until invoked. No native driver/production registration. */
export function createLinuxNativeBackend(
    input: LinuxModelPlan,
    window: LinuxNativeWindow,
    supplied?: LinuxNativeOps,
) {
    const plan = checkedLinuxModelPlan(input);
    return createBackend(
        plan,
        window,
        supplied ?? defaultOps(),
        false,
        Boolean(plan.review.history),
    );
}
/** Own a real read-only preparation before a prompt. No fabricated review or consent is supplied. */
export function createLinuxNativePreparationBackend(
    input: LinuxModelConfiguration,
    window: LinuxNativeWindow,
    supplied: LinuxNativeOps,
    menuDataHome?: string,
) {
    return createBackend(
        checkedLinuxModelConfiguration(input),
        window,
        supplied,
        true,
        false,
        menuDataHome,
    );
}
function createBackend(
    selected: LinuxModelConfiguration,
    window: LinuxNativeWindow,
    ops: LinuxNativeOps,
    preparing: boolean,
    retainedHistory = false,
    menuDataHome?: string,
) {
    let plan = selected;
    const continuation = preparing || retainedHistory;
    const fs = ops.fs,
        C = fs.constants;
    if (ops.platform !== 'linux' || ops.arch !== 'x64') throw Error('NATIVE_UNSUPPORTED_PLATFORM');
    if (
        !Number.isFinite(window.startedMs) ||
        !Number.isFinite(window.deadlineMs) ||
        window.deadlineMs <= window.startedMs ||
        window.deadlineMs - window.startedMs > 120000
    )
        throw Error('NATIVE_WINDOW');
    window = { ...window };
    for (const name of ['O_NOFOLLOW', 'O_NONBLOCK', 'O_DIRECTORY', 'O_EXCL', 'O_CREAT'] as const)
        if (!Number.isInteger(C[name]) || C[name] === 0) throw Error('NATIVE_REQUIRED_FLAG');
    const work = path.posix.join(
        path.posix.dirname(plan.root),
        '.DiagnosticHub-maintenance-' + hash(plan.root).slice(0, 20),
    );
    const fixed: LinuxModelScope = {
        root: plan.root,
        source: plan.host.sourceRoot,
        stage: work + '/stage-' + plan.transactionId,
        previous: work + '/previous-' + plan.transactionId,
        uid: plan.host.uid,
        key: 'dh-linux-' + hash(plan.host.uid + '\0' + plan.root),
    };
    let menuPaths = plan.menu ? linuxMenuPaths(plan, work) : null;
    const state = {
        failed: false,
        code: 'UNSTARTED',
        pending: null as string | null,
        fds: new Set<number>(),
        dirs: new Set<Dir>(),
        servers: new Set<Server>(),
        sockets: new Set<object>(),
        timers: new Set<ReturnType<typeof setTimeout>>(),
        allocations: new Set<string>(),
        lastReturned: null as unknown,
        primarySet: false,
        primary: undefined as unknown,
        releaseKnown: false,
        lateEvents: 0,
    };
    let attempted = false,
        lease: LinuxModelLease | null = null,
        leaseIdentity: LinuxReservationIdentity | null = null;
    const fail = (code: string): never => {
        state.failed = true;
        state.code = code;
        throw Error(code);
    };
    const gate = () => {
        if (state.failed) throw Error(state.code);
        const now = ops.now();
        if (!Number.isFinite(now) || now < window.startedMs || now >= window.deadlineMs)
            fail('NATIVE_DEADLINE');
    };
    const call = <T>(
        stage: string,
        operation: () => T,
        retain: (value: T) => void = () => {},
    ): T => {
        gate();
        state.pending = stage;
        let value: T;
        try {
            value = operation();
        } catch (error) {
            if (!state.primarySet) {state.primarySet = true; state.primary = error;}
            return fail('NATIVE_IO_UNKNOWN');
        }
        state.lastReturned = value;
        retain(value);
        gate();
        state.pending = null;
        return value;
    };
    const maybeStat = (file: string) =>
        call('lstat', () => {
            try {
                return fs.lstatSync(file);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        });
    const stat = (file: string) => {
        const value = maybeStat(file);
        if (!value) fail('NATIVE_REQUIRED_PATH');
        return value!;
    };
    const open = (file: string, flags: number, mode?: number) =>
        call(
            'open',
            () => fs.openSync(file, flags, mode),
            (fd) => state.fds.add(fd),
        );
    const close = (fd: number) =>
        call(
            'close',
            () => fs.closeSync(fd),
            () => state.fds.delete(fd),
        );
    const fstat = (fd: number) => call('fstat', () => fs.fstatSync(fd));
    const fdPath = (fd: number) => {
        if (!Number.isInteger(fd) || fd < 0 || !state.fds.has(fd)) return fail('NATIVE_FD_CUSTODY');
        return '/proc/self/fd/' + fd;
    };
    const plainDirectory = (value: Stats, logical: string, privateDirectory = false) => {
        if (
            !value.isDirectory() ||
            value.isSymbolicLink() ||
            !Number.isSafeInteger(value.dev) ||
            !Number.isSafeInteger(value.ino) ||
            value.ino <= 0 ||
            value.dev < 0 ||
            !Number.isSafeInteger(value.nlink) || value.nlink < 1 ||
            (inside(plan.host.home, logical)
                ? value.uid !== plan.host.uid
                : value.uid !== 0 && value.uid !== plan.host.uid) ||
            (value.mode & 0o7022) !== 0 ||
            (privateDirectory && (value.mode & 0o077) !== 0)
        )
            fail('NATIVE_DIRECTORY_IDENTITY');
    };
    const regular = (value: Stats, cap: number, privateFile: boolean) => {
        if (
            !value.isFile() ||
            value.isSymbolicLink() ||
            value.nlink !== 1 ||
            value.uid !== plan.host.uid ||
            !Number.isSafeInteger(value.ino) ||
            value.ino <= 0 ||
            !Number.isSafeInteger(value.dev) ||
            value.dev < 0 ||
            !Number.isFinite(value.mtimeMs) ||
            !Number.isFinite(value.ctimeMs) ||
            !Number.isSafeInteger(value.size) ||
            value.size < 0 ||
            value.size > cap ||
            (value.mode & 0o7022) !== 0 ||
            (privateFile && (value.mode & 0o077) !== 0)
        )
            fail('NATIVE_REGULAR_IDENTITY');
    };
    // Pinned ancestors prevent an alias/replacement from redirecting an operation into a foreign parent.
    const pin = (directory: string) => {
        if (!normalPath(directory)) return fail('NATIVE_PATH');
        const held: { fd: number; logical: string; before: Stats }[] = [];
        let fd = open('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK),
            logical = '/';
        let before = fstat(fd);
        plainDirectory(before, logical);
        held.push({ fd, logical, before });
        for (const part of directory.split('/').filter(Boolean)) {
            logical = path.posix.join(logical, part);
            fd = open(
                fdPath(fd) + '/' + part,
                C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK,
            );
            before = fstat(fd);
            plainDirectory(before, logical);
            held.push({ fd, logical, before });
        }
        const check = () => {
            for (const item of held)
                if (
                    !sameInode(item.before, stat(item.logical)) ||
                    call('canonical-fd', () => fs.realpathSync(fdPath(item.fd))) !== item.logical
                )
                    fail('NATIVE_PARENT_CHANGED');
        };
        check();
        return {
            fd,
            check,
            acknowledgeDirectoryLinks(changes: readonly {path: string; delta: number}[]) {
                for (const item of held) {
                    const delta = changes.filter((change) => change.path === item.logical)
                        .reduce((sum, change) => sum + change.delta, 0);
                    if (!delta) continue;
                    const active = fstat(item.fd);
                    const expectedLinks = item.before.nlink === 1 ? 1 : item.before.nlink + delta;
                    if (active.dev !== item.before.dev || active.ino !== item.before.ino ||
                        active.uid !== item.before.uid || active.mode !== item.before.mode ||
                        active.nlink !== expectedLinks || active.nlink < 1)
                        fail('NATIVE_PARENT_CHANGED');
                    item.before = active;
                }
                check();
            },
            finish() {
                check();
                for (const item of held.reverse()) close(item.fd);
            },
        };
    };
    const names = (directory: string, limit: number) => {
        const parent = pin(directory),
            dir = call(
                'opendir',
                () => fs.opendirSync(fdPath(parent.fd)),
                (value) => state.dirs.add(value),
            ),
            result: string[] = [];
        for (;;) {
            const entry = call('readdir', () => dir.readSync());
            if (!entry) break;
            if (
                result.length >= limit ||
                !entry.name ||
                /[\/\x00]/.test(entry.name) ||
                entry.name === '.' ||
                entry.name === '..'
            )
                fail('NATIVE_INVENTORY_BOUND');
            result.push(entry.name);
        }
        call(
            'closedir',
            () => dir.closeSync(),
            () => state.dirs.delete(dir),
        );
        parent.finish();
        return result.sort();
    };
    const read = (file: string, cap: number, privateFile = true, proc = false) => {
        const parent = pin(path.posix.dirname(file)),
            anchored = fdPath(parent.fd) + '/' + path.posix.basename(file),
            before = stat(anchored);
        regular(before, proc ? Number.MAX_SAFE_INTEGER : cap, privateFile);
        const fd = open(anchored, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK),
            active = fstat(fd);
        if (!sameInode(before, active)) fail('NATIVE_READ_CHANGED');
        const buffer = Buffer.alloc(cap + 1);
        let total = 0;
        while (total < buffer.length) {
            const count = call('read', () =>
                fs.readSync(fd, buffer, total, buffer.length - total, total),
            );
            if (!count) break;
            total += count;
        }
        if (
            total > cap ||
            (!proc && total !== before.size) ||
            !stable(active, fstat(fd)) ||
            !sameInode(before, stat(anchored))
        )
            fail('NATIVE_READ_CHANGED');
        close(fd);
        parent.finish();
        return buffer.subarray(0, total);
    };
    const json = (file: string, cap = 16384) => {
        try {
            return JSON.parse(read(file, cap).toString('utf8')) as unknown;
        } catch {
            return fail('NATIVE_METADATA');
        }
    };
    const manifest = (value: unknown) => {
        const result = validateInstallationManifest(value);
        if (
            result.layout !== 'linux-folder' ||
            result.platform !== 'linux' ||
            result.arch !== 'x64' ||
            result.files.some((file) => file.kind !== 'file')
        )
            return fail('NATIVE_LAYOUT');
        return result;
    };
    const manifestHash = (value: InstallationManifest) => hash(JSON.stringify(value));
    const fileHash = (file: string, expectedBytes: number, snapshots?: Map<string, Stats>) => {
        const parent = pin(path.posix.dirname(file)),
            anchored = fdPath(parent.fd) + '/' + path.posix.basename(file),
            before = stat(anchored);
        regular(before, expectedBytes, false);
        if (before.size !== expectedBytes) fail('NATIVE_PAYLOAD_SIZE');
        const fd = open(anchored, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK),
            active = fstat(fd),
            buffer = Buffer.alloc(65536),
            digest = createHash('sha256');
        if (!sameInode(before, active)) fail('NATIVE_PAYLOAD_CHANGED');
        let total = 0;
        for (;;) {
            const count = call('hash-read', () =>
                fs.readSync(
                    fd,
                    buffer,
                    0,
                    Math.min(buffer.length, expectedBytes - total + 1),
                    total,
                ),
            );
            if (!count) break;
            total += count;
            if (total > expectedBytes) fail('NATIVE_PAYLOAD_SIZE');
            digest.update(buffer.subarray(0, count));
        }
        if (
            total !== expectedBytes ||
            !stable(active, fstat(fd)) ||
            !sameInode(before, stat(anchored))
        )
            fail('NATIVE_PAYLOAD_CHANGED');
        close(fd);
        parent.finish();
        snapshots?.set(file, before);
        return digest.digest('hex');
    };
    const inventory = (directory: string, release: InstallationManifest, extra: string[]) => {
        const files = new Set([...release.files.map((file) => file.path), ...extra]),
            dirs = new Set<string>();
        for (const name of files) {
            let item = path.posix.dirname(name);
            while (item !== '.') {
                dirs.add(item);
                item = path.posix.dirname(item);
            }
        }
        let count = 0;
        const snapshots = new Map<string, Stats>();
        const visit = (current: string) => {
            snapshots.set(current, stat(current));
            for (const name of names(current, MAX_ENTRIES)) {
                if (++count > MAX_ENTRIES) fail('NATIVE_INVENTORY_BOUND');
                const file = path.posix.join(current, name),
                    relative = path.posix.relative(directory, file),
                    currentStat = stat(file);
                if (
                    currentStat.isDirectory() &&
                    !currentStat.isSymbolicLink() &&
                    dirs.has(relative)
                ) {
                    plainDirectory(currentStat, file);
                    visit(file);
                } else if (!files.has(relative)) fail('NATIVE_FOREIGN_CONTENT');
                else regular(currentStat, 2 * 1024 ** 3, false);
            }
        };
        visit(directory);
        for (const file of release.files) {
            if (
                file.kind !== 'file' ||
                fileHash(path.posix.join(directory, file.path), file.bytes, snapshots) !==
                    file.sha256
            )
                fail('NATIVE_PAYLOAD_CHECKSUM');
        }
        for (const [file, before] of snapshots)
            if (!stable(before, stat(file))) fail('NATIVE_INVENTORY_CHANGED');
    };
    const procOwner = () => {
        if (
            ops.platform !== 'linux' ||
            ops.arch !== 'x64' ||
            call('uid', ops.uid) !== plan.host.uid ||
            call('euid', ops.euid) !== plan.host.uid ||
            ops.pid !== plan.owner.pid
        )
            fail('NATIVE_HOST_IDENTITY');
        const file = '/proc/' + ops.pid,
            parsed = linuxProcIdentity(
                read(file + '/stat', PROC_TEXT, false, true).toString('utf8'),
                ops.pid,
            );
        const executable = call('self-exe', () => fs.readlinkSync(file + '/exe'));
        if (
            parsed.state === 'Z' ||
            parsed.startTicks !== plan.owner.startTicks ||
            executable !== ops.executable ||
            executable !== plan.owner.executable
        )
            fail('NATIVE_HOST_IDENTITY');
        if (
            linuxProcIdentity(
                read(file + '/stat', PROC_TEXT, false, true).toString('utf8'),
                ops.pid,
            ).startTicks !== parsed.startTicks
        )
            fail('NATIVE_HOST_IDENTITY');
        return copy(plan.owner);
    };
    const scopeCheck = (scope: LinuxModelScope) => {
        if (
            JSON.stringify(scope) !== JSON.stringify(fixed) &&
            (Object.keys(scope).length !== Object.keys(fixed).length ||
                (Object.keys(fixed) as (keyof LinuxModelScope)[]).some(
                    (key) => scope[key] !== fixed[key],
                ))
        )
            fail('NATIVE_SCOPE');
    };
    const parents = (): LinuxModelParent[] => {
        const expected = new Set<string>(['/']);
        for (const target of [
            path.posix.dirname(plan.root),
            plan.host.sourceRoot,
            plan.host.appData,
            ...(plan.menu ? [path.posix.join(plan.menu.dataHome, 'applications')] : []),
        ]) {
            let current = target;
            for (;;) {
                expected.add(current);
                if (current === '/') break;
                current = path.posix.dirname(current);
            }
        }
        return [...expected].sort().map((file) => {
            const anchored = pin(file),
                value = fstat(anchored.fd);
            anchored.finish();
            return { path: file, ...id(value), mode: value.mode };
        });
    };
    const payload = (directory: string): LinuxModelPayload | null => {
        const before = maybeStat(directory);
        if (!before) return null;
        plainDirectory(before, directory, true);
        const record = validateInstallationRecord(json(directory + '/' + INSTALLATION_RECORD));
        const raw = read(directory + '/' + INSTALLATION_MANIFEST, MAX_INSTALLATION_MANIFEST_BYTES),
            release = manifest(JSON.parse(raw.toString('utf8')));
        const owner = json(directory + '/' + SETUP_OWNER) as Record<string, unknown>,
            options = owner?.options as Record<string, unknown>;
        if (
            record.profile !== 'dedicated' ||
            record.manifestSHA256 !== hash(raw) ||
            record.installationId !== plan.installationId ||
            owner?.schemaVersion !== 1 ||
            owner.product !== INSTALLATION_PRODUCT ||
            owner.root !== plan.root ||
            owner.installationId !== record.installationId ||
            typeof owner.transactionId !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(owner.transactionId) ||
            !Array.isArray(owner.integrations) ||
            owner.integrations.length > 1 ||
            (!plan.menu && owner.integrations.length !== 0) ||
            !options ||
            Object.keys(options).length !== 3 ||
            !['startMenu', 'desktop', 'launch'].every((key) => typeof options[key] === 'boolean') ||
            Object.keys(owner).some(
                (key) =>
                    ![
                        'schemaVersion',
                        'product',
                        'root',
                        'installationId',
                        'transactionId',
                        'options',
                        'integrations',
                    ].includes(key),
            )
        )
            fail('NATIVE_OWNERSHIP');
        const menuRecord =
            (owner.integrations as unknown[]).length === 1
                ? checkedLinuxMenuRecord((owner.integrations as unknown[])[0], plan)
                : undefined;
        if (menuRecord && (!options.startMenu || options.desktop || options.launch))
            fail('NATIVE_MENU_OPTIONS');
        inventory(directory, release, [INSTALLATION_RECORD, INSTALLATION_MANIFEST, SETUP_OWNER]);
        if (!stable(before, stat(directory))) fail('NATIVE_SLOT_CHANGED');
        return {
            identity: id(before),
            ...(menuRecord ? { menu: copy(menuRecord) } : {}),
            manifest: release,
            verifiedManifestSHA256: manifestHash(release),
            installationId: record.installationId,
            transactionId: owner.transactionId as string,
            root: plan.root,
            profile: path.posix.join(
                plan.host.appData,
                'DiagnosticHub',
                'profiles',
                record.installationId,
            ),
        };
    };
    const activity = (retained: string[] = []) => {
        const locations = {
            root: fixed.root,
            stage: fixed.stage,
            previous: fixed.previous,
            ...Object.fromEntries(retained.map((file, index) => ['retained-' + index, file])),
        };
        const result: Record<string, 'inactive' | 'active' | 'unknown'> = {
            root: 'inactive',
            stage: 'inactive',
            previous: 'inactive',
            ...Object.fromEntries(
                retained.map((_, index) => ['retained-' + index, 'inactive' as const]),
            ),
        };
        const unknown = () =>
            Object.fromEntries(Object.keys(locations).map((key) => [key, 'unknown' as const]));
        const before = names('/proc', MAX_PIDS + 1024).filter((name) => /^[1-9][0-9]*$/.test(name));
        if (before.length > MAX_PIDS) return unknown();
        for (const text of before) {
            const directory = '/proc/' + text,
                owner = maybeStat(directory);
            if (!owner) return unknown();
            // Every replaceable app slot is private0700; other ordinary UIDs cannot execute within it.
            if (owner.uid !== plan.host.uid) continue;
            const first = linuxProcIdentity(
                read(directory + '/stat', PROC_TEXT, false, true).toString('utf8'),
                Number(text),
            );
            if (first.state === 'Z') continue;
            const executable = call('proc-exe', () => {
                try {
                    return fs.readlinkSync(directory + '/exe');
                } catch (error) {
                    if (
                        ['ENOENT', 'EACCES', 'EPERM'].includes(
                            (error as NodeJS.ErrnoException).code ?? '',
                        )
                    )
                        return null;
                    throw error;
                }
            });
            if (executable === null || !normalPath(executable)) return unknown();
            const last = linuxProcIdentity(
                read(directory + '/stat', PROC_TEXT, false, true).toString('utf8'),
                Number(text),
            );
            if (first.startTicks !== last.startTicks || !sameInode(owner, stat(directory)))
                return unknown();
            for (const [slot, location] of Object.entries(locations))
                if (inside(location, executable)) result[slot] = 'active';
        }
        if (
            JSON.stringify(before) !==
            JSON.stringify(
                names('/proc', MAX_PIDS + 1024).filter((name) => /^[1-9][0-9]*$/.test(name)),
            )
        )
            return unknown();
        return result;
    };
    // Desktop files keep their admitted mode when retained/restored. Their containing work directory
    // remains private; journal/owner JSON still uses the separate strict private-file policy.
    const menuFile = (file: string): LinuxMenuFile | null => {
        const parent = pin(path.posix.dirname(file));
        const anchored = fdPath(parent.fd) + '/' + path.posix.basename(file);
        const before = maybeStat(anchored);
        if (before === null) {
            parent.finish();
            return null;
        }
        regular(before, 8192, false);
        const bytes = read(file, 8192, false);
        if (bytes.length === 0 || !stable(before, stat(anchored))) fail('NATIVE_MENU_CHANGED');
        parent.finish();
        return { identity: id(before), bytes: bytes.length, sha256: hash(bytes) };
    };
    const sourceObservation = (): LinuxModelSource => {
        procOwner();
        const sourceStat = stat(plan.host.sourceRoot);
        plainDirectory(sourceStat, plan.host.sourceRoot);
        const release = manifest(
            json(plan.host.sourceRoot + '/' + SETUP_PAYLOAD, MAX_INSTALLATION_MANIFEST_BYTES),
        );
        if (release.version !== plan.host.version) fail('NATIVE_SOURCE_VERSION');
        inventory(plan.host.sourceRoot, release, [SETUP_PAYLOAD]);
        if (!stable(sourceStat, stat(plan.host.sourceRoot))) fail('NATIVE_SOURCE_CHANGED');
        return {identity: id(sourceStat),manifest: release,verifiedManifestSHA256: manifestHash(release)};
    };
    const observe = (scope: LinuxModelScope): LinuxModelView => {
        scopeCheck(scope);
        if (plan.action !== 'uninstall-current') {
            if (maybeStat(work + '-uninstall') && !completedRemoval) return fail('NATIVE_REMOVAL_PENDING_OR_RETAINED');
            completedRemoval?.completed();
        }
        const source = sourceObservation();
        const workStat = maybeStat(work);
        let journal: LinuxModelJournal | null = null;
        let journalOriginal: { base64: string; sha256: string } | null = null;
        let completed: NonNullable<LinuxModelView['history']>['completed'] = null;
        let lineage: LinuxRetainedGeneration[] = [];
        if (workStat) {
            plainDirectory(workStat, work, true);
            const entries = names(
                work,
                (menuPaths ? 5 : 3) + (continuation ? 1 + MAX_LINUX_RETAINED_GENERATIONS * 2 : 0),
            );
            if (!continuation) {
                const legacy = new Set([
                    'journal.json',
                    path.posix.basename(fixed.stage),
                    path.posix.basename(fixed.previous),
                    ...(menuPaths ? ['menu-candidate.desktop', 'menu-previous.desktop'] : []),
                ]);
                if (entries.some((name) => !legacy.has(name))) fail('NATIVE_FOREIGN_MAINTENANCE');
            }
            if (continuation && maybeStat(work + '/completed-journal.json')) {
                const bytes = read(work + '/completed-journal.json', 8192);
                completed = {
                    journal: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
                    base64: bytes.toString('base64'),
                    sha256: hash(bytes),
                };
            }
            if (maybeStat(work + '/journal.json')) {
                if (continuation) {
                    const bytes = read(work + '/journal.json', 8192);
                    journal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                    journalOriginal = { base64: bytes.toString('base64'), sha256: hash(bytes) };
                } else journal = json(work + '/journal.json') as LinuxModelJournal;
            } else if (!completed && !state.allocations.has(work))
                fail('NATIVE_FOREIGN_MAINTENANCE');
            const archives = entries.filter((name) =>
                /^retained-journal-[a-f0-9-]{36}\.json$/.test(name),
            );
            if (
                archives.length > MAX_LINUX_RETAINED_GENERATIONS ||
                (archives.length && (!completed || menuPaths))
            )
                fail('NATIVE_RETAINED_HISTORY');
            const unordered: LinuxRetainedGeneration[] = archives.map((name) => {
                const bytes = read(work + '/' + name, 8192),
                    saved = JSON.parse(
                        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                    ) as LinuxModelJournal;
                if (
                    typeof saved.transactionId !== 'string' ||
                    name !== 'retained-journal-' + saved.transactionId + '.json' ||
                    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                        saved.transactionId,
                    )
                )
                    return fail('NATIVE_RETAINED_HISTORY');
                const previous = payload(work + '/previous-' + saved.transactionId);
                if (!previous) return fail('NATIVE_RETAINED_HISTORY');
                return {
                    archived: true,
                    base64: bytes.toString('base64'),
                    sha256: hash(bytes),
                    journal: saved,
                    previous,
                    activity: 'inactive',
                };
            });
            let preceding = completed?.journal;
            while (unordered.length) {
                const next = unordered.filter(
                    (entry) =>
                        entry.previous.transactionId === preceding?.transactionId &&
                        entry.journal.previousSHA256 === preceding?.candidateSHA256,
                );
                if (next.length !== 1) fail('NATIVE_RETAINED_CHAIN');
                const selected = next[0];
                lineage.push(selected);
                unordered.splice(unordered.indexOf(selected), 1);
                preceding = selected.journal;
            }
            if (
                continuation &&
                completed &&
                journal &&
                journal.transactionId !== plan.transactionId &&
                journal.phase === 'candidate-active' &&
                journal.previousSHA256 !== null
            ) {
                if (
                    menuPaths ||
                    lineage.length >= MAX_LINUX_RETAINED_GENERATIONS ||
                    !journalOriginal
                )
                    fail('NATIVE_RETAINED_HISTORY');
                const previous = payload(work + '/previous-' + journal.transactionId);
                if (!previous) fail('NATIVE_RETAINED_HISTORY');
                lineage.push({
                    archived: false,
                    ...journalOriginal!,
                    journal,
                    previous: previous!,
                    activity: 'inactive',
                });
            }
            const allowed = new Set([
                'journal.json',
                ...(continuation ? ['completed-journal.json'] : []),
                path.posix.basename(fixed.stage),
                path.posix.basename(fixed.previous),
                ...(menuPaths ? ['menu-candidate.desktop', 'menu-previous.desktop'] : []),
                ...lineage.flatMap((entry) => [
                    'previous-' + entry.journal.transactionId,
                    ...(entry.archived
                        ? ['retained-journal-' + entry.journal.transactionId + '.json']
                        : []),
                ]),
            ]);
            if (entries.some((name) => !allowed.has(name))) fail('NATIVE_FOREIGN_MAINTENANCE');
        }
        const sampledActivity = activity(
            lineage.map((entry) => work + '/previous-' + entry.journal.transactionId),
        );
        lineage = lineage.map((entry, index) => ({
            ...entry,
            activity: sampledActivity['retained-' + index],
        }));
        const view: LinuxModelView = {
            parents: parents(),
            source,
            root: payload(fixed.root),
            stage: payload(fixed.stage),
            previous: payload(fixed.previous),
            journal,
            ...(continuation
                ? {
                      history: {
                          journalOriginal,
                          completed,
                          ...(lineage.length ? { lineage } : {}),
                      },
                  }
                : {}),
            activity: {
                root: sampledActivity.root,
                stage: sampledActivity.stage,
                previous: sampledActivity.previous,
            },
            ...(menuPaths
                ? {
                      menu: {
                          current: menuFile(menuPaths.current),
                          candidate: workStat ? menuFile(menuPaths.candidate) : null,
                          previous: workStat ? menuFile(menuPaths.previous) : null,
                      },
                  }
                : {}),
        };
        // Validate all file/journal/slot grammar while preserving truthful unknown/active activity output.
        checkedLinuxModelView(
            {
                ...copy(view),
                activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
                ...(view.history?.lineage
                    ? {
                          history: {
                              ...view.history,
                              lineage: view.history.lineage.map((entry) => ({
                                  ...entry,
                                  activity: 'inactive' as const,
                              })),
                          },
                      }
                    : {}),
            },
            plan,
        );
        return view;
    };
    const wait = <T>(submit: (done: (error: unknown, value?: T) => void) => void): Promise<T> => {
        gate();
        state.pending = 'kernel-event';
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                timer = call(
                    'timer-create',
                    () =>
                        ops.later(() => {
                            if (timer !== undefined) state.timers.delete(timer);
                            if (settled) return;
                            settled = true;
                            state.failed = true;
                            state.code = 'NATIVE_DEADLINE';
                            reject(Error(state.code));
                        }, window.deadlineMs - ops.now()),
                    (value) => state.timers.add(value),
                );
            } catch {
                reject(Error(state.code));
                return;
            }
            const done = (error: unknown, value?: T, thrown = false) => {
                const failure = thrown || (error !== null && error !== undefined);
                // Capture the actual first failure before timer/gate work can produce a secondary.
                // Repeated callbacks are late failures even when their value is undefined.
                if ((failure || settled) && !state.primarySet) {state.primarySet=true;state.primary=error;}
                if (settled) {
                    state.lateEvents++;
                    state.failed = true;
                    state.code = 'NATIVE_LATE_EVENT';
                    return;
                }
                settled = true;
                try {
                    gate();
                    call(
                        'timer-cancel',
                        () => ops.cancel(timer!),
                        () => state.timers.delete(timer!),
                    );
                } catch {
                    state.failed = true;
                    state.code = 'NATIVE_TIMER_UNKNOWN';
                    reject(Error(state.code));
                    return;
                }
                if (failure) {
                    state.failed = true;
                    state.code = 'NATIVE_KERNEL_UNKNOWN';
                    reject(Error(state.code));
                    return;
                }
                state.lastReturned = value;
                try {
                    gate();
                    state.pending = null;
                    resolve(value as T);
                } catch (failure) {
                    reject(failure);
                }
            };
            try {
                gate();
                submit((error,value) => done(error,value));
            } catch (error) {
                done(error,undefined,true);
            }
        });
    };
    const kernel: LinuxModelKernel = {
        async acquire(wanted) {
            gate();
            if (attempted) return fail('NATIVE_RESERVATION_CONSUMED');
            attempted = true;
            const owner = procOwner();
            if (
                wanted.root !== fixed.root ||
                wanted.uid !== fixed.uid ||
                wanted.key !== fixed.key ||
                JSON.stringify(wanted.owner) !== JSON.stringify(owner)
            )
                return fail('NATIVE_RESERVATION_BINDING');
            const server = call('server-create', ops.server, (value) => state.servers.add(value)),
                endpoint = '\0' + fixed.key;
            // No request protocol/data read. Only sockets accepted by this newly owned reservation are rejected.
            server.on('connection', (socket) => {
                state.sockets.add(socket); // Capture before gates; later/failed returns remain owned.
                try {
                    // Event containment is bookkeeping, not an OS action; install before any refusal gate.
                    socket.on('error', () => {});
                    gate();
                    socket.once('close', () => state.sockets.delete(socket));
                    gate();
                    socket.destroy();
                    gate();
                } catch {
                    state.failed = true;
                    if (state.code === 'UNSTARTED') state.code = 'NATIVE_CONNECTION_UNKNOWN';
                }
            });
            const available = await wait<boolean>((done) => {
                server.on('error', (error: NodeJS.ErrnoException) => {
                    if (error.code === 'EADDRINUSE' && !server.listening && !lease)
                        done(null, false);
                    else {
                        state.failed = true;
                        state.code = 'NATIVE_KERNEL_UNKNOWN';
                        done(error);
                    }
                });
                server.once('listening', () => done(null, true));
                server.listen({ path: endpoint, exclusive: true, backlog: 1 });
            });
            if (!available) return null;
            if (!server.listening || server.address() !== endpoint)
                return fail('NATIVE_RESERVATION_ADDRESS');
            const identity = { ...copy(wanted), token: call('reservation-token', ops.uuid) };
            if (
                !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                    identity.token,
                )
            )
                return fail('NATIVE_RESERVATION_TOKEN');
            leaseIdentity = copy(identity);
            lease = { identity: copy(identity), handle: server };
            return { identity: copy(identity), handle: server };
        },
        async current(handle) {
            gate();
            procOwner();
            if (
                !lease ||
                !leaseIdentity ||
                lease.handle !== handle ||
                !(handle as Server).listening ||
                (handle as Server).address() !== '\0' + fixed.key
            )
                return fail('NATIVE_RESERVATION_LOST');
            return copy(leaseIdentity);
        },
        async release(handle, expected) {
            const current = await this.current(handle);
            if (JSON.stringify(current) !== JSON.stringify(expected))
                return fail('NATIVE_RESERVATION_RELEASE_BINDING');
            await wait<void>((done) => (handle as Server).close((error) => done(error)));
            // Adopt terminal owned-resource state before applying a sticky late-error fence.
            // This read cannot authorize another mutation or clear the recorded failure.
            state.pending = 'server-close-state';
            let closed: boolean;
            try {closed = state.sockets.size === 0 && !(handle as Server).listening && (handle as Server).address() === null;}
            catch (error) {if (!state.primarySet) {state.primarySet=true;state.primary=error;}return fail('NATIVE_RELEASE_UNCERTAIN');}
            state.lastReturned = closed; state.pending = null;
            if (closed) {state.servers.delete(handle as Server);lease=null;leaseIdentity=null;state.releaseKnown=true;}
            gate();
            if (!closed) fail('NATIVE_RELEASE_UNCERTAIN');
            return true;
        },
    };
    const protect = async <T>(operation: () => Promise<T> | T) => {
        try {
            gate();
            const value = await operation();
            gate();
            return value;
        } catch (error) {
            if (!state.primarySet) {state.primarySet = true; state.primary = error;}
            if (!state.failed) {
                state.failed = true;
                state.code = 'NATIVE_REFUSAL';
            }
            throw Error(state.code);
        }
    };
    const guard = async (scope: LinuxModelScope, expected: LinuxModelView) => {
        scopeCheck(scope);
        if (!lease || !leaseIdentity) return fail('NATIVE_RESERVATION_REQUIRED');
        await kernel.current(lease.handle);
        const captured = checkedLinuxModelView(expected, plan),
            actual = observe(scope);
        checkedLinuxModelView(actual, plan);
        if (linuxModelReviewSHA256(actual) !== linuxModelReviewSHA256(captured))
            fail('NATIVE_REVIEW_CHANGED');
        return captured;
    };
    const requireMutation = () => {
        gate();
        if (!ops.moveNoReplace) fail('NATIVE_ATOMIC_MOVE_UNAVAILABLE');
    };
    const space = (view: LinuxModelView, copying: boolean) => {
        const parent = pin(path.posix.dirname(plan.root));
        const available = call('statfs', () => fs.statfsSync(fdPath(parent.fd)));
        if (
            !Number.isSafeInteger(available.bavail) ||
            available.bavail < 0 ||
            !Number.isSafeInteger(available.bsize) ||
            available.bsize <= 0
        )
            fail('NATIVE_SPACE_UNSUPPORTED');
        const bytes = view.source.manifest.files.reduce(
            (total, file) => total + (file.kind === 'file' ? file.bytes : 0),
            0,
        );
        // Preserve the existing setup engine staging/recovery reserve; not a performance threshold.
        const required = copying ? bytes * 3 + 64 * 1024 ** 2 : 65536;
        if (BigInt(available.bavail) * BigInt(available.bsize) < BigInt(required))
            fail('NATIVE_SPACE');
        parent.finish();
    };
    const mkdirNew = (directory: string) => {
        const parent = pin(path.posix.dirname(directory));
        parent.check();
        call(
            'mkdir-exclusive',
            () =>
                fs.mkdirSync(fdPath(parent.fd) + '/' + path.posix.basename(directory), {
                    mode: 0o700,
                }),
            () => state.allocations.add(directory),
        );
        plainDirectory(stat(directory), directory, true);
        parent.acknowledgeDirectoryLinks([{path: path.posix.dirname(directory), delta: 1}]);
        call('parent-sync', () => fs.fsyncSync(parent.fd));
        parent.finish();
    };
    const write = (
        file: string,
        bytes: Buffer,
        exclusive: boolean,
        prior?: Buffer,
        mode = 0o600,
        cap = MAX_INSTALLATION_MANIFEST_BYTES,
    ) => {
        if (bytes.length > cap) return fail('NATIVE_WRITE_BOUND');
        const parent = pin(path.posix.dirname(file)),
            anchored = fdPath(parent.fd) + '/' + path.posix.basename(file),
            before = maybeStat(anchored);
        if (exclusive ? before !== null : before === null) return fail('NATIVE_WRITE_OWNERSHIP');
        if (before) regular(before, cap, true);
        const fd = open(
                anchored,
                C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | (exclusive ? C.O_CREAT | C.O_EXCL : 0),
                mode,
            ),
            active = fstat(fd);
        regular(active, cap, true);
        if (before && !sameInode(before, active)) fail('NATIVE_WRITE_CHANGED');
        if (prior) {
            const old = Buffer.alloc(prior.length + 1);
            let total = 0;
            while (total < old.length) {
                const count = call('journal-read', () =>
                    fs.readSync(fd, old, total, old.length - total, total),
                );
                if (!count) break;
                total += count;
            }
            if (
                total !== prior.length ||
                !old.subarray(0, total).equals(prior) ||
                !stable(active, fstat(fd))
            )
                fail('NATIVE_JOURNAL_CHANGED');
        }
        parent.check();
        let total = 0;
        while (total < bytes.length) {
            const count = call('write', () =>
                fs.writeSync(fd, bytes, total, Math.min(65536, bytes.length - total), total),
            );
            if (count <= 0) fail('NATIVE_WRITE_PROGRESS');
            total += count;
        }
        call('truncate', () => fs.ftruncateSync(fd, bytes.length));
        call('file-sync', () => fs.fsyncSync(fd));
        const check = Buffer.alloc(bytes.length + 1);
        let count = 0;
        while (count < check.length) {
            const size = call('write-readback', () =>
                fs.readSync(fd, check, count, check.length - count, count),
            );
            if (!size) break;
            count += size;
        }
        if (
            count !== bytes.length ||
            !check.subarray(0, count).equals(bytes) ||
            !sameInode(active, fstat(fd)) ||
            !sameInode(active, stat(anchored))
        )
            fail('NATIVE_WRITE_READBACK');
        call('parent-sync', () => fs.fsyncSync(parent.fd));
        close(fd);
        parent.finish();
    };
    const copyFile = (sourceFile: string, target: string, bytes: number, sha256: string) => {
        const sourceParent = pin(path.posix.dirname(sourceFile)),
            destinationParent = pin(path.posix.dirname(target));
        const sourcePath = fdPath(sourceParent.fd) + '/' + path.posix.basename(sourceFile),
            targetPath = fdPath(destinationParent.fd) + '/' + path.posix.basename(target);
        const before = stat(sourcePath);
        regular(before, bytes, false);
        if (before.size !== bytes) fail('NATIVE_COPY_SIZE');
        const inputFD = open(sourcePath, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK),
            outputFD = open(
                targetPath,
                C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK,
                before.mode & 0o777,
            );
        if (!sameInode(before, fstat(inputFD))) fail('NATIVE_COPY_CHANGED');
        const created = fstat(outputFD);
        regular(created, bytes, false);
        if ((created.mode & 0o777) !== (before.mode & 0o777)) fail('NATIVE_COPY_MODE');
        const digest = createHash('sha256'),
            buffer = Buffer.alloc(65536);
        let total = 0;
        for (;;) {
            sourceParent.check();
            destinationParent.check();
            const count = call('copy-read', () =>
                fs.readSync(inputFD, buffer, 0, Math.min(buffer.length, bytes - total + 1), total),
            );
            if (!count) break;
            if (total + count > bytes) fail('NATIVE_COPY_SIZE');
            digest.update(buffer.subarray(0, count));
            let written = 0;
            while (written < count) {
                const amount = call('copy-write', () =>
                    fs.writeSync(outputFD, buffer, written, count - written, total + written),
                );
                if (amount <= 0) fail('NATIVE_WRITE_PROGRESS');
                written += amount;
            }
            total += count;
        }
        if (
            total !== bytes ||
            digest.digest('hex') !== sha256 ||
            !stable(before, fstat(inputFD)) ||
            !sameInode(before, stat(sourcePath)) ||
            !sameInode(created, stat(targetPath))
        )
            fail('NATIVE_COPY_CHANGED');
        call('file-sync', () => fs.fsyncSync(outputFD));
        call('parent-sync', () => fs.fsyncSync(destinationParent.fd));
        close(outputFD);
        close(inputFD);
        sourceParent.finish();
        destinationParent.finish();
        if (fileHash(target, bytes) !== sha256) fail('NATIVE_COPY_READBACK');
    };
    const effects: LinuxUnqualifiedEffects = {
        kind: 'native-unqualified',
        handoff(scope, expected) {
            return protect(async () => {
                requireMutation();
                const actual = await guard(copy(scope), copy(expected));
                const pending = actual.history?.lineage?.at(-1);
                if (
                    !continuation ||
                    !actual.history?.journalOriginal ||
                    (actual.history.completed && (!pending || pending.archived)) ||
                    !actual.journal ||
                    actual.journal.phase !== 'candidate-active' ||
                    (actual.journal.previousSHA256 !== null && !pending) ||
                    !actual.root ||
                    actual.stage ||
                    actual.previous ||
                    actual.root.transactionId !== actual.journal.transactionId ||
                    actual.root.verifiedManifestSHA256 !== actual.journal.candidateSHA256 ||
                    actual.journal.transactionId === plan.transactionId
                )
                    return fail('NATIVE_COMPLETED_HANDOFF');
                const parent = pin(work),
                    source = fdPath(parent.fd) + '/journal.json',
                    targetName = pending
                        ? 'retained-journal-' + actual.journal.transactionId + '.json'
                        : 'completed-journal.json',
                    target = fdPath(parent.fd) + '/' + targetName,
                    before = stat(source);
                regular(before, 8192, true);
                if (
                    maybeStat(target) ||
                    read(work + '/journal.json', 8192).toString('base64') !==
                        actual.history.journalOriginal.base64
                )
                    return fail('NATIVE_COMPLETED_HANDOFF_CHANGED');
                parent.check();
                call(
                    'completed-journal-noreplace',
                    () => ops.moveNoReplace!(parent.fd, 'journal.json', parent.fd, targetName),
                    () => state.allocations.add(work + '/' + targetName),
                );
                if (
                    maybeStat(source) ||
                    !sameInode(before, stat(target)) ||
                    read(work + '/' + targetName, 8192).toString('base64') !==
                        actual.history.journalOriginal.base64
                )
                    return fail('NATIVE_COMPLETED_HANDOFF_CHANGED');
                call('parent-sync', () => fs.fsyncSync(parent.fd));
                parent.finish();
                return observe(copy(scope));
            });
        },
        observe(scope) {
            return protect(() => observe(copy(scope)));
        },
        journal(scope, expected, next) {
            return protect(async () => {
                requireMutation();
                scope = copy(scope);
                expected = copy(expected);
                next = copy(next);
                const nextBytes = Buffer.from(JSON.stringify(next));
                if (nextBytes.length > 8192) fail('NATIVE_JOURNAL_BOUND');
                const actual = await guard(scope, expected);
                checkedLinuxModelView(
                    {
                        ...copy(actual),
                        journal: next,
                        ...(actual.history
                            ? {
                                  history: {
                                      ...copy(actual.history),
                                      journalOriginal: {
                                          base64: nextBytes.toString('base64'),
                                          sha256: hash(nextBytes),
                                      },
                                  },
                              }
                            : {}),
                    },
                    plan,
                );
                const previous = actual.journal;
                space(actual, previous === null && next.phase === 'copying');
                const phases: Record<string, string[]> = {
                    new: ['copying'],
                    copying: ['prepared'],
                    prepared: ['old-retained'],
                    'old-retained': ['candidate-active'],
                    'candidate-active': ['rollback-started'],
                    'rollback-started': ['rollback-started', 'candidate-retained'],
                    'candidate-retained': ['rolled-back'],
                };
                const menuAdvance = previous?.menu && next.menu && previous.phase === next.phase;
                if (menuAdvance) {
                    if (previous!.phase !== 'candidate-active') fail('NATIVE_MENU_PHASE');
                    assertLinuxMenuAdvance(previous!.menu!, next.menu!);
                    assertLinuxMenuPhase(actual.menu!, next.menu!, plan);
                } else if (!phases[previous?.phase ?? 'new']?.includes(next.phase))
                    fail('NATIVE_JOURNAL_PHASE');
                if (
                    previous &&
                    !sameLinuxMenu(
                        {
                            ...previous,
                            phase: next.phase,
                            ...(menuAdvance ? { menu: next.menu } : {}),
                        },
                        next,
                    )
                )
                    fail('NATIVE_JOURNAL_IDENTITY');
                if (
                    !previous &&
                    (next.candidateSHA256 !== actual.source.verifiedManifestSHA256 ||
                        next.previousSHA256 !== (actual.root?.verifiedManifestSHA256 ?? null) ||
                        JSON.stringify(next.owner) !== JSON.stringify(plan.owner))
                )
                    fail('NATIVE_JOURNAL_IDENTITY');
                if (plan.menu) {
                    if (!next.menu || !actual.menu) fail('NATIVE_MENU_JOURNAL');
                    if (previous === null) {
                        const declared = prepareLinuxMenuJournal(
                            plan,
                            actual.root?.menu ?? null,
                            actual.menu!.current,
                        );
                        if (
                            !sameLinuxMenu(next.menu, declared) ||
                            actual.menu!.candidate !== null ||
                            actual.menu!.previous !== null
                        )
                            fail('NATIVE_MENU_JOURNAL_IDENTITY');
                        // No-replace moves retain preimages; refuse cross-filesystem setup before mutation.
                        const a = pin(path.posix.dirname(menuPaths!.current)),
                            b = pin(path.posix.dirname(work));
                        const dev = fstat(a.fd).dev;
                        if (
                            dev !== fstat(b.fd).dev ||
                            (actual.menu!.current && actual.menu!.current.identity.dev !== dev)
                        )
                            fail('NATIVE_MENU_CROSS_DEVICE');
                        a.finish();
                        b.finish();
                    } else if (!menuAdvance && !sameLinuxMenu(previous.menu, next.menu))
                        fail('NATIVE_MENU_JOURNAL_IDENTITY');
                }
                if (completedRemoval && !previous && next.phase === 'copying') completedRemoval.archiveCompleted();
                const existing = maybeStat(work);
                if (!existing) mkdirNew(work);
                else plainDirectory(existing, work, true);
                // An owned existing FD is rewritten in place. Partial crash writes remain UNKNOWN, not durable commits.
                write(
                    work + '/journal.json',
                    nextBytes,
                    previous === null,
                    previous
                        ? actual.history?.journalOriginal
                            ? Buffer.from(actual.history.journalOriginal.base64, 'base64')
                            : Buffer.from(JSON.stringify(previous))
                        : undefined,
                );
                return observe(scope);
            });
        },
        stage(scope, expected, payloadInput) {
            return protect(async () => {
                requireMutation();
                scope = copy(scope);
                expected = copy(expected);
                const wanted = copy(payloadInput),
                    actual = await guard(scope, expected);
                const payload = {
                    manifest: actual.source.manifest,
                    verifiedManifestSHA256: actual.source.verifiedManifestSHA256,
                    installationId: plan.installationId,
                    transactionId: plan.transactionId,
                    root: plan.root,
                    profile: path.posix.join(
                        plan.host.appData,
                        'DiagnosticHub',
                        'profiles',
                        plan.installationId,
                    ),
                    ...(actual.journal?.menu?.after
                        ? { menu: copy(actual.journal.menu.after) }
                        : {}),
                };
                if (
                    actual.stage ||
                    actual.journal?.phase !== 'copying' ||
                    JSON.stringify(payload) !== JSON.stringify(wanted)
                )
                    fail('NATIVE_STAGE_IDENTITY');
                const ownerBytes = Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        product: INSTALLATION_PRODUCT,
                        installationId: plan.installationId,
                        transactionId: plan.transactionId,
                        root: plan.root,
                        options: {
                            startMenu: Boolean(payload.menu),
                            desktop: false,
                            launch: false,
                        },
                        integrations: payload.menu ? [copy(payload.menu)] : [],
                    }),
                );
                if (ownerBytes.length > 8192) fail('NATIVE_OWNERSHIP_BOUND');
                mkdirNew(fixed.stage);
                const created = new Set([fixed.stage]);
                for (const file of payload.manifest.files) {
                    if (file.kind !== 'file') throw Error('NATIVE_LAYOUT');
                    let current = fixed.stage;
                    for (const part of file.path.split('/').slice(0, -1)) {
                        current += '/' + part;
                        if (!created.has(current)) {
                            mkdirNew(current);
                            created.add(current);
                        }
                    }
                    copyFile(
                        path.posix.join(fixed.source, file.path),
                        path.posix.join(fixed.stage, file.path),
                        file.bytes,
                        file.sha256,
                    );
                }
                const release = Buffer.from(JSON.stringify(payload.manifest));
                write(fixed.stage + '/' + INSTALLATION_MANIFEST, release, true);
                write(
                    fixed.stage + '/' + INSTALLATION_RECORD,
                    Buffer.from(
                        JSON.stringify({
                            schemaVersion: 1,
                            product: INSTALLATION_PRODUCT,
                            installationId: plan.installationId,
                            manifestSHA256: hash(release),
                            profile: 'dedicated',
                        }),
                    ),
                    true,
                );
                write(fixed.stage + '/' + SETUP_OWNER, ownerBytes, true);
                return observe(scope);
            });
        },
        move(scope, expected, from, to) {
            return protect(async () => {
                requireMutation();
                scope = copy(scope);
                expected = copy(expected);
                const actual = await guard(scope, expected);
                if (
                    !['root:previous', 'stage:root', 'root:stage', 'previous:root'].includes(
                        from + ':' + to,
                    ) ||
                    !actual[from] ||
                    actual[to]
                )
                    fail('NATIVE_MOVE_OWNERSHIP');
                const sourceDirectory = pin(path.posix.dirname(fixed[from])),
                    targetDirectory = pin(path.posix.dirname(fixed[to]));
                const sourceName = path.posix.basename(fixed[from]),
                    targetName = path.posix.basename(fixed[to]),
                    sourceFile = fdPath(sourceDirectory.fd) + '/' + sourceName,
                    targetFile = fdPath(targetDirectory.fd) + '/' + targetName;
                const before = stat(sourceFile);
                plainDirectory(before, fixed[from], true);
                if (maybeStat(targetFile)) fail('NATIVE_MOVE_TARGET_EXISTS');
                sourceDirectory.check();
                targetDirectory.check();
                call(
                    'move-noreplace',
                    () =>
                        ops.moveNoReplace!(
                            sourceDirectory.fd,
                            sourceName,
                            targetDirectory.fd,
                            targetName,
                        ),
                    () => state.allocations.add(fixed[to]),
                );
                if (maybeStat(sourceFile) || !sameInode(before, stat(targetFile)))
                    fail('NATIVE_MOVE_CHANGED');
                const links = [{path: path.posix.dirname(fixed[from]), delta: -1},
                    {path: path.posix.dirname(fixed[to]), delta: 1}];
                sourceDirectory.acknowledgeDirectoryLinks(links);
                targetDirectory.acknowledgeDirectoryLinks(links);
                call('parent-sync', () => fs.fsyncSync(sourceDirectory.fd));
                call('parent-sync', () => fs.fsyncSync(targetDirectory.fd));
                sourceDirectory.finish();
                targetDirectory.finish();
                return observe(scope);
            });
        },
        menuStage(scope, expected, recordInput, textInput) {
            return protect(async () => {
                requireMutation();
                if (!plan.menu || !menuPaths) fail('NATIVE_MENU_UNAVAILABLE');
                scope = copy(scope);
                expected = copy(expected);
                const record = checkedLinuxMenuRecord(copy(recordInput), plan),
                    text = textInput;
                const actual = await guard(scope, expected),
                    journal = actual.journal?.menu;
                const desired = desiredLinuxMenu(plan);
                if (
                    actual.journal?.phase !== 'candidate-active' ||
                    !journal ||
                    journal.phase !== 'pending' ||
                    !['create', 'replace'].includes(journal.action) ||
                    actual.menu!.candidate !== null ||
                    !sameLinuxMenu(record, desired.record) ||
                    !sameLinuxMenu(journal.after, record) ||
                    typeof text !== 'string' ||
                    text !== desired.text ||
                    Buffer.byteLength(text) !== record.bytes ||
                    hash(text) !== record.sha256
                )
                    fail('NATIVE_MENU_STAGE');
                write(menuPaths!.candidate, Buffer.from(text), true);
                return observe(scope);
            });
        },
        menuMove(scope, expected, from, to) {
            return protect(async () => {
                requireMutation();
                if (
                    !plan.menu ||
                    !menuPaths ||
                    !['current', 'candidate', 'previous'].includes(from) ||
                    !['current', 'candidate', 'previous'].includes(to)
                )
                    fail('NATIVE_MENU_UNAVAILABLE');
                scope = copy(scope);
                expected = copy(expected);
                const actual = await guard(scope, expected),
                    journal = actual.journal?.menu;
                if (actual.journal?.phase !== 'candidate-active' || !journal || !actual.menu)
                    fail('NATIVE_MENU_PHASE');
                const pair = from + ':' + to;
                const permitted =
                    (pair === 'current:previous' &&
                        ((journal!.action === 'replace' && journal!.phase === 'staged') ||
                            (journal!.action === 'deselect' && journal!.phase === 'pending'))) ||
                    (pair === 'candidate:current' &&
                        ((journal!.action === 'create' && journal!.phase === 'staged') ||
                            (journal!.action === 'replace' && journal!.phase === 'retained'))) ||
                    (pair === 'current:candidate' &&
                        ['create', 'replace'].includes(journal!.action) &&
                        journal!.phase === 'rollback-pending') ||
                    (pair === 'previous:current' &&
                        ['replace', 'deselect'].includes(journal!.action) &&
                        journal!.phase === 'rollback-candidate-retained');
                if (!permitted || actual.menu![from] === null || actual.menu![to] !== null)
                    fail('NATIVE_MENU_MOVE');
                const held = actual.menu![from]!;
                const sourceParent = pin(path.posix.dirname(menuPaths![from])),
                    targetParent = pin(path.posix.dirname(menuPaths![to]));
                const sourceName = path.posix.basename(menuPaths![from]),
                    targetName = path.posix.basename(menuPaths![to]);
                const sourceFile = fdPath(sourceParent.fd) + '/' + sourceName,
                    targetFile = fdPath(targetParent.fd) + '/' + targetName;
                const before = stat(sourceFile);
                regular(before, 8192, false);
                if (
                    !sameLinuxMenu(id(before), held.identity) ||
                    before.size !== held.bytes ||
                    fileHash(menuPaths![from], held.bytes) !== held.sha256 ||
                    maybeStat(targetFile) !== null ||
                    fstat(sourceParent.fd).dev !== fstat(targetParent.fd).dev
                )
                    fail('NATIVE_MENU_MOVE_IDENTITY');
                sourceParent.check();
                targetParent.check();
                if (!stable(before, stat(sourceFile))) fail('NATIVE_MENU_CHANGED');
                call(
                    'menu-move-noreplace',
                    () =>
                        ops.moveNoReplace!(
                            sourceParent.fd,
                            sourceName,
                            targetParent.fd,
                            targetName,
                        ),
                    () => state.allocations.add(menuPaths![to]),
                );
                if (
                    maybeStat(sourceFile) !== null ||
                    !sameInode(before, stat(targetFile)) ||
                    fileHash(menuPaths![to], held.bytes) !== held.sha256
                )
                    fail('NATIVE_MENU_MOVE_READBACK');
                call('parent-sync', () => fs.fsyncSync(sourceParent.fd));
                call('parent-sync', () => fs.fsyncSync(targetParent.fd));
                sourceParent.finish();
                targetParent.finish();
                return observe(scope);
            });
        },
    };
    let completedRemoval: ReturnType<typeof createLinuxInitialUninstall> | null = null;
    const backend = {
        selectMenu(selected: boolean) {
            if (
                !continuation ||
                !plan.menu ||
                attempted ||
                lease ||
                state.failed ||
                typeof selected !== 'boolean'
            )
                return fail('NATIVE_MENU_SELECTION');
            plan = checkedLinuxModelConfiguration({ ...plan, menu: { ...plan.menu, selected } });
        },
        /** This only derives operation IDs from actual bounded originals, once.
         * Every later prompt/transaction still compares a fresh complete view. */
        prepare: () =>
            protect(async () => {
                if (!preparing) return fail('NATIVE_PREPARATION_ALREADY_CONSUMED');
                preparing = false;
                procOwner();
                if (plan.action !== 'uninstall-current' && maybeStat(work + '-uninstall')) {
                    if (plan.action !== 'install' || plan.menu || maybeStat(plan.root) || maybeStat(work))
                        return fail('NATIVE_REMOVAL_PENDING_OR_RETAINED');
                    completedRemoval = backend.initialUninstall();
                    completedRemoval.completed();
                }
                let installationId = plan.installationId;
                const destination = maybeStat(plan.root);
                if (destination) plainDirectory(destination, plan.root, true);
                const recordPath = plan.root + '/' + INSTALLATION_RECORD;
                const hasRecord = Boolean(maybeStat(recordPath));
                if (hasRecord)
                    installationId = validateInstallationRecord(json(recordPath)).installationId;
                if (hasRecord && !plan.menu) {
                    const owner = json(plan.root + '/' + SETUP_OWNER) as {
                        integrations?: unknown[];
                    };
                    if (Array.isArray(owner.integrations) && owner.integrations.length === 1) {
                        if (!menuDataHome) return fail('NATIVE_MENU_REVIEW_REQUIRED');
                        plan = checkedLinuxModelConfiguration({
                            ...plan,
                            installationId,
                            menu: { dataHome: menuDataHome, selected: true },
                        });
                    }
                }
                let transactionId = plan.transactionId;
                const maintenance = maybeStat(work);
                if (maintenance) plainDirectory(maintenance, work, true);
                if (maybeStat(work + '/journal.json')) {
                    const journal = json(work + '/journal.json') as LinuxModelJournal;
                    if (!hasRecord) installationId = journal.installationId;
                    if (
                        journal.root !== plan.root ||
                        journal.uid !== plan.host.uid ||
                        journal.installationId !== installationId ||
                        typeof journal.transactionId !== 'string' ||
                        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                            journal.transactionId,
                        )
                    )
                        return fail('NATIVE_PREPARATION_JOURNAL');
                    if (
                        !['install', 'repair', 'update'].includes(plan.action) ||
                        journal.phase !== 'candidate-active' ||
                        (journal.previousSHA256 === null
                            ? Boolean(maybeStat(work + '/completed-journal.json'))
                            : Boolean(plan.menu) || !maybeStat(work + '/completed-journal.json'))
                    )
                        transactionId = journal.transactionId;
                } else if (continuation && maybeStat(work + '/completed-journal.json')) {
                    const journal = json(work + '/completed-journal.json') as LinuxModelJournal;
                    if (!hasRecord) return fail('NATIVE_COMPLETED_RECOVERY_ROOT');
                    if (journal.installationId !== installationId)
                        return fail('NATIVE_COMPLETED_RECOVERY_ID');
                }
                plan = checkedLinuxModelConfiguration({ ...plan, installationId, transactionId });
                fixed.stage = work + '/stage-' + transactionId;
                fixed.previous = work + '/previous-' + transactionId;
                menuPaths = plan.menu ? linuxMenuPaths(plan, work) : null;
                return {
                    configuration: copy(plan),
                    scope: copy(fixed),
                    view: observe(copy(fixed)),
                };
            }),
        kernel: {
            acquire: (wanted) => protect(() => kernel.acquire(wanted)),
            current: (handle) => protect(() => kernel.current(handle)),
            release: (handle, expected) => protect(() => kernel.release(handle, expected)),
        } satisfies LinuxModelKernel,
        effects,
        scope: copy(fixed),
        /** A distinct, concrete initial-only remover; ordinary install/rollback effects stay unchanged. */
        initialUninstall(): ReturnType<typeof createLinuxInitialUninstall> {
            if (plan.menu || !['install','uninstall-current'].includes(plan.action)) return fail('NATIVE_UNINSTALL_SELECTION');
            let prepared: ReturnType<typeof backend.prepare> | undefined;
            const removal = work + '-uninstall', payloadRoot = removal + '/payload',
                disposalRoot = removal + '/disposal';
            const match = (value: Stats, expected: {dev: number;ino: number;uid: number;mode: number;kind: string;bytes?: number}) =>
                !value.isSymbolicLink() && value.dev === expected.dev && value.ino === expected.ino &&
                value.uid === expected.uid && value.mode === expected.mode &&
                (expected.kind === 'file' ? value.isFile() && value.nlink === 1 && value.size === expected.bytes
                    : value.isDirectory() && value.nlink > 0);
            return createLinuxInitialUninstall({
                configuration: () => copy(plan),
                async initial() {
                    if (!prepared) {prepared = backend.prepare(); return prepared;}
                    const first = await prepared;
                    return {...first,view: await effects.observe(copy(first.scope))};
                },
                kernel: backend.kernel,
                source: sourceObservation,
                activity,
                stat, maybe: maybeStat, names, read, hash: fileHash,
                mkdir(directory) {
                    if (![removal,disposalRoot].includes(directory)) return fail('NATIVE_UNINSTALL_PATH');
                    mkdirNew(directory);
                },
                write(file,bytes,exclusive,prior) {
                    if (![removal + '/snapshot.json',removal + '/state.json'].includes(file))
                        return fail('NATIVE_UNINSTALL_PATH');
                    write(file,bytes,exclusive,prior,0o600,MAX_INSTALLATION_MANIFEST_BYTES * 6 + 131072);
                },
                move(from,to,expected) {
                    requireMutation();
                    if (!(from === fixed.root && to === payloadRoot ||
                        from === work && to === removal + '/original-maintenance' ||
                        from === removal && to.startsWith(work + '-removed-') &&
                            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(to.slice((work + '-removed-').length)) ||
                        inside(payloadRoot,from) && to === disposalRoot + '/entry'))
                        return fail('NATIVE_UNINSTALL_PATH');
                    const source = pin(path.posix.dirname(from)), target = pin(path.posix.dirname(to));
                    const sourceName = path.posix.basename(from), targetName = path.posix.basename(to),
                        sourceFile = fdPath(source.fd) + '/' + sourceName, targetFile = fdPath(target.fd) + '/' + targetName;
                    if (!match(stat(sourceFile),expected) || maybeStat(targetFile)) return fail('NATIVE_UNINSTALL_CHANGED');
                    source.check(); target.check();
                    call('uninstall-move-issued',() => ops.moveNoReplace!(source.fd,sourceName,target.fd,targetName),
                        () => state.allocations.add(to));
                    if (maybeStat(sourceFile) || !match(stat(targetFile),expected)) return fail('NATIVE_UNINSTALL_MOVED_FOREIGN');
                    const links = expected.kind === 'directory' ?
                        [{path:path.posix.dirname(from),delta:-1},{path:path.posix.dirname(to),delta:1}] : [];
                    source.acknowledgeDirectoryLinks(links); target.acknowledgeDirectoryLinks(links);
                    call('parent-sync',() => fs.fsyncSync(source.fd)); call('parent-sync',() => fs.fsyncSync(target.fd));
                    source.finish(); target.finish();
                    if (expected.kind === 'file' && fileHash(to,expected.bytes!) !== expected.sha256)
                        return fail('NATIVE_UNINSTALL_MOVED_FOREIGN');
                },
                remove(file,expected) {
                    if (file !== disposalRoot + '/entry' || !ops.unlinkOwned) return fail('NATIVE_UNINSTALL_PATH');
                    const parent = pin(disposalRoot), anchored = fdPath(parent.fd) + '/entry';
                    if ((fstat(parent.fd).mode & 0o7777) !== 0o700 || !match(stat(anchored),expected))
                        return fail('NATIVE_UNINSTALL_DISPOSAL');
                    parent.check();
                    // The controller persisted unlink-issued before entering this single submission.
                    call('unlink-issued',() => ops.unlinkOwned!(parent.fd,'entry',expected.kind,{dev:expected.dev,ino:expected.ino}));
                    if (maybeStat(anchored)) return fail('NATIVE_UNINSTALL_UNLINK_ACK');
                    parent.acknowledgeDirectoryLinks(expected.kind === 'directory' ? [{path:disposalRoot,delta:-1}] : []);
                    call('parent-sync',() => fs.fsyncSync(parent.fd)); parent.finish();
                },
                available: () => Boolean(ops.moveNoReplace && ops.unlinkOwned),
                diagnostics: () => backend.diagnostics(),
                healthy: gate,
                knownRelease: () => state.releaseKnown,
                reserved() {
                    gate();procOwner();
                    if (!lease || !leaseIdentity || !(lease.handle as Server).listening ||
                        (lease.handle as Server).address() !== '\0' + fixed.key) return fail('NATIVE_RESERVATION_REQUIRED');
                },
            });
        },
        /** A live direct child's initial kernel identity only; not profile/window/loaded-code proof. */
        observeLaunchChild: (pid: number) =>
            protect(async () => {
                if (!lease || !Number.isSafeInteger(pid) || pid <= 0 || pid === ops.pid)
                    return fail('NATIVE_LAUNCH_CHILD');
                await kernel.current(lease.handle);
                const directory = '/proc/' + pid,
                    before = stat(directory);
                if (
                    before.uid !== plan.host.uid ||
                    !before.isDirectory() ||
                    before.isSymbolicLink()
                )
                    return fail('NATIVE_LAUNCH_CHILD');
                const sample = () => {
                    const text = read(directory + '/stat', PROC_TEXT, false, true).toString('utf8');
                    const identity = linuxProcIdentity(text, pid);
                    if (
                        text
                            .slice(text.lastIndexOf(') ') + 2)
                            .trim()
                            .split(/\s+/)[1] !== String(ops.pid) ||
                        identity.state === 'Z' ||
                        identity.state === 'X'
                    )
                        return fail('NATIVE_LAUNCH_CHILD');
                    return identity;
                };
                const first = sample(),
                    executable = call('child-exe', () => fs.readlinkSync(directory + '/exe')),
                    last = sample();
                if (
                    first.startTicks !== last.startTicks ||
                    !sameInode(before, stat(directory)) ||
                    executable !== path.posix.join(fixed.root, 'app/diagnostic-hub')
                )
                    return fail('NATIVE_LAUNCH_CHILD');
                return { pid, uid: before.uid, startTicks: first.startTicks, executable };
            }),
        capabilities: {
            nativeQualified: false as const,
            directoryMoveNoReplace: ops.moveNoReplace !== null,
            productionDispatch: false as const,
        },
        diagnostics: () => ({
            failed: state.failed,
            code: state.code,
            pending: state.pending,
            retainedFDs: state.fds.size,
            retainedDirs: state.dirs.size,
            retainedServers: state.servers.size,
            retainedSockets: state.sockets.size,
            retainedTimers: state.timers.size,
            allocations: state.allocations.size,
            lateEvents: state.lateEvents,
            primarySet: state.primarySet,
        }),
    };
    return backend;
}
