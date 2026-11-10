import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import * as installation from '../shared/installation.ts';
import * as model from '../electron/linux-transaction-model.ts';
import * as menu from '../electron/linux-menu-ownership.ts';
import { linuxReviewArguments } from '../electron/linux-setup-ui.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';

// Fixed source reads only. No physical-FS/native host module, default backend,
// installer process, timer or old test registration is imported or executed.
const root = new URL('../', import.meta.url);
const allowed = new Set(
    [
        'electron/linux-native-backend.ts',
        'electron/linux-initial-uninstall.ts',
        'electron/linux-native-driver.ts',
        'electron/linux-permanent-setup.ts',
        'electron/installation-maintenance.ts',
        'tests/linux-native-backend.test.ts',
        'tests/linux-permanent-setup.test.ts',
    ].map((relative) => new URL(relative, root).href),
);
const read = (url: URL, encoding: 'utf8' = 'utf8') => {
    assert.ok(allowed.has(url.href), 'Unadmitted source read.');
    return readFileSync(url, encoding);
};
const refuse = () => {
    throw Error('UNEXPECTED_REAL_HOST_PORT');
};
const maintenanceTree = ts.createSourceFile(
    'fixed-maintenance.ts',
    read(new URL('electron/installation-maintenance.ts', root)),
    ts.ScriptTarget.ES2022,
    true,
);
const maintenance: Record<string, string> = {};
for (const name of ['SETUP_OWNER', 'SETUP_PAYLOAD']) {
    const declarations = maintenanceTree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(declarations.length, 1);
    const value = declarations[0].initializer;
    assert.ok(value && ts.isStringLiteral(value));
    maintenance[name] = value.text;
}
function subject(
    relative: 'electron/linux-native-backend.ts' | 'electron/linux-native-driver.ts' | 'electron/linux-initial-uninstall.ts',
    modules: Map<string, unknown>,
) {
    const source = read(new URL(relative, root));
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.ES2022, true);
    assert.equal(
        (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
        0,
    );
    for (const node of tree.statements)
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
            assert.ok(
                ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
            );
        }
    const compiled = ts.transpileModule(source, {
        fileName: relative,
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
            process: Object.freeze({}),
            performance: Object.freeze({ now: refuse }),
            setTimeout: refuse,
            clearTimeout: refuse,
            require(name: string) {
                assert.ok(modules.has(name));
                return modules.get(name);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    new vm.Script(compiled.outputText, { filename: relative + '.memory.cjs' }).runInContext(
        context,
        { timeout: 1000 },
    );
    return module.exports;
}
const removal = subject('electron/linux-initial-uninstall.ts',new Map<string,unknown>([
    ['node:path',path],['node:crypto',{createHash,randomUUID:refuse}],
    ['./linux-transaction-model.ts',model],['../shared/installation.ts',installation],
    ['./installation-maintenance.ts',maintenance],
]));
const backend = subject(
    'electron/linux-native-backend.ts',
    new Map<string, unknown>([
        ['node:path', path],
        ['node:crypto', { createHash, randomUUID: refuse }],
        ['node:net', { createServer: refuse }],
        ['./physical-fs.ts', { physicalFS: Object.freeze({}) }],
        ['./linux-transaction-model.ts', model],
        ['../shared/installation.ts', installation],
        ['./installation-maintenance.ts', maintenance],
        ['./linux-menu-ownership.ts', menu],
        ['./linux-initial-uninstall.ts',removal],
    ]),
);
const nativeDriver = subject(
    'electron/linux-native-driver.ts',
    new Map<string, unknown>([
        ['./linux-native-backend.ts', backend],
        ['./linux-transaction-model.ts', model],
    ]),
);
const fixtureUrl = new URL('tests/linux-permanent-setup.test.ts', root);
const fixtureSource = read(fixtureUrl);
assert.equal(
    createHash('sha256').update(fixtureSource).digest('hex'),
    '7c4f4efbef492a7aa29861a3f2a762f94d553ec7f7a03af98eb24c589f93fac0',
);
const fixtureTree = ts.createSourceFile(
    'fixed-permanent-fixture.ts',
    fixtureSource,
    ts.ScriptTarget.ES2022,
    true,
);
const registrations = fixtureTree.statements.filter(
    (node) =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'test',
);
assert.equal(registrations.length, 10);
const admittedImports = new Set([
    'node:assert/strict',
    'node:test',
    'node:vm',
    'typescript',
    'node:fs',
    'node:crypto',
    'node:events',
    'node:path',
    '../electron/linux-native-backend.ts',
    '../electron/linux-native-driver.ts',
    '../electron/linux-transaction-model.ts',
    '../electron/linux-owned-launch.ts',
    '../electron/linux-menu-ownership.ts',
    '../shared/installation.ts',
    '../electron/installation-maintenance.ts',
    './fixtures/linux-readback-port.ts',
    '../electron/linux-setup-ui.ts',
]);
for (const node of fixtureTree.statements)
    if (ts.isImportDeclaration(node))
        assert.ok(
            ts.isStringLiteral(node.moduleSpecifier) &&
                admittedImports.has(node.moduleSpecifier.text),
        );
let prefix = fixtureTree.statements
    .filter((node) => node.pos < registrations[0].pos && !ts.isImportDeclaration(node))
    .map((node) => node.getText(fixtureTree))
    .join('\n');
assert.equal(prefix.split('import.meta.url').length - 1, 2);
prefix = prefix.replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href));
const fixtureCompiled = ts.transpileModule(
    prefix +
        '\nmodule.exports={permanentFixture,selectCandidate,gate,milestone,workPath,mutation};',
    {
        fileName: 'exact-permanent-fixture-prefix.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    },
);
assert.equal(
    (fixtureCompiled.diagnostics ?? []).filter(
        (item) => item.category === ts.DiagnosticCategory.Error,
    ).length,
    0,
);
const fixtureModule = { exports: {} as any };
const fixtureContext = vm.createContext(
    {
        module: fixtureModule,
        exports: fixtureModule.exports,
        Object,
        JSON,
        Map,
        Set,
        Buffer,
        Promise,
        Error,
        TextDecoder,
        structuredClone,
        URL,
        assert,
        vm,
        ts,
        readFileSync: read,
        constants,
        createHash,
        EventEmitter,
        path,
        ...backend,
        createLinuxNativeDriver: nativeDriver.createLinuxNativeDriver,
        nativeDriver,
        linuxModelReviewSHA256: model.linuxModelReviewSHA256,
        createLinuxOwnedLaunch: refuse,
        ownedLaunch: Object.freeze({ createLinuxOwnedLaunch: refuse }),
        desiredLinuxMenu: menu.desiredLinuxMenu,
        prepareLinuxMenuJournal: menu.prepareLinuxMenuJournal,
        INSTALLATION_PRODUCT: installation.INSTALLATION_PRODUCT,
        validateInstallationManifest: installation.validateInstallationManifest,
        installation,
        ...maintenance,
        linuxReviewArguments,
        linuxReadbackPair,
        queueMicrotask,
    },
    { codeGeneration: { strings: false, wasm: false } },
);
new vm.Script(fixtureCompiled.outputText, {
    filename: 'exact-permanent-prefix.memory.cjs',
}).runInContext(fixtureContext, { timeout: 1000 });
const { permanentFixture, selectCandidate, gate, milestone, workPath, mutation } =
    fixtureModule.exports;
const bytes = (f: any, file: string) => Buffer.from(f.node(file).bytes);
const json = (f: any, file: string) => JSON.parse(bytes(f, file).toString());
async function next(f: any, version: string) {
    selectCandidate(f, version, 'actual-memory-candidate-' + version);
    f.choices.operation = 'update';
    return f.begin().operation;
}
async function seed(selected = false) {
    const f = permanentFixture(false, selected);
    assert.equal((await f.begin().operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const work = workPath(f.plan.root),
        originalA = bytes(f, work + '/journal.json'),
        inodeA = f.node(f.plan.root).ino;
    const installationId = json(
        f,
        f.plan.root + '/.diagnostic-hub-installation.json',
    ).installationId;
    const profile =
        f.plan.host.appData + '/DiagnosticHub/profiles/' + installationId + '/retained-marker';
    f.file(profile, 'original profile bytes');
    assert.equal((await next(f, '0.7.0')).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const originalB = bytes(f, work + '/journal.json'),
        journalB = JSON.parse(originalB.toString()),
        inodeB = f.node(f.plan.root).ino;
    return { f, work, originalA, originalB, journalB, inodeA, inodeB, profile };
}
const originals = (f: any, work: string) =>
    new Map<string, Buffer>(
        Array.from(f.nodes.entries() as Iterable<[string, any]>)
            .filter(([file, value]) => file.startsWith(work + '/') && value.kind === 'file')
            .map(([file, value]) => [file, Buffer.from(value.bytes)] as const),
    );

test('real permanent caller advances A to B to C and D retaining every original and prior payload', async () => {
    const { f, work, originalA, originalB, journalB, inodeA, inodeB, profile } = await seed();
    const c = await next(f, '0.8.0');
    assert.equal(c.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const journalC = json(f, work + '/journal.json'),
        originalC = bytes(f, work + '/journal.json'),
        inodeC = f.node(f.plan.root).ino;
    assert.deepEqual(bytes(f, work + '/completed-journal.json'), originalA);
    assert.deepEqual(
        bytes(f, work + '/retained-journal-' + journalB.transactionId + '.json'),
        originalB,
    );
    assert.equal(f.node(work + '/previous-' + journalB.transactionId).ino, inodeA);
    assert.equal(f.node(work + '/previous-' + journalC.transactionId).ino, inodeB);
    const d = await next(f, '0.9.0');
    assert.equal(d.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const journalD = json(f, work + '/journal.json');
    assert.deepEqual(
        bytes(f, work + '/retained-journal-' + journalC.transactionId + '.json'),
        originalC,
    );
    assert.equal(f.node(work + '/previous-' + journalD.transactionId).ino, inodeC);
    assert.equal(f.node(work + '/previous-' + journalB.transactionId).ino, inodeA);
    assert.equal(f.node(work + '/previous-' + journalC.transactionId).ino, inodeB);
    assert.equal(bytes(f, profile).toString(), 'original profile bytes');
    assert.equal(c.result.nativeQualified, false);
    assert.equal(d.result.nativeQualified, false);
    assert.equal(f.state.processRequests.length, 0);
    for (const name of ['unlinkSync', 'rmdirSync', 'rmSync', 'renameSync'])
        assert.equal(name in f.ops.fs, false);
});

test('C rollback restores B once and retains C plus immutable A B lineage without enabling another update', async () => {
    const { f, work, inodeB, profile } = await seed();
    assert.equal((await next(f, '0.8.0')).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const currentC = json(f, work + '/journal.json'),
        inodeC = f.node(f.plan.root).ino;
    const saved = originals(f, work);
    const retainedC = originals(f, f.plan.root);
    f.choices.operation = 'rollback';
    const rolled = await f.begin().operation;
    assert.equal(rolled.result.verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.plan.root).ino, inodeB);
    assert.equal(f.node(work + '/stage-' + currentC.transactionId).ino, inodeC);
    const at = f.calls.length;
    assert.equal((await f.begin().operation).result.verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.calls.slice(at).some(mutation), false);
    const formerPrevious = work + '/previous-' + currentC.transactionId;
    for (const [file, original] of saved)
        if (file !== work + '/journal.json') {
            const actual = file.startsWith(formerPrevious + '/')
                ? f.plan.root + file.slice(formerPrevious.length)
                : file;
            assert.deepEqual(bytes(f, actual), original);
        }
    for (const [file, original] of retainedC)
        assert.deepEqual(
            bytes(f, work + '/stage-' + currentC.transactionId + file.slice(f.plan.root.length)),
            original,
        );
    const before = f.calls.length;
    const refused = await next(f, '0.9.0');
    assert.equal(refused.status, 'retained-unknown');
    assert.equal(f.calls.slice(before).some(mutation), false);
    assert.equal(f.node(f.plan.root).ino, inodeB);
    assert.equal(f.node(work + '/stage-' + currentC.transactionId).ino, inodeC);
    assert.equal(bytes(f, profile).toString(), 'original profile bytes');
    assert.equal(f.state.processRequests.length, 0);
});

test('foreign originals broken lineage aliases and historical activity refuse before any new mutation', async () => {
    for (const mode of [
        'foreign',
        'original',
        'chain',
        'alias',
        'active',
        'unknown-activity',
        'menu',
        'predecessor-transaction',
    ]) {
        const { f, work, journalB, inodeA, profile } = await seed(mode === 'menu');
        if (mode !== 'menu')
            assert.equal((await next(f, '0.8.0')).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        const menuPath =
            mode === 'menu'
                ? json(f, f.plan.root + '/' + maintenance.SETUP_OWNER).integrations[0].path
                : null;
        const menuOriginal = menuPath ? bytes(f, menuPath) : null;
        const saved = originals(f, work);
        const archive = work + '/retained-journal-' + journalB.transactionId + '.json';
        let changedOwner: { path: string; original: Buffer } | null = null;
        if (mode === 'foreign') f.file(work + '/retained-journal-unbound.json', 'unbound original');
        else if (mode === 'original')
            f.node(archive).bytes = Buffer.concat([bytes(f, archive), Buffer.from('x')]);
        else if (mode === 'chain') {
            const decoded = json(f, archive);
            decoded.previousSHA256 = 'f'.repeat(64);
            f.node(archive).bytes = Buffer.from(JSON.stringify(decoded));
        } else if (mode === 'alias')
            f.node(work + '/previous-' + journalB.transactionId).ino = f.node(f.plan.root).ino;
        else if (mode === 'predecessor-transaction') {
            const current = json(f, work + '/journal.json');
            const ownerPath =
                work + '/previous-' + current.transactionId + '/' + maintenance.SETUP_OWNER;
            const decoded = json(f, ownerPath);
            decoded.transactionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            const original = Buffer.from(JSON.stringify(decoded));
            f.node(ownerPath).bytes = original;
            changedOwner = { path: ownerPath, original: Buffer.from(original) };
        } else if (mode === 'active' || mode === 'unknown-activity') {
            f.directory('/proc/888', 1000);
            const process = f.file(
                '/proc/888/stat',
                '888 (retained) S ' + Array(18).fill('0').join(' ') + ' 9000\n',
                0o444,
            );
            process.proc = true;
            if (mode === 'active') {
                const executable = f.file('/proc/888/exe', '', 0o777);
                executable.kind = 'link';
                executable.target =
                    work + '/previous-' + journalB.transactionId + '/app/diagnostic-hub';
            }
        }
        const before = f.calls.length,
            inodeC = f.node(f.plan.root).ino;
        let refused;
        if (mode === 'predecessor-transaction') {
            f.choices.operation = 'rollback';
            refused = await f.begin().operation;
        } else refused = await next(f, mode === 'menu' ? '0.8.0' : '0.9.0');
        assert.equal(refused.status, 'retained-unknown', mode);
        assert.equal(f.calls.slice(before).some(mutation), false, mode);
        assert.equal(f.node(f.plan.root).ino, inodeC);
        if (mode !== 'alias')
            assert.equal(f.node(work + '/previous-' + journalB.transactionId).ino, inodeA);
        assert.equal(bytes(f, profile).toString(), 'original profile bytes');
        if (menuPath) {
            assert.deepEqual(bytes(f, menuPath), menuOriginal);
            for (const [file, original] of saved) assert.deepEqual(bytes(f, file), original);
        }
        if (changedOwner) {
            assert.deepEqual(bytes(f, changedOwner.path), changedOwner.original);
            for (const file of [work + '/completed-journal.json', archive, work + '/journal.json'])
                assert.deepEqual(bytes(f, file), saved.get(file));
        }
        assert.equal(f.state.processRequests.length, 0);
    }
});

test('review races and uncertain archive acknowledgements retain current owner with no activation or retry', async () => {
    for (const mode of ['review-race', 'before-move', 'move-then-throw']) {
        const { f, work, originalB, inodeB, journalB } = await seed();
        selectCandidate(f, '0.8.0', 'candidate-C-held');
        f.choices.operation = 'update';
        let attempts = 0;
        const move = f.ops.moveNoReplace;
        if (mode !== 'review-race')
            f.ops.moveNoReplace = (...args: any[]) => {
                if (args[1] === 'journal.json' && args[3].startsWith('retained-journal-')) {
                    attempts++;
                    if (mode === 'move-then-throw') Reflect.apply(move, f.ops, args);
                    throw Error('ARCHIVE_ACK_UNKNOWN');
                }
                return Reflect.apply(move, f.ops, args);
            };
        const at = f.calls.length;
        let outcome;
        if (mode === 'review-race') {
            const held = gate();
            f.state.enteredGUI = gate();
            f.state.guiGate = held;
            const running = f.begin();
            try {
                await milestone(running, f.state.enteredGUI.promise);
                const decoded = json(f, work + '/completed-journal.json');
                decoded.owner.startTicks = '10000';
                f.node(work + '/completed-journal.json').bytes = Buffer.from(
                    JSON.stringify(decoded),
                );
            } finally {
                held.resolve();
                await running.outcome;
            }
            outcome = await running.operation;
        } else outcome = await f.begin().operation;
        assert.equal(outcome.status, 'retained-unknown');
        assert.equal(f.node(f.plan.root).ino, inodeB);
        assert.equal(
            f.calls.slice(at).some((name: string) => /^(write|truncate|mkdir)$/.test(name)),
            false,
        );
        if (mode !== 'review-race') {
            assert.equal(attempts, 1);
            assert.equal(outcome.result.reservation, 'held');
            if (mode === 'before-move')
                assert.deepEqual(bytes(f, work + '/journal.json'), originalB);
            else
                assert.deepEqual(
                    bytes(f, work + '/retained-journal-' + journalB.transactionId + '.json'),
                    originalB,
                );
        }
        const stopped = f.calls.length;
        f.api.linuxPermanentSetupDiagnostics(outcome.owner);
        assert.equal(f.calls.length, stopped);
        assert.equal(f.state.processRequests.length, 0);
    }
});

test('acknowledged archive boundary continues under a fresh invocation without replaying its move', async () => {
    const { f, work, journalB, originalB } = await seed();
    selectCandidate(f, '0.8.0', 'candidate-C-after-archive');
    f.choices.operation = 'update';
    const b = backend.createLinuxNativePreparationBackend(
        {
            host: f.plan.host,
            root: f.plan.root,
            action: 'update',
            transactionId: f.ops.uuid(),
            installationId: f.plan.installationId,
            owner: f.plan.owner,
        },
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    );
    const prepared = await b.prepare(),
        view = prepared.view;
    const lease = await b.kernel.acquire({
        root: prepared.configuration.root,
        uid: 1000,
        key: prepared.scope.key,
        owner: prepared.configuration.owner,
    });
    assert.ok(lease);
    const after = await b.effects.handoff(prepared.scope, view);
    assert.equal(after.journal, null);
    assert.equal(after.history.lineage.at(-1).archived, true);
    assert.deepEqual(
        bytes(f, work + '/retained-journal-' + journalB.transactionId + '.json'),
        originalB,
    );
    assert.equal(await b.kernel.release(lease.handle, lease.identity), true);
    const at = f.calls.length;
    const completed = await f.begin().operation;
    assert.equal(completed.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    // Only B->previous and staged C->root remain; the acknowledged journal is not moved again.
    assert.equal(f.calls.slice(at).filter((name: string) => name === 'move-noreplace').length, 2);
    assert.deepEqual(
        bytes(f, work + '/retained-journal-' + journalB.transactionId + '.json'),
        originalB,
    );
});

test('finite retained-history capacity refuses before mutation and cancellation never archives', async () => {
    const { f, work, profile } = await seed();
    for (let index = 0; index < model.MAX_LINUX_RETAINED_GENERATIONS; index++)
        assert.equal(
            (await next(f, '0.' + (8 + index) + '.0')).result.verdict,
            'ACTIVE_PREVIOUS_RETAINED',
        );
    const saved = originals(f, work),
        inode = f.node(f.plan.root).ino,
        at = f.calls.length;
    assert.equal((await next(f, '0.99.0')).status, 'retained-unknown');
    assert.equal(f.calls.slice(at).some(mutation), false);
    assert.equal(f.node(f.plan.root).ino, inode);
    for (const [file, original] of saved) assert.deepEqual(bytes(f, file), original);
    assert.equal(bytes(f, profile).toString(), 'original profile bytes');
    const cancelled = await seed();
    cancelled.f.state.reply = { status: 'cancelled' };
    const before = cancelled.f.calls.length;
    assert.equal((await next(cancelled.f, '0.8.0')).status, 'cancelled');
    assert.equal(cancelled.f.calls.slice(before).some(mutation), false);
    assert.deepEqual(bytes(cancelled.f, cancelled.work + '/journal.json'), cancelled.originalB);
});
