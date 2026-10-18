import assert from 'node:assert/strict';
import test from 'node:test';
import {
    sshExecutionMode,
    requireConsoleCapabilities,
    sshInput,
    sshInputBytes,
    consoleCompletion,
    consoleReady,
    consoleStep,
} from '../shared/ssh-console';

test('legacy mode remains independent and a missing/old streaming capability cannot authorize console', () => {
    assert.equal(sshExecutionMode(undefined), 'independent-script');
    for (const mode of [null, '', 'pty', 1, {}, []])
        assert.throws(() => sshExecutionMode(mode), /unsupported/);
    const advertised = { protocol: 1, independentStream: 1, persistentConsole: 1 };
    let accessorRead = false;
    const accessor = {
        ...advertised,
        get protocol() {
            accessorRead = true;
            return 1;
        },
    };
    assert.deepEqual(requireConsoleCapabilities(advertised), advertised);
    for (const value of [
        undefined,
        null,
        {},
        { protocol: 1, persistentConsole: 1 },
        { ...advertised, protocol: 2 },
        { ...advertised, independentStream: 0 },
        { ...advertised, token: 'not metadata' },
        Object.create(advertised),
        { ...advertised, [Symbol('unknown')]: true },
        accessor,
    ])
        assert.throws(() => requireConsoleCapabilities(value));
    assert.equal(accessorRead, false, 'Validation must not invoke metadata accessors.');
});

test('Script and consecutive Send Enter derive exact bytes without rewriting or helper commands', () => {
    const command = ' cd /\npwd\nll\nfixture_hi ';
    assert.equal(
        Buffer.from(sshInputBytes(undefined, { intent: 'script', command })).toString(),
        command,
    );
    assert.equal(
        Buffer.from(sshInputBytes('console', { intent: 'script', command })).toString(),
        command + '\r',
    );
    for (let index = 0; index < 2; index++)
        assert.deepEqual(
            [...sshInputBytes('console', { intent: 'send-enter', command: '' })],
            [13],
        );
    const first = sshInputBytes('console', { intent: 'send-enter', command: '' });
    first[0] = 0;
    assert.deepEqual([...sshInputBytes('console', { intent: 'send-enter', command: '' })], [13]);
});

test('invalid blank/oversized/NUL scripts, independent Enter and unknown fields fail before input', () => {
    for (const command of ['', ' \t\n', 'a\0b', 'x'.repeat(8193), '€'.repeat(2731)])
        assert.throws(() => sshInput('console', { intent: 'script', command }));
    assert.equal(
        sshInputBytes('console', { intent: 'script', command: 'x'.repeat(8192) }).length,
        8193,
    );
    for (const action of [
        { intent: 'send-enter', command: '' },
        { intent: 'send-enter', command: ' ' },
    ])
        assert.throws(() => sshInput(undefined, action), /console mode/);
    for (const action of [
        { command: 'pwd' },
        { intent: 'script', command: 'pwd', write: true },
        { intent: 'send-enter', command: 'pwd' },
    ])
        assert.throws(() => sshInput('console', action));
});

test('literal criteria are bounded and explicit, including initial readiness and intermediate input roles', () => {
    const initial = { role: 'shell-prompt', literals: ['fixture:/root# '] };
    assert.deepEqual(consoleReady(initial), initial);
    assert.throws(
        () => consoleReady({ role: 'intermediate-input-prompt', literals: ['Proceed? '] }),
        /Initial/,
    );
    for (const value of [
        undefined,
        null,
        {},
        { role: 'shell-prompt', literals: [] },
        { role: 'shell-prompt', literals: Array(1) },
        { role: 'shell-prompt', literals: [' '] },
        { role: 'shell-prompt', literals: ['x'.repeat(257)] },
        { role: 'shell-prompt', literals: ['\x1b[32m# '] },
        { role: 'shell-prompt', literals: ['same', 'same'] },
        { role: 'shell-prompt', literals: Array.from({ length: 9 }, (_, i) => 'p' + i) },
        { role: 'shell-prompt', literals: [/board#/] },
        { ...initial, regex: true },
    ])
        assert.throws(() => consoleCompletion(value));
    // A user-supplied literal is literal text, never a regex or automatic generic fallback.
    assert.deepEqual(consoleCompletion({ role: 'shell-prompt', literals: ['.*# '] }).literals, [
        '.*# ',
    ]);
});

test('armed per-step snapshots isolate command, defaults, overrides and alternatives from later edits', () => {
    const defaults = { role: 'shell-prompt', literals: ['fixture:/root# ', 'fixture:/# '] };
    const input = { intent: 'script', command: 'cd /' };
    const frozen = consoleStep(input, defaults);
    input.command = 'different';
    defaults.literals[0] = 'changed';
    assert.equal(frozen.command, 'cd /');
    assert.deepEqual(frozen.completion.literals, ['fixture:/root# ', 'fixture:/# ']);
    assert.ok(
        Object.isFrozen(frozen) &&
            Object.isFrozen(frozen.completion) &&
            Object.isFrozen(frozen.completion.literals),
    );
    const next = consoleStep(
        {
            intent: 'send-enter',
            command: '',
            completion: {
                role: 'intermediate-input-prompt',
                literals: ['Proceed fixture [Enter]? '],
            },
        },
        defaults,
    );
    assert.equal(next.completion.role, 'intermediate-input-prompt');
    assert.deepEqual(next.completion.literals, ['Proceed fixture [Enter]? ']);
    assert.throws(() => consoleStep(input, undefined), /completion/);
});
