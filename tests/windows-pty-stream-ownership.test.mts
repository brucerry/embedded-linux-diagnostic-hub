// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { finalPtyClosure } from './fixtures/pty-closure';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
const ts = createRequire(import.meta.url)('typescript');
const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'tests/fixtures/os-pty.ts'), 'utf8');
const at = source.indexOf('    let firstStdout = false;');
assert(at > 0);
// Execute the actual complete stream/abort/close adapter, replacing only host discovery and spawn ports.
const code = ts.transpileModule('async function create(){' + source.slice(at), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const now = () => Number(process.hrtime.bigint() / 1000000n);
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
    agentPid: 100,
    childCreated: '100',
    agentCreated: '100',
};
const bounded = async (p, label) => {
    let timer;
    try {
        return await Promise.race([
            p,
            new Promise(
                (_, reject) =>
                    (timer = setTimeout(
                        () => reject(Error('Controlled ' + label + ' did not settle')),
                        2000,
                    )),
            ),
        ]);
    } finally {
        clearTimeout(timer);
    }
};
async function exercise(kind, { active = false, unknown = false, badReceipt = false } = {}) {
    const parent = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'hub-pty-stream-'));
    const home = await fsp.mkdtemp(path.join(parent, 'hub-real-pty-'));
    const homeIdentity = await fsp.lstat(home, { bigint: true });
    const controller = new AbortController(),
        diagnostics = [],
        roots = [],
        holds = [];
    let child,
        referenced = false,
        held;
    const holdUnknown = (e) => {
        holds.push(String(e));
        held ??= createOwnershipHold(
            { kind: 'controlled-pty-stream-hold', reason: String(e) },
            () => {},
            {
                interval: () => ({
                    ref() {
                        referenced = true;
                    },
                }),
            },
        );
    };
    const startup = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 10000,
        cleanupDeadline: now() + 10000,
        timeoutMs: 2000,
        emit: async () => {},
        hold: holdUnknown,
        identity: (c) =>
            new Promise((resolve) =>
                c.once('message', (m) =>
                    resolve({
                        pid: c.pid,
                        created: m.created,
                        basis: 'Controlled Node leaf self-report, not OS creation identity',
                    }),
                ),
            ),
        proveDescendants: async (c) => {
            if (unknown) throw Error('Controlled descendant proof unavailable');
            assert.notEqual(c.exitCode, null);
            assert(c.stdout.readableEnded && c.stderr.readableEnded);
        },
    });
    class Channel extends EventEmitter {
        destroyed = false;
        writableEnded = false;
        writes = 0;
        write() {
            this.writes++;
            return false;
        }
        pause() {}
        resume() {}
        end() {}
        exit() {}
        close() {
            this.emit('close');
        }
    }
    const channel = new Channel(),
        session = new EventEmitter();
    const receipt = { ...leafReceipt, ...(badReceipt ? { inputPumpJoined: false } : {}) };
    const grandchild =
        'setTimeout(()=>{process.stdout.write(Buffer.alloc(262144,120));process.stderr.write(' +
        JSON.stringify('HUB_OS_PTY_CLOSE ' + JSON.stringify(receipt) + '\n') +
        ');},100);';
    const leaf =
        'process.stdin.resume();' +
        (active ? "process.stdout.write('ACTIVE');" : '') +
        "process.stdin.on('end',()=>{const c=require('node:child_process').spawn(process.execPath,['-e'," +
        JSON.stringify(grandchild) +
        "],{stdio:['ignore',1,2]});process.send({descendantPID:c.pid},()=>process.exit(0));});process.send({ready:true,pid:process.pid,created:String(performance.timeOrigin)});";
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
        home,
        homeIdentity,
        temp: parent,
        homeUnix: home,
        toolIdentities: {
            pwsh: { path: 'controlled-node-port' },
            dll: { path: 'controlled-dll-port' },
            agent: { path: 'controlled-agent-port' },
        },
        bashExecutable: 'controlled-bash-port',
        binary: 'controlled',
        gitRoot: 'controlled',
        options: {
            signal: controller.signal,
            registerChild(c, stop) {
                startup.adopt('controlled-pty-bridge', c, stop);
            },
            diagnostic(s) {
                diagnostics.push(JSON.parse(s));
            },
        },
        holdUnknown,
        timing(phase, extra) {
            diagnostics.push({ phase, ...extra });
        },
        ptyBridgeArguments() {
            return [];
        },
        finalPtyClosure,
        spawn() {
            child = spawn(process.execPath, ['-e', leaf], {
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            roots.push(child.pid);
            return child;
        },
    };
    let fixture, pendingClose, joined, observed;
    try {
        fixture = await vm.runInNewContext(code + 'create()', context);
        fixture.attachShell(session);
        session.emit('shell', () => channel);
        child.on('message', (m) => {
            if (m.descendantPID) roots.push(m.descendantPID);
        });
        await bounded(startup.children.get(child).identityTask, 'root identity');
        if (active) {
            for (let i = 0; i < 40 && !channel.writes; i++)
                await new Promise((r) => setTimeout(r, 5));
            assert.equal(channel.writes, 1);
            assert(child.stdout.isPaused());
            channel.emit('drain');
            assert(!child.stdout.isPaused());
        }
        const beforeWrites = channel.writes;
        if (kind === 'end') channel.emit('end');
        else if (kind === 'close') channel.emit('close');
        else if (kind === 'abort') controller.abort(Error('Controlled abort'));
        else if (kind === 'owner-stop') startup.cancel();
        else if (kind === 'fixture-close') {
            pendingClose = fixture.close();
            void pendingClose.catch(() => {});
        } else throw Error('Unexpected controlled stop route');
        channel.emit('data', Buffer.from('FORBIDDEN_LATE_INPUT'));
        if (badReceipt) {
            await assert.rejects(
                () => bounded(fixture.settled(), 'invalid receipt'),
                /inputPumpJoined/,
            );
            assert(referenced && held);
        } else {
            await bounded(fixture.settled(), 'outer pipe closure');
            if (unknown) {
                await assert.rejects(() => startup.join(), /descendant proof unavailable/);
                assert(referenced && held);
            } else {
                joined = await startup.join();
                assert.equal(joined.complete, true);
                assert(
                    joined.children[0].joined &&
                        joined.children[0].exit &&
                        joined.children[0].close,
                );
            }
            await bounded(pendingClose ?? fixture.close(), 'fixture cleanup');
        }
        observed = {
            exit: startup.children.get(child).exit,
            close: startup.children.get(child).close,
            stdoutPaused: child.stdout.isPaused(),
            stdoutEnded: child.stdout.readableEnded,
            stderrEnded: child.stderr.readableEnded,
            writesBeforeStop: beforeWrites,
            writesAfterStop: channel.writes - beforeWrites,
            lateInputCount: fixture.state.inputs.length,
            held: holds.length > 0,
            referenced,
        };
        assert.equal(observed.writesAfterStop, 0);
        assert.equal(observed.lateInputCount, 0);
        assert(observed.exit && observed.close && observed.stdoutEnded && observed.stderrEnded);
        assert.equal(observed.stdoutPaused, false);
        const stop = diagnostics.filter((r) => r.phase === 'bridge-stop-drain');
        assert.equal(stop.length, 1);
    } finally {
        // Cleanup only this controlled case after observation; never touches hosted roots/leases.
        if (child) {
            channel.destroyed = true;
            child.stdin.end();
            child.stdout.resume();
            if (child.exitCode === null) await bounded(once(child, 'exit'), 'cleanup exit');
            await bounded(startup.children.get(child).closed, 'cleanup pipe close');
        }
        if (pendingClose) await pendingClose.catch(() => {});
        if (fixture) await fixture.close().catch(() => {});
        await fsp.rm(parent, { recursive: true, force: true });
        const evidence = process.env.HUB_PTY_LIFECYCLE_EVIDENCE;
        if (evidence) {
            await fsp.mkdir(evidence, { recursive: true });
            const report = {
                kind,
                active,
                unknown,
                badReceipt,
                sourceSHA256: createHash('sha256').update(source).digest('hex'),
                observed,
                roots,
                holds,
                referenced,
                joined,
                diagnostics,
                proofLimits:
                    'Real owned Node root and inherited-pipe writer; production adapter and NativePilotStartup join are real. Inner Windows receipt and identity/descendant ports are controlled, not Windows/OS qualification or discharge of any historical hold.',
            };
            const raw = JSON.stringify(report, null, 2) + '\n';
            assert(Buffer.byteLength(raw) <= 65536);
            await fsp.writeFile(
                path.join(
                    evidence,
                    [
                        kind,
                        active ? 'active' : 'quiet',
                        unknown ? 'unknown' : 'known',
                        badReceipt ? 'invalid' : 'valid',
                    ].join('-') + '.json',
                ),
                raw,
            );
        }
    }
    return observed;
}
for (const route of ['end', 'close', 'abort', 'owner-stop', 'fixture-close'])
    test(
        'actual adapter drains late inherited output after ' + route + ' and joins outer pipes',
        async () => {
            await exercise(route);
        },
    );
test('live SSH backpressure still pauses/resumes before stop; stop disarms later input/output', async () => {
    await exercise('end', { active: true });
});
test('positive inner/outer pipe facts do not override unknown descendant proof', async () => {
    await exercise('end', { unknown: true });
});
test('outer stream drain does not promote an invalid inner receipt into closure', async () => {
    await exercise('end', { badReceipt: true });
});

test('actual closing ssh2 Channel is not treated as writable while destroyed remains false', async () => {
    const { Channel } = createRequire(import.meta.url)('ssh2/lib/Channel.js');
    const protocol = {
        channelData() {},
        channelClose() {},
        channelEOF() {},
        channelWindowAdjust() {},
    };
    const channel = new Channel(
        { _protocol: protocol, _sock: { writable: true } },
        {
            type: 'session',
            incoming: { id: 0, window: 2097152, packetSize: 32768, state: 'open' },
            outgoing: { id: 1, window: 2097152, packetSize: 32768, state: 'open' },
        },
        { server: true },
    );
    channel.on('error', () => {});
    channel.end();
    channel.close();
    channel.emit('close');
    await new Promise(setImmediate);
    assert.equal(channel.destroyed, false);
    assert.equal(channel.writableEnded, true);
    let writes = 0;
    const write = channel.write;
    channel.write = function (...args) {
        writes++;
        return write.apply(this, args);
    };
    const ast = ts.createSourceFile('os-pty.ts', source, ts.ScriptTarget.Latest, true);
    let callback;
    const visit = (n) => {
        if (
            ts.isCallExpression(n) &&
            n.expression.getText(ast) === 'child.stdout.on' &&
            n.arguments[0]?.text === 'data'
        )
            callback = n.arguments[1].getText(ast);
        ts.forEachChild(n, visit);
    };
    visit(ast);
    assert(callback);
    const child = spawn(
        process.execPath,
        [
            '-e',
            "process.on('message',()=>process.stdout.write('LATE_CLOSED_CHANNEL',()=>process.disconnect()));process.send({ready:true});",
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let exited = false;
    child.on('exit', () => (exited = true));
    const closed = once(child, 'close');
    const observations = [];
    const state = { outputBytes: 0, outputTail: '' };
    const code = ts.transpileModule('const handler=' + callback + '; handler;', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const handler = vm.runInNewContext(code, {
        Buffer,
        stopping: false,
        terminal: undefined,
        firstStdout: false,
        timing() {},
        state,
        channel,
        child,
    });
    child.stdout.on('data', (b) => {
        handler(b);
        observations.push({ bytes: b.length, paused: child.stdout.isPaused() });
    });
    child.stderr.resume();
    try {
        await bounded(once(child, 'message'), 'closing-channel child readiness');
        child.send({ go: true });
        const [code, signal] = await bounded(closed, 'closing-channel child close');
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert.equal(writes, 0);
        assert(observations.length > 0);
        assert(observations.every((r) => !r.paused));
        assert.equal(state.outputBytes, 19);
    } finally {
        child.stdout.resume();
        child.stderr.resume();
        if (!exited) child.kill('SIGKILL');
        await bounded(closed, 'closing-channel cleanup').catch(() => {});
    }
});
