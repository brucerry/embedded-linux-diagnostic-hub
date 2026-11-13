/** Actual owned launcher with closed memory ports; no process, socket, timer or FS fixture is created. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync, constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createLinuxNativeBackend } from '../electron/linux-native-backend.ts';
import { createLinuxNativeDriver } from '../electron/linux-native-driver.ts';
import { createLinuxOwnedLaunch } from '../electron/linux-owned-launch.ts';
import { linuxModelReviewSHA256 } from '../electron/linux-transaction-model.ts';
import { INSTALLATION_PRODUCT, validateInstallationManifest } from '../shared/installation.ts';
import { SETUP_OWNER, SETUP_PAYLOAD } from '../electron/installation-maintenance.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';
import { createLinuxMainReadback } from '../electron/linux-setup-readback.ts';

// Pinned declaration extraction only: none of the old71 registrations execute here.
const source = readFileSync(new URL('./linux-native-backend.test.ts', import.meta.url), 'utf8');
assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '117374f6d75ac5b30b7b51bd881871861bef1afddf3760ec0a4b7758cddf8c43',
);
const tree = ts.createSourceFile('fixed-launch-fixture.ts', source, ts.ScriptTarget.ES2022, true);
assert.equal(
    (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
const declarations: string[] = [];
for (const name of ['hash', 'clone', 'installationId', 'transactionId', 'token', 'procStat']) {
    const found = tree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(found.length, 1);
    declarations.push('const ' + found[0].getText(tree) + ';');
}
for (const name of ['FakeServer', 'fixture', 'launchFixture']) {
    const found = tree.statements.filter(
        (node) =>
            (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
            node.name?.text === name,
    );
    assert.equal(found.length, 1);
    declarations.push(found[0].getText(tree));
}
const compiled = ts.transpileModule(
    declarations.join('\n') + '\nmodule.exports={launchFixture,procStat};',
    {
        fileName: 'fixed-launch-fixture.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    },
);
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
        assert,
        constants,
        createHash,
        EventEmitter,
        queueMicrotask,
        createLinuxNativeBackend,
        createLinuxNativeDriver,
        createLinuxOwnedLaunch,
        linuxModelReviewSHA256,
        INSTALLATION_PRODUCT,
        validateInstallationManifest,
        SETUP_OWNER,
        SETUP_PAYLOAD,
        linuxReadbackPair,
    },
    { codeGeneration: { strings: false, wasm: false } },
);
new vm.Script(compiled.outputText, { filename: 'fixed-launch-fixture.memory.cjs' }).runInContext(
    context,
    { timeout: 1000 },
);
const { launchFixture, procStat } = module.exports;
const watch = (operation: Promise<any>) => ({
    operation,
    outcome: operation.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
    ),
});
async function join(f: any, running: ReturnType<typeof watch>) {
    for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
    await running.outcome;
    if (f.pair) await f.pair.pump();
}
async function phase(f: any, name: string) {
    for (let at = 0; at < 1000; at++) {
        const state = f.controller.summary();
        if (state.pending === name || state.verdict === 'RETAINED_UNKNOWN') break;
        await Promise.resolve();
    }
    assert.equal(f.controller.summary().pending, name, JSON.stringify(f.controller.summary()));
}
async function active(f: any, running: ReturnType<typeof watch>, readback = false) {
    await phase(f, 'spawn-event');
    f.addChild();
    f.child.emit('spawn');
    await phase(f, readback ? 'setup-readback' : 'child-and-pipe-close');
    if (!readback) return null;
    const record = {
        schemaVersion: 1 as const,
        source: 'linux-main-self-observation' as const,
        root: f.plan.root,
        installationId: f.plan.installationId,
        transactionId: f.plan.transactionId,
        manifestSHA256: f.plan.review.source.verifiedManifestSHA256,
        version: f.plan.host.version,
        process: {
            pid: 888,
            uid: 1000,
            executable: f.plan.root + '/app/diagnostic-hub',
            creationTimeMs: 10000,
        },
        profile: { path: f.plan.review.root.profile, lockOwned: true as const },
        window: {
            electronId: 1,
            nativeHandleHex: '0100000000000000',
            visible: true as const,
            minimized: false as const,
            mainFrameReady: true as const,
        },
        observedAtMs: Date.now(),
        payloadIntegrity: 'not-checked' as const,
        independentProcessObservation: false as const,
        independentWindowObservation: false as const,
        descendantRetirement: false as const,
        finalizationAuthority: false as const,
    };
    const main = createLinuxMainReadback(f.pair.child);
    main.offer(record, async () => ({ ...record, observedAtMs: Date.now() }));
    await f.pair.pump(
        () => f.controller.summary().pending === 'child-and-pipe-close' || f.heldReadbackClose,
    );
    assert.notEqual(
        f.controller.summary().verdict,
        'RETAINED_UNKNOWN',
        JSON.stringify(f.controller.summary()),
    );
    return main;
}

test('normal direct and private-readback closure retire only the same reservation and preserve all payloads', async () => {
    for (const readback of [false, true]) {
        const f = await launchFixture(readback),
            originals = new Map<string, string>(
                Array.from(f.nodes.entries() as Iterable<[string, any]>)
                    .filter(
                        ([name, node]) => name.startsWith('/home/test/') && node.kind === 'file',
                    )
                    .map(([name, node]) => [name, node.bytes.toString('base64')]),
            );
        const closed = f.server.close.bind(f.server);
        let releaseCalls = 0;
        f.server.close = (done: any) => {
            releaseCalls++;
            assert.equal(f.controller.summary().timerOwned, true);
            return closed(done);
        };
        const running = watch(f.controller.run());
        try {
            const main = await active(f, running, readback);
            f.close();
            const result = await running.operation;
            assert.equal(result.verdict, 'DIRECT_CHILD_CLOSED_RETAINED');
            assert.equal(result.reservation, 'none');
            assert.equal(result.childOwned, false);
            assert.equal(result.timerOwned, false);
            assert.equal(releaseCalls, 1);
            assert.equal(f.server.listening, false);
            assert.equal(f.server.closed, 2);
            assert.equal(f.fds.size, 0);
            const custody = f.controller.diagnostics();
            assert.equal(custody.retainedServers, 0);
            assert.equal(custody.retainedSockets, 0);
            assert.equal(custody.retainedTimers, 0);
            for (const [name, value] of originals)
                assert.equal(f.node(name).bytes.toString('base64'), value);
            for (const name of [
                'successorVerified',
                'wholeGroupRetirement',
                'nativeQualified',
                'productionDispatch',
            ])
                assert.equal(result[name], false);
            if (main) {
                await main.joinClosure();
                assert.equal(result.readback.channelBoundFreshReadback, true);
                assert.equal(result.readback.finalizationAuthority, false);
            }
            const at = f.calls.length;
            await assert.rejects(f.controller.run(), /consumed/);
            assert.equal(f.calls.length, at);
        } finally {
            await join(f, running);
        }
    }
});

test('a missing pipe or private-channel close blocks reservation release until that exact close is observed', async () => {
    for (const mode of ['pipe', 'readback']) {
        const f = await launchFixture(mode === 'readback');
        if (mode === 'readback') {
            const emit = f.pair.parent.emit.bind(f.pair.parent);
            f.pair.parent.emit = (name: string, ...args: any[]) => {
                if (name === 'close' && !f.allowReadbackClose) {
                    f.heldReadbackClose = () => emit(name, ...args);
                    return true;
                }
                return emit(name, ...args);
            };
        }
        const running = watch(f.controller.run());
        try {
            const main = await active(f, running, mode === 'readback');
            if (mode === 'pipe') {
                f.node('/proc/888/stat').bytes = Buffer.from(
                    procStat(888, '10001', 'Z').replace(' Z 0 ', ' Z 777 '),
                );
                f.child.emit('exit', 0, null);
                f.child.stdout.emit('end');
                f.child.stdout.emit('close');
                f.child.stderr.emit('end');
                f.child.emit('close', 0, null);
            }
            assert.equal(f.server.closed, 1);
            assert.equal(f.server.listening, true);
            assert.equal(f.controller.summary().reservation, 'held');
            assert.equal(f.controller.summary().timerOwned, true);
            if (mode === 'pipe') f.child.stderr.emit('close');
            else {
                assert.equal(typeof f.heldReadbackClose, 'function');
                f.allowReadbackClose = true;
                f.heldReadbackClose();
                await f.pair.pump(() => f.controller.summary().pending === 'child-and-pipe-close');
                f.close();
            }
            assert.equal((await running.operation).reservation, 'none');
            if (main) await main.joinClosure();
        } finally {
            await join(f, running);
        }
    }
});

test('release waits for actual own-server closure and acknowledgement while retaining its deadline', async () => {
    for (const mode of ['held-ack', 'ack-without-close', 'no-ack']) {
        const f = await launchFixture();
        let done: ((error?: unknown) => void) | undefined,
            releaseCalls = 0;
        f.server.close = (callback: any) => {
            releaseCalls++;
            f.server.closed++;
            done = callback;
            if (mode === 'ack-without-close') callback();
            return f.server;
        };
        const running = watch(f.controller.run());
        try {
            await active(f, running);
            f.close();
            await phase(f, 'reservation-release');
            assert.equal(releaseCalls, 1);
            assert.equal(f.controller.summary().timerOwned, true);
            assert.equal(f.controller.summary().reservation, 'unknown');
            if (mode === 'held-ack') {
                f.server.listening = false;
                done!();
                assert.equal((await running.operation).reservation, 'none');
            } else {
                for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
                const result = await running.operation;
                assert.equal(result.verdict, 'RETAINED_UNKNOWN');
                assert.equal(result.reservation, 'unknown');
                assert.equal(f.controller.diagnostics().retainedServers, 1);
                assert.equal(releaseCalls, 1);
                if (mode === 'no-ack') {
                    f.server.listening = false;
                    done!();
                    assert.equal(f.controller.summary().verdict, 'RETAINED_UNKNOWN');
                    assert.equal(releaseCalls, 1);
                }
            }
        } finally {
            await join(f, running);
        }
    }
});

test('throw undefined late errors accepted sockets and reentrant child failure never fabricate a release pass', async () => {
    for (const mode of [
        'throw-undefined',
        'ack-then-throw',
        'late-error',
        'accepted-socket',
        'child-error',
    ]) {
        const f = await launchFixture();
        if (mode === 'accepted-socket') {
            // This fixture reuses one fake server, whereas production creates a server per acquire.
            // Remove only the retired install's identified listener before the launch owner exists.
            assert.equal(f.server.closed, 1);
            assert.equal(f.server.listening, false);
            assert.equal(f.controller.summary().verdict, 'UNSTARTED');
            const retired = f.server.listeners('connection');
            assert.equal(retired.length, 1);
            f.server.removeListener('connection', retired[0]);
            assert.equal(f.server.listenerCount('connection'), 0);
        }
        let calls = 0;
        f.server.close = (done: any) => {
            calls++;
            f.server.closed++;
            if (mode === 'throw-undefined') throw undefined;
            if (mode === 'accepted-socket') {
                assert.equal(f.server.listenerCount('connection'), 1);
                const socket = Object.assign(new EventEmitter(), {
                    destroyCalls: 0,
                    destroy() {
                        this.destroyCalls++;
                        return this;
                    },
                });
                f.accepted = socket;
                f.server.emit('connection', socket);
            }
            f.server.listening = false;
            done();
            if (mode === 'ack-then-throw') throw undefined;
            if (mode === 'late-error') done(Error('private-late-error'));
            if (mode === 'child-error') f.child.emit('error', Error('private-child-error'));
            return f.server;
        };
        const running = watch(f.controller.run());
        try {
            await active(f, running);
            f.close();
            const result = await running.operation;
            assert.equal(result.verdict, 'RETAINED_UNKNOWN');
            assert.equal(calls, 1);
            assert.equal(result.childOwned, false);
            assert.equal(result.timerOwned, true);
            assert.equal(f.controller.diagnostics().launchPrimarySet, true);
            assert.equal(
                result.reservation,
                ['ack-then-throw', 'late-error', 'child-error'].includes(mode) ? 'none' : 'unknown',
            );
            if (mode === 'accepted-socket') {
                assert.equal(f.controller.diagnostics().retainedSockets, 1);
                assert.equal(f.accepted.destroyCalls, 1);
            }
            assert.equal(result.wholeGroupRetirement, false);
            assert.equal(result.successorVerified, false);
            assert.doesNotMatch(JSON.stringify(result), /private-late-error|private-child-error/);
        } finally {
            await join(f, running);
        }
    }
});

test('custom config uses the captured validated appData and neither later mutation nor desktop input redirects it', async () => {
    const f = await launchFixture(),
        expected = f.plan.host.appData;
    assert.notEqual(expected, f.plan.host.home + '/.config');
    f.plan.host.appData = '/home/test/foreign-config';
    f.desktop.XDG_CONFIG_HOME = '/home/test/injected';
    const running = watch(f.controller.run());
    try {
        await active(f, running);
        assert.equal(f.requests[0].environment.XDG_CONFIG_HOME, expected);
        f.close();
        assert.equal((await running.operation).reservation, 'none');
    } finally {
        await join(f, running);
    }
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HOME', 'PATH']) {
        const g = await launchFixture(),
            at = g.calls.length;
        let getters = 0;
        const desktop = Object.defineProperty({ DISPLAY: ':99' }, key, {
            enumerable: true,
            get() {
                getters++;
                return '/home/test/foreign';
            },
        });
        assert.throws(
            () =>
                createLinuxOwnedLaunch(
                    g.plan,
                    { startedMs: 0, deadlineMs: 120000 },
                    desktop,
                    g.ops,
                    g.host,
                ),
            /LINUX_LAUNCH_ENVIRONMENT/,
        );
        assert.equal(getters, 0);
        assert.equal(g.calls.length, at);
        assert.equal(g.requests.length, 0);
    }
});

test('timer cancellation failure after known release retains its actual timer owner without retrying release', async () => {
    for (const thrown of [Error('private-cancel-error'), undefined]) {
        const f = await launchFixture(),
            cancel = f.ops.cancel;
        let calls = 0,
            outerTimer: unknown;
        f.ops.cancel = (timer: any) => {
            if (timer === outerTimer) {
                calls++;
                throw thrown;
            }
            return cancel(timer);
        };
        // Host methods were captured at construction; construct this invocation against the selected failing port.
        f.controller = createLinuxOwnedLaunch(
            f.plan,
            { startedMs: 0, deadlineMs: 120000 },
            f.desktop,
            f.ops,
            f.host,
        );
        const running = watch(f.controller.run());
        try {
            await phase(f, 'spawn-event');
            outerTimer = Array.from(f.timers.keys())[0];
            assert.ok(outerTimer);
            f.addChild();
            f.child.emit('spawn');
            await phase(f, 'child-and-pipe-close');
            f.close();
            const result = await running.operation;
            assert.equal(result.verdict, 'RETAINED_UNKNOWN');
            assert.equal(result.reservation, 'none');
            assert.equal(f.server.listening, false);
            assert.equal(result.timerOwned, true);
            assert.equal(calls, 1);
            assert.equal(f.server.closed, 2);
            assert.equal(f.controller.diagnostics().launchPrimarySet, true);
        } finally {
            await join(f, running);
        }
    }
});
