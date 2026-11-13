/** Actual coordinator in a closed VM. Ports below are memory controls only:
 * no native helper, PTY, process, physical filesystem mutation or release evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';
import ts from 'typescript';

const source = readFileSync(
    new URL('../scripts/linux-owned-second-seal-fixture.ts', import.meta.url),
    'utf8',
);
const tree = ts.createSourceFile('coordinator.ts', source, ts.ScriptTarget.ES2022, true);
assert.equal(
    (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
// The direct CLI is intentionally excluded; every executable declaration is the
// actual source, and require is a literal closed import map below.
assert.ok(ts.isIfStatement(tree.statements.at(-1)!));
const body = tree.statements
    .slice(0, -1)
    .map((node) => node.getText(tree))
    .join('\n');
const compiled = ts.transpileModule(body + '\nexports.memoryRetained = retained;', {
    fileName: 'coordinator.ts',
    reportDiagnostics: true,
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
});
assert.equal(
    (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).length,
    0,
);
const script = new vm.Script(compiled.outputText, { filename: 'actual-second-seal.memory.cjs' });
const args = [
    '--a-appdir',
    '/memory/a',
    '--a-archive',
    '/memory/a.tar',
    '--b-appdir',
    '/memory/b',
    '--b-archive',
    '/memory/b.tar',
    '--fixture-root',
    '/memory/fixture',
    '--c-appdir',
    '/memory/c',
    '--c-archive',
    '/memory/c.tar',
];
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const health = () => ({
    failed: false,
    pending: null,
    retainedFDs: 0,
    retainedDirs: 0,
    retainedServers: 0,
    retainedSockets: 0,
    retainedTimers: 0,
});
const closed = () => ({ closed: true, failed: false });
function finalCustody() {
    return {
        phase: 'finished',
        primarySet: false,
        native: { failed: false, retainedFDs: 0 },
        backend: { backend: health() },
        launch: {
            verdict: 'DIRECT_CHILD_CLOSED_RETAINED',
            code: 'DIRECT_CLOSE_NO_SUCCESSOR_AUTHORITY',
            pending: null,
            reservation: 'none',
            childOwned: false,
            timerOwned: false,
            spawned: true,
            identityObserved: true,
            exited: true,
            closed: true,
            retainedConfirmed: true,
            initialConfirmed: false,
            sealRecovered: false,
            sealInterrupted: false,
            pipes: { stdout: { end: true, close: true }, stderr: { end: true, close: true } },
            readback: closed(),
            quitControl: closed(),
        },
    };
}
function memory() {
    const events: string[] = [],
        timers = new Map<object, { at: number; callback: () => void }>(),
        intervals = new Set<object>(),
        products = new WeakMap<object, any>();
    const state = {
        now: 100,
        deadline: 540100,
        events,
        pendingProducer: null as ReturnType<typeof deferred<unknown>> | null,
        pendingProduct: null as ReturnType<typeof deferred<any>> | null,
        producerReturn: undefined as unknown,
        failAt: '',
        thrown: undefined as unknown,
        cancelAt: '',
        mutate: null as ((stage: string, custody: any) => void) | null,
        getters: 0,
        records: [] as any[],
        contextDrift: false,
    };
    const effect = (stage: string) => {
        events.push(stage);
        if (state.failAt === stage) throw state.thrown;
    };
    const identity = {
        root: '/memory/fixture/installed',
        appData: '/memory/fixture/profile',
        dataHome: '/memory/fixture/data',
        sourceCommit: 'a'.repeat(40),
        runId: '1',
        runAttempt: '1',
        copies: [],
        records: [],
    };
    const bResult = Object.freeze({}),
        cResult = Object.freeze({});
    const b = Object.freeze({
        ...identity,
        deadlineMs: state.deadline,
        host: { version: '0.6.0' },
        revalidateCopies() {
            effect('b-copies');
        },
        updateToCurrentC() {
            effect('c-update');
            return Promise.resolve(cResult);
        },
    });
    const c = Object.freeze({
        ...identity,
        deadlineMs: state.deadline,
        host: { version: '0.6.1-qualification.0' },
        revalidateCopies() {
            effect('c-copies');
        },
        capturePublishedC() {
            effect('c-published');
            return { memoryOnly: true };
        },
        revalidateAfterUninstall() {
            effect('c-removed');
            return { memoryOnly: true };
        },
        writeSecondSealUninstallRecord(raw: Buffer) {
            effect('record');
            state.records.push(JSON.parse(raw.toString()));
            return { path: '/memory/record', bytes: raw.length, sha256: 'b'.repeat(64) };
        },
    });
    const product = (choices: any, mode?: string) => {
        const stage =
            choices.operation === 'uninstall-current'
                ? 'uninstall'
                : choices.version === '0.6.0'
                  ? 'b-finalize'
                  : 'c-finalize';
        effect(stage);
        assert.equal(mode, stage === 'uninstall' ? undefined : 'normal-finalize');
        const custody: any =
            stage === 'uninstall'
                ? {
                      phase: 'finished',
                      primarySet: false,
                      native: { failed: false, retainedFDs: 0 },
                      uninstall: {
                          primarySet: false,
                          pending: null,
                          reservation: 'none',
                          backend: health(),
                      },
                  }
                : finalCustody();
        const result: any = {
            status:
                stage === 'uninstall' ? 'current-payload-removed' : 'previous-generation-finalized',
            owner: Object.freeze({}),
            result: {
                profileRetained: true,
                originalRecordsRetained: true,
                priorRecoveryPayloadsRemoved: false,
            },
        };
        if (state.cancelAt === stage) {
            result.status = 'cancelled';
            custody.phase = 'cancelled';
            delete custody.launch;
        }
        state.mutate?.(stage, custody);
        products.set(result.owner, custody);
        return state.pendingProduct ? state.pendingProduct.promise : Promise.resolve(result);
    };
    const modules = new Map<string, unknown>([
        ['node:path', {}],
        ['node:url', {}],
        ['node:util', { types: utilTypes }],
        [
            './linux-owned-installation-fixture.ts',
            {
                linuxOwnedFixtureArguments(selected: string[]) {
                    assert.equal(selected.length, 16);
                    assert.deepEqual(Array.from(selected.slice(-2)), [
                        '--scenario',
                        'current-b-with-c',
                    ]);
                },
                runLinuxOwnedInstallationFixture() {
                    effect('producer');
                    return state.producerReturn !== undefined
                        ? state.producerReturn
                        : state.pendingProducer
                          ? state.pendingProducer.promise
                          : Promise.resolve(bResult);
                },
                getLinuxOwnedCurrentBWithCFixtureContext(value: unknown) {
                    effect('b-context');
                    assert.equal(value, bResult);
                    return b;
                },
                getLinuxOwnedCurrentCFixtureContext(value: unknown) {
                    effect('c-context');
                    assert.equal(value, cResult);
                    return state.contextDrift
                        ? Object.freeze({ ...c, root: '/memory/foreign' })
                        : c;
                },
            },
        ],
        [
            '../electron/linux-permanent-setup.ts',
            {
                linuxPermanentArguments(selected: string[]) {
                    return { root: selected[1], version: selected[3], operation: selected[5] };
                },
                runLinuxPermanentOwnedFixture(
                    _host: unknown,
                    choices: any,
                    _data: unknown,
                    _prompts: unknown,
                    _desktop: unknown,
                    mode: string,
                ) {
                    return product(choices, mode);
                },
                runLinuxPermanentSetup(_host: unknown, choices: any) {
                    return product(choices);
                },
                linuxPermanentSetupDiagnostics(owner: object) {
                    assert.ok(products.has(owner));
                    return products.get(owner);
                },
            },
        ],
        [
            '../electron/linux-setup-prompts.ts',
            {
                linuxTerminalPrompt() {
                    return {
                        async review() {
                            throw Error('Unexpected prompt port invocation');
                        },
                        hasPending: () => false,
                    };
                },
            },
        ],
    ]);
    for (const node of tree.statements)
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
            assert.ok(
                ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
            );
    const module = { exports: {} as any };
    script.runInContext(
        vm.createContext(
            {
                module,
                exports: module.exports,
                Buffer,
                Promise,
                Object,
                Set,
                Map,
                Error,
                performance: { now: () => state.now },
                process: {
                    platform: 'linux',
                    arch: 'x64',
                    getuid: () => 1000,
                    geteuid: () => 1000,
                    stdin: { isTTY: true },
                    stdout: { isTTY: true },
                    env: { DISPLAY: ':memory' },
                },
                setTimeout(callback: () => void, delay: number) {
                    const key = {};
                    timers.set(key, { at: state.now + delay, callback });
                    return key;
                },
                clearTimeout(key: object) {
                    timers.delete(key);
                },
                setInterval() {
                    const key = {};
                    intervals.add(key);
                    return key;
                },
                require(name: string) {
                    assert.ok(modules.has(name));
                    return modules.get(name);
                },
            },
            { codeGeneration: { strings: false, wasm: false } },
        ),
        { timeout: 1000 },
    );
    return {
        api: module.exports,
        state,
        bResult,
        cResult,
        products,
        timers,
        intervals,
        run: () => module.exports.runLinuxOwnedSecondSealFixture([...args]),
        expire() {
            state.now = 540100;
            for (const timer of [...timers.values()]) if (timer.at <= state.now) timer.callback();
        },
        retained() {
            const all = [...module.exports.memoryRetained];
            assert.equal(all.length, 1);
            return all[0];
        },
    };
}
test('memory coordinator performs actual fixed call ordering and retains honest scoped output', async () => {
    const f = memory(),
        result = await f.run();
    assert.equal(result.status, 'completed-controlled-second-seal-uninstall');
    assert.deepEqual(
        f.state.events.filter((s) => !s.endsWith('copies')),
        [
            'producer',
            'b-context',
            'b-finalize',
            'c-update',
            'c-context',
            'c-finalize',
            'c-published',
            'uninstall',
            'c-removed',
            'record',
        ],
    );
    assert.equal(f.state.records.length, 1);
    assert.equal(f.state.records[0].products.length, 3);
    for (const key of ['releaseAcceptance', 'physicalLoadedByteProof', 'wholeGroupRetirement'])
        assert.equal(f.state.records[0][key], false);
    assert.equal(f.api.memoryRetained.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
});
test('memory coordinator rejects proxy/accessor/extra arguments without observing their getters', () => {
    const f = memory();
    let reads = 0;
    const accessor = [...args];
    Object.defineProperty(accessor, '1', {
        get() {
            reads++;
            throw Error('getter');
        },
    });
    const extra = [...args] as any;
    extra.unexpected = true;
    for (const value of [
        new Proxy([...args], {
            get() {
                reads++;
                throw Error('proxy');
            },
        }),
        accessor,
        extra,
        args.slice(2),
        [...args.slice(0, -2), '--scenario', 'current-b'],
    ])
        assert.throws(
            () => f.api.linuxOwnedSecondSealFixtureArguments(value),
            /SECOND_SEAL_ARGUMENT/,
        );
    assert.equal(reads, 0);
    assert.deepEqual(f.state.events, []);
});
test('memory coordinator halts known cancellation at each product stage without later actions', async () => {
    for (const stage of ['b-finalize', 'c-finalize', 'uninstall']) {
        const f = memory();
        f.state.cancelAt = stage;
        assert.equal((await f.run()).status, 'cancelled');
        assert.equal(
            f.state.events.at(-2)?.endsWith('copies') || f.state.events.at(-1)?.endsWith('copies'),
            true,
        );
        assert.equal(f.state.events.includes('record'), false);
        assert.equal(f.api.memoryRetained.size, 0);
        assert.equal(f.timers.size, 0);
        if (stage === 'b-finalize') assert.equal(f.state.events.includes('c-update'), false);
        if (stage === 'c-finalize') assert.equal(f.state.events.includes('uninstall'), false);
    }
});
test('memory coordinator preserves exact falsey primary errors and original issued objects', async () => {
    for (const primary of [undefined, null, false, 0]) {
        const f = memory();
        f.state.failAt = 'c-update';
        f.state.thrown = primary;
        assert.equal((await f.run()).status, 'retained-nonpassing');
        const held = f.retained();
        assert.equal(held.primarySet, true);
        assert.equal(held.primary, primary);
        assert.equal(held.products.length, 1);
        assert.equal(held.contexts.length, 1);
        assert.equal(f.state.events.includes('c-finalize'), false);
    }
});
test('memory coordinator does not inspect or assimilate an unsupported thenable', async () => {
    const f = memory();
    let reads = 0;
    const value = Object.defineProperty({}, 'then', {
        get() {
            reads++;
            throw Error('must not read');
        },
    });
    f.state.producerReturn = value;
    assert.equal((await f.run()).status, 'retained-nonpassing');
    assert.equal(reads, 0);
    assert.equal(f.retained().issues[0].value, value);
    assert.equal(f.state.events.includes('b-context'), false);
});
test('memory coordinator retains deadline-pending promise and adopts late completion without continuing', async () => {
    const f = memory();
    const pending = deferred<unknown>();
    f.state.pendingProducer = pending;
    const running = f.run();
    f.expire();
    assert.equal((await running).status, 'retained-nonpassing');
    const held = f.retained();
    assert.equal(held.pending.promise, pending.promise);
    const first = held.primary;
    pending.resolve(f.bResult);
    await held.execution;
    assert.equal(held.primary, first);
    assert.equal(held.returned.includes(f.bResult), true);
    assert.equal(f.state.events.includes('b-context'), false);
});
test('memory coordinator refuses context identity drift before C product effects', async () => {
    const f = memory();
    f.state.contextDrift = true;
    assert.equal((await f.run()).status, 'retained-nonpassing');
    assert.equal(f.retained().contexts.length, 2);
    assert.equal(f.state.events.includes('c-finalize'), false);
});
test('memory coordinator requires independent root pipe inspector and control closure facts', async () => {
    for (const corrupt of [
        (d: any) => {
            d.launch.exited = false;
        },
        (d: any) => {
            d.launch.pipes.stderr.close = false;
        },
        (d: any) => {
            d.launch.readback.failed = true;
        },
        (d: any) => {
            d.launch.quitControl.closed = false;
        },
        (d: any) => {
            d.launch.retainedConfirmed = false;
        },
        (d: any) => {
            d.backend.backend.retainedFDs = 1;
        },
    ]) {
        const f = memory();
        f.state.mutate = (stage, custody) => {
            if (stage === 'b-finalize') corrupt(custody);
        };
        assert.equal((await f.run()).status, 'retained-nonpassing');
        assert.equal(f.retained().products.length, 1);
        assert.equal(f.state.events.includes('c-update'), false);
    }
});
test('memory coordinator preserves published/removed readback and failed final-write custody', async () => {
    for (const stage of ['c-published', 'c-removed', 'record']) {
        const f = memory();
        const error = Error(stage);
        f.state.failAt = stage;
        f.state.thrown = error;
        assert.equal((await f.run()).status, 'retained-nonpassing');
        assert.equal(f.retained().primary, error);
        assert.equal(f.retained().pending.error, error);
        assert.equal(f.state.records.length, 0);
        if (stage === 'c-published') assert.equal(f.state.events.includes('uninstall'), false);
    }
});
