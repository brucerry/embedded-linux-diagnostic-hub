/** Actual fixture orchestration and record closures under closed memory ports only.
 * No installer, native addon, app, filesystem mutation, process or real timer is executed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as fixtureRecords from '../scripts/lib/linux-owned-fixture-records.ts';

const root = new URL('../', import.meta.url),
    entryURL = new URL('scripts/linux-owned-seal-preparation-fixture.ts', root),
    installURL = new URL('scripts/linux-owned-installation-fixture.ts', root),
    helperURL = new URL('tests/linux-owned-current-b-fixture.test.ts', root),
    entrySource = readFileSync(entryURL, 'utf8'),
    installSource = readFileSync(installURL, 'utf8'),
    helperSource = readFileSync(helperURL, 'utf8');
const compile = (source: string) =>
    ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
const entryCode =
    compile(entrySource.replace('import.meta.url', "'file:///fixed/entry.ts'")) +
    '\nexports.inspect = () => Array.from(runs);';
const closedBackend = () => ({
    failed: false,
    pending: null,
    retainedFDs: 0,
    retainedDirs: 0,
    retainedServers: 0,
    retainedSockets: 0,
    retainedTimers: 0,
});
function summary(recovery = false) {
    return {
        verdict: recovery ? 'SEAL_RECOVERED_NO_LAUNCH' : 'SEAL_PREPARATION_PAUSED',
        code: recovery ? 'SEAL_RECOVERED_NO_LAUNCH' : 'SEAL_PREPARATION_PAUSED',
        pending: null,
        reservation: 'none',
        childOwned: false,
        timerOwned: false,
        spawned: !recovery,
        exited: !recovery,
        closed: !recovery,
        initialConfirmed: false,
        retainedConfirmed: false,
        sealRecovered: recovery,
        sealInterrupted: !recovery,
        pipes: {
            stdout: { end: !recovery, close: !recovery },
            stderr: { end: !recovery, close: !recovery },
        },
        readback: recovery ? null : { closed: true, failed: false },
        quitControl: recovery ? null : { closed: true, failed: false },
    };
}
function entryModel() {
    const events: string[] = [],
        timers = new Set<object>(),
        fixtureResult = {},
        pausedOwner = {},
        recoveredOwner = {};
    const state = {
        oldLate: false,
        copiesChanged: false,
        recordChanged: false,
        expired: false,
        recoveryStatus: 'previous-generation-seal-recovered',
        spawned: false,
        failRecovery: false,
        failure: undefined as unknown,
        failWriter: false,
        cancel: false,
        review: null as null | (() => Promise<any>),
    };
    let preparationRaw: Buffer | null = null,
        recoveryRaw: Buffer | null = null,
        preparations = 0,
        recoveries = 0;
    const processPort: any = {
        platform: 'linux',
        arch: 'x64',
        getuid: () => 1000,
        geteuid: () => 1000,
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write() {} },
        env: { DISPLAY: ':99' },
        argv: ['node'],
    };
    const context = {
        host: { version: '0.6.0', sourceRoot: '/model/envelope-b' },
        root: '/model/installed',
        dataHome: '/model/data',
        sourceCommit: 'a'.repeat(40),
        runId: '1',
        runAttempt: '1',
        copies: { unitOnly: true },
        records: { unitOnly: true },
        revalidateCopies() {
            events.push('copies');
            if (state.copiesChanged || state.expired) throw Error('memory copies or deadline');
        },
        writeSealPreparationRecord(raw: Buffer) {
            events.push('preparation-record');
            preparationRaw = Buffer.from(raw);
            return {
                path: '/model/records/seal-preparation.json',
                bytes: raw.length,
                sha256: 'b'.repeat(64),
            };
        },
        revalidateSealPreparationRecord() {
            events.push('preparation-readback');
            assert.ok(preparationRaw);
            if (state.recordChanged || state.expired)
                throw Error('memory changed preparation or deadline');
            return {
                path: '/model/records/seal-preparation.json',
                bytes: preparationRaw!.length,
                sha256: 'b'.repeat(64),
                profileSHA256: 'c'.repeat(64),
            };
        },
        writeSealRecoveryRecord(raw: Buffer) {
            events.push('recovery-record');
            assert.equal(recoveryRaw, null);
            recoveryRaw = Buffer.from(raw);
            if (state.failWriter) throw state.failure;
            return {
                path: '/model/records/seal-recovery.json',
                bytes: raw.length,
                sha256: 'd'.repeat(64),
            };
        },
    };
    const diagnostics = (owner: object) => {
        if (owner === pausedOwner)
            return {
                phase: 'fixture-paused',
                primarySet: false,
                native: { failed: false, retainedFDs: 0 },
                backend: { backend: closedBackend() },
                launch: state.oldLate ? { ...summary(), verdict: 'RETAINED_UNKNOWN' } : summary(),
            };
        assert.equal(owner, recoveredOwner);
        return {
            phase: state.cancel ? 'cancelled' : 'finished',
            primarySet: false,
            native: { failed: false, retainedFDs: 0 },
            backend: { backend: closedBackend() },
            ...(state.cancel ? {} : { launch: { ...summary(true), spawned: state.spawned } }),
        };
    };
    const modules = new Map<string, any>([
        ['node:path', path],
        ['node:url', { fileURLToPath }],
        [
            './linux-owned-installation-fixture.ts',
            {
                async runLinuxOwnedInstallationFixture(args: string[]) {
                    events.push('current-b');
                    assert.equal(args.at(-1), 'current-b');
                    preparations++;
                    return fixtureResult;
                },
                getLinuxOwnedCurrentBFixtureContext(value: unknown) {
                    assert.equal(value, fixtureResult);
                    return context;
                },
            },
        ],
        [
            '../electron/linux-permanent-setup.ts',
            {
                linuxPermanentArguments(args: string[]) {
                    assert.deepEqual(Array.from(args), [
                        '--install-directory',
                        context.root,
                        '--version',
                        '0.6.0',
                        '--operation',
                        'finalize',
                        '--terminal',
                        '--no-menu',
                    ]);
                    return { capturedArgs: args };
                },
                async runLinuxPermanentOwnedFixture(
                    _host: unknown,
                    _choices: unknown,
                    _data: unknown,
                    _prompts: unknown,
                    _desktop: unknown,
                    mode: string,
                ) {
                    events.push('pause-product');
                    assert.equal(mode, 'seal-preparation');
                    return {
                        status: 'fixture-seal-preparation-paused',
                        owner: pausedOwner,
                        result: summary(),
                        interruption: { unitOnly: true },
                    };
                },
                async runLinuxPermanentSealRecoveryFixture(
                    host: unknown,
                    choices: unknown,
                    data: unknown,
                    prompts: any,
                    desktop: any,
                    owner: object,
                ) {
                    events.push('recovery-product');
                    recoveries++;
                    assert.equal(host, context.host);
                    assert.ok(choices);
                    assert.equal(data, context.dataHome);
                    assert.equal(owner, pausedOwner);
                    assert.equal(desktop.DISPLAY, ':99');
                    const reply = await prompts.terminal.review({
                        detail: 'memory restricted ordinary recovery review',
                        menu: false,
                        confirmation: 'apply',
                        deadlineMs: 200,
                    });
                    if (state.failRecovery) throw state.failure;
                    assert.equal(reply.status, state.cancel ? 'cancelled' : 'confirmed');
                    return {
                        status: state.cancel ? 'cancelled' : state.recoveryStatus,
                        owner: recoveredOwner,
                        result: summary(true),
                    };
                },
                linuxPermanentSetupDiagnostics: diagnostics,
            },
        ],
        [
            '../electron/linux-setup-prompts.ts',
            {
                linuxTerminalPrompt() {
                    return {
                        hasPending: () => false,
                        review: async () => {
                            events.push('real-terminal');
                            return state.review
                                ? state.review()
                                : { status: state.cancel ? 'cancelled' : 'confirmed', menu: false };
                        },
                    };
                },
            },
        ],
    ]);
    const module = { exports: {} as any };
    new vm.Script(entryCode).runInContext(
        vm.createContext(
            {
                module,
                exports: module.exports,
                Buffer,
                Object,
                JSON,
                WeakMap,
                Set,
                process: processPort,
                performance: { now: () => 100 },
                setInterval: () => {
                    const timer = {};
                    timers.add(timer);
                    return timer;
                },
                require(name: string) {
                    assert.ok(modules.has(name), 'Closed entry import');
                    return modules.get(name);
                },
            },
            { codeGeneration: { strings: false, wasm: false } },
        ),
        { timeout: 1000 },
    );
    assert.equal(events.length, 0);
    return {
        api: module.exports,
        state,
        processPort,
        events,
        timers,
        prepare: () =>
            module.exports.runLinuxOwnedSealPreparationFixture(['--a-appdir', '/model/a']),
        recover: (value: unknown) => module.exports.runLinuxOwnedSealRecoveryFixture(value),
        preparation: () => preparationRaw,
        recovery: () => recoveryRaw,
        preparations: () => preparations,
        recoveries: () => recoveries,
    };
}

// Reuse only the existing inert memory-fixture construction prefix, never its test registrations.
// Its old source-pin assertion belongs to that older test, not this changed-source projection.
const helperTree = ts.createSourceFile(
        'fixed-current-b-memory.ts',
        helperSource,
        ts.ScriptTarget.ES2022,
        true,
    ),
    firstTest = helperTree.statements.findIndex(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'test',
    );
assert.ok(firstTest > 0);
let metaReplacements = 0;
const transformed = ts.transform(helperTree, [
    (context) => (node) => {
        const visit: ts.Visitor = (value) => {
            if (
                ts.isPropertyAccessExpression(value) &&
                value.name.text === 'url' &&
                ts.isMetaProperty(value.expression) &&
                value.expression.keywordToken === ts.SyntaxKind.ImportKeyword
            ) {
                metaReplacements++;
                return ts.factory.createStringLiteral(helperURL.href);
            }
            return ts.visitEachChild(value, visit, context);
        };
        return ts.visitNode(node, visit) as ts.SourceFile;
    },
]);
assert.equal(
    metaReplacements,
    1,
    'Only the real source URL expression is rebound; quoted projection tokens stay intact.',
);
const projectedTree = transformed.transformed[0],
    printer = ts.createPrinter();
const prefix = projectedTree.statements
    .slice(0, firstTest)
    .filter((node) => {
        if (ts.isImportDeclaration(node)) return false;
        return !(
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isPropertyAccessExpression(node.expression.expression) &&
            node.expression.expression.name.text === 'equal' &&
            ts.isCallExpression(node.expression.arguments[0]) &&
            node.expression.arguments[0].expression.getText(helperTree) === 'sha' &&
            node.expression.arguments[0].arguments[0]?.getText(helperTree) === 'text'
        );
    })
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, projectedTree))
    .join('\n');
transformed.dispose();
const installTree = ts.createSourceFile(
        'actual-installation.ts',
        installSource,
        ts.ScriptTarget.ES2022,
        true,
    ),
    parserNodes = ['need', 'normal', 'linuxOwnedFixtureArguments'].map((name) => {
        const nodes = installTree.statements.filter((node) =>
            ts.isFunctionDeclaration(node)
                ? node.name?.text === name
                : ts.isVariableStatement(node) &&
                  node.declarationList.declarations.some(
                      (item) => ts.isIdentifier(item.name) && item.name.text === name,
                  ),
        );
        assert.equal(nodes.length, 1);
        return nodes[0].getText(installTree);
    });
const parserModule = { exports: {} as any };
new vm.Script(
    compile(parserNodes.join('\n') + '\nmodule.exports=linuxOwnedFixtureArguments;'),
).runInContext(
    vm.createContext(
        {
            module: parserModule,
            exports: parserModule.exports,
            Object,
            Set,
            path,
            fixtureArguments: fixtureRecords.fixtureArguments,
        },
        { codeGeneration: { strings: false, wasm: false } },
    ),
);
const memoryContext = vm.createContext(
    {
        assert,
        Buffer,
        Object,
        JSON,
        Set,
        Map,
        Promise,
        URL,
        structuredClone,
        utilTypes,
        path,
        vm,
        ts,
        createHash,
        fixtureRecords,
        fileURLToPath,
        readFileSync(url: URL, encoding: string) {
            assert.equal(url.href, installURL.href);
            assert.equal(encoding, 'utf8');
            return installSource;
        },
        linuxOwnedFixtureArguments: parserModule.exports,
    },
    { codeGeneration: { strings: false, wasm: false } },
);
new vm.Script(compile(prefix + '\nglobalThis.currentBMemory = model;')).runInContext(
    memoryContext,
    { timeout: 1000 },
);
function contextModel() {
    const m = (memoryContext as any).currentBMemory('current-b');
    Object.assign(m.state, {
        sealRecoveryRecordAttempted: false,
        sealRecoveryRecordUnsettled: false,
        sealRecoveryRecordOriginal: null,
        sealRecoveryProfile: null,
    });
    return m;
}

test('default preparation stays separate while actual paused continuation reaches ordinary no-launch recovery once', async () => {
    const m = entryModel(),
        prepared = await m.prepare();
    assert.equal(prepared.status, 'cooperative-seal-preparing-paused');
    assert.equal(m.recoveries(), 0);
    const recovered = await m.recover(prepared);
    assert.equal(recovered.status, 'cooperative-seal-recovered');
    assert.equal(recovered.applicationLaunched, false);
    assert.equal(recovered.releaseAcceptance, false);
    assert.equal(m.preparations(), 1);
    assert.equal(m.recoveries(), 1);
    const record = JSON.parse(m.recovery()!.toString());
    assert.equal(record.product.status, 'previous-generation-seal-recovered');
    assert.equal(record.custody.launch.verdict, 'SEAL_RECOVERED_NO_LAUNCH');
    assert.ok(m.events.indexOf('preparation-record') < m.events.indexOf('recovery-product'));
    assert.ok(m.events.indexOf('recovery-product') < m.events.indexOf('recovery-record'));
    assert.equal(m.timers.size, 0);
    assert.equal(m.api.inspect().length, 0);
    await assert.rejects(m.recover(prepared), /CONSUMED/);
    assert.equal(m.recoveries(), 1);
});

test('plain foreign serialized and concurrent reused results cannot reenter or rerun preparation', async () => {
    const m = entryModel(),
        other = entryModel(),
        prepared = await m.prepare();
    for (const value of [
        {},
        JSON.parse(JSON.stringify(prepared)),
        new Proxy(prepared, {}),
        await other.prepare(),
    ])
        await assert.rejects(m.recover(value), /PAUSED_RESULT_REQUIRED/);
    assert.equal(m.recoveries(), 0);
    let release!: (value: unknown) => void, entered!: () => void;
    const gate = new Promise<any>((resolve) => {
            release = resolve;
        }),
        seen = new Promise<void>((resolve) => {
            entered = resolve;
        });
    m.state.cancel = true;
    m.state.review = async () => {
        entered();
        return gate;
    };
    const running = m.recover(prepared);
    await seen;
    await assert.rejects(m.recover(prepared), /CONSUMED/);
    release({ status: 'cancelled' });
    assert.equal((await running).status, 'cancelled');
    assert.equal(m.recovery(), null);
    assert.equal(m.preparations(), 1);
    assert.equal(m.recoveries(), 1);
    assert.equal(m.timers.size, 0);
});

test('changed original owner copies record or nonrecovery product result remains nonpassing without a recovery record', async () => {
    for (const mode of ['owner', 'copies', 'record', 'deadline', 'spawned', 'wrong-status']) {
        const m = entryModel(),
            prepared = await m.prepare();
        if (mode === 'owner') m.state.oldLate = true;
        if (mode === 'copies') m.state.copiesChanged = true;
        if (mode === 'record') m.state.recordChanged = true;
        if (mode === 'deadline') m.state.expired = true;
        if (mode === 'spawned') m.state.spawned = true;
        if (mode === 'wrong-status')
            m.state.recoveryStatus = 'previous-generation-already-finalized';
        assert.equal((await m.recover(prepared)).status, 'retained-nonpassing', mode);
        assert.equal(m.recovery(), null);
        assert.equal(m.timers.size, 1);
        if (['owner', 'copies', 'record', 'deadline'].includes(mode))
            assert.equal(m.recoveries(), 0);
        await assert.rejects(m.recover(prepared), /CONSUMED/);
    }
});

test('late owner failure and falsey product or fixed-writer failure retain custody and cannot be retried', async () => {
    for (const mode of ['late-owner', 'product', 'writer']) {
        const m = entryModel(),
            prepared = await m.prepare();
        if (mode === 'late-owner')
            m.state.review = async () => {
                m.state.oldLate = true;
                return { status: 'confirmed', menu: false };
            };
        if (mode === 'product') m.state.failRecovery = true;
        if (mode === 'writer') m.state.failWriter = true;
        assert.equal((await m.recover(prepared)).status, 'retained-nonpassing');
        const owner = m.api.inspect()[0];
        assert.equal(owner.primarySet, true);
        if (mode !== 'late-owner') assert.equal(owner.primary, undefined);
        assert.equal(m.timers.size, 1);
        if (mode !== 'writer') assert.equal(m.recovery(), null);
        await assert.rejects(m.recover(prepared), /CONSUMED/);
    }
});

test('actual context recovery writer retains its original preparation copies profile and nine-minute gate', async () => {
    const m = contextModel(),
        context = m.getContext(await m.run()),
        raw = Buffer.from('authored memory preparation record');
    context.writeSealPreparationRecord(raw);
    const original = context.revalidateSealPreparationRecord();
    const record = context.writeSealRecoveryRecord(Buffer.from('authored memory recovery record'));
    assert.equal(record.path, m.root + '/records/seal-recovery.json');
    assert.deepEqual(m.fileMap.get(m.root + '/records/seal-preparation.json'), raw);
    assert.equal(context.revalidateSealPreparationRecord().profileSHA256, original.profileSHA256);
    assert.equal(m.state.sealRecoveryRecordUnsettled, false);
    assert.throws(() => context.writeSealRecoveryRecord(Buffer.from('retry')));
    const late = contextModel(),
        lateContext = late.getContext(await late.run());
    lateContext.writeSealPreparationRecord(raw);
    late.setNow(9 * 60000);
    assert.throws(() => lateContext.revalidateSealPreparationRecord());
    assert.equal(late.writes.includes('records/seal-recovery.json'), false);
});

test('actual context refuses changed originals or profile and retains an uncertain one-use recovery write', async () => {
    for (const mode of ['record', 'copy', 'profile', 'write-ack']) {
        const m = contextModel(),
            context = m.getContext(await m.run()),
            raw = Buffer.from('memory preparation');
        context.writeSealPreparationRecord(raw);
        context.revalidateSealPreparationRecord();
        if (mode === 'record')
            m.fileMap.set(m.root + '/records/seal-preparation.json', Buffer.from('changed'));
        if (mode === 'copy') m.fileMap.set(m.inputOriginals[0].archivePath, Buffer.from('changed'));
        if (mode === 'profile')
            m.fileMap.set(m.appData + '/profile-marker', Buffer.from('changed'));
        if (mode === 'write-ack') {
            const set = m.fileMap.set.bind(m.fileMap);
            m.fileMap.set = (name: string, value: Buffer) => {
                set(name, value);
                if (name === m.root + '/records/seal-recovery.json') {
                    m.state.fds.add(99);
                    throw undefined;
                }
                return m.fileMap;
            };
        }
        let failed = false;
        try {
            context.writeSealRecoveryRecord(Buffer.from('memory recovery'));
        } catch (error) {
            failed = true;
            if (mode === 'write-ack') assert.equal(error, undefined);
        }
        assert.equal(failed, true, mode);
        assert.equal(m.state.sealRecoveryRecordAttempted, true);
        const writes = m.writes.length;
        assert.throws(() => context.writeSealRecoveryRecord(Buffer.from('retry')));
        assert.equal(m.writes.length, writes);
        if (mode === 'write-ack') {
            assert.equal(m.state.sealRecoveryRecordUnsettled, true);
            assert.equal(m.state.fds.has(99), true);
            assert.equal(m.state.first, undefined);
        }
    }
});
