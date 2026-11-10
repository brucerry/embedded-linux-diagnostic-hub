// Closed memory models only. No npm, registry request, Gateway load, filesystem actor or CLI run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { sourceFixture, pipelineFixture } from './fixtures/gateway-producer-memory.ts';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import { parseGatewayArchiveBuildRecord } from '../scripts/lib/gateway-build-record.mjs';
import { openGatewayArchiveBytes } from '../scripts/lib/inner-archive-inspection.mjs';
import { prepareDiagnosticGatewayInstall } from '../scripts/lib/diagnostic-gateway-install.mjs';
import { gatewayInstallPlan } from '../scripts/lib/diagnostic-gateway-runtime.mjs';
import { startDiagnosticGatewayCommand } from '../scripts/lib/diagnostic-gateway-command.mjs';
import { createFinalGatewayObserver } from '../scripts/lib/final-gateway-runtime.mjs';
import { createOwnedWebFiles } from '../scripts/lib/owned-web-files.mjs';
import { createOwnedWebCapabilities } from '../scripts/lib/owned-web-capabilities.mjs';
import { localSourceProvider } from '../scripts/lib/committed-source-provider.mjs';
import { observeSourceBridge } from '../scripts/lib/committed-source-bridge.mjs';
import { startInstrumentedChildOutput } from '../scripts/lib/instrumented-gateway-output.mjs';
import {
    CURRENT_GATEWAY_BUILD_LEAF,
    readCurrentGatewayBuildFile,
    validateCurrentGatewayBuildContext,
} from '../scripts/lib/current-gateway-build.mjs';

const hash = (b) => createHash('sha256').update(b).digest('hex');
const sri = (b) => 'sha512-' + createHash('sha512').update(b).digest('base64');
const cliURL = new URL('../scripts/observe-gateway-current-install.mjs', import.meta.url);
const cliText = readFileSync(cliURL, 'utf8');
assert.equal(hash(cliText), '2528c2df6a376406433cbe115d66243e7285e2fe4ecde444919ee6a87358da77');
const tarText = readFileSync(
    new URL('./gateway-dependency-bytes.test.ts', import.meta.url),
    'utf8',
);
assert.equal(hash(tarText), '9f3222d5fdf26327025a141dab95a55d70a8cec1643a067ae937fd92596f249d');
const cliAST = ts.createSourceFile(
    'actual-cli.mjs',
    cliText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
);
const tarAST = ts.createSourceFile(
    'authored-package-fixture.ts',
    tarText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);
function one(source, nodes, name) {
    const found = nodes.filter((n) =>
        ts.isFunctionDeclaration(n)
            ? n.name?.text === name
            : ts.isVariableStatement(n) &&
              n.declarationList.declarations.some(
                  (d) => ts.isIdentifier(d.name) && d.name.text === name,
              ),
    );
    assert.equal(found.length, 1, 'One actual declaration: ' + name);
    return found[0].getText(source);
}
const declarations = [
    'retained',
    'digest',
    'decoder',
    'activated',
    'npmTrustKeys',
    'npmEnvironment',
    'withoutTrustValues',
    'fail',
    'gate',
    'censusFilesystem',
    'cacheContentPath',
    'installAndObserve',
    'observeGatewayInstallFromCurrentJob',
].map((n) => one(cliAST, cliAST.statements, n));
const main = cliAST.statements.filter(ts.isIfStatement);
assert.equal(main.length, 1);
const report = one(cliAST, main[0].thenStatement.statements, 'report');
const imports = {
    assert,
    constants,
    path,
    fileURLToPath,
    createHash,
    createOwnedWebFiles,
    createOwnedWebCapabilities,
    localSourceProvider,
    observeSourceBridge,
    parseGatewayArchiveBuildRecord,
    openGatewayArchiveBytes,
    prepareDiagnosticGatewayInstall,
    gatewayInstallPlan,
    startDiagnosticGatewayCommand,
    createFinalGatewayObserver,
    startInstrumentedChildOutput,
    CURRENT_GATEWAY_BUILD_LEAF,
    readCurrentGatewayBuildFile,
    validateCurrentGatewayBuildContext,
};
function project(options = {}) {
    const timers = new Set();
    let actors = 0;
    const forbidden = () => {
        actors++;
        throw Error('A physical actor is forbidden in this projection');
    };
    const proc = options.process ?? {
        env: {},
        platform: 'linux',
        arch: 'x64',
        version: 'v24.22.0',
        argv: ['node', 'closed-test'],
        execArgv: [],
        getuid: () => 1000,
        exitCode: undefined,
    };
    const context = vm.createContext({
        ...imports,
        Buffer,
        TextDecoder,
        JSON,
        Object,
        Array,
        Map,
        Set,
        Promise,
        structuredClone,
        process: proc,
        fs: Object.fromEntries(
            ['realpath', 'lstat', 'mkdir', 'open', 'opendir'].map((n) => [n, forbidden]),
        ),
        spawn: forbidden,
        performance: { now: () => 0 },
        setTimeout: forbidden,
        clearTimeout: forbidden,
        setInterval(fn, ms) {
            assert.equal(ms, 60000);
            const timer = { fn };
            timers.add(timer);
            return timer;
        },
        clearInterval(timer) {
            assert.ok(timers.delete(timer));
        },
    });
    // Only actual selected declarations; no whole CLI module/import/main body is executed.
    const text =
        declarations.join('\n').replaceAll('import.meta.url', JSON.stringify(cliURL.href)) +
        '\n' +
        report +
        '\nglobalThis.control={installAndObserve,cacheContentPath,censusFilesystem,npmEnvironment,withoutTrustValues,entry:observeGatewayInstallFromCurrentJob,report,retained};';
    const output = ts.transpileModule(text, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const exports = {};
    context.module = { exports };
    context.exports = exports;
    new vm.Script(output, { filename: 'actual-current-job-selected-units.cjs' }).runInContext(
        context,
    );
    return { ...context.control, timers, proc, actors: () => actors };
}
const fixtureContext = vm.createContext({ assert, Buffer, gzipSync });
const fixtureOutput = ts.transpileModule(
    one(tarAST, tarAST.statements, 'tar') +
        '\n' +
        one(tarAST, tarAST.statements, 'members') +
        '\nglobalThis.authored={tar,members};',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
new vm.Script(fixtureOutput).runInContext(fixtureContext);
const { tar, members } = fixtureContext.authored;

async function model() {
    const p = project();
    const base = sourceFixture();
    const versions = [
        ['ssh2', '1.17.0'],
        ['asn1', '0.2.6'],
        ['bcrypt-pbkdf', '1.0.2'],
        ['safer-buffer', '2.1.2'],
        ['tweetnacl', '0.14.5'],
    ];
    const bundles = versions.map(([name, version]) => ({
        path: 'node_modules/' + name,
        members: members(name, version),
    }));
    for (const row of bundles) row.bytes = tar(row.members);
    const lock = structuredClone(base.lock);
    delete lock.packages['node_modules/dep'];
    lock.packages['node_modules/ssh2'].dependencies = Object.fromEntries(
        versions.slice(1).map(([n, v]) => [n, '^' + v]),
    );
    for (let i = 0; i < bundles.length; i++) {
        const b = bundles[i],
            [name, version] = versions[i];
        lock.packages[b.path] = {
            ...(i === 0 ? lock.packages[b.path] : base.dep(name, version)),
            integrity: sri(b.bytes),
        };
    }
    const f = pipelineFixture(new Map([['package-lock.json', Buffer.from(JSON.stringify(lock))]]));
    const nodePath = '/tools/bin/node',
        npmPath = '/tools/lib/node_modules/npm/bin/npm-cli.js',
        nodeBytes = Buffer.from('authored Node file bytes, never executed');
    f.tools.runtime = {
        ...f.tools.runtime,
        executablePath: nodePath,
        executableSHA256: hash(nodeBytes),
        node: 'v24.22.0',
        versions: { node: '24.22.0' },
    };
    f.tools.npmEntryPath = npmPath;
    const { record } = await produceGatewayArchive(f.context, f.options, f.io);
    const artifacts = record.lockPreparation.cwd.replace(/\/stage$/, '') + '/artifacts/';
    f.filesystem.write(nodePath, nodeBytes);
    const opened = [],
        directoryHandles = new Set();
    const adjust = async (file) => ({
        ...(await f.filesystem.fs.lstat(file)),
        uid: 1000,
        gid: 1000,
        mode: file === nodePath ? 0o100755 : (await f.filesystem.fs.lstat(file)).mode,
    });
    const native = {
        realpath: (file) => f.filesystem.fs.realpath(file),
        lstat: adjust,
        mkdir: (file) => f.filesystem.fs.mkdir(file),
        async open(file, flags) {
            opened.push({ file, flags });
            if (flags & constants.O_DIRECTORY) {
                assert.equal(
                    flags,
                    constants.O_RDONLY |
                        constants.O_DIRECTORY |
                        constants.O_NOFOLLOW |
                        constants.O_NONBLOCK,
                );
                const h = {
                    stat: () => adjust(file),
                    sync: async () => {},
                    close: async () => {
                        directoryHandles.delete(h);
                    },
                };
                directoryHandles.add(h);
                return h;
            }
            const writing = Boolean(flags & constants.O_WRONLY);
            assert.equal(
                flags,
                writing
                    ? constants.O_WRONLY |
                          constants.O_CREAT |
                          constants.O_EXCL |
                          constants.O_NOFOLLOW
                    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            const h = await f.filesystem.fs.open(file, writing ? 'wx' : 'r');
            return {
                read: (...args) => h.read(...args),
                stat: () => adjust(file),
                sync: () => h.sync(),
                close: () => h.close(),
                async write(buffer, offset, length, position) {
                    const before = f.filesystem.bytes(file),
                        next = Buffer.alloc(Math.max(before.length, position + length));
                    before.copy(next);
                    buffer.copy(next, position, offset, offset + length);
                    await h.writeFile(next);
                    return { bytesWritten: length };
                },
            };
        },
        async opendir(file) {
            const rows = await f.filesystem.fs.readdir(file);
            return { read: async () => rows.shift() ?? null, close: async () => {} };
        },
    };
    const files = createOwnedWebFiles(native),
        manualTimers = new Set();
    let child,
        launches = 0,
        spawned = false,
        finished = false,
        pipes = false;
    const state = {
        failed: false,
        first: undefined,
        secondary: [],
        commands: [],
        archives: [],
        observer: null,
    };
    const input = {
        root: '/project',
        uid: 1000,
        nodePath,
        npmPath,
        builder: structuredClone(record.builder),
        expected: structuredClone(f.context),
        archive: f.filesystem.bytes(artifacts + record.archive.name),
        recordBytes: Buffer.from(JSON.stringify(record) + '\n'),
        checksum: f.filesystem.bytes(artifacts + record.checksum.name),
        sourceLockBytes: Buffer.from(f.files.get('package-lock.json')),
        eventBytes: Buffer.from('{"model":true}\n'),
        toolchainOriginals: [['selected-node.bin', nodeBytes]],
        environment: {
            PATH: '/tools/bin:/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TZ: 'UTC',
            NODE_ENV: 'production',
        },
    };
    const ports = {
        now: () => 0,
        setTimer(fn) {
            const timer = { fn };
            manualTimers.add(timer);
            return timer;
        },
        clearTimer(timer) {
            assert.ok(manualTimers.delete(timer));
        },
        launch(file, args, options) {
            launches++;
            assert.equal(file, nodePath);
            assert.equal(options.shell, false);
            assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
            assert.ok(
                args.includes('--ignore-scripts') &&
                    args.includes('--omit=optional') &&
                    args.includes('--fetch-retries=0'),
            );
            assert.ok(!args.includes('--offline'));
            assert.equal(args[0], npmPath);
            child = new EventEmitter();
            Object.assign(child, {
                stdin: null,
                stdout: new EventEmitter(),
                stderr: new EventEmitter(),
                exitCode: null,
                signalCode: null,
                pid: 4242,
                spawnfile: file,
                spawnargs: [file, ...args],
            });
            child.kill = () => {
                throw Error('No cleanup/signal port');
            };
            return child;
        },
    };
    function populate() {
        for (const b of bundles) {
            for (const m of b.members)
                f.filesystem.write(
                    '/project/validation/gateway-runtime/install/' +
                        b.path +
                        '/' +
                        m.name.slice('package/'.length),
                    m.bytes,
                );
            f.filesystem.write(
                p.cacheContentPath(
                    '/project/validation/gateway-runtime',
                    lock.packages[b.path].integrity,
                ),
                b.bytes,
            );
        }
    }
    function close(pipesNow = true) {
        if (!child) return;
        if (!spawned) {
            spawned = true;
            child.emit('spawn');
        }
        if (!finished) {
            populate();
            child.stdout.emit('data', Buffer.from('authored npm output\n'));
            finished = true;
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        }
        if (pipesNow && !pipes) {
            pipes = true;
            child.stdout.emit('close');
            child.stderr.emit('close');
        }
    }
    const execute = () =>
        p.installAndObserve(
            state,
            input,
            files.filesystem,
            (file, bytes) => files.filesystem.writeFile(file, bytes, { flag: 'wx' }),
            ports,
        );
    async function submitted(running) {
        for (let i = 0; i < 20000 && !child; i++) await Promise.resolve();
        assert.ok(child, 'Reach the actual command milestone');
        return running;
    }
    return {
        p,
        f,
        state,
        input,
        files,
        opened,
        bundles,
        manualTimers,
        directoryHandles,
        execute,
        submitted,
        close,
        get child() {
            return child;
        },
        launches: () => launches,
    };
}
function start(m) {
    const work = m.execute();
    const outcome = work.then(
        (value) => ({ value }),
        (error) => ({ error }),
    );
    return { work, outcome };
}

test('actual current-job entry refuses untrusted context before any actor or keeper', async () => {
    const p = project();
    await assert.rejects(p.entry());
    assert.equal(p.actors(), 0);
    assert.equal(p.timers.size, 0);
    const inherited = {
        HTTPS_PROXY: 'https://authored-proxy.invalid',
        NODE_EXTRA_CA_CERTS: '/authored-ca.pem',
        NODE_OPTIONS: '--untrusted',
        npm_config_ignore_scripts: 'false',
    };
    const selected = p.npmEnvironment(
        { PATH: '/tools/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
        inherited,
    );
    assert.equal(selected.HTTPS_PROXY, inherited.HTTPS_PROXY);
    assert.equal(selected.NODE_EXTRA_CA_CERTS, inherited.NODE_EXTRA_CA_CERTS);
    assert.equal(selected.NODE_OPTIONS, undefined);
    assert.equal(selected.npm_config_ignore_scripts, undefined);
    const raw = Buffer.from(
        'authored ' + inherited.HTTPS_PROXY + ' ' + inherited.NODE_EXTRA_CA_CERTS,
    );
    const redacted = p.withoutTrustValues(raw, selected);
    assert.ok(!redacted.includes(Buffer.from(inherited.HTTPS_PROXY)));
    assert.ok(!redacted.includes(Buffer.from(inherited.NODE_EXTRA_CA_CERTS)));
    assert.ok(raw.includes(Buffer.from(inherited.HTTPS_PROXY)));
});

test('actual canonical install joins command closure then compares census to five original SRI archives', async () => {
    const m = await model(),
        running = start(m);
    try {
        await m.submitted();
        m.close();
        const result = await running.work;
        assert.equal(m.launches(), 1);
        assert.equal(result.dependencyOrigin.packages.length, 5);
        assert.equal(result.dependencyOrigin.loadedCodeObserved, false);
        assert.equal(result.installation.loadedJavaScriptMapping, null);
        assert.equal(result.installation.dependencyArchiveIntegrity, null);
        assert.equal(m.state.commands[0].closed, true);
        assert.equal(m.state.commands[0].owner.observation().releaseAcceptance, false);
        assert.equal(m.state.archives.length, 5);
        for (let i = 0; i < m.state.archives.length; i++)
            assert.ok(
                m.f.filesystem
                    .bytes(
                        '/project/validation/gateway-runtime/inputs/dependency-' +
                            String(i + 1).padStart(2, '0') +
                            '.tgz',
                    )
                    .equals(m.state.archives[i].bytes),
            );
        assert.ok(
            m.opened.some(
                (r) =>
                    r.file.endsWith('/dist-gateway/main.cjs') &&
                    r.flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
            ),
        );
        m.files.owner.assertSettled();
        assert.equal(m.manualTimers.size, 0);
        assert.equal(m.f.filesystem.handles.size + m.directoryHandles.size, 0);
    } finally {
        m.close();
        await running.outcome;
    }
});

test('actual pending command and Error or undefined failure cannot advance to census or retry', async () => {
    for (const value of [null, Error('authored child failure'), undefined]) {
        const m = await model(),
            running = start(m);
        try {
            await m.submitted();
            m.close(false);
            await Promise.resolve();
            assert.equal(m.state.observer, null);
            assert.equal(m.state.commands[0].closed, false);
            if (value !== null) {
                m.child.emit('error', value);
                const failed = await running.outcome;
                assert.ok(failed.error);
                assert.equal(failed.error.cause, value);
                assert.equal(m.state.observer, null);
            }
            m.close();
            const result = await running.outcome;
            if (value === null) assert.ok(result.value);
            else assert.ok(result.error);
            assert.equal(m.launches(), 1);
            assert.equal(m.state.commands[0].closed, true);
        } finally {
            m.close();
            await running.outcome;
        }
    }
});

test('actual record/source/tool/checksum and original SRI mismatches refuse without replacing existing checks', async () => {
    for (const change of ['context', 'source-lock', 'tool', 'checksum', 'root']) {
        const m = await model();
        if (change === 'context') m.input.expected.sourceCommit = 'f'.repeat(40);
        if (change === 'source-lock') m.input.sourceLockBytes = Buffer.from('{}');
        if (change === 'tool') m.input.builder.runtime.executableSHA256 = 'f'.repeat(64);
        if (change === 'checksum') m.input.checksum = Buffer.from('wrong');
        if (change === 'root') m.input.root = '/unrelated';
        await assert.rejects(m.execute());
        assert.equal(m.launches(), 0);
        assert.equal(m.state.commands.length, 0);
    }
    const m = await model(),
        running = start(m);
    try {
        await m.submitted();
        m.close(false);
        const b = m.bundles[0],
            cache = m.p.cacheContentPath('/project/validation/gateway-runtime', sri(b.bytes));
        m.f.filesystem.write(cache, Buffer.from('wrong original archive bytes'));
        m.close();
        const outcome = await running.outcome;
        assert.ok(outcome.error);
        assert.equal(m.launches(), 1);
        assert.equal(m.state.origin, undefined);
        assert.equal(m.state.observer.snapshot().primaryFailure, true);
    } finally {
        m.close();
        await running.outcome;
    }
});

test('actual output reporter owns its keeper before writes and retains raw Error or undefined without retry', async () => {
    for (const failure of [null, Error('authored output failure'), undefined]) {
        const p = project();
        let writes = 0;
        const stream = new EventEmitter();
        stream.write = (_bytes, callback) => {
            writes++;
            assert.equal(p.timers.size, 1);
            if (failure !== null) throw failure;
            callback();
            return true;
        };
        const running = p.report(stream, Buffer.from('finite model report\n'));
        if (failure === null) {
            await running;
            assert.equal(p.timers.size, 0);
        } else {
            await assert.rejects(running);
            assert.equal(p.timers.size, 1);
            const lease = Array.from(p.retained)[0];
            assert.equal(lease.firstSet, true);
            assert.equal(lease.first, failure);
            assert.equal(lease.output.snapshot().unknownOperation, true);
            assert.equal(p.proc.exitCode, 1);
        }
        assert.equal(writes, 1);
        assert.equal(p.actors(), 0);
    }
});
