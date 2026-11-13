/** Actual full caller with closed memory ports. No native host, process, socket,
 * physical mutation, installer, recovery operation or release evidence is created. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as installation from '../shared/installation.ts';
import { linuxModelReviewSHA256 } from '../electron/linux-transaction-model.ts';

const root = new URL('../', import.meta.url),
    source = readFileSync(new URL('electron/linux-permanent-setup.ts', root), 'utf8'),
    tree = ts.createSourceFile(
        'actual-seal-recovery-caller.ts',
        source,
        ts.ScriptTarget.ES2022,
        true,
    );
assert.equal(
    (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
const compiled = ts.transpileModule(source, {
    fileName: 'actual-seal-recovery-caller.ts',
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
const script = new vm.Script(compiled.outputText, {
    filename: 'actual-seal-recovery-caller.memory.cjs',
});
const maintenance = ts.createSourceFile(
    'fixed-maintenance.ts',
    readFileSync(new URL('electron/installation-maintenance.ts', root), 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
);
const declarations = maintenance.statements
    .flatMap((node) => (ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []))
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'SETUP_PAYLOAD');
assert.equal(declarations.length, 1);
const payloadLiteral = declarations[0].initializer;
assert.ok(payloadLiteral && ts.isStringLiteral(payloadLiteral));
const SETUP_PAYLOAD = payloadLiteral.text;
const clone = <T>(value: T): T => structuredClone(value),
    hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function backendHealth() {
    return {
        failed: false,
        pending: null as string | null,
        retainedFDs: 0,
        retainedDirs: 0,
        retainedServers: 0,
        retainedSockets: 0,
        retainedTimers: 0,
    };
}
function memoryCaller(normalFinalize = false) {
    const host = {
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        euid: 1000,
        home: '/memory/home',
        appData: '/memory/home/config',
        sourceRoot: '/memory/home/source',
        version: '0.6.0',
    };
    const choices = {
        root: '/memory/home/root',
        version: host.version,
        operation: 'finalize',
        menu: false,
        menuExplicit: true,
        terminal: true,
    };
    const manifest = installation.validateInstallationManifest({
        schemaVersion: 1,
        product: installation.INSTALLATION_PRODUCT,
        layout: 'linux-folder',
        platform: 'linux',
        arch: 'x64',
        version: host.version,
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'app/diagnostic-hub',
        files: [{ kind: 'file', path: 'app/diagnostic-hub', bytes: 7, sha256: hash('memory!') }],
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest)),
        manifestSHA256 = hash(manifestBytes),
        previousManifest = { ...manifest, version: '0.5.0', sourceCommit: 'b'.repeat(40) },
        previousSHA256 = hash(JSON.stringify(previousManifest)),
        installationId = '11111111-1111-4111-8111-111111111111',
        previousTX = '22222222-2222-4222-8222-222222222222',
        currentTX = '33333333-3333-4333-8333-333333333333',
        profile = host.appData + '/profile',
        identity = (ino: number) => ({ dev: 1, ino, uid: host.uid }),
        owner = { pid: 777, startTicks: '10001', executable: host.sourceRoot + '/setup-helper' };
    const previous = {
            identity: identity(21),
            manifest: previousManifest,
            verifiedManifestSHA256: previousSHA256,
            installationId,
            transactionId: previousTX,
            root: choices.root,
            profile,
        },
        current = {
            identity: identity(22),
            manifest,
            verifiedManifestSHA256: manifestSHA256,
            installationId,
            transactionId: currentTX,
            root: choices.root,
            profile,
        },
        oldJournal = {
            schemaVersion: 1,
            root: choices.root,
            uid: host.uid,
            transactionId: previousTX,
            installationId,
            profile,
            candidateSHA256: previousSHA256,
            previousSHA256: null,
            owner,
            phase: 'candidate-active',
        },
        journal = {
            ...oldJournal,
            transactionId: currentTX,
            candidateSHA256: manifestSHA256,
            previousSHA256,
        },
        original = (value: unknown) => {
            const bytes = Buffer.from(JSON.stringify(value));
            return { base64: bytes.toString('base64'), sha256: hash(bytes) };
        };
    const initial: any = {
        parents: [{ path: host.home, ...identity(2), mode: 0o40700 }],
        source: { identity: identity(20), manifest, verifiedManifestSHA256: manifestSHA256 },
        root: current,
        stage: null,
        previous,
        journal,
        history: {
            journalOriginal: original(journal),
            completed: { ...original(oldJournal), journal: oldJournal },
        },
        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
    };
    const configuration = {
        host,
        root: choices.root,
        action: 'finalize',
        transactionId: currentTX,
        installationId,
        owner,
    };
    const pending: any = {
        ...clone(initial),
        previous: null,
        history: {
            journalOriginal: original(journal),
            completed: null,
            cleanup: {
                configuration: clone(configuration),
                initial: clone(initial),
                snapshotSHA256: 'c'.repeat(64),
                entries: 4,
                progress: { phase: 'complete', index: 4, leaf: 'source' },
                seal: { intentSHA256: 'd'.repeat(64), state: 'preparing' },
            },
        },
    };
    const pausedSummary = {
        verdict: 'SEAL_PREPARATION_PAUSED',
        pending: null,
        childOwned: false,
        timerOwned: false,
        reservation: 'none',
        spawned: true,
        exited: true,
        closed: true,
        initialConfirmed: false,
        retainedConfirmed: false,
        sealRecovered: false,
        sealInterrupted: true,
        nativeQualified: false,
        releaseAcceptance: false,
        readback: { closed: true, failed: false },
        quitControl: { closed: true, failed: false },
    };
    const normalSummary = {
        ...pausedSummary,
        verdict: 'DIRECT_CHILD_CLOSED_RETAINED',
        code: 'DIRECT_CLOSE_NO_SUCCESSOR_AUTHORITY',
        retainedConfirmed: true,
        sealInterrupted: false,
    };
    const state = {
        events: [] as string[],
        current: clone(initial),
        inspected: 0,
        prompts: 0,
        promptRequests: [] as any[],
        reply: { status: 'confirmed', menu: false } as any,
        promptGate: null as ReturnType<typeof deferred<any>> | null,
        promptEntered: deferred<void>(),
        promptFailureSet: false,
        promptFailure: undefined as unknown,
        launchFailureSet: false,
        launchFailure: undefined as unknown,
        beforeInspect: null as ((count: number, view: any) => void) | null,
        launches: [] as any[][],
        plans: [] as any[],
        configurations: [] as any[],
        quitSelections: [] as object[],
        sealSelections: [] as object[],
        observationReads: 0,
        original: {
            summary: clone(normalFinalize ? normalSummary : pausedSummary),
            launch: { ...backendHealth(), launchPrimarySet: false },
            native: { failed: false, retainedFDs: 0 },
            preparation: backendHealth(),
        },
    };
    // These observations are supplied memory ports, not a native transcript or a
    // success credential. Only the actual caller can create its private owner key.
    const observation = {
        kind: 'cooperative-seal-preparing-pause',
        nativeQualified: false,
        releaseAcceptance: false,
        abruptInterruptionObserved: false,
        view: {
            ...clone(pending),
            activity: { root: 'active', stage: 'inactive', previous: 'inactive' },
        },
    };
    const operations = Object.freeze({ memoryOnly: true }),
        nativeOwner = Object.freeze({ memoryOnly: true }),
        processHost = Object.freeze({
            spawn() {
                throw Error('UNEXPECTED_REAL_SPAWN');
            },
        });
    let nativeCalls = 0,
        preparations = 0;
    const modules = new Map<string, unknown>([
        ['node:path', path],
        ['../shared/installation.ts', installation],
        ['./installation-maintenance.ts', { SETUP_PAYLOAD }],
        [
            './linux-setup-review.ts',
            {
                linuxReviewDisk: {
                    async bytes(file: string, cap: number, uid: number) {
                        state.events.push('source');
                        assert.equal(file, host.sourceRoot + '/' + SETUP_PAYLOAD);
                        assert.equal(uid, host.uid);
                        assert.ok(manifestBytes.length <= cap);
                        return Buffer.from(manifestBytes);
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
                async createLinuxNativeHost(sourceRoot: string, candidate: unknown) {
                    state.events.push('native-memory-port');
                    assert.equal(sourceRoot, host.sourceRoot);
                    assert.deepEqual(candidate, manifest);
                    const first = nativeCalls++ === 0;
                    return {
                        operations,
                        owner: nativeOwner,
                        diagnostics: () =>
                            first ? state.original.native : { failed: false, retainedFDs: 0 },
                    };
                },
                linuxNativeHostFailureCustody: () => null,
            },
        ],
        [
            './linux-native-driver.ts',
            {
                prepareLinuxNativeDriver(
                    config: any,
                    deadline: any,
                    ops: unknown,
                    actualOwner: unknown,
                ) {
                    state.events.push('prepare');
                    state.configurations.push(config);
                    assert.equal(ops, operations);
                    assert.equal(actualOwner, nativeOwner);
                    assert.equal(deadline.startedMs, 100);
                    assert.equal(deadline.deadlineMs, 120100);
                    const first = preparations++ === 0;
                    return {
                        async inspect() {
                            state.events.push('inspect');
                            const view = clone(state.current);
                            state.inspected++;
                            state.beforeInspect?.(state.inspected, view);
                            return view;
                        },
                        describe: () => 'Closed-memory pending seal review; no native execution.',
                        menuSelected: () => false,
                        plan(fresh: any, menu: boolean) {
                            state.events.push('plan');
                            assert.equal(menu, false);
                            const plan = {
                                host: config.host,
                                root: config.root,
                                action: config.action,
                                owner,
                                installationId,
                                transactionId: currentTX,
                                consent: true,
                                review: fresh,
                                reviewSHA256: linuxModelReviewSHA256(fresh),
                            };
                            state.plans.push(plan);
                            return plan;
                        },
                        run() {
                            throw Error('UNEXPECTED_TRANSACTION_PORT');
                        },
                        diagnostics: () => ({
                            backend: first ? state.original.preparation : backendHealth(),
                        }),
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
                    assert.equal(binding.transactionId, currentTX);
                    const selection = Object.freeze({ memoryOnly: true });
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
                    const selection = Object.freeze({ memoryOnly: true });
                    state.sealSelections.push(selection);
                    return selection;
                },
            },
        ],
        [
            './linux-owned-launch.ts',
            {
                createLinuxNativeLaunchProcessHost() {
                    state.events.push('process-port');
                    return processHost;
                },
                createLinuxOwnedLaunch(...args: any[]) {
                    state.events.push('launch-construction');
                    state.launches.push(args);
                    const first = state.launches.length === 1;
                    assert.equal(args[0].action, 'finalize');
                    assert.equal(args[3], operations);
                    assert.equal(args[4], processHost);
                    assert.equal(args[5], true);
                    if (first) {
                        assert.equal(args[6], state.quitSelections[0]);
                        assert.equal(args[7], normalFinalize ? undefined : state.sealSelections[0]);
                    } else {
                        assert.equal(args[6], undefined);
                        assert.equal(args[7], undefined);
                    }
                    return {
                        async run() {
                            state.events.push(first ? 'pause-memory-port' : 'recover-memory-port');
                            if (first) {
                                if (!normalFinalize) state.current = clone(pending);
                                return clone(state.original.summary);
                            }
                            if (state.launchFailureSet) throw state.launchFailure;
                            assert.equal(args[0].review.history.cleanup.seal.state, 'preparing');
                            return {
                                verdict: 'SEAL_RECOVERED_NO_LAUNCH',
                                sealRecovered: true,
                                initialConfirmed: false,
                                retainedConfirmed: false,
                                spawned: false,
                                childOwned: false,
                                nativeQualified: false,
                                releaseAcceptance: false,
                            };
                        },
                        summary: () =>
                            first
                                ? clone(state.original.summary)
                                : { verdict: 'SEAL_RECOVERED_NO_LAUNCH' },
                        diagnostics: () =>
                            first
                                ? clone(state.original.launch)
                                : { ...backendHealth(), launchPrimarySet: false },
                        sealInterruptionObservation() {
                            assert.equal(
                                first,
                                true,
                                'Recovery must not read a new pause observation.',
                            );
                            state.observationReads++;
                            return clone(observation);
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
                'Unadmitted fixed memory import.',
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
                WeakMap,
                WeakSet,
                Buffer,
                Error,
                Promise,
                TextDecoder,
                structuredClone,
                require(name: string) {
                    assert.ok(modules.has(name));
                    return modules.get(name);
                },
            },
            { codeGeneration: { strings: false, wasm: false } },
        ),
        { timeout: 1000 },
    );
    const api = module.exports,
        prompts = {
            now: () => 100,
            gui: {
                async review() {
                    throw Error('UNEXPECTED_GUI_PORT');
                },
            },
            terminal: {
                async review(request: any) {
                    state.events.push('prompt');
                    state.prompts++;
                    state.promptRequests.push(request);
                    assert.equal(request.confirmation, 'apply');
                    assert.equal(request.menu, false);
                    state.promptEntered.resolve();
                    if (state.promptFailureSet) throw state.promptFailure;
                    return state.promptGate ? await state.promptGate.promise : state.reply;
                },
            },
        };
    const args = (selected: any = choices, actualHost: any = host) => [
        actualHost,
        selected,
        '/memory/home/data',
        prompts,
        { DISPLAY: ':memory' },
    ];
    return {
        api,
        state,
        host,
        choices,
        pending,
        observation,
        pause: () => api.runLinuxPermanentOwnedFixture(...args(), 'seal-preparation'),
        normalFinalize: (selected: any = choices) =>
            api.runLinuxPermanentOwnedFixture(...args(selected), 'normal-finalize'),
        recover: (pausedOwner: unknown, selected: any = choices, actualHost: any = host) =>
            api.runLinuxPermanentSealRecoveryFixture(...args(selected, actualHost), pausedOwner),
        holdPrompt() {
            state.promptEntered = deferred<void>();
            return (state.promptGate = deferred<any>());
        },
    };
}
async function paused(f: ReturnType<typeof memoryCaller>) {
    const result = await f.pause();
    assert.equal(result.status, 'fixture-seal-preparation-paused');
    assert.equal(result.releaseAcceptance, false);
    assert.equal(f.api.linuxPermanentSetupDiagnostics(result.owner).phase, 'fixture-paused');
    assert.equal(f.state.launches.length, 1);
    assert.equal(f.state.inspected, 2, 'The paused owner requires both actual caller inspections.');
    return result.owner;
}
async function promptReached(f: ReturnType<typeof memoryCaller>, running: Promise<any>) {
    assert.equal(
        await Promise.race([
            f.state.promptEntered.promise.then(() => true),
            running.then(() => false),
        ]),
        true,
        'Actual caller settled before reaching the held memory prompt.',
    );
}
function retained(f: ReturnType<typeof memoryCaller>, result: any) {
    assert.equal(result.status, 'retained-unknown');
    const diagnostics = f.api.linuxPermanentSetupDiagnostics(result.owner);
    assert.equal(diagnostics.primarySet, true);
    assert.equal(diagnostics.phase, 'retained-unknown');
}
function noNewSelectors(f: ReturnType<typeof memoryCaller>) {
    assert.equal(f.state.quitSelections.length, 1);
    assert.equal(f.state.sealSelections.length, 1);
}

test('memory normal-finalize obtains consent and selects ordinary quit without a seal pause', async () => {
    const f = memoryCaller(true),
        result = await f.normalFinalize();
    assert.equal(result.status, 'previous-generation-finalized');
    assert.equal(f.api.linuxPermanentSetupDiagnostics(result.owner).phase, 'finished');
    assert.equal(f.state.inspected, 2);
    assert.equal(f.state.quitSelections.length, 1);
    assert.equal(f.state.sealSelections.length, 0);
    assert.equal(f.state.observationReads, 0);
    assert.equal(f.state.launches.length, 1);
    assert.match(f.state.promptRequests[0].detail, /complete the described Finalize/);
    assert.ok(f.state.events.indexOf('prompt') < f.state.events.indexOf('quit-selection'));
});

test('memory normal-finalize cancellation and thrown undefined do not mint quit or seal authority', async () => {
    for (const throws of [false, true]) {
        const f = memoryCaller(true);
        f.state.reply = { status: 'cancelled' };
        f.state.promptFailureSet = throws;
        f.state.promptFailure = undefined;
        const result = await f.normalFinalize();
        assert.equal(result.status, throws ? 'retained-unknown' : 'cancelled');
        assert.equal(f.api.linuxPermanentSetupDiagnostics(result.owner).primarySet, throws);
        assert.equal(f.state.quitSelections.length, 0);
        assert.equal(f.state.sealSelections.length, 0);
        assert.equal(f.state.launches.length, 0);
    }
});

test('memory normal-finalize refuses a changed review and invalid launch/menu/terminal choices', async () => {
    const f = memoryCaller(true);
    f.state.beforeInspect = (count, view) => {
        if (count === 2) view.activity.root = 'active';
    };
    retained(f, await f.normalFinalize());
    assert.equal(f.state.quitSelections.length, 0);
    for (const changes of [{ operation: 'launch' }, { menu: true }, { terminal: false }]) {
        const other = memoryCaller(true);
        assert.throws(
            () => other.normalFinalize({ ...other.choices, ...changes }),
            /LINUX_OWNED_FIXTURE_SELECTION/,
        );
        assert.deepEqual(other.state.events, []);
    }
});

test('memory recovery rejects plain foreign and consumed owners before any new source or native IO', async () => {
    const f = memoryCaller(),
        owner = await paused(f),
        foreign = memoryCaller(),
        otherOwner = await paused(foreign);
    for (const value of [{}, clone(owner), Object.freeze({ owner }), otherOwner, null, false]) {
        const count = f.state.events.length;
        assert.throws(() => f.recover(value), /LINUX_SEAL_RECOVERY_OWNER/);
        assert.equal(f.state.events.length, count);
    }
    for (const changes of [
        { operation: 'launch' },
        { menu: true },
        { terminal: false },
        { root: '/foreign' },
        { version: '0.5.0' },
    ]) {
        const count = f.state.events.length;
        assert.throws(
            () => f.recover(owner, { ...f.choices, ...changes }),
            /LINUX_SEAL_RECOVERY_SELECTION/,
        );
        assert.equal(f.state.events.length, count);
    }
    f.state.reply = { status: 'cancelled' };
    assert.equal((await f.recover(owner)).status, 'cancelled');
    const count = f.state.events.length;
    assert.throws(() => f.recover(owner), /LINUX_SEAL_RECOVERY_SELECTION/);
    assert.equal(f.state.events.length, count);
    assert.equal(f.state.launches.length, 1);
    noNewSelectors(f);
});

test('memory actual paused caller owner recovers with undefined selectors and maps only the no-launch result', async () => {
    const f = memoryCaller(),
        owner = await paused(f),
        before = f.state.observationReads,
        result = await f.recover(owner);
    assert.equal(result.status, 'previous-generation-seal-recovered');
    assert.equal(result.result.verdict, 'SEAL_RECOVERED_NO_LAUNCH');
    assert.equal(result.result.spawned, false);
    assert.equal(result.result.nativeQualified, false);
    assert.equal(result.result.releaseAcceptance, false);
    assert.equal(f.state.launches.length, 2);
    noNewSelectors(f);
    assert.equal(f.state.launches[1][6], undefined);
    assert.equal(f.state.launches[1][7], undefined);
    assert.equal(f.state.plans[1].reviewSHA256, linuxModelReviewSHA256(f.pending));
    assert.ok(
        f.state.observationReads > before,
        'Original owner must remain live-checked by the actual caller.',
    );
    assert.equal(f.state.events.filter((event) => event === 'recover-memory-port').length, 1);
    const count = f.state.events.length;
    assert.throws(() => f.recover(owner), /LINUX_SEAL_RECOVERY_SELECTION/);
    assert.equal(f.state.events.length, count);
});

test('memory pending review binding rejects changed intent transaction source profile and published/idempotent fallthrough before consent', async () => {
    const changes: ((view: any) => void)[] = [
        (view) => {
            view.history.cleanup.seal.intentSHA256 = 'e'.repeat(64);
        },
        (view) => {
            view.root.transactionId = view.journal.transactionId =
                '44444444-4444-4444-8444-444444444444';
        },
        (view) => {
            view.source.identity.ino++;
        },
        (view) => {
            view.source.verifiedManifestSHA256 = 'f'.repeat(64);
        },
        (view) => {
            view.root.profile = view.journal.profile = '/memory/home/config/other-profile';
        },
        (view) => {
            view.history.cleanup.seal.state = 'ready';
        },
        (view) => {
            view.journal.phase = 'candidate-confirmed';
            view.history.cleanup.seal.state = 'published';
        },
        (view) => {
            view.journal = null;
            delete view.history;
        },
    ];
    for (const change of changes) {
        const f = memoryCaller(),
            owner = await paused(f),
            prompts = f.state.prompts;
        change(f.state.current);
        const result = await f.recover(owner);
        retained(f, result);
        assert.equal(f.state.prompts, prompts);
        assert.equal(f.state.plans.length, 1);
        assert.equal(f.state.launches.length, 1);
        noNewSelectors(f);
        const count = f.state.events.length;
        assert.throws(() => f.recover(owner), /LINUX_SEAL_RECOVERY_SELECTION/);
        assert.equal(f.state.events.length, count);
    }
});

test('memory original-owner late uncertainty before and across the actual held prompt blocks recovery', async () => {
    for (const phase of ['before-prompt', 'during-prompt'])
        for (const changed of ['launch', 'native', 'preparation']) {
            const f = memoryCaller(),
                owner = await paused(f),
                prompts = f.state.prompts;
            let injections = 0;
            const invalidate = () => {
                injections++;
                if (changed === 'launch') f.state.original.launch.launchPrimarySet = true;
                if (changed === 'native') f.state.original.native.retainedFDs = 1;
                if (changed === 'preparation')
                    f.state.original.preparation.pending = 'late-memory-operation';
            };
            let running: Promise<any>;
            if (phase === 'before-prompt') {
                f.state.beforeInspect = (count) => {
                    if (count === 3) invalidate();
                };
                running = f.recover(owner);
            } else {
                const gate = f.holdPrompt();
                running = f.recover(owner);
                await promptReached(f, running);
                invalidate();
                gate.resolve({ status: 'confirmed', menu: false });
            }
            const result = await running;
            assert.equal(
                injections,
                1,
                'The intended original-owner uncertainty was actually injected.',
            );
            retained(f, result);
            assert.equal(f.state.prompts, prompts + (phase === 'during-prompt' ? 1 : 0));
            assert.equal(f.state.launches.length, 1);
            assert.equal(f.state.inspected, 3);
            noNewSelectors(f);
        }
    for (const changed of ['quit-failed', 'missing-interruption', 'contradictory-interruption']) {
        const f = memoryCaller(),
            owner = await paused(f);
        if (changed === 'quit-failed') f.state.original.summary.quitControl.failed = true;
        if (changed === 'missing-interruption')
            delete (f.state.original.summary as any).sealInterrupted;
        if (changed === 'contradictory-interruption')
            f.state.original.summary.sealInterrupted = false;
        const count = f.state.events.length;
        assert.throws(() => f.recover(owner), /LINUX_SEAL_RECOVERY_OWNER/);
        assert.equal(f.state.events.length, count);
    }
});

test('memory recovery cancellation and post-consent fresh review drift never mint another selector or launch', async () => {
    for (const mode of ['cancelled', 'fresh-intent', 'fresh-source']) {
        const f = memoryCaller(),
            owner = await paused(f);
        let injections = 0;
        if (mode === 'cancelled') f.state.reply = { status: 'cancelled' };
        else
            f.state.beforeInspect = (count, view) => {
                if (count !== 4) return;
                injections++;
                if (mode === 'fresh-intent')
                    view.history.cleanup.seal.intentSHA256 = 'e'.repeat(64);
                else view.source.identity.ino++;
            };
        const result = await f.recover(owner);
        assert.equal(
            injections,
            mode === 'cancelled' ? 0 : 1,
            'Fresh-review drift must reach its actual inspection.',
        );
        if (mode === 'cancelled') {
            assert.equal(result.status, 'cancelled');
            assert.equal(f.state.inspected, 3);
        } else {
            retained(f, result);
            assert.equal(f.state.inspected, 4);
        }
        assert.equal(f.state.launches.length, 1);
        assert.equal(f.state.plans.length, 1);
        noNewSelectors(f);
        const count = f.state.events.length;
        assert.throws(() => f.recover(owner), /LINUX_SEAL_RECOVERY_SELECTION/);
        assert.equal(f.state.events.length, count);
    }
});

test('memory recovery snapshots caller inputs and keeps falsey prompt or recovery failure consumed and retained', async () => {
    const f = memoryCaller(),
        owner = await paused(f),
        selected = { ...f.choices },
        actualHost = { ...f.host },
        gate = f.holdPrompt();
    const running = f.recover(owner, selected, actualHost);
    await promptReached(f, running);
    selected.root = '/foreign';
    selected.operation = 'launch';
    actualHost.sourceRoot = '/foreign';
    gate.resolve({ status: 'confirmed', menu: false });
    assert.equal((await running).status, 'previous-generation-seal-recovered');
    assert.equal(f.state.plans[1].root, f.choices.root);
    assert.equal(f.state.plans[1].host.sourceRoot, f.host.sourceRoot);
    for (const failure of [undefined, null, false, 0, ''])
        for (const phase of ['prompt', 'recovery']) {
            const failed = memoryCaller(),
                pausedOwner = await paused(failed);
            if (phase === 'prompt') {
                failed.state.promptFailureSet = true;
                failed.state.promptFailure = failure;
            } else {
                failed.state.launchFailureSet = true;
                failed.state.launchFailure = failure;
            }
            retained(failed, await failed.recover(pausedOwner));
            noNewSelectors(failed);
            assert.equal(failed.state.launches.length, phase === 'prompt' ? 1 : 2);
            const count = failed.state.events.length;
            assert.throws(() => failed.recover(pausedOwner), /LINUX_SEAL_RECOVERY_SELECTION/);
            assert.equal(failed.state.events.length, count);
        }
});
