import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createWindowsFixedLaunchAttempt } from './fixtures/windows-installer-fixed-launch.ts';
import { WINDOWS_LAUNCH_CAPTURE_BYTES } from './fixtures/windows-installer-child-observation.ts';

// Controlled emitters only. No process, shell, installer or PowerShell is run.
class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    exitCode = 0;
    killed = true;
}
function launch(child = new FakeChild()) {
    let calls = 0;
    const attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
        platform: 'win32',
        environment: {},
        spawn() {
            calls++;
            return child;
        },
    });
    attempt.invoke();
    const snapshot = () => {
        const observation = attempt.snapshot().observation;
        assert.ok(observation);
        return observation;
    };
    return { child, attempt, snapshot, calls: () => calls };
}

test('both pipes retain separate byte-exact bounded prefixes and continue consuming after their caps', () => {
    const { child, snapshot } = launch();
    const a = Buffer.alloc(WINDOWS_LAUNCH_CAPTURE_BYTES + 31, 0x61);
    const b = Buffer.alloc(WINDOWS_LAUNCH_CAPTURE_BYTES + 57, 0x62);
    child.stdout.emit('data', a);
    child.stderr.emit('data', b);
    a.fill(0);
    b.fill(0);
    child.stdout.emit('data', Buffer.from('more output'));
    child.stderr.emit('data', Buffer.from('more errors'));
    const result = snapshot();
    assert.equal(result.registrationErrorObserved, false);
    for (const [pipe, value, extra] of [
        [result.stdout, 0x61, 31],
        [result.stderr, 0x62, 57],
    ] as const) {
        assert.equal(pipe.capturedBytes, WINDOWS_LAUNCH_CAPTURE_BYTES);
        assert.equal(pipe.bytesObserved, WINDOWS_LAUNCH_CAPTURE_BYTES + extra + 11);
        assert.equal(pipe.truncated, true);
        assert.deepEqual(
            Buffer.from(pipe.capturedBase64, 'base64'),
            Buffer.alloc(WINDOWS_LAUNCH_CAPTURE_BYTES, value),
        );
        assert.equal(pipe.dataObserverAttached, true);
    }
    assert.equal(child.stdout.listenerCount('data'), 1);
    assert.equal(child.stderr.listenerCount('data'), 1);
    assert.equal(result.childAndPipesCloseObserved, false);
});

test('exit, EOF, mutable flags and child close do not substitute for both pipe close events', () => {
    const { child, snapshot, attempt, calls } = launch();
    Object.assign(child.stdout, { destroyed: true, closed: true, readableEnded: true });
    assert.equal(snapshot().childAndPipesCloseObserved, false);
    child.emit('exit', 7, null);
    child.stdout.emit('end');
    child.stderr.emit('end');
    assert.equal(snapshot().exit.observed, true);
    assert.equal(snapshot().exit.code, 7);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
    child.emit('close', 7, null);
    child.stdout.emit('close');
    assert.equal(snapshot().childAndPipesCloseObserved, false);
    child.stderr.emit('close');
    assert.equal(snapshot().childAndPipesCloseObserved, true);
    assert.equal(snapshot().close.code, 7);
    assert.equal(snapshot().stdout.handle, child.stdout);
    assert.equal(snapshot().stderr.handle, child.stderr);
    assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
    assert.equal(calls(), 1);
    // Observation does not promote the launch to qualified/retired.
    assert.equal(attempt.snapshot().outcome, 'returned-unobserved');
});

test('pipe close without EOF is recorded distinctly from clean readable end', () => {
    const { child, snapshot } = launch();
    child.stdout.emit('close');
    child.stderr.emit('close');
    assert.equal(snapshot().childAndPipesCloseObserved, false);
    child.emit('close', null, 'SIGTERM');
    const result = snapshot();
    assert.equal(result.childAndPipesCloseObserved, true);
    assert.equal(result.stdout.endObserved, false);
    assert.equal(result.stderr.endObserved, false);
    assert.equal(result.exit.observed, false);
    assert.equal(result.close.signal, 'SIGTERM');
});

test('child and pipe errors retain first payloads independently and never imply closure', async () => {
    const { child, snapshot, attempt } = launch();
    const fault = Error('child fault'),
        pipeFault = Error('pipe fault');
    queueMicrotask(() => {
        child.emit('error', fault);
        child.stdout.emit('error', undefined);
        child.stderr.emit('error', pipeFault);
    });
    await Promise.resolve();
    child.emit('error', Error('later child fault'));
    child.stdout.emit('error', Error('later stdout fault'));
    child.stderr.emit('error', Error('later stderr fault'));
    assert.equal(attempt.snapshot().processError, fault);
    assert.equal(attempt.snapshot().outcome, 'process-error-unretired');
    const result = snapshot();
    assert.equal(result.stdout.errorObserved, true);
    assert.equal(result.stdout.error, undefined);
    assert.equal(result.stderr.error, pipeFault);
    assert.equal(result.childAndPipesCloseObserved, false);
});

test('binary and split UTF-8 bytes survive snapshots without sharing mutable capture storage', () => {
    const { child, snapshot } = launch();
    child.stdout.emit('data', Uint8Array.from([0xf0, 0x9f]));
    const before = snapshot();
    child.stdout.emit('data', Buffer.from([0x98, 0x80, 0x00, 0xff]));
    assert.deepEqual(
        Buffer.from(before.stdout.capturedBase64, 'base64'),
        Buffer.from([0xf0, 0x9f]),
    );
    assert.deepEqual(
        Buffer.from(snapshot().stdout.capturedBase64, 'base64'),
        Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0x00, 0xff]),
    );
    assert.equal(snapshot().stdout.truncated, false);
    assert.ok(Object.isFrozen(before));
    assert.ok(Object.isFrozen(before.stdout));
});

test('one pipe registration failure retains its handle and does not abandon the other pipe', () => {
    const child = new FakeChild(),
        fault = Error('stdout registration failed');
    child.stdout.on = () => {
        throw fault;
    };
    const { snapshot } = launch(child);
    child.stderr.emit('data', Buffer.from('stderr retained'));
    child.stderr.emit('close');
    child.emit('close', 0, null);
    const result = snapshot();
    assert.equal(result.registrationErrorObserved, true);
    assert.equal(result.registrationError, fault);
    assert.equal(result.stdout.handle, child.stdout);
    assert.equal(result.stdout.dataObserverAttached, false);
    assert.equal(result.stderr.dataObserverAttached, true);
    assert.equal(Buffer.from(result.stderr.capturedBase64, 'base64').toString(), 'stderr retained');
    assert.equal(result.childAndPipesCloseObserved, false);
});

test('throwing pipe getter preserves uncertainty and still observes the second pipe', () => {
    const child = new FakeChild(),
        fault = Error('stdout lookup failed');
    Object.defineProperty(child, 'stdout', {
        get() {
            throw fault;
        },
    });
    const { snapshot, attempt } = launch(child);
    child.stderr.emit('data', Buffer.from('ok'));
    const result = snapshot();
    assert.equal(result.registrationError, fault);
    assert.equal(result.stdout.handle, null);
    assert.equal(result.stderr.capturedBytes, 2);
    assert.equal(attempt.snapshot().child, child);
    assert.equal(attempt.snapshot().errorObserverAttached, true);
});

test('all terminal/error observers precede flowing mode and registration-time events are retained', () => {
    const child = new FakeChild();
    const originalOn = child.stdout.on;
    child.stdout.on = function (event, observer) {
        const result = originalOn.call(this, event, observer);
        if (event === 'data') {
            assert.equal(child.listenerCount('error'), 1);
            assert.equal(child.listenerCount('exit'), 1);
            assert.equal(child.listenerCount('close'), 1);
            assert.equal(child.stderr.listenerCount('error'), 1);
            assert.equal(child.stderr.listenerCount('close'), 1);
            child.stderr.emit('error', Error('synchronous fake pipe fault'));
            this.emit('data', Buffer.from('early bytes'));
        }
        return result;
    };
    const { snapshot } = launch(child);
    assert.equal(snapshot().stderr.errorObserved, true);
    assert.equal(snapshot().stdout.capturedBytes, 11);
});

test('malformed data and lifecycle payloads are explicit and cannot complete the observation', () => {
    const { child, snapshot } = launch();
    child.stdout.emit('data', 'unexpected encoding');
    child.emit('exit', undefined, {});
    child.stdout.emit('data', Buffer.from('next'));
    assert.equal(snapshot().stdout.invalidChunkObserved, true);
    assert.equal(snapshot().stdout.dataAfterTerminalEvent, false);
    assert.equal(snapshot().stdout.capturedBytes, 4);
    assert.equal(snapshot().exit.invalidPayloadObserved, true);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
    child.stdout.emit('close');
    child.stderr.emit('close');
    child.emit('close', 0, null);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
});

test('late bytes after EOF are still consumed but disqualify the combined close observation', () => {
    const { child, snapshot } = launch();
    child.stdout.emit('end');
    child.stdout.emit('data', Buffer.from('late'));
    child.stdout.emit('close');
    child.stderr.emit('close');
    child.emit('close', 0, null);
    assert.equal(snapshot().stdout.dataAfterTerminalEvent, true);
    assert.equal(snapshot().stdout.invalidChunkObserved, false);
    assert.equal(snapshot().stdout.capturedBytes, 4);
    assert.equal(snapshot().registrationErrorObserved, false);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
});

test('a malformed child close cannot satisfy the combined close observation', () => {
    const { child, snapshot } = launch();
    child.stdout.emit('close');
    child.stderr.emit('close');
    child.emit('close', undefined, {});
    assert.equal(snapshot().close.observed, true);
    assert.equal(snapshot().close.invalidPayloadObserved, true);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
});

test('one shared pipe cannot stand in for two independently retained pipes', () => {
    const child = new FakeChild();
    child.stderr = child.stdout;
    const { snapshot } = launch(child);
    child.stdout.emit('close');
    child.emit('close', 0, null);
    assert.equal(snapshot().stdout.closeObserved, true);
    assert.equal(snapshot().stderr.closeObserved, true);
    assert.equal(snapshot().pipeHandlesDistinct, false);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
});

test('partial registration keeps event facts but cannot report complete close observation', () => {
    const child = new FakeChild(),
        originalOn = child.stdout.on;
    child.stdout.on = function (event, observer) {
        if (event === 'data') throw Error('data listener failed');
        return originalOn.call(this, event, observer);
    };
    const { snapshot } = launch(child);
    child.stdout.emit('close');
    child.stderr.emit('close');
    child.emit('close', 0, null);
    assert.equal(snapshot().stdout.closeObserved, true);
    assert.equal(snapshot().stderr.closeObserved, true);
    assert.equal(snapshot().close.observed, true);
    assert.equal(snapshot().registrationErrorObserved, true);
    assert.equal(snapshot().childAndPipesCloseObserved, false);
});
