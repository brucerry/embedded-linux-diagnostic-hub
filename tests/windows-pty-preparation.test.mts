// @ts-nocheck
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { finalPtyClosure } from './fixtures/pty-closure';
import {
    ptyTerminalObservation,
    ptyCompileObservation,
} from './fixtures/pty-terminal-observation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const requireHash = (b) => createHash('sha256').update(b).digest('hex');
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    preparePtyBridge,
    preparedPtyIdentity,
    verifyPreparedPtyBridge,
    verifyPreparedPtyBridgeSync,
    ptyLoadObservation,
    verifyPtyProcessBirth,
    preparedDescriptorOwnership,
} from '../scripts/lib/pty-bridge-preparation.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { ptyBridgeArguments } from './fixtures/winpty-identity';
const now = () => Number(process.hrtime.bigint() / 1000000n);
const birth = (t) => {
    const unix = BigInt(t) - 116444736000000000n;
    return (
        new Date(Number((unix / 10000000n) * 1000n)).toISOString().slice(0, 19) +
        '.' +
        String(unix % 10000000n).padStart(7, '0') +
        'Z'
    );
};
function fact() {
    return {
        schema: 1,
        kind: 'pty-compile-observation',
        clockDomain: 'helper-stopwatch',
        pid: 321,
        createdFileTime: '134000000000000000',
        frequency: '10000000',
        callStart: '100',
        callEnd: '200',
        cpuBefore: {
            available: true,
            totalTicks: '10',
            userTicks: '5',
            kernelTicks: '5',
            sampledAt: '90',
        },
        cpuAfter: {
            available: true,
            totalTicks: '20',
            userTicks: '10',
            kernelTicks: '10',
            sampledAt: '205',
        },
        beforeLoggingStart: '50',
        beforeLoggingEnd: '80',
        afterLoggingStart: '210',
        afterLoggingEnd: '220',
        identityCaptureStart: '230',
        identityCaptureEnd: '250',
        callSucceeded: true,
        callError: null,
        powershellVersion: '7.5.1',
        edition: 'Core',
        dotnetVersion: '9.0.0',
        processorCount: 4,
        powershellFile: { path: 'C:\\pwsh.exe', sha256: 'a'.repeat(64) },
        loadedAssemblies: [
            'System.Management.Automation',
            'System.Private.CoreLib',
            'Microsoft.CodeAnalysis',
            'Microsoft.CodeAnalysis.CSharp',
        ].map((name) => ({
            name,
            available: false,
            reason: 'Controlled unavailable loaded identity',
        })),
        hostLoad: { available: false, reason: 'No additional host sampler' },
    };
}

async function fixture(kind = 'success') {
    const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'hub-real-pty-'));
    const source = path.join(root, 'bridge.cs'),
        script = path.join(root, 'bridge.ps1'),
        artifactPath = path.join(root, 'bridge.dll');
    await fsp.writeFile(source, 'controlled C# source');
    await fsp.writeFile(script, 'controlled compiler script');
    const controller = new AbortController(),
        holds = [],
        events = [];
    let child,
        compilerLaunch,
        spawns = 0,
        descendantReads = 0;
    let held,
        referenced = false;
    const hold = (e) => {
        holds.push(e);
        held ??= createOwnershipHold(
            { kind: 'controlled-preparation-unknown', reason: String(e) },
            () => {},
            {
                interval: () => ({
                    ref() {
                        referenced = true;
                    },
                }),
            },
        );
        startup.stopQueryAdmission();
    };
    const startup = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 3000,
        cleanupDeadline: now() + 3000,
        timeoutMs: 200,
        diagnostics: true,
        emit: async (s, d) => events.push({ s, d }),
        hold,
        identity: async (c) => [
            {
                pid: c.pid,
                created: birth(c.pid === 321 ? '134000000000000000' : '134000000000000001'),
                state: 'running',
            },
        ],
        proveDescendants: async (c) => {
            descendantReads++;
            if (kind === 'unknown-descendant') throw Error('descendant unknown');
            assert(c.closed);
        },
    });
    const finish = (code = 0) => {
        if (child.closed) return;
        child.closed = true;
        child.emit('exit', code, null);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', code, null);
    };
    const options = {
        startup,
        signal: controller.signal,
        deadline: now() + 1000,
        cleanupDeadline: now() + 2000,
        cancel: (e) => controller.abort(e),
        hold,
        emit: async (s, d) => {
            if (kind === 'evidence-fail' && s === 'pty-compile-closed')
                throw Error('durable append failed');
            events.push({ s, d });
        },
        check() {},
        executable: 'bound-pwsh',
        expectedCompiler: fact().powershellFile,
        context: {
            sourceSHA256: 'a'.repeat(64),
            bindingSHA256: 'b'.repeat(64),
            nonce: '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e',
            root,
        },
        args: ['compile-only'],
        env: {},
        artifactPath,
        inputs: [source, script],
    };
    if (kind === 'compiler-identity')
        options.expectedCompiler = { ...options.expectedCompiler, sha256: 'f'.repeat(64) };
    if (kind === 'timeout' || kind === 'unknown-pipes') options.deadline = now() + 20;
    if (kind === 'unknown-pipes') options.cleanupDeadline = now() + 50;
    if (kind === 'pre-abort') controller.abort(Error('cancelled before compile'));
    const spawnPort = (executable, args, settings) => {
        compilerLaunch = { executable, args, settings };
        spawns++;
        child = Object.assign(new EventEmitter(), {
            pid: 321,
            closed: false,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill() {
                if (kind !== 'unknown-pipes') finish(1);
                return true;
            },
        });
        child.stdin.resume();
        if (['timeout', 'abort'].includes(kind))
            child.stdin.on('end', () => setTimeout(() => finish(1), 40));
        setImmediate(async () => {
            if (kind === 'abort') {
                controller.abort(Error('cancel during compile'));
                return;
            }
            if (['timeout', 'unknown-pipes'].includes(kind)) return;
            try {
                if (kind !== 'missing-artifact')
                    await fsp.writeFile(
                        artifactPath,
                        kind === 'empty-artifact'
                            ? Buffer.alloc(0)
                            : Buffer.from('controlled emitted assembly'),
                    );
                if (kind === 'unexpected-output')
                    await fsp.writeFile(path.join(root, 'unexpected.pdb'), 'extra output');
                const data = fact();
                if (kind === 'wrong-pid') data.pid = 999;
                if (kind === 'failed-call') {
                    data.callSucceeded = false;
                    data.callError = 'compile refused';
                    data.afterLoggingStart = null;
                    data.afterLoggingEnd = null;
                }
                let output = 'HUB_OS_PTY_COMPILE ' + JSON.stringify(data) + '\n';
                if (kind === 'truncated') output = output.slice(0, -1);
                if (kind === 'output-overflow') output = 'x'.repeat(65537);
                const emitted = await fsp.readFile(artifactPath).catch(() => Buffer.alloc(0));
                const managed = {
                    schema: 1,
                    kind: 'pty-compiled-artifact',
                    pid: 321,
                    path: artifactPath,
                    sha256: requireHash(emitted),
                    bytes: emitted.length,
                    fullName: 'controlled-assembly, Version=0.0.0.0',
                };
                if (kind === 'artifact-wrong-hash') managed.sha256 = 'f'.repeat(64);
                const artifactWire = 'HUB_OS_PTY_ARTIFACT ' + JSON.stringify(managed) + '\n';
                if (kind !== 'artifact-receipt-missing') output += artifactWire;
                if (kind === 'artifact-receipt-duplicate') output += artifactWire;
                child.stderr.write(output);
                if (kind === 'stdout') child.stdout.write('unexpected shell bytes');
                finish(kind === 'compiler-fail' ? 1 : 0);
            } catch (e) {
                holds.push(e);
                finish(1);
            }
        });
        return child;
    };
    const run = (ports = {}) => preparePtyBridge(options, { spawnPort, ...ports });
    return {
        root,
        artifactPath,
        source,
        script,
        options,
        holds,
        events,
        startup,
        controller,
        run,
        finish,
        get compilerLaunch() {
            return compilerLaunch;
        },
        get child() {
            return child;
        },
        get spawns() {
            return spawns;
        },
        get referenced() {
            return referenced;
        },
        get descendantReads() {
            return descendantReads;
        },
        async close() {
            if (child && !child.closed) finish(1);
            await startup.join().catch(() => {});
            await fsp.rm(root, { recursive: true, force: true });
        },
    };
}
test('actual preparation helper admits an artifact only after shared controller identity/descendant/pipe join', async () => {
    const f = await fixture();
    try {
        const p = await f.run();
        assert.equal(f.spawns, 1);
        assert(f.startup.children.get(f.child).joined);
        assert(f.descendantReads > 0);
        assert(Object.isFrozen(p));
        assert.equal(p.compilerPID, 321);
        assert.equal(p.inputs.length, 2);
        assert.equal(p.artifact.path, f.artifactPath);
        assert.deepEqual(await verifyPreparedPtyBridge(p), p);
        const receipt = f.events.find((e) => e.s === 'pty-compile-closed');
        assert(receipt.d.descendantsClosed && receipt.d.pipesClosed);
        assert.equal(f.holds.length, 0);
    } finally {
        await f.close();
    }
});
for (const kind of [
    'compiler-fail',
    'failed-call',
    'missing-artifact',
    'wrong-pid',
    'truncated',
    'stdout',
    'output-overflow',
    'evidence-fail',
    'unexpected-output',
    'empty-artifact',
    'artifact-receipt-missing',
    'artifact-receipt-duplicate',
    'artifact-wrong-hash',
    'compiler-identity',
])
    test('no runtime artifact admission after ' + kind, async () => {
        const f = await fixture(kind);
        try {
            await assert.rejects(f.run());
            assert.equal(f.spawns, 1);
            assert(f.controller.signal.aborted);
            assert(!f.events.some((e) => e.s === 'pty-compile-closed'));
            assert(f.startup.children.get(f.child).joined);
        } finally {
            await f.close();
        }
    });
for (const kind of ['pre-abort', 'abort', 'timeout'])
    test(
        'compilation ' +
            kind +
            ' preserves work cutoff and positively joins the tracked child before refusal',
        async () => {
            const f = await fixture(kind);
            try {
                const d = f.options.deadline,
                    c = f.options.cleanupDeadline;
                await assert.rejects(f.run());
                assert.equal(f.options.deadline, d);
                assert.equal(f.options.cleanupDeadline, c);
                assert.equal(f.spawns, kind === 'pre-abort' ? 0 : 1);
                if (f.child) assert(f.startup.children.get(f.child).joined);
                assert(!f.events.some((e) => e.s === 'pty-compile-closed'));
            } finally {
                await f.close();
            }
        },
    );
for (const kind of ['unknown-pipes', 'unknown-descendant'])
    test(kind + ' retains hold; compiler success/kill request is not closure', async () => {
        const f = await fixture(kind);
        try {
            await assert.rejects(f.run());
            assert(f.holds.length > 0);
            assert(f.referenced);
            assert(!f.events.some((e) => e.s === 'pty-compile-closed'));
        } finally {
            await f.close();
        }
    });
for (const change of ['bytes', 'replacement', 'source', 'script', 'symlink', 'size', 'hardlink'])
    test('prepared artifact/input identity rejects ' + change, async () => {
        const f = await fixture();
        try {
            const p = await f.run();
            if (change === 'bytes') await fsp.appendFile(f.artifactPath, 'changed');
            if (change === 'replacement') {
                const bytes = await fsp.readFile(f.artifactPath);
                await fsp.rename(f.artifactPath, f.artifactPath + '.old');
                await fsp.writeFile(f.artifactPath, bytes);
            }
            if (change === 'source') await fsp.appendFile(f.source, 'changed');
            if (change === 'script') await fsp.appendFile(f.script, 'changed');
            if (change === 'symlink') {
                await fsp.rename(f.artifactPath, f.artifactPath + '.old');
                await fsp.symlink(f.artifactPath + '.old', f.artifactPath);
            }
            if (change === 'size') await fsp.writeFile(f.artifactPath, Buffer.alloc(1048577));
            if (change === 'hardlink') await fsp.link(f.artifactPath, f.artifactPath + '.alias');
            await assert.rejects(verifyPreparedPtyBridge(p));
        } finally {
            await f.close();
        }
    });
test('fresh runtime argv selects only byte-bound assembly loading; legacy callers keep their prior compile path', () => {
    const args = ptyBridgeArguments(
        'C:\\Git\\bash.exe',
        'C:\\source\\bridge.ps1',
        'C:\\private',
        'C:\\private\\bridge.dll',
    );
    assert.deepEqual(args.slice(-2), ['-PreparedAssembly', 'C:\\private\\bridge.dll']);
    assert(!args.includes('-CompileOnly'));
    assert(args.includes('15000'));
    assert(
        !ptyBridgeArguments('C:\\Git\\bash.exe', 'bridge.ps1', 'C:\\private').includes(
            '-PreparedAssembly',
        ),
    );
    const ps = fs.readFileSync(new URL('./fixtures/winpty-bridge.ps1', import.meta.url), 'utf8');
    const runtime = ps.slice(
        ps.indexOf('if($PreparedAssembly) {'),
        ps.indexOf('# Counters and stamps'),
    );
    assert(
        runtime.includes('ComputeHash($bytes)') &&
            runtime.includes('[Reflection.Assembly]::Load($bytes)'),
    );
    assert(
        runtime.indexOf('Prepared assembly bytes changed.') <
            runtime.indexOf('[Reflection.Assembly]::Load($bytes)'),
    );
    assert(!runtime.includes('Add-Type'));
    assert(ps.indexOf('if($CompileOnly){') < ps.indexOf('[HubWinptyFixture]::Run'));
    assert(ps.indexOf('    exit 0') < ps.indexOf('[HubWinptyFixture]::Run'));
    const actor = fs.readFileSync(
        new URL('./fixtures/console-real-pty-assertions.ts', import.meta.url),
        'utf8',
    );
    assert(actor.includes('readyTimeoutMs: 7000'));
    assert(actor.includes('            7000,'));
    const stage = fs.readFileSync(
        new URL('../scripts/windows-native-pilot-stage.mts', import.meta.url),
        'utf8',
    );
    assert(stage.includes('deadline: envelope.stageDeadline'));
});
function loadFact(prepared, pid = 654) {
    return {
        schema: 1,
        kind: 'pty-artifact-load',
        pid,
        createdFileTime: '134000000000000001',
        compilerPID: prepared.compilerPID,
        compilerCreatedFileTime: prepared.compilerCreatedFileTime,
        artifact: structuredClone(prepared.artifact),
        context: structuredClone(prepared.context),
        runtime: structuredClone(prepared.runtime),
        loadedType: 'HubWinptyFixture',
        moduleVersionId: '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e',
    };
}
for (const wrong of [
    'none',
    'missing',
    'duplicate',
    'pid',
    'birth',
    'compiler',
    'source',
    'runtime',
    'artifact',
    'type',
    'module',
    'partial',
    'extra',
])
    test('fresh consumer load protocol ' + wrong, async () => {
        const f = await fixture();
        try {
            const p = await f.run(),
                d = loadFact(p);
            let wire = '';
            if (wrong === 'pid') d.pid = 999;
            if (wrong === 'birth') {
                d.pid = p.compilerPID;
                d.createdFileTime = p.compilerCreatedFileTime;
            }
            if (wrong === 'compiler') d.compilerPID = 999;
            if (wrong === 'source') d.context.sourceSHA256 = 'f'.repeat(64);
            if (wrong === 'runtime') d.runtime.dotnetVersion = 'foreign';
            if (wrong === 'artifact') d.artifact.sha256 = 'f'.repeat(64);
            if (wrong === 'type') d.loadedType = 'Other';
            if (wrong === 'module') d.moduleVersionId = 'invalid';
            if (wrong === 'extra') d.authority = true;
            if (wrong !== 'missing') wire = 'HUB_OS_PTY_LOAD ' + JSON.stringify(d) + '\n';
            if (wrong === 'duplicate') wire += wire;
            if (wrong === 'partial') wire = wire.slice(0, -1);
            if (['missing', 'partial'].includes(wrong))
                assert.equal(ptyLoadObservation(wire, 654, p), undefined);
            else if (wrong === 'none') assert.deepEqual(ptyLoadObservation(wire, 654, p), d);
            else assert.throws(() => ptyLoadObservation(wire, 654, p));
        } finally {
            await f.close();
        }
    });
for (const fault of ['open', 'sync', 'readFile', 'stat', 'close'])
    test(
        'prepared artifact ' + fault + ' failure cannot publish admission or erase custody',
        async () => {
            const f = await fixture();
            try {
                const fsPort = {
                    ...fsp,
                    async open(file, flags) {
                        if (file === f.artifactPath && flags === 'r+' && fault === 'open')
                            throw Error('injected open failure');
                        const fd = await fsp.open(file, flags);
                        if (file !== f.artifactPath || flags !== 'r+') return fd;
                        return {
                            stat: async (...args) => {
                                if (fault === 'stat') throw Error('injected stat failure');
                                return fd.stat(...args);
                            },
                            sync: async () => {
                                if (fault === 'sync') throw Error('injected sync failure');
                                return fd.sync();
                            },
                            readFile: async () => {
                                if (fault === 'readFile') throw Error('injected read failure');
                                return fd.readFile();
                            },
                            close: async () => {
                                await fd.close();
                                if (fault === 'close') throw Error('injected close failure');
                            },
                        };
                    },
                };
                await assert.rejects(f.run({ fsPort }));
                assert(f.holds.length > 0);
                assert(f.referenced);
                assert(!f.events.some((e) => e.s === 'pty-compile-closed'));
                assert(fs.existsSync(f.root));
            } finally {
                await f.close();
            }
        },
    );
const leafReceipt = {
    complete: true,
    exitCode: 0,
    timedOut: false,
    bashExited: true,
    agentExited: true,
    inputPumpJoined: true,
    outputPumpJoined: true,
    outputDrained: true,
    pipesClosed: true,
    handlesClosed: true,
    terminationConfirmed: true,
    childPid: 100,
    agentPid: 101,
    childCreated: '100',
    agentCreated: '101',
};
for (const route of [
    'valid',
    'missing-load',
    'duplicate-load',
    'foreign-load',
    'cancel-before-open',
    'cancel-at-spawn',
    'tamper-before-open',
    'delayed-load-ack',
    'load-ack-fail',
    'late-identity-mismatch',
])
    test(
        'actual fixture adapter consumes prepared artifact through a fresh tracked runtime: ' +
            route,
        async () => {
            const f = await fixture();
            let runtime;
            try {
                const prepared = await f.run(),
                    frames = [],
                    holds = [],
                    session = new EventEmitter();
                let accepts = 0,
                    spawns = 0,
                    checks = 0;
                let releaseLoadAck;
                const loadAck = new Promise((r) => (releaseLoadAck = r));
                if (route === 'tamper-before-open')
                    await fsp.appendFile(f.artifactPath, 'tampered');
                const ts = createRequire(import.meta.url)('typescript'),
                    source = fs.readFileSync(
                        new URL('./fixtures/os-pty.ts', import.meta.url),
                        'utf8',
                    );
                const code = ts.transpileModule(
                    'async function create(){' +
                        source.slice(source.indexOf('    let firstStdout = false;')),
                    {
                        compilerOptions: {
                            target: ts.ScriptTarget.ES2022,
                            module: ts.ModuleKind.None,
                        },
                    },
                ).outputText;
                class Channel extends EventEmitter {
                    destroyed = false;
                    writableEnded = false;
                    write() {
                        return true;
                    }
                    pause() {}
                    resume() {}
                    end() {
                        this.writableEnded = true;
                    }
                    exit() {}
                    close() {
                        if (!this.destroyed) {
                            this.destroyed = true;
                            this.emit('close');
                        }
                    }
                }
                const channel = new Channel();
                const options = {
                    maxOpenings: 1,
                    signal: f.controller.signal,
                    bridgePreparation: { deadline: f.options.deadline, startup: f.startup },
                    check() {
                        checks++;
                        if (route === 'cancel-at-spawn' && checks === 3)
                            f.controller.abort(Error('cancel immediately before spawn'));
                    },
                    registerChild(c, stop) {
                        f.startup.adopt('bash-winpty-bridge', c, stop);
                    },
                    terminalDiagnostic: (d) => {
                        frames.push(d);
                        if (d.kind === 'pty-artifact-load' && route === 'delayed-load-ack')
                            return loadAck;
                        if (d.kind === 'pty-artifact-load' && route === 'load-ack-fail')
                            return Promise.reject(Error('controlled durable load record failed'));
                    },
                };
                const context = {
                    Buffer,
                    JSON,
                    Promise,
                    Set,
                    Map,
                    Error,
                    setTimeout,
                    clearTimeout,
                    performance,
                    process,
                    path,
                    fs: fsp,
                    home: f.root,
                    homeIdentity: await fsp.lstat(f.root, { bigint: true }),
                    temp: path.dirname(f.root),
                    homeUnix: f.root,
                    toolIdentities: { pwsh: { path: 'bound-runtime' } },
                    bashExecutable: 'C:\\Git\\bash.exe',
                    prepared,
                    helperEnvironment: {},
                    options,
                    holdUnknown: (e) => holds.push(e),
                    timing() {},
                    verifyPreparedPtyBridge,
                    verifyPreparedPtyBridgeSync,
                    ptyLoadObservation,
                    verifyPtyProcessBirth,
                    ptyCompileObservation,
                    ptyTerminalObservation,
                    finalPtyClosure,
                    ptyBridgeArguments,
                    spawn(executable, args, settings) {
                        spawns++;
                        assert.equal(executable, 'bound-runtime');
                        assert.equal(
                            JSON.parse(settings.env.HUB_TEST_WINPTY_PREPARED).artifact.sha256,
                            prepared.artifact.sha256,
                        );
                        assert(args.includes('-PreparedAssembly'));
                        assert(!args.includes('-CompileOnly'));
                        runtime = Object.assign(new EventEmitter(), {
                            pid: 654,
                            stdin: new PassThrough(),
                            stdout: new PassThrough(),
                            stderr: new PassThrough(),
                            closed: false,
                        });
                        runtime.stdin.resume();
                        return runtime;
                    },
                };
                vm.createContext(context);
                vm.runInContext(code, context);
                const adapter = await context.create();
                adapter.attachShell(session);
                if (route === 'cancel-before-open')
                    f.controller.abort(Error('cancelled after compile before open'));
                if (
                    ['cancel-before-open', 'cancel-at-spawn', 'tamper-before-open'].includes(route)
                ) {
                    assert.throws(() =>
                        session.emit('shell', () => {
                            accepts++;
                            return channel;
                        }),
                    );
                    assert.equal(spawns, 0);
                    if (route === 'tamper-before-open') assert(holds.length);
                    return;
                }
                session.emit('shell', () => {
                    accepts++;
                    return channel;
                });
                assert.equal(spawns, 1);
                assert.equal(accepts, 1);
                assert.notEqual(runtime, f.child);
                assert.equal(f.spawns, 1);
                let earlyClose;
                if (route === 'late-identity-mismatch') earlyClose = adapter.close();
                const load = loadFact(prepared);
                if (route === 'late-identity-mismatch') load.createdFileTime = '134000000000000020';
                if (route === 'foreign-load') load.context.nonce = 'other-owner';
                const wire = 'HUB_OS_PTY_LOAD ' + JSON.stringify(load) + '\n';
                if (route !== 'missing-load') runtime.stderr.write(wire);
                if (route === 'duplicate-load') runtime.stderr.write(wire);
                runtime.stderr.write('HUB_OS_PTY_CLOSE ' + JSON.stringify(leafReceipt) + '\n');
                runtime.closed = true;
                runtime.emit('exit', 0, null);
                runtime.stdout.end();
                runtime.stderr.end();
                runtime.emit('close', 0, null);
                await adapter.settled();
                if (route === 'valid' || route === 'delayed-load-ack') {
                    const closing = adapter.close();
                    if (route === 'delayed-load-ack') {
                        await new Promise(setImmediate);
                        assert(fs.existsSync(f.root));
                        releaseLoadAck();
                    }
                    await closing;
                    assert.equal(holds.length, 0);
                    assert.equal(frames.filter((x) => x.kind === 'pty-artifact-load').length, 1);
                    assert(!fs.existsSync(f.root));
                } else {
                    await assert.rejects(earlyClose ?? adapter.close());
                    assert(holds.length > 0);
                    assert(fs.existsSync(f.root));
                }
                assert((await f.startup.join()).complete);
            } finally {
                if (runtime && !runtime.closed) {
                    runtime.closed = true;
                    runtime.emit('exit', 1, null);
                    runtime.emit('close', 1, null);
                }
                await f.close();
            }
        },
    );
test('guard descriptor close uncertainty remains owned after ordinary read success', async () => {
    const f = await fixture();
    try {
        const p = await f.run(),
            before = preparedDescriptorOwnership();
        let target;
        const port = {
            ...fs,
            openSync(file, flags) {
                const fd = fs.openSync(file, flags);
                if (file === p.artifact.path) target = fd;
                return fd;
            },
            closeSync(fd) {
                fs.closeSync(fd);
                if (fd === target) throw Error('controlled close result unknown');
            },
        };
        assert.throws(() => verifyPreparedPtyBridgeSync(p, port), /close result unknown/);
        assert.equal(preparedDescriptorOwnership().sync, before.sync + 1);
    } finally {
        await f.close();
    }
});
test('async artifact read fault and failed close retain both first cause and descriptor custody', async () => {
    const f = await fixture();
    try {
        const before = preparedDescriptorOwnership();
        await fsp.writeFile(f.artifactPath, 'controlled artifact');
        const port = {
            ...fsp,
            async open(file, flags) {
                const fd = await fsp.open(file, flags);
                return {
                    stat: (...a) => fd.stat(...a),
                    readFile: async () => {
                        throw Error('first read fault');
                    },
                    close: async () => {
                        await fd.close();
                        throw Error('later close unknown');
                    },
                };
            },
        };
        await assert.rejects(
            preparedPtyIdentity(f.artifactPath, { fsPort: port }),
            (e) =>
                e instanceof AggregateError &&
                e.errors[0].message === 'first read fault' &&
                e.errors[1].message === 'later close unknown',
        );
        assert.equal(preparedDescriptorOwnership().async, before.async + 1);
    } finally {
        await f.close();
    }
});
for (const size of [1048575, 1048576, 1048577])
    test('prepared artifact byte boundary ' + size, async () => {
        const f = await fixture();
        try {
            await fsp.writeFile(f.artifactPath, Buffer.alloc(size, 1));
            if (size <= 1048576)
                assert.equal((await preparedPtyIdentity(f.artifactPath)).bytes, size);
            else await assert.rejects(preparedPtyIdentity(f.artifactPath));
        } finally {
            await f.close();
        }
    });
test('compiler arguments and input bytes are snapshotted before asynchronous admission', async () => {
    const f = await fixture();
    try {
        const emit = f.options.emit;
        f.options.emit = async (s, d) => {
            if (s === 'pty-compile-before') f.options.args.push('later mutation');
            await emit(s, d);
        };
        const p = await f.run();
        assert.deepEqual(p.compilerArguments, ['compile-only']);
        assert.deepEqual(f.compilerLaunch.args, ['compile-only']);
        assert.deepEqual(
            JSON.parse(f.compilerLaunch.settings.env.HUB_TEST_WINPTY_COMPILE_INPUTS),
            p.inputs,
        );
        const ps = fs.readFileSync(
            new URL('./fixtures/winpty-bridge.ps1', import.meta.url),
            'utf8',
        );
        assert(ps.indexOf('$sourceLocks=@()') < ps.indexOf('$callStart='));
        assert(ps.includes('[IO.FileShare]::Read'));
        assert(ps.indexOf('Compiler input bytes changed.') < ps.indexOf('Add-Type -Path'));
        assert(ps.indexOf('$sourceCloseFailure=$null') > ps.indexOf('finally { $callEnd='));
    } finally {
        await f.close();
    }
});

test('supplemental birth binding preserves the retained Win32_Process versus StartTime precision difference', () => {
    const owned = [{ pid: 3176, created: '2026-10-20T05:36:11.0254260Z' }];
    verifyPtyProcessBirth(3176, '134369481710254268', owned);
    assert.throws(() => verifyPtyProcessBirth(3176, '134369481710254270', owned));
    assert.throws(() => verifyPtyProcessBirth(3177, '134369481710254268', owned));
});
