// Fixed source/memory projections only. These controls execute the actual public
// race and selected private custody/continuation/CLI slices, not physical setup.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

type Data = Record<string, any>;
const sourceURL = new URL('../scripts/linux-owned-installation-fixture.ts', import.meta.url);
const text = readFileSync(sourceURL, 'utf8');
assert.equal(
    createHash('sha256').update(text).digest('hex'),
    'f8c7b4c6f8924f104338460df4884fa40f4b1faedbfa0f6ea8121e657106212d',
);
const source = ts.createSourceFile(
    'actual-linux-fixture.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);
function one(nodes: readonly ts.Node[], name: string) {
    const matches = nodes.filter((node) =>
        ts.isFunctionDeclaration(node)
            ? node.name?.text === name
            : ts.isVariableStatement(node) &&
              node.declarationList.declarations.some(
                  (item) => ts.isIdentifier(item.name) && item.name.text === name,
              ),
    );
    assert.equal(matches.length, 1, 'Require actual declaration: ' + name);
    return matches[0];
}
const code = (node: ts.Node) => node.getText(source);
const publicRun = one(source.statements, 'runLinuxOwnedInstallationFixture');
const execute = one(
    source.statements,
    'executeLinuxOwnedInstallationFixture',
) as ts.FunctionDeclaration;
const statements = execute.body!.statements;
const firstHelper = statements.findIndex(ts.isFunctionDeclaration);
assert.ok(firstHelper > 0);
const preamble = statements.slice(0, firstHelper).map(code).join('\n');
const outer = statements.filter(ts.isTryStatement);
assert.equal(outer.length, 1);
assert.ok(outer[0].catchClause && outer[0].finallyBlock);
const insideTry = outer[0].tryBlock.statements;
const prepare = one(insideTry, 'prepare') as ts.FunctionDeclaration;
const operation = one(insideTry, 'operation');
const prepareStatements = prepare.body!.statements;
const phase = code(prepareStatements[0]);
assert.match(phase, /state\.phase\s*=\s*'prepare-'/);
const censusAt = prepareStatements.findIndex((node) => node === one(prepareStatements, 'census'));
const asarAt = prepareStatements.findIndex((node) =>
    code(node).includes("await import('@electron/asar')"),
);
assert.ok(censusAt >= 0 && asarAt >= 0);
assert.equal(code(prepareStatements[asarAt + 1]), 'gate();');
const success = [
    ...insideTry.filter(
        (node) =>
            ts.isExpressionStatement(node) && /^state\.phase\s*=\s*'complete'/.test(code(node)),
    ),
    one(insideTry, 'result'),
    ...insideTry.filter(
        (node) => ts.isReturnStatement(node) && node.expression?.getText(source) === 'result',
    ),
];
assert.equal(success.length, 3);
const installCall = insideTry.filter(
    (node) => ts.isExpressionStatement(node) && /^await operation\('install', a\)/.test(code(node)),
);
assert.equal(installCall.length, 1);
const bodies: Record<string, string> = {
    normal: success.map(code).join('\n'),
    effect:
        phase +
        '\n' +
        prepareStatements
            .slice(censusAt, censusAt + 3)
            .map(code)
            .join('\n'),
    asar:
        phase +
        '\n' +
        prepareStatements
            .slice(asarAt, asarAt + 3)
            .map(code)
            .join('\n'),
    child: code(operation) + '\n' + code(installCall[0]),
};
const write = one(statements, 'write') as ts.FunctionDeclaration;
assert.equal(code(write.body!.statements[0]), 'gate();');
// Preserve the actual write-entry gate, then substitute only its physical IO.
const writePort =
    text.slice(write.getStart(source), write.body!.getStart(source) + 1) +
    code(write.body!.statements[0]) +
    '\nreturn actorWrite(name, value);\n}';
const header = text.slice(execute.getStart(source), execute.body!.getStart(source) + 1);
const tail = code(outer[0].catchClause!) + ' finally ' + code(outer[0].finallyBlock!);
const top = ['A', 'need', 'normal', 'inside', 'owners', 'linuxOwnedFixtureArguments']
    .map((name) => code(one(source.statements, name)))
    .join('\n');
const compile = (value: string) =>
    ts.transpileModule(value, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
function program(mode: string) {
    return compile(
        top +
            '\n' +
            code(publicRun) +
            '\n' +
            header +
            '\n' +
            preamble +
            '\n' +
            code(one(statements, 'effect')) +
            '\n' +
            writePort +
            '\ntry {\n' +
            bodies[mode] +
            '\n' +
            (mode === 'normal' ? '' : success.map(code).join('\n')) +
            '\n} ' +
            tail +
            '\n}\n' +
            `export const probe = () => { const all = Array.from(owners); return {
            work: all.find((x: any) => typeof x.pending === 'boolean'),
            state: all.find((x: any) => 'fds' in x) }; };`,
    );
}
const cli = source.statements
    .filter(ts.isIfStatement)
    .filter((node) => code(node.expression).includes('process.argv[1]'));
assert.equal(cli.length, 1);
assert.ok(ts.isBlock(cli[0].thenStatement));
const cliBlock = cli[0].thenStatement as ts.Block;
const cliCalls = cliBlock.statements.filter(
    (node): node is ts.ExpressionStatement =>
        ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression),
);
assert.equal(cliCalls.length, 1);
const voidCall = cliCalls[0].expression as ts.VoidExpression;
const cliText = code(cliBlock),
    replacement = 'globalThis.__cliChain = ' + code(voidCall.expression) + ';';
const capturedCLI =
    cliText.replace(code(cliCalls[0]), replacement).slice(0, -1) +
    '\nglobalThis.__cliReporting = () => reporting;\n}';
const cliCode = compile(capturedCLI);

function deferred() {
    let resolve!: (value: any) => void, reject!: (error: unknown) => void;
    let settled = false;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return {
        promise,
        resolve(value: any) {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        },
        reject(error: unknown) {
            if (!settled) {
                settled = true;
                reject(error);
            }
        },
    };
}
const inputArgs = () => [
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
function model(mode: string, outputFailure?: { value: unknown }) {
    const gate = deferred(),
        entered = deferred(),
        events: string[] = [];
    const counts = {
        census: 0,
        imports: 0,
        extract: 0,
        writes: 0,
        close: 0,
        spawn: 0,
        observer: 0,
        mkdir: 0,
        stdout: 0,
        stderr: 0,
    };
    const timeouts = new Map<object, () => void>(),
        intervals = new Set<object>();
    let now = 0,
        api: Data,
        childOptions: Data | null = null;
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    });
    const stdout = Object.assign(new EventEmitter(), {
        write(value: string) {
            counts.stdout++;
            events.push('stdout');
            assert.equal(typeof value, 'string');
            assert.ok(
                intervals.size > 0,
                'Actual deadline keeper must precede fallible reporting.',
            );
            if (counts.stdout === 1 && outputFailure) throw outputFailure.value;
            return true;
        },
    });
    const stderr = Object.assign(new EventEmitter(), {
        write() {
            counts.stderr++;
            return true;
        },
    });
    const processPort: Data = {
        platform: 'linux',
        arch: 'x64',
        versions: { napi: '10' },
        env: { HOME: '/model/home' },
        getuid: () => {
            assert.equal(api.probe().work.pending, true);
            return 1000;
        },
        geteuid: () => 1000,
        argv: ['/authored/node', sourceURL.pathname, ...inputArgs()],
        stdout,
        stderr,
        exitCode: undefined,
    };
    const module = { exports: {} };
    const context = vm.createContext({
        module,
        exports: module.exports,
        path,
        Buffer,
        Error,
        utilTypes: types,
        process: processPort,
        performance: { now: () => now },
        setTimeout(callback: () => void, delay: number) {
            assert.equal(delay, 9 * 60000);
            const token = Object.freeze({ deadline: true });
            timeouts.set(token, callback);
            return token;
        },
        clearTimeout(token: object) {
            events.push('clear-timeout');
            timeouts.delete(token);
        },
        setInterval(_callback: () => void, delay: number) {
            assert.equal(delay, 60000);
            events.push('keeper');
            const token = Object.freeze({ keeper: true });
            intervals.add(token);
            return token;
        },
        clearInterval(token: object) {
            events.push('clear-keeper');
            assert.ok(intervals.delete(token));
        },
        observeLinuxGzipTar: () => {
            counts.census++;
            entered.resolve(true);
            return gate.promise;
        },
        chunks: () => [],
        archive: {},
        window: {},
        role: 'a',
        input: {},
        close: () => {
            counts.close++;
            throw Error('No post-deadline close actor expected.');
        },
        require(id: string) {
            assert.equal(id, '@electron/asar');
            counts.imports++;
            entered.resolve(true);
            return gate.promise;
        },
        actorWrite(name: string) {
            counts.writes++;
            return { path: '/model/home/run/' + name, sha256: 'c'.repeat(64) };
        },
        fs: {
            mkdirSync(directory: string) {
                counts.mkdir++;
                assert.equal(directory, '/model/home/run/operations/install');
            },
        },
        repo: '/model/home/repo',
        python: '/fixed/python3',
        pythonDisk: { sha256: 'a'.repeat(64) },
        companionDisk: { sha256: 'b'.repeat(64) },
        digest(file: string) {
            assert.ok(
                [
                    '/fixed/python3',
                    '/model/home/repo/scripts/linux-owned-installation-pty.py',
                ].includes(file),
            );
            return { sha256: (file === '/fixed/python3' ? 'a' : 'b').repeat(64) };
        },
        target: '/model/home/run/installed',
        appData: '/model/home/run/config',
        dataHome: '/model/home/run/data',
        commit: 'a'.repeat(40),
        runId: '123',
        runAttempt: '1',
        version: '0.6.0-qualification.0',
        sourceRoot: '/model/home/a-app',
        a: { version: '0.6.0-qualification.0', outputRoot: '/model/home/envelope-a' },
        spawn: () => {
            counts.spawn++;
            assert.equal(api.probe().state.childSubmitted, true);
            return child;
        },
        observeOwnedChild: (value: unknown, options: Data) => {
            counts.observer++;
            assert.equal(value, child);
            assert.equal(
                child.listenerCount('error'),
                1,
                'Actual raw listener must precede shared observation.',
            );
            childOptions = options;
            entered.resolve(true);
            return { outcome: gate.promise };
        },
    });
    new vm.Script(program(mode), { filename: 'actual-fixture-boundary.cjs' }).runInContext(context);
    api = module.exports as Data;
    const inspect = () => api.probe() as Data;
    let publicOutcome: Promise<Data> | null = null;
    const start = () => {
        const outcome = api.runLinuxOwnedInstallationFixture(inputArgs()) as Promise<Data>;
        publicOutcome = outcome.then(
            (value) => ({ value }),
            (error) => ({ error }),
        );
        return publicOutcome;
    };
    async function awaitEntered(outcome: Promise<unknown>) {
        assert.equal(
            await Promise.race([
                entered.promise.then(() => 'entered'),
                outcome.then(() => 'settled'),
            ]),
            'entered',
        );
    }
    const fire = () => {
        assert.equal(timeouts.size, 1);
        now = 9 * 60000;
        const [token, callback] = timeouts.entries().next().value!;
        timeouts.delete(token);
        callback();
    };
    const lateModule = {
        extractFile: () => {
            counts.extract++;
            return Buffer.from('{}');
        },
    };
    const childResult = {
        spawnObserved: true,
        exitObserved: true,
        closeObserved: true,
        code: 0,
        closeCode: 0,
        signal: null,
        closeSignal: null,
        timedOut: false,
        error: null,
    };
    async function finish(value?: unknown, reject = false) {
        const selectedValue =
            arguments.length > 0
                ? value
                : mode === 'asar'
                  ? lateModule
                  : mode === 'child'
                    ? childResult
                    : {};
        const work = inspect().work;
        const joined = work?.outcome?.then(
            (result: unknown) => ({ result }),
            (error: unknown) => ({ error }),
        );
        entered.resolve(true);
        if (reject) gate.reject(selectedValue);
        else gate.resolve(selectedValue);
        if (joined) await joined;
        if (publicOutcome) await publicOutcome;
    }
    const cliStart = () => {
        new vm.Script(cliCode, { filename: 'actual-fixture-cli.cjs' }).runInContext(context);
        return (context as Data).__cliChain as Promise<unknown>;
    };
    return {
        start,
        inspect,
        awaitEntered,
        fire,
        finish,
        gate,
        counts,
        events,
        intervals,
        timeouts,
        child,
        childResult,
        processPort,
        cliStart,
        reporting: () => (context as Data).__cliReporting(),
        mappedChildFailure: () => {
            assert.ok(childOptions);
            childOptions.requestStop();
        },
    };
}

test('actual public outcome bounds pending effects and preserves late adoption or raw rejection', async () => {
    const normal = model('normal');
    try {
        const outcome = await normal.start();
        assert.equal(outcome.value.status, 'completed-controlled-install-update-rollback');
        assert.equal(outcome.value.releaseAcceptance, false);
        assert.equal(normal.inspect().work.pending, false);
        assert.equal(normal.inspect().state.retired, true);
        assert.equal(normal.timeouts.size, 0);
        assert.equal(normal.intervals.size, 0);
    } finally {
        await normal.finish();
    }
    for (const late of [
        { value: { actualLateValue: true }, reject: false },
        { value: new Error('authored late effect failure'), reject: true },
        { value: undefined, reject: true },
    ]) {
        const m = model('effect'),
            outcome = m.start();
        try {
            await m.awaitEntered(outcome);
            m.fire();
            const publicResult = await outcome,
                state = m.inspect().state;
            assert.equal(publicResult.value.status, 'retained-nonpassing');
            assert.equal(publicResult.value.phase, 'prepare-a');
            assert.equal(m.inspect().work.pending, true);
            assert.equal(state.retired, false);
            assert.equal(state.first.message, 'FIXTURE_DEADLINE');
            assert.ok(m.intervals.has(state.keeper));
            const first = state.first;
            await m.finish(late.value, late.reject);
            assert.equal(state.first, first);
            assert.equal(m.inspect().work.pending, false);
            if (late.reject) {
                assert.equal(state.lateFailure.value, late.value);
                assert.equal(state.pending.size, 1);
                assert.equal(state.retired, false);
            } else {
                assert.equal(state.returns[0].returned, true);
                assert.equal(state.returns[0].value, late.value);
                assert.equal(state.pending.size, 0);
                assert.equal(state.retired, true);
            }
            assert.equal(m.counts.census, 1);
            assert.equal(m.counts.writes, 0);
            assert.equal(m.counts.close, 0);
        } finally {
            await m.finish();
        }
    }
});

test('actual pending ASAR continuation reports a deadline and performs no late extract', async () => {
    for (const late of [
        { reject: false, value: null },
        { reject: true, value: new Error('late ASAR failure') },
        { reject: true, value: undefined },
    ]) {
        const m = model('asar'),
            outcome = m.start();
        try {
            await m.awaitEntered(outcome);
            m.fire();
            const result = await outcome,
                state = m.inspect().state,
                first = state.first;
            assert.equal(result.value.status, 'retained-nonpassing');
            assert.equal(m.inspect().work.pending, true);
            assert.equal(state.retired, false);
            assert.ok(m.intervals.has(state.keeper));
            if (late.reject) await m.finish(late.value, true);
            else await m.finish();
            assert.equal(state.first, first);
            assert.equal(first.message, 'FIXTURE_DEADLINE');
            if (late.reject) assert.equal(state.lateFailure.value, late.value);
            assert.equal(m.inspect().work.pending, false);
            assert.equal(m.counts.imports, 1);
            assert.equal(m.counts.extract, 0);
            assert.equal(m.counts.writes, 0);
        } finally {
            await m.finish();
        }
    }
});

test('actual pending child keeps raw first failure and retires only acknowledged closure facts', async () => {
    for (const raw of [new Error('authored raw child failure'), undefined]) {
        let coerced = 0;
        if (raw)
            Object.defineProperty(raw, 'toString', {
                get() {
                    coerced++;
                    throw Error('Do not coerce raw child failure.');
                },
            });
        for (const bothEOF of [false, true]) {
            const m = model('child'),
                outcome = m.start();
            try {
                await m.awaitEntered(outcome);
                m.child.emit('error', raw);
                m.mappedChildFailure();
                const state = m.inspect().state;
                assert.equal(state.firstSet, true);
                assert.equal(state.first, raw);
                assert.equal(coerced, 0);
                m.fire();
                assert.equal((await outcome).value.status, 'retained-nonpassing');
                assert.equal(state.retired, false);
                assert.equal(state.childSubmitted, true);
                assert.equal(m.inspect().work.pending, true);
                assert.ok(m.intervals.has(state.keeper));
                m.child.stdout.emit('end');
                if (bothEOF) m.child.stderr.emit('end');
                await m.finish(m.childResult);
                assert.equal(state.first, raw);
                assert.equal(m.inspect().work.pending, false);
                assert.equal(state.childSubmitted, !bothEOF);
                assert.equal(state.retired, bothEOF);
                assert.equal(m.counts.writes, 2); // Only request/submission before the deadline.
                assert.equal(m.counts.spawn, 1);
                assert.equal(m.counts.observer, 1);
                assert.equal(coerced, 0);
            } finally {
                await m.finish();
            }
        }
    }
});

test('actual CLI reports once after the keeper and cannot turn output failure or late work into a pass', async () => {
    for (const value of [new Error('authored stdout failure'), undefined]) {
        const m = model('effect', { value }),
            chain = m.cliStart();
        try {
            await m.awaitEntered(chain);
            m.fire();
            await chain;
            assert.equal(m.processPort.exitCode, 1);
            assert.equal(m.reporting().failed, true);
            assert.equal(m.reporting().first, value);
            assert.equal(m.counts.stdout, 2);
            assert.equal(m.counts.stderr, 0);
            assert.ok(m.events.indexOf('keeper') < m.events.indexOf('stdout'));
            const first = m.inspect().state.first;
            await m.finish({ lateValue: true });
            await Promise.resolve();
            assert.equal(m.counts.stdout, 2);
            assert.equal(m.processPort.exitCode, 1);
            assert.equal(m.inspect().state.first, first);
            assert.equal(first.message, 'FIXTURE_DEADLINE');
        } finally {
            await m.finish();
            await chain;
        }
    }
});
