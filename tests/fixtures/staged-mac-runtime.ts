import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { types as utilTypes } from 'node:util';
import { validateMacManifest } from '../../scripts/lib/macos-release.mjs';
import {
    sampleMacArchive,
    validateMacPayloadIdentity,
} from '../../scripts/lib/macos-payload-identity.mjs';
import type { OwnedDesktop } from './macos-native-owned';
import type { BigIntStats } from 'node:fs';

export const MAC_RUNTIME_OVERRIDE_NAMES = [
    'NODE_OPTIONS',
    'NODE_PATH',
    'ELECTRON_RUN_AS_NODE',
    'PWDEBUG',
    'PW_INSTRUMENT_MODULES',
    'PLAYWRIGHT_DRIVER_URL',
    'PW_TEST_CONNECT_WS_ENDPOINT',
    'SELENIUM_REMOTE_URL',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
] as const;

export function assertMacRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
    for (const name of MAC_RUNTIME_OVERRIDE_NAMES)
        assert.equal(environment[name], undefined, 'Runtime override is not admitted.');
    assert.ok(
        !Object.keys(environment).some((name) => name.startsWith('PW_TEST_')),
        'Runtime test override is not admitted.',
    );
}

const runtimeStages = [
    'prepare',
    'canonical-input',
    'runtime-root',
    'runtime-profile',
    'runtime-artifacts',
    'runtime-home',
    'runtime-temp',
    'file-open',
    'file-stat',
    'file-read',
    'file-close',
    'hash-realpath',
    'hash-lstat',
    'hash-stat',
    'hash-read',
    'package-binding',
    'launch',
    'runtime-attach',
    'runtime-window',
    'runtime-url',
    'runtime-overview',
    'runtime-identity',
    'identity-binding',
    'publication-write',
    'publication-sync',
    'normal-quit',
    'closure-binding',
    'unclassified',
] as const;
type RuntimeStage = (typeof runtimeStages)[number];
const waitingStages = [
    ...runtimeStages,
    'node-endpoint',
    'node-connect',
    'main-initialize',
    'main-response',
    'main-context',
    'browser-endpoint',
    'browser-connect',
    'renderer-attach',
    'first-window',
    'normal-root-close',
    'stdout-eof',
    'stderr-eof',
    'transport-close',
] as const;
const failureReasons = [
    'deadline',
    'process',
    'transport',
    'stream',
    'main-evaluation',
    'operation',
    'other',
] as const;
const ownData = (object: unknown, key: string): unknown => {
    if (object === null || typeof object !== 'object' || utilTypes.isProxy(object))
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const count = (value: unknown, maximum: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? Math.min(value, maximum + 1)
        : null;
const mapCount = (value: unknown, maximum: number) => {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return null;
    try {
        return count(
            Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!.call(value),
            maximum,
        );
    } catch {
        return null;
    }
};
const pendingStage = (value: unknown) => {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
        return 'unclassified';
    let result = 'unclassified',
        seen = 0;
    try {
        for (const record of Map.prototype.values.call(value)) {
            if (++seen > 32) break;
            const phase = ownData(record, 'phase');
            if (typeof phase === 'string' && (waitingStages as readonly string[]).includes(phase))
                result = phase;
        }
    } catch {
        /* Unknown map shape is diagnostic data, never new owner work. */
    }
    return result;
};

/** Memory-only finite facts. No exception, path, PID, descriptor value, endpoint,
 * environment or stream content is read or serialized. Counts use cap+1 for overflow. */
export function macRuntimeFailureDiagnostic(stage: string, owner: unknown, openFiles: number) {
    const rawReason = ownData(owner, 'reason');
    const reason =
        typeof rawReason !== 'string'
            ? 'operation'
            : [
                    'phase-deadline',
                    'owner-phase-deadline',
                    'owner-deadline',
                    'shutdown-deadline',
                ].includes(rawReason)
              ? 'deadline'
              : [
                      'child-error',
                      'unexpected-root-exit',
                      'root-exit-not-normal',
                      'root-close-not-normal',
                      'spawn-failed',
                  ].includes(rawReason)
                ? 'process'
                : [
                        'node-socket-error',
                        'browser-socket-error',
                        'node-socket-disconnected',
                        'browser-socket-disconnected',
                        'main-inspector-disconnected',
                        'attach-failed',
                        'forbidden-termination-command',
                        'framework-transport-close-refused',
                    ].includes(rawReason)
                  ? 'transport'
                  : [
                          'root-stream-error',
                          'root-stream-cap',
                          'endpoint-line-cap',
                          'endpoint-conflict',
                      ].includes(rawReason)
                    ? 'stream'
                    : ['main-evaluate-exception', 'main-inspector-response-error'].includes(
                            rawReason,
                        )
                      ? 'main-evaluation'
                      : rawReason === 'staged-mac-runtime-failed' ||
                          (runtimeStages as readonly string[]).some(
                              (phase) => rawReason === phase + '-failed',
                          )
                        ? 'operation'
                        : 'other';
    const streams = ownData(owner, 'streams');
    const genericWaitingStage = pendingStage(ownData(owner, 'pendingWaits'));
    return Object.freeze({
        stage: (runtimeStages as readonly string[]).includes(stage) ? stage : 'unclassified',
        reason,
        waitingStage:
            genericWaitingStage === 'unclassified'
                ? pendingStage(ownData(owner, 'shutdownPending'))
                : genericWaitingStage,
        pendingOperations: mapCount(ownData(owner, 'pendingWaits'), 32),
        pendingShutdown: mapCount(ownData(owner, 'shutdownPending'), 8),
        pendingMain: count(ownData(owner, 'mainPendingCount'), 16),
        openFiles: count(openFiles, 32),
        childObserved: ownData(owner, 'child') !== undefined,
        attachReturned: ownData(owner, 'attachReturned') === true,
        quitRequested: ownData(owner, 'quitIntent') === true,
        rootExitObserved: ownData(owner, 'exitObserved') === true,
        rootCloseObserved: ownData(owner, 'closeObserved') === true,
        bothEOFObserved:
            ownData(streams, 'stdoutEOF') === true && ownData(streams, 'stderrEOF') === true,
        retainedUnknown: true,
        releaseAcceptance: false,
    });
}
export type MacRuntimeFailureDiagnostic = ReturnType<typeof macRuntimeFailureDiagnostic>;

export function formatMacRuntimeFailure(diagnostic: MacRuntimeFailureDiagnostic) {
    // Rebuild only fixed data fields; never consult a getter, toJSON or extra field.
    diagnostic = Object.fromEntries(
        [
            'stage',
            'reason',
            'waitingStage',
            'pendingOperations',
            'pendingShutdown',
            'pendingMain',
            'openFiles',
            'childObserved',
            'attachReturned',
            'quitRequested',
            'rootExitObserved',
            'rootCloseObserved',
            'bothEOFObserved',
            'retainedUnknown',
            'releaseAcceptance',
        ].map((key) => [key, ownData(diagnostic, key)]),
    ) as MacRuntimeFailureDiagnostic;
    assert.ok((runtimeStages as readonly string[]).includes(diagnostic.stage));
    assert.ok((failureReasons as readonly string[]).includes(diagnostic.reason));
    assert.ok((waitingStages as readonly string[]).includes(diagnostic.waitingStage));
    for (const [key, maximum] of [
        ['pendingOperations', 33],
        ['pendingShutdown', 9],
        ['pendingMain', 17],
        ['openFiles', 33],
    ] as const)
        assert.ok(
            diagnostic[key] === null ||
                (Number.isSafeInteger(diagnostic[key]) &&
                    diagnostic[key]! >= 0 &&
                    diagnostic[key]! <= maximum),
        );
    for (const key of [
        'childObserved',
        'attachReturned',
        'quitRequested',
        'rootExitObserved',
        'rootCloseObserved',
        'bothEOFObserved',
    ] as const)
        assert.equal(typeof diagnostic[key], 'boolean');
    assert.equal(diagnostic.retainedUnknown, true);
    assert.equal(diagnostic.releaseAcceptance, false);
    const text = JSON.stringify(diagnostic);
    assert.ok(Buffer.byteLength(text) <= 2048 && !/[\r\n%]/.test(text));
    return text;
}

export function emitMacRuntimeFailure(
    diagnostic: MacRuntimeFailureDiagnostic,
    write: (line: string) => number,
) {
    const line =
        '::error title=Mac retained runtime diagnostic::' +
        formatMacRuntimeFailure(diagnostic) +
        '\n';
    // One borrowed-channel write only. A short/failed write authorizes no retry,
    // fallback, owner operation, cleanup or claim that GitHub accepted an annotation.
    assert.equal(write(line), Buffer.byteLength(line), 'Bounded diagnostic write incomplete.');
}

type Handle = {
    fd: number;
    writeFile(bytes: Buffer): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
    stat(options: { bigint: true }): Promise<BigIntStats>;
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
};
type Desktop = Pick<
    OwnedDesktop,
    | 'owner'
    | 'launch'
    | 'attach'
    | 'firstWindow'
    | 'evaluate'
    | 'normalQuit'
    | 'snapshot'
    | 'process'
>;
export type MacRuntimeInput = {
    executable: string;
    destination: string;
    buildInfo: string;
    root: string;
    sourceCommit: string;
    asset: string;
    arch: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
};
export type MacRuntimePorts = {
    desktop(options: ConstructorParameters<typeof OwnedDesktop>[0]): Desktop;
    now(): number;
    realpath(file: string): Promise<string>;
    mkdir(file: string): Promise<unknown>;
    lstat(file: string): Promise<BigIntStats>;
    open(file: string, mode: 'read' | 'create'): Promise<Handle>;
    overview(page: Awaited<ReturnType<Desktop['firstWindow']>>): Promise<void>;
    retain(context: unknown): Promise<never>;
    reportFailure(diagnostic: MacRuntimeFailureDiagnostic): void;
};

/** One existing packaged-Mac observation. All actual IO and the existing owner are
 * supplied by the leaf; importing this module cannot launch or acquire a resource. */
export async function runStagedMacRuntime(input: MacRuntimeInput, ports: MacRuntimePorts) {
    input = { ...input, environment: { ...input.environment } };
    assertMacRuntimeEnvironment(input.environment);
    for (const name of ['executable', 'destination', 'buildInfo', 'root', 'cwd'] as const)
        assert.ok(path.isAbsolute(input[name]) && path.resolve(input[name]) === input[name]);
    assert.notEqual(input.root, path.dirname(input.root));
    assert.match(input.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(['arm64', 'x64'].includes(input.arch));
    assert.equal(input.asset, 'Diagnostic-Hub-macos-' + input.arch + '.zip');
    const bundle = path.dirname(path.dirname(path.dirname(input.executable)));
    assert.equal(path.basename(bundle), 'Diagnostic Hub.app');
    assert.equal(input.executable, path.join(bundle, 'Contents/MacOS/Diagnostic Hub'));
    const asar = path.join(bundle, 'Contents/Resources/app.asar');
    const profile = path.join(input.root, 'profile');
    const artifactsDir = path.join(input.root, 'artifacts');
    const environment: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        HOME: path.join(input.root, 'home'),
        TMPDIR: path.join(input.root, 'temp'),
        HUB_STAGED_ASSET: input.asset,
    };
    for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
        'NODE_EXTRA_CA_CERTS',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
        'USER',
        'LOGNAME',
        '__CF_USER_TEXT_ENCODING',
        'XPC_FLAGS',
        'XPC_SERVICE_NAME',
    ])
        if (input.environment[name] !== undefined) environment[name] = input.environment[name];
    // The owner and retained context exist before the first asynchronous IO or spawn.
    const desktop = ports.desktop({
        executable: input.executable,
        profile,
        artifactsDir,
        env: environment,
        deadline: ports.now() + 90000,
    });
    const owner = desktop.owner;
    const handles = new Map<number, Handle>();
    const context = {
        input,
        desktop,
        handles,
        error: undefined as unknown,
        identity: undefined as unknown,
    };
    let stage: RuntimeStage = 'prepare';
    const effect = <T>(phase: string, operation: () => Promise<T>) => {
        stage = (runtimeStages as readonly string[]).includes(phase)
            ? (phase as RuntimeStage)
            : 'unclassified';
        owner.active();
        // Register the promise with existing custody before the operation's microtask.
        // Late returns/rejections remain in owner.pendingWaits after a deadline.
        return owner.wait(
            Promise.resolve().then(() => {
                owner.active();
                return operation();
            }),
            phase,
        );
    };
    const opened = (file: string, mode: 'read' | 'create') =>
        effect('file-open', async () => {
            const handle = await ports.open(file, mode);
            handles.set(handle.fd, handle);
            owner.publicationFDs.add(handle.fd);
            return handle;
        });
    const close = async (handle: Handle) =>
        effect('file-close', async () => {
            const fd = handle.fd;
            await handle.close();
            handles.delete(fd);
            owner.publicationFDs.delete(fd);
        });
    const readBytes = async (file: string, maximum: number) => {
        const handle = await opened(file, 'read');
        const before = await effect('file-stat', () => handle.stat({ bigint: true }));
        assert.ok(
            before.isFile() &&
                before.nlink === 1n &&
                before.size > 0n &&
                before.size <= BigInt(maximum),
        );
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let at = 0;
        for (;;) {
            const { bytesRead } = await effect('file-read', () =>
                handle.read(bytes, at, bytes.length - at, at),
            );
            assert.ok(
                Number.isSafeInteger(bytesRead) && bytesRead >= 0 && bytesRead <= bytes.length - at,
            );
            if (!bytesRead) break;
            at += bytesRead;
            assert.ok(at <= Number(before.size));
        }
        const after = await effect('file-stat', () => handle.stat({ bigint: true }));
        for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
            assert.equal(after[key], before[key]);
        assert.equal(at, Number(before.size));
        await close(handle);
        return bytes.subarray(0, at);
    };
    const json = async (file: string, maximum: number) =>
        JSON.parse((await readBytes(file, maximum)).toString('utf8'));
    // Use the existing bounded streaming reader, supplying tracked IO instead of
    // its native defaults. A late or failed open/close remains reachable in custody.
    const hashFile = (file: string) =>
        sampleMacArchive(file, {
            realpath: (file: string) => effect('hash-realpath', () => ports.realpath(file)),
            lstat: (file: string) => effect('hash-lstat', () => ports.lstat(file)),
            open: async (file: string) => {
                const handle = await opened(file, 'read');
                return {
                    stat: () => effect('hash-stat', () => handle.stat({ bigint: true })),
                    read: (buffer: Buffer, offset: number, length: number, position: number) =>
                        effect('hash-read', () => handle.read(buffer, offset, length, position)),
                    close: () => close(handle),
                };
            },
            // Its JS default also describes directory-walk IO; this single-file reader
            // consumes exactly realpath/lstat/open and the handle's stat/read/close.
        } as unknown as Parameters<typeof sampleMacArchive>[1]);
    const publish = async (file: string, value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
        assert.ok(bytes.length <= 32768, 'Runtime observation exceeds its byte bound.');
        const handle = await opened(file, 'create');
        await effect('publication-write', () => handle.writeFile(bytes));
        await effect('publication-sync', () => handle.sync());
        await close(handle);
        assert.ok((await readBytes(file, 32768)).equals(bytes));
    };
    try {
        for (const file of [
            input.cwd,
            input.executable,
            asar,
            input.buildInfo,
            path.dirname(input.root),
            path.dirname(input.destination),
        ])
            assert.equal(await effect('canonical-input', () => ports.realpath(file)), file);
        await effect('runtime-root', () => ports.mkdir(input.root));
        await effect('runtime-profile', () => ports.mkdir(profile));
        await effect('runtime-artifacts', () => ports.mkdir(artifactsDir));
        await effect('runtime-home', () => ports.mkdir(environment.HOME!));
        await effect('runtime-temp', () => ports.mkdir(environment.TMPDIR!));
        const pkg = await json(path.join(input.cwd, 'package.json'), 65536);
        const lock = await json(path.join(input.cwd, 'package-lock.json'), 1048576);
        const info = await json(input.buildInfo, 65536);
        stage = 'package-binding';
        assert.equal(pkg.version, lock.version);
        assert.equal(pkg.version, lock.packages[''].version);
        assert.equal(pkg.devDependencies.electron, lock.packages['node_modules/electron'].version);
        validateMacManifest(info, {
            arch: input.arch,
            version: pkg.version,
            commit: input.sourceCommit,
            sha256: info.sha256,
        });
        assert.equal(info.source, input.sourceCommit);
        assert.equal(info.packagedSourceMatches, true);
        assert.equal(info.distribution, true);
        assert.ok(info.payloadIdentity);
        validateMacPayloadIdentity(info.payloadIdentity);
        const disk = async () => {
            const executable = await hashFile(input.executable);
            const archive = await hashFile(asar);
            assert.equal(executable.sha256, info.payloadIdentity.executableSHA256);
            assert.equal(archive.sha256, info.asarSHA256);
            assert.equal(archive.sha256, info.payloadIdentity.asarSHA256);
            return { executableSHA256: executable.sha256, asarSHA256: archive.sha256 };
        };
        await disk();
        stage = 'launch';
        desktop.launch();
        await effect('runtime-attach', () => desktop.attach());
        const page = await effect('runtime-window', () => desktop.firstWindow());
        await effect('runtime-url', () => page.waitForURL('app://bundle/index.html'));
        await effect('runtime-overview', () => ports.overview(page));
        const identity = await effect('runtime-identity', () =>
            desktop.evaluate(
                async ({ app, BrowserWindow }, marker) => {
                    const windows = BrowserWindow.getAllWindows();
                    if (windows.length !== 1)
                        throw Error('Expected one packaged application window.');
                    const contents = windows[0].webContents;
                    const key = JSON.stringify(marker);
                    await contents.executeJavaScriptInIsolatedWorld(999, [
                        { code: `globalThis[${key}]=true` },
                    ]);
                    let isolated;
                    try {
                        isolated = await contents.executeJavaScript(
                            `typeof globalThis[${key}] === 'undefined'`,
                        );
                    } finally {
                        await contents.executeJavaScriptInIsolatedWorld(999, [
                            { code: `delete globalThis[${key}]` },
                        ]);
                    }
                    const noPageNode = await contents.executeJavaScript(
                        'typeof process === "undefined" && typeof require === "undefined"',
                    );
                    const rendererPID = contents.getOSProcessId();
                    const metric = app.getAppMetrics().find((item) => item.pid === rendererPID);
                    return {
                        asset: process.env.HUB_STAGED_ASSET,
                        packaged: app.isPackaged,
                        version: app.getVersion(),
                        platform: process.platform,
                        arch: process.arch,
                        executable: process.execPath,
                        asar: app.getAppPath(),
                        pid: process.pid,
                        rendererPID,
                        osSandboxed: metric?.sandboxed ?? null,
                        contextsSeparated: isolated === true,
                        pageNodeAbsent: noPageNode === true,
                        versions: {
                            node: process.versions.node,
                            electron: process.versions.electron,
                            chrome: process.versions.chrome,
                        },
                        sandbox:
                            isolated === true &&
                            noPageNode === true &&
                            !process.argv.includes('--no-sandbox'),
                        profile: app.getPath('userData'),
                        cwd: process.cwd(),
                        nativeVisible: windows[0].isVisible(),
                    };
                },
                '__stagedQualification_' + randomUUID().replaceAll('-', ''),
            ),
        );
        stage = 'identity-binding';
        identity.sandbox = identity.sandbox && identity.osSandboxed === true;
        assert.equal(identity.packaged, true);
        assert.equal(identity.version, pkg.version);
        assert.equal(identity.platform, 'darwin');
        assert.equal(identity.arch, input.arch);
        assert.equal(identity.sandbox, true);
        assert.equal(identity.contextsSeparated, true);
        assert.equal(identity.pageNodeAbsent, true);
        assert.equal(path.basename(identity.asar), 'app.asar');
        assert.equal(identity.asset, input.asset);
        assert.equal(identity.executable, input.executable);
        assert.equal(identity.pid, desktop.process().pid);
        assert.equal(identity.asar, asar);
        assert.equal(identity.profile, profile);
        assert.equal(identity.cwd, input.cwd);
        assert.equal(identity.nativeVisible, true);
        assert.equal(identity.versions.electron, lock.packages['node_modules/electron'].version);
        // Capture Electron's embedded Node; the selected build/driver Node does not pin it.
        assert.match(identity.versions.node, /^\d+\.\d+\.\d+(?:[-+].*)?$/);
        assert.ok(
            typeof identity.versions.chrome === 'string' && identity.versions.chrome.length > 0,
        );
        const boundIdentity = Object.assign(identity, await disk(), {
            sourceCommit: input.sourceCommit,
            startupRoot: input.root,
            fixtureNetworkMode: 'default',
            diskIdentityOnly: true,
            physicalLoadedBytesVerified: false,
            physicalDescendantClosure: false,
        });
        context.identity = boundIdentity;
        await publish(path.join(input.root, 'prequit.json'), {
            identity: boundIdentity,
            closure: desktop.snapshot(),
            releaseAcceptance: false,
        });
        assert.equal(handles.size, 0);
        assert.equal(owner.publicationFDs.size, 0);
        assert.equal(owner.pendingWaits.size, 0);
        owner.preQuitReceiptVerified = true;
        stage = 'normal-quit';
        await desktop.normalQuit();
        stage = 'closure-binding';
        assert.ok(owner.quitComplete && owner.exitObserved && owner.closeObserved);
        assert.equal(owner.exitCode, 0);
        assert.equal(owner.signal, null);
        assert.ok(
            owner.streams.stdoutComplete &&
                owner.streams.stderrComplete &&
                owner.streams.stdoutEOF &&
                owner.streams.stderrEOF,
        );
        const closure = desktop.snapshot();
        assert.equal(closure.mainTransportClosed, true);
        assert.equal(closure.rendererTransportClosed, true);
        assert.equal(closure.physicalDescendantClosure, false);
        await publish(path.join(input.root, 'closure.json'), { closure, releaseAcceptance: false });
        await publish(input.destination, { ...boundIdentity, closure, releaseAcceptance: false });
        return boundIdentity;
    } catch (error) {
        context.error = error;
        owner.freeze('staged-mac-runtime-failed');
        try {
            ports.reportFailure(macRuntimeFailureDiagnostic(stage, owner, handles.size));
        } catch {
            /* Reporting cannot replace retained custody. */
        }
        return ports.retain(context);
    }
}
