/** Initial Finalize through actual caller/owner/backend, with MapFS and manual process/channel ports only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { readFileSync, constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { EventEmitter } from 'node:events';
import * as model from '../electron/linux-transaction-model.ts';
import * as installation from '../shared/installation.ts';
import * as menu from '../electron/linux-menu-ownership.ts';
import * as readiness from '../electron/linux-setup-readiness.ts';
import { linuxReviewArguments } from '../electron/linux-setup-ui.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';

const root = new URL('../', import.meta.url),
    hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const allowed = new Set(
    [
        'tests/linux-retained-generations.test.ts',
        'tests/linux-native-backend.test.ts',
        'electron/installation-maintenance.ts',
        'electron/linux-setup-readback-native.ts',
        'electron/linux-initial-uninstall.ts',
        'electron/linux-retained-cleanup.ts',
        'electron/linux-native-backend.ts',
        'electron/linux-native-driver.ts',
        'electron/linux-owned-launch.ts',
        'electron/linux-setup-readiness.ts',
        'electron/linux-setup-readback.ts',
        'electron/linux-permanent-setup.ts',
    ].map((name) => new URL(name, root).href),
);
const read = (url: URL) => {
    assert.ok(allowed.has(url.href), 'Unadmitted fixed source read.');
    return readFileSync(url, 'utf8');
};
const refuse = () => {
    throw Error('UNADMITTED_REAL_PORT');
};
function definitions(source: string, bindings: Record<string, unknown>) {
    const compiled = ts.transpileModule(source, {
        fileName: 'fixed-inert-declarations.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    });
    assert.equal(
        (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
            .length,
        0,
    );
    const module = { exports: {} as any };
    new vm.Script(compiled.outputText).runInContext(
        vm.createContext(
            {
                module,
                exports: module.exports,
                Object,
                JSON,
                Map,
                Set,
                Buffer,
                Error,
                Promise,
                TextDecoder,
                URL,
                structuredClone,
                assert,
                vm,
                ts,
                root,
                read,
                refuse,
                ...bindings,
            },
            { codeGeneration: { strings: false, wasm: false } },
        ),
        { timeout: 1000 },
    );
    return module.exports;
}
const helperSource = read(new URL('tests/linux-retained-generations.test.ts', root));
assert.equal(
    hash(helperSource),
    '705496e44aa6961c110630aec9eab5262396102cb671c9a4fb7837e37bc0251b',
);
const helperTree = ts.createSourceFile(
    'fixed-loader.ts',
    helperSource,
    ts.ScriptTarget.ES2022,
    true,
);
const helpers = helperTree.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'subject',
);
assert.equal(helpers.length, 1);
const subject = definitions(helpers[0].getText(helperTree) + '\nmodule.exports=subject;', {});
const maintenanceSource = read(new URL('electron/installation-maintenance.ts', root)),
    maintenanceTree = ts.createSourceFile(
        'fixed-maintenance.ts',
        maintenanceSource,
        ts.ScriptTarget.ES2022,
        true,
    );
const declarations: string[] = [];
for (const key of ['SETUP_OWNER', 'SETUP_PAYLOAD']) {
    const found = maintenanceTree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === key);
    assert.equal(found.length, 1);
    assert.ok(found[0].initializer && ts.isStringLiteral(found[0].initializer));
    declarations.push('const ' + found[0].getText(maintenanceTree) + ';');
}
const paths = maintenanceTree.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'maintenancePaths',
);
assert.equal(paths.length, 1);
const maintenance = definitions(
    declarations.join('\n') +
        '\n' +
        paths[0].getText(maintenanceTree) +
        '\nmodule.exports={SETUP_OWNER,SETUP_PAYLOAD,maintenancePaths};',
    { path, createHash, process: Object.freeze({ platform: 'linux' }) },
);
const nativeTree = ts.createSourceFile(
    'fixed-native-constant.ts',
    read(new URL('electron/linux-setup-readback-native.ts', root)),
    ts.ScriptTarget.ES2022,
    true,
);
const nativeConstants = nativeTree.statements
    .flatMap((node) =>
        ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
    )
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'LINUX_SETUP_READBACK_ENV');
assert.equal(nativeConstants.length, 1);
assert.ok(nativeConstants[0].initializer && ts.isStringLiteral(nativeConstants[0].initializer));
const nativeQuitConstants = nativeTree.statements
    .flatMap((node) =>
        ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
    )
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'LINUX_SETUP_QUIT_ENV');
assert.equal(nativeQuitConstants.length, 1);
assert.ok(
    nativeQuitConstants[0].initializer && ts.isStringLiteral(nativeQuitConstants[0].initializer),
);
const common = new Map<string, unknown>([
    ['node:path', path],
    ['node:crypto', { createHash, randomUUID: refuse }],
    ['node:util', { types: utilTypes }],
    ['./linux-transaction-model.ts', model],
    ['../shared/installation.ts', installation],
    ['./installation-maintenance.ts', maintenance],
    ['./linux-menu-ownership.ts', menu],
]);
const readback = subject(
    'electron/linux-setup-readback.ts',
    new Map([
        ...common,
        ['node:crypto', { randomBytes }],
        ['./linux-setup-readiness.ts', readiness],
    ]),
);
const removal = subject('electron/linux-initial-uninstall.ts', common);
const cleanup = subject('electron/linux-retained-cleanup.ts', common);
const backend = subject(
    'electron/linux-native-backend.ts',
    new Map([
        ...common,
        ['node:net', { createServer: refuse }],
        ['./physical-fs.ts', { physicalFS: {} }],
        ['./linux-initial-uninstall.ts', removal],
        ['./linux-retained-cleanup.ts', cleanup],
    ]),
);
const driver = subject(
    'electron/linux-native-driver.ts',
    new Map([...common, ['./linux-native-backend.ts', backend]]),
);
const installerClocks = new WeakMap<object, { offset: number }>();
const owned = subject(
    'electron/linux-owned-launch.ts',
    new Map([
        ...common,
        ['node:child_process', { spawn: refuse }],
        [
            'node:net',
            {
                Socket: class {
                    constructor() {
                        refuse();
                    }
                },
            },
        ],
        ['./linux-native-driver.ts', driver],
        ['./linux-native-backend.ts', backend],
        [
            './linux-setup-readback.ts',
            {
                ...readback,
                createLinuxInstallerReadback(...args: any[]) {
                    const clock = installerClocks.get(args[0]);
                    if (clock)
                        args[2] = {
                            now: () => Date.now() + clock.offset,
                            nonce: () => randomBytes(32),
                        };
                    return Reflect.apply(readback.createLinuxInstallerReadback, undefined, args);
                },
            },
        ],
        [
            './linux-setup-readback-native.ts',
            {
                LINUX_SETUP_READBACK_ENV: nativeConstants[0].initializer.text,
                LINUX_SETUP_QUIT_ENV: nativeQuitConstants[0].initializer.text,
            },
        ],
    ]),
);
const fixtureSource = read(new URL('tests/linux-native-backend.test.ts', root));
assert.equal(
    hash(fixtureSource),
    '117374f6d75ac5b30b7b51bd881871861bef1afddf3760ec0a4b7758cddf8c43',
);
const tree = ts.createSourceFile(
        'fixed-memory-fixture.ts',
        fixtureSource,
        ts.ScriptTarget.ES2022,
        true,
    ),
    parts: string[] = [];
for (const name of ['hash', 'clone', 'installationId', 'transactionId', 'token', 'procStat']) {
    const found = tree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(found.length, 1);
    parts.push('const ' + found[0].getText(tree) + ';');
}
for (const name of ['FakeServer', 'fixture', 'menuFixture']) {
    const found = tree.statements.filter(
        (node) =>
            (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
            node.name?.text === name,
    );
    assert.equal(found.length, 1);
    parts.push(found[0].getText(tree));
}
const fixtures = definitions(
    parts.join('\n') + '\nmodule.exports={fixture,menuFixture,FakeServer,procStat};',
    {
        constants,
        createHash,
        EventEmitter,
        queueMicrotask,
        ...backend,
        ...maintenance,
        INSTALLATION_PRODUCT: installation.INSTALLATION_PRODUCT,
        validateInstallationManifest: installation.validateInstallationManifest,
        linuxModelReviewSHA256: model.linuxModelReviewSHA256,
        desiredLinuxMenu: menu.desiredLinuxMenu,
    },
);
const watch = (operation: Promise<any>) => ({
    operation,
    outcome: operation.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
    ),
});
const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const bytes = (f: any, file: string) => Buffer.from(f.node(file).bytes),
    json = (f: any, file: string) => JSON.parse(bytes(f, file).toString());
const changes = (name: string) => ['write', 'truncate', 'mkdir', 'move-noreplace'].includes(name);
function memory(selected = false) {
    const f: any = fixtures.menuFixture(selected, false);
    let sequence = 0;
    f.ops.uuid = () => '33333333-3333-4333-8333-' + (++sequence).toString(16).padStart(12, '0');
    f.servers = [];
    f.ops.server = () => {
        const server = new fixtures.FakeServer(),
            listen = server.listen.bind(server);
        server.listen = (options: any) => {
            server.unavailable = f.servers.some((s: any) => s.listening);
            return listen(options);
        };
        f.servers.push(server);
        return server;
    };
    const move = f.ops.moveNoReplace;
    f.archiveCalls = 0;
    f.ops.moveNoReplace = (a: number, b: string, c: number, d: string) => {
        const archive = b === 'journal.json' && d === 'completed-journal.json';
        if (archive) {
            f.archiveCalls++;
            f.beforeArchive?.();
        }
        f.beforeCleanupMove?.(f.fds.get(a).path + '/' + b, f.fds.get(c).path + '/' + d);
        move(a, b, c, d);
        f.afterCleanupMove?.(f.fds.get(a).path + '/' + b, f.fds.get(c).path + '/' + d);
        if (archive) f.afterArchive?.();
    };
    f.unlinkCalls = [];
    f.ops.unlinkOwned = (fd: number, name: string, kind: string, identity: any) => {
        const file = f.fds.get(fd).path + '/' + name,
            node = f.node(file);
        assert.equal(name, 'entry');
        assert.ok(file.startsWith(f.work + '-finalize-') && file.endsWith('/disposal/entry'));
        assert.equal(f.node(path.posix.dirname(file)).mode & 0o7777, 0o700);
        assert.equal(node.ino, identity.ino);
        assert.equal(identity.dev, 1);
        assert.equal(node.kind, kind);
        if (kind === 'directory')
            assert.equal(
                Array.from(f.nodes.keys() as Iterable<string>).some(
                    (other) => path.posix.dirname(other) === file,
                ),
                false,
            );
        f.calls.push('unlink-owned');
        f.unlinkCalls.push(file);
        f.beforeUnlink?.(file);
        f.nodes.delete(file);
        f.afterUnlink?.(file);
    };
    f.run = (operation: string) => {
        const attempt: any = {
            operation,
            spawn: defer(),
            requests: [],
            pair: linuxReadbackPair(),
            settled: false,
            clock: { offset: 0 },
        };
        installerClocks.set(attempt.pair.parent, attempt.clock);
        const child = Object.assign(new EventEmitter(), {
            pid: 888,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        });
        Object.assign(child, { stdio: [null, child.stdout, child.stderr, attempt.pair.parent] });
        attempt.child = child;
        const api = subject(
            'electron/linux-permanent-setup.ts',
            new Map([
                ...common,
                ['./linux-setup-ui.ts', { linuxReviewArguments }],
                ['./linux-native-driver.ts', driver],
                ['./linux-native-backend.ts', backend],
                ['./linux-setup-readback.ts', readback],
                [
                    './linux-setup-review.ts',
                    {
                        linuxReviewDisk: {
                            async bytes(file: string, cap: number, uid: number) {
                                assert.equal(uid, 1000);
                                assert.equal(
                                    file,
                                    f.plan.host.sourceRoot + '/' + maintenance.SETUP_PAYLOAD,
                                );
                                const value = bytes(f, file);
                                assert.ok(value.length <= cap);
                                return value;
                            },
                        },
                    },
                ],
                [
                    './linux-native-host.ts',
                    {
                        async createLinuxNativeHost() {
                            return {
                                operations: f.ops,
                                owner: f.plan.owner,
                                diagnostics: () => ({ loadAttempted: false, loaded: false }),
                            };
                        },
                        linuxNativeHostFailureCustody: () => null,
                    },
                ],
                [
                    './linux-owned-launch.ts',
                    {
                        ...owned,
                        createLinuxOwnedLaunch(...args: any[]) {
                            const returned = Reflect.apply(
                                owned.createLinuxOwnedLaunch,
                                undefined,
                                args,
                            );
                            attempt.controller = returned;
                            return returned;
                        },
                        createLinuxNativeLaunchProcessHost: () => ({
                            spawn(request: any) {
                                attempt.requests.push(request);
                                attempt.spawn.resolve();
                                return child;
                            },
                        }),
                    },
                ],
            ]),
        );
        attempt.api = api;
        const prompt = {
            async review() {
                return f.reply ?? { status: 'confirmed', menu: selected };
            },
            hasPending: () => false,
        };
        Object.assign(
            attempt,
            watch(
                api.runLinuxPermanentSetup(
                    f.plan.host,
                    {
                        root: f.plan.root,
                        version: f.plan.host.version,
                        operation,
                        menu: selected,
                        menuExplicit: true,
                        terminal: true,
                    },
                    f.plan.menu.dataHome,
                    { gui: prompt, terminal: prompt, now: f.ops.now },
                    { DISPLAY: ':99' },
                ),
            ),
        );
        attempt.outcome.then(() => {
            attempt.settled = true;
        });
        return attempt;
    };
    f.work = maintenance.maintenancePaths(f.plan.root).work;
    f.readyIO = (attempt: any) => {
        const c = {
            platform: 'linux',
            arch: 'x64',
            layout: 'linux-folder',
            packaged: true,
            root: f.plan.root,
            installationId: json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD)
                .installationId,
            manifestSHA256: json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD)
                .manifestSHA256,
            version: json(f, f.plan.root + '/' + installation.INSTALLATION_MANIFEST).version,
            profile: json(
                f,
                f.work +
                    (f.nodes.has(f.work + '/journal.json')
                        ? '/journal.json'
                        : '/completed-journal.json'),
            ).profile,
            executable: f.plan.root + '/app/diagnostic-hub',
            pid: 888,
            uid: 1000,
            euid: 1000,
            processCreationMs: 10000,
            appUrl: 'app://bundle/index.html',
        };
        const sample = {
            window: {},
            contents: {},
            frame: {},
            frameUrl: c.appUrl,
            electronId: 1,
            nativeHandle: Buffer.from('0100000000000000', 'hex'),
            visible: true,
            minimized: false,
            loading: false,
            profile: c.profile,
            ownsProfile: true,
            quitting: false,
            nowMs: Date.now(),
            generation: 0,
        };
        const permitted = new Set([
            c.root + '/' + maintenance.SETUP_OWNER,
            f.work + '/journal.json',
            f.work + '/completed-journal.json',
        ]);
        const io = {
            async bytes(file: string, cap: number, uid: number) {
                assert.ok(permitted.has(file));
                assert.equal(cap, 8192);
                assert.equal(uid, 1000);
                f.beforeReadyRead?.(file);
                const value = bytes(f, file);
                assert.ok(value.length <= cap);
                return value;
            },
            async node(file: string) {
                assert.ok(permitted.has(file));
                f.beforeReadyNode?.(file);
                const item = f.nodes.get(file);
                return item
                    ? {
                          kind: item.kind === 'link' ? 'other' : item.kind,
                          uid: item.uid,
                          mode: item.mode,
                          dev: 1,
                          ino: item.ino,
                          nlink: item.nlink,
                          size: item.bytes.length,
                          mtimeMs: item.mtime,
                          ctimeMs: item.mtime,
                      }
                    : null;
            },
        };
        attempt.readyContext = c;
        attempt.sample = sample;
        attempt.readyIO = io;
        return () =>
            readiness.observeLinuxSetupReadiness(
                c,
                () => {
                    sample.nowMs = Date.now();
                    return sample;
                },
                io,
            );
    };
    return f;
}
async function seed(selected = false) {
    const f = memory(selected),
        a = f.run('install');
    assert.equal((await a.operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    return f;
}
function candidate(f: any, version: string) {
    const text = Buffer.from('actual-memory-candidate-' + version),
        source = f.plan.host.sourceRoot,
        manifest = json(f, source + '/' + maintenance.SETUP_PAYLOAD);
    f.node(source + '/app/diagnostic-hub').bytes = text;
    manifest.version = version;
    manifest.files[0] = {
        kind: 'file',
        path: 'app/diagnostic-hub',
        bytes: text.length,
        sha256: hash(text),
    };
    const raw = Buffer.from(JSON.stringify(manifest));
    f.node(source + '/' + maintenance.SETUP_PAYLOAD).bytes = raw;
    f.plan.review.source.manifest = installation.validateInstallationManifest(manifest);
    f.plan.review.source.verifiedManifestSHA256 = hash(raw);
    f.plan.host.version = version;
}
async function updated() {
    const f = await seed(),
        originalA = bytes(f, f.work + '/journal.json');
    candidate(f, '0.7.0');
    assert.equal((await f.run('update').operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    return { f, originalA, originalB: bytes(f, f.work + '/journal.json') };
}
async function phase(attempt: any, name: string) {
    for (let at = 0; at < 1000; at++) {
        if (attempt.controller?.summary().pending === name || attempt.settled) break;
        await Promise.resolve();
    }
    assert.equal(
        attempt.controller?.summary().pending,
        name,
        JSON.stringify(attempt.controller?.summary()),
    );
}
async function start(f: any, attempt: any) {
    const entered: any = await Promise.race([
        attempt.spawn.promise.then(() => ({ entered: true })),
        attempt.outcome,
    ]);
    assert.equal(entered.entered, true, JSON.stringify(entered));
    f.directory('/proc/888', 1000);
    f.file(
        '/proc/888/stat',
        fixtures.procStat(888, '10001').replace(' S 0 ', ' S 777 '),
        0o444,
    ).proc = true;
    const executable = f.file('/proc/888/exe', '', 0o777);
    executable.kind = 'link';
    executable.target = f.plan.root + '/app/diagnostic-hub';
    attempt.child.emit('spawn');
    await phase(attempt, 'setup-readback');
}
function close(f: any, attempt: any) {
    f.node('/proc/888/stat').bytes = Buffer.from(
        fixtures.procStat(888, '10001', 'Z').replace(' Z 0 ', ' Z 777 '),
    );
    attempt.child.emit('exit', 0, null);
    for (const pipe of [attempt.child.stdout, attempt.child.stderr]) {
        pipe.emit('end');
        pipe.emit('close');
    }
    attempt.child.emit('close', 0, null);
}
async function join(f: any, attempt: any) {
    for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
    await attempt.pair.pump();
    await attempt.outcome;
}
async function boot(f: any, attempt: any) {
    const refresh = f.readyIO(attempt),
        initial = await refresh();
    assert.ok(initial);
    const main = readback.createLinuxMainReadback(attempt.pair.child);
    main.offer(initial, refresh);
    attempt.main = main;
    await attempt.pair.pump(
        () => attempt.controller.summary().pending === 'child-and-pipe-close' || attempt.settled,
    );
    assert.equal(
        attempt.controller.summary().pending,
        'child-and-pipe-close',
        JSON.stringify({
            summary: attempt.controller.summary(),
            diagnostics: attempt.controller.diagnostics(),
            main: main.summary(),
            archiveCalls: f.archiveCalls,
            activeJournalPresent: f.nodes.has(f.work + '/journal.json'),
            completedJournalPresent: f.nodes.has(f.work + '/completed-journal.json'),
            attemptSettled: attempt.settled,
        }),
    );
}
async function interruptedSeal(f: any) {
    const a = f.run('finalize');
    try {
        await start(f, a);
        const refresh = f.readyIO(a),
            initial = await refresh();
        assert.ok(initial);
        a.main = readback.createLinuxMainReadback(a.pair.child);
        a.main.offer(initial, refresh);
        await a.pair.pump(() => a.settled);
        const result = await a.operation;
        assert.equal(result.status, 'retained-unknown');
        assert.equal(result.result.retainedConfirmed, false);
        close(f, a);
        return { attempt: a, result };
    } finally {
        await join(f, a);
    }
}
function authoredSealRestart(f: any) {
    // Manual MapFS OS-restart facts only; no process, FD or real reservation is controlled.
    for (const server of f.servers) server.listening = false;
    f.beforeCleanupMove = undefined;
    f.afterCleanupMove = undefined;
}

test('shipping Finalize confirms a live initial app then retains exact original completion before close', async () => {
    const f = await seed(),
        original = bytes(f, f.work + '/journal.json'),
        rootInode = f.node(f.plan.root).ino;
    const id = json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD).installationId,
        profile = f.plan.host.appData + '/DiagnosticHub/profiles/' + id + '/keep';
    f.file(profile, 'profile retained');
    const a = f.run('finalize');
    try {
        await start(f, a);
        await boot(f, a);
        assert.equal(a.controller.summary().initialConfirmed, true);
        assert.equal(a.settled, false);
        assert.equal(f.nodes.has(f.work + '/journal.json'), false);
        assert.deepEqual(bytes(f, f.work + '/completed-journal.json'), original);
        assert.equal(f.archiveCalls, 1);
        assert.equal(f.servers.at(-1).listening, true);
        close(f, a);
        const result = await a.operation;
        assert.equal(result.status, 'initial-finalized');
        assert.equal(result.result.initialConfirmed, true);
        assert.equal(result.result.successorVerified, false);
        assert.equal(result.result.wholeGroupRetirement, false);
        assert.equal(result.result.readback.finalizationAuthority, false);
        assert.equal(f.node(f.plan.root).ino, rootInode);
        assert.equal(bytes(f, profile).toString(), 'profile retained');
        assert.equal(f.servers.at(-1).listening, false);
        assert.equal(f.fds.size, 0);
        await a.main.joinClosure();
    } finally {
        await join(f, a);
    }
});

test('completed initial is idempotent without relaunch while ordinary relaunch uses actual preserved metadata', async () => {
    const f = await seed(),
        first = f.run('finalize');
    try {
        await start(f, first);
        await boot(f, first);
        close(f, first);
        assert.equal((await first.operation).status, 'initial-finalized');
    } finally {
        await join(f, first);
    }
    const original = bytes(f, f.work + '/completed-journal.json'),
        again = f.run('finalize');
    assert.equal((await again.operation).status, 'initial-already-completed');
    assert.equal(again.requests.length, 0);
    assert.equal(f.archiveCalls, 1);
    const launch = f.run('launch');
    try {
        await start(f, launch);
        await boot(f, launch);
        close(f, launch);
        const result = await launch.operation;
        assert.equal(result.result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
        assert.equal(result.result.reservation, 'none');
        assert.deepEqual(bytes(f, f.work + '/completed-journal.json'), original);
        assert.equal(f.archiveCalls, 1);
    } finally {
        await join(f, launch);
    }
});

test('menu retained predecessor stage and foreign history refuse Finalize before any app or mutation', async () => {
    for (const mode of ['menu', 'previous', 'stage', 'foreign']) {
        const f = await seed(mode === 'menu');
        if (mode === 'previous') {
            const journal = json(f, f.work + '/journal.json');
            journal.previousSHA256 = 'b'.repeat(64);
            f.node(f.work + '/journal.json').bytes = Buffer.from(JSON.stringify(journal));
        }
        if (mode === 'stage')
            f.directory(f.work + '/stage-' + json(f, f.work + '/journal.json').transactionId);
        if (mode === 'foreign') f.file(f.work + '/foreign.json', 'foreign');
        const before = bytes(f, f.work + '/journal.json'),
            at = f.calls.length,
            a = f.run('finalize'),
            result = await a.operation;
        assert.equal(result.status, 'retained-unknown');
        assert.equal(a.requests.length, 0);
        assert.equal(f.calls.slice(at).some(changes), false);
        assert.deepEqual(bytes(f, f.work + '/journal.json'), before);
    }
});

test('cancelled or changed candidate and stale or mismatched live readiness never archive an original', async () => {
    for (const mode of ['cancel', 'candidate', 'profile', 'stale']) {
        const f = await seed(),
            original = bytes(f, f.work + '/journal.json');
        if (mode === 'cancel') f.reply = { status: 'cancelled' };
        const a = f.run('finalize');
        try {
            if (mode === 'cancel') {
                assert.equal((await a.operation).status, 'cancelled');
                assert.equal(a.requests.length, 0);
            } else {
                await start(f, a);
                const refresh = f.readyIO(a);
                if (mode === 'candidate')
                    f.node(f.plan.root + '/app/diagnostic-hub').bytes = Buffer.from('changed');
                if (mode === 'profile') a.sample.profile = '/home/test/foreign';
                const record = await refresh();
                if (mode === 'stale' && record) record.observedAtMs -= 3000;
                const main = readback.createLinuxMainReadback(a.pair.child);
                if (record) main.offer(record, async () => record);
                await a.pair.pump();
                for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
                assert.equal((await a.operation).result.verdict, 'RETAINED_UNKNOWN');
            }
            assert.equal(f.archiveCalls, 0);
            assert.deepEqual(bytes(f, f.work + '/journal.json'), original);
        } finally {
            await join(f, a);
        }
    }
});

test('falsey and lost archive acknowledgements retain owner and exact original without retry', async () => {
    for (const mode of ['before-error', 'before-undefined', 'after-error', 'after-undefined']) {
        const f = await seed(),
            original = bytes(f, f.work + '/journal.json');
        const failure = mode.endsWith('undefined') ? undefined : Error('private archive error');
        if (mode.startsWith('before'))
            f.beforeArchive = () => {
                throw failure;
            };
        else
            f.afterArchive = () => {
                throw failure;
            };
        const a = f.run('finalize');
        try {
            await start(f, a);
            const refresh = f.readyIO(a),
                main = readback.createLinuxMainReadback(a.pair.child),
                record = await refresh();
            assert.ok(record);
            main.offer(record, refresh);
            await a.pair.pump();
            const result = await a.operation;
            assert.equal(result.result.verdict, 'RETAINED_UNKNOWN');
            assert.equal(f.archiveCalls, 1);
            assert.equal(f.servers.at(-1).listening, true);
            assert.deepEqual(
                bytes(
                    f,
                    f.work +
                        (mode.startsWith('before') ? '/journal.json' : '/completed-journal.json'),
                ),
                original,
            );
        } finally {
            await join(f, a);
        }
    }
});

test('reentrant child closure and deadline at the commit seam cannot become confirmation success', async () => {
    for (const mode of ['exit', 'deadline']) {
        const f = await seed();
        f.beforeArchive = () => {
            if (mode === 'exit') close(f, a);
            else f.advance(120000);
        };
        const a = f.run('finalize');
        try {
            await start(f, a);
            const refresh = f.readyIO(a),
                main = readback.createLinuxMainReadback(a.pair.child),
                record = await refresh();
            assert.ok(record);
            main.offer(record, refresh);
            await a.pair.pump();
            const result = await a.operation;
            assert.equal(result.result.verdict, 'RETAINED_UNKNOWN');
            assert.equal(result.result.initialConfirmed, false);
            assert.equal(f.archiveCalls, 1);
            assert.ok(f.nodes.has(f.work + '/completed-journal.json'));
            assert.equal(f.servers.at(-1).listening, true);
        } finally {
            await join(f, a);
        }
    }
});

test('completed metadata fallback refuses active ambiguity unknown nodes replacement and noninitial originals', async () => {
    const f = await seed(),
        original = bytes(f, f.work + '/journal.json');
    f.file(f.work + '/completed-journal.json', original.toString());
    f.nodes.delete(f.work + '/journal.json');
    for (const mode of ['valid', 'appears', 'identity', 'noninitial', 'unknown']) {
        f.node(f.work + '/completed-journal.json').bytes = Buffer.from(original);
        let probes = 0;
        const a: any = {};
        const refresh = f.readyIO(a);
        f.beforeReadyNode = undefined;
        if (mode === 'noninitial') {
            const value = JSON.parse(original.toString());
            value.previousSHA256 = 'b'.repeat(64);
            f.node(f.work + '/completed-journal.json').bytes = Buffer.from(JSON.stringify(value));
        }
        if (mode === 'appears')
            f.beforeReadyNode = (file: string) => {
                if (file === f.work + '/journal.json' && ++probes === 2)
                    f.file(file, original.toString());
            };
        if (mode === 'identity')
            f.beforeReadyNode = (file: string) => {
                if (file === f.work + '/completed-journal.json' && ++probes === 2)
                    f.node(file).ino += 1000;
            };
        if (mode === 'unknown')
            a.readyIO.node = async () => {
                throw undefined;
            };
        const result = await refresh();
        assert.equal(Boolean(result), mode === 'valid');
        f.nodes.delete(f.work + '/journal.json');
    }
});

test('actual commit requires one-shot Finalize selection and an owned live channel rather than supplied flags', async () => {
    const f = await seed(),
        a = f.run('finalize');
    try {
        await start(f, a);
        const original = bytes(f, f.work + '/journal.json');
        assert.equal(f.archiveCalls, 0);
        assert.equal(a.controller.summary().initialConfirmed, false);
        const at = f.calls.length;
        await assert.rejects(a.controller.run(), /consumed/);
        assert.equal(f.calls.length, at);
        close(f, a);
        for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
        const result = await a.operation;
        assert.equal(result.result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(f.archiveCalls, 0);
        assert.deepEqual(bytes(f, f.work + '/journal.json'), original);
        assert.equal(result.result.readback.finalizationAuthority, false);
    } finally {
        await join(f, a);
    }
});

test('shipping first-predecessor Finalize removes only A, preserves originals and profile, then supports B relaunch and C rollback', async () => {
    const { f, originalA, originalB } = await updated(),
        journalB = JSON.parse(originalB.toString()),
        previous = f.work + '/previous-' + journalB.transactionId,
        ledger = f.work + '-finalize-' + journalB.transactionId,
        rootInode = f.node(f.plan.root).ino,
        profile = journalB.profile + '/keep';
    f.file(profile, 'profile retained through generations');
    const a = f.run('finalize');
    try {
        await start(f, a);
        await boot(f, a);
        assert.equal(a.controller.summary().retainedConfirmed, true);
        assert.equal(a.controller.summary().initialConfirmed, false);
        assert.equal(f.nodes.has(previous), false);
        assert.equal(json(f, ledger + '/state.json').phase, 'complete');
        assert.equal(json(f, f.work + '/journal.json').phase, 'candidate-confirmed');
        assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
        assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        assert.equal(f.unlinkCalls.length, 6);
        assert.equal(f.node(f.plan.root).ino, rootInode);
        close(f, a);
        const result = await a.operation;
        assert.equal(result.status, 'previous-generation-finalized');
        assert.equal(result.result.wholeGroupRetirement, false);
        assert.equal(result.result.successorVerified, false);
        assert.equal(result.result.readback.finalizationAuthority, false);
        assert.equal(f.fds.size, 0);
        await a.main.joinClosure();
    } finally {
        await join(f, a);
    }
    const again = f.run('finalize');
    assert.equal((await again.operation).status, 'previous-generation-already-finalized');
    assert.equal(again.requests.length, 0);
    const launch = f.run('launch');
    try {
        await start(f, launch);
        await boot(f, launch);
        close(f, launch);
        assert.equal((await launch.operation).result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
    } finally {
        await join(f, launch);
    }
    candidate(f, '0.8.0');
    assert.equal((await f.run('update').operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const currentC = json(f, f.work + '/journal.json');
    assert.equal(f.node(f.work + '/previous-' + currentC.transactionId).ino, rootInode);
    const beforeUnsupported = f.calls.length,
        unsupported = f.run('finalize');
    assert.equal((await unsupported.operation).status, 'retained-unknown');
    assert.equal(unsupported.requests.length, 0);
    assert.equal(f.calls.slice(beforeUnsupported).some(changes), false);
    const launchC = f.run('launch');
    try {
        await start(f, launchC);
        await boot(f, launchC);
        close(f, launchC);
        assert.equal((await launchC.operation).result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
    } finally {
        await join(f, launchC);
    }
    assert.equal((await f.run('rollback').operation).result.verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.plan.root).ino, rootInode);
    assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
    assert.equal(bytes(f, profile).toString(), 'profile retained through generations');
    assert.equal(f.unlinkCalls.length, 6);
});

test('explicit MapFS restart resumes issued predecessor removal or lost baseline-move ACK without repeating deleted members', async () => {
    for (const mode of ['unlink-ack', 'baseline-ack']) {
        const { f, originalA, originalB } = await updated(),
            transactionId = JSON.parse(originalB.toString()).transactionId,
            ledger = f.work + '-finalize-' + transactionId;
        let first = true;
        if (mode === 'unlink-ack')
            f.afterUnlink = () => {
                if (first) {
                    first = false;
                    throw undefined;
                }
            };
        else
            f.afterCleanupMove = (from: string, to: string) => {
                if (
                    first &&
                    from === f.work + '/completed-journal.json' &&
                    to === ledger + '/original-completed-journal.json'
                ) {
                    first = false;
                    throw undefined;
                }
            };
        const a = f.run('finalize');
        try {
            await start(f, a);
            const refresh = f.readyIO(a),
                initial = await refresh();
            assert.ok(initial);
            a.main = readback.createLinuxMainReadback(a.pair.child);
            a.main.offer(initial, refresh);
            await a.pair.pump(() => a.settled);
            const failed = await a.operation;
            assert.equal(failed.status, 'retained-unknown');
            assert.equal(failed.result.retainedConfirmed, false);
            assert.equal(f.unlinkCalls.length, mode === 'unlink-ack' ? 1 : 6);
            close(f, a);
        } finally {
            await join(f, a);
        }
        // Explicit authored OS-restart facts in memory; no actual process or reservation control.
        for (const server of f.servers) server.listening = false;
        f.afterUnlink = undefined;
        f.afterCleanupMove = undefined;
        const resumed = f.run('finalize');
        try {
            await start(f, resumed);
            await boot(f, resumed);
            close(f, resumed);
            assert.equal((await resumed.operation).status, 'previous-generation-finalized');
            assert.equal(f.unlinkCalls.length, 6);
            assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
            assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        } finally {
            await join(f, resumed);
        }
    }
});

test('missing unlink authority or an active predecessor refuses retained Finalize before a prompt or launch', async () => {
    for (const mode of ['capability', 'active']) {
        const { f, originalB } = await updated(),
            journal = JSON.parse(originalB.toString());
        if (mode === 'capability') f.ops.unlinkOwned = null;
        else {
            f.directory('/proc/888', 1000);
            f.file(
                '/proc/888/stat',
                fixtures.procStat(888, '10001').replace(' S 0 ', ' S 777 '),
                0o444,
            ).proc = true;
            const exe = f.file('/proc/888/exe', '', 0o777);
            exe.kind = 'link';
            exe.target = f.work + '/previous-' + journal.transactionId + '/app/diagnostic-hub';
        }
        const at = f.calls.length,
            a = f.run('finalize');
        assert.equal((await a.operation).status, 'retained-unknown');
        assert.equal(a.requests.length, 0);
        assert.equal(f.calls.slice(at).some(changes), false);
        assert.equal(f.unlinkCalls.length, 0);
        assert.deepEqual(bytes(f, f.work + '/journal.json'), originalB);
    }
});

test('legacy malformed active seal without atomic intent preserves originals and refuses automatic repair', async () => {
    const { f, originalA, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId,
        confirmed = Buffer.from(
            JSON.stringify({ ...JSON.parse(originalB.toString()), phase: 'candidate-confirmed' }),
        );
    let reached = false;
    f.afterCleanupMove = (from: string, to: string) => {
        if (
            from === f.work + '/completed-journal.json' &&
            to === ledger + '/original-completed-journal.json'
        ) {
            reached = true;
            throw undefined;
        }
    };
    const a = f.run('finalize');
    try {
        await start(f, a);
        const refresh = f.readyIO(a),
            initial = await refresh();
        assert.ok(initial);
        a.main = readback.createLinuxMainReadback(a.pair.child);
        a.main.offer(initial, refresh);
        await a.pair.pump(() => a.settled);
        assert.equal((await a.operation).status, 'retained-unknown');
        assert.equal(reached, true);
        assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
        assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        assert.equal(f.nodes.has(ledger + '/seal-intent.json'), false);
        // Reconstruct the exact legacy49dd in-place failure postimage in MapFS only.
        // New source never produces this active-journal overwrite.
        const partial = Buffer.from(confirmed.subarray(0, originalB.length));
        assert.notDeepEqual(partial, originalB);
        assert.ok(partial.length < confirmed.length);
        f.node(f.work + '/journal.json').bytes = partial;
        assert.throws(() => json(f, f.work + '/journal.json'));
        const at = f.calls.length,
            blocked = f.run('finalize');
        assert.equal((await blocked.operation).status, 'retained-unknown');
        assert.equal(blocked.requests.length, 0);
        assert.equal(f.calls.slice(at).some(changes), false);
        assert.equal(f.unlinkCalls.length, 6);
        assert.deepEqual(bytes(f, f.work + '/journal.json'), partial);
        assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
        assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        close(f, a);
    } finally {
        await join(f, a);
    }
});

test('retained cleanup uses fresh one-shot admission without pretending a slow cleanup has fresh UI observations', async () => {
    const { f, originalA, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId,
        a = f.run('finalize');
    let first = true;
    f.afterUnlink = () => {
        if (first) {
            first = false;
            a.clock.offset = 3000;
            f.advance(3000);
        }
    };
    try {
        await start(f, a);
        await boot(f, a);
        assert.equal(a.controller.readiness(), null);
        assert.equal(a.controller.summary().retainedConfirmed, true);
        assert.equal(a.controller.summary().successorVerified, false);
        assert.equal(f.unlinkCalls.length, 6);
        assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
        assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        close(f, a);
        assert.equal((await a.operation).status, 'previous-generation-finalized');
    } finally {
        await join(f, a);
    }
    const stale = await updated(),
        b = stale.f.run('finalize');
    try {
        await start(stale.f, b);
        const refresh = stale.f.readyIO(b),
            record = await refresh();
        assert.ok(record);
        record.observedAtMs -= 3000;
        b.main = readback.createLinuxMainReadback(b.pair.child);
        b.main.offer(record, async () => record);
        await b.pair.pump();
        for (const expire of Array.from(stale.f.timers.values()) as (() => void)[]) expire();
        assert.equal((await b.operation).status, 'retained-unknown');
        assert.equal(stale.f.unlinkCalls.length, 0);
        assert.deepEqual(bytes(stale.f, stale.f.work + '/journal.json'), stale.originalB);
    } finally {
        await join(stale.f, b);
    }
});

test('admitted cleanup still stops on owned-child exit, current-payload change or deadline after the first member', async () => {
    for (const mode of ['child', 'current', 'deadline']) {
        const { f, originalA, originalB } = await updated(),
            ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId,
            a = f.run('finalize');
        let first = true;
        f.afterUnlink = () => {
            if (!first) return;
            first = false;
            if (mode === 'child') close(f, a);
            if (mode === 'current')
                f.node(f.plan.root + '/app/diagnostic-hub').bytes = Buffer.from('foreign-current');
            if (mode === 'deadline') f.advance(120000);
        };
        try {
            await start(f, a);
            const refresh = f.readyIO(a),
                record = await refresh();
            assert.ok(record);
            a.main = readback.createLinuxMainReadback(a.pair.child);
            a.main.offer(record, refresh);
            await a.pair.pump(() => a.settled);
            const result = await a.operation;
            assert.equal(result.status, 'retained-unknown', mode);
            assert.equal(result.result.retainedConfirmed, false, mode);
            assert.equal(f.unlinkCalls.length, 1, mode);
            assert.deepEqual(bytes(f, f.work + '/journal.json'), originalB);
            assert.deepEqual(bytes(f, f.work + '/completed-journal.json'), originalA);
            assert.equal(json(f, ledger + '/state.json').leaf, 'unlink-issued');
            if (mode !== 'child') close(f, a);
        } finally {
            await join(f, a);
        }
    }
});

test('atomic seal resumes only its pinned partial stage without overwriting the active journal or launching during recovery', async () => {
    const { f, originalA, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId,
        write = f.ops.fs.writeSync.bind(f.ops.fs),
        cut = originalB.length;
    let reached = false,
        activeWrites = 0;
    f.ops.fs.writeSync = (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ) => {
        const file = f.fds.get(fd).path;
        if (file === f.work + '/journal.json' && buffer.toString().includes('candidate-confirmed'))
            activeWrites++;
        if (file === ledger + '/confirmed-journal.json') {
            assert.equal(f.nodes.has(ledger + '/seal-intent.json'), true);
            const count = write(fd, buffer, offset, Math.min(length, cut - position), position);
            if (position + count === cut) {
                reached = true;
                throw undefined;
            }
            return count;
        }
        return write(fd, buffer, offset, length, position);
    };
    await interruptedSeal(f);
    assert.equal(reached, true);
    assert.equal(activeWrites, 0);
    const intent = json(f, ledger + '/seal-intent.json'),
        stage = bytes(f, ledger + '/confirmed-journal.json'),
        confirmed = Buffer.from(
            JSON.stringify({ ...JSON.parse(originalB.toString()), phase: 'candidate-confirmed' }),
        );
    assert.equal(f.node(ledger + '/confirmed-journal.json').ino, intent.staged.ino);
    assert.deepEqual(stage, confirmed.subarray(0, cut));
    assert.throws(() => JSON.parse(stage.toString()));
    assert.deepEqual(bytes(f, f.work + '/journal.json'), originalB);
    authoredSealRestart(f);
    f.ops.fs.writeSync = write;
    const recovery = f.run('finalize'),
        result = await recovery.operation;
    assert.equal(result.status, 'previous-generation-seal-recovered');
    assert.equal(result.result.verdict, 'SEAL_RECOVERED_NO_LAUNCH');
    assert.equal(result.result.spawned, false);
    assert.equal(result.result.childOwned, false);
    assert.equal(result.result.retainedConfirmed, false);
    assert.equal(result.result.readback, null);
    assert.equal(recovery.requests.length, 0);
    assert.equal(result.result.reservation, 'none');
    assert.deepEqual(bytes(f, f.work + '/journal.json'), confirmed);
    assert.equal(f.node(f.work + '/journal.json').ino, intent.staged.ino);
    assert.equal(f.node(ledger + '/unconfirmed-journal.json').ino, intent.original.ino);
    assert.deepEqual(bytes(f, ledger + '/unconfirmed-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
    assert.equal(f.unlinkCalls.length, 6);
    const at = f.calls.length,
        repeated = f.run('finalize');
    assert.equal((await repeated.operation).status, 'previous-generation-already-finalized');
    assert.equal(repeated.requests.length, 0);
    assert.equal(f.calls.slice(at).some(changes), false);
});

test('atomic seal interruption before or after each rename reconciles one-sided state without repeating retirement', async () => {
    for (const mode of ['before-retire', 'after-retire', 'before-publish', 'after-publish']) {
        const { f, originalA, originalB } = await updated(),
            ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId;
        let reached = false,
            retiredMoves = 0,
            publishedMoves = 0;
        const fault = (from: string, to: string, after: boolean) => {
            const retire =
                    from === f.work + '/journal.json' &&
                    to === ledger + '/unconfirmed-journal.json',
                publish =
                    from === ledger + '/confirmed-journal.json' && to === f.work + '/journal.json';
            if (after && retire) retiredMoves++;
            if (after && publish) publishedMoves++;
            if (
                !reached &&
                ((mode === 'before-retire' && !after && retire) ||
                    (mode === 'after-retire' && after && retire) ||
                    (mode === 'before-publish' && !after && publish) ||
                    (mode === 'after-publish' && after && publish))
            ) {
                reached = true;
                throw undefined;
            }
        };
        f.beforeCleanupMove = (from: string, to: string) => fault(from, to, false);
        f.afterCleanupMove = (from: string, to: string) => fault(from, to, true);
        await interruptedSeal(f);
        assert.equal(reached, true, mode);
        const intent = json(f, ledger + '/seal-intent.json');
        authoredSealRestart(f);
        f.afterCleanupMove = (from: string, to: string) => {
            if (from === f.work + '/journal.json' && to === ledger + '/unconfirmed-journal.json')
                retiredMoves++;
            if (from === ledger + '/confirmed-journal.json' && to === f.work + '/journal.json')
                publishedMoves++;
        };
        const a = f.run('finalize'),
            result = await a.operation;
        assert.equal(
            result.status,
            mode === 'after-publish'
                ? 'previous-generation-already-finalized'
                : 'previous-generation-seal-recovered',
            mode,
        );
        assert.equal(a.requests.length, 0, mode);
        assert.equal(retiredMoves, 1, mode);
        assert.equal(publishedMoves, 1, mode);
        assert.equal(f.node(f.work + '/journal.json').ino, intent.staged.ino);
        assert.deepEqual(bytes(f, ledger + '/unconfirmed-journal.json'), originalB);
        assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        assert.equal(f.unlinkCalls.length, 6);
    }
});

test('atomic seal rejects foreign stage identity bytes binding or conflicting source state before further effects', async () => {
    for (const mode of [
        'stage-inode',
        'stage-bytes',
        'intent-binding',
        'retired-conflict',
        'active-partial',
        'missing-intent',
    ]) {
        const { f, originalA, originalB } = await updated(),
            ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId;
        let reached = false;
        f.beforeCleanupMove = (from: string, to: string) => {
            if (from === f.work + '/journal.json' && to === ledger + '/unconfirmed-journal.json') {
                reached = true;
                throw undefined;
            }
        };
        await interruptedSeal(f);
        assert.equal(reached, true);
        authoredSealRestart(f);
        if (mode === 'stage-inode') f.node(ledger + '/confirmed-journal.json').ino += 10000;
        if (mode === 'stage-bytes')
            f.node(ledger + '/confirmed-journal.json').bytes = Buffer.from('foreign-stage');
        if (mode === 'intent-binding') {
            const intent = json(f, ledger + '/seal-intent.json');
            intent.snapshotSHA256 = 'f'.repeat(64);
            f.node(ledger + '/seal-intent.json').bytes = Buffer.from(JSON.stringify(intent));
        }
        if (mode === 'retired-conflict')
            f.file(ledger + '/unconfirmed-journal.json', originalB.toString());
        if (mode === 'active-partial') f.node(f.work + '/journal.json').bytes = Buffer.from('{');
        if (mode === 'missing-intent') f.nodes.delete(ledger + '/seal-intent.json');
        const originalCurrent = bytes(f, f.work + '/journal.json'),
            at = f.calls.length,
            a = f.run('finalize');
        assert.equal((await a.operation).status, 'retained-unknown', mode);
        assert.equal(a.requests.length, 0, mode);
        assert.equal(f.calls.slice(at).some(changes), false, mode);
        assert.deepEqual(bytes(f, f.work + '/journal.json'), originalCurrent);
        assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
        assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
        assert.equal(f.unlinkCalls.length, 6);
    }
});

test('partial intent is not issuance and leaves the prior active journal intact without automatic repair', async () => {
    const { f, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId,
        write = f.ops.fs.writeSync.bind(f.ops.fs);
    let reached = false;
    f.ops.fs.writeSync = (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ) => {
        if (f.fds.get(fd).path === ledger + '/seal-intent.json') {
            write(fd, buffer, offset, length, position);
            reached = true;
            throw undefined;
        }
        return write(fd, buffer, offset, length, position);
    };
    await interruptedSeal(f);
    assert.equal(reached, true);
    assert.throws(() => json(f, ledger + '/seal-intent.json'));
    assert.deepEqual(bytes(f, f.work + '/journal.json'), originalB);
    assert.equal(f.nodes.has(ledger + '/unconfirmed-journal.json'), false);
    authoredSealRestart(f);
    f.ops.fs.writeSync = write;
    const at = f.calls.length,
        blocked = f.run('finalize');
    assert.equal((await blocked.operation).status, 'retained-unknown');
    assert.equal(blocked.requests.length, 0);
    assert.equal(f.calls.slice(at).some(changes), false);
    assert.deepEqual(bytes(f, f.work + '/journal.json'), originalB);
});

test('valid legacy confirmed state remains readable without inventing an atomic intent', async () => {
    const { f, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId;
    f.afterCleanupMove = (from: string, to: string) => {
        if (
            from === f.work + '/completed-journal.json' &&
            to === ledger + '/original-completed-journal.json'
        )
            throw undefined;
    };
    await interruptedSeal(f);
    authoredSealRestart(f);
    // Explicit MapFS postimage of the preserved49dd successful in-place seal.
    f.node(f.work + '/journal.json').bytes = Buffer.from(
        JSON.stringify({ ...JSON.parse(originalB.toString()), phase: 'candidate-confirmed' }),
    );
    assert.equal(f.nodes.has(ledger + '/seal-intent.json'), false);
    const repeated = f.run('finalize');
    assert.equal((await repeated.operation).status, 'previous-generation-already-finalized');
    assert.equal(repeated.requests.length, 0);
    const launch = f.run('launch');
    try {
        await start(f, launch);
        await boot(f, launch);
        close(f, launch);
        assert.equal((await launch.operation).result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
        assert.equal(f.nodes.has(ledger + '/seal-intent.json'), false);
    } finally {
        await join(f, launch);
    }
});

test('late falsey reservation release failure after atomic recovery never reports recovery success or retries', async () => {
    const { f, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId;
    f.beforeCleanupMove = (from: string, to: string) => {
        if (from === f.work + '/journal.json' && to === ledger + '/unconfirmed-journal.json')
            throw undefined;
    };
    await interruptedSeal(f);
    authoredSealRestart(f);
    const make = f.ops.server;
    let releaseCalls = 0;
    f.ops.server = () => {
        const server = make();
        server.close = (done: () => void) => {
            releaseCalls++;
            server.listening = false;
            done();
            throw undefined;
        };
        return server;
    };
    const a = f.run('finalize'),
        result = await a.operation;
    assert.equal(result.status, 'retained-unknown');
    assert.equal(result.result.sealRecovered, false);
    assert.equal(a.requests.length, 0);
    assert.equal(releaseCalls, 1);
    assert.equal(a.controller.diagnostics().primarySet, true);
    assert.equal(json(f, f.work + '/journal.json').phase, 'candidate-confirmed');
    assert.equal(f.unlinkCalls.length, 6);
});

test('an owned-stage read race cannot be adopted as a new prefix and overwritten during atomic recovery', async () => {
    const { f, originalB } = await updated(),
        ledger = f.work + '-finalize-' + JSON.parse(originalB.toString()).transactionId,
        stageFile = ledger + '/confirmed-journal.json',
        write = f.ops.fs.writeSync.bind(f.ops.fs);
    f.ops.fs.writeSync = (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ) => {
        if (f.fds.get(fd).path === stageFile) {
            write(fd, buffer, offset, length, position);
            throw undefined;
        }
        return write(fd, buffer, offset, length, position);
    };
    await interruptedSeal(f);
    authoredSealRestart(f);
    f.ops.fs.writeSync = write;
    const read = f.ops.fs.readSync.bind(f.ops.fs);
    let reached = false;
    f.ops.fs.readSync = (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ) => {
        // Select only the fixed publisher's direct prior read in this closed VM. No stack is emitted
        // or production hook added; guards' earlier stored-inventory reads remain unchanged.
        const stack = new Error().stack ?? '';
        if (
            !reached &&
            f.fds.get(fd).path === stageFile &&
            position === 0 &&
            buffer.length === 8193 &&
            /at (?:async )?publishRetainedSeal \(/.test(stack) &&
            !/at (?:Object\.)?stored \(|at observe \(|at (?:async )?guardRecovery \(/.test(stack)
        ) {
            reached = true;
            const foreign = Buffer.from(f.node(stageFile).bytes);
            foreign[0] = 0x5b;
            // Same-size, same-stat modeled race: an inode check alone cannot bless different bytes.
            f.node(stageFile).bytes = foreign;
        }
        return read(fd, buffer, offset, length, position);
    };
    const at = f.calls.length,
        a = f.run('finalize'),
        result = await a.operation;
    assert.equal(reached, true);
    assert.equal(result.status, 'retained-unknown');
    assert.equal(a.requests.length, 0);
    assert.equal(f.calls.slice(at).some(changes), false);
    assert.equal(f.node(stageFile).bytes[0], 0x5b);
    assert.deepEqual(bytes(f, f.work + '/journal.json'), originalB);
    assert.equal(f.nodes.has(ledger + '/unconfirmed-journal.json'), false);
    assert.equal(f.unlinkCalls.length, 6);
});
