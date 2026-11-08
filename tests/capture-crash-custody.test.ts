import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ownFixtureChild } from './fixtures/owned-fixture-child';

class Pipe extends EventEmitter {
    resume() {
        return this;
    }
}
class Child extends EventEmitter {
    stdout = new Pipe();
    stderr = new Pipe();
    signals: string[] = [];
    refusal = false;
    thrown?: Error;
    kill(signal: 'SIGKILL') {
        this.signals.push(signal);
        if (this.thrown) throw this.thrown;
        return !this.refusal;
    }
}
function fixture() {
    const child = new Child();
    let timer: (() => void) | undefined;
    let cleared = 0;
    const owner = ownFixtureChild(() => child, {
        timeoutMs: 15000,
        clock: {
            set(run) {
                timer = run;
                return 1;
            },
            clear() {
                cleared++;
            },
        },
    });
    let retired = false,
        completed = false;
    void owner.retired.then(() => {
        retired = true;
    });
    void owner.done.then(
        () => {
            completed = true;
        },
        () => {
            completed = true;
        },
    );
    return {
        child,
        owner,
        fire: () => timer!(),
        cleared: () => cleared,
        state: () => ({ retired, completed }),
    };
}
async function turns() {
    for (let n = 0; n < 8; n++) await Promise.resolve();
}
function close(
    f: ReturnType<typeof fixture>,
    code: number | null = null,
    signal: string | null = 'SIGKILL',
) {
    f.child.emit('exit', code, signal);
    f.child.stdout.emit('end');
    f.child.stderr.emit('end');
    f.child.stdout.emit('close');
    f.child.stderr.emit('close');
    f.child.emit('close', code, signal);
}

test('a gate and accepted signal do not release custody before exit, both EOFs and closes', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.stdout.emit('data', Buffer.from('{"gate":'));
    f.child.stdout.emit('data', Buffer.from('true}\n'));
    assert.equal(await f.owner.firstLine, '{"gate":true}');
    f.owner.stop();
    f.owner.stop();
    assert.deepEqual(f.child.signals, ['SIGKILL']);
    await turns();
    assert.deepEqual(f.state(), { retired: false, completed: false });
    f.child.emit('exit', null, 'SIGKILL');
    f.child.stdout.emit('end');
    f.child.stdout.emit('close');
    f.child.emit('close', null, 'SIGKILL');
    await turns();
    assert.deepEqual(f.state(), { retired: false, completed: false });
    f.child.stderr.emit('end');
    await turns();
    assert.equal(f.state().retired, false);
    f.child.stderr.emit('close');
    const done = await f.owner.done;
    await f.owner.retired;
    assert.equal(done.retired, true);
    assert.equal(done.stdoutEOF, true);
    assert.equal(done.stderrEOF, true);
    assert.equal(f.cleared(), 1);
});
test('exit and pipe EOFs still require the ChildProcess close acknowledgement', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.emit('exit', 0, null);
    f.child.stdout.emit('end');
    f.child.stderr.emit('end');
    f.child.stdout.emit('close');
    f.child.stderr.emit('close');
    await turns();
    assert.equal(f.state().retired, false);
    f.child.emit('close', 0, null);
    assert.equal((await f.owner.done).code, 0);
});
test('a missing exit acknowledgement holds custody even after close notifications', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.stdout.emit('end');
    f.child.stderr.emit('end');
    f.child.stdout.emit('close');
    f.child.stderr.emit('close');
    f.child.emit('close', 0, null);
    await turns();
    assert.equal(f.state().retired, false);
    f.child.emit('exit', 0, null);
    await f.owner.done;
});
test('spawn failure joins pipe closes without requiring an impossible exit or sending a signal', async () => {
    const f = fixture();
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.child.emit('error', Error('ENOENT synthetic'));
    f.child.emit('close', -2, null);
    f.child.stdout.emit('close');
    await turns();
    assert.equal(f.state().retired, false);
    f.child.stderr.emit('close');
    await f.owner.retired;
    await failure;
    assert.deepEqual(f.child.signals, []);
    assert.equal(f.cleared(), 1);
});
test('deadline before spawn queues only one owned stop and holds until retirement', async () => {
    const f = fixture();
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.fire();
    assert.deepEqual(f.child.signals, []);
    f.child.emit('spawn');
    f.owner.stop();
    f.fire();
    assert.deepEqual(f.child.signals, ['SIGKILL']);
    await turns();
    assert.equal(f.state().retired, false);
    close(f);
    await failure;
    await f.owner.retired;
});
test('refused stop is a failure, never acknowledgement or an automatic retry', async () => {
    const f = fixture();
    f.child.refusal = true;
    f.child.emit('spawn');
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.owner.stop();
    f.owner.stop();
    await turns();
    assert.equal(f.state().retired, false);
    assert.deepEqual(f.child.signals, ['SIGKILL']);
    close(f, 0, null);
    await failure;
});
test('a thrown stop retains custody and its original failure until actual closure', async () => {
    const f = fixture(),
        reason = Error('Synthetic kill error');
    f.child.thrown = reason;
    f.child.emit('spawn');
    const failure = assert.rejects(
        f.owner.done,
        (error: unknown) => error instanceof AggregateError && error.errors.includes(reason),
    );
    f.owner.stop();
    await turns();
    assert.equal(f.state().retired, false);
    close(f, 0, null);
    await failure;
    assert.deepEqual(f.child.signals, ['SIGKILL']);
});
for (const stream of ['stdout', 'stderr'] as const)
    test(`${stream} overflow fails and requests one stop`, async () => {
        const f = fixture();
        f.child.emit('spawn');
        const failure = assert.rejects(f.owner.done, AggregateError);
        f.child[stream].emit('data', Buffer.alloc(stream === 'stdout' ? 65537 : 16385));
        f.owner.stop();
        assert.deepEqual(f.child.signals, ['SIGKILL']);
        close(f);
        await failure;
    });
test('later overflow fails even after the first gate was already delivered', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.stdout.emit('data', Buffer.from('{}\n'));
    assert.equal(await f.owner.firstLine, '{}');
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.child.stdout.emit('data', Buffer.alloc(65536));
    close(f);
    await failure;
});
test('pipe errors retire only after all physical closure observations', async () => {
    const f = fixture();
    f.child.emit('spawn');
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.child.stderr.emit('error', Error('Synthetic pipe error'));
    await turns();
    assert.equal(f.state().retired, false);
    close(f);
    await failure;
});
test('started child with missing EOF fails after physical retirement instead of passing', async () => {
    const f = fixture();
    f.child.emit('spawn');
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.child.emit('exit', 0, null);
    f.child.stdout.emit('close');
    f.child.stderr.emit('close');
    f.child.emit('close', 0, null);
    await f.owner.retired;
    await failure;
});
test('natural exit before gate rejects the gate without inventing a crash signal', async () => {
    const f = fixture();
    f.child.emit('spawn');
    const gate = assert.rejects(f.owner.firstLine, /before its gate/);
    close(f, 0, null);
    await gate;
    await f.owner.done;
    assert.deepEqual(f.child.signals, []);
});
test('stop after exit only drains and never sends a late signal', async () => {
    const f = fixture();
    f.child.emit('spawn');
    f.child.emit('exit', 0, null);
    f.owner.stop();
    assert.deepEqual(f.child.signals, []);
    f.child.stdout.emit('end');
    f.child.stderr.emit('end');
    f.child.stdout.emit('close');
    f.child.stderr.emit('close');
    f.child.emit('close', 0, null);
    await f.owner.done;
});
test('exit/close disagreement remains a joined failure', async () => {
    const f = fixture();
    f.child.emit('spawn');
    const failure = assert.rejects(f.owner.done, AggregateError);
    f.child.emit('exit', 0, null);
    f.child.stdout.emit('end');
    f.child.stderr.emit('end');
    f.child.stdout.emit('close');
    f.child.stderr.emit('close');
    f.child.emit('close', 1, null);
    await failure;
});
test('cleanup removes only its listeners and never signals again after retirement', async () => {
    const f = fixture(),
        unrelated = () => {};
    f.child.on('close', unrelated);
    f.child.stdout.on('data', unrelated);
    f.child.emit('spawn');
    close(f, 0, null);
    await f.owner.done;
    assert.deepEqual(f.child.listeners('close'), [unrelated]);
    assert.deepEqual(f.child.stdout.listeners('data'), [unrelated]);
    f.owner.stop();
    f.fire();
    assert.deepEqual(f.child.signals, []);
});
test('synchronous spawn failure clears the already-owned deadline', () => {
    let clears = 0;
    const reason = Error('Synthetic spawn throw');
    assert.throws(
        () =>
            ownFixtureChild(
                () => {
                    throw reason;
                },
                {
                    timeoutMs: 1,
                    clock: {
                        set: () => 1,
                        clear: () => {
                            clears++;
                        },
                    },
                },
            ),
        (error: unknown) => error === reason,
    );
    assert.equal(clears, 1);
});
test('deadline allocation failure acquires no child', () => {
    let starts = 0;
    assert.throws(
        () =>
            ownFixtureChild(
                () => {
                    starts++;
                    return new Child();
                },
                {
                    timeoutMs: 1,
                    clock: {
                        set() {
                            throw Error('Synthetic allocation failure');
                        },
                        clear() {},
                    },
                },
            ),
        /allocation failure/,
    );
    assert.equal(starts, 0);
});
test('unsupported deadline fails before child acquisition', () => {
    let starts = 0;
    assert.throws(() =>
        ownFixtureChild(
            () => {
                starts++;
                return new Child();
            },
            { timeoutMs: 30001 },
        ),
    );
    assert.equal(starts, 0);
});
