import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startupBound } from './pilot-runtime-startup.mjs';
import { windowsCreationOrder } from '../../tests/fixtures/memory-resource-processes.ts';
import { ptyCompileObservation } from '../../tests/fixtures/pty-terminal-observation.mjs';
const now = () => Number(process.hrtime.bigint() / 1000000n);
const ownedAsyncDescriptors = new Set();
const ownedSyncDescriptors = new Set();
export const preparedDescriptorOwnership = () => ({
    async: ownedAsyncDescriptors.size,
    sync: ownedSyncDescriptors.size,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function preparedPtyIdentity(file, { durable = false, fsPort = fs } = {}) {
    const fs = fsPort;
    assert.equal(await fs.realpath(file), file, 'Prepared bridge canonical path changed');
    const before = await fs.lstat(file, { bigint: true });
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
    assert(before.size > 0n && before.size <= 1048576n, 'Prepared bridge byte bound');
    const fd = await fs.open(file, durable ? 'r+' : 'r');
    const ownership = Object.freeze({ fd, path: file });
    ownedAsyncDescriptors.add(ownership);
    let primary;
    try {
        const opened = await fd.stat({ bigint: true });
        assert.equal(opened.dev, before.dev);
        assert.equal(opened.ino, before.ino);
        if (durable) await fd.sync();
        const bytes = await fd.readFile();
        assert.equal(BigInt(bytes.length), before.size);
        const after = await fd.stat({ bigint: true });
        const current = await fs.lstat(file, { bigint: true });
        for (const s of [after, current])
            for (const k of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'])
                assert.equal(s[k], before[k], 'Prepared bridge changed during read');
        return Object.freeze({
            path: file,
            sha256: hash(bytes),
            bytes: bytes.length,
            dev: String(before.dev),
            ino: String(before.ino),
            mtimeNs: String(before.mtimeNs),
            ctimeNs: String(before.ctimeNs),
        });
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        try {
            await fd.close();
            ownedAsyncDescriptors.delete(ownership);
        } catch (closure) {
            throw primary
                ? new AggregateError(
                      [primary, closure],
                      'Prepared artifact I/O and descriptor closure failed',
                  )
                : closure;
        }
    }
}
export async function verifyPreparedPtyBridge(prepared) {
    assert.deepEqual(await preparedPtyIdentity(prepared.artifact.path), prepared.artifact);
    for (const row of prepared.inputs)
        assert.deepEqual(await preparedPtyIdentity(row.path), row, 'Prepared bridge input changed');
    return prepared;
}
/** One compiler tool, no PTY/Bash startup. The caller's original work/cleanup clocks are immutable.
 * No artifact is admitted until real exit, pipe-close, identity/descendant join and evidence complete. */
export async function preparePtyBridge(
    options,
    { spawnPort = spawn, clock = now, fsPort = fs } = {},
) {
    const { startup, signal, deadline, cleanupDeadline, cancel, hold, emit } = options;
    assert(
        Number.isSafeInteger(deadline) &&
            Number.isSafeInteger(cleanupDeadline) &&
            deadline <= cleanupDeadline,
    );
    const cleanup = Math.min(cleanupDeadline, deadline + 10000);
    const compilerArguments = Object.freeze([...options.args]);
    let child,
        stdout = '',
        stderr = '',
        exit,
        overflow = false;
    const check = () => {
        signal.throwIfAborted();
        assert(clock() < deadline, 'PTY preparation absolute deadline');
        options.check();
    };
    assert(
        /^[a-f0-9]{64}$/.test(options.context.sourceSHA256) &&
            /^[a-f0-9]{64}$/.test(options.context.bindingSHA256),
    );
    assert(/^[a-f0-9-]{36}$/.test(options.context.nonce));
    assert(
        options.artifactPath.startsWith(options.context.root + path.sep),
        'Prepared output outside owned root',
    );
    const directory = path.dirname(options.artifactPath);
    const directoryIdentity = await fs.lstat(directory, { bigint: true });
    assert.equal(await fs.realpath(directory), directory);
    const beforeNames = await fs.readdir(directory);
    assert(beforeNames.length <= 4, 'Fresh compiler directory envelope');
    const tempIdentity = options.compileTemp
        ? await fs.lstat(options.compileTemp, { bigint: true })
        : undefined;
    if (tempIdentity) {
        assert(tempIdentity.isDirectory() && !tempIdentity.isSymbolicLink());
        assert.equal(await fs.realpath(options.compileTemp), options.compileTemp);
        assert.deepEqual(await fs.readdir(options.compileTemp), []);
    }
    assert(
        !beforeNames.includes(path.basename(options.artifactPath)),
        'Fresh prepared output required',
    );
    const inputs = [];
    for (const file of options.inputs) inputs.push(await preparedPtyIdentity(file));
    try {
        check();
        await emit('pty-compile-before', {
            deadline,
            cleanupDeadline,
            inputs,
            compilerArguments,
            artifactPath: options.artifactPath,
        });
        check();
        child = startup.spawn(
            'winpty-bridge-compile',
            () =>
                spawnPort(options.executable, [...compilerArguments], {
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...options.env, HUB_TEST_WINPTY_COMPILE_INPUTS: JSON.stringify(inputs) },
                }),
            (p) => p.stdin.end(),
        );
        child.stdin.on('error', () => {});
        child.once('exit', (code, signal) => {
            exit = { code, signal };
        });
        for (const stream of ['stdout', 'stderr'])
            child[stream].on('data', (bytes) => {
                if (overflow) return;
                if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.length > 65536) {
                    overflow = true;
                    cancel(Error('PTY compilation output bound'));
                    return;
                }
                if (stream === 'stdout') stdout += bytes.toString();
                else stderr += bytes.toString();
            });
        child.stdin.end();
        const row = startup.children.get(child);
        await startupBound(row.closed, {
            signal,
            deadline,
            label: 'PTY compiler exit/pipe close',
            clock,
        });
        await startupBound(startup.joinChild(child), {
            signal,
            deadline,
            label: 'PTY compiler identity/descendant join',
            clock,
        });
        check();
        assert(!overflow, 'PTY compilation output bound');
        assert.deepEqual(exit, { code: 0, signal: null }, 'PTY compiler failed');
        assert.equal(row.code, 0);
        assert.equal(row.closeCode, 0);
        assert.equal(stdout, '', 'Compiler may not emit shell bytes');
        const observation = ptyCompileObservation(stderr, child.pid);
        assert(observation?.callSucceeded, 'Complete successful compile observation required');
        verifyPtyProcessBirth(child.pid, observation.createdFileTime, row.identity);
        assert.deepEqual(
            observation.powershellFile,
            options.expectedCompiler,
            'Bound compiler identity required',
        );
        const currentDirectory = await fs.lstat(directory, { bigint: true });
        assert.equal(currentDirectory.dev, directoryIdentity.dev);
        assert.equal(currentDirectory.ino, directoryIdentity.ino);
        assert.deepEqual(
            (await fs.readdir(directory)).sort(),
            [...beforeNames, path.basename(options.artifactPath)].sort(),
            'Unexpected compiler output',
        );
        if (tempIdentity) {
            const current = await fs.lstat(options.compileTemp, { bigint: true });
            assert.equal(current.dev, tempIdentity.dev);
            assert.equal(current.ino, tempIdentity.ino);
            assert.equal(await fs.realpath(options.compileTemp), options.compileTemp);
        }
        if (options.compileTemp)
            assert.deepEqual(
                await fs.readdir(options.compileTemp),
                [],
                'Compiler temporary files remain',
            );
        const artifact = await preparedPtyIdentity(options.artifactPath, { durable: true, fsPort });
        const artifactLines = stderr
            .split(/\r?\n/)
            .filter((l) => l.startsWith('HUB_OS_PTY_ARTIFACT '));
        assert.equal(artifactLines.length, 1, 'One compiled artifact receipt required');
        const artifactRaw = artifactLines[0].slice('HUB_OS_PTY_ARTIFACT '.length);
        assert(Buffer.byteLength(artifactRaw) <= 8192);
        const managed = JSON.parse(artifactRaw);
        assert.deepEqual(Object.keys(managed).sort(), [
            'bytes',
            'fullName',
            'kind',
            'path',
            'pid',
            'schema',
            'sha256',
        ]);
        assert.equal(managed.schema, 1);
        assert.equal(managed.kind, 'pty-compiled-artifact');
        assert.equal(managed.pid, child.pid);
        assert.equal(managed.path, artifact.path);
        assert.equal(managed.sha256, artifact.sha256);
        assert.equal(managed.bytes, artifact.bytes);
        assert(
            typeof managed.fullName === 'string' &&
                managed.fullName.length > 0 &&
                managed.fullName.length <= 1024,
        );
        const prepared = Object.freeze({
            artifact,
            inputs: Object.freeze(inputs.map(Object.freeze)),
            managed: Object.freeze(managed),
            compilerPID: child.pid,
            compilerCreatedFileTime: observation.createdFileTime,
            runtime: Object.freeze({
                powershellVersion: observation.powershellVersion,
                edition: observation.edition,
                dotnetVersion: observation.dotnetVersion,
                powershellFile: Object.freeze({ ...observation.powershellFile }),
            }),
            context: Object.freeze({ ...options.context }),
            compilerArguments,
        });
        await verifyPreparedPtyBridge(prepared);
        check();
        await emit('pty-compile-closed', {
            deadline,
            artifact,
            inputs,
            compilerPID: child.pid,
            observation,
            prepared,
            artifactDurableAndDescriptorClosed: true,
            descendantsClosed: true,
            pipesClosed: true,
        });
        check();
        return prepared;
    } catch (error) {
        cancel(error);
        startup.cancel();
        if (child) {
            const row = startup.children.get(child);
            try {
                try {
                    await startupBound(row.closed, {
                        deadline: Math.min(cleanup, clock() + 1000),
                        label: 'PTY compiler cooperative closure',
                        clock,
                    });
                } catch {
                    startup.terminateChild(child, error);
                }
                await startupBound(row.closed, {
                    deadline: cleanup,
                    label: 'PTY compiler terminated pipe close',
                    clock,
                });
                await startupBound(startup.joinChild(child), {
                    deadline: cleanup,
                    label: 'PTY compiler terminal ownership join',
                    clock,
                });
            } catch (closure) {
                hold(closure);
            }
        }
        // Closure was attempted before sticky hold closes further query admission.
        hold(error);
        throw error;
    }
}
/** Exact fresh consumer load evidence; absence/duplicate/foreign identity cannot satisfy close. */
export function ptyLoadObservation(stderr, pid, prepared) {
    const lines = stderr
        .split(/\r?\n/)
        .slice(0, -1)
        .filter((l) => l.startsWith('HUB_OS_PTY_LOAD '));
    if (!lines.length) return undefined;
    assert.equal(lines.length, 1, 'One prepared bridge load receipt required');
    const raw = lines[0].slice('HUB_OS_PTY_LOAD '.length);
    assert(Buffer.byteLength(raw) <= 8192);
    const d = JSON.parse(raw);
    assert.deepEqual(Object.keys(d).sort(), [
        'artifact',
        'compilerCreatedFileTime',
        'compilerPID',
        'context',
        'createdFileTime',
        'kind',
        'loadedType',
        'moduleVersionId',
        'pid',
        'runtime',
        'schema',
    ]);
    assert.equal(d.schema, 1);
    assert.equal(d.kind, 'pty-artifact-load');
    assert.equal(d.pid, pid);
    assert(/^[1-9]\d{0,19}$/.test(d.createdFileTime));
    assert(
        d.pid !== prepared.compilerPID || d.createdFileTime !== prepared.compilerCreatedFileTime,
        'Fresh runtime process required',
    );
    assert.equal(d.compilerPID, prepared.compilerPID);
    assert.equal(d.compilerCreatedFileTime, prepared.compilerCreatedFileTime);
    assert.deepEqual(d.artifact, prepared.artifact);
    assert.deepEqual(d.context, prepared.context);
    assert.deepEqual(d.runtime, prepared.runtime);
    assert.equal(d.loadedType, 'HubWinptyFixture');
    assert(/^[a-f0-9-]{36}$/i.test(d.moduleVersionId));
    return d;
}
/** Final synchronous guard runs on the original shell-open/readiness path before spawn. */
export function verifyPreparedPtyBridgeSync(prepared, fsPort = syncFs) {
    const syncFs = fsPort;
    for (const expected of [prepared.artifact, ...prepared.inputs]) {
        assert.equal(syncFs.realpathSync(expected.path), expected.path);
        const before = syncFs.lstatSync(expected.path, { bigint: true });
        assert(
            before.isFile() &&
                !before.isSymbolicLink() &&
                before.nlink === 1n &&
                before.size > 0n &&
                before.size <= 1048576n,
        );
        const fd = syncFs.openSync(expected.path, 'r');
        const ownership = Object.freeze({ fd, path: expected.path });
        ownedSyncDescriptors.add(ownership);
        let primary;
        try {
            const opened = syncFs.fstatSync(fd, { bigint: true });
            assert.equal(opened.dev, before.dev);
            assert.equal(opened.ino, before.ino);
            const bytes = syncFs.readFileSync(fd);
            assert.equal(BigInt(bytes.length), before.size);
            const after = syncFs.fstatSync(fd, { bigint: true }),
                current = syncFs.lstatSync(expected.path, { bigint: true });
            for (const stat of [after, current])
                for (const k of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'])
                    assert.equal(stat[k], before[k]);
            assert.deepEqual(
                {
                    path: expected.path,
                    sha256: hash(bytes),
                    bytes: bytes.length,
                    dev: String(before.dev),
                    ino: String(before.ino),
                    mtimeNs: String(before.mtimeNs),
                    ctimeNs: String(before.ctimeNs),
                },
                expected,
            );
        } catch (error) {
            primary = error;
            throw error;
        } finally {
            try {
                syncFs.closeSync(fd);
                ownedSyncDescriptors.delete(ownership);
            } catch (closure) {
                throw primary
                    ? new AggregateError(
                          [primary, closure],
                          'Prepared artifact guard and descriptor closure failed',
                      )
                    : closure;
            }
        }
    }
    return prepared;
}

export function verifyPtyProcessBirth(pid, fileTime, identity) {
    assert(typeof fileTime === 'string' && /^[1-9]\d{0,19}$/.test(fileTime));
    const root = Array.isArray(identity) ? identity.find((r) => r.pid === pid) : identity;
    assert(
        root && root.pid === pid && typeof root.created === 'string',
        'Owned PTY process creation identity required',
    );
    const owned = windowsCreationOrder(root.created) + 116444736000000000n,
        self = BigInt(fileTime);
    // Win32_Process CreationDate has microsecond precision; .NET StartTime retains100ns.
    // Supplemental cross-provider check only: sampler identities/generation rules are unchanged.
    assert(
        owned === self || (owned % 10n === 0n && (self / 10n) * 10n === owned),
        'PTY self/owned process creation differs',
    );
}
