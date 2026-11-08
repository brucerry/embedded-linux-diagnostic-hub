import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { validateHostReply, OwnedHost, isolatedGateway } from './memory-resource-gateway-process';

test('derived SSH profile loads only its verified JS bundle, even when the ambient tree has a binary', async () => {
    assert.ok(process.env.HUB_MEMORY_SSH_PROFILE, 'Use npm run test:memory:self.');
    const profile = await sshQualificationProfile();
    assert.equal(profile.kind, 'ssh2-js-bundle');
    assert.equal(profile.bindingAvailable, false);
    assert.equal('runtimeAddonExcluded' in profile && profile.runtimeAddonExcluded, true);
    // No claim about absence of a binary in the original install is made by the bundle profile.
    assert.equal('nativeBinaryAbsent' in profile, false);
});

test('tampered derived bundle is rejected before module execution without changing the source profile', async () => {
    const manifestPath = process.env.HUB_MEMORY_SSH_PROFILE!;
    const directory = await fs.mkdtemp(path.resolve('validation/memory-runtime/tamper-control-'));
    for (const file of ['preload.cjs', 'manifest.json'])
        await fs.copyFile(path.join(path.dirname(manifestPath), file), path.join(directory, file));
    await fs.writeFile(path.join(directory, 'ssh2.cjs'), 'throw Error("must never execute");');
    const child = spawnSync(
        process.execPath,
        ['--require', path.join(directory, 'preload.cjs'), '-e', 'require("ssh2")'],
        {
            env: { ...process.env, HUB_MEMORY_SSH_PROFILE: path.join(directory, 'manifest.json') },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
        },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Qualification artifact changed: ssh2.cjs/);
    assert.doesNotMatch(child.stderr, /Error: must never execute/);
    await sshQualificationProfile();
});

test('gateway allocation replies bind PID, role, nonce, request and success', () => {
    const expected = { nonce: 'fixture', pid: 42, role: 'gateway-node', id: 3 };
    const valid = { version: 1, ...expected, ok: true, value: { memory: 'fixture' } };
    assert.deepEqual(validateHostReply(valid, expected), valid.value);
    for (const key of ['pid', 'role', 'nonce', 'id'] as const)
        assert.throws(
            () => validateHostReply({ ...valid, [key]: 'wrong' }, expected),
            /Unbound host reply/,
        );
    assert.throws(
        () => validateHostReply({ ...valid, ok: false, error: 'injected host failure' }, expected),
        /injected host failure/,
    );
});

test('default fast command emits blocked policy receipt without starting a resource child', async () => {
    const directory = await fs.mkdtemp(path.resolve('validation/memory-runtime/policy-control-'));
    const child = spawnSync(
        process.execPath,
        ['scripts/memory-runtime.mjs', '--entry=fast', '--out=' + directory],
        {
            env: process.env,
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15000,
        },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    const entries = await fs.readdir(directory);
    assert.equal(entries.length, 1);
    const receipt = JSON.parse(
        await fs.readFile(path.join(directory, entries[0], 'receipt.json'), 'utf8'),
    );
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.childStarted, false);
    assert.match(receipt.firstFailure, /Reviewed policy required/);
});

test('real referenced and unreferenced timer omissions are rejected, including a resetCache lookalike', async () => {
    const { GatewayTimers } = await import('./memory-resource-gateway-timers');
    for (const unref of [false, true]) {
        const timers = new GatewayTimers();
        function resetCache() {}
        const timer = setTimeout(resetCache, 60000);
        if (unref) timer.unref();
        try {
            await assert.rejects(timers.joinHttpDateCache(), /Unexpected live Timeout/);
        } finally {
            clearTimeout(timer);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(timers.size, 0);
            timers.disable();
        }
    }
});

test('error plus close without exit records failed start, including an actual missing executable', async () => {
    const failure = Object.assign(Error('spawn EPERM'), { code: 'EPERM' });
    const child = new EventEmitter() as ChildProcess;
    let kills = 0;
    child.send = ((_message: unknown, callback: (error: Error) => void) => {
        queueMicrotask(() => {
            child.emit('error', failure);
            callback(failure);
            child.emit('close', -1, null);
        });
        return true;
    }) as ChildProcess['send'];
    child.kill = () => {
        kills++;
        return false;
    };
    const host = new OwnedHost('gateway-node', 'normal', {
        forkChild: (() => child) as typeof fork,
    });
    await assert.rejects(host.initialize('http://127.0.0.1:5173'), (error) => error === failure);
    assert.deepEqual(await host.abort(), { kind: 'failed-start', error: String(failure) });
    assert.equal(kills, 0);
    const missingDirectory = await fs.mkdtemp(
        path.resolve('validation/memory-runtime/failed-start-control-'),
    );
    const missingExecutable = path.join(missingDirectory, 'node.exe');
    const actual = new OwnedHost('gateway-node', 'normal', {
        forkChild: ((module, args, options) =>
            fork(module, args, {
                ...options,
                execPath: missingExecutable,
            })) as typeof fork,
    });
    const events: string[] = [];
    actual.child.on('error', () => events.push('error'));
    actual.child.on('exit', () => events.push('exit'));
    actual.child.on('close', () => events.push('close'));
    await assert.rejects(actual.initialize('http://127.0.0.1:5173'), { code: 'ENOENT' });
    const termination = await actual.abort();
    assert.equal(termination.kind, 'failed-start');
    assert.deepEqual(events, ['error', 'close']);
    assert.equal(actual.child.pid, undefined);
    await fs.writeFile(
        path.join(missingDirectory, 'failed-start.json'),
        JSON.stringify(
            {
                status: 'passed-real-failed-start-control',
                expectedFailure: 'ENOENT',
                events,
                pid: actual.child.pid ?? null,
                termination,
                scope: 'Actual fork error/close without exit; no executable or child process was created.',
            },
            null,
            2,
        ),
        { flag: 'wx' },
    );
});

test('send and kill failures have bounded cleanup and never fabricate verified exit', async () => {
    for (const killThrows of [false, true]) {
        const failure = Error('fixture send failed');
        const child = Object.assign(new EventEmitter(), { pid: 42 }) as ChildProcess;
        child.send = (() => {
            throw failure;
        }) as ChildProcess['send'];
        child.kill = () => {
            if (killThrows) throw Error('fixture kill denied');
            return false;
        };
        const host = new OwnedHost('gateway-node', 'normal', {
            forkChild: (() => child) as typeof fork,
            terminationMs: 20,
        });
        await assert.rejects(
            host.initialize('http://127.0.0.1:5173'),
            (error) => error === failure,
        );
        await assert.rejects(
            host.abort(),
            (error) =>
                /termination deadline exceeded.*liveness is unverified/.test(String(error)) &&
                (killThrows
                    ? /kill denied/.test(String(error))
                    : /kill returned false/.test(String(error))),
        );
    }
});

test('second-host start failure joins the first child and preserves unresolved cleanup as failure', async () => {
    for (const killWorks of [true, false]) {
        const failure = Object.assign(Error('second spawn EAGAIN'), { code: 'EAGAIN' });
        const live = new Set([42]);
        let forks = 0,
            exitChecks = 0;
        const fakeFork = (() => {
            const first = forks++ === 0;
            const child = Object.assign(new EventEmitter(), {
                pid: first ? 42 : undefined,
            }) as ChildProcess;
            child.send = ((
                message: { nonce: string; id: number },
                callback: (error?: Error) => void,
            ) => {
                queueMicrotask(() => {
                    if (first)
                        child.emit('message', {
                            version: 1,
                            nonce: message.nonce,
                            id: message.id,
                            pid: 42,
                            role: 'ssh-fixture-node',
                            ok: true,
                            value: { runtime: {}, descriptor: {} },
                        });
                    else callback(failure);
                });
                return true;
            }) as ChildProcess['send'];
            child.kill = () => {
                if (!killWorks) return false;
                queueMicrotask(() => {
                    live.delete(42);
                    child.emit('exit', null, 'SIGTERM');
                    child.emit('close', null, 'SIGTERM');
                });
                return true;
            };
            if (!first)
                queueMicrotask(() => {
                    child.emit('error', failure);
                    child.emit('close', -1, null);
                });
            return child;
        }) as typeof fork;
        const aborts: unknown[] = [];
        const run = isolatedGateway(
            'http://127.0.0.1:5173',
            'normal',
            async (stage, data) => {
                if (stage === 'gateway-host-abort') aborts.push(data);
            },
            {
                forkChild: fakeFork,
                terminationMs: 20,
                makeSampler: (roots) => ({
                    sample: async () =>
                        roots.map((pid) => ({
                            pid,
                            created: 'mock-instance',
                            role: 'fixture-root',
                            state: 'running' as const,
                            rssBytes: null,
                            heapUsedBytes: null,
                            externalBytes: null,
                            arrayBuffersBytes: null,
                            unsupported: ['mock OS table'],
                        })),
                    assertExited: async () => {
                        exitChecks++;
                        assert.equal(live.size, 0, 'mock descendant remains alive');
                    },
                }),
            },
        );
        if (killWorks) await assert.rejects(run, (error) => error === failure);
        else
            await assert.rejects(
                run,
                (error) =>
                    error instanceof AggregateError &&
                    error.cause === failure &&
                    /cleanup is unverified/.test(error.message),
            );
        assert.equal(aborts.length, 2);
        assert.equal(exitChecks, 1);
    }
});

test('host release requires actual normal zero exit and rejects missing-exit closure', async () => {
    for (const kind of ['zero', 'nonzero', 'signal', 'close-without-exit']) {
        const child = Object.assign(new EventEmitter(), { pid: 42 }) as ChildProcess;
        child.kill = () => false;
        child.send = ((message: { nonce: string; id: number; action: string }) => {
            queueMicrotask(() => {
                child.emit('message', {
                    version: 1,
                    nonce: message.nonce,
                    id: message.id,
                    pid: 42,
                    role: 'gateway-node',
                    ok: true,
                    value: {
                        resources: { ipcMessageListeners: 0, ipcDisconnectListeners: 0, timers: 0 },
                    },
                });
                if (message.action === 'release')
                    setImmediate(() => {
                        if (kind !== 'close-without-exit')
                            child.emit(
                                'exit',
                                kind === 'nonzero' ? 1 : kind === 'signal' ? null : 0,
                                kind === 'signal' ? 'SIGABRT' : null,
                            );
                        child.emit('close', 0, null);
                    });
            });
            return true;
        }) as ChildProcess['send'];
        const host = new OwnedHost('gateway-node', 'normal', {
            forkChild: (() => child) as typeof fork,
            terminationMs: 20,
        });
        if (kind === 'zero')
            assert.deepEqual((await host.close()).termination, {
                kind: 'exited',
                code: 0,
                signal: null,
            });
        else await assert.rejects(host.close(), /Owned host exit must be normal zero/);
    }
});

import './memory-resource-startup-history.test';

import './memory-resource-invocation.test';
