import path from 'node:path';
import { valid } from 'semver';
import { maintenancePaths, SETUP_OWNER } from './installation-maintenance.ts';
import { linuxReviewDisk, type LinuxReviewIO } from './linux-setup-review.ts';
import type { LinuxSetupReadiness } from '../shared/types.ts';
import { INSTALLATION_PRODUCT } from '../shared/installation.ts';
import { sameLinuxMenu } from './linux-menu-ownership.ts';

export interface LinuxReadinessContext {
    platform: string;
    arch: string;
    layout: string;
    packaged: boolean;
    root: string;
    installationId: string;
    manifestSHA256: string;
    version: string;
    profile: string;
    executable: string;
    pid: number;
    uid: number;
    euid: number;
    processCreationMs: number | null;
    appUrl: string;
}
export interface LinuxReadinessSample {
    window: object;
    contents: object;
    frame: object;
    frameUrl: string;
    electronId: number;
    nativeHandle: Buffer;
    visible: boolean;
    minimized: boolean;
    loading: boolean;
    profile: string;
    ownsProfile: boolean;
    quitting: boolean;
    nowMs: number;
    generation: number;
}
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const hash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const uuid = (x: unknown) =>
    typeof x === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const absolute = (x: unknown): x is string =>
    typeof x === 'string' &&
    x.length > 1 &&
    x.length <= 240 &&
    x.startsWith('/') &&
    path.posix.normalize(x) === x &&
    !/[\\\x00-\x1f\x7f]/.test(x);
function fields(x: unknown, keys: string[]): asserts x is Record<string, unknown> {
    if (
        !x ||
        typeof x !== 'object' ||
        Array.isArray(x) ||
        Object.keys(x).length !== keys.length ||
        Object.keys(x).some((k) => !keys.includes(k))
    )
        throw Error('LINUX_READINESS_GRAMMAR');
}
function wireFields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    fields(value, keys);
    if (
        (Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null) ||
        Reflect.ownKeys(value).length !== keys.length ||
        keys.some((key) => {
            const d = Object.getOwnPropertyDescriptor(value, key)!;
            return !Object.hasOwn(d, 'value') || Boolean(d.get || d.set);
        })
    )
        throw Error('LINUX_READINESS_WIRE');
}
/** Strict wire projection only. Validation never grants independent observation or setup authority. */
export function checkedLinuxSetupReadiness(input: unknown): LinuxSetupReadiness {
    wireFields(input, [
        'schemaVersion',
        'source',
        'root',
        'installationId',
        'transactionId',
        'manifestSHA256',
        'version',
        'process',
        'profile',
        'window',
        'observedAtMs',
        'payloadIntegrity',
        'independentProcessObservation',
        'independentWindowObservation',
        'descendantRetirement',
        'finalizationAuthority',
    ]);
    wireFields(input.process, ['pid', 'uid', 'executable', 'creationTimeMs']);
    wireFields(input.profile, ['path', 'lockOwned']);
    wireFields(input.window, [
        'electronId',
        'nativeHandleHex',
        'visible',
        'minimized',
        'mainFrameReady',
    ]);
    if (
        input.schemaVersion !== 1 ||
        input.source !== 'linux-main-self-observation' ||
        !absolute(input.root) ||
        !absolute(input.profile.path) ||
        !uuid(input.installationId) ||
        !uuid(input.transactionId) ||
        !hash(input.manifestSHA256) ||
        typeof input.version !== 'string' ||
        valid(input.version) !== input.version ||
        !positive(input.process.pid) ||
        !positive(input.process.uid) ||
        input.process.executable !== path.posix.join(input.root, 'app/diagnostic-hub') ||
        typeof input.process.creationTimeMs !== 'number' ||
        !Number.isFinite(input.process.creationTimeMs) ||
        input.process.creationTimeMs <= 0 ||
        input.process.creationTimeMs > Number.MAX_SAFE_INTEGER ||
        input.profile.path === input.root ||
        input.profile.path.startsWith(input.root + '/') ||
        input.root.startsWith(input.profile.path + '/') ||
        input.profile.lockOwned !== true ||
        !positive(input.window.electronId) ||
        typeof input.window.nativeHandleHex !== 'string' ||
        !/^(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(input.window.nativeHandleHex) ||
        !/[1-9a-f]/.test(input.window.nativeHandleHex) ||
        input.window.visible !== true ||
        input.window.minimized !== false ||
        input.window.mainFrameReady !== true ||
        !positive(input.observedAtMs) ||
        input.process.creationTimeMs > input.observedAtMs ||
        input.payloadIntegrity !== 'not-checked' ||
        input.independentProcessObservation !== false ||
        input.independentWindowObservation !== false ||
        input.descendantRetirement !== false ||
        input.finalizationAuthority !== false
    )
        throw Error('LINUX_READINESS_WIRE');
    const bytes = JSON.stringify(input);
    if (Buffer.byteLength(bytes) > 8192) throw Error('LINUX_READINESS_BOUND');
    return JSON.parse(bytes) as LinuxSetupReadiness;
}
function parse(bytes: Buffer) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8192)
        throw Error('LINUX_READINESS_BOUND');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    // Existing Linux writers use compact JSON. Reject duplicate keys, trailing bytes and lossy UTF-8.
    if (!Buffer.from(JSON.stringify(value)).equals(bytes)) throw Error('LINUX_READINESS_JSON');
    return value;
}
function metadata(ownerInput: unknown, journalInput: unknown, c: LinuxReadinessContext) {
    fields(ownerInput, [
        'schemaVersion',
        'product',
        'root',
        'installationId',
        'transactionId',
        'options',
        'integrations',
    ]);
    const o = ownerInput;
    fields(o.options, ['startMenu', 'desktop', 'launch']);
    if (
        o.schemaVersion !== 1 ||
        o.product !== INSTALLATION_PRODUCT ||
        o.root !== c.root ||
        o.installationId !== c.installationId ||
        !uuid(o.transactionId) ||
        typeof o.options.startMenu !== 'boolean' ||
        o.options.desktop !== false ||
        o.options.launch !== false ||
        !Array.isArray(o.integrations) ||
        o.integrations.length > 1
    )
        throw Error('LINUX_READINESS_OWNER');
    const optionalMenu = Boolean(
        journalInput && typeof journalInput === 'object' && Object.hasOwn(journalInput, 'menu'),
    );
    fields(journalInput, [
        'schemaVersion',
        'root',
        'uid',
        'transactionId',
        'installationId',
        'profile',
        'candidateSHA256',
        'previousSHA256',
        'owner',
        'phase',
        ...(optionalMenu ? ['menu'] : []),
    ]);
    const j = journalInput;
    fields(j.owner, ['pid', 'startTicks', 'executable']);
    if (
        j.schemaVersion !== 1 ||
        j.root !== c.root ||
        j.uid !== c.uid ||
        j.transactionId !== o.transactionId ||
        j.installationId !== c.installationId ||
        j.profile !== c.profile ||
        j.candidateSHA256 !== c.manifestSHA256 ||
        !(j.previousSHA256 === null || hash(j.previousSHA256)) ||
        (j.phase !== 'candidate-active' && j.phase !== 'candidate-confirmed') ||
        !positive(j.owner.pid) ||
        typeof j.owner.startTicks !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(j.owner.startTicks) ||
        !absolute(j.owner.executable)
    )
        throw Error('LINUX_READINESS_JOURNAL');
    if (optionalMenu) {
        fields(j.menu, ['action', 'before', 'after', 'beforeFile', 'phase']);
        if (
            j.menu.phase !== 'applied' ||
            ![
                'create',
                'replace',
                'deselect',
                'drop-absent',
                'unchanged',
                'retain-foreign',
                'retain-absent',
            ].includes(String(j.menu.action))
        )
            throw Error('LINUX_READINESS_MENU');
        for (const item of [j.menu.before, j.menu.after])
            if (item !== null) {
                fields(item, ['kind', 'path', 'root', 'installationId', 'uid', 'bytes', 'sha256']);
                if (
                    item.kind !== 'linux-desktop' ||
                    !absolute(item.path) ||
                    item.root !== c.root ||
                    item.installationId !== c.installationId ||
                    item.uid !== c.uid ||
                    !positive(item.bytes) ||
                    item.bytes > 8192 ||
                    !hash(item.sha256)
                )
                    throw Error('LINUX_READINESS_MENU');
            }
        if (j.menu.beforeFile !== null) {
            fields(j.menu.beforeFile, ['identity', 'bytes', 'sha256']);
            fields(j.menu.beforeFile.identity, ['dev', 'ino', 'uid']);
            const file = j.menu.beforeFile,
                id = file.identity as Record<string, unknown>;
            if (
                !Number.isSafeInteger(id.dev) ||
                (id.dev as number) < 0 ||
                !positive(id.ino) ||
                id.uid !== c.uid ||
                !positive(file.bytes) ||
                file.bytes > 8192 ||
                !hash(file.sha256)
            )
                throw Error('LINUX_READINESS_MENU');
        }
        const action = j.menu.action,
            before = j.menu.before,
            after = j.menu.after,
            file = j.menu.beforeFile as Record<string, unknown> | null;
        if (
            before &&
            file &&
            ((before as Record<string, unknown>).bytes !== file.bytes ||
                (before as Record<string, unknown>).sha256 !== file.sha256)
        )
            throw Error('LINUX_READINESS_MENU');
        const relation =
            action === 'create'
                ? file === null && after !== null
                : action === 'replace'
                  ? before !== null &&
                    file !== null &&
                    after !== null &&
                    !sameLinuxMenu(before, after)
                  : action === 'unchanged'
                    ? before !== null &&
                      file !== null &&
                      after !== null &&
                      sameLinuxMenu(before, after)
                    : action === 'deselect'
                      ? before !== null && file !== null && after === null
                      : action === 'drop-absent'
                        ? before !== null && file === null && after === null
                        : action === 'retain-foreign'
                          ? before === null && file !== null && after === null
                          : before === null && file === null && after === null;
        if (!relation) throw Error('LINUX_READINESS_MENU');
        const expected = j.menu.after === null ? [] : [j.menu.after];
        if (
            Boolean(j.menu.after) !== o.options.startMenu ||
            !sameLinuxMenu(o.integrations, expected)
        )
            throw Error('LINUX_READINESS_MENU');
    } else if (o.integrations.length || o.options.startMenu) throw Error('LINUX_READINESS_MENU');
    return o.transactionId as string;
}
function ready(
    s: LinuxReadinessSample | null,
    c: LinuxReadinessContext,
): s is LinuxReadinessSample {
    return Boolean(
        s &&
        s.window &&
        s.contents &&
        s.frame &&
        s.frameUrl === c.appUrl &&
        positive(s.electronId) &&
        Buffer.isBuffer(s.nativeHandle) &&
        [4, 8].includes(s.nativeHandle.byteLength) &&
        s.nativeHandle.some((byte) => byte !== 0) &&
        s.visible === true &&
        s.minimized === false &&
        s.loading === false &&
        s.profile === c.profile &&
        s.ownsProfile === true &&
        s.quitting === false &&
        Number.isSafeInteger(s.nowMs) &&
        s.nowMs >= c.processCreationMs!,
    );
}
/** Existing trusted readUpdateInfo route calls this; no new endpoint, writes or cleanup.
 * Local metadata and main-process window/profile reports are not independent native evidence.
 * Unknown/replaced documents, missing metadata, unsupported handles and races return null. */
export async function observeLinuxSetupReadiness(
    input: LinuxReadinessContext,
    sample: () => LinuxReadinessSample | null,
    io: Pick<LinuxReviewIO, 'bytes'> & Partial<Pick<LinuxReviewIO, 'node'>> = linuxReviewDisk,
): Promise<LinuxSetupReadiness | null> {
    try {
        const c = { ...input };
        if (
            c.platform !== 'linux' ||
            c.arch !== 'x64' ||
            c.layout !== 'linux-folder' ||
            c.packaged !== true ||
            !absolute(c.root) ||
            !absolute(c.profile) ||
            c.profile === c.root ||
            c.profile.startsWith(c.root + '/') ||
            c.root.startsWith(c.profile + '/') ||
            !uuid(c.installationId) ||
            !hash(c.manifestSHA256) ||
            typeof c.version !== 'string' ||
            valid(c.version) !== c.version ||
            c.executable !== path.posix.join(c.root, 'app/diagnostic-hub') ||
            !positive(c.pid) ||
            !positive(c.uid) ||
            c.euid !== c.uid ||
            c.processCreationMs === null ||
            !Number.isFinite(c.processCreationMs) ||
            c.processCreationMs <= 0 ||
            c.processCreationMs > Number.MAX_SAFE_INTEGER ||
            c.appUrl !== 'app://bundle/index.html'
        )
            return null;
        const initial = sample();
        if (
            !ready(initial, c) ||
            !Number.isSafeInteger(initial.generation) ||
            initial.generation < 0
        )
            return null;
        const first = { ...initial, nativeHandle: Buffer.from(initial.nativeHandle) };
        const bytes = io.bytes;
        const read = async (file: string) => {
            const result = (await Reflect.apply(bytes, io, [file, 8192, c.uid])) as Buffer;
            if (!Buffer.isBuffer(result) || result.length > 8192)
                throw Error('LINUX_READINESS_BOUND');
            return Buffer.from(result);
        };
        const handle = first.nativeHandle,
            ownerPath = path.posix.join(c.root, SETUP_OWNER),
            activeJournal = maintenancePaths(c.root).journal;
        const probeDescriptor = Object.getOwnPropertyDescriptor(io, 'node');
        if (
            probeDescriptor &&
            (!Object.hasOwn(probeDescriptor, 'value') ||
                typeof probeDescriptor.value !== 'function')
        )
            return null;
        const probe = probeDescriptor?.value as LinuxReviewIO['node'] | undefined;
        const inspect = async (file: string) =>
            probe ? (Reflect.apply(probe, io, [file]) as ReturnType<LinuxReviewIO['node']>) : null;
        const identity = (value: Awaited<ReturnType<LinuxReviewIO['node']>>) => {
            if (!value || value.kind !== 'file') throw Error('LINUX_READINESS_METADATA_KIND');
            return JSON.stringify(
                ['kind', 'uid', 'mode', 'dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(
                    (key) => {
                        const field = Object.getOwnPropertyDescriptor(value, key);
                        if (!field || !Object.hasOwn(field, 'value'))
                            throw Error('LINUX_READINESS_METADATA_IDENTITY');
                        return field.value;
                    },
                ),
            );
        };
        let journalPath = activeJournal,
            completed = false;
        if (probe && (await inspect(activeJournal)) === null) {
            journalPath = path.posix.join(
                path.posix.dirname(activeJournal),
                'completed-journal.json',
            );
            completed = true;
        }
        const ownerIdentity = completed ? identity(await inspect(ownerPath)) : null,
            journalIdentity = completed ? identity(await inspect(journalPath)) : null;
        const ownerBytes = await read(ownerPath),
            journalBytes = await read(journalPath);
        const journal = parse(journalBytes);
        if (
            completed &&
            (!journal ||
                typeof journal !== 'object' ||
                ((journal as Record<string, unknown>).previousSHA256 !== null &&
                    (journal as Record<string, unknown>).phase !== 'candidate-confirmed') ||
                Object.hasOwn(journal, 'menu'))
        )
            return null;
        const transactionId = metadata(parse(ownerBytes), journal, c);
        const ownerAgain = await read(ownerPath),
            journalAgain = await read(journalPath);
        if (!ownerBytes.equals(ownerAgain) || !journalBytes.equals(journalAgain)) return null;
        if (
            completed &&
            (identity(await inspect(ownerPath)) !== ownerIdentity ||
                identity(await inspect(journalPath)) !== journalIdentity ||
                (await inspect(activeJournal)) !== null)
        )
            return null;
        const last = sample();
        if (
            !ready(last, c) ||
            last.window !== first.window ||
            last.contents !== first.contents ||
            last.frame !== first.frame ||
            last.electronId !== first.electronId ||
            !last.nativeHandle.equals(handle) ||
            last.generation !== first.generation ||
            last.nowMs < first.nowMs ||
            last.nowMs - first.nowMs >= 2000
        )
            return null;
        const result: LinuxSetupReadiness = {
            schemaVersion: 1,
            source: 'linux-main-self-observation',
            root: c.root,
            installationId: c.installationId,
            transactionId,
            manifestSHA256: c.manifestSHA256,
            version: c.version,
            process: {
                pid: c.pid,
                uid: c.uid,
                executable: c.executable,
                creationTimeMs: c.processCreationMs,
            },
            profile: { path: last.profile, lockOwned: true },
            window: {
                electronId: last.electronId,
                nativeHandleHex: handle.toString('hex'),
                visible: true,
                minimized: false,
                mainFrameReady: true,
            },
            observedAtMs: last.nowMs,
            payloadIntegrity: 'not-checked',
            independentProcessObservation: false,
            independentWindowObservation: false,
            descendantRetirement: false,
            finalizationAuthority: false,
        };
        return Buffer.byteLength(JSON.stringify(result)) <= 8192 ? result : null;
    } catch {
        return null;
    }
}
