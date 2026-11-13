/** Closed-memory actual caller/backend controls. No filesystem mutation, native load or deletion suite. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { readFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { EventEmitter } from 'node:events';
import * as installation from '../shared/installation.ts';
import * as model from '../electron/linux-transaction-model.ts';
import * as menu from '../electron/linux-menu-ownership.ts';
import { linuxReviewArguments } from '../electron/linux-setup-ui.ts';

const root = new URL('../', import.meta.url);
const allowed = new Set(
    [
        'electron/linux-initial-uninstall.ts',
        'electron/linux-retained-cleanup.ts',
        'electron/linux-native-backend.ts',
        'electron/linux-native-driver.ts',
        'electron/linux-permanent-setup.ts',
        'electron/installation-maintenance.ts',
        'tests/linux-native-backend.test.ts',
    ].map((name) => new URL(name, root).href),
);
const read = (name: string) => {
    const url = new URL(name, root);
    assert.ok(allowed.has(url.href));
    return readFileSync(url, 'utf8');
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const refuse = () => {
    throw Error('UNADMITTED_REAL_PORT');
};
const maintenance: Record<string, string> = {};
const maintenanceTree = ts.createSourceFile(
    'fixed-maintenance.ts',
    read('electron/installation-maintenance.ts'),
    ts.ScriptTarget.ES2022,
    true,
);
for (const key of ['SETUP_OWNER', 'SETUP_PAYLOAD']) {
    const matches = maintenanceTree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === key);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].initializer && ts.isStringLiteral(matches[0].initializer));
    maintenance[key] = matches[0].initializer.text;
}
function execute(
    source: string,
    file: string,
    modules: Map<string, unknown>,
    extra: Record<string, unknown> = {},
) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
    assert.equal(
        (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
        0,
    );
    for (const node of tree.statements)
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
            assert.ok(
                ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
                'Closed source import.',
            );
    const result = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    });
    assert.equal(
        (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
            .length,
        0,
    );
    const module = { exports: {} as any };
    const context = vm.createContext(
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
            structuredClone,
            assert,
            constants,
            createHash,
            EventEmitter,
            queueMicrotask,
            ...extra,
            process: Object.freeze({}),
            performance: { now: refuse },
            setTimeout: refuse,
            clearTimeout: refuse,
            require(name: string) {
                assert.ok(modules.has(name), 'Unadmitted require.');
                return modules.get(name);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    new vm.Script(result.outputText, { filename: file + '.memory.cjs' }).runInContext(context, {
        timeout: 1000,
    });
    return module.exports;
}
const common = new Map<string, unknown>([
    ['node:path', path],
    ['node:crypto', { createHash, randomUUID: refuse }],
    ['node:util', { types: utilTypes }],
    ['../shared/installation.ts', installation],
    ['./installation-maintenance.ts', maintenance],
    ['./linux-transaction-model.ts', model],
]);
const removal = execute(
    read('electron/linux-initial-uninstall.ts'),
    'initial-uninstall.ts',
    common,
);
const cleanup = execute(read('electron/linux-retained-cleanup.ts'), 'retained-cleanup.ts', common);
const backend = execute(
    read('electron/linux-native-backend.ts'),
    'native-backend.ts',
    new Map([
        ...common,
        ['node:net', { createServer: refuse }],
        ['./physical-fs.ts', { physicalFS: Object.freeze({}) }],
        ['./linux-menu-ownership.ts', menu],
        ['./linux-initial-uninstall.ts', removal],
        ['./linux-retained-cleanup.ts', cleanup],
    ]),
);
const driver = execute(
    read('electron/linux-native-driver.ts'),
    'native-driver.ts',
    new Map([...common, ['./linux-native-backend.ts', backend]]),
);
// Extract only fixed inert declarations; never import/register the old71 tests.
const fixtureSource = read('tests/linux-native-backend.test.ts');
assert.equal(
    hash(fixtureSource),
    '117374f6d75ac5b30b7b51bd881871861bef1afddf3760ec0a4b7758cddf8c43',
);
const fixtureTree = ts.createSourceFile(
    'fixed-backend-fixture.ts',
    fixtureSource,
    ts.ScriptTarget.ES2022,
    true,
);
const declarations: string[] = [];
for (const name of ['hash', 'clone', 'installationId', 'transactionId', 'token', 'procStat']) {
    const found = fixtureTree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(found.length, 1);
    declarations.push('const ' + found[0].getText(fixtureTree) + ';');
}
for (const name of ['FakeServer', 'fixture', 'menuFixture']) {
    const found = fixtureTree.statements.filter(
        (node) =>
            (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
            node.name?.text === name,
    );
    assert.equal(found.length, 1);
    declarations.push(found[0].getText(fixtureTree));
}
const fixtures = execute(
    declarations.join('\n') + '\nmodule.exports={fixture,menuFixture,FakeServer};',
    'fixed-fixture.ts',
    new Map(),
    {
        ...backend,
        INSTALLATION_PRODUCT: installation.INSTALLATION_PRODUCT,
        validateInstallationManifest: installation.validateInstallationManifest,
        linuxModelReviewSHA256: model.linuxModelReviewSHA256,
        desiredLinuxMenu: menu.desiredLinuxMenu,
        ...maintenance,
    },
);
const json = (f: any, file: string) => JSON.parse(f.node(file).bytes.toString());
const bytes = (f: any, file: string) => Buffer.from(f.node(file).bytes);
const work = (f: any) =>
    path.posix.join(
        path.posix.dirname(f.plan.root),
        '.DiagnosticHub-maintenance-' + hash(f.plan.root).slice(0, 20),
    );
const mutation = (name: string) =>
    ['write', 'truncate', 'mkdir', 'move-noreplace', 'unlink-owned'].includes(name);
const snapshot = (f: any, prefix: string) =>
    new Map<string, string>(
        Array.from(f.nodes.entries() as Iterable<[string, any]>)
            .filter(([name, node]) => name.startsWith(prefix + '/') && node.kind === 'file')
            .map(([name, node]) => [name, node.bytes.toString('base64')]),
    );
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function memory(classic = false, selectedMenu = false) {
    const f: any = selectedMenu ? fixtures.menuFixture(true, false) : fixtures.fixture();
    const parent = (name: string) => path.posix.dirname(name);
    const resolve = (name: string) => {
        const found = /^\/proc\/self\/fd\/(\d+)(.*)$/.exec(name);
        return found ? (f.fds.get(Number(found[1])).path + found[2]).replace(/\/+/g, '/') : name;
    };
    if (classic)
        for (const [name, node] of f.nodes)
            if (node.kind === 'directory')
                node.nlink =
                    2 +
                    Array.from(f.nodes.values() as Iterable<any>).filter(
                        (child) =>
                            child.kind === 'directory' &&
                            child.path !== name &&
                            parent(child.path) === name,
                    ).length;
    const mkdir = f.ops.fs.mkdirSync.bind(f.ops.fs),
        move = f.ops.moveNoReplace;
    f.ops.fs.mkdirSync = (name: string, options: any) => {
        const target = resolve(name);
        mkdir(name, options);
        if (classic) {
            f.node(target).nlink = 2;
            f.node(parent(target)).nlink++;
        }
    };
    f.ops.moveNoReplace = (fromFD: number, fromName: string, toFD: number, toName: string) => {
        const from = f.fds.get(fromFD).path + '/' + fromName,
            to = f.fds.get(toFD).path + '/' + toName;
        const directory = f.node(from).kind === 'directory';
        move(fromFD, fromName, toFD, toName);
        if (classic && directory && parent(from) !== parent(to)) {
            f.node(parent(from)).nlink--;
            f.node(parent(to)).nlink++;
        }
        f.afterMove?.(from, to);
    };
    let sequence = 0;
    f.ops.uuid = () => '33333333-3333-4333-8333-' + (++sequence).toString(16).padStart(12, '0');
    f.sockets = [];
    f.ops.server = () => {
        const socket = new fixtures.FakeServer(),
            listen = socket.listen.bind(socket),
            close = socket.close.bind(socket);
        socket.listen = (options: any) => {
            socket.unavailable = f.sockets.some((item: any) => item.listening);
            return listen(options);
        };
        socket.close = (done: (error?: unknown) => void) => {
            if (f.closeBehavior === 'throw-undefined') {
                socket.listening = false;
                throw undefined;
            }
            if (f.closeBehavior === 'ack-then-throw-undefined') {
                socket.listening = false;
                done();
                throw undefined;
            }
            return close((error?: unknown) => {
                done(error);
                f.afterClose?.(done);
            });
        };
        f.sockets.push(socket);
        return socket;
    };
    f.unlinkCalls = [];
    f.ops.unlinkOwned = (fd: number, name: string, kind: string, identity: any) => {
        const file = f.fds.get(fd).path + '/' + name,
            node = f.node(file);
        assert.equal(name, 'entry');
        assert.equal(node.ino, identity.ino);
        assert.equal(identity.dev, 1);
        assert.equal(f.node(parent(file)).mode & 0o7777, 0o700);
        assert.equal(node.kind, kind);
        if (kind === 'directory')
            assert.equal(
                Array.from(f.nodes.keys() as Iterable<string>).some(
                    (other) => parent(other) === file,
                ),
                false,
            );
        f.calls.push('unlink-owned');
        f.unlinkCalls.push(file);
        f.beforeUnlink?.(file);
        f.nodes.delete(file);
        if (classic && kind === 'directory') f.node(parent(file)).nlink--;
        f.afterUnlink?.(file);
    };
    f.reply = { status: 'confirmed', menu: false };
    f.promptRequests = [];
    const core = execute(
        read('electron/linux-permanent-setup.ts'),
        'permanent-setup.ts',
        new Map([
            ...common,
            [
                './linux-setup-review.ts',
                {
                    linuxReviewDisk: {
                        async bytes(file: string, cap: number, uid: number) {
                            assert.equal(
                                file,
                                f.plan.host.sourceRoot + '/' + maintenance.SETUP_PAYLOAD,
                            );
                            assert.equal(uid, 1000);
                            const value = bytes(f, file);
                            assert.ok(value.length <= cap);
                            return value;
                        },
                    },
                },
            ],
            ['./linux-setup-ui.ts', { linuxReviewArguments }],
            ['./linux-native-driver.ts', driver],
            ['./linux-setup-readback.ts', { createLinuxOwnedQuitSelection: refuse }],
            ['./linux-native-backend.ts', { createLinuxSealInterruptionSelection: refuse }],
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
                { createLinuxOwnedLaunch: refuse, createLinuxNativeLaunchProcessHost: refuse },
            ],
        ]),
    );
    const prompt = {
        async review(request: any) {
            f.promptRequests.push(request);
            f.enteredPrompt?.resolve();
            if (f.promptGate) await f.promptGate.promise;
            return f.reply;
        },
        hasPending: () => Boolean(f.promptGate),
    };
    f.core = core;
    f.run = (operation = 'uninstall-current') =>
        core.runLinuxPermanentSetup(
            f.plan.host,
            {
                root: f.plan.root,
                version: f.plan.host.version,
                operation,
                menu: false,
                menuExplicit: true,
                terminal: true,
            },
            '/home/test/xdg',
            { gui: prompt, terminal: prompt, now: f.ops.now },
            {},
        );
    f.profile = f.plan.host.appData + '/DiagnosticHub/profiles/' + f.plan.installationId + '/keep';
    f.file(f.profile, 'settings-and-reports');
    if (classic)
        for (const [name, node] of f.nodes)
            if (node.kind === 'directory')
                node.nlink =
                    2 +
                    Array.from(f.nodes.values() as Iterable<any>).filter(
                        (child) =>
                            child.kind === 'directory' &&
                            child.path !== name &&
                            parent(child.path) === name,
                    ).length;
    return f;
}
async function installed(classic = false, selected = false) {
    const f = memory(classic, selected);
    const result = await driver
        .createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops)
        .run();
    assert.equal(result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    return f;
}
/** Reconstruct only the MapFS postimage of initial Finalize's no-replace journal rename.
 * This supplies a removal preimage; it does not execute or qualify a native Finalize. */
function archivedInitial(f: any) {
    const from = work(f) + '/journal.json',
        to = work(f) + '/completed-journal.json',
        original = bytes(f, from),
        node = f.node(from);
    assert.equal(f.nodes.has(to), false);
    f.nodes.delete(from);
    node.path = to;
    f.nodes.set(to, node);
    return original;
}
function preserved(f: any, original: Map<string, string>) {
    for (const [name, value] of original)
        assert.equal(f.node(name).bytes.toString('base64'), value);
}

test('actual shipping initial uninstall removes only manifest members and retains source profile and original records', async () => {
    const f = await installed(),
        source = snapshot(f, f.plan.host.sourceRoot),
        journal = bytes(f, work(f) + '/journal.json');
    const rawOriginals = new Map<string, string>(
        [
            installation.INSTALLATION_RECORD,
            installation.INSTALLATION_MANIFEST,
            maintenance.SETUP_OWNER,
        ].map((name) => [name, bytes(f, f.plan.root + '/' + name).toString('base64')]),
    );
    assert.equal(
        f.core.linuxPermanentArguments([
            '--version',
            '0.6.0',
            '--install-directory',
            f.plan.root,
            '--operation',
            'uninstall-current',
        ]).operation,
        'uninstall-current',
    );
    assert.throws(() =>
        f.core.linuxPermanentArguments(['--version', '0.6.0', '--operation', 'finalize']),
    );
    const result = await f.run();
    assert.equal(result.status, 'current-payload-removed');
    assert.equal(f.nodes.has(f.plan.root), false);
    assert.equal(f.nodes.has(work(f)), false);
    assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    preserved(f, source);
    const removal = work(f) + '-uninstall',
        saved = json(f, removal + '/snapshot.json');
    for (const original of saved.originals)
        assert.equal(original.base64, rawOriginals.get(original.path));
    assert.deepEqual(bytes(f, removal + '/original-maintenance/journal.json'), journal);
    assert.equal(json(f, removal + '/state.json').phase, 'complete');
    assert.equal(result.result.finalizationAuthority, false);
    assert.equal(result.result.originalRecordsRetained, true);
    assert.equal(result.result.priorRecoveryPayloadsRemoved, false);
    assert.equal(f.unlinkCalls.length, 6);
    assert.equal(f.core.linuxPermanentSetupDiagnostics(result.owner).phase, 'finished');
    assert.equal(f.sockets.at(-1).listening, false);
    assert.equal(f.fds.size, 0);
});

test('shipping uninstall accepts an archived initial Finalize and preserves recovery through a fresh install', async () => {
    for (const classic of [false, true]) {
        const f = await installed(classic),
            original = archivedInitial(f),
            source = snapshot(f, f.plan.host.sourceRoot),
            result = await f.run();
        assert.equal(result.status, 'current-payload-removed');
        assert.equal(f.nodes.has(f.plan.root), false);
        assert.equal(f.nodes.has(work(f)), false);
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
        preserved(f, source);
        const removal = work(f) + '-uninstall',
            saved = json(f, removal + '/snapshot.json');
        assert.equal(saved.initial.journal, null);
        assert.equal(saved.initial.history.journalOriginal, null);
        assert.equal(saved.initial.history.completed.base64, original.toString('base64'));
        assert.deepEqual(
            bytes(f, removal + '/original-maintenance/completed-journal.json'),
            original,
        );
        assert.equal(f.nodes.has(removal + '/original-maintenance/journal.json'), false);
        assert.equal(json(f, removal + '/state.json').phase, 'complete');
        assert.equal(result.result.originalRecordsRetained, true);
        assert.equal(result.result.priorRecoveryPayloadsRemoved, false);
        assert.equal(result.result.finalizationAuthority, false);
        assert.equal(f.unlinkCalls.length, 6);
        assert.equal(f.sockets.at(-1).listening, false);
        assert.equal(f.fds.size, 0);
        const retained = snapshot(f, removal),
            previousId = saved.initial.root.installationId,
            again = await f.run('install');
        assert.equal(again.status, 'finished');
        const archive = work(f) + '-removed-' + previousId;
        for (const [name, value] of retained)
            assert.equal(
                f.node(archive + name.slice(removal.length)).bytes.toString('base64'),
                value,
            );
        assert.equal(f.nodes.has(removal), false);
        assert.notEqual(
            json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD).installationId,
            previousId,
        );
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
        assert.equal(f.sockets.at(-1).listening, false);
        assert.equal(f.fds.size, 0);
    }
});

test('archived initial removal recovery preserves filename and original bytes after a lost unlink acknowledgement', async () => {
    for (const mode of ['resume', 'changed-original', 'renamed-original']) {
        const f = await installed(),
            original = archivedInitial(f);
        let first = true;
        f.afterUnlink = () => {
            if (first) {
                first = false;
                throw undefined;
            }
        };
        assert.equal((await f.run()).status, 'retained-unknown');
        assert.equal(f.unlinkCalls.length, 1);
        const removal = work(f) + '-uninstall',
            from = removal + '/original-maintenance/completed-journal.json';
        assert.equal(json(f, removal + '/state.json').leaf, 'unlink-issued');
        // Authored MapFS restart only; no actual reservation or process is released.
        for (const socket of f.sockets) socket.listening = false;
        f.afterUnlink = undefined;
        if (mode === 'changed-original')
            f.node(from).bytes = Buffer.concat([original, Buffer.from('\n')]);
        if (mode === 'renamed-original') {
            const node = f.node(from),
                to = removal + '/original-maintenance/journal.json';
            f.nodes.delete(from);
            node.path = to;
            f.nodes.set(to, node);
        }
        const at = f.calls.length,
            result = await f.run();
        if (mode === 'resume') {
            assert.equal(result.status, 'current-payload-removed');
            assert.equal(f.unlinkCalls.length, 6);
            assert.deepEqual(bytes(f, from), original);
            assert.equal(json(f, removal + '/state.json').phase, 'complete');
        } else {
            assert.equal(result.status, 'retained-unknown');
            assert.equal(f.calls.slice(at).some(mutation), false);
            assert.equal(f.unlinkCalls.length, 1);
        }
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    }
});

test('completed initial journal does not admit conflicting or changed transaction histories', async () => {
    for (const mode of ['both-journals', 'previous-digest', 'transaction', 'phase']) {
        const f = await installed(),
            original = archivedInitial(f),
            file = work(f) + '/completed-journal.json';
        if (mode === 'both-journals') f.file(work(f) + '/journal.json', original.toString());
        else {
            const value = json(f, file);
            if (mode === 'previous-digest') value.previousSHA256 = 'f'.repeat(64);
            if (mode === 'transaction')
                value.transactionId = '99999999-9999-4999-8999-999999999999';
            if (mode === 'phase') value.phase = 'old-retained';
            f.node(file).bytes = Buffer.from(JSON.stringify(value));
        }
        const at = f.calls.length,
            originalFiles = snapshot(f, '/home/test');
        assert.equal((await f.run()).status, 'retained-unknown', mode);
        assert.equal(f.calls.slice(at).some(mutation), false, mode);
        assert.equal(f.promptRequests.length, 0, mode);
        assert.equal(f.unlinkCalls.length, 0, mode);
        preserved(f, originalFiles);
    }
});

test('archived initial journal changing during consent cannot begin removal', async () => {
    const f = await installed(),
        original = archivedInitial(f);
    f.promptGate = deferred();
    f.enteredPrompt = deferred();
    const running = f.run(),
        outcome = running.then(
            (value: any) => ({ value }),
            (error: any) => ({ error }),
        );
    try {
        const milestone: any = await Promise.race([
            f.enteredPrompt.promise.then(() => ({ entered: true })),
            outcome,
        ]);
        assert.equal(milestone.entered, true);
        const at = f.calls.length;
        f.node(work(f) + '/completed-journal.json').bytes = Buffer.concat([
            original,
            Buffer.from('\n'),
        ]);
        f.promptGate.resolve();
        assert.equal((await running).status, 'retained-unknown');
        assert.equal(f.calls.slice(at).some(mutation), false);
        assert.equal(f.unlinkCalls.length, 0);
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    } finally {
        f.promptGate.resolve();
        await outcome;
    }
});

test('classic links and source A install B removal C fresh install preserve historical actors and originals', async () => {
    const f = await installed(true),
        home = f.node('/home/test'),
        beforeHome = home.nlink;
    const installerSource = f.plan.host.sourceRoot;
    const installerJournal = bytes(f, work(f) + '/journal.json');
    const selectSource = (newSource: string) => {
        const oldSource = f.plan.host.sourceRoot;
        for (const [name, value] of snapshot(f, oldSource)) {
            const node = f.node(name);
            f.file(
                newSource + name.slice(oldSource.length),
                Buffer.from(value, 'base64').toString(),
                node.mode & 0o777,
            );
        }
        f.plan.host.sourceRoot = newSource;
        f.plan.owner.executable = newSource + '/app/diagnostic-hub';
        f.ops.executable = f.plan.owner.executable;
        f.node('/proc/777/exe').target = f.ops.executable;
        for (const [name, node] of f.nodes)
            if (node.kind === 'directory')
                node.nlink =
                    2 +
                    Array.from(f.nodes.values() as Iterable<any>).filter(
                        (child) =>
                            child.kind === 'directory' &&
                            child.path !== name &&
                            path.posix.dirname(child.path) === name,
                    ).length;
    };
    const firstId = json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD).installationId;
    const removerSource = '/home/test/remover-source';
    selectSource(removerSource);
    assert.equal((await f.run()).status, 'current-payload-removed');
    assert.ok(home.nlink >= 2);
    assert.equal(f.node(work(f) + '-uninstall/disposal').nlink, 2);
    const originals = snapshot(f, work(f) + '-uninstall');
    const removalSnapshot = json(f, work(f) + '-uninstall/snapshot.json');
    assert.equal(removalSnapshot.host.sourceRoot, removerSource);
    assert.equal(removalSnapshot.removalOwner.executable, removerSource + '/app/diagnostic-hub');
    assert.equal(
        removalSnapshot.initial.journal.owner.executable,
        installerSource + '/app/diagnostic-hub',
    );
    assert.notEqual(
        removalSnapshot.removalOwner.executable,
        removalSnapshot.initial.journal.owner.executable,
    );
    assert.deepEqual(
        bytes(f, work(f) + '-uninstall/original-maintenance/journal.json'),
        installerJournal,
    );
    // A subsequent genuine preparation may execute from a separately downloaded complete folder.
    selectSource('/home/test/next-source');
    const again = await f.run('install');
    assert.equal(
        again.status,
        'finished',
        JSON.stringify(f.core.linuxPermanentSetupDiagnostics(again.owner)),
    );
    assert.equal(again.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const archive = work(f) + '-removed-' + firstId;
    for (const [name, value] of originals)
        assert.equal(
            f.node(archive + name.slice((work(f) + '-uninstall').length)).bytes.toString('base64'),
            value,
        );
    assert.equal(f.nodes.has(work(f) + '-uninstall'), false);
    const secondId = json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD).installationId;
    assert.notEqual(secondId, firstId);
    assert.equal((await f.run()).status, 'current-payload-removed');
    assert.equal(json(f, archive + '/state.json').phase, 'complete');
    assert.equal(
        json(f, archive + '/snapshot.json').removalOwner.executable,
        removerSource + '/app/diagnostic-hub',
    );
    assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    assert.ok(home.nlink >= beforeHome);
    assert.equal(f.fds.size, 0);
});

test('menu recovery activity unknown and missing removal capability refuse before any removal or prompt', async () => {
    for (const mode of ['menu', 'active', 'unknown', 'history', 'capability']) {
        const f = await installed(false, mode === 'menu');
        if (mode === 'capability') f.ops.unlinkOwned = null;
        if (mode === 'history')
            f.file(
                work(f) + '/completed-journal.json',
                bytes(f, work(f) + '/journal.json').toString(),
            );
        if (mode === 'active' || mode === 'unknown') {
            f.directory('/proc/888', 1000);
            f.file(
                '/proc/888/stat',
                '888 (other) S ' + Array(18).fill('0').join(' ') + ' 333\n',
                0o444,
            );
            if (mode === 'active') {
                const node = f.file('/proc/888/exe', '', 0o777);
                node.kind = 'link';
                node.target = f.plan.root + '/app/diagnostic-hub';
            }
        }
        const original = snapshot(f, '/home/test'),
            at = f.calls.length;
        const result = await f.run();
        assert.equal(result.status, 'retained-unknown', mode);
        assert.equal(f.calls.slice(at).some(mutation), false, mode);
        assert.equal(f.promptRequests.length, 0, mode);
        preserved(f, original);
    }
});

test('cancel and changed or expired pending review cannot begin removal', async () => {
    const cancelled = await installed();
    cancelled.reply = { status: 'cancelled' };
    const at = cancelled.calls.length;
    assert.equal((await cancelled.run()).status, 'cancelled');
    assert.equal(cancelled.calls.slice(at).some(mutation), false);
    for (const mode of ['changed', 'expired']) {
        const f = await installed();
        f.promptGate = deferred();
        f.enteredPrompt = deferred();
        const running = f.run(),
            outcome = running.then(
                (value: any) => ({ value }),
                (error: any) => ({ error }),
            );
        try {
            const milestone: any = await Promise.race([
                f.enteredPrompt.promise.then(() => ({ entered: true })),
                outcome,
            ]);
            assert.equal(milestone.entered, true);
            const at = f.calls.length;
            if (mode === 'changed')
                f.node(f.plan.root + '/app/diagnostic-hub').bytes = Buffer.from('changed');
            else f.advance(120000);
            f.promptGate.resolve();
            assert.equal((await running).status, 'retained-unknown');
            assert.equal(f.calls.slice(at).some(mutation), false);
            assert.equal(f.unlinkCalls.length, 0);
        } finally {
            f.promptGate.resolve();
            await outcome;
        }
    }
});

test('issued unlink failures retain first custody no retry and pending removal blocks every ordinary operation', async () => {
    for (const thrown of [Error('raw-primary'), undefined]) {
        const f = await installed(),
            original = snapshot(f, f.plan.host.sourceRoot);
        f.beforeUnlink = () => {
            throw thrown;
        };
        const result = await f.run();
        assert.equal(result.status, 'retained-unknown');
        assert.equal(f.unlinkCalls.length, 1);
        const progress = json(f, work(f) + '-uninstall/state.json');
        assert.equal(progress.leaf, 'unlink-issued');
        assert.equal(
            f.core.linuxPermanentSetupDiagnostics(result.owner).uninstall.primarySet,
            true,
        );
        assert.equal(f.sockets.at(-1).listening, true);
        preserved(f, original);
        const at = f.calls.length;
        for (const operation of ['install', 'update', 'resume', 'launch'])
            assert.equal((await f.run(operation)).status, 'retained-unknown');
        assert.equal(f.calls.slice(at).some(mutation), false);
        assert.equal(f.unlinkCalls.length, 1);
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    }
});

test('explicit restarted owner resolves lost unlink ACK from observed absence and rejects contradictory progress', async () => {
    for (const mode of [
        'resume',
        'reappeared',
        'original-binding',
        'missing-removal-owner',
        'malformed-removal-owner',
    ]) {
        const f = await installed();
        let first = true;
        f.afterUnlink = () => {
            if (first) {
                first = false;
                throw undefined;
            }
        };
        assert.equal((await f.run()).status, 'retained-unknown');
        assert.equal(f.unlinkCalls.length, 1);
        const removal = work(f) + '-uninstall',
            state = json(f, removal + '/state.json'),
            saved = json(f, removal + '/snapshot.json');
        assert.equal(state.leaf, 'unlink-issued');
        // Authored OS restart: the old abstract reservation is no longer listening. No real process/close.
        for (const socket of f.sockets) socket.listening = false;
        f.afterUnlink = undefined;
        if (mode === 'reappeared') {
            const item = saved.entries[state.index];
            f.file(removal + '/payload/' + item.path, 'foreign-reappeared');
        }
        if (mode === 'original-binding') {
            const record = saved.originals.find(
                (item: any) => item.path === installation.INSTALLATION_RECORD,
            );
            const value = JSON.parse(Buffer.from(record.base64, 'base64').toString());
            value.installationId = '99999999-9999-4999-8999-999999999999';
            const raw = Buffer.from(JSON.stringify(value));
            record.base64 = raw.toString('base64');
            record.sha256 = hash(raw);
            const entry = saved.entries.find((item: any) => item.path === record.path);
            entry.sha256 = record.sha256;
            entry.bytes = raw.length;
        }
        if (mode === 'missing-removal-owner') delete saved.removalOwner;
        if (mode === 'malformed-removal-owner')
            saved.removalOwner.executable = '/home/test/foreign-source/app/diagnostic-hub';
        if (
            ['original-binding', 'missing-removal-owner', 'malformed-removal-owner'].includes(mode)
        ) {
            const snapshotRaw = Buffer.from(JSON.stringify(saved));
            f.node(removal + '/snapshot.json').bytes = snapshotRaw;
            state.snapshotSHA256 = hash(snapshotRaw);
            f.node(removal + '/state.json').bytes = Buffer.from(JSON.stringify(state));
        }
        const at = f.calls.length,
            result = await f.run();
        if (mode === 'resume') {
            assert.equal(result.status, 'current-payload-removed');
            assert.equal(f.unlinkCalls.length, 6);
        } else {
            assert.equal(result.status, 'retained-unknown');
            assert.equal(f.calls.slice(at).some(mutation), false);
            assert.equal(f.unlinkCalls.length, 1);
        }
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    }
});

test('moved foreign late and terminal-error outcomes never publish false success or retry', async () => {
    for (const mode of [
        'foreign',
        'late',
        'quarantine-active',
        'release-error',
        'throw-undefined',
        'ack-then-throw-undefined',
        'socket-pending',
    ]) {
        const f = await installed();
        if (mode === 'foreign')
            f.afterMove = (_from: string, to: string) => {
                if (to.endsWith('/disposal/entry')) f.node(to).ino += 10000;
            };
        if (mode === 'late') f.afterUnlink = () => f.advance(120000);
        if (mode === 'release-error')
            f.afterClose = (done: (error: unknown) => void) => done(Error('late-close-error'));
        if (mode === 'throw-undefined' || mode === 'ack-then-throw-undefined')
            f.closeBehavior = mode;
        if (mode === 'socket-pending')
            f.afterUnlink = () => {
                if (f.unlinkCalls.length !== 6) return;
                const socket = Object.assign(new EventEmitter(), {
                    destroyCalls: 0,
                    destroy() {
                        this.destroyCalls++;
                        return this;
                    },
                });
                f.acceptedSocket = socket;
                f.sockets.at(-1).emit('connection', socket);
            };
        if (mode === 'quarantine-active')
            f.afterMove = (_from: string, to: string) => {
                if (to.endsWith('-uninstall/payload')) {
                    f.directory('/proc/888', 1000);
                    f.file(
                        '/proc/888/stat',
                        '888 (other) S ' + Array(18).fill('0').join(' ') + ' 333\n',
                        0o444,
                    );
                    const node = f.file('/proc/888/exe', '', 0o777);
                    node.kind = 'link';
                    node.target = to + '/app/diagnostic-hub';
                }
            };
        const terminal = [
            'release-error',
            'throw-undefined',
            'ack-then-throw-undefined',
            'socket-pending',
        ].includes(mode);
        const knownClosed = mode === 'release-error' || mode === 'ack-then-throw-undefined';
        const result = await f.run();
        assert.equal(result.status, knownClosed ? 'refused' : 'retained-unknown');
        assert.equal(f.nodes.has(f.plan.root), false);
        assert.equal(f.unlinkCalls.length, terminal ? 6 : mode === 'late' ? 1 : 0);
        assert.equal(f.sockets.at(-1).listening, !terminal);
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
        if (terminal) {
            assert.equal(f.fds.size, 0);
            assert.equal(json(f, work(f) + '-uninstall/state.json').phase, 'complete');
            const custody = f.core.linuxPermanentSetupDiagnostics(result.owner).uninstall;
            assert.equal(custody.primarySet, true);
            assert.equal(custody.reservation, knownClosed ? 'none' : 'held');
            if (mode === 'socket-pending') {
                assert.equal(custody.backend.retainedSockets, 1);
                assert.equal(f.acceptedSocket.destroyCalls, 1);
            }
        }
        if (mode === 'foreign')
            assert.ok(f.node(work(f) + '-uninstall/disposal/entry').ino > 10000);
    }
});

test('unexpected parent link deltas and identity replacement refuse while both supported link policies work', async () => {
    for (const mode of ['extra-link', 'identity']) {
        const f = memory(true),
            mkdir = f.ops.fs.mkdirSync.bind(f.ops.fs);
        f.ops.fs.mkdirSync = (name: string, options: any) => {
            mkdir(name, options);
            if (mode === 'extra-link') f.node('/home/test').nlink++;
            else f.node('/home/test').ino += 10000;
        };
        const result = await driver
            .createLinuxNativeDriver(f.plan, { startedMs: 0, deadlineMs: 120000 }, f.ops)
            .run();
        assert.equal(result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(f.calls.includes('move-noreplace'), false);
        assert.equal(f.unlinkCalls.length, 0);
        assert.equal(f.nodes.has(f.plan.root), false);
        assert.equal(bytes(f, f.profile).toString(), 'settings-and-reports');
    }
});
