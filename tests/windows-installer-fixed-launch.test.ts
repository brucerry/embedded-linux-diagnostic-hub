import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createWindowsFixedLaunchAttempt } from './fixtures/windows-installer-fixed-launch.ts';

// Only fake host calls: no executable, PowerShell, process inspection or installation.
test('one direct fixed invocation preserves the exact returned handle', () => {
    const calls: unknown[][] = [],
        child = new EventEmitter();
    const environment = {
        Path: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        electron_run_as_node: '1',
        node_options: '--require injected',
        Node_Path: 'x',
        Portable_Executable_File: 'x',
        portable_executable_dir: 'x',
        PORTABLE_EXECUTABLE_APP_FILENAME: 'x',
    };
    const originalEnvironment = { ...environment };
    const attempt = createWindowsFixedLaunchAttempt('C:\\Program Files\\Diagnostic Hub', {
        platform: 'win32',
        environment,
        spawn(...args) {
            calls.push(args);
            return child;
        },
    });
    assert.equal(calls.length, 0);
    assert.equal(attempt.snapshot().outcome, 'not-attempted');
    const result = attempt.invoke();
    assert.deepEqual(calls, [
        [
            'C:\\Program Files\\Diagnostic Hub\\Diagnostic Hub.exe',
            [],
            {
                cwd: 'C:\\Program Files\\Diagnostic Hub',
                shell: false,
                detached: false,
                windowsHide: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { Path: 'C:\\Windows', TEMP: 'C:\\Temp' },
            },
        ],
    ]);
    assert.deepEqual(environment, originalEnvironment);
    assert.equal(result.child, child);
    assert.equal(result.handleReturned, true);
    assert.equal(result.errorObserverAttached, true);
    assert.equal(result.processErrorObserved, false);
    assert.equal(child.listenerCount('error'), 1);
    assert.equal(result.outcome, 'returned-unobserved');
    assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
    assert.equal(calls.length, 1);
});

test('throw after invocation remains uncertain and cannot be retried', () => {
    const fault = Error('injected failure');
    let calls = 0;
    const attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
        platform: 'win32',
        environment: {},
        spawn() {
            calls++;
            throw fault;
        },
    });
    const result = attempt.invoke();
    assert.equal(result.outcome, 'invocation-uncertain');
    assert.equal(result.invocationError, fault);
    assert.equal(result.handleReturned, false);
    assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
    assert.equal(calls, 1);
});

test('bad roots and non-Windows hosts refuse before invocation', () => {
    let calls = 0;
    const host = {
        platform: 'win32',
        environment: {},
        spawn() {
            calls++;
        },
    };
    for (const root of [
        '',
        'C:',
        'C:\\',
        'C:/Hub',
        '\\\\server\\share',
        'C:\\a\\..\\b',
        'C:\\a\\.\\b',
        'C:\\a\\',
        'C:\\a\\NUL.txt',
        'C:\\a\\COM¹.txt',
        'C:\\a\\LPT²',
        'C:\\a\\CONIN$',
        'C:\\a\\CONOUT$.txt',
        'C:\\a\\folder.',
        'C:\\a\\folder ',
        'C:\\a\\file:stream',
        'C:\\a\\*',
        'C:\\a\\\\b',
        'C:\\a\u0000b',
    ])
        assert.throws(() => createWindowsFixedLaunchAttempt(root, host), /ROOT_INVALID/, root);
    assert.throws(
        () => createWindowsFixedLaunchAttempt('C:\\Hub', { ...host, platform: 'linux' }),
        /WINDOWS_REQUIRED/,
    );
    assert.equal(calls, 0);
});

test('reentrant spawn cannot invoke a second launch', () => {
    let calls = 0;
    let attempt: ReturnType<typeof createWindowsFixedLaunchAttempt>;
    attempt = createWindowsFixedLaunchAttempt('D:\\Hub', {
        platform: 'win32',
        environment: {},
        spawn() {
            calls++;
            assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
            return new EventEmitter();
        },
    });
    assert.equal(attempt.invoke().outcome, 'returned-unobserved');
    assert.equal(calls, 1);
});

test('invalid return is uncertain and is never evidence of process absence', () => {
    for (const value of [null, undefined, 0, 'child']) {
        const attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
            platform: 'win32',
            environment: {},
            spawn() {
                return value;
            },
        });
        const result = attempt.invoke();
        assert.equal(result.outcome, 'invocation-uncertain');
        assert.equal(result.handleReturned, false);
        assert.ok(result.invocationError instanceof Error);
        assert.match(result.invocationError.message, /HANDLE_UNAVAILABLE/);
        assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
    }
});

test('install root length limit is enforced before invoking a host', () => {
    let calls = 0;
    const host = {
        platform: 'win32',
        environment: {},
        spawn() {
            calls++;
            return {};
        },
    };
    assert.equal(
        createWindowsFixedLaunchAttempt('C:\\' + 'a'.repeat(217), host).snapshot().outcome,
        'not-attempted',
    );
    assert.throws(
        () => createWindowsFixedLaunchAttempt('C:\\' + 'a'.repeat(218), host),
        /ROOT_INVALID/,
    );
    assert.equal(calls, 0);
});

test('asynchronous errors retain the child and never establish retirement or allow retry', async () => {
    const child = new EventEmitter();
    const fault = Error('fake ENOENT');
    let calls = 0;
    const attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
        platform: 'win32',
        environment: {},
        spawn() {
            calls++;
            queueMicrotask(() => child.emit('error', fault));
            return child;
        },
    });
    const before = attempt.invoke();
    assert.equal(before.outcome, 'returned-unobserved');
    await Promise.resolve();
    const after = attempt.snapshot();
    assert.equal(after.child, child);
    assert.equal(after.processErrorObserved, true);
    assert.equal(after.processError, fault);
    assert.equal(after.outcome, 'process-error-unretired');
    assert.equal(before.processErrorObserved, false);
    assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
    assert.equal(calls, 1);
    assert.doesNotThrow(() => child.emit('error', Error('second fake error')));
    assert.equal(attempt.snapshot().processError, fault);
});

test('missing or throwing observer registration preserves the returned handle and uncertainty', () => {
    const fault = Error('registration failed');
    for (const child of [
        {},
        { on: 1 },
        {
            on() {
                throw fault;
            },
        },
        {
            get on() {
                throw fault;
            },
        },
    ]) {
        const attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
            platform: 'win32',
            environment: {},
            spawn() {
                return child;
            },
        });
        const result = attempt.invoke();
        assert.equal(result.child, child);
        assert.equal(result.handleReturned, true);
        assert.equal(result.errorObserverAttached, false);
        assert.equal(result.outcome, 'invocation-uncertain');
        assert.ok(result.invocationError instanceof Error);
        assert.throws(() => attempt.invoke(), /ALREADY_ATTEMPTED/);
    }
});

test('errors during observer registration are retained even if registration later throws', () => {
    const fault = Error('process fault'),
        registrationFault = Error('registration fault');
    let attempt: ReturnType<typeof createWindowsFixedLaunchAttempt>;
    const child = {
        on(event: string, observer: (error: unknown) => void) {
            assert.equal(event, 'error');
            assert.equal(attempt.snapshot().child, child);
            observer(fault);
            throw registrationFault;
        },
    };
    attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
        platform: 'win32',
        environment: {},
        spawn() {
            return child;
        },
    });
    const result = attempt.invoke();
    assert.equal(result.child, child);
    assert.equal(result.processError, fault);
    assert.equal(result.processErrorObserved, true);
    assert.equal(result.invocationError, registrationFault);
    assert.equal(result.outcome, 'invocation-uncertain');
});

test('undefined error payload is distinguished from an unobserved error', () => {
    const child = new EventEmitter();
    const attempt = createWindowsFixedLaunchAttempt('C:\\Hub', {
        platform: 'win32',
        environment: {},
        spawn() {
            return child;
        },
    });
    attempt.invoke();
    child.emit('error', undefined);
    child.emit('error', Error('later error'));
    assert.equal(attempt.snapshot().processErrorObserved, true);
    assert.equal(attempt.snapshot().processError, undefined);
    assert.equal(attempt.snapshot().outcome, 'process-error-unretired');
});
