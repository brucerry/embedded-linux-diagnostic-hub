import {
    startupIdentityDecoder,
    identityManifestStage,
    identityPartStage,
} from '../scripts/lib/startup-identity-report.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { ProcessSample } from './fixtures/memory-resource-verdict';
import { productJob, ProductRunOwner, type ProductClock } from './fixtures/memory-product-owner';
import {
    ProductShutdownObserver,
    shutdownHistory,
    rememberProcessRoles,
} from './fixtures/memory-product-shutdown';
import { productStartup } from './fixtures/memory-product-startup';
import { soakAssessmentConfig } from './fixtures/memory-resource-policy';
import { requirements } from './fixtures/memory-resource-verdict';
import { isolatedGateway } from './fixtures/memory-resource-gateway-process';

class Clock implements ProductClock {
    time = 0;
    next = 0;
    timers = new Map<number, { due: number; callback(): void }>();
    now = () => this.time;
    set = (callback: () => void, ms: number) => {
        const id = ++this.next;
        this.timers.set(id, { due: this.time + ms, callback });
        return id;
    };
    clear = (id: unknown) => {
        this.timers.delete(id as number);
    };
    async advance(time: number) {
        for (;;) {
            await flush();
            const row = [...this.timers]
                .filter(([, v]) => v.due <= time)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!row) break;
            this.time = row[1].due;
            this.timers.delete(row[0]);
            row[1].callback();
        }
        this.time = time;
        await flush();
    }
}
async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const row = (state: 'running' | 'terminated' = 'running', rss = 100): ProcessSample => ({
    pid: 42,
    created: 'actual-model-instance',
    role: 'renderer',
    state,
    rssBytes: state === 'running' ? rss : null,
    heapUsedBytes: null,
    externalBytes: null,
    arrayBuffersBytes: null,
    unsupported: ['OS allocation breakdown unavailable'],
});
function fixture() {
    const clock = new Clock(),
        events = Object.assign(new EventEmitter(), {
            connected: true,
            exitCode: 0,
            disconnect() {
                this.connected = false;
            },
        });
    return {
        clock,
        events,
        owner: new ProductRunOwner(productJob(undefined, clock), events, clock),
    };
}
test('OS observation spans store/window/server closure, joins the live sample before retirement and retains a shutdown peak/final terminated row', async () => {
    const f = fixture(),
        live = deferred(),
        close = deferred(),
        order: string[] = [],
        samples: any[] = [];
    let state: 'running' | 'terminated' = 'running',
        rss = 100,
        reads = 0;
    const observer = new ProductShutdownObserver(
        async () => {
            reads++;
            return [row(state, rss)];
        },
        (read) => f.owner.observe(read),
        async (_stage, value) => {
            samples.push(value);
        },
        () => {},
        f.clock,
    );
    const current = f.owner.run(() => live.promise);
    await flush();
    f.owner.bind(
        {
            teardown: async () => {
                order.push('store-window-server-close');
                await close.promise;
                state = 'terminated';
            },
            assertDescendantsExited: async () => {
                assert.equal(state, 'terminated');
                order.push('descendants-joined');
            },
        },
        async () => {
            observer.start();
            order.push('OS-observer-started');
            await current;
            order.push('live-sample-joined');
        },
    );
    const joined = f.owner.join();
    await flush();
    assert.deepEqual(order, ['OS-observer-started']);
    live.resolve();
    await flush();
    assert.deepEqual(order, [
        'OS-observer-started',
        'live-sample-joined',
        'store-window-server-close',
    ]);
    rss = 999;
    await f.clock.advance(250);
    assert.ok(
        samples.some((v) => v.phase === 'during-shutdown' && v.processes[0].rssBytes === 999),
    );
    close.resolve();
    await joined;
    await observer.finish();
    f.owner.closeObservations();
    assert.equal(samples.at(-1).phase, 'final-joined');
    assert.equal(samples.at(-1).processes[0].rssBytes, null);
    assert.equal(samples.at(-1).processes[0].state, 'terminated');
    assert.ok(reads >= 3);
    f.owner.finish(true);
    assert.equal(f.clock.timers.size, 0);
});
test('diagnostic observation remains allowed during cleanup reserve/cancellation, but work cannot restart and observation admission must close', async () => {
    const f = fixture();
    f.owner.bind({ teardown: async () => {}, assertDescendantsExited: async () => {} });
    await f.clock.advance(2340000);
    await assert.rejects(f.owner.run(async () => assert.fail('work after deadline')));
    assert.deepEqual(await f.owner.observe(async () => [row()]), [row()]);
    await f.owner.join();
    assert.throws(() => f.owner.finish(true), /observation admission remains open/);
    f.owner.closeObservations();
    await assert.rejects(
        f.owner.observe(async () => []),
        /admission is closed/,
    );
    f.owner.finish(true);
});
test('a held OS read is serialized and actual finish waits for it; missing final instances cannot become an empty success', async () => {
    const f = fixture(),
        held = deferred<ProcessSample[]>();
    let reads = 0,
        active = 0,
        peak = 0;
    const observer = new ProductShutdownObserver(
        async () => {
            reads++;
            active++;
            peak = Math.max(peak, active);
            try {
                return reads === 1 ? await held.promise : [];
            } finally {
                active--;
            }
        },
        (read) => f.owner.observe(read),
        async () => {},
        () => {},
        f.clock,
    );
    observer.start();
    await flush();
    await f.clock.advance(1000);
    assert.equal(reads, 1);
    let settled = false;
    const finish = observer.finish().finally(() => {
        settled = true;
    });
    void finish.catch(() => {});
    await flush();
    assert.equal(settled, false);
    held.resolve([row()]);
    await assert.rejects(finish, /Missing shutdown process history/);
    assert.equal(peak, 1);
    f.owner.hold('Observation incomplete.');
});
for (const kind of ['bad-identity', 'terminated-zero', 'read-failure', 'evidence-failure'] as const)
    test(
        'invalid or undurable shutdown sample stays failed without acceptance: ' + kind,
        async () => {
            const f = fixture();
            let accepted = 0,
                writes = 0;
            const observer = new ProductShutdownObserver(
                async () => {
                    if (kind === 'read-failure') throw Error('OS observation denied');
                    return [
                        kind === 'bad-identity'
                            ? { ...row(), created: '' }
                            : kind === 'terminated-zero'
                              ? { ...row('terminated'), rssBytes: 0 }
                              : row(),
                    ];
                },
                (read) => f.owner.observe(read),
                async () => {
                    writes++;
                    if (kind === 'evidence-failure') throw Error('journal failed');
                },
                () => {
                    accepted++;
                },
                f.clock,
            );
            observer.start();
            await flush();
            await assert.rejects(observer.finish());
            if (kind !== 'evidence-failure') {
                assert.equal(accepted, 0);
                assert.equal(writes, 0);
            }
            f.owner.hold('Shutdown observation failed.');
            assert.equal(f.events.connected, true);
            assert.throws(() => f.owner.finish(true));
        },
    );
test('late observation is rejected before acceptance and the original total deadline cannot be extended', async () => {
    const f = fixture(),
        held = deferred<ProcessSample[]>();
    let accepted = 0;
    const observer = new ProductShutdownObserver(
        () => held.promise,
        (read) => f.owner.observe(read),
        async () => {},
        () => {
            accepted++;
        },
        f.clock,
    );
    observer.start();
    await flush();
    await f.clock.advance(2400000);
    held.resolve([row('terminated')]);
    await flush();
    await assert.rejects(observer.finish(), /after total deadline/);
    assert.equal(accepted, 0);
    assert.ok(f.owner.snapshot().invalid);
    assert.equal(f.events.connected, true);
});
test('final history must retain every observed instance and every descendant must actually be terminated', async () => {
    for (const kind of ['missing', 'live']) {
        const f = fixture();
        let reads = 0;
        const observer = new ProductShutdownObserver(
            async () =>
                ++reads === 1
                    ? [row()]
                    : kind === 'missing'
                      ? [{ ...row('terminated'), pid: 99 }]
                      : [row()],
            (read) => f.owner.observe(read),
            async () => {},
            () => {},
            f.clock,
        );
        observer.start();
        await flush();
        await assert.rejects(
            observer.finish(),
            kind === 'missing' ? /omitted an owned process/ : /remains live/,
        );
        f.owner.hold('No final closed history.');
    }
});
test('observation handoff failure still attempts actual teardown and cannot bypass the failed receipt', async () => {
    const f = fixture();
    let attempts = 0;
    f.owner.bind(
        {
            teardown: async () => {
                attempts++;
            },
            assertDescendantsExited: async () => {},
        },
        async () => {
            throw Error('handoff refused');
        },
    );
    await assert.rejects(f.owner.join());
    assert.equal(attempts, 1);
    f.owner.hold('Handoff unverified.');
    assert.throws(() => f.owner.finish(true));
});
test('OS history keeps PID/creation-bound roles, strips unavailable allocation fields and never invents zero on exit', () => {
    const known = new Map<string, string>();
    rememberProcessRoles([row()], known);
    const mapped = shutdownHistory([{ ...row('terminated'), role: 'owned-descendant' }], known);
    assert.throws(
        () => shutdownHistory([{ ...row('terminated'), heapUsedBytes: 1 }], known),
        /Invalid heapUsedBytes/,
    );
    assert.equal(mapped[0].role, 'renderer');
    assert.equal(mapped[0].rssBytes, null);
    assert.equal(mapped[0].heapUsedBytes, null);
    assert.match(mapped[0].unsupported.join(' '), /diagnostic RSS/);
    assert.equal(
        shutdownHistory([{ ...row(), created: 'replacement', role: 'owned-descendant' }], known)[0]
            .role,
        'owned-descendant',
    );
});
test('expired startup rejects before admission and cancellation state survives a held stage', () => {
    assert.throws(() => productStartup({ workDeadlineMs: 0 })(), /work deadline exhausted/);
    const controller = new AbortController(),
        admit = productStartup({ signal: controller.signal });
    admit();
    controller.abort(Error('cancelled during awaited build'));
    assert.throws(admit, /cancelled during awaited build/);
});
test('gateway cancellation during startup history prevents init and second fork, while retained first child joins', async () => {
    const controller = new AbortController(),
        held = deferred(),
        entered = deferred();
    let forks = 0,
        init = 0,
        alive = true,
        heldOnce = false;
    const decoder = startupIdentityDecoder();
    const pending = isolatedGateway(
        'http://127.0.0.1:5173',
        'normal',
        async (stage, data) => {
            if (stage === identityManifestStage || stage === identityPartStage) {
                const value = decoder.accept(stage, data);
                if (!value) return;
                stage = value.stage;
            } else decoder.assertComplete();
            if (stage === 'gateway-process-history' && !heldOnce) {
                heldOnce = true;
                entered.resolve();
                await held.promise;
            }
        },
        {
            signal: controller.signal,
            forkChild: (() => {
                forks++;
                const child: any = Object.assign(new EventEmitter(), { pid: 42, connected: true });
                child.send = (message: any, callback?: (error?: Error) => void) => {
                    if (message.action === 'init') init++;
                    callback?.();
                    return true;
                };
                child.kill = () => {
                    alive = false;
                    queueMicrotask(() => {
                        child.emit('exit', 0, null);
                        child.emit('close', 0, null);
                    });
                    return true;
                };
                return child;
            }) as any,
            makeSampler: () => ({
                sample: async () => [
                    {
                        ...row(alive ? 'running' : 'terminated'),
                        role: 'fixture-root',
                        heapUsedBytes: null as null,
                        externalBytes: null as null,
                        arrayBuffersBytes: null as null,
                    },
                ],
                assertExited: async () => {
                    assert.equal(alive, false);
                },
            }),
        },
    );
    await entered.promise;
    controller.abort(Error('cancelled before host init'));
    held.resolve();
    await assert.rejects(pending, /cancelled before host init/);
    assert.equal(forks, 1);
    assert.equal(init, 0);
    assert.equal(alive, false);
});
test('actual harness wiring hands observation over before cleanup, final-samples after joins and closes admission before durable finish', async () => {
    const source = await fs.readFile('tests/fixtures/memory-resource-soak.ts', 'utf8');
    const bind = source.slice(
        source.indexOf('owner.bind(driver,'),
        source.indexOf('    } catch (error)', source.indexOf('owner.bind(driver,')),
    );
    assert.ok(bind.indexOf('shutdown.start()') < bind.indexOf('stop = true'));
    assert.match(bind, /await sampling;[\s\S]*await inFlight;/);
    assert.ok(
        bind.indexOf('shutdown.start()') < bind.indexOf('await localEvidence.enterCleanup()'),
    );
    const final = source.slice(source.indexOf('    } finally {\n        let ownershipJoined'));
    assert.ok(final.indexOf('await owner.join()') < final.indexOf('await shutdown.finish()'));
    assert.ok(
        final.indexOf('await shutdown.finish()') < final.indexOf('owner.closeObservations()'),
    );
    assert.ok(
        final.indexOf('owner.closeObservations()') <
            final.indexOf('await finishObservationTimeline(localEvidence, owner)'),
    );
    assert.doesNotMatch(final.slice(0, final.indexOf('await owner.join()')), /stop = true/);
    assert.match(source, /workDeadlineMs: owner.job.deadlineMs - owner.job.reserveMs/);
});

test('assessment identity declares unchanged ownership deadline and mandatory shutdown diagnostics in both observer modes', () => {
    for (const observer of ['250ms', 'disabled']) {
        const config = soakAssessmentConfig({
            lane: 'browser',
            gcMode: 'normal',
            observer,
            viewer: false,
            component: false,
            requirements: requirements(false, [], false),
        });
        assert.deepEqual(config.ownership, {
            protocol: 'cancel-product-job/v1',
            budgetMs: 2400000,
            cleanupReserveMs: 60000,
        });
        assert.deepEqual(config.shutdownObserver, {
            cadenceMs: 250,
            scope: 'owned-pid-creation-os-rss-history',
            finalJoinedSample: true,
            forceGc: false,
            retainedInNoSamplerControl: true,
        });
        assert.equal(config.warmupMs, 300000);
        assert.equal(config.measuredMs, 1500000);
        assert.equal(config.minCycles, 100);
    }
});
