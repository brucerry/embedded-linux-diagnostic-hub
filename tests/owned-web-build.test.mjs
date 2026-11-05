import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    startOwnedWebBuild,
    WEB_BUILD_BOUNDS,
    validateWebBuildCustody,
    WebBuildCustodyFailure,
    runHeldWebProducer,
} from '../scripts/lib/owned-web-build.mjs';

function fixture(override = {}) {
    const child = Object.assign(new EventEmitter(), {
        pid: 123,
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        signalCode: null,
    });
    let deadline,
        clears = 0,
        launches = 0,
        selected,
        time = 0;
    const plan = {
        command: ['/synthetic/node', '/synthetic/vite.js'],
        cwd: '/synthetic',
        environment: { NODE_ENV: 'production', WEB_BASE_PATH: './' },
        env: { LANG: 'C' },
    };
    const owner = startOwnedWebBuild(plan, {
        launch(command, options) {
            launches++;
            selected = { command, options };
            return child;
        },
        setTimer(callback, milliseconds) {
            assert.equal(milliseconds, WEB_BUILD_BOUNDS.deadlineMs);
            deadline = callback;
            return 1;
        },
        clearTimer(token) {
            assert.equal(token, 1);
            clears++;
        },
        now: () => time,
        ...override,
    });
    function close(code = 0, signal = null) {
        child.emit('exit', code, signal);
        child.emit('close', code, signal);
        child.stdout.emit('close');
        child.stderr.emit('close');
    }
    return {
        child,
        owner,
        plan,
        close,
        expire: () => deadline(),
        advance: (milliseconds) => {
            time += milliseconds;
        },
        get launches() {
            return launches;
        },
        get clears() {
            return clears;
        },
        get selected() {
            return selected;
        },
    };
}
const rejection = (owner) =>
    assert.rejects(owner.result, (error) => {
        assert.ok(error instanceof WebBuildCustodyFailure);
        assert.equal(error.owner, owner);
        return true;
    });

test('normal observation requires exit, child close and both pipe closures', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.stdout.emit('data', Buffer.from('synthetic build output'));
    let ready = false;
    f.owner.result.then(() => {
        ready = true;
    });
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.child.stdout.emit('close');
    await Promise.resolve();
    assert.equal(ready, false);
    f.child.stderr.emit('close');
    const result = await f.owner.result;
    validateWebBuildCustody(result.custody);
    assert.equal(result.custody.stdout.bytes, 22);
    assert.equal(
        result.custody.stdout.sha256,
        createHash('sha256').update('synthetic build output').digest('hex'),
    );
    assert.equal(result.custody.descendantRetirement, 'not-observed');
    assert.equal(f.owner.snapshot().listeners, 0);
    assert.equal(f.clears, 1);
    assert.equal(f.launches, 1);
    assert.deepEqual(f.selected.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(f.selected.options.shell, false);
});

for (const mode of [
    'deadline',
    'stdout-overflow',
    'stderr-overflow',
    'chunk-overflow',
    'child-error',
    'stream-error',
    'nonzero',
    'signal',
    'missing-pid',
    'missing-spawn',
    'close-mismatch',
    'invalid-data',
]) {
    test('failure stays failed after late direct closure: ' + mode, async () => {
        const f = fixture();
        if (mode === 'missing-pid') f.child.pid = undefined;
        if (mode !== 'missing-spawn') f.child.emit('spawn');
        if (mode === 'deadline') f.expire();
        if (mode.endsWith('-overflow') && mode !== 'chunk-overflow') {
            const name = mode.split('-')[0];
            f.child[name].emit('data', Buffer.alloc(WEB_BUILD_BOUNDS[name + 'Bytes'] + 1));
            assert.equal(f.owner.snapshot()[name + 'Overflow'], true);
            f.child[name].emit('data', Buffer.from('discarded after overflow'));
            assert.equal(f.owner.retainedOutput()[name].length, 0);
        }
        if (mode === 'chunk-overflow') {
            for (let i = 0; i <= WEB_BUILD_BOUNDS.chunksPerStream; i++)
                f.child.stdout.emit('data', Buffer.from('x'));
            assert.equal(f.owner.retainedOutput().stdout.length, WEB_BUILD_BOUNDS.chunksPerStream);
        }
        if (mode === 'child-error') f.child.emit('error', Error('synthetic failure'));
        if (mode === 'stream-error') f.child.stdout.emit('error', Error('synthetic failure'));
        if (mode === 'invalid-data') f.child.stdout.emit('data', 'not a Buffer');
        if (mode === 'close-mismatch') {
            f.child.emit('exit', 0, null);
            f.child.emit('close', 1, null);
            f.child.stdout.emit('close');
            f.child.stderr.emit('close');
        } else f.close(mode === 'nonzero' ? 1 : 0, mode === 'signal' ? 'SIGTERM' : null);
        await rejection(f.owner);
        assert.ok(f.owner.snapshot().failure);
        assert.equal((await f.owner.waitForDirectClosure()).listeners, 0);
        assert.equal(f.launches, 1);
    });
}

test('deadline rejection retains pending child and listeners without any teardown', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.expire();
    await rejection(f.owner);
    assert.equal(f.owner.snapshot().childClosed, false);
    assert.ok(f.owner.snapshot().listeners > 0);
    assert.equal(f.clears, 0);
    f.close();
    await f.owner.waitForDirectClosure();
    await rejection(f.owner);
});

test('CLI boundary catches propagated main rejection and preserves pending custody', async () => {
    const f = fixture();
    let code, message;
    f.child.emit('spawn');
    const completed = runHeldWebProducer(async () => await f.owner.result, {
        setExitCode: (value) => {
            code = value;
        },
        report: (value) => {
            message = value;
        },
    });
    f.expire();
    assert.equal(await completed, undefined);
    assert.equal(code, 1);
    assert.ok(message.length < 100);
    assert.equal(f.owner.snapshot().childClosed, false);
    assert.ok(f.owner.snapshot().listeners > 0);
    f.close();
    await f.owner.waitForDirectClosure();
    await rejection(f.owner);
});

test('late close cannot beat a delayed timer callback', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.advance(WEB_BUILD_BOUNDS.deadlineMs + 1);
    f.close();
    await rejection(f.owner);
    assert.match(f.owner.snapshot().failure, /Elapsed observation/);
});

test('throwing dispatch stays uncertain and never retries', async () => {
    let calls = 0;
    const f = fixture({
        launch() {
            calls++;
            throw Error('uncertain dispatch');
        },
    });
    await rejection(f.owner);
    assert.equal(calls, 1);
    assert.equal(f.owner.snapshot().childClosed, false);
    assert.ok(f.owner.snapshot().failure.includes('Dispatch'));
});

test('unacknowledged listener removal retains custody and prevents success', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.stderr.off = () => {
        throw Error('synthetic held removal');
    };
    f.close();
    await rejection(f.owner);
    assert.ok(f.owner.snapshot().listeners > 0);
});

test('caller plan mutation cannot rewrite the selected command or environment', async () => {
    const f = fixture();
    f.plan.command[0] = '/changed';
    f.plan.environment.NODE_ENV = 'changed';
    f.plan.env.LANG = 'changed';
    f.child.emit('spawn');
    f.close();
    const result = await f.owner.result;
    assert.equal(result.command[0], '/synthetic/node');
    assert.equal(result.environment.NODE_ENV, 'production');
    assert.equal(f.selected.options.env.LANG, 'C');
    assert.equal(
        result.custody.environmentSHA256,
        createHash('sha256').update('[["LANG","C"]]').digest('hex'),
    );
});

test('summary validator rejects missing or fabricated direct closure and broader claims', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.close();
    const { custody } = await f.owner.result;
    for (const patch of [
        { childClose: false },
        { spawn: false },
        { exit: false },
        { descendantRetirement: 'proven' },
        { policy: 'timeout-is-retired' },
        { bounds: { ...WEB_BUILD_BOUNDS, deadlineMs: 1 } },
        { environmentSHA256: 'not-a-hash' },
        { stdout: { ...custody.stdout, closed: false } },
    ]) {
        assert.throws(() => validateWebBuildCustody({ ...custody, ...patch }));
    }
    const missing = { ...custody };
    delete missing.stderr;
    assert.throws(() => validateWebBuildCustody(missing));
});

test('CLI and build record use custody, while release acceptance remains blocked', async () => {
    const cli = await readFile(
        new URL('../scripts/produce-web-archive.mjs', import.meta.url),
        'utf8',
    );
    const producer = await readFile(
        new URL('../scripts/lib/web-archive-producer.mjs', import.meta.url),
        'utf8',
    );
    const gate = await readFile(
        new URL('../scripts/lib/staged-artifact-gate.mjs', import.meta.url),
        'utf8',
    );
    const owner = await readFile(
        new URL('../scripts/lib/owned-web-build.mjs', import.meta.url),
        'utf8',
    );
    assert.match(cli, /startOwnedWebBuild/);
    assert.match(cli, /return await owner\.result/);
    assert.match(cli, /await runHeldWebProducer\(\(\) => main/);
    assert.doesNotMatch(cli, /spawnSync|stdio: 'inherit'|process\.exit\(/);
    assert.match(producer, /validateWebBuildCustody\(result\.custody\)/);
    assert.match(producer, /structuredClone\(await io\.build\(\)\)/);
    assert.match(gate, /Full-product evidence blocked/);
    assert.doesNotMatch(owner, /\.kill\(|\.destroy\(|\.unref\(|AbortController|process\.exit\(/);
});

test('Vite custody is not represented as full default Git/file or environment admission', async () => {
    const cli = await readFile(
        new URL('../scripts/produce-web-archive.mjs', import.meta.url),
        'utf8',
    );
    const provider = await readFile(
        new URL('../scripts/lib/committed-source-provider.mjs', import.meta.url),
        'utf8',
    );
    const doc = await readFile(
        new URL('../docs/web-producer-integration.md', import.meta.url),
        'utf8',
    );
    assert.match(cli, /native-executor-group-and-profile-admission/);
    assert.match(cli, /localSourceProvider\(root,\s*\{/);
    assert.match(cli, /requireOwnedWebCapabilities\(capability\)/);
    assert.match(provider, /timeout: 30000/);
    assert.match(doc.replace(/\s+/g, ' '), /Full default producer execution remains held/);
    assert.match(doc.replace(/\s+/g, ' '), /not a complete observed/);
});
