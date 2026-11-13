import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { INSTALLATION_PRODUCT } from '../shared/installation.ts';
import { maintenancePaths, SETUP_OWNER } from '../electron/installation-maintenance.ts';
import {
    observeLinuxSetupReadiness,
    type LinuxReadinessContext,
    type LinuxReadinessSample,
} from '../electron/linux-setup-readiness.ts';
import { trustedFrameHandler } from '../electron/trusted-ipc.ts';
import { verifyLinuxSuccessor } from '../electron/linux-setup-successor.ts';
import { desiredLinuxMenu, prepareLinuxMenuJournal } from '../electron/linux-menu-ownership.ts';
import {
    createLinuxInstallerReadback,
    createLinuxMainReadback,
} from '../electron/linux-setup-readback.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';
import type { LinuxSetupReadiness } from '../shared/types.ts';

const pins = {
    'electron/main.ts': 'db6c3bbc4d16df23f2abb35b90684d73123217d0e9fc91a053170b41a0e208a5',
    'electron/linux-native-backend.ts':
        '0cddc8c02368b1dea62a9bd6e5bd676df1e8e1b433f9b6c4bb3fe3847aadfcb2',
    'electron/linux-transaction-model.ts':
        '7e3e04c85b3e470567d8332e79342abbfab076142d2ad306203a84513d246860',
};
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function source(file: keyof typeof pins, supplied?: string) {
    const text = supplied ?? readFileSync(file, 'utf8');
    assert.equal(
        sha(text),
        pins[file],
        'Exact current source required before extracting inert expressions.',
    );
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    assert.equal(
        (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
        0,
    );
    return { text, tree };
}
function fixture() {
    const c: LinuxReadinessContext = {
        platform: 'linux',
        arch: 'x64',
        layout: 'linux-folder',
        packaged: true,
        root: '/home/test/installed',
        installationId: '11111111-1111-4111-8111-111111111111',
        manifestSHA256: 'a'.repeat(64),
        version: '0.6.0',
        profile: '/home/test/data/DiagnosticHub/profiles/11111111-1111-4111-8111-111111111111',
        executable: '/home/test/installed/app/diagnostic-hub',
        pid: 888,
        uid: 1000,
        euid: 1000,
        processCreationMs: 10000,
        appUrl: 'app://bundle/index.html',
    };
    const transactionId = '22222222-2222-4222-8222-222222222222';
    const owner = {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        installationId: c.installationId,
        transactionId,
        root: c.root,
        options: { startMenu: false, desktop: false, launch: false },
        integrations: [] as unknown[],
    };
    const journal = {
        schemaVersion: 1,
        root: c.root,
        uid: c.uid,
        transactionId,
        installationId: c.installationId,
        profile: c.profile,
        candidateSHA256: c.manifestSHA256,
        previousSHA256: null as string | null,
        owner: { pid: 777, startTicks: '9999', executable: '/home/test/source/app/diagnostic-hub' },
        phase: 'candidate-active',
    };
    const s: LinuxReadinessSample = {
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
        nowMs: 11000,
        generation: 1,
    };
    const records = new Map<string, Buffer>(),
        reads: string[] = [];
    const ownerPath = c.root + '/' + SETUP_OWNER,
        journalPath = maintenancePaths(c.root).journal;
    const save = () => {
        records.set(ownerPath, Buffer.from(JSON.stringify(owner)));
        records.set(journalPath, Buffer.from(JSON.stringify(journal)));
    };
    save();
    let onRead = (_count: number) => {};
    const io = {
        async bytes(file: string, cap: number, uid: number) {
            assert.equal(cap, 8192);
            assert.equal(uid, 1000);
            reads.push(file);
            onRead(reads.length);
            assert.ok(file === ownerPath || file === journalPath);
            const bytes = records.get(file);
            if (!bytes) throw Error('private-missing-canary');
            return Buffer.from(bytes);
        },
    };
    return {
        c,
        s,
        owner,
        journal,
        transactionId,
        records,
        reads,
        ownerPath,
        journalPath,
        save,
        io,
        sample: () => s,
        setHook(fn: typeof onRead) {
            onRead = fn;
        },
    };
}
function writerObject(file: keyof typeof pins, variable: string) {
    const { tree } = source(file);
    const found: ts.VariableDeclaration[] = [];
    function walk(n: ts.Node) {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === variable)
            found.push(n);
        ts.forEachChild(n, walk);
    }
    walk(tree);
    let expression: ts.Expression;
    if (variable === 'ownerBytes') {
        assert.equal(found.length, 1);
        const outer = found[0].initializer as ts.CallExpression;
        assert.equal(outer.expression.getText(tree), 'Buffer.from');
        const inner = outer.arguments[0] as ts.CallExpression;
        assert.equal(inner.expression.getText(tree), 'JSON.stringify');
        expression = inner.arguments[0];
    } else {
        const install = tree.statements.find(
            (n) => ts.isClassDeclaration(n) && n.name?.text === 'LinuxTransactionCore',
        ) as ts.ClassDeclaration;
        const method = install.members.find((n) => n.name?.getText(tree) === 'install')!;
        const candidates = found.filter((n) => n.pos > method.pos && n.end < method.end);
        assert.equal(candidates.length, 1);
        expression = candidates[0].initializer!;
    }
    assert.ok(ts.isObjectLiteralExpression(expression));
    return expression.getText(tree);
}
function evaluateWriter(
    expression: string,
    bindings: Record<string, unknown>,
): Record<string, unknown> {
    const output = ts.transpileModule('export default (' + expression + ');', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports = { default: undefined };
    vm.runInNewContext(output.outputText, { ...bindings, exports }, { timeout: 1000 });
    return exports.default as unknown as Record<string, unknown>;
}
function mainCallback() {
    const { tree } = source('electron/main.ts'),
        callbacks: ts.ArrowFunction[] = [];
    function walk(n: ts.Node) {
        if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'registerHandler' &&
            ts.isStringLiteral(n.arguments[0]) &&
            n.arguments[0].text === 'hub:read-update-info'
        ) {
            assert.equal(n.arguments.length, 2);
            assert.ok(ts.isArrowFunction(n.arguments[1]));
            callbacks.push(n.arguments[1]);
        }
        ts.forEachChild(n, walk);
    }
    walk(tree);
    assert.equal(callbacks.length, 1);
    return ts.transpileModule('export default ' + callbacks[0].getText(tree), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
}
function route(f: ReturnType<typeof fixture>, platform = 'linux') {
    const frame = { url: f.c.appUrl };
    const contents = {
        mainFrame: frame,
        isDestroyed: () => false,
        isLoadingMainFrame: () => f.s.loading,
    };
    const window = {
        id: f.s.electronId,
        webContents: contents,
        isDestroyed: () => false,
        isVisible: () => f.s.visible,
        isMinimized: () => f.s.minimized,
        getNativeWindowHandle: () => Buffer.from(f.s.nativeHandle),
    };
    const bindings = {
        exports: {} as { default?: () => Promise<unknown> },
        process: {
            platform,
            arch: 'x64',
            execPath: f.c.executable,
            pid: f.c.pid,
            getuid: () => f.c.uid,
            geteuid: () => f.c.euid,
            getCreationTime: () => f.c.processCreationMs,
        },
        startup: {
            delivery: 'installed',
            profilePath: f.c.profile,
            installation: {
                root: f.c.root,
                record: { installationId: f.c.installationId, manifestSHA256: f.c.manifestSHA256 },
                manifest: { layout: platform === 'linux' ? 'linux-folder' : 'windows-nsis' },
            },
        },
        app: {
            isPackaged: true,
            getVersion: () => f.c.version,
            getPath: (name: string) => {
                assert.equal(name, 'userData');
                return f.s.profile;
            },
        },
        window,
        ownsProfile: true,
        quit: { phase: 'idle' },
        appUrl: f.c.appUrl,
        captureRendererEpoch: f.s.generation,
        Date: { now: () => f.s.nowMs },
        observeLinuxSetupReadiness: (
            c: LinuxReadinessContext,
            sample: () => LinuxReadinessSample | null,
        ) => observeLinuxSetupReadiness(c, sample, f.io),
        legacyCalls: 0,
        linuxSetupReadback: null as {
            offer(
                value: LinuxSetupReadiness | null,
                refresh: () => Promise<LinuxSetupReadiness | null>,
            ): void;
        } | null,
        acknowledgeSetupBoot: async (_c: unknown) => {
            bindings.legacyCalls++;
        },
        runningExecutable: f.c.executable,
        updateOwnership: {
            observe: () => {
                throw Error('Unexpected portable branch');
            },
        },
        receipts: {
            info: () => {
                throw Error('Unexpected portable branch');
            },
        },
        console: {
            warn: () => {
                throw Error('Unexpected legacy warning');
            },
        },
    };
    // Only the pinned callback is defined. Main module/imports and Electron are never evaluated.
    vm.runInNewContext(mainCallback(), bindings, { timeout: 1000 });
    const handler = trustedFrameHandler(
        () => window,
        f.c.appUrl,
        () => bindings.exports.default!(),
    );
    return {
        bindings,
        window,
        frame,
        invoke: () =>
            handler({ sender: contents, senderFrame: frame }) as Promise<Record<string, unknown>>,
        handler,
    };
}
test('main readiness matches active local metadata and emits explicit self-observation with no authority', async () => {
    const f = fixture(),
        result = await observeLinuxSetupReadiness(f.c, f.sample, f.io);
    assert.ok(result);
    assert.equal(result.transactionId, f.transactionId);
    assert.equal(result.manifestSHA256, f.c.manifestSHA256);
    assert.deepEqual(result.profile, { path: f.c.profile, lockOwned: true });
    assert.equal(result.window.nativeHandleHex, '0100000000000000');
    assert.equal(result.finalizationAuthority, false);
    assert.equal(result.descendantRetirement, false);
    assert.equal(result.independentWindowObservation, false);
    assert.equal(result.independentProcessObservation, false);
    assert.equal(result.payloadIntegrity, 'not-checked');
    assert.equal(f.reads.length, 4);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
    assert.equal(
        verifyLinuxSuccessor(
            {} as never,
            result as never,
            {} as never,
            '0'.repeat(64),
            Buffer.alloc(32),
            12000,
        ),
        false,
    );
});

test('confirmed current and completed-anchor metadata retain readiness without claiming cleanup or native authority', async () => {
    for (const archived of [false, true]) {
        const f = fixture();
        f.journal.phase = 'candidate-confirmed';
        f.journal.previousSHA256 = 'b'.repeat(64);
        f.save();
        let io: Parameters<typeof observeLinuxSetupReadiness>[2] = f.io;
        if (archived) {
            const completed =
                f.journalPath.slice(0, -'journal.json'.length) + 'completed-journal.json';
            f.records.set(completed, f.records.get(f.journalPath)!);
            f.records.delete(f.journalPath);
            io = {
                async bytes(file, cap, uid) {
                    assert.ok(file === f.ownerPath || file === completed);
                    assert.equal(cap, 8192);
                    assert.equal(uid, 1000);
                    return Buffer.from(f.records.get(file)!);
                },
                async node(file) {
                    assert.ok([f.ownerPath, f.journalPath, completed].includes(file));
                    const raw = f.records.get(file);
                    return raw
                        ? {
                              kind: 'file',
                              uid: 1000,
                              mode: 0o100600,
                              dev: 1,
                              ino: file === f.ownerPath ? 801 : 802,
                              nlink: 1,
                              size: raw.length,
                              mtimeMs: 1,
                              ctimeMs: 1,
                          }
                        : null;
                },
            };
        }
        const result = await observeLinuxSetupReadiness(f.c, f.sample, io);
        assert.ok(result);
        assert.equal(result.transactionId, f.transactionId);
        assert.equal(result.finalizationAuthority, false);
        assert.equal(result.payloadIntegrity, 'not-checked');
        assert.equal(result.independentWindowObservation, false);
        assert.equal(result.descendantRetirement, false);
    }
});
test('actual current Linux writer expressions produce metadata accepted without relabelling its provenance', async () => {
    const f = fixture(),
        plan = {
            root: f.c.root,
            host: { uid: f.c.uid },
            installationId: f.c.installationId,
            transactionId: f.transactionId,
            owner: clone(f.journal.owner),
        };
    const payload = { menu: undefined },
        before = { source: { verifiedManifestSHA256: f.c.manifestSHA256 }, root: null };
    const owner = evaluateWriter(writerObject('electron/linux-native-backend.ts', 'ownerBytes'), {
        INSTALLATION_PRODUCT,
        plan,
        payload,
        copy: clone,
    });
    const journal = evaluateWriter(writerObject('electron/linux-transaction-model.ts', 'journal'), {
        plan,
        before,
        profile: () => f.c.profile,
        copy: clone,
    });
    journal.phase = 'candidate-active';
    f.records.set(f.ownerPath, Buffer.from(JSON.stringify(owner)));
    f.records.set(f.journalPath, Buffer.from(JSON.stringify(journal)));
    assert.ok(await observeLinuxSetupReadiness(f.c, f.sample, f.io));
});
test('actual menu writer records bind a completed integration while incomplete or inconsistent menu state stays unknown', async () => {
    for (const kind of ['valid', 'incomplete', 'inconsistent', 'impossible'] as const) {
        const f = fixture(),
            plan = {
                root: f.c.root,
                installationId: f.c.installationId,
                transactionId: f.transactionId,
                host: {
                    platform: 'linux',
                    arch: 'x64',
                    uid: 1000,
                    euid: 1000,
                    home: '/home/test',
                    appData: '/home/test/data',
                    sourceRoot: '/home/test/source',
                    version: '0.6.0',
                },
                owner: clone(f.journal.owner),
                menu: { dataHome: '/home/test/xdg', selected: true },
            },
            record = desiredLinuxMenu(plan).record,
            owner = evaluateWriter(writerObject('electron/linux-native-backend.ts', 'ownerBytes'), {
                INSTALLATION_PRODUCT,
                plan,
                payload: { menu: record },
                copy: clone,
            }),
            journal = evaluateWriter(
                writerObject('electron/linux-transaction-model.ts', 'journal'),
                {
                    plan,
                    before: {
                        source: { verifiedManifestSHA256: f.c.manifestSHA256 },
                        root: null,
                        menu: { current: null },
                    },
                    profile: () => f.c.profile,
                    copy: clone,
                    prepareLinuxMenuJournal,
                },
            );
        journal.phase = 'candidate-active';
        const menu = journal.menu as Record<string, unknown>;
        menu.phase = kind === 'incomplete' ? 'staged' : 'applied';
        if (kind === 'inconsistent') (owner.options as Record<string, unknown>).startMenu = false;
        if (kind === 'impossible') {
            menu.after = null;
            owner.integrations = [];
            (owner.options as Record<string, unknown>).startMenu = false;
        }
        f.records.set(f.ownerPath, Buffer.from(JSON.stringify(owner)));
        f.records.set(f.journalPath, Buffer.from(JSON.stringify(journal)));
        const result = await observeLinuxSetupReadiness(f.c, f.sample, f.io);
        if (kind === 'valid') assert.ok(result);
        else assert.equal(result, null, kind);
    }
});
test('unsupported runtime, identity or profile context returns unknown before any metadata read', async () => {
    for (const change of [
        { platform: 'win32' },
        { arch: 'arm64' },
        { layout: 'linux-appimage' },
        { packaged: false },
        { uid: 0 },
        { euid: 0 },
        { pid: 0 },
        { root: '/home/test/../foreign' },
        { profile: '/home/test/installed/profile' },
        { manifestSHA256: 'bad' },
        { executable: '/foreign' },
        { processCreationMs: null },
        { processCreationMs: 12000 },
        { appUrl: 'http://127.0.0.1:5173/' },
    ]) {
        const f = fixture();
        assert.equal(await observeLinuxSetupReadiness({ ...f.c, ...change }, f.sample, f.io), null);
        assert.equal(f.reads.length, 0);
    }
});
test('hidden, loading, foreign-profile, unlocked or unsupported native window yields no readiness', async () => {
    for (const change of [
        { visible: false },
        { minimized: true },
        { loading: true },
        { profile: '/foreign' },
        { ownsProfile: false },
        { quitting: true },
        { frameUrl: 'app://foreign/index.html' },
        { nativeHandle: Buffer.alloc(8) },
        { nativeHandle: Buffer.alloc(32) },
        { electronId: 0 },
        { generation: -1 },
    ]) {
        const f = fixture();
        Object.assign(f.s, change);
        assert.equal(await observeLinuxSetupReadiness(f.c, f.sample, f.io), null);
        assert.equal(f.reads.length, 0);
    }
});
test('current-frame, navigation-generation, window-handle and profile changes during reads are fenced', async () => {
    for (const change of [
        { window: {} },
        { contents: {} },
        { frame: {} },
        { generation: 2 },
        { nativeHandle: Buffer.from('0200000000000000', 'hex') },
        { visible: false },
        { loading: true },
        { profile: '/foreign' },
        { ownsProfile: false },
        { quitting: true },
        { nowMs: 10999 },
        { nowMs: 13000 },
    ]) {
        const f = fixture();
        f.setHook((count) => {
            if (count === 2) Object.assign(f.s, change);
        });
        assert.equal(await observeLinuxSetupReadiness(f.c, f.sample, f.io), null);
        assert.equal(f.reads.length, 4);
    }
});
test('owner, journal candidate, transaction, UID, profile and phase mismatches cannot emit readiness', async () => {
    for (const kind of [
        'product',
        'installation',
        'transaction',
        'hash',
        'uid',
        'profile',
        'phase',
        'owner-pid',
        'owner-executable',
        'extra',
        'menu',
    ]) {
        const f = fixture();
        if (kind === 'product') f.owner.product = 'foreign';
        if (kind === 'installation')
            f.owner.installationId = '33333333-3333-4333-8333-333333333333';
        if (kind === 'transaction')
            f.journal.transactionId = '33333333-3333-4333-8333-333333333333';
        if (kind === 'hash') f.journal.candidateSHA256 = 'b'.repeat(64);
        if (kind === 'uid') f.journal.uid = 1001;
        if (kind === 'profile') f.journal.profile = '/foreign';
        if (kind === 'phase') f.journal.phase = 'prepared';
        if (kind === 'owner-pid') f.journal.owner.pid = 0;
        if (kind === 'owner-executable') f.journal.owner.executable = '../foreign';
        if (kind === 'extra') Object.assign(f.journal, { unknown: true });
        if (kind === 'menu') f.owner.options.startMenu = true;
        f.save();
        assert.equal(await observeLinuxSetupReadiness(f.c, f.sample, f.io), null, kind);
    }
});
test('changed, missing, oversized, duplicate-key or malformed metadata returns null without raw errors', async () => {
    for (const kind of [
        'changed',
        'missing',
        'oversize',
        'duplicate',
        'invalid-json',
        'invalid-utf8',
        'exception',
    ]) {
        const f = fixture();
        if (kind === 'changed')
            f.setHook((count) => {
                if (count === 3)
                    f.records.set(
                        f.ownerPath,
                        Buffer.from(JSON.stringify({ ...f.owner, root: '/foreign' })),
                    );
            });
        if (kind === 'missing') f.records.delete(f.journalPath);
        if (kind === 'oversize') f.records.set(f.ownerPath, Buffer.alloc(8193));
        if (kind === 'duplicate')
            f.records.set(
                f.ownerPath,
                Buffer.from('{"root":"foreign",' + JSON.stringify(f.owner).slice(1)),
            );
        if (kind === 'invalid-json') f.records.set(f.ownerPath, Buffer.from('{'));
        if (kind === 'invalid-utf8') f.records.set(f.ownerPath, Buffer.from([0xff]));
        if (kind === 'exception')
            f.setHook(() => {
                throw Error('private-error-canary');
            });
        assert.equal(await observeLinuxSetupReadiness(f.c, f.sample, f.io), null, kind);
    }
});
test('context and sampling aliases cannot rewrite the pre-read identity or freshness window', async () => {
    const f = fixture();
    f.setHook((count) => {
        if (count === 1) {
            f.c.root = '/foreign';
            f.c.manifestSHA256 = 'b'.repeat(64);
        }
    });
    const result = await observeLinuxSetupReadiness(f.c, f.sample, f.io);
    assert.equal(result!.root, '/home/test/installed');
    assert.equal(result!.manifestSHA256, 'a'.repeat(64));
    const old = fixture();
    old.setHook((count) => {
        if (count === 1) old.s.nowMs = 14000;
    });
    assert.equal(await observeLinuxSetupReadiness(old.c, old.sample, old.io), null);
});
test('actual readUpdateInfo callback and producer connect the installed Linux profile/window/transaction', async () => {
    const f = fixture(),
        r = route(f),
        info = await r.invoke(),
        installation = info.installation as Record<string, unknown>,
        readiness = installation.linuxSetupReadiness as Record<string, unknown>;
    assert.equal(info.handoffConfirmed, false);
    assert.equal(installation.automaticUpdateQualified, false);
    assert.equal(installation.payloadIntegrity, 'not-checked');
    assert.equal(readiness.transactionId, f.transactionId);
    assert.equal(readiness.finalizationAuthority, false);
    assert.equal(r.bindings.legacyCalls, 0);
    assert.equal(f.reads.length, 4);
});
test('real trusted-frame wrapper refuses subframes and foreign senders before producer reads', async () => {
    const f = fixture(),
        r = route(f);
    assert.throws(() => r.handler({ sender: {}, senderFrame: r.frame }), /Untrusted/);
    assert.throws(
        () => r.handler({ sender: r.window.webContents, senderFrame: { url: f.c.appUrl } }),
        /Untrusted/,
    );
    assert.equal(f.reads.length, 0);
});
test('actual callback returns ordinary update information with null readiness on metadata failure', async () => {
    const f = fixture();
    f.records.delete(f.journalPath);
    const r = route(f),
        info = await r.invoke();
    assert.equal((info.installation as Record<string, unknown>).linuxSetupReadiness, null);
    assert.equal(info.currentVersion, '0.6.0');
    assert.equal(info.handoffConfirmed, false);
    assert.equal(r.bindings.legacyCalls, 0);
});
test('actual callback fences document replacement and profile loss during its awaited reads', async () => {
    for (const kind of ['generation', 'frame', 'profile-lock'] as const) {
        const f = fixture(),
            r = route(f);
        f.setHook((count) => {
            if (count !== 2) return;
            if (kind === 'generation') r.bindings.captureRendererEpoch++;
            if (kind === 'frame') r.window.webContents.mainFrame = { url: f.c.appUrl };
            if (kind === 'profile-lock') r.bindings.ownsProfile = false;
        });
        const info = await r.invoke();
        assert.equal((info.installation as Record<string, unknown>).linuxSetupReadiness, null);
    }
});
test('Windows callback keeps its existing acknowledgement and never invokes Linux metadata reads', async () => {
    const f = fixture(),
        r = route(f, 'win32'),
        info = await r.invoke();
    assert.equal(r.bindings.legacyCalls, 1);
    assert.equal(f.reads.length, 0);
    assert.equal(Object.hasOwn(info.installation as object, 'linuxSetupReadiness'), false);
    assert.equal(info.handoffConfirmed, false);
});
test('exact-source guards reject any changed main or writer bytes before defining the callback', () => {
    for (const file of Object.keys(pins) as (keyof typeof pins)[])
        assert.throws(
            () => source(file, readFileSync(file, 'utf8') + '\n'),
            /Exact current source/,
        );
});
test('pinned actual main callback supplies a fresh authenticated-channel response to its owned installer peer', async () => {
    const f = fixture(),
        r = route(f),
        pair = linuxReadbackPair(),
        parent = createLinuxInstallerReadback(
            pair.parent,
            {
                root: f.c.root,
                installationId: f.c.installationId,
                transactionId: f.transactionId,
                manifestSHA256: f.c.manifestSHA256,
                version: f.c.version,
                profile: f.c.profile,
                executable: f.c.executable,
                uid: f.c.uid,
            },
            { now: () => f.s.nowMs, nonce: () => Buffer.alloc(32, 0xa) },
        ),
        child = createLinuxMainReadback(pair.child, () => f.s.nowMs);
    r.bindings.linuxSetupReadback = child;
    parent.admit({ pid: f.c.pid, uid: f.c.uid, executable: f.c.executable, startTicks: '10001' });
    const info = await r.invoke();
    assert.ok((info.installation as { linuxSetupReadiness: unknown }).linuxSetupReadiness);
    await pair.pump(() => parent.summary().closed);
    assert.equal(await parent.wait(), true);
    await child.joinClosure();
    assert.equal(parent.readiness()!.transactionId, f.transactionId);
    assert.equal(parent.readiness()!.finalizationAuthority, false);
    assert.equal(f.reads.length, 8);
});
test('opted-in inherited channel ownership precedes quit construction and all window-ready callbacks', () => {
    const { tree } = source('electron/main.ts');
    let admission = -1,
        quit = -1,
        ready = -1;
    function walk(n: ts.Node) {
        if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'createLinuxNativeSetupReadback'
        )
            admission = n.pos;
        if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'createQuitController'
        )
            quit = n.pos;
        if (ts.isCallExpression(n) && n.expression.getText(tree) === 'app.whenReady') ready = n.pos;
        ts.forEachChild(n, walk);
    }
    walk(tree);
    assert.ok(
        admission > 0 && admission < quit && quit < ready,
        'Inherited owner must be present before early quit or readiness waits.',
    );
});
