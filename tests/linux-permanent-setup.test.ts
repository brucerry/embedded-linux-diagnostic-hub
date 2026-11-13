import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
    createLinuxNativeBackend,
    createLinuxNativePreparationBackend,
} from '../electron/linux-native-backend.ts';
import { createLinuxNativeDriver } from '../electron/linux-native-driver.ts';
import * as nativeDriver from '../electron/linux-native-driver.ts';
import * as nativeBackend from '../electron/linux-native-backend.ts';
import * as setupReadback from '../electron/linux-setup-readback.ts';
import { linuxModelReviewSHA256 } from '../electron/linux-transaction-model.ts';
import { createLinuxOwnedLaunch } from '../electron/linux-owned-launch.ts';
import { desiredLinuxMenu, prepareLinuxMenuJournal } from '../electron/linux-menu-ownership.ts';
import { INSTALLATION_PRODUCT, validateInstallationManifest } from '../shared/installation.ts';
import { SETUP_OWNER, SETUP_PAYLOAD } from '../electron/installation-maintenance.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';
import path from 'node:path';
import * as installation from '../shared/installation.ts';
import * as ownedLaunch from '../electron/linux-owned-launch.ts';
import { linuxReviewArguments } from '../electron/linux-setup-ui.ts';

// Reuse only fixed declarations from the existing explicit-memory backend
// fixture. No old registration is imported, and no real native host, socket,
// filesystem mutation, child process or installation is constructed here.
const fixtureSource = readFileSync(
    new URL('./linux-native-backend.test.ts', import.meta.url),
    'utf8',
);
assert.equal(
    createHash('sha256').update(fixtureSource).digest('hex'),
    '117374f6d75ac5b30b7b51bd881871861bef1afddf3760ec0a4b7758cddf8c43',
);
const fixtureTree = ts.createSourceFile(
    'fixed-linux-backend-fixture.ts',
    fixtureSource,
    ts.ScriptTarget.ES2022,
    true,
);
assert.equal(
    (fixtureTree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
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
const fakeServer = fixtureTree.statements.filter(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'FakeServer',
);
assert.equal(fakeServer.length, 1);
declarations.push(fakeServer[0].getText(fixtureTree));
for (const name of ['fixture', 'acquire', 'menuFixture', 'preparedNativeResume', 'launchFixture']) {
    const found = fixtureTree.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.equal(found.length, 1);
    declarations.push(found[0].getText(fixtureTree));
}
declarations.push(
    'bootstrapExports.value={fixture,menuFixture,preparedNativeResume,launchFixture};',
);
const compiled = ts.transpileModule(declarations.join('\n'), {
    fileName: 'fixed-linux-permanent-memory-fixture.ts',
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
    reportDiagnostics: true,
});
assert.equal(
    (compiled.diagnostics ?? []).filter((node) => node.category === ts.DiagnosticCategory.Error)
        .length,
    0,
);
const bootstrapExports = { value: undefined as any },
    outerModule = { exports: {} };
const fixtureContext = vm.createContext(
    {
        bootstrapExports,
        module: outerModule,
        exports: outerModule.exports,
        Object,
        JSON,
        Map,
        Set,
        Buffer,
        Promise,
        EventEmitter,
        queueMicrotask,
        assert,
        constants,
        createHash,
        createLinuxNativeBackend,
        createLinuxNativeDriver,
        linuxModelReviewSHA256,
        createLinuxOwnedLaunch,
        desiredLinuxMenu,
        prepareLinuxMenuJournal,
        INSTALLATION_PRODUCT,
        validateInstallationManifest,
        SETUP_OWNER,
        SETUP_PAYLOAD,
        linuxReadbackPair,
    },
    { codeGeneration: { strings: false, wasm: false } },
);
new vm.Script(compiled.outputText, {
    filename: 'fixed-linux-permanent-memory-fixture.cjs',
}).runInContext(fixtureContext, { timeout: 1000 });
const {
    fixture: memoryFixture,
    menuFixture,
    preparedNativeResume,
    launchFixture,
} = bootstrapExports.value;

const coreSource = readFileSync(
    new URL('../electron/linux-permanent-setup.ts', import.meta.url),
    'utf8',
);
const coreTree = ts.createSourceFile(
    'actual-linux-permanent-setup.ts',
    coreSource,
    ts.ScriptTarget.ES2022,
    true,
);
assert.equal(
    (coreTree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
const coreCompiled = ts.transpileModule(coreSource, {
    fileName: 'actual-linux-permanent-setup-memory.ts',
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
    reportDiagnostics: true,
});
assert.equal(
    (coreCompiled.diagnostics ?? []).filter((node) => node.category === ts.DiagnosticCategory.Error)
        .length,
    0,
);
const coreScript = new vm.Script(coreCompiled.outputText, {
    filename: 'actual-linux-permanent-setup-memory.cjs',
});

function gate() {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise<unknown>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function watch(operation: Promise<any>) {
    return {
        operation,
        outcome: operation.then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
        ),
    };
}
async function milestone(running: ReturnType<typeof watch>, pending: Promise<unknown>) {
    const result: any = await Promise.race([
        pending.then(() => ({ entered: true })),
        running.outcome,
    ]);
    if (result.ok === false) throw result.error;
    assert.equal(result.entered, true, 'Actual operation settled before the authored milestone.');
}
const mutation = (name: string) => /^(write|truncate|mkdir|move-noreplace)$/.test(name);
const workPath = (root: string) =>
    path.posix.join(
        path.posix.dirname(root),
        '.DiagnosticHub-maintenance-' +
            createHash('sha256').update(root).digest('hex').slice(0, 20),
    );
function selectCandidate(f: any, version: string, text: string) {
    const bytes = Buffer.from(text),
        relative = 'app/diagnostic-hub';
    f.node(f.plan.host.sourceRoot + '/' + relative).bytes = bytes;
    const manifest = JSON.parse(
        f.node(f.plan.host.sourceRoot + '/' + SETUP_PAYLOAD).bytes.toString(),
    );
    manifest.version = version;
    manifest.files[0] = {
        kind: 'file',
        path: relative,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const original = Buffer.from(JSON.stringify(manifest));
    f.node(f.plan.host.sourceRoot + '/' + SETUP_PAYLOAD).bytes = original;
    f.plan.review.source.manifest = validateInstallationManifest(manifest);
    f.plan.review.source.verifiedManifestSHA256 = createHash('sha256')
        .update(original)
        .digest('hex');
    f.plan.host.version = version;
    f.choices.version = version;
}

function permanentFixture(installed = false, selected = false) {
    const f = menuFixture(selected, installed);
    // Fresh explicit invocations get fresh UUIDs. The original shared fixture's
    // constant-token default remains untouched for its existing registrations.
    let uuidSequence = 0;
    f.ops.uuid = () => '33333333-3333-4333-8333-' + (++uuidSequence).toString(16).padStart(12, '0');
    const state = {
        nativeCalls: 0,
        sourceReads: 0,
        guiCalls: 0,
        terminalCalls: 0,
        nativeFailureSet: false,
        nativeFailure: undefined as unknown,
        sourceFailureSet: false,
        sourceFailure: undefined as unknown,
        reply: { status: 'confirmed', menu: selected } as any,
        terminalReply: { status: 'confirmed', menu: selected } as any,
        guiGate: null as ReturnType<typeof gate> | null,
        nativeGate: null as ReturnType<typeof gate> | null,
        enteredNative: gate(),
        enteredGUI: gate(),
        enteredTerminal: gate(),
        requests: [] as any[],
        processRequests: [] as any[],
        enteredProcess: gate(),
    };
    const choices: any = {
        root: f.plan.root,
        menu: selected,
        menuExplicit: true,
        terminal: false,
        version: f.plan.host.version,
        operation: installed ? 'update' : 'install',
    };
    const child = Object.assign(new EventEmitter(), {
        pid: 888,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    const pair = linuxReadbackPair();
    Object.assign(child, { stdio: [null, child.stdout, child.stderr, pair.parent] });
    const modules = new Map<string, unknown>([
        ['node:path', path],
        ['../shared/installation.ts', installation],
        ['./installation-maintenance.ts', { SETUP_PAYLOAD }],
        [
            './linux-setup-review.ts',
            {
                linuxReviewDisk: {
                    async bytes(file: string, maximum: number, uid: number) {
                        state.sourceReads++;
                        assert.equal(file, f.plan.host.sourceRoot + '/' + SETUP_PAYLOAD);
                        assert.equal(uid, 1000);
                        if (state.sourceFailureSet) throw state.sourceFailure;
                        const bytes = Buffer.from(f.node(file).bytes);
                        assert.ok(bytes.length <= maximum);
                        return bytes;
                    },
                },
            },
        ],
        ['./linux-setup-ui.ts', { linuxReviewArguments }],
        [
            './linux-native-host.ts',
            {
                async createLinuxNativeHost(root: string, manifest: any) {
                    state.nativeCalls++;
                    state.enteredNative.resolve();
                    assert.equal(root, f.plan.host.sourceRoot);
                    assert.deepEqual(
                        JSON.parse(JSON.stringify(manifest)),
                        JSON.parse(JSON.stringify(f.plan.review.source.manifest)),
                    );
                    if (state.nativeFailureSet) throw state.nativeFailure;
                    if (state.nativeGate) await state.nativeGate.promise;
                    return Object.freeze({
                        operations: f.ops,
                        owner: Object.freeze(JSON.parse(JSON.stringify(f.plan.owner))),
                        diagnostics: () =>
                            Object.freeze({
                                stage: 'ready',
                                failed: false,
                                loadAttempted: false,
                                loaded: false,
                                retainedFDs: 0,
                                retainedModule: false,
                                retainedOriginalBytes: 0,
                                firstFailureRetained: false,
                            }),
                    });
                },
                linuxNativeHostFailureCustody: () => null,
            },
        ],
        ['./linux-native-driver.ts', nativeDriver],
        ['./linux-transaction-model.ts', { linuxModelReviewSHA256 }],
        ['./linux-setup-readback.ts', setupReadback],
        ['./linux-native-backend.ts', nativeBackend],
        [
            './linux-owned-launch.ts',
            {
                ...ownedLaunch,
                createLinuxNativeLaunchProcessHost: () => ({
                    spawn(request: unknown) {
                        state.processRequests.push(request);
                        state.enteredProcess.resolve();
                        return child;
                    },
                }),
            },
        ],
    ]);
    for (const node of coreTree.statements)
        if (ts.isImportDeclaration(node)) {
            assert.ok(
                ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
            );
        }
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
            require(name: string) {
                assert.ok(modules.has(name), 'Unadmitted permanent-setup import.');
                return modules.get(name);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    coreScript.runInContext(context, { timeout: 1000 });
    const prompts = {
        gui: {
            async review(request: unknown) {
                state.guiCalls++;
                state.requests.push(request);
                state.enteredGUI.resolve();
                if (state.guiGate) await state.guiGate.promise;
                state.guiGate = null;
                return state.reply;
            },
            hasPending: () => Boolean(state.guiGate),
        },
        terminal: {
            async review(request: unknown) {
                state.terminalCalls++;
                state.requests.push(request);
                state.enteredTerminal.resolve();
                return state.terminalReply;
            },
            hasPending: () => false,
        },
        now: f.ops.now,
    };
    return {
        ...f,
        state,
        choices,
        child,
        pair,
        prompts,
        api: module.exports,
        begin() {
            return watch(
                module.exports.runLinuxPermanentSetup(
                    f.plan.host,
                    choices,
                    f.plan.menu.dataHome,
                    prompts,
                    { DISPLAY: ':99' },
                ),
            );
        },
    };
}

test('actual permanent caller obtains fresh backend review and consent before one memory install', async () => {
    const f = permanentFixture(),
        held = gate();
    const args = [
        '--install-directory',
        f.plan.root,
        '--version',
        '0.6.0',
        '--operation',
        'resume',
    ];
    assert.equal(f.api.linuxPermanentArguments(args).operation, 'resume');
    assert.throws(() => linuxReviewArguments(args), /LINUX_REVIEW_ARGUMENT/);
    const finalizeArgs = [...args.slice(0, -1), 'finalize'];
    assert.equal(f.api.linuxPermanentArguments(finalizeArgs).operation, 'finalize');
    assert.throws(() => linuxReviewArguments(finalizeArgs), /LINUX_REVIEW_ARGUMENT/);
    for (const operation of ['review', 'remove'])
        assert.throws(() =>
            f.api.linuxPermanentArguments([
                '--install-directory',
                f.plan.root,
                '--version',
                '0.6.0',
                '--operation',
                operation,
            ]),
        );
    for (const operation of ['launch', 'finalize'])
        assert.throws(() =>
            f.api.linuxPermanentArguments([
                '--install-directory',
                f.plan.root,
                '--version',
                '0.6.0',
                '--operation',
                operation,
                '--no-launch',
            ]),
        );
    const entry = readFileSync(
        new URL('../scripts/linux-setup-install.cts', import.meta.url),
        'utf8',
    );
    assert.match(entry, /export async function linuxSetupInstallEntry\(args: string\[\]\)/);
    assert.match(entry, /app\/resources\/linux-setup-install\.cjs/);
    assert.match(entry, /await runLinuxPermanentSetup\(/);
    assert.match(entry, /ELECTRON_RUN_AS_NODE/);
    f.state.guiGate = held;
    const running = f.begin();
    try {
        await milestone(running, f.state.enteredGUI.promise);
        assert.equal(f.state.sourceReads, 1);
        assert.equal(f.state.nativeCalls, 1);
        assert.equal(f.calls.some(mutation), false);
        assert.equal(f.server.listenCalls, 0);
        assert.equal(f.nodes.has(f.plan.root), false);
        assert.equal(f.state.requests[0].deadlineMs, 120000);
        assert.equal(f.state.requests[0].confirmation, 'apply');
        held.resolve();
        const result = await running.operation;
        assert.equal(result.status, 'finished');
        assert.equal(result.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        assert.equal(result.result.nativeQualified, false);
        assert.equal(result.result.productionDispatch, false);
        assert.equal(f.node(f.plan.root + '/app/diagnostic-hub').bytes.toString(), 'fixture');
        assert.equal(f.state.guiCalls, 1);
        assert.equal(f.state.terminalCalls, 0);
        assert.equal(f.state.processRequests.length, 0);
        assert.equal(f.fds.size, 0);
        assert.equal(f.server.closed, 1);
    } finally {
        held.resolve();
        await running.outcome;
    }
});

test('actual permanent caller cancellation and unavailable surfaces cannot authorize mutations or launch', async () => {
    for (const mode of ['cancelled', 'unavailable', 'unknown', 'explicit-terminal']) {
        const f = permanentFixture();
        f.state.reply = { status: mode === 'explicit-terminal' ? 'confirmed' : mode, menu: false };
        f.state.terminalReply = { status: 'cancelled' };
        f.choices.terminal = mode === 'explicit-terminal';
        const result = await f.begin().operation;
        assert.equal(result.status, mode === 'unknown' ? 'retained-unknown' : 'cancelled');
        assert.equal(f.calls.some(mutation), false);
        assert.equal(f.server.listenCalls, 0);
        assert.equal(f.state.processRequests.length, 0);
        assert.equal(f.nodes.has(f.plan.root), false);
        assert.equal(f.state.guiCalls, mode === 'explicit-terminal' ? 0 : 1);
        assert.equal(
            f.state.terminalCalls,
            mode === 'unavailable' || mode === 'explicit-terminal' ? 1 : 0,
        );
        assert.ok(Object.isFrozen(result.owner));
    }
});

test('actual permanent caller refuses a changed source or destination after the reviewed prompt', async () => {
    for (const mode of ['source-bytes', 'foreign-destination']) {
        const f = permanentFixture(),
            held = gate();
        f.state.guiGate = held;
        const running = f.begin();
        try {
            await milestone(running, f.state.enteredGUI.promise);
            if (mode === 'source-bytes')
                f.node(f.plan.host.sourceRoot + '/app/diagnostic-hub').bytes[0] ^= 1;
            else {
                f.directory(f.plan.root);
                f.file(f.plan.root + '/foreign', 'foreign-preimage');
            }
            const at = f.calls.length;
            held.resolve();
            const result = await running.operation;
            assert.equal(result.status, 'retained-unknown');
            assert.equal(f.api.linuxPermanentSetupDiagnostics(result.owner).primarySet, true);
            assert.equal(f.calls.slice(at).some(mutation), false);
            assert.equal(f.state.processRequests.length, 0);
            assert.equal(f.server.listenCalls, 0);
            if (mode === 'foreign-destination')
                assert.equal(f.node(f.plan.root + '/foreign').bytes.toString(), 'foreign-preimage');
        } finally {
            held.resolve();
            await running.outcome;
        }
    }
});

test('actual permanent caller retains source or native Error and undefined failure without prompting or mutation', async () => {
    for (const kind of ['source', 'native'])
        for (const original of [Error('PRIVATE_SETUP_PORT_FAILURE'), undefined]) {
            const f = permanentFixture();
            if (kind === 'source') {
                f.state.sourceFailureSet = true;
                f.state.sourceFailure = original;
            } else {
                f.state.nativeFailureSet = true;
                f.state.nativeFailure = original;
            }
            const result = await f.begin().operation;
            assert.equal(result.status, 'retained-unknown');
            assert.equal(f.api.linuxPermanentSetupDiagnostics(result.owner).primarySet, true);
            assert.equal(f.state.nativeCalls, kind === 'source' ? 0 : 1);
            assert.equal(f.state.guiCalls, 0);
            assert.equal(f.state.terminalCalls, 0);
            assert.equal(f.calls.some(mutation), false);
            assert.equal(f.server.listenCalls, 0);
            assert.equal(f.state.processRequests.length, 0);
            assert.doesNotMatch(
                JSON.stringify(result) +
                    JSON.stringify(f.api.linuxPermanentSetupDiagnostics(result.owner)),
                /PRIVATE_SETUP_PORT_FAILURE/,
            );
        }
});

test('actual permanent caller uses the same deadline across native preparation and held prompt continuations', async () => {
    for (const where of ['native', 'prompt']) {
        const f = permanentFixture(),
            held = gate();
        if (where === 'native') f.state.nativeGate = held;
        else f.state.guiGate = held;
        const running = f.begin();
        try {
            await milestone(
                running,
                where === 'native' ? f.state.enteredNative.promise : f.state.enteredGUI.promise,
            );
            f.advance(120000);
            held.resolve();
            const result = await running.operation;
            assert.equal(result.status, 'retained-unknown');
            assert.equal(f.api.linuxPermanentSetupDiagnostics(result.owner).primarySet, true);
            assert.equal(f.calls.some(mutation), false);
            assert.equal(f.server.listenCalls, 0);
            assert.equal(f.state.processRequests.length, 0);
            assert.equal(f.state.nativeCalls, 1);
            assert.equal(f.state.guiCalls, where === 'prompt' ? 1 : 0);
        } finally {
            held.resolve();
            await running.outcome;
        }
    }
});

test('actual permanent caller preserves partial-write custody and a destination race winner without automatic retry', async () => {
    for (const kind of ['partial-write', 'destination-race', 'busy-reservation']) {
        const f = permanentFixture();
        let injected = false,
            writes = 0;
        if (kind === 'busy-reservation') f.server.unavailable = true;
        else
            f.setHook((name: string) => {
                if (kind === 'partial-write' && name === 'write' && ++writes < 2) return;
                if (!injected && name === (kind === 'partial-write' ? 'write' : 'move-noreplace')) {
                    injected = true;
                    if (kind === 'partial-write') throw Error('PRIVATE_PARTIAL_SETUP_WRITE');
                    f.directory(f.plan.root);
                    f.file(f.plan.root + '/foreign-race-winner', 'foreign-owned-bytes');
                }
            });
        const result = await f.begin().operation;
        assert.equal(
            result.result.verdict,
            kind === 'busy-reservation' ? 'REFUSED' : 'RETAINED_UNKNOWN',
        );
        assert.equal(f.state.nativeCalls, 1);
        assert.equal(f.state.guiCalls, 1);
        assert.equal(f.state.processRequests.length, 0);
        if (kind === 'busy-reservation') {
            assert.equal(result.status, 'refused');
            assert.equal(f.calls.some(mutation), false);
            assert.equal(f.nodes.has(f.plan.root), false);
        } else {
            assert.equal(injected, true);
            assert.equal(result.status, 'retained-unknown');
            assert.equal(result.result.reservation, 'held');
            if (kind === 'partial-write') {
                assert.ok(
                    f.api.linuxPermanentSetupDiagnostics(result.owner).backend.backend.retainedFDs >
                        0,
                );
                assert.equal(writes, 2);
            } else {
                assert.equal(
                    f.node(f.plan.root + '/foreign-race-winner').bytes.toString(),
                    'foreign-owned-bytes',
                );
                assert.equal(f.calls.filter((name: string) => name === 'move-noreplace').length, 1);
            }
        }
        const after = f.calls.length;
        f.api.linuxPermanentSetupDiagnostics(result.owner);
        assert.equal(f.calls.length, after);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PARTIAL_SETUP_WRITE/);
    }
});

test('actual permanent caller updates repairs rolls back and resumes while preserving owned profile and payload preimages', async () => {
    {
        const f = permanentFixture(true, true);
        const updated = await f.begin().operation;
        assert.equal(updated.status, 'finished');
        assert.equal(updated.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
        assert.equal(f.node(f.desired.record.path).bytes.toString(), f.desired.text);
        f.choices.operation = 'rollback'; // A separate explicit command, not automatic recovery.
        const restored = await f.begin().operation;
        assert.equal(restored.result.verdict, 'ROLLED_BACK_RETAINED');
        assert.equal(restored.result.nativeQualified, false);
        assert.equal(f.node(f.desired.record.path).bytes.toString(), f.oldText);
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
        assert.equal(f.state.processRequests.length, 0);
    }
    {
        const f = permanentFixture(true, true);
        const source = Buffer.from(f.node(f.plan.host.sourceRoot + '/' + SETUP_PAYLOAD).bytes);
        f.node(f.plan.root + '/.diagnostic-hub-release.json').bytes = source;
        const record = JSON.parse(
            f.node(f.plan.root + '/.diagnostic-hub-installation.json').bytes.toString(),
        );
        record.manifestSHA256 = createHash('sha256').update(source).digest('hex');
        f.node(f.plan.root + '/.diagnostic-hub-installation.json').bytes = Buffer.from(
            JSON.stringify(record),
        );
        f.choices.operation = 'repair';
        const repaired = await f.begin().operation;
        assert.equal(repaired.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        assert.equal(repaired.result.nativeQualified, false);
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
        assert.equal(f.state.processRequests.length, 0);
    }
    {
        const f = permanentFixture(true, true),
            seeded = await preparedNativeResume(f, 'old-retained');
        f.choices.operation = 'resume';
        const resumed = await f.begin().operation;
        assert.equal(resumed.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        assert.equal(f.node(f.plan.root).ino, seeded.before.stage.identity.ino);
        assert.equal(f.node(f.marker).bytes.toString(), 'retained-profile-marker');
        assert.equal(resumed.result.nativeQualified, false);
        assert.equal(f.state.processRequests.length, 0);
    }
});

test('actual permanent relaunch routes one fixed owned child and retains an unacknowledged spawn at the original deadline', async () => {
    const f = permanentFixture();
    const installed = await f.begin().operation;
    assert.equal(installed.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    f.choices.operation = 'launch';
    const running = f.begin();
    try {
        await milestone(running, f.state.enteredProcess.promise);
        assert.equal(f.state.processRequests.length, 1);
        const request = f.state.processRequests[0];
        assert.equal(request.executable, f.plan.root + '/app/diagnostic-hub');
        assert.equal(request.root, f.plan.root);
        assert.equal(request.readback, true);
        assert.equal(request.environment.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(request.environment.HOME, f.plan.host.home);
        // No spawn/exit/EOF or inherited-channel ACK is fabricated. Expire only
        // this model's already-issued timer ports, then join the actual caller.
        f.advance(120000);
        for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
        const result = await running.operation;
        assert.equal(result.status, 'launch');
        assert.equal(result.result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(result.result.childOwned, true);
        assert.equal(result.result.successorVerified, false);
        assert.equal(result.result.reservation, 'held');
        assert.equal(f.state.processRequests.length, 1);
    } finally {
        f.advance(120000);
        for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
        await running.outcome;
        await f.pair.pump();
    }
});

test('actual permanent first install A then update B preserves original completed journal and explicit rollback restores A', async () => {
    for (const mode of ['rollback', 'unbound-third-update-refused']) {
        const f = permanentFixture(),
            installed = await f.begin().operation;
        assert.equal(installed.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        const work = workPath(f.plan.root),
            originalA = Buffer.from(f.node(work + '/journal.json').bytes);
        const identityA = JSON.parse(
            f.node(f.plan.root + '/.diagnostic-hub-installation.json').bytes.toString(),
        );
        const rootInodeA = f.node(f.plan.root).ino;
        const profileMarker =
            f.plan.host.appData +
            '/DiagnosticHub/profiles/' +
            identityA.installationId +
            '/user-marker';
        f.file(profileMarker, 'private retained settings');
        selectCandidate(f, '0.7.0', 'candidate-B-bytes');
        f.choices.operation = 'update';
        const updated = await f.begin().operation;
        assert.equal(updated.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        assert.deepEqual(f.node(work + '/completed-journal.json').bytes, originalA);
        assert.equal(
            f.node(f.plan.root + '/app/diagnostic-hub').bytes.toString(),
            'candidate-B-bytes',
        );
        const journalB = JSON.parse(f.node(work + '/journal.json').bytes.toString());
        assert.notEqual(journalB.transactionId, JSON.parse(originalA.toString()).transactionId);
        assert.equal(f.node(work + '/previous-' + journalB.transactionId).ino, rootInodeA);
        assert.equal(f.node(profileMarker).bytes.toString(), 'private retained settings');
        if (mode === 'rollback') {
            f.choices.operation = 'rollback';
            const result = await f.begin().operation;
            assert.equal(result.result.verdict, 'ROLLED_BACK_RETAINED');
            assert.equal(f.node(f.plan.root).ino, rootInodeA);
            assert.equal(f.node(f.plan.root + '/app/diagnostic-hub').bytes.toString(), 'fixture');
            assert.equal(result.result.nativeQualified, false);
        } else {
            const journalOriginalB = Buffer.from(f.node(work + '/journal.json').bytes);
            const inodeB = f.node(f.plan.root).ino;
            f.file(work + '/unbound-history.json', 'foreign retained original');
            selectCandidate(f, '0.8.0', 'candidate-C-bytes');
            const at = f.calls.length;
            const refused = await f.begin().operation;
            assert.equal(refused.status, 'retained-unknown');
            assert.equal(f.node(f.plan.root).ino, inodeB);
            assert.equal(f.calls.slice(at).some(mutation), false);
            assert.deepEqual(f.node(work + '/journal.json').bytes, journalOriginalB);
        }
        assert.deepEqual(f.node(work + '/completed-journal.json').bytes, originalA);
        assert.equal(f.node(profileMarker).bytes.toString(), 'private retained settings');
        assert.equal(f.state.processRequests.length, 0);
    }
});

test('actual completed-journal handoff can be explicitly continued after its acknowledged boundary without replaying the move', async () => {
    const f = permanentFixture(),
        installed = await f.begin().operation;
    assert.equal(installed.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const work = workPath(f.plan.root),
        originalA = Buffer.from(f.node(work + '/journal.json').bytes);
    const record = JSON.parse(
        f.node(f.plan.root + '/.diagnostic-hub-installation.json').bytes.toString(),
    );
    selectCandidate(f, '0.7.0', 'candidate-B-after-handoff');
    const backend = createLinuxNativePreparationBackend(
        {
            host: f.plan.host,
            root: f.plan.root,
            action: 'update',
            installationId: record.installationId,
            transactionId: '77777777-7777-4777-8777-777777777777',
            owner: f.plan.owner,
        },
        { startedMs: 0, deadlineMs: 120000 },
        f.ops,
    );
    const prepared = await backend.prepare();
    const held = await backend.kernel.acquire({
        root: f.plan.root,
        uid: 1000,
        key: prepared.scope.key,
        owner: f.plan.owner,
    });
    assert.ok(held);
    let acknowledged = false;
    try {
        const after = await backend.effects.handoff!(prepared.scope, prepared.view);
        acknowledged = true;
        assert.equal(after.journal, null);
        assert.deepEqual(f.node(work + '/completed-journal.json').bytes, originalA);
    } finally {
        // This modeled owner completed its acknowledged primitive and explicitly
        // releases that exact lease. No failed/unknown owner is declared retired.
        if (acknowledged)
            assert.equal(await backend.kernel.release(held.handle, held.identity), true);
    }
    const moves = f.calls.filter((name: string) => name === 'move-noreplace').length;
    f.choices.operation = 'update';
    const continued = await f.begin().operation;
    assert.equal(continued.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(
        f.node(f.plan.root + '/app/diagnostic-hub').bytes.toString(),
        'candidate-B-after-handoff',
    );
    assert.deepEqual(f.node(work + '/completed-journal.json').bytes, originalA);
    // Only app A→previous and staged B→root remain; the journal is not moved again.
    assert.equal(f.calls.filter((name: string) => name === 'move-noreplace').length - moves, 2);
    assert.equal(continued.result.nativeQualified, false);
    for (const mode of ['before-move', 'move-then-throw']) {
        const interrupted = permanentFixture(),
            first = await interrupted.begin().operation;
        assert.equal(first.result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
        const home = workPath(interrupted.plan.root);
        const journalA = Buffer.from(interrupted.node(home + '/journal.json').bytes);
        const inodeA = interrupted.node(interrupted.plan.root).ino;
        selectCandidate(interrupted, '0.7.0', 'candidate-B-must-not-activate');
        interrupted.choices.operation = 'update';
        const move = interrupted.ops.moveNoReplace;
        let attempts = 0;
        interrupted.ops.moveNoReplace = (...args: any[]) => {
            if (args[1] === 'journal.json' && args[3] === 'completed-journal.json') {
                attempts++;
                if (mode === 'move-then-throw') Reflect.apply(move, interrupted.ops, args);
                throw Error('PRIVATE_HANDOFF_ACK_UNKNOWN');
            }
            return Reflect.apply(move, interrupted.ops, args);
        };
        const at = interrupted.calls.length;
        const result = await interrupted.begin().operation;
        assert.equal(result.status, 'retained-unknown');
        assert.equal(result.result.verdict, 'RETAINED_UNKNOWN');
        assert.equal(result.result.reservation, 'held');
        assert.equal(attempts, 1);
        assert.equal(interrupted.node(interrupted.plan.root).ino, inodeA);
        assert.equal(
            interrupted.node(interrupted.plan.root + '/app/diagnostic-hub').bytes.toString(),
            'fixture',
        );
        assert.equal(
            Array.from(interrupted.nodes.keys()).some(
                (name: any) =>
                    name.startsWith(home + '/stage-') || name.startsWith(home + '/previous-'),
            ),
            false,
        );
        assert.equal(
            interrupted.calls
                .slice(at)
                .some((name: string) => /^(write|truncate|mkdir)$/.test(name)),
            false,
        );
        if (mode === 'before-move') {
            assert.deepEqual(interrupted.node(home + '/journal.json').bytes, journalA);
            assert.equal(interrupted.nodes.has(home + '/completed-journal.json'), false);
        } else {
            assert.deepEqual(interrupted.node(home + '/completed-journal.json').bytes, journalA);
            assert.equal(interrupted.nodes.has(home + '/journal.json'), false);
        }
        const custody = interrupted.api.linuxPermanentSetupDiagnostics(result.owner);
        assert.ok(custody.backend.backend.retainedFDs > 0);
        const stopped = interrupted.calls.length;
        interrupted.api.linuxPermanentSetupDiagnostics(result.owner);
        assert.equal(interrupted.calls.length, stopped);
        assert.equal(attempts, 1);
        assert.equal(interrupted.state.processRequests.length, 0);
        // No second invocation, lease reuse, cleanup or release is attempted for
        // either failed owner. Their uncertain custody is deliberately retained.
    }
});
