import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
    reportFailure(): void;
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
    const effect = <T>(phase: string, operation: () => Promise<T>) => {
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
        await desktop.normalQuit();
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
            ports.reportFailure();
        } catch {
            /* Reporting cannot replace retained custody. */
        }
        return ports.retain(context);
    }
}
