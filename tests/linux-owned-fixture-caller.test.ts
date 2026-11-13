// Actual full caller under explicit memory ports. These four groups never load a
// native host, create a child/socket, mutate physical files or qualify a runtime.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as installation from '../shared/installation.ts';
import { linuxModelReviewSHA256 } from '../electron/linux-transaction-model.ts';

const source = readFileSync(
    new URL('../electron/linux-permanent-setup.ts', import.meta.url),
    'utf8',
);
const tree = ts.createSourceFile(
    'actual-linux-permanent-fixture.ts',
    source,
    ts.ScriptTarget.ES2022,
    true,
);
assert.equal(
    (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
const compiled = ts.transpileModule(source, {
    fileName: 'actual-linux-permanent-fixture.ts',
    reportDiagnostics: true,
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
});
assert.equal(
    (compiled.diagnostics ?? []).filter((x) => x.category === ts.DiagnosticCategory.Error).length,
    0,
);
const script = new vm.Script(compiled.outputText, {
    filename: 'actual-linux-permanent-fixture.cjs',
});

const maintenanceSource = ts.createSourceFile(
    'actual-linux-maintenance.ts',
    readFileSync(new URL('../electron/installation-maintenance.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
);
const payloadDeclarations = maintenanceSource.statements
    .flatMap((node) => (ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []))
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'SETUP_PAYLOAD');
assert.equal(payloadDeclarations.length, 1);
const payloadLiteral = payloadDeclarations[0].initializer;
assert.ok(payloadLiteral && ts.isStringLiteral(payloadLiteral));
const SETUP_PAYLOAD = payloadLiteral.text;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
async function promptReached(f: ReturnType<typeof memoryCaller>, running: Promise<any>) {
    const reached = await Promise.race([
        f.state.enteredPrompt.promise.then(() => true),
        running.then(() => false),
    ]);
    assert.equal(reached, true, 'Actual caller settled before the memory prompt milestone.');
}

function memoryCaller(operation: 'launch' | 'finalize' = 'launch') {
    const host = {
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        euid: 1000,
        home: '/memory/home',
        appData: '/memory/data',
        sourceRoot: '/memory/source',
        version: '0.6.0',
    };
    const choices = {
        root: '/memory/root',
        menu: false,
        menuExplicit: true,
        terminal: true,
        version: '0.6.0',
        operation,
    };
    const manifest = installation.validateInstallationManifest({
        schemaVersion: 1,
        product: installation.INSTALLATION_PRODUCT,
        layout: 'linux-folder',
        platform: 'linux',
        arch: 'x64',
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'app/diagnostic-hub',
        files: [
            {
                kind: 'file',
                path: 'app/diagnostic-hub',
                bytes: 7,
                sha256: createHash('sha256').update('memory!').digest('hex'),
            },
        ],
    });
    const review = {
        marker: 'same',
        journal: { phase: 'active' },
        history: null,
        source: { verifiedManifestSHA256: 'b'.repeat(64) },
        root: { profile: '/memory/profile' },
    };
    const state = {
        events: [] as string[],
        reads: 0,
        inspected: 0,
        config: null as any,
        plan: null as any,
        reply: { status: 'confirmed', menu: false } as any,
        promptGate: null as ReturnType<typeof deferred<any>> | null,
        enteredPrompt: deferred<void>(),
        changedReview: false,
        quitBindings: [] as any[],
        quitSelections: [] as object[],
        sealSelections: [] as object[],
        launches: [] as any[][],
        selection: null as object | null,
        interruptionReads: 0,
        interruptionObservation: Object.freeze({ memoryOnly: true, notNativeEvidence: true }),
        returned: {
            verdict: 'DIRECT_CHILD_CLOSED_RETAINED',
            nativeQualified: false,
            releaseAcceptance: false,
        } as any,
        launchFailureSet: false,
        launchFailure: undefined as unknown,
    };
    // Observe the real private WeakMap semantics without changing admission. The
    // captured one-use key exists only in this VM test, never in product exports.
    class ObservedWeakMap extends WeakMap<object, unknown> {
        override set(key: object, value: unknown) {
            if (value === 'normal-quit' || value === 'seal-preparation') state.selection = key;
            return super.set(key, value);
        }
    }
    const operations = Object.freeze({ memoryOnly: true });
    const nativeOwner = Object.freeze({ memoryOnly: true });
    const processHost = Object.freeze({ memoryOnly: true });
    const modules = new Map<string, unknown>([
        ['node:path', path],
        ['../shared/installation.ts', installation],
        ['./installation-maintenance.ts', { SETUP_PAYLOAD }],
        [
            './linux-setup-review.ts',
            {
                linuxReviewDisk: {
                    async bytes(file: string, maximum: number, uid: number) {
                        state.events.push('source');
                        state.reads++;
                        assert.equal(file, host.sourceRoot + '/' + SETUP_PAYLOAD);
                        assert.equal(uid, host.uid);
                        const bytes = Buffer.from(JSON.stringify(manifest));
                        assert.ok(bytes.length <= maximum);
                        return bytes;
                    },
                },
            },
        ],
        [
            './linux-setup-ui.ts',
            {
                linuxReviewArguments() {
                    throw Error('UNEXPECTED_ARGUMENT_PORT');
                },
            },
        ],
        [
            './linux-native-host.ts',
            {
                async createLinuxNativeHost(root: string, actual: unknown) {
                    state.events.push('native-memory-port');
                    assert.equal(root, host.sourceRoot);
                    assert.deepEqual(actual, manifest);
                    return {
                        operations,
                        owner: nativeOwner,
                        diagnostics: () => ({ memoryOnly: true, loaded: false }),
                    };
                },
                linuxNativeHostFailureCustody: () => null,
            },
        ],
        [
            './linux-native-driver.ts',
            {
                prepareLinuxNativeDriver(config: any, deadline: any, ops: unknown, owner: unknown) {
                    state.events.push('prepare');
                    state.config = config;
                    assert.equal(ops, operations);
                    assert.equal(owner, nativeOwner);
                    assert.deepEqual(plain(deadline), { startedMs: 100, deadlineMs: 120100 });
                    return {
                        async inspect() {
                            state.events.push('inspect-' + ++state.inspected);
                            return state.inspected === 2 && state.changedReview
                                ? { ...review, marker: 'changed' }
                                : review;
                        },
                        describe: () => 'memory review only',
                        menuSelected: () => false,
                        plan(fresh: unknown, menu: boolean) {
                            state.events.push('plan');
                            assert.equal(fresh, review);
                            assert.equal(menu, false);
                            return (state.plan = {
                                root: config.root,
                                host: config.host,
                                review: fresh,
                                installationId: '11111111-1111-4111-8111-111111111111',
                                transactionId: '22222222-2222-4222-8222-222222222222',
                            });
                        },
                        run() {
                            throw Error('UNEXPECTED_TRANSACTION_PORT');
                        },
                        diagnostics: () => ({ memoryOnly: true }),
                    };
                },
                prepareLinuxNativeUninstallDriver() {
                    throw Error('UNEXPECTED_UNINSTALL_PORT');
                },
            },
        ],
        ['./linux-transaction-model.ts', { linuxModelReviewSHA256 }],
        [
            './linux-setup-readback.ts',
            {
                createLinuxOwnedQuitSelection(binding: any) {
                    state.events.push('quit-selection');
                    state.quitBindings.push(binding);
                    const selection = Object.freeze({ memoryOnlyQuit: true });
                    state.quitSelections.push(selection);
                    return selection;
                },
            },
        ],
        [
            './linux-native-backend.ts',
            {
                createLinuxSealInterruptionSelection() {
                    state.events.push('seal-selection');
                    const selection = Object.freeze({ memoryOnlySeal: true });
                    state.sealSelections.push(selection);
                    return selection;
                },
            },
        ],
        [
            './linux-owned-launch.ts',
            {
                createLinuxNativeLaunchProcessHost() {
                    state.events.push('process-memory-port');
                    return processHost;
                },
                createLinuxOwnedLaunch(...args: any[]) {
                    state.events.push('launch-construction');
                    state.launches.push(args);
                    return {
                        async run() {
                            state.events.push('launch-run');
                            if (state.launchFailureSet) throw state.launchFailure;
                            return state.returned;
                        },
                        summary: () => ({ memoryOnly: true, qualified: false }),
                        sealInterruptionObservation() {
                            state.events.push('interruption-readback');
                            state.interruptionReads++;
                            return state.interruptionObservation;
                        },
                    };
                },
            },
        ],
    ]);
    for (const node of tree.statements)
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
            assert.ok(
                ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
                'Unadmitted caller import.',
            );
    const module = { exports: {} as any };
    script.runInContext(
        vm.createContext(
            {
                module,
                exports: module.exports,
                Object,
                JSON,
                Map,
                Set,
                WeakMap: ObservedWeakMap,
                Buffer,
                Error,
                Promise,
                TextDecoder,
                structuredClone,
                require(name: string) {
                    assert.ok(modules.has(name), 'Unadmitted memory import.');
                    return modules.get(name);
                },
            },
            { codeGeneration: { strings: false, wasm: false } },
        ),
        { timeout: 1000 },
    );
    const prompts = {
        now: () => 100,
        gui: {
            review() {
                throw Error('UNEXPECTED_GUI_PORT');
            },
        },
        terminal: {
            async review(request: any) {
                state.events.push('prompt');
                assert.equal(request.confirmation, 'apply');
                assert.equal(request.menu, false);
                state.enteredPrompt.resolve();
                const reply = state.promptGate ? await state.promptGate.promise : state.reply;
                state.events.push('consent-returned');
                return reply;
            },
        },
    };
    const api = module.exports;
    const args = (selected: any = choices) => [
        host,
        selected,
        '/memory/data',
        prompts,
        { DISPLAY: ':memory' },
    ];
    return {
        api,
        host,
        choices,
        state,
        operations,
        nativeOwner,
        processHost,
        review,
        ordinary: (selection?: unknown, selected?: any) =>
            api.runLinuxPermanentSetup(...args(selected), selection),
        owned: (
            mode: unknown = operation === 'launch' ? 'normal-quit' : 'seal-preparation',
            selected?: any,
        ) => api.runLinuxPermanentOwnedFixture(...args(selected), mode),
    };
}

test('memory caller refuses invalid/plain or consumed fixture selections before any source or native IO', async () => {
    for (const selection of [{}, Object.freeze({ mode: 'normal-quit' }), null, 'normal-quit']) {
        const f = memoryCaller();
        await assert.rejects(f.ordinary(selection), /LINUX_OWNED_FIXTURE_SELECTION/);
        assert.deepEqual(f.state.events, []);
    }
    for (const [mode, changes] of [
        ['unknown', {}],
        ['seal-preparation', {}],
        ['normal-quit', { menu: true }],
        ['normal-quit', { terminal: false }],
    ] as const) {
        const f = memoryCaller();
        assert.throws(
            () => f.owned(mode, { ...f.choices, ...changes }),
            /LINUX_OWNED_FIXTURE_SELECTION/,
        );
        assert.deepEqual(f.state.events, []);
    }
    const f = memoryCaller();
    f.state.promptGate = deferred<any>();
    const running = f.owned();
    await promptReached(f, running);
    assert.ok(f.state.selection);
    const count = f.state.events.length;
    await assert.rejects(f.ordinary(f.state.selection), /LINUX_OWNED_FIXTURE_SELECTION/);
    assert.equal(f.state.events.length, count);
    f.state.promptGate.resolve({ status: 'cancelled' });
    assert.equal((await running).status, 'cancelled');
});

test('memory caller cancellation or changed fresh review cannot mint quit/seal authority or launch', async () => {
    for (const operation of ['launch', 'finalize'] as const) {
        const cancelled = memoryCaller(operation);
        cancelled.state.reply = { status: 'cancelled' };
        assert.equal((await cancelled.owned()).status, 'cancelled');
        assert.equal(cancelled.state.inspected, 1);
        assert.equal(
            cancelled.state.quitSelections.length + cancelled.state.sealSelections.length,
            0,
        );
        assert.equal(cancelled.state.launches.length, 0);
        const changed = memoryCaller(operation);
        changed.state.changedReview = true;
        const result = await changed.owned();
        assert.equal(result.status, 'retained-unknown');
        assert.equal(changed.api.linuxPermanentSetupDiagnostics(result.owner).primarySet, true);
        assert.equal(changed.state.inspected, 2);
        assert.equal(changed.state.quitSelections.length + changed.state.sealSelections.length, 0);
        assert.equal(changed.state.launches.length, 0);
    }
});

test('memory caller snapshots the selected operation and mints exact bound selectors only after fresh consent', async () => {
    const f = memoryCaller();
    let reads = 0;
    const aliased: any = { ...f.choices };
    Object.defineProperty(aliased, 'operation', {
        enumerable: true,
        get: () => (++reads === 1 ? 'launch' : 'finalize'),
    });
    f.state.promptGate = deferred<any>();
    const running = f.owned('normal-quit', aliased);
    await promptReached(f, running);
    assert.equal(reads, 1);
    aliased.root = '/memory/changed';
    assert.equal(f.state.config.action, 'launch');
    assert.equal(f.state.quitSelections.length + f.state.sealSelections.length, 0);
    f.state.promptGate.resolve({ status: 'confirmed', menu: false });
    const result = await running;
    assert.equal(result.status, 'launch');
    assert.equal(result.result, f.state.returned);
    assert.equal(f.state.interruptionReads, 0);
    assert.deepEqual(plain(f.state.quitBindings), [
        {
            root: '/memory/root',
            installationId: f.state.plan.installationId,
            transactionId: f.state.plan.transactionId,
            manifestSHA256: 'b'.repeat(64),
            version: '0.6.0',
            profile: '/memory/profile',
            executable: '/memory/root/app/diagnostic-hub',
            uid: 1000,
        },
    ]);
    assert.equal(f.state.sealSelections.length, 0);
    const args = f.state.launches[0];
    assert.equal(args[0], f.state.plan);
    assert.equal(args[3], f.operations);
    assert.equal(args[4], f.processHost);
    assert.equal(args[5], true);
    assert.equal(args[6], f.state.quitSelections[0]);
    assert.equal(args[7], undefined);
    assert.ok(f.state.events.indexOf('consent-returned') < f.state.events.indexOf('inspect-2'));
    assert.ok(f.state.events.indexOf('inspect-2') < f.state.events.indexOf('quit-selection'));
    assert.ok(f.state.events.indexOf('quit-selection') < f.state.events.indexOf('launch-run'));
});

test('memory caller keeps paused/nonfinalized and falsey/uncertain outcomes distinct without changing ordinary launch', async () => {
    const paused = memoryCaller('finalize');
    paused.state.returned = {
        verdict: 'SEAL_PREPARATION_PAUSED',
        initialConfirmed: false,
        retainedConfirmed: false,
        sealRecovered: false,
        nativeQualified: false,
    };
    const result = await paused.owned();
    assert.equal(result.status, 'fixture-seal-preparation-paused');
    assert.equal(result.releaseAcceptance, false);
    assert.equal(result.result, paused.state.returned);
    assert.equal(result.interruption, paused.state.interruptionObservation);
    assert.equal(paused.state.interruptionReads, 1);
    assert.ok(
        paused.state.events.indexOf('launch-run') <
            paused.state.events.indexOf('interruption-readback'),
    );
    assert.equal(paused.api.linuxPermanentSetupDiagnostics(result.owner).phase, 'fixture-paused');
    assert.equal(paused.state.launches[0][6], paused.state.quitSelections[0]);
    assert.equal(paused.state.launches[0][7], paused.state.sealSelections[0]);
    for (const failure of [undefined, null, false, 0, '']) {
        const f = memoryCaller('finalize');
        f.state.launchFailureSet = true;
        f.state.launchFailure = failure;
        const failed = await f.owned();
        assert.equal(failed.status, 'retained-unknown');
        const diagnostics = f.api.linuxPermanentSetupDiagnostics(failed.owner);
        assert.equal(diagnostics.primarySet, true);
        assert.equal(diagnostics.phase, 'retained-unknown');
        assert.equal(f.state.events.filter((x) => x === 'launch-run').length, 1);
        assert.equal(f.state.interruptionReads, 0);
    }
    const uncertain = memoryCaller('finalize');
    uncertain.state.returned = {
        verdict: 'RETAINED_UNKNOWN',
        initialConfirmed: false,
        retainedConfirmed: false,
    };
    assert.equal((await uncertain.owned()).status, 'retained-unknown');
    assert.equal(uncertain.state.interruptionReads, 0);
    const ordinary = memoryCaller();
    const ordinaryResult = await ordinary.ordinary();
    assert.equal(ordinaryResult.status, 'launch');
    assert.equal(ordinaryResult.result, ordinary.state.returned);
    assert.equal(ordinary.state.selection, null);
    assert.equal(ordinary.state.quitSelections.length + ordinary.state.sealSelections.length, 0);
    assert.equal(ordinary.state.launches[0][6], undefined);
    assert.equal(ordinary.state.launches[0][7], undefined);
    assert.equal(ordinary.state.launches[0][5], true);
    assert.equal(ordinary.state.interruptionReads, 0);
    const ordinaryFinalize = memoryCaller('finalize');
    ordinaryFinalize.state.returned = {
        verdict: 'SEAL_PREPARATION_PAUSED',
        initialConfirmed: false,
        retainedConfirmed: false,
    };
    assert.equal((await ordinaryFinalize.ordinary()).status, 'refused');
    assert.equal(
        ordinaryFinalize.state.quitSelections.length + ordinaryFinalize.state.sealSelections.length,
        0,
    );
    assert.equal(ordinaryFinalize.state.interruptionReads, 0);
});
