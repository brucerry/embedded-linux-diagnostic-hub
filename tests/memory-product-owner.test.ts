import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
    productJob,
    ProductRunOwner,
    observeProductOwner,
    type ProductClock,
} from './fixtures/memory-product-owner';
import { syncCloseEvidence } from './fixtures/memory-resource-evidence';
import { parseFastPolicy } from './fixtures/memory-resource-policy';
import { collectionFixture } from './fixtures/memory-fast-test-input';

class Clock implements ProductClock {
    time = 0;
    sequence = 0;
    timers = new Map<number, { due: number; callback(): void }>();
    now = () => this.time;
    set = (callback: () => void, ms: number) => {
        const id = ++this.sequence;
        this.timers.set(id, { due: this.time + ms, callback });
        return id;
    };
    clear = (id: unknown) => {
        this.timers.delete(id as number);
    };
    async advance(until: number) {
        for (;;) {
            await flush();
            const next = [...this.timers]
                .filter(([, value]) => value.due <= until)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) break;
            this.time = next[1].due;
            this.timers.delete(next[0]);
            next[1].callback();
        }
        this.time = until;
        await flush();
    }
}
async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function fixture() {
    const clock = new Clock(),
        job = productJob(undefined, clock);
    const events = Object.assign(new EventEmitter(), {
        connected: true,
        exitCode: 0,
        disconnect() {
            this.connected = false;
        },
    });
    return { clock, job, events, owner: new ProductRunOwner(job, events, clock) };
}
test('product deadline identity is exact, shared and counts startup without extension', async () => {
    const f = fixture();
    await f.clock.advance(100000);
    assert.deepEqual(productJob(JSON.stringify(f.job), f.clock), f.job);
    for (const delta of [
        { reserveMs: 1000 },
        { budgetMs: 900000 },
        { deadlineMs: 2500001 },
        { nonce: 'foreign' },
        { extra: true },
    ])
        assert.throws(() => productJob(JSON.stringify({ ...f.job, ...delta }), f.clock));
    await f.clock.advance(2340000);
    assert.equal(f.owner.signal.aborted, true);
    assert.throws(() => f.owner.assertAdmissible());
    await f.owner.join();
    f.owner.finish(true);
    assert.equal(f.clock.timers.size, 0);
});
for (const event of ['SIGTERM', 'SIGINT', 'disconnect', 'message'])
    test(`cancellation at admission (${event}) cannot invoke work`, async () => {
        const f = fixture();
        f.events.emit(event, { kind: 'cancel-product-job', nonce: 'wrong', reason: 'foreign' });
        let admitted = 0;
        await assert.rejects(
            f.owner.run(async () => {
                admitted++;
            }),
        );
        assert.equal(admitted, 0);
        assert.equal(f.events.exitCode, 1);
        await f.owner.join();
        f.owner.finish(true);
        assert.equal(f.events.listenerCount('SIGTERM'), 0);
    });
test('factory cancellation retains startup until the returned adapter is disposed and descendants join', async () => {
    const f = fixture(),
        startup = deferred<any>(),
        descendant = deferred();
    let teardowns = 0;
    const start = f.owner.run(() => startup.promise);
    await flush();
    f.owner.cancel('cancel startup');
    assert.equal(f.owner.snapshot().pending, 1);
    assert.throws(() => f.owner.finish(true), /unjoined/);
    startup.resolve({
        teardown: async () => {
            teardowns++;
        },
        assertDescendantsExited: () => descendant.promise,
    });
    f.owner.bind(await start);
    let joined = false;
    const join = f.owner.join().then(() => {
        joined = true;
    });
    await flush();
    assert.equal(teardowns, 1);
    assert.equal(joined, false);
    assert.throws(() => f.owner.finish(true), /descendants/);
    descendant.resolve();
    await join;
    f.owner.finish(true);
});
test('async cycle and sampler settle through one concurrent teardown; no next cycle admitted', async () => {
    const f = fixture(),
        cycle = deferred(),
        sample = deferred(),
        cleanup = deferred();
    let teardownCalls = 0,
        descendantChecks = 0;
    f.owner.bind({
        teardown: async () => {
            teardownCalls++;
            cycle.reject(Error('real host closed'));
            sample.resolve();
            await cleanup.promise;
        },
        assertDescendantsExited: async () => {
            descendantChecks++;
        },
    });
    const work = f.owner.run(() => cycle.promise),
        sampling = f.owner.run(() => sample.promise);
    void work.catch(() => {});
    await flush();
    f.owner.cancel('stream evidence ceiling exceeded');
    f.owner.cancel('repeat cancellation');
    const joined = f.owner.join();
    await flush();
    assert.equal(teardownCalls, 1);
    assert.equal(descendantChecks, 0);
    await assert.rejects(f.owner.run(async () => {}));
    cleanup.resolve();
    await joined;
    await assert.rejects(work, /real host closed/);
    await sampling;
    assert.equal(descendantChecks, 1);
    f.owner.finish(true);
});
test('normal cleanup closes admission and successful durable join removes all handlers and timers', async () => {
    const f = fixture();
    let closes = 0;
    f.owner.bind({
        teardown: async () => {
            closes++;
        },
        assertDescendantsExited: async () => {},
    });
    await f.owner.run(async () => {});
    await f.owner.join();
    await assert.rejects(
        f.owner.run(async () => assert.fail('no admission during cleanup')),
        /cleanup already started/,
    );
    assert.equal(closes, 1);
    f.owner.finish(true);
    assert.equal(f.owner.snapshot().completed, true);
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.events.connected, false);
    assert.equal(f.events.eventNames().length, 0);
});
test('unknown startup, hung teardown and failed descendant join remain invalid, attached and held', async () => {
    for (const kind of ['startup', 'teardown', 'descendant']) {
        const f = fixture(),
            never = deferred();
        if (kind === 'startup') void f.owner.run(() => never.promise);
        else {
            f.owner.bind({
                teardown: async () => {
                    if (kind === 'teardown') await never.promise;
                },
                assertDescendantsExited: async () => {
                    if (kind === 'descendant') throw Error('history unknown');
                },
            });
            void f.owner.join().catch((error) => f.owner.hold(error));
        }
        await f.clock.advance(2400000);
        assert.equal(f.owner.snapshot().completed, false);
        assert.ok(f.owner.snapshot().invalid);
        assert.equal(f.events.listenerCount('SIGTERM'), 1);
        assert.equal(f.events.connected, true);
        assert.ok(f.clock.timers.size > 0);
        assert.throws(() => f.owner.finish(true));
    }
});
test('teardown rejection, evidence sync/close failure and late joins cannot certify success', async () => {
    const failed = fixture();
    failed.owner.bind({
        teardown: async () => {
            throw Error('teardown failed');
        },
        assertDescendantsExited: async () => assert.fail('not reached'),
    });
    await assert.rejects(failed.owner.join(), /teardown failed/);
    failed.owner.hold('failed cleanup');
    assert.throws(() => failed.owner.finish(true));
    const f = fixture();
    f.owner.bind({ teardown: async () => {}, assertDescendantsExited: async () => {} });
    await f.owner.join();
    assert.throws(() => f.owner.finish(false), /durably/);
    const calls: string[] = [];
    const errors = await syncCloseEvidence(
        [0, 1].map((id) => ({
            sync: async () => {
                calls.push('sync' + id);
                throw Error('injected fsync failure');
            },
            close: async () => {
                calls.push('close' + id);
            },
        })),
    );
    assert.equal(errors.length, 2);
    assert.deepEqual(calls.sort(), ['close0', 'close1', 'sync0', 'sync1']);
    f.owner.hold(errors[0]);
    await f.clock.advance(2400001);
    assert.throws(() => f.owner.finish(true), /INVALID/);
    assert.equal(f.events.connected, true);
});
function outer(connected = true) {
    const clock = new Clock(),
        job = productJob(undefined, clock),
        messages: any[] = [];
    const child = Object.assign(new EventEmitter(), {
        pid: 123,
        connected,
        kill: () => assert.fail('Owning product harness must never be killed.'),
        send: (message: unknown, callback: (error?: Error) => void) => {
            messages.push(message);
            callback();
        },
    });
    const watched = observeProductOwner(child, job, clock);
    child.emit('spawn');
    return { child, clock, job, watched, messages };
}
test('outer requires actual exit AND close, rather than exit-only inherited stream observation', async () => {
    const f = outer();
    let settled = false;
    void f.watched.outcome.then(() => {
        settled = true;
    });
    f.child.emit('exit', 0, null);
    await flush();
    assert.equal(settled, false);
    assert.equal(f.watched.snapshot().closeObserved, false);
    f.child.emit('close', 0, null);
    assert.equal((await f.watched.outcome).closeObserved, true);
});
test('outer deadline and missing IPC never fall back to killing the owning middle process', async () => {
    for (const connected of [true, false]) {
        const f = outer(connected);
        await f.clock.advance(2340000);
        if (connected) assert.equal(f.messages[0].nonce, f.job.nonce);
        else assert.equal(f.watched.snapshot().killErrors.length, 1);
        await f.clock.advance(2400000);
        const invalid = await f.watched.outcome;
        assert.equal(invalid.closeObserved, false);
        assert.equal(invalid.timedOut, true);
        f.child.emit('exit', 1, null);
        f.child.emit('close', 1, null);
        assert.equal(invalid.closeObserved, false);
        assert.equal(f.watched.snapshot().closeObserved, true);
    }
});
test('soak caller wires ownership before product factory and waits for direct close without an owner kill', async () => {
    const source = await fs.readFile('tests/fixtures/memory-resource-soak.ts', 'utf8');
    const child = source.slice(source.indexOf('async function runChild()'));
    assert.ok(child.indexOf('new ProductRunOwner') < child.indexOf('await main(owner)'));
    assert.match(child, /process.connected/);
    assert.match(source, /owner.run\(\(\) =>[\s\S]*?createQualificationDriver/);
    assert.match(source, /signal: owner.signal/);
    assert.match(source, /await owner.join\(\)/);
    assert.match(source, /syncCloseEvidence\(\[timeline\]\)/);
    const supervisor = source.slice(
        source.indexOf('async function supervise()'),
        source.indexOf('async function runChild()'),
    );
    assert.match(supervisor, /stdio: \[.*'ipc'\]/);
    assert.match(supervisor, /observeProductOwner/);
    assert.match(supervisor, /row.closeObserved/);
    assert.match(supervisor, /row.code !== row.closeCode/);
    assert.doesNotMatch(supervisor, /child.kill|once\('exit'|process.exit\(/);
    const native = await fs.readFile('tests/fixtures/memory-product-aggregate-native.ts', 'utf8');
    assert.match(native, /teardownTask \?\?= teardownOnce/);
    for (const name of ['memory-product-aggregate.ts', 'memory-product-aggregate-native.ts']) {
        const driver = await fs.readFile('tests/fixtures/' + name, 'utf8');
        assert.match(driver, /admit\(\);\n\s+host = await createProduct/);
        assert.match(driver, /signal: context.signal/);
        assert.match(driver, /workDeadlineMs: context.workDeadlineMs/);
        assert.match(driver, /admit\(\);\n\s+gateway = await createProductGateway/);
    }
});
test('Linux caller supplies the independent SHA and rejects absent, malformed or mismatched identity', async () => {
    const yaml = createRequire(import.meta.url)('js-yaml');
    const workflow = yaml.load(await fs.readFile('.github/workflows/linux-portable.yml', 'utf8'));
    const step = workflow.jobs.build.steps.find(
        (row: any) => row.name === 'Build isolated JS runtime and require reviewed memory policy',
    );
    assert.equal(step.env.HUB_MEMORY_POLICY_SHA256, '${{ vars.HUB_MEMORY_POLICY_SHA256 }}');
    assert.match(
        step.run,
        /--policy="\$HUB_MEMORY_POLICY" --policy-sha256="\$HUB_MEMORY_POLICY_SHA256"/,
    );
    assert.match(step.run, /-z "\$HUB_MEMORY_POLICY".*\|\|.*\^\[a-f0-9\]\{64\}\$/);
    assert.doesNotMatch(step.run, /sha256sum|shasum|Get-FileHash/);
    const f = collectionFixture();
    for (const digest of ['', 'x'.repeat(64), 'a'.repeat(64)])
        assert.throws(() => parseFastPolicy(f.json, digest, f.config));
    assert.equal(parseFastPolicy(f.json, f.policySHA256, f.config).policySHA256, f.policySHA256);
    assert.throws(() =>
        parseFastPolicy(f.json, f.policySHA256, { ...f.config, platform: 'linux' }),
    );
});
