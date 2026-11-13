/** Actual producer continuation/registration under closed memory ports. No real
 * adapter, filesystem actor, PTY, process, native helper or installation executes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';
import ts from 'typescript';
import { fixtureA, fixtureB, fixtureC } from '../scripts/lib/linux-owned-fixture-records.ts';
const text = readFileSync(
    new URL('../scripts/linux-owned-installation-fixture.ts', import.meta.url),
    'utf8',
);
const tree = ts.createSourceFile('actual-producer.ts', text, ts.ScriptTarget.ES2022, true);
const found = new Map<string, ts.Node[]>();
function visit(node: ts.Node) {
    const name = ts.isFunctionDeclaration(node)
        ? node.name?.text
        : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          ? node.name.text
          : undefined;
    if (name) found.set(name, [...(found.get(name) ?? []), node]);
    ts.forEachChild(node, visit);
}
visit(tree);
function actual(name: string) {
    let matches = found.get(name) ?? [];
    if (name === 'nonpassing') {
        const execute = (found.get('executeLinuxOwnedInstallationFixture') ?? [])[0];
        assert.ok(execute && ts.isFunctionDeclaration(execute) && execute.body);
        matches = matches.filter(
            (node) => ts.isVariableDeclaration(node) && node.parent.parent.parent === execute.body,
        );
    }
    assert.equal(matches.length, 1, 'One actual declaration: ' + name);
    const node = matches[0];
    return ts.isVariableDeclaration(node)
        ? 'const ' + node.getText(tree) + ';'
        : node.getText(tree);
}
const code =
    [
        'need',
        'owners',
        'currentCContexts',
        'getLinuxOwnedCurrentCFixtureContext',
        'fail',
        'unknown',
        'hold',
        'gate',
        'nonpassing',
        'effect',
        'checked',
        'writeFinal',
        'updateToCurrentC',
    ]
        .map(actual)
        .join('\n') +
    '\nexports.memory={update:updateToCurrentC,writeFinal,get:getLinuxOwnedCurrentCFixtureContext,owners};';
const compiled = ts.transpileModule(code, {
    fileName: 'actual-c-custody.ts',
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.equal(
    (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).length,
    0,
);
const script = new vm.Script(compiled.outputText, { filename: 'actual-c-custody.memory.cjs' });
function deferred() {
    let resolve!: (value: any) => void, reject!: (value: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function model() {
    const state: any = {
        phase: 'current-b-originals',
        retired: true,
        failed: false,
        firstSet: false,
        first: undefined,
        lateFailure: null,
        fds: new Set(),
        pending: new Set(),
        returns: [],
        childSubmitted: false,
        child: null,
        envelopes: [],
        cUpdateIssued: false,
        cRecordIssued: false,
        cRecordUnsettled: false,
        sealRecordUnsettled: false,
        sealRecoveryRecordUnsettled: false,
        keeper: null,
    };
    const config = {
        now: 1000,
        pending: null as ReturnType<typeof deferred> | null,
        failureSet: false,
        failure: undefined as unknown,
        calls: 0,
        updateCalls: [] as unknown[][],
        services: null as any,
        lateValue: null as any,
        writes: 0,
        writeFailure: false,
    };
    const timers = new Map<object, { callback: () => void; delay: number }>(),
        intervals = new Set<object>();
    const commit = 'a'.repeat(40),
        facts = {
            root: '/memory/f/installed',
            appData: '/memory/f/config',
            dataHome: '/memory/f/data',
            sourceCommit: commit,
            runId: '1',
            runAttempt: '1',
        };
    const noIO = () => {
        throw Error('UNEXPECTED_PHYSICAL_PORT');
    };
    const readback = {
        records: { memoryOnly: true },
        capturePublishedC: noIO,
        revalidateAfterUninstall: noIO,
        writeSecondSealUninstallRecord: noIO,
    };
    const module = { exports: {} as any };
    let written: Buffer | null = null;
    script.runInContext(
        vm.createContext(
            {
                module,
                exports: module.exports,
                Promise,
                Object,
                Set,
                WeakMap,
                Buffer,
                Error,
                utilTypes,
                path,
                state,
                A: fixtureA,
                B: fixtureB,
                C: fixtureC,
                inputOriginals: [],
                started: 0,
                until: 540000,
                performance: { now: () => config.now },
                root: '/memory/f',
                target: facts.root,
                appData: facts.appData,
                dataHome: facts.dataHome,
                repo: '/memory/repo',
                commit,
                runId: '1',
                runAttempt: '1',
                uid: 1000,
                work: '/memory/f/work',
                id: 'memory-id',
                facts,
                a: {},
                b: { outputRoot: '/memory/b', version: '0.6.0' },
                c: { outputRoot: '/memory/c', version: '0.6.1-qualification.0' },
                updated: {
                    originalManifest: Buffer.from('B'),
                    record: { installationId: 'memory-id' },
                    work: '/memory/f/work',
                    journal: { transactionId: 'memory-b' },
                },
                host: (plan: any) =>
                    Object.freeze({ sourceRoot: plan.outputRoot, version: plan.version }),
                structuredClone,
                fs: { lstatSync: noIO, readdirSync: noIO },
                ancestry: noIO,
                tree: noIO,
                write(name: string, value: Buffer) {
                    assert.equal(name, 'records/second-seal-uninstall.json');
                    assert.equal(state.cRecordUnsettled, true);
                    config.writes++;
                    if (config.writeFailure) {
                        state.fds.add(77);
                        throw config.failure;
                    }
                    written = Buffer.from(value);
                    return {
                        path: '/memory/f/' + name,
                        bytes: value.length,
                        sha256: 'b'.repeat(64),
                    };
                },
                payload: noIO,
                bytes(file: string) {
                    if (file === '/memory/f/records/second-seal-uninstall.json') {
                        assert.ok(written);
                        return Buffer.from(written);
                    }
                    assert.equal(file, '/memory/repo/.git/HEAD');
                    return Buffer.from(commit + '\n');
                },
                revalidateInputs() {
                    if (state.failed) throw Error('FIXTURE_FROZEN_OR_DEADLINE');
                },
                operation(...args: unknown[]) {
                    config.updateCalls.push(args);
                    return Promise.resolve();
                },
                snapshot(label: string, plan: unknown) {
                    assert.equal(label, 'updated-c');
                    assert.ok(plan);
                    return {
                        record: { installationId: 'memory-id' },
                        journal: { transactionId: 'memory-c' },
                    };
                },
                runOwnedCurrentC(services: unknown) {
                    config.calls++;
                    config.services = services;
                    if (config.failureSet) return Promise.reject(config.failure);
                    return config.pending ? config.pending.promise : Promise.resolve(readback);
                },
                setTimeout(callback: () => void, delay: number) {
                    const key = {};
                    timers.set(key, { callback, delay });
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
                clearInterval(key: object) {
                    intervals.delete(key);
                },
            },
            { codeGeneration: { strings: false, wasm: false } },
        ),
        { timeout: 1000 },
    );
    return { api: module.exports.memory, state, config, timers, intervals, readback };
}
test('actual C producer uses original remaining deadline and one-use state before a second getter can retry', async () => {
    const f = model(),
        pending = deferred();
    f.config.pending = pending;
    const running = f.api.update();
    assert.equal(f.state.cUpdateIssued, true);
    assert.equal([...f.timers.values()][0].delay, 539000);
    assert.throws(() => f.api.update(), /FIXTURE_C_UPDATE_ONCE/);
    assert.equal(f.config.calls, 1);
    pending.resolve(f.readback);
    const result = await running;
    const context = f.api.get(result);
    assert.equal(context.deadlineMs, 540000);
    assert.equal(context.host.version, '0.6.1-qualification.0');
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
});
test('actual C registrar refuses foreign serialized and proxy results without physical ports', async () => {
    const f = model(),
        result = await f.api.update();
    assert.equal(f.api.get(result).root, '/memory/f/installed');
    for (const value of [{ ...result }, {}, new Proxy(result, {}), null, false])
        assert.throws(() => f.api.get(value), /FIXTURE_CURRENT_C_RESULT_REQUIRED/);
});
test('actual C producer preserves falsey adapter failure and does not register or retry it', async () => {
    for (const failure of [undefined, null, false]) {
        const f = model();
        f.config.failureSet = true;
        f.config.failure = failure;
        const result = await f.api.update();
        assert.equal(result.status, 'retained-nonpassing');
        assert.equal(f.state.firstSet, true);
        assert.equal(f.state.first, failure);
        assert.throws(() => f.api.get(result), /FIXTURE_CURRENT_C_RESULT_REQUIRED/);
        assert.throws(() => f.api.update(), /FIXTURE_FROZEN_OR_DEADLINE/);
        assert.equal(f.config.calls, 1);
    }
});
test('actual C producer keeps pending and late adapter custody after public deadline without admitting a result', async () => {
    const f = model(),
        pending = deferred();
    f.config.pending = pending;
    const running = f.api.update(),
        owner = [...f.api.owners].find((x: any) => x.outcome !== null) as any;
    assert.equal(f.state.returns.includes(pending.promise), true);
    f.config.now = 540000;
    [...f.timers.values()][0].callback();
    const result = await running;
    assert.equal(result.status, 'retained-nonpassing');
    assert.equal(owner.pending, true);
    const first = f.state.first;
    pending.resolve(f.readback);
    await owner.outcome;
    assert.equal(owner.pending, false);
    assert.equal(f.state.first, first);
    assert.equal(
        f.state.returns.includes(f.readback),
        true,
        'Late readback must remain in its original owner.',
    );
    assert.throws(() => f.api.get(result), /FIXTURE_CURRENT_C_RESULT_REQUIRED/);
    assert.equal(f.config.calls, 1);
});

test('actual fixed writer keeps one-use original bytes and unresolved descriptor custody without retry', () => {
    const f = model(),
        bytes = Buffer.from('original');
    const record = f.api.writeFinal(bytes);
    bytes.fill(0);
    assert.equal(record.bytes, 8);
    assert.equal(f.state.returns[0].toString(), 'original');
    assert.equal(f.state.cRecordUnsettled, false);
    assert.throws(() => f.api.writeFinal(Buffer.from('again')), /FIXTURE_C_RECORD_INPUT/);
    assert.equal(f.config.writes, 1);
    const failed = model();
    failed.config.writeFailure = true;
    failed.config.failure = undefined;
    let caught = false;
    try {
        failed.api.writeFinal(Buffer.from('keep'));
    } catch (error) {
        caught = true;
        assert.equal(error, undefined);
    }
    assert.equal(caught, true);
    assert.equal(failed.state.cRecordUnsettled, true);
    assert.equal(failed.state.fds.has(77), true);
    assert.equal(failed.state.returns[0].toString(), 'keep');
    assert.throws(() => failed.api.writeFinal(Buffer.from('retry')), /FIXTURE_C_RECORD_INPUT/);
    assert.equal(failed.config.writes, 1);
    assert.equal(failed.state.fds.has(77), true);
});
