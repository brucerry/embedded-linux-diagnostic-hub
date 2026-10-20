// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { terminalRuntimeDiagnostics } from '../scripts/lib/pilot-terminal-diagnostics.mjs';
import {
    ptyTerminalObservation,
    ptyCompileObservation,
} from './fixtures/pty-terminal-observation.mjs';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
const turn = () => new Promise(setImmediate),
    now = () => Number(process.hrtime.bigint() / 1000000n);
function ownership() {
    let held,
        referenced = false;
    const reasons = [];
    return {
        hold(e) {
            reasons.push(String(e));
            held ??= createOwnershipHold(
                { kind: 'controlled-terminal-hold', reason: String(e) },
                () => {},
                {
                    interval: () => ({
                        ref() {
                            referenced = true;
                        },
                    }),
                },
            );
        },
        get held() {
            return Boolean(held);
        },
        get referenced() {
            return referenced;
        },
        reasons,
    };
}
test('terminal rows are reserved within1024 and remain usable after sticky normal admission closes', async () => {
    const owner = ownership(),
        sent = [];
    const d = terminalRuntimeDiagnostics(
        async (s, v) => {
            sent.push({ s, v });
        },
        (e) => owner.hold(e),
    );
    const terminal = d.reserveTerminal({ rows: 2, bytes: 1024, pendingBytes: 512 });
    for (let i = 0; i < 1022; i++) await d.emit('ordinary', { i });
    assert.throws(() => d.emit('overflow', {}), /rows/);
    owner.hold(Error('original unknown closure'));
    terminal.enterHold();
    d.note('post-hold-normal', {});
    await assert.rejects(() => d.emit('post-hold-work', {}), /admission closed/);
    await terminal.emit('pty-terminal', { unknown: true });
    await terminal.emit('pty-terminal', { unknown: true });
    assert.throws(() => terminal.emit('pty-terminal', {}), /rows|reservation/);
    await d.drain();
    assert.equal(sent.length, 1024);
    assert.throws(() => terminal.emit('runtime-ready', {}), /allowlist/);
    assert.throws(() => terminal.emit('stage-final', {}), /allowlist/);
    assert(!sent.some((r) => r.s === 'post-hold-normal'));
    assert(owner.held && owner.referenced);
    assert.equal(owner.reasons[0], 'Error: original unknown closure');
});
test('pending terminal capacity and single durable credit stay inside262144bytes', async () => {
    let firstRelease,
        inflight = 0,
        maxInflight = 0;
    const sent = [],
        gate = new Promise((r) => (firstRelease = r));
    const d = terminalRuntimeDiagnostics(
        async (s, v) => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            sent.push(s);
            if (sent.length === 1) await gate;
            inflight--;
        },
        () => {},
    );
    const terminal = d.reserveTerminal({ rows: 2, bytes: 8192, pendingBytes: 4096 });
    const ordinary = [];
    for (let i = 0; i < 4; i++) ordinary.push(d.emit('ordinary', { text: 'x'.repeat(63000) }));
    assert.throws(() => d.emit('ordinary', { text: 'x'.repeat(7000) }), /pendingBytes/);
    const final = terminal.emit('pty-terminal', { text: 't'.repeat(1000) });
    await turn();
    assert.equal(sent.length, 1);
    firstRelease();
    await Promise.all([...ordinary, final]);
    await d.drain();
    assert.equal(maxInflight, 1);
    assert.equal(sent.at(-1), 'pty-terminal');
});
test('terminal reservations cannot be added after ordinary admission or used to clear transport failure', async () => {
    const d = terminalRuntimeDiagnostics(
        async () => {},
        () => {},
    );
    await d.emit('one', {});
    assert.throws(
        () => d.reserveTerminal({ rows: 1, bytes: 100, pendingBytes: 100 }),
        /before diagnostic admission/,
    );
    const error = Error('durable transport failed'),
        owner = ownership();
    const failed = terminalRuntimeDiagnostics(
        async () => {
            throw error;
        },
        (e) => owner.hold(e),
    );
    const terminal = failed.reserveTerminal({ rows: 2, bytes: 1024, pendingBytes: 1024 });
    await assert.rejects(() => failed.emit('one', {}), /transport failed/);
    await turn();
    terminal.enterHold();
    await assert.rejects(
        () => terminal.emit('pty-terminal', {}),
        (e) => e === error,
    );
    assert(owner.held && owner.referenced);
});
test('terminal frames preserve stream/channel census, counters and fixed snapshots without closure authority', async () => {
    const child = {
        pid: 321,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    };
    const channel = new PassThrough();
    channel.outgoing = { state: 'closing' };
    let stopped = false,
        tick = 0;
    const frames = [],
        owner = ownership();
    const observer = ptyTerminalObservation({
        child,
        channel,
        identity: () => ({ created: 'owned-creation' }),
        stopping: () => stopped,
        emit: (d) => frames.push(d),
        hold: (e) => owner.hold(e),
        clock: () => ++tick,
    });
    child.stdout.pause();
    observer.event('stdout-data', { bytes: 8, disposition: 'channel-write' });
    observer.event('write-false');
    observer.event('channel-end');
    stopped = true;
    owner.hold(Error('keep original hold'));
    observer.snapshot('stop');
    for (let i = 0; i < 70; i++)
        observer.event('stdout-data', { bytes: 4, disposition: 'discarded' });
    child.stdout.resume();
    observer.event('channel-drain');
    observer.event('process-exit');
    observer.snapshot('exit');
    child.stdin.end();
    child.stdout.end();
    child.stderr.end();
    child.stdin.resume();
    child.stderr.resume();
    await turn();
    observer.event('input-discard', { bytes: 3 });
    observer.event('outer-close');
    observer.snapshot('close');
    observer.snapshot('final', { outcome: 'unknown', closureProven: true });
    observer.snapshot('final');
    await turn();
    assert.equal(frames.length, 4);
    for (const f of frames) {
        assert.equal(f.closureProven, false);
        assert.equal(f.created, 'owned-creation');
        assert(Buffer.byteLength(JSON.stringify(f)) <= 8192);
        assert(f.trace.length <= 16);
    }
    const f = frames.at(-1);
    assert.equal(f.bytes.observedStdout, 288);
    assert.equal(f.bytes.discardedStdout, 280);
    assert.equal(f.bytes.handedToChannel, 8);
    assert.equal(f.traceComplete, false);
    assert(f.traceOverflow > 0);
    assert.equal(f.counters['write-false'], 1);
    assert.equal(f.bytes.discardedInput, 3);
    assert.equal(f.lastData['stdout-data'].bytes, 4);
    assert(f.lastTransitions['stdout-resume']);
    assert(f.lastEvents['stderr-close']);
    assert.equal(f.counters['stdin-finish'], 1);
    assert.equal(f.counters['stdout-end'], 1);
    assert.equal(f.counters['stderr-close'], 1);
    assert(owner.held && owner.referenced);
});
test('unavailable child identity remains null; terminal persistence failure preserves referenced ownership', async () => {
    const child = {
            pid: 321,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        },
        owner = ownership();
    let captured;
    const observer = ptyTerminalObservation({
        child,
        channel: new PassThrough(),
        stopping: () => true,
        emit: (d) => {
            captured = d;
            throw Error('terminal persistence refused');
        },
        hold: (e) => owner.hold(e),
    });
    observer.snapshot('final');
    assert.equal(captured.created, null);
    assert.equal(captured.identityAvailable, false);
    assert(owner.held && owner.referenced);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
});
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
const wire = (d) => 'HUB_OS_PTY_COMPILE ' + JSON.stringify(d) + '\n';
test('call stamps, logging spans and self CPU parse independently without cross-clock arithmetic', () => {
    const d = fact();
    assert.deepEqual(ptyCompileObservation(wire(d), 321), d);
    assert.equal(ptyCompileObservation(wire(d).slice(0, -1), 321), undefined);
});
test('unavailable CPU and runtime identity remain unavailable, never fabricated zero', () => {
    const d = fact();
    d.cpuBefore = { available: false, reason: 'unavailable' };
    d.cpuAfter = { available: false, reason: 'unavailable' };
    d.loadedAssemblies = null;
    d.runtimeReason = 'unavailable';
    d.createdFileTime = null;
    assert.deepEqual(ptyCompileObservation(wire(d), 321).cpuBefore, {
        available: false,
        reason: 'unavailable',
    });
    d.cpuBefore.totalTicks = '0';
    assert.throws(() => ptyCompileObservation(wire(d), 321), /invent zero/);
});
test('loaded runtime metadata retains MVID without claiming physical assembly hashes', () => {
    const d = fact();
    d.loadedAssemblies[0] = {
        name: 'System.Management.Automation',
        available: true,
        fullName: 'System.Management.Automation, Version=7.5.0.0',
        moduleVersionId: '9536ac3c-b0ea-44dc-a4b6-9b1feec7975e',
        physicalIdentity: {
            available: false,
            reason: 'No physical assembly read authorized on readiness path.',
        },
    };
    assert.deepEqual(
        ptyCompileObservation(wire(d), 321).loadedAssemblies[0],
        d.loadedAssemblies[0],
    );
    d.loadedAssemblies[0].sha256 = 'a'.repeat(64);
    assert.throws(() => ptyCompileObservation(wire(d), 321), /physical assembly/);
});
test('duplicate, foreign, oversized and backwards compile facts are refused', () => {
    for (const change of [
        (d) => (d.pid = 999),
        (d) => (d.callEnd = '99'),
        (d) => (d.cpuAfter.totalTicks = '9'),
        (d) => (d.powershellFile.sha256 = 'bad'),
    ]) {
        const d = fact();
        change(d);
        assert.throws(() => ptyCompileObservation(wire(d), 321));
    }
    assert.throws(() => ptyCompileObservation(wire(fact()) + wire(fact()), 321), /One compile/);
    const d = fact();
    d.padding = 'x'.repeat(9000);
    assert.throws(() => ptyCompileObservation(wire(d), 321), /frame bound/);
});
test('failed Add-Type observation retains its error and absent success logging', () => {
    const d = fact();
    d.callSucceeded = false;
    d.callError = 'controlled compile error';
    d.afterLoggingStart = null;
    d.afterLoggingEnd = null;
    assert.equal(ptyCompileObservation(wire(d), 321).callError, 'controlled compile error');
});
function fakeChild(pid = 1234) {
    const c = new EventEmitter();
    Object.assign(c, {
        pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null,
    });
    return c;
}
function finish(c) {
    c.exitCode = 0;
    c.emit('exit', 0, null);
    c.stdout.end();
    c.stderr.end();
    c.stdout.resume();
    c.stderr.resume();
    c.emit('close', 0, null);
}
test('held final reporting drains an already-admitted OS census without starting another query', async () => {
    let release,
        reads = 0;
    const owner = ownership(),
        records = [],
        child = fakeChild();
    const controller = new AbortController();
    const scope = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 5000,
        cleanupDeadline: now() + 5000,
        timeoutMs: 1000,
        readTable: () => {
            reads++;
            return new Promise((r) => (release = r));
        },
        emit: async () => {},
        terminalEmit: async (s, d) => records.push({ s, d }),
        hold: (e) => owner.hold(e),
    });
    scope.adopt('owned-root', child, () => {});
    await turn();
    assert.equal(reads, 1);
    owner.hold(Error('original outer EOF unknown'));
    scope.stopQueryAdmission();
    const pending = scope.terminalObservation('held');
    assert.equal(records.length, 0);
    release([
        {
            pid: 1234,
            parent: 1,
            created: '2026-10-20T03:49:21.0000000Z',
            rssBytes: 1,
            creationClock: 'windows-utc-100ns' as const,
        },
        {
            pid: 1235,
            parent: 1234,
            created: '2026-10-20T03:49:21.0000001Z',
            rssBytes: 1,
            creationClock: 'windows-utc-100ns' as const,
        },
    ]);
    await pending;
    assert.equal(reads, 1);
    const d = records[0].d;
    assert.equal(d.admittedObservationsSettled, true);
    assert.equal(d.newQueryAdmitted, false);
    assert.equal(d.releaseAuthorized, false);
    assert.deepEqual(d.children[0].census.tuples, [
        [1234, '2026-10-20T03:49:21.0000000Z', 'fixture-root', 'running'],
        [1235, '2026-10-20T03:49:21.0000001Z', 'owned-descendant', 'running'],
    ]);
    assert.equal(d.children[0].close, false);
    assert(owner.held && owner.referenced);
    await assert.rejects(() => scope.join(), /Held/);
    finish(child);
});
test('normal final report reuses the existing final descendant read and preserves full join gates', async () => {
    let reads = 0;
    const records = [],
        child = fakeChild();
    const scope = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: now() + 5000,
        cleanupDeadline: now() + 5000,
        readTable: async () =>
            ++reads === 1
                ? [
                      {
                          pid: 1234,
                          parent: 1,
                          created: '2026-10-20T03:49:21.0000000Z',
                          rssBytes: 1,
                          creationClock: 'windows-utc-100ns' as const,
                      },
                  ]
                : [],
        emit: async () => {},
        terminalEmit: async (s, d) => records.push({ s, d }),
        hold: (e) => {
            throw e;
        },
    });
    scope.adopt('owned-root', child, () => {});
    await scope.children.get(child).identityTask;
    finish(child);
    const joined = await scope.join();
    assert.equal(joined.complete, true);
    assert.equal(reads, 2);
    assert.equal(records[0].d.children[0].census.tuples[0][3], 'terminated');
    assert.equal(records[0].d.newQueryAdmitted, false);
    assert.equal(records[0].d.releaseAuthorized, false);
});
test('terminal observation deadline reports incomplete pending ownership without restarting a read', async () => {
    let release,
        reads = 0;
    const owner = ownership(),
        records = [],
        child = fakeChild();
    const scope = new NativePilotStartup({
        signal: new AbortController().signal,
        deadline: now() + 1000,
        cleanupDeadline: now() + 1000,
        timeoutMs: 20,
        readTable: () => {
            reads++;
            return new Promise((r) => (release = r));
        },
        emit: async () => {},
        terminalEmit: async (s, d) => records.push(d),
        hold: (e) => owner.hold(e),
    });
    scope.adopt('owned-root', child, () => {});
    await turn();
    owner.hold(Error('unknown'));
    scope.stopQueryAdmission();
    await scope.terminalObservation('pending');
    assert.equal(records[0].admittedObservationsSettled, false);
    assert.equal(records[0].outcomes, null);
    assert.equal(reads, 1);
    assert(owner.held && owner.referenced);
    release([
        {
            pid: 1234,
            parent: 1,
            created: '2026-10-20T03:49:21.0000000Z',
            rssBytes: 1,
            creationClock: 'windows-utc-100ns' as const,
        },
    ]);
    await scope.children.get(child).identityTask;
    finish(child);
});
test('helper source keeps bounded preparation/runtime Add-Type branches and no diagnostic writes between captured call stamps', () => {
    const ps = fs.readFileSync(
        path.join(import.meta.dirname, 'fixtures/winpty-bridge.ps1'),
        'utf8',
    );
    assert.equal((ps.match(/Add-Type -Path/g) || []).length, 2);
    const a = ps.indexOf('$callStart=[Diagnostics.Stopwatch]::GetTimestamp()'),
        b = ps.indexOf('finally { $callEnd=[Diagnostics.Stopwatch]::GetTimestamp() }');
    assert(a > 0 && b > a);
    const span = ps.slice(a, b);
    assert(span.includes('Add-Type -Path'));
    assert(!/WriteLine|Write-PtyTiming|ConvertTo-Json/.test(span));
    assert(ps.indexOf('$cpuBefore=Read-PtySelfCpu') < a);
    assert(ps.indexOf('$cpuAfter=Read-PtySelfCpu') > b);
    assert(ps.indexOf("'HUB_OS_PTY_COMPILE '") > b);
    assert(ps.includes('[int]$DeadlineMs=15000'));
    assert(ps.includes('GetAssemblies()'));
    assert(!/Start-Process|Set-ExecutionPolicy|Set-MpPreference/.test(ps));
});
