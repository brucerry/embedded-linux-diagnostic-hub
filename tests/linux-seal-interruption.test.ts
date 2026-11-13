/** Opaque cooperative-seal selection controls. Authored MapFS samples are unit inputs, never native evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { readFileSync } from 'node:fs';
import * as model from '../electron/linux-transaction-model.ts';
import * as installation from '../shared/installation.ts';

const root = new URL('../', import.meta.url),
    sourceURL = new URL('electron/linux-retained-cleanup.ts', root),
    maintenanceURL = new URL('electron/installation-maintenance.ts', root),
    admitted = new Set([sourceURL.href, maintenanceURL.href]),
    read = (url: URL) => {
        assert.ok(admitted.has(url.href));
        return readFileSync(url, 'utf8');
    };
const maintenanceTree = ts.createSourceFile(
        'fixed-maintenance.ts',
        read(maintenanceURL),
        ts.ScriptTarget.ES2022,
        true,
    ),
    declarations = maintenanceTree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'SETUP_OWNER');
assert.equal(declarations.length, 1);
assert.ok(declarations[0].initializer && ts.isStringLiteral(declarations[0].initializer));
const SETUP_OWNER = declarations[0].initializer.text;
const source = read(sourceURL),
    tree = ts.createSourceFile('linux-retained-cleanup.ts', source, ts.ScriptTarget.ES2022, true),
    modules = new Map<string, unknown>([
        ['node:path', path],
        ['node:crypto', { createHash }],
        ['node:util', { types: utilTypes }],
        ['./linux-transaction-model.ts', model],
        ['../shared/installation.ts', installation],
        ['./installation-maintenance.ts', { SETUP_OWNER }],
    ]);
assert.equal(
    (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
for (const node of tree.statements)
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
        assert.ok(
            ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
            'Closed runtime import.',
        );
const compiled = ts.transpileModule(source, {
    fileName: 'linux-retained-cleanup.ts',
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
const module = { exports: {} as any },
    refuse = () => {
        throw Error('UNADMITTED_REAL_PORT');
    },
    context = vm.createContext(
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
new vm.Script(compiled.outputText, { filename: 'linux-retained-cleanup.memory.cjs' }).runInContext(
    context,
    { timeout: 1000 },
);
const createLinuxRetainedCleanup = module.exports.createLinuxRetainedCleanup;
assert.equal(typeof createLinuxRetainedCleanup, 'function');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex'),
    clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)),
    id = '11111111-1111-4111-8111-111111111111',
    txA = '22222222-2222-4222-8222-222222222222',
    txB = '33333333-3333-4333-8333-333333333333';
type Node = {
    path: string;
    kind: 'file' | 'directory' | 'link';
    ino: number;
    uid: number;
    mode: number;
    nlink: number;
    bytes: Buffer;
};

const api = module.exports;
const fixtureURL = new URL('tests/linux-retained-cleanup.test.ts', root),
    fixtureSource = readFileSync(fixtureURL, 'utf8');
assert.equal(
    hash(fixtureSource),
    'b888f67c70484179ad387e0c266802258fab770532df84ffe02718df570113ae',
);
const fixtureTree = ts.createSourceFile(
        'fixed-cleanup-fixture.ts',
        fixtureSource,
        ts.ScriptTarget.ES2022,
        true,
    ),
    memories = fixtureTree.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'memory',
    );
assert.equal(memories.length, 1);
const fixtureCompiled = ts.transpileModule(
    memories[0].getText(fixtureTree) + '\nglobalThis.fixedMemory = memory;',
    {
        fileName: 'fixed-cleanup-fixture.ts',
        reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
);
assert.equal(
    (fixtureCompiled.diagnostics ?? []).filter(
        (item) => item.category === ts.DiagnosticCategory.Error,
    ).length,
    0,
);
const fixtureContext = vm.createContext(
    {
        assert,
        path,
        installation,
        model,
        createHash,
        Buffer,
        Object,
        JSON,
        Map,
        Set,
        Promise,
        hash,
        clone,
        id,
        txA,
        txB,
        SETUP_OWNER,
        createLinuxRetainedCleanup,
        process: Object.freeze({}),
        setTimeout: refuse,
        clearTimeout: refuse,
    },
    { codeGeneration: { strings: false, wasm: false } },
);
new vm.Script(fixtureCompiled.outputText, {
    filename: 'fixed-memory-only-fixture.cjs',
}).runInContext(fixtureContext, { timeout: 1000 });
const memory: () => any = (fixtureContext as any).fixedMemory;

/** Explicitly authored unit preimage. Actual native publication is tested only by the real
 * backend/owned-launch route; no native or durable-filesystem result is claimed here. */
async function preparingSample() {
    const f = memory(),
        plan = {
            ...clone(f.configuration),
            consent: true,
            review: clone(f.view),
            reviewSHA256: model.linuxModelReviewSHA256(f.view),
        },
        cleanup = f.create(),
        complete = await cleanup.run(await cleanup.inspect()),
        snapshotSHA256 = hash(complete.rawSnapshot),
        original = f.io.stat(f.work + '/journal.json'),
        confirmed = Buffer.from(
            JSON.stringify({ ...complete.snapshot.initial.journal, phase: 'candidate-confirmed' }),
        );
    f.file(f.ledger + '/original-journal.json', f.rawB);
    f.io.move(f.work + '/completed-journal.json', f.ledger + '/original-completed-journal.json', {
        path: 'completed-journal.json',
        kind: 'file',
        ...f.io.stat(f.work + '/completed-journal.json'),
    });
    f.file(f.ledger + '/confirmed-journal.json', Buffer.alloc(0));
    const staged = f.io.stat(f.ledger + '/confirmed-journal.json'),
        intent = {
            schemaVersion: 1,
            root: plan.root,
            installationId: plan.installationId,
            transactionId: plan.transactionId,
            uid: plan.host.uid,
            snapshotSHA256,
            original: {
                path: 'journal.json',
                kind: 'file',
                dev: original.dev,
                ino: original.ino,
                uid: original.uid,
                mode: original.mode,
                bytes: original.size,
                sha256: hash(f.rawB),
            },
            staged: {
                path: 'confirmed-journal.json',
                kind: 'file',
                dev: staged.dev,
                ino: staged.ino,
                uid: staged.uid,
                mode: staged.mode,
                bytes: confirmed.length,
                sha256: hash(confirmed),
            },
        };
    f.file(f.ledger + '/seal-intent.json', JSON.stringify(intent));
    const intentSHA256 = hash(JSON.stringify(intent)),
        view = clone(complete.snapshot.initial);
    view.previous = null;
    view.activity.root = 'active';
    view.history.cleanup = {
        configuration: clone(complete.snapshot.configuration),
        initial: clone(complete.snapshot.initial),
        snapshotSHA256,
        entries: complete.snapshot.entries.length,
        progress: { phase: 'complete', index: complete.snapshot.entries.length, leaf: 'source' },
        seal: { intentSHA256, state: 'preparing' },
    };
    const read = () => ({
        view: clone(view),
        cleanup: f.create().stored(),
        staged: { ...intent.staged, bytes: 0, sha256: hash(Buffer.alloc(0)) },
        fileDescriptors: 0,
        directories: 0,
        pending: null,
    });
    return { f, plan, read, view, intent, intentSHA256, snapshotSHA256 };
}

function bound(
    sample: Awaited<ReturnType<typeof preparingSample>>,
    change: (value: any) => any = (value) => value,
) {
    const selection = api.createLinuxSealInterruptionSelection();
    let reads = 0;
    const publisher = api.bindLinuxSealInterruption(selection, sample.plan, () => {
        reads++;
        return change(sample.read());
    });
    return { selection, publisher, reads: () => reads };
}

test('opaque selections bind once to a real checked plan and refuse plain objects', async () => {
    const sample = await preparingSample(),
        selection = api.createLinuxSealInterruptionSelection();
    assert.equal(Object.keys(selection).length, 0);
    assert.equal(api.isLinuxSealInterruption({}), false);
    for (const invalid of [false, null, 0, ''])
        assert.throws(
            () => api.bindLinuxSealInterruption(invalid, sample.plan, sample.read),
            /SELECTION/,
        );
    assert.throws(() => api.bindLinuxSealInterruption({}, sample.plan, sample.read), /SELECTION/);
    assert.throws(
        () =>
            api.bindLinuxSealInterruption(
                JSON.parse(JSON.stringify(selection)),
                sample.plan,
                sample.read,
            ),
        /SELECTION/,
    );
    const publisher = api.bindLinuxSealInterruption(selection, sample.plan, sample.read);
    assert.equal(publisher.diagnostics().phase, 'bound');
    assert.throws(
        () => api.bindLinuxSealInterruption(selection, sample.plan, sample.read),
        /SELECTION/,
    );
});

test('only a complete preparing observation yields a source-owned cooperative pause with no qualification claims', async () => {
    const sample = await preparingSample(),
        state = bound(sample),
        at = sample.f.calls.length,
        result = state.publisher.pause(),
        observation = state.publisher.observation(result);
    assert.equal(api.isLinuxSealInterruption(result), true);
    assert.equal(Object.keys(result).length, 0);
    assert.equal(observation.kind, 'cooperative-seal-preparing-pause');
    assert.equal(observation.nativeQualified, false);
    assert.equal(observation.releaseAcceptance, false);
    assert.equal(observation.abruptInterruptionObserved, false);
    assert.equal(observation.cleanup.seal.state, 'preparing');
    assert.equal(observation.cleanup.seal.intentSHA256, sample.intentSHA256);
    assert.equal(observation.cleanup.progress.snapshotSHA256, sample.snapshotSHA256);
    assert.equal(observation.staged.bytes, 0);
    assert.deepEqual(observation.cleanup.rawSnapshot, sample.read().cleanup.rawSnapshot);
    assert.equal(
        sample.f.calls
            .slice(at)
            .some((call: any) => ['write', 'move', 'remove', 'mkdir'].includes(call.name)),
        false,
    );
    assert.equal(state.reads(), 1);
});

test('a pause belongs to one backend publisher and mutable samples cannot change its retained originals', async () => {
    const sample = await preparingSample(),
        first = bound(sample),
        second = bound(sample),
        result = first.publisher.pause();
    assert.throws(() => second.publisher.observation(result), /OWNER/);
    assert.throws(() => first.publisher.observation({}), /OWNER/);
    const before = first.publisher.observation(result),
        digest = hash(before.cleanup.rawSnapshot);
    before.cleanup.rawSnapshot[0] ^= 1;
    before.view.root.manifest.version = '9.9.9';
    before.staged.ino++;
    sample.view.root.identity.ino++;
    const again = first.publisher.observation(result);
    assert.equal(hash(again.cleanup.rawSnapshot), digest);
    assert.equal(again.view.root.manifest.version, '0.7.0');
    assert.equal(again.view.root.identity.ino, sample.plan.review.root.identity.ino);
    assert.throws(() => first.publisher.pause(), /CONSUMED/);
    assert.equal(first.reads(), 1);
});

test('nonpreparing incomplete changed or unclosed checkpoints fail closed and cannot be retried', async () => {
    const sample = await preparingSample();
    const changes = [
        (x: any) => {
            x.fileDescriptors = 1;
            return x;
        },
        (x: any) => {
            x.directories = 1;
            return x;
        },
        (x: any) => {
            x.pending = 'close';
            return x;
        },
        (x: any) => {
            x.cleanup.seal.state = 'ready';
            return x;
        },
        (x: any) => {
            x.cleanup.seal.state = 'gap';
            return x;
        },
        (x: any) => {
            x.cleanup.seal.state = 'published';
            return x;
        },
        (x: any) => {
            x.cleanup.progress.phase = 'deleting';
            return x;
        },
        (x: any) => {
            x.cleanup.rawSnapshot[0] ^= 1;
            return x;
        },
        (x: any) => {
            x.cleanup.rawState[0] ^= 1;
            return x;
        },
        (x: any) => {
            x.cleanup.seal.intentSHA256 = 'f'.repeat(64);
            return x;
        },
        (x: any) => {
            x.staged.bytes = 1;
            return x;
        },
        (x: any) => {
            x.staged.ino++;
            return x;
        },
        (x: any) => {
            x.view.activity.root = 'inactive';
            return x;
        },
        (x: any) => {
            x.view.root.identity.ino++;
            return x;
        },
        (x: any) => {
            x.view.source.identity.ino++;
            return x;
        },
    ];
    for (const change of changes) {
        const state = bound(sample, change);
        assert.throws(() => state.publisher.pause());
        assert.equal(state.publisher.diagnostics().phase, 'retained-unknown');
        assert.equal(state.publisher.diagnostics().primarySet, true);
        assert.throws(() => state.publisher.pause(), /CONSUMED/);
        assert.equal(state.reads(), 1);
    }
});

test('falsey first reader failure stays primary and a late asynchronous port never mints a pause', async () => {
    const sample = await preparingSample(),
        selection = api.createLinuxSealInterruptionSelection();
    let reads = 0;
    const publisher = api.bindLinuxSealInterruption(selection, sample.plan, () => {
        reads++;
        throw undefined;
    });
    let caught = false;
    try {
        publisher.pause();
    } catch (error) {
        caught = true;
        assert.equal(error, undefined);
    }
    assert.equal(caught, true);
    assert.equal(publisher.diagnostics().primarySet, true);
    assert.throws(() => publisher.pause(), /CONSUMED/);
    assert.equal(reads, 1);
    for (const mode of [
        'resolved',
        'rejected',
        'deferred-resolve',
        'deferred-reject',
        'own-then-getter',
    ]) {
        let resolve!: (value: unknown) => void,
            reject!: (value: unknown) => void,
            getterReads = 0;
        const value =
            mode === 'resolved' || mode === 'own-then-getter'
                ? Promise.resolve(undefined)
                : mode === 'rejected'
                  ? Promise.reject(undefined)
                  : new Promise<unknown>((done, fail) => {
                        resolve = done;
                        reject = fail;
                    });
        if (mode === 'own-then-getter')
            Object.defineProperty(value, 'then', {
                get() {
                    getterReads++;
                    throw Error('must not read returned.then');
                },
            });
        const other = api.createLinuxSealInterruptionSelection(),
            asyncPublisher = api.bindLinuxSealInterruption(other, sample.plan, () => value);
        assert.throws(() => asyncPublisher.pause(), /ASYNC_READER/);
        assert.equal(asyncPublisher.diagnostics().phase, 'retained-unknown');
        if (mode === 'deferred-resolve') resolve(undefined);
        if (mode === 'deferred-reject') reject(undefined);
        await Promise.resolve();
        await Promise.resolve();
        const diagnostics = asyncPublisher.diagnostics();
        assert.equal(diagnostics.readerPromise.joinSet, true);
        assert.equal(diagnostics.readerPromise.outcomeSet, true);
        assert.equal(
            diagnostics.readerPromise.settled,
            mode.includes('reject') ? 'rejected' : 'resolved',
        );
        assert.equal(diagnostics.readerPromise.intrinsicFailureSet, false);
        assert.equal(diagnostics.primarySet, true);
        assert.equal(getterReads, 0);
        assert.throws(() => asyncPublisher.pause(), /CONSUMED/);
    }
    const poisoned = Promise.resolve(undefined);
    Object.defineProperty(poisoned, 'constructor', {
        get() {
            throw undefined;
        },
    });
    const poisonedOwner = api.bindLinuxSealInterruption(
        api.createLinuxSealInterruptionSelection(),
        sample.plan,
        () => poisoned,
    );
    assert.throws(() => poisonedOwner.pause(), /ASYNC_READER/);
    assert.equal(poisonedOwner.diagnostics().readerPromise.intrinsicFailureSet, true);
    assert.equal(poisonedOwner.diagnostics().readerPromise.joinSet, false);
    assert.equal(poisonedOwner.diagnostics().phase, 'retained-unknown');
    assert.throws(() => poisonedOwner.pause(), /CONSUMED/);
    for (const enumerable of [false, true]) {
        let getterReads = 0;
        const thenable = sample.read();
        Object.defineProperty(thenable, 'then', {
            enumerable,
            get() {
                getterReads++;
                throw Error('must not read thenable.then');
            },
        });
        const thenableOwner = api.bindLinuxSealInterruption(
            api.createLinuxSealInterruptionSelection(),
            sample.plan,
            () => thenable,
        );
        assert.throws(() => thenableOwner.pause(), /THENABLE_READER/);
        assert.equal(getterReads, 0);
        assert.equal(thenableOwner.diagnostics().readerPromise, null);
        assert.equal(thenableOwner.diagnostics().phase, 'retained-unknown');
    }
});

test('recovery or unconsented selections cannot reach a preparing-state producer', async () => {
    const sample = await preparingSample();
    for (const change of [
        (p: any) => {
            p.consent = false;
        },
        (p: any) => {
            p.action = 'launch';
        },
        (p: any) => {
            p.review = clone(sample.read().view);
            p.review.activity.root = 'inactive';
            p.reviewSHA256 = model.linuxModelReviewSHA256(p.review);
        },
    ]) {
        const plan = clone(sample.plan),
            selection = api.createLinuxSealInterruptionSelection();
        let reads = 0;
        change(plan);
        assert.throws(() =>
            api.bindLinuxSealInterruption(selection, plan, () => {
                reads++;
                return sample.read();
            }),
        );
        assert.equal(reads, 0);
        assert.throws(
            () => api.bindLinuxSealInterruption(selection, sample.plan, sample.read),
            /SELECTION/,
        );
    }
});
