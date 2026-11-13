/** Closed-memory projections of the fixed fixture continuation. No physical FS actor, child,
 * native addon, copy/install/launch/Finalize/unlink, or real timer runs here. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {
    getLinuxOwnedCurrentBFixtureContext,
    linuxOwnedFixtureArguments,
} from '../scripts/linux-owned-installation-fixture.ts';
const sourceURL = new URL('../scripts/linux-owned-installation-fixture.ts', import.meta.url),
    text = readFileSync(sourceURL, 'utf8'),
    sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
assert.equal(sha(text), 'f8c7b4c6f8924f104338460df4884fa40f4b1faedbfa0f6ea8121e657106212d');
const source = ts.createSourceFile(
    'actual-owned-fixture.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);
function one(nodes: readonly ts.Node[], name: string) {
    const found = nodes.filter((node) =>
        ts.isFunctionDeclaration(node)
            ? node.name?.text === name
            : ts.isVariableStatement(node) &&
              node.declarationList.declarations.some(
                  (item) => ts.isIdentifier(item.name) && item.name.text === name,
              ),
    );
    assert.equal(found.length, 1, 'One actual declaration: ' + name);
    return found[0];
}
const code = (node: ts.Node) => node.getText(source),
    execute = one(
        source.statements,
        'executeLinuxOwnedInstallationFixture',
    ) as ts.FunctionDeclaration,
    outer = execute.body!.statements.filter(ts.isTryStatement);
assert.equal(outer.length, 1);
const body = outer[0].tryBlock.statements,
    first = body.findIndex(
        (node) =>
            ts.isExpressionStatement(node) && /^await operation\('install', a\)/.test(code(node)),
    );
assert.ok(first >= 0);
const actualTail = body.slice(first).map(code).join('\n'),
    actualSnapshot = code(one(body, 'snapshot')),
    actualRevalidate = code(one(body, 'revalidateInputs')),
    actualTop = [
        'A',
        'need',
        'normal',
        'inside',
        'linuxOwnedFixtureArguments',
        'currentBContexts',
        'getLinuxOwnedCurrentBFixtureContext',
    ]
        .map((name) => code(one(source.statements, name)))
        .join('\n'),
    actualOwnership = ['fail', 'unknown', 'hold', 'gate', 'nonpassing']
        .map((name) => code(one(execute.body!.statements, name)))
        .join('\n');
const compile = (value: string) =>
    ts.transpileModule(value, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
const args = () => [
    '--a-appdir',
    '/model/home/a-app',
    '--a-archive',
    '/model/home/a.tar.gz',
    '--b-appdir',
    '/model/home/b-app',
    '--b-archive',
    '/model/home/b.tar.gz',
    '--fixture-root',
    '/model/home/run',
];
const deferred = () => {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
function model(
    scenario?: 'current-b',
    options: { holdUpdate?: boolean; failSeal?: boolean; sealError?: unknown } = {},
) {
    const home = '/model/home',
        root = home + '/run',
        target = root + '/installed',
        appData = root + '/config',
        dataHome = root + '/data',
        repo = home + '/repo',
        commit = 'c'.repeat(40),
        work = root + '/.DiagnosticHub-maintenance-' + sha(target).slice(0, 20),
        fileMap = new Map<string, Buffer>(),
        modes = new Map<string, number>(),
        identityOverrides = new Map<string, number>(),
        operations: string[] = [],
        writes: string[] = [],
        intervals = new Set<object>(),
        update = deferred();
    let now = 0,
        reads = 0,
        active: 'a' | 'b' | null = null,
        previous: 'a' | null = null,
        retained: 'b' | null = null,
        api: any;
    const state: any = {
        failed: false,
        firstSet: false,
        first: undefined,
        phase: 'host',
        retired: false,
        lateFailure: null,
        fds: new Set(),
        pending: new Set(),
        childSubmitted: false,
        child: null,
        envelopes: [],
        transcript: [],
        keeper: null,
        sealRecordAttempted: false,
        sealRecordUnsettled: false,
        sealRecordOriginal: null,
        sealRecord: null,
    };
    const put = (file: string, raw: string | Buffer, mode = 0o600) => {
        fileMap.set(file, Buffer.from(raw));
        modes.set(file, mode);
    };
    const identity = (file: string) => ({
        dev: 3,
        ino: identityOverrides.get(file) ?? parseInt(sha(file).slice(0, 8), 16) + 1,
        uid: 1000,
        gid: 1000,
        mode: modes.get(file) ?? 0o700,
        nlink: 1,
        size: fileMap.get(file)?.length ?? 0,
        mtimeMs: 1,
        ctimeMs: 1,
    });
    const check = () => {
        if (api) api.gate();
    };
    const bytes = (file: string, cap: number) => {
        check();
        reads++;
        const value = fileMap.get(file);
        assert.ok(value, 'Authored memory file: ' + file);
        assert.ok(value.length <= cap);
        return Buffer.from(value);
    };
    const digest = (file: string, cap: number, _system = false, bound = false) => {
        const value = bytes(file, cap);
        return {
            bytes: value.length,
            sha256: sha(value),
            ...(bound ? { identity: identity(file) } : {}),
        };
    };
    const tree = (directory: string, _cap = 20032, bound = false) => {
        check();
        reads++;
        const files = Array.from(fileMap.keys())
            .filter((file) => file.startsWith(directory + '/'))
            .sort()
            .map((file) => ({
                path: file.slice(directory.length + 1),
                mode: modes.get(file) ?? 0o600,
                bytes: fileMap.get(file)!.length,
                sha256: sha(fileMap.get(file)!),
                ...(bound ? { identity: identity(file) } : {}),
            }));
        return { files, directories: [], ...(bound ? { identity: identity(directory) } : {}) };
    };
    const write = (name: string, value: unknown) => {
        check();
        writes.push(name);
        if (name === 'records/seal-preparation.json' && options.failSeal) {
            state.fds.add(99);
            throw options.sealError;
        }
        const raw = Buffer.isBuffer(value)
            ? Buffer.from(value)
            : Buffer.from(JSON.stringify(value) + '\n');
        put(root + '/' + name, raw);
        return { path: root + '/' + name, bytes: raw.length, sha256: sha(raw) };
    };
    const installationId = '11111111-1111-4111-8111-111111111111',
        txA = '22222222-2222-4222-8222-222222222222',
        txB = '33333333-3333-4333-8333-333333333333';
    const plans = {
        a: {
            version: '0.6.0-qualification.0',
            outputRoot: root + '/envelope-a',
            descriptorSHA256: sha('a descriptor'),
        },
        b: {
            version: '0.6.0',
            outputRoot: root + '/envelope-b',
            descriptorSHA256: sha('b descriptor'),
        },
    };
    const captured = (role: 'a' | 'b') => {
        const originalManifest = Buffer.from(
                JSON.stringify({ version: plans[role].version, sourceCommit: commit }),
            ),
            originalRecord = Buffer.from(
                JSON.stringify({
                    installationId,
                    profile: 'dedicated',
                    manifestSHA256: sha(originalManifest),
                }),
            ),
            originalOwner = Buffer.from(
                JSON.stringify({ root: target, installationId, authoredMemoryOnly: true }),
            );
        return {
            originalManifest,
            originalRecord,
            originalOwner,
            record: JSON.parse(originalRecord.toString()),
            observed: { authoredMemoryOnly: true, role },
        };
    };
    const installFiles = (directory: string, role: 'a' | 'b') => {
        const value = captured(role);
        put(directory + '/.diagnostic-hub-release.json', value.originalManifest);
        put(directory + '/.diagnostic-hub-installation.json', value.originalRecord);
        put(directory + '/.diagnostic-hub-ownership.json', value.originalOwner);
        put(directory + '/app/diagnostic-hub', 'authored-memory-application-' + role, 0o700);
    };
    const journal = (phase = 'candidate-active') =>
        Buffer.from(
            JSON.stringify({
                root: target,
                uid: 1000,
                phase,
                transactionId: active === 'a' && previous === null ? txA : txB,
                previousSHA256: previous ? sha(captured('a').originalManifest) : null,
            }),
        );
    const operation = async (op: string) => {
        check();
        operations.push(op);
        if (op === 'update' && options.holdUpdate) {
            state.childSubmitted = true;
            await update.promise;
            state.childSubmitted = false;
        }
        if (op === 'install') {
            active = 'a';
            installFiles(target, 'a');
            put(work + '/journal.json', journal());
        }
        if (op === 'update') {
            put(work + '/completed-journal.json', fileMap.get(work + '/journal.json')!);
            active = 'b';
            previous = 'a';
            installFiles(target, 'b');
            installFiles(work + '/previous-' + txB, 'a');
            put(work + '/journal.json', journal());
        }
        if (op === 'rollback') {
            active = 'a';
            previous = null;
            retained = 'b';
            installFiles(target, 'a');
            installFiles(work + '/stage-' + txB, 'b');
            put(
                work + '/journal.json',
                Buffer.from(
                    JSON.stringify({
                        root: target,
                        uid: 1000,
                        phase: 'rolled-back',
                        transactionId: txB,
                        previousSHA256: sha(captured('a').originalManifest),
                    }),
                ),
            );
        }
    };
    const payload = (directory: string, plan: { version: string }) => {
        check();
        reads++;
        const role =
            directory === target ? active : directory.includes('/previous-') ? previous : retained;
        assert.ok(role);
        assert.equal(plans[role].version, plan.version);
        return captured(role);
    };
    put(repo + '/.git/HEAD', commit + '\n');
    put(appData + '/profile-marker', 'settings-and-reports');
    const inputOriginals: any[] = [];
    for (const role of ['a', 'b'] as const) {
        const archivePath = home + '/' + role + '.tar.gz',
            sourceRoot = home + '/' + role + '-app',
            envelopeRoot = plans[role].outputRoot;
        put(archivePath, 'authored-memory-archive-' + role);
        for (const base of [sourceRoot, envelopeRoot]) {
            put(base + '/resources/helper.cjs', 'authored-memory-helper-' + role);
            put(base + '/resources/helper.node', 'authored-memory-native-bytes-' + role);
        }
        const census = write('records/' + role + '-census.json', { authoredMemoryOnly: true });
        const original = {
            role,
            version: plans[role].version,
            sourceCommit: commit,
            archivePath,
            archive: digest(archivePath, 1e6, false, true),
            sourceRoot,
            sourceInventory: tree(sourceRoot, 20032, true),
            envelopeRoot,
            envelopeInventory: tree(envelopeRoot, 20032, true),
            descriptorSHA256: plans[role].descriptorSHA256,
            records: { census },
        };
        const inputRecord = write('records/' + role + '-inputs.json', original);
        inputOriginals.push({ ...original, inputRecord });
    }
    writes.length = 0;
    reads = 0;
    const context = vm.createContext(
        {
            assert,
            Buffer,
            structuredClone,
            utilTypes,
            path,
            state,
            inputOriginals,
            performance: { now: () => now },
            started: 0,
            until: 9 * 60000,
            setInterval: () => {
                const lease = {};
                intervals.add(lease);
                return lease;
            },
            clearInterval: (lease: object) => {
                assert.ok(intervals.delete(lease));
            },
            clearTimeout: () => {},
            timer: {},
            root,
            target,
            appData,
            dataHome,
            home,
            uid: 1000,
            repo,
            commit,
            runId: '123',
            runAttempt: '1',
            a: plans.a,
            b: plans.b,
            operation,
            payload,
            tree,
            bytes,
            digest,
            write,
            sha,
            selected: linuxOwnedFixtureArguments([
                ...args(),
                ...(scenario ? ['--scenario', scenario] : []),
            ]),
            module: { exports: {} },
            exports: {},
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    context.exports = context.module.exports;
    const program =
        actualTop +
        '\n' +
        actualOwnership +
        '\n' +
        actualRevalidate +
        '\n' +
        actualSnapshot +
        '\n' +
        'async function run(){try{\n' +
        actualTail +
        '\n}' +
        code(outer[0].catchClause!) +
        'finally' +
        code(outer[0].finallyBlock!) +
        '}\n' +
        'module.exports={run,getContext:getLinuxOwnedCurrentBFixtureContext,gate,revalidateInputs};';
    new vm.Script(compile(program), {
        filename: 'actual-current-b-continuation.memory.cjs',
    }).runInContext(context);
    api = context.module.exports;
    return {
        ...api,
        state,
        inputOriginals,
        operations,
        writes,
        intervals,
        fileMap,
        identityOverrides,
        update,
        setNow(value: number) {
            now = value;
        },
        reads: () => reads,
        root,
        target,
        appData,
        work,
        plans,
        txB,
    };
}

test('fixed scenario parser keeps default arguments unchanged and admits only current-b', () => {
    assert.equal(Object.hasOwn(linuxOwnedFixtureArguments(args()), 'scenario'), false);
    assert.equal(
        linuxOwnedFixtureArguments([...args(), '--scenario', 'current-b']).scenario,
        'current-b',
    );
    for (const extra of [
        ['--scenario', 'finalize'],
        ['--scenario', '/model/home/path'],
        ['--scenario', 'current-b', '--scenario', 'current-b'],
        ['--scenario'],
    ])
        assert.throws(() => linuxOwnedFixtureArguments([...args(), ...extra]));
    assert.throws(() =>
        linuxOwnedFixtureArguments([...args(), '--a-appdir', '/model/home/elsewhere']),
    );
});

test('actual default continuation still rolls back while current-b retains B and its previous A originals', async () => {
    const old = model(),
        rolled = await old.run();
    assert.equal(rolled.status, 'completed-controlled-install-update-rollback');
    assert.deepEqual(old.operations, ['install', 'update', 'rollback']);
    assert.throws(() => old.getContext(rolled));
    const current = model('current-b'),
        result = await current.run();
    assert.equal(result.status, 'completed-controlled-install-update-current-b');
    assert.deepEqual(current.operations, ['install', 'update']);
    assert.equal(result.installedAppLaunched, false);
    assert.equal(result.releaseAcceptance, false);
    const bound = current.getContext(result);
    assert.equal(bound.host.sourceRoot, current.plans.b.outputRoot);
    assert.equal(bound.root, current.target);
    assert.equal(bound.host.requirePackagedReviewCapability, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(bound.host), true);
    assert.equal(current.writes.includes('records/current-b-binding.json'), true);
    assert.equal(current.writes.includes('records/current-b-completed-journal.json'), true);
    assert.equal(current.writes.includes('records/retained-b-payload.json'), false);
    assert.throws(
        () => getLinuxOwnedCurrentBFixtureContext(result),
        'A projected memory result cannot enter the physical module WeakMap.',
    );
});

test('foreign JSON and proxy results cannot acquire a context or invoke physical read ports', () => {
    let traps = 0;
    for (const value of [
        { status: 'completed-controlled-install-update-current-b' },
        JSON.parse('{"success":true}'),
        new Proxy(
            {},
            {
                get() {
                    traps++;
                    throw Error('unread');
                },
            },
        ),
    ])
        assert.throws(() => getLinuxOwnedCurrentBFixtureContext(value));
    assert.equal(traps, 0);
});

test('pending, failed or late update never exposes a successful current-B context', async () => {
    for (const mode of ['failed', 'late']) {
        const m = model('current-b', { holdUpdate: true }),
            running = m.run();
        for (let i = 0; i < 100 && !m.operations.includes('update'); i++) await Promise.resolve();
        assert.equal(m.operations.includes('update'), true);
        assert.equal(m.writes.includes('records/current-b-binding.json'), false);
        assert.throws(() =>
            m.getContext({ status: 'completed-controlled-install-update-current-b' }),
        );
        if (mode === 'failed') m.update.reject(undefined);
        else {
            m.setNow(9 * 60000);
            m.update.resolve();
        }
        const result = await running;
        assert.equal(result.status, 'retained-nonpassing');
        assert.equal(result.releaseAcceptance, false);
        assert.equal(m.writes.includes('records/final.json'), false);
        assert.throws(() => m.getContext(result));
        if (mode === 'failed') {
            assert.equal(m.state.firstSet, true);
            assert.equal(m.state.first, undefined);
            assert.equal(m.state.childSubmitted, true);
        }
    }
});

test('original archive identity, original source and retained helper/native copy changes refuse read-only continuation', async () => {
    for (const mode of [
        'archive-bytes',
        'archive-identity',
        'source-helper',
        'envelope-native',
        'current-root',
        'journal-original',
    ]) {
        const m = model('current-b'),
            result = await m.run(),
            original = m.inputOriginals[0];
        if (mode === 'archive-bytes') m.fileMap.set(original.archivePath, Buffer.from('changed'));
        if (mode === 'archive-identity') m.identityOverrides.set(original.archivePath, 999);
        if (mode === 'source-helper')
            m.fileMap.set(original.sourceRoot + '/resources/helper.cjs', Buffer.from('changed'));
        if (mode === 'envelope-native')
            m.fileMap.set(original.envelopeRoot + '/resources/helper.node', Buffer.from('changed'));
        if (mode === 'current-root') m.identityOverrides.set(m.target, 888);
        if (mode === 'journal-original')
            m.fileMap.set(m.work + '/journal.json', Buffer.from('changed'));
        const writes = m.writes.length;
        assert.throws(() => m.getContext(result), mode);
        assert.equal(m.writes.length, writes, 'Read-only rejection does not publish or repair.');
    }
});

test('post-retirement child/stream uncertainty blocks getter, copy revalidation and fixed record write before any IO', async () => {
    const m = model('current-b'),
        result = await m.run(),
        context = m.getContext(result),
        reads = m.reads(),
        writes = m.writes.length;
    const firstLate = { value: undefined };
    m.state.lateFailure = firstLate;
    assert.throws(() => m.getContext(result));
    assert.throws(() => context.revalidateCopies());
    assert.throws(() =>
        context.writeSealPreparationRecord(Buffer.from('{"authoredMemoryOnly":true}')),
    );
    assert.equal(m.reads(), reads);
    assert.equal(m.writes.length, writes);
    assert.equal(m.state.lateFailure, firstLate);
    assert.equal(m.state.sealRecordAttempted, false);
});

test('copy-only revalidation survives legitimate later maintenance/profile changes and fixed writer retains original bytes once', async () => {
    const m = model('current-b'),
        result = await m.run(),
        context = m.getContext(result);
    (context.copies as any[])[0].archive.sha256 = 'f'.repeat(64); // Returned data cannot mutate the private baseline.
    let traps = 0;
    assert.throws(() => context.writeSealPreparationRecord('../unrequested' as any));
    assert.throws(() =>
        context.writeSealPreparationRecord(
            new Proxy(Buffer.from('unread'), {
                get() {
                    traps++;
                    throw Error('unread');
                },
            }),
        ),
    );
    assert.equal(traps, 0);
    assert.equal(m.state.sealRecordAttempted, false);
    m.fileMap.set(m.work + '/journal.json', Buffer.from('authored later product state'));
    m.fileMap.set(m.appData + '/profile-marker', Buffer.from('legitimate app profile write'));
    context.revalidateCopies();
    const raw = Buffer.from('{"authoredMemoryOnly":true,"releaseAcceptance":false}\n'),
        original = Buffer.from(raw),
        written = context.writeSealPreparationRecord(raw);
    raw.fill(0);
    assert.equal(written.path, m.root + '/records/seal-preparation.json');
    assert.deepEqual(m.fileMap.get(written.path), original);
    assert.deepEqual(m.state.sealRecordOriginal, original);
    assert.equal(m.state.sealRecordUnsettled, false);
    assert.equal(m.state.fds.size, 0);
    assert.throws(() => context.writeSealPreparationRecord(original));
    assert.equal(
        m.writes.filter((name: string) => name === 'records/seal-preparation.json').length,
        1,
    );
});

test('fixed writer retains raw falsey failure and uncertain descriptor without retry or cleanup', async () => {
    const m = model('current-b', { failSeal: true, sealError: undefined }),
        result = await m.run(),
        context = m.getContext(result);
    const raw = Buffer.from('{"authoredMemoryOnly":true}');
    assert.throws(() => context.writeSealPreparationRecord(raw));
    assert.equal(m.state.firstSet, true);
    assert.equal(m.state.first, undefined);
    assert.equal(m.state.sealRecordAttempted, true);
    assert.equal(m.state.sealRecordUnsettled, true);
    assert.deepEqual(m.state.sealRecordOriginal, raw);
    assert.equal(m.state.fds.has(99), true);
    assert.equal(m.intervals.size, 1);
    assert.throws(() => context.writeSealPreparationRecord(raw));
    assert.equal(
        m.writes.filter((name: string) => name === 'records/seal-preparation.json').length,
        1,
    );
});
