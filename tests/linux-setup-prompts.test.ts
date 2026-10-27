import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:fs';
import type { App, Dialog, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import {
    linuxGuiPrompt,
    linuxTerminalPrompt,
    type LinuxPromptClock,
    type LinuxTTYOps,
} from '../electron/linux-setup-prompts.ts';
function clockFixture() {
    let now = 0;
    const timers = new Map<object, () => void>();
    const clock: LinuxPromptClock = {
        now: () => now,
        set(callback) {
            const token = {};
            timers.set(token, callback);
            return token as ReturnType<typeof setTimeout>;
        },
        clear(token) {
            timers.delete(token);
        },
        async wait() {
            now = 60000;
        },
    };
    return {
        clock,
        timers,
        set(value: number) {
            now = value;
        },
    };
}
function guiFixture(response: MessageBoxReturnValue = { response: 1, checkboxChecked: true }) {
    const c = clockFixture();
    let readyCalls = 0;
    const requests: MessageBoxOptions[] = [];
    const app = {
        async whenReady() {
            readyCalls++;
        },
    } as Pick<App, 'whenReady'>;
    const dialog = {
        async showMessageBox(options: MessageBoxOptions) {
            requests.push(options);
            return response;
        },
    } as Pick<Dialog, 'showMessageBox'>;
    return { ...c, app, dialog, requests, readyCalls: () => readyCalls };
}
test('GUI prompt uses an owned cancellable Linux message box with default Cancel and menu checkbox', async () => {
    const f = guiFixture(),
        prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock);
    assert.deepEqual(
        await prompt.review({ detail: 'literal <&> "$x"', menu: false, deadlineMs: 120000 }),
        { status: 'confirmed', menu: true },
    );
    assert.equal(f.requests[0].defaultId, 0);
    assert.equal(f.requests[0].cancelId, 0);
    assert.deepEqual(f.requests[0].buttons, ['Cancel', 'Finish review']);
    assert.equal(f.requests[0].checkboxChecked, false);
    assert.equal(f.requests[0].detail, 'literal <&> "$x"');
    assert.ok(f.requests[0].signal);
    assert.equal(prompt.hasPending(), false);
    assert.equal(f.timers.size, 0);
});
test('GUI unavailability never initializes Electron and Cancel never becomes acceptance', async () => {
    const f = guiFixture({ response: 0, checkboxChecked: true });
    assert.deepEqual(
        await linuxGuiPrompt(f.app, f.dialog, false, f.clock).review({
            detail: '',
            menu: false,
            deadlineMs: 120000,
        }),
        { status: 'unavailable' },
    );
    assert.equal(f.readyCalls(), 0);
    assert.deepEqual(
        await linuxGuiPrompt(f.app, f.dialog, true, f.clock).review({
            detail: '',
            menu: false,
            deadlineMs: 120000,
        }),
        { status: 'cancelled' },
    );
});
test('GUI deadline aborts only its own prompt and cannot create another or confirm it', async () => {
    const f = guiFixture();
    f.dialog.showMessageBox = ((options: MessageBoxOptions) => {
        f.requests.push(options);
        return new Promise<MessageBoxReturnValue>((resolve) =>
            options.signal!.addEventListener('abort', () =>
                resolve({ response: 0, checkboxChecked: false }),
            ),
        );
    }) as Dialog['showMessageBox'];
    const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock),
        pending = prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
    await Promise.resolve();
    assert.equal(f.requests.length, 1);
    assert.equal(prompt.hasPending(), true);
    f.set(60000);
    [...f.timers.values()][0]();
    assert.deepEqual(await pending, { status: 'cancelled' });
    assert.equal(f.requests.length, 1);
    assert.equal(prompt.hasPending(), false);
});
test('expired/rolled-back readiness and late timer creation never admit a GUI submission', async () => {
    for (const problem of ['expired', 'rollback', 'timer'] as const) {
        const f = guiFixture();
        if (problem !== 'timer')
            f.app.whenReady = async () => {
                f.set(problem === 'expired' ? 60000 : -1);
            };
        else {
            const original = f.clock.set;
            f.clock.set = (callback, milliseconds) => {
                const token = original(callback, milliseconds);
                f.set(60000);
                return token;
            };
        }
        const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock);
        assert.deepEqual(await prompt.review({ detail: '', menu: false, deadlineMs: 120000 }), {
            status: 'unknown',
        });
        assert.equal(f.requests.length, 0);
    }
});
test('GUI submission error remains pending UNKNOWN and loses private exception text', async () => {
    const f = guiFixture();
    f.dialog.showMessageBox = (async () => {
        throw Error('private-GUI-canary');
    }) as Dialog['showMessageBox'];
    const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock),
        result = await prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
    assert.deepEqual(result, { status: 'unknown' });
    assert.equal(prompt.hasPending(), true);
    assert.doesNotMatch(JSON.stringify(result), /canary/);
});
function ttyFixture(answer: string | Buffer = 'review menu\n') {
    const c = clockFixture();
    let input = Buffer.from(answer),
        opened = 0,
        closed = 0,
        reads = 0,
        writes = 0,
        chosenFlags = 0;
    const ops: LinuxTTYOps = {
        platform: 'linux',
        uid: () => 1000,
        euid: () => 1000,
        fs: {
            constants,
            openSync(file: string, flags: number) {
                assert.equal(file, '/dev/tty');
                opened++;
                chosenFlags = flags;
                return 7;
            },
            fstatSync(fd: number) {
                assert.equal(fd, 7);
                return { isCharacterDevice: () => true };
            },
            readSync(fd: number, buffer: Buffer, offset: number, length: number) {
                assert.equal(fd, 7);
                reads++;
                const count = Math.min(input.length, length);
                input.copy(buffer, offset, 0, count);
                input = input.subarray(count);
                return count;
            },
            writeSync(fd: number, _buffer: Buffer, _offset: number, count: number) {
                assert.equal(fd, 7);
                writes++;
                return count;
            },
            closeSync(fd: number) {
                assert.equal(fd, 7);
                closed++;
            },
        } as unknown as LinuxTTYOps['fs'],
    };
    return { ...c, ops, counts: () => ({ opened, closed, reads, writes, chosenFlags }) };
}
test('TTY consent reads only fixed /dev/tty, never stdin; complete line and exact choices required', async () => {
    for (const [answer, expected] of [
        ['review menu\n', { status: 'confirmed', menu: true }],
        ['review no-menu\n', { status: 'confirmed', menu: false }],
        ['\n', { status: 'cancelled' }],
        ['yes\n', { status: 'cancelled' }],
        ['', { status: 'cancelled' }],
    ] as const) {
        const f = ttyFixture(answer),
            prompt = linuxTerminalPrompt(f.clock, f.ops);
        assert.deepEqual(
            await prompt.review({ detail: 'review only', menu: false, deadlineMs: 120000 }),
            expected,
        );
        assert.equal(f.counts().opened, 1);
        assert.equal(f.counts().closed, 1);
        assert.equal(prompt.hasPending(), false);
        assert.equal(f.counts().chosenFlags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
        assert.equal(f.counts().chosenFlags & constants.O_NONBLOCK, constants.O_NONBLOCK);
    }
});
test('TTY unavailable platform/root user cannot open a terminal', async () => {
    for (const problem of ['platform', 'root'] as const) {
        const f = ttyFixture();
        if (problem === 'platform') f.ops.platform = 'darwin';
        else f.ops.uid = () => 0;
        assert.deepEqual(
            await linuxTerminalPrompt(f.clock, f.ops).review({
                detail: '',
                menu: false,
                deadlineMs: 120000,
            }),
            { status: 'unavailable' },
        );
        assert.equal(f.counts().opened, 0);
    }
});
test('TTY missing terminal is unavailable; late FD/type/read failure is retained UNKNOWN without closure', async () => {
    for (const problem of ['missing', 'late', 'type', 'read'] as const) {
        const f = ttyFixture();
        if (problem === 'missing')
            f.ops.fs.openSync = (() => {
                throw Object.assign(Error('private'), { code: 'ENXIO' });
            }) as typeof f.ops.fs.openSync;
        if (problem === 'late') {
            const original = f.ops.fs.openSync;
            f.ops.fs.openSync = ((...args: Parameters<typeof original>) => {
                const fd = original(...args);
                f.set(60000);
                return fd;
            }) as typeof original;
        }
        if (problem === 'type')
            f.ops.fs.fstatSync = (() => ({
                isCharacterDevice: () => false,
            })) as unknown as typeof f.ops.fs.fstatSync;
        if (problem === 'read')
            f.ops.fs.readSync = (() => {
                throw Error('private');
            }) as typeof f.ops.fs.readSync;
        const prompt = linuxTerminalPrompt(f.clock, f.ops),
            result = await prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
        assert.equal(result.status, problem === 'missing' ? 'unavailable' : 'unknown');
        assert.equal(prompt.hasPending(), problem !== 'missing');
        assert.equal(f.counts().closed, 0);
        assert.doesNotMatch(JSON.stringify(result), /private/);
    }
});
test('TTY time limit, malformed UTF-8, multiline paste and byte overflow do not become consent', async () => {
    for (const answer of [
        'review menu\nreview menu\n',
        'x'.repeat(1025),
        'waiting',
        Buffer.from([0xff, 10]),
    ]) {
        const f = ttyFixture(answer);
        if (answer === 'waiting')
            f.ops.fs.readSync = (() => {
                throw Object.assign(Error('wait'), { code: 'EAGAIN' });
            }) as typeof f.ops.fs.readSync;
        const prompt = linuxTerminalPrompt(f.clock, f.ops);
        assert.deepEqual(await prompt.review({ detail: '', menu: false, deadlineMs: 120000 }), {
            status: 'unknown',
        });
        assert.equal(prompt.hasPending(), true);
        assert.equal(f.counts().closed, 0);
    }
});

test('GUI settled late or malformed clock samples never confirm even when timer callback was delayed', async () => {
    for (const sample of [60000, 60001, -1, NaN]) {
        const f = guiFixture();
        f.dialog.showMessageBox = (async () => {
            f.set(sample);
            return { response: 1, checkboxChecked: true };
        }) as Dialog['showMessageBox'];
        const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock);
        const result = await prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
        assert.notEqual(result.status, 'confirmed');
        assert.equal(prompt.hasPending(), false);
    }
});

// S1 regressions authored for review only; not executed in this successor.
test('S1 synchronous throw and rejected GUI submission freeze every later timer action while retaining custody', async () => {
    for (const mode of ['throw', 'reject'] as const) {
        const f = guiFixture();
        let aborts = 0;
        f.dialog.showMessageBox = ((options: MessageBoxOptions) => {
            f.requests.push(options);
            options.signal!.addEventListener('abort', () => { aborts++; });
            if (mode === 'throw') throw Error('private-submission-canary');
            return Promise.reject(Error('private-submission-canary'));
        }) as Dialog['showMessageBox'];
        const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock);
        const result = await prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
        assert.deepEqual(result, { status: 'unknown' });
        assert.equal(prompt.hasPending(), true);
        assert.equal(f.requests.length, 1);
        const callback = [...f.timers.values()][0];
        assert.ok(callback);
        f.set(60000);
        callback();
        f.set(120000);
        callback();
        // A frozen callback must not even consult a newly throwing clock.
        f.clock.now = () => { throw Error('private-clock-canary'); };
        assert.doesNotThrow(callback);
        assert.equal(aborts, 0);
        assert.equal(prompt.hasPending(), true);
        assert.doesNotMatch(JSON.stringify(result), /canary/);
    }
});
test('S1 late or invalid timer samples freeze actuation without fabricating prompt closure', async () => {
    for (const sample of [120000, 120001, NaN, Infinity, -1, 'throw'] as const) {
        const f = guiFixture();
        let aborts = 0;
        let settle!: (result: MessageBoxReturnValue) => void;
        f.dialog.showMessageBox = ((options: MessageBoxOptions) => {
            f.requests.push(options);
            options.signal!.addEventListener('abort', () => { aborts++; });
            return new Promise<MessageBoxReturnValue>((resolve) => { settle = resolve; });
        }) as Dialog['showMessageBox'];
        const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock);
        const result = prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
        await Promise.resolve();
        assert.equal(f.requests.length, 1);
        const callback = [...f.timers.values()][0];
        assert.ok(callback);
        const originalNow = f.clock.now;
        if (sample === 'throw') f.clock.now = () => { throw Error('private-clock-canary'); };
        else f.set(sample);
        assert.doesNotThrow(callback);
        assert.equal(aborts, 0);
        assert.equal(prompt.hasPending(), true);
        f.clock.now = originalNow;
        f.set(60000);
        callback();
        assert.equal(aborts, 0);
        assert.equal(prompt.hasPending(), true);
        // Only the explicit fake promise return below can settle this retained owner.
        settle({ response: 0, checkboxChecked: false });
        assert.deepEqual(await result, { status: 'cancelled' });
        assert.equal(prompt.hasPending(), false);
        assert.equal(f.requests.length, 1);
    }
});
test('S1 readiness rejection retains UNKNOWN without creating a prompt timer or another surface', async () => {
    const f = guiFixture();
    f.app.whenReady = async () => { throw Error('private-readiness-canary'); };
    const prompt = linuxGuiPrompt(f.app, f.dialog, true, f.clock);
    const result = await prompt.review({ detail: '', menu: false, deadlineMs: 120000 });
    assert.deepEqual(result, { status: 'unknown' });
    assert.equal(prompt.hasPending(), true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /canary/);
});
