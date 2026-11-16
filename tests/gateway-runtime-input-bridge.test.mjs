// Closed-memory bridge controls. No Python, Gateway, filesystem writes, sockets or timers run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startGatewayRuntimeInputBridge } from '../scripts/lib/gateway-runtime-input-bridge.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = ['asn1', 'bcrypt-pbkdf', 'safer-buffer', 'ssh2', 'tweetnacl'];
const sourcePaths = [
    'scripts/ci/prepare-gateway-runtime-inputs.py',
    'scripts/ci/gateway-runtime-native.py',
    'scripts/ci/prepare-gateway-runtime-child.py',
    'scripts/ci/gateway-runtime-inputs.json',
];
function canonical(value) {
    const sorted = (item) =>
        Array.isArray(item)
            ? item.map(sorted)
            : item && typeof item === 'object'
              ? Object.fromEntries(
                    Object.keys(item)
                        .sort()
                        .map((key) => [key, sorted(item[key])]),
                )
              : item;
    return Buffer.from(JSON.stringify(sorted(value)) + '\n');
}
const pulse = async () => {
    for (let i = 0; i < 2000; i++) await Promise.resolve();
};
function deferred() {
    let resolve;
    const promise = new Promise((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
function fixture() {
    const sourceRoot = '/project',
        pythonPath = '/usr/bin/python3.12';
    const sourceLockBytes = Buffer.from('{"fixture":"source lock data only"}\n');
    const profile = canonical({ schemaVersion: 1, sourceLockSHA256: hash(sourceLockBytes) });
    const files = new Map(
        sourcePaths.map((name) => [
            sourceRoot + '/' + name,
            name.endsWith('.json')
                ? profile
                : Buffer.from('# synthetic source bytes, never evaluated: ' + name + '\n'),
        ]),
    );
    files.set(pythonPath, Buffer.from('synthetic interpreter bytes, never executed'));
    const selection = {
        sourceRoot,
        pythonPath,
        pythonSHA256: hash(files.get(pythonPath)),
        uid: 1000,
        sourceFiles: Object.fromEntries(
            sourcePaths.map((name) => [name, hash(files.get(sourceRoot + '/' + name))]),
        ),
    };
    const request = {
        sourceLockBytes,
        installRoot:
            '/job-temp/diagnostic-hub-gateway-123-attempt-1/validation/gateway-runtime/install',
        archivesRoot:
            '/job-temp/diagnostic-hub-gateway-123-attempt-1/validation/gateway-runtime/inputs/runtime-archives',
    };
    const originalArchives = names.map((name, index) => {
        const bytes = Buffer.from('synthetic original archive data only: ' + name);
        files.set(request.archivesRoot + '/' + (index + 1) + '.tgz', bytes);
        return {
            path: 'node_modules/' + name,
            file: index + 1 + '.tgz',
            bytes: bytes.length,
            sha256: hash(bytes),
        };
    });
    const report = {
        schemaVersion: 1,
        status: 'prepared-inputs-not-runtime',
        sourceLockSHA256: hash(sourceLockBytes),
        profileSHA256: hash(profile),
        archives: originalArchives,
    };
    const controls = {},
        readCalls = [],
        launchCalls = [],
        timers = [],
        childReady = deferred();
    let child,
        stdinCallback,
        stdinBytes,
        stdinEnded = false,
        spawned = false,
        signalCalls = 0;
    const ports = {
        readFile: async (file, maximum) => {
            readCalls.push({ file, maximum });
            if (controls.archiveReadFailure && file === request.archivesRoot + '/1.tgz')
                throw undefined;
            assert.ok(files.has(file), 'Only exact predeclared paths may be read.');
            const bytes = files.get(file);
            assert.ok(bytes.length <= maximum);
            return Buffer.from(bytes);
        },
        fileSnapshot: () => ({
            pending: 0,
            handles: controls.heldFile ? 1 : 0,
            uncertainPublications: controls.uncertainFile ? 1 : 0,
            primaryFailure: controls.priorFileFailure === true,
        }),
        now: () => 0,
        setTimer(callback, ms) {
            const timer = { callback, ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) {
            if (controls.clearFailure) throw undefined;
            timer.cleared = true;
        },
        launch(file, args, options) {
            launchCalls.push({ file, args, options });
            child = new EventEmitter();
            Object.assign(child, {
                pid: 777,
                exitCode: null,
                signalCode: null,
                spawnfile: file,
                spawnargs: [file, ...args],
                stdin: new EventEmitter(),
                stdout: new EventEmitter(),
                stderr: new EventEmitter(),
                kill() {
                    signalCalls++;
                    assert.fail('The bridge must never signal a process.');
                },
            });
            child.stdin.end = (bytes, callback) => {
                assert.equal(stdinEnded, false, 'The input may only be submitted once.');
                stdinEnded = true;
                stdinBytes = Buffer.from(bytes);
                stdinCallback = callback;
                return controls.asyncInput ? Promise.resolve(child.stdin) : child.stdin;
            };
            childReady.resolve(child);
            return child;
        },
    };
    function spawn() {
        if (!spawned) {
            spawned = true;
            child.emit('spawn');
        }
    }
    function acknowledgeInput() {
        stdinCallback(controls.inputError ? Error('authored input failure') : undefined);
        child.stdin.emit('finish');
        child.stdin.emit('close');
    }
    function complete(raw = canonical(report), code = 0, signal = null) {
        spawn();
        if (!controls.holdInput) acknowledgeInput();
        if (raw.length) child.stdout.emit('data', raw);
        if (controls.stderr) child.stderr.emit('data', Buffer.from('authored bounded stderr'));
        if (!controls.holdStdout) {
            child.stdout.emit('end');
            child.stdout.emit('close');
        }
        if (!controls.holdStderr) {
            child.stderr.emit('end');
            child.stderr.emit('close');
        }
        child.emit('exit', code, signal);
        child.emit('close', code, signal);
    }
    return {
        selection,
        request,
        profile,
        files,
        report,
        originalArchives,
        controls,
        readCalls,
        launchCalls,
        timers,
        childReady: childReady.promise,
        ports,
        start: () => startGatewayRuntimeInputBridge(selection, request, ports),
        spawn,
        acknowledgeInput,
        complete,
        callbackInput: (error) => stdinCallback(error),
        get child() {
            return child;
        },
        get stdinBytes() {
            return stdinBytes;
        },
        get signalCalls() {
            return signalCalls;
        },
    };
}

test('bridge reads pinned code/interpreter and returns exact original buffers only after direct child and input closure', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    assert.equal(f.launchCalls.length, 1);
    const launch = f.launchCalls[0];
    assert.equal(launch.file, f.selection.pythonPath);
    assert.deepEqual(launch.args, [
        '-I',
        '-B',
        '-S',
        '/project/scripts/ci/prepare-gateway-runtime-child.py',
    ]);
    assert.equal(launch.options.cwd, '/project');
    assert.equal(launch.options.shell, false);
    assert.deepEqual(launch.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(launch.options.env, {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
    });
    assert.ok(f.stdinBytes.length <= 1024 ** 2);
    const input = JSON.parse(f.stdinBytes.toString('utf8'));
    assert.ok(JSON.stringify(input).includes(f.request.sourceLockBytes.toString('base64')));
    assert.ok(JSON.stringify(input).includes(f.profile.toString('base64')));
    assert.equal(f.timers[0].ms, 300000);
    f.complete();
    const result = await owner.result;
    await owner.closed;
    assert.deepEqual(
        result.map((row) => row.path),
        names.map((name) => 'node_modules/' + name),
    );
    for (const [index, row] of result.entries())
        assert.ok(
            row.bytes.equals(f.files.get(f.request.archivesRoot + '/' + (index + 1) + '.tgz')),
        );
    assert.equal(f.signalCalls, 0);
    assert.ok(f.timers.every((timer) => timer.cleared));
    assert.equal(f.child.eventNames().length, 0);
});

for (const which of ['python', 'preparer', 'native', 'child', 'profile'])
    test(which + ' byte mismatch prevents child dispatch', async () => {
        const f = fixture();
        const file =
            which === 'python'
                ? f.selection.pythonPath
                : '/project/' +
                  sourcePaths[['preparer', 'native', 'child', 'profile'].indexOf(which)];
        f.files.set(file, Buffer.from('different untrusted input'));
        const owner = f.start();
        await assert.rejects(owner.result);
        assert.equal(f.launchCalls.length, 0);
        assert.equal(f.signalCalls, 0);
    });

test('unknown asynchronous stdin submission remains failed without a second submission or signal', async () => {
    const f = fixture();
    f.controls.asyncInput = true;
    const owner = f.start();
    await f.childReady;
    await assert.rejects(owner.result);
    f.complete();
    await pulse();
    await assert.rejects(owner.result);
    assert.equal(f.launchCalls.length, 1);
    assert.equal(f.signalCalls, 0);
});
test('duplicate stdin acknowledgement is rejected before publication can be accepted', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    f.spawn();
    f.callbackInput();
    f.callbackInput();
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});
test('stdin error remains a failure after all later direct-child closure events', async () => {
    const f = fixture();
    f.controls.inputError = true;
    const owner = f.start();
    await f.childReady;
    f.complete();
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});

for (const which of [
    'truncated',
    'extra-field',
    'duplicate-key',
    'invalid-utf8',
    'wrong-schema',
    'wrong-lock',
    'wrong-profile',
    'file-order',
    'wrong-file',
    'wrong-size',
    'negative-size',
    'trailing-data',
])
    test('refuses ' + which + ' child report', async () => {
        const f = fixture(),
            owner = f.start();
        await f.childReady;
        let bytes;
        if (which === 'truncated') bytes = canonical(f.report).subarray(0, 17);
        if (which === 'extra-field') bytes = canonical({ ...f.report, extra: true });
        if (which === 'duplicate-key')
            bytes = Buffer.from(
                '{"schemaVersion":1,"schemaVersion":1,' + canonical(f.report).toString().slice(1),
            );
        if (which === 'invalid-utf8') bytes = Buffer.from([0xff, 0xfe]);
        if (which === 'wrong-schema') bytes = canonical({ ...f.report, schemaVersion: 2 });
        if (which === 'wrong-lock')
            bytes = canonical({ ...f.report, sourceLockSHA256: 'f'.repeat(64) });
        if (which === 'wrong-profile')
            bytes = canonical({ ...f.report, profileSHA256: 'f'.repeat(64) });
        if (which === 'file-order')
            bytes = canonical({ ...f.report, archives: [...f.report.archives].reverse() });
        if (which === 'wrong-file')
            bytes = canonical({
                ...f.report,
                archives: f.report.archives.map((row, index) =>
                    index ? row : { ...row, file: '../1.tgz' },
                ),
            });
        if (which === 'wrong-size')
            bytes = canonical({
                ...f.report,
                archives: f.report.archives.map((row, index) =>
                    index ? row : { ...row, bytes: row.bytes + 1 },
                ),
            });
        if (which === 'negative-size')
            bytes = canonical({
                ...f.report,
                archives: f.report.archives.map((row, index) =>
                    index ? row : { ...row, bytes: -1 },
                ),
            });
        if (which === 'trailing-data')
            bytes = Buffer.concat([canonical(f.report), Buffer.from('not JSON')]);
        f.complete(bytes);
        await assert.rejects(owner.result);
        assert.equal(f.signalCalls, 0);
        assert.ok(f.readCalls.every((row) => !row.file.includes('/../')));
    });

test('stdout overflow cannot fall back to parsing a partial report', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    f.complete(Buffer.alloc(8193, 65));
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});
test('stderr is bounded and nonempty stderr cannot be called a successful preparation', async () => {
    const f = fixture();
    f.controls.stderr = true;
    const owner = f.start();
    await f.childReady;
    f.complete();
    await assert.rejects(owner.result);
});
test('stderr overflow is refused without a raw-output fallback or another launch', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    f.spawn();
    f.acknowledgeInput();
    f.child.stderr.emit('data', Buffer.alloc(1025, 65));
    await assert.rejects(owner.result);
    assert.equal(f.launchCalls.length, 1);
    assert.equal(f.signalCalls, 0);
});
test('output after stdout closure is rejected before the remaining child events', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    f.spawn();
    f.acknowledgeInput();
    f.child.stdout.emit('close');
    f.child.stdout.emit('data', canonical(f.report));
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});
for (const stream of ['stdout', 'stderr'])
    test(
        stream + ' close before EOF prevents handoff even after late EOF and direct closure',
        async () => {
            const f = fixture(),
                owner = f.start();
            await f.childReady;
            f.spawn();
            f.acknowledgeInput();
            f.child.stdout.emit('data', canonical(f.report));
            const other = stream === 'stdout' ? 'stderr' : 'stdout';
            f.child[other].emit('end');
            f.child[other].emit('close');
            f.child[stream].emit('close');
            await assert.rejects(owner.result);
            assert.equal(
                f.readCalls.filter((row) => row.file.startsWith(f.request.archivesRoot + '/'))
                    .length,
                0,
            );
            f.child[stream].emit('end');
            f.child.emit('exit', 0, null);
            f.child.emit('close', 0, null);
            await pulse();
            await assert.rejects(owner.result);
            assert.equal(
                f.readCalls.filter((row) => row.file.startsWith(f.request.archivesRoot + '/'))
                    .length,
                0,
            );
            assert.equal(f.signalCalls, 0);
        },
    );
test('stdout data after EOF prevents handoff permanently despite later pipe and child closure', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    f.spawn();
    f.acknowledgeInput();
    f.child.stdout.emit('data', canonical(f.report));
    f.child.stdout.emit('end');
    f.child.stdout.emit('data', Buffer.from('unexpected data after end'));
    await assert.rejects(owner.result);
    f.child.stdout.emit('close');
    f.child.stderr.emit('end');
    f.child.stderr.emit('close');
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    await pulse();
    await assert.rejects(owner.result);
    assert.equal(
        f.readCalls.filter((row) => row.file.startsWith(f.request.archivesRoot + '/')).length,
        0,
    );
    assert.equal(f.signalCalls, 0);
});
for (const [code, signal] of [
    [1, null],
    [null, 'SIGTERM'],
])
    test('refuses unsuccessful direct exit ' + String(code) + '/' + String(signal), async () => {
        const f = fixture(),
            owner = f.start();
        await f.childReady;
        f.complete(canonical(f.report), code, signal);
        await assert.rejects(owner.result);
        assert.equal(f.signalCalls, 0);
    });
test('deadline with missing EOF retains failure and a late close is never retried as success', async () => {
    const f = fixture();
    f.controls.holdStderr = true;
    const owner = f.start();
    await f.childReady;
    f.complete();
    await pulse();
    f.timers.find((timer) => timer.ms === 300000).callback();
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
    f.child.stderr.emit('end');
    f.child.stderr.emit('close');
    await pulse();
    await assert.rejects(owner.result);
    assert.equal(f.launchCalls.length, 1);
});
test('missing stdin closure cannot publish successful original archives', async () => {
    const f = fixture();
    f.controls.holdInput = true;
    const owner = f.start();
    await f.childReady;
    f.complete();
    f.timers.find((timer) => timer.ms === 300000).callback();
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});
test('archive bytes must match the reported exact size and digest after child close', async () => {
    const f = fixture(),
        owner = f.start();
    await f.childReady;
    f.files.set(f.request.archivesRoot + '/1.tgz', Buffer.from('altered original archive'));
    f.complete();
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});
test('raw undefined archive read failure remains failed instead of yielding empty originals', async () => {
    const f = fixture();
    f.controls.archiveReadFailure = true;
    const owner = f.start();
    await f.childReady;
    f.complete();
    await assert.rejects(owner.result);
    assert.equal(f.signalCalls, 0);
});
for (const which of ['heldFile', 'uncertainFile', 'priorFileFailure', 'clearFailure'])
    test('retains ' + which + ' uncertainty despite a zero direct-child exit', async () => {
        const f = fixture();
        f.controls[which] = true;
        const owner = f.start();
        if (which === 'clearFailure') {
            await f.childReady;
            f.complete();
        } else {
            await pulse();
            if (f.child) f.complete();
        }
        await assert.rejects(owner.result);
        assert.equal(f.signalCalls, 0);
    });
