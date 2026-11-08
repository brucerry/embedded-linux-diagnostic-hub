import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ProductInspection,
    inspectionObserverNames,
    type InspectionNativeStop,
    type InspectionObserver,
    type InspectionObserverName,
    type InspectionRebind,
} from './fixtures/memory-product-inspection';
import type { AggregateDiagnosticClock } from './fixtures/memory-product-aggregate-diagnostics';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
const stop: InspectionNativeStop = {
    releaseAt: 1,
    deadline: 10001,
    cutoffOrdinal: 4,
    nativeStop: {
        eventOrdinal: 5,
        observedAt: 2,
        version: {
            versionId: 'version',
            registrationId: 'registration',
            scriptURL: 'http://fixture/worker.js',
            status: 'redundant',
            runningStatus: 'stopped',
            controlledClients: [],
        },
    },
    nativeStopLatencyMilliseconds: 1,
    releaseJoinMilliseconds: 2,
};
function fixture(clock?: AggregateDiagnosticClock, count: number = inspectionObserverNames.length) {
    const identity = {
        nativePageId: 'page',
        nativeContextId: 'context',
        browserProduct: 'fixture-browser',
        root: { pid: 123, created: 'creation-identity' },
    };
    let current = { wrapper: 1 };
    const next = { wrapper: 2 };
    const calls: string[] = [];
    const hooks = new Map<InspectionObserverName, InspectionObserver<typeof current>>();
    const ports = {
        identity,
        currentPage: () => current,
        async disconnect() {
            calls.push('disconnect');
        },
        async reconnect() {
            calls.push('reconnect');
            return { page: next, ...identity, root: { ...identity.root } };
        },
        async verifyCurrentIdentity(_binding: InspectionRebind<typeof current>) {
            calls.push('verify-identity');
        },
        async commitBinding(binding: InspectionRebind<typeof current>) {
            calls.push('commit');
            current = binding.page;
        },
        async emit(stage: string, _data: unknown) {
            calls.push('emit/' + stage);
        },
    };
    const inspection = new ProductInspection(ports, clock);
    for (const name of inspectionObserverNames.slice(0, count)) {
        let bound = current,
            generation = 1,
            released = false;
        const observer = {
            async release() {
                calls.push('release/' + name);
                released = true;
            },
            assertReleased() {
                assert.equal(released, true);
            },
            async bind(page: typeof current, value: number) {
                calls.push('bind/' + name);
                bound = page;
                generation = value;
                released = false;
            },
            assertBound(page: typeof current, value: number) {
                assert.equal(released, false);
                assert.equal(bound, page);
                assert.equal(generation, value);
            },
        };
        hooks.set(name, observer);
        inspection.register(name, observer);
    }
    const input = {
        async observeRelease(disconnect: () => Promise<void>, join: () => Promise<void>) {
            calls.push('observe-release');
            await disconnect();
            await join();
            return stop;
        },
        async joinWorkerClose() {
            calls.push('worker-close');
        },
        async acknowledgeNativeStop() {
            calls.push('ack-stop');
        },
    };
    return { inspection, ports, hooks, input, calls, identity };
}

test('two retirements preserve all five bindings, counter history and evidence ordering', async () => {
    const f = fixture();
    for (const generation of [2, 3]) {
        assert.equal(await f.inspection.retire(f.input), stop);
        f.inspection.assertReady();
        f.inspection.assertJoined();
        const snapshot = f.inspection.snapshot();
        assert.equal(snapshot.generation, generation);
        assert.equal(snapshot.observers.length, 5);
        assert.ok(
            snapshot.observers.every(
                (row) => row.state === 'bound' && row.generation === generation,
            ),
        );
        assert.equal(await f.inspection.use('next-cycle', async () => generation), generation);
    }
    assert.equal(f.calls.filter((x) => x === 'ack-stop').length, 2);
    assert.ok(f.calls.indexOf('ack-stop') < f.calls.indexOf('reconnect'));
    assert.ok(f.calls.indexOf('commit') < f.calls.indexOf('emit/inspection-ready-generation'));
});

test('incomplete observer registration cannot admit product work', async () => {
    const f = fixture(undefined, 4);
    let called = false;
    await assert.rejects(
        f.inspection.use('missing', async () => {
            called = true;
        }),
        /Every actual/,
    );
    assert.equal(called, false);
});

test('binding validation cannot reenter admission before retirement closes it', async () => {
    const f = fixture();
    const hook = f.hooks.get('host-events')!;
    const original = hook.assertBound.bind(hook);
    let reentry: Promise<void> | undefined,
        ran = false;
    hook.assertBound = (page, generation) => {
        original(page, generation);
        if (generation === 1 && !reentry) {
            reentry = f.inspection.use('reentry', async () => {
                ran = true;
            });
            void reentry.catch(() => {});
        }
    };
    await f.inspection.retire(f.input);
    assert.ok(reentry);
    await assert.rejects(reentry, /not ready|validation/);
    assert.equal(ran, false);
});

test('closing admission during reconnect cannot reopen the coordinator', async () => {
    const f = fixture();
    const entered = deferred(),
        gate = deferred();
    const reconnect = f.ports.reconnect;
    f.ports.reconnect = async () => {
        entered.resolve();
        await gate.promise;
        return reconnect();
    };
    const pending = f.inspection.retire(f.input);
    await entered.promise;
    f.inspection.closeAdmission();
    gate.resolve();
    await assert.rejects(pending, /closing|admission changed/);
    assert.equal(f.inspection.snapshot().phase, 'closing');
    assert.equal(f.inspection.snapshot().generation, 1);
    assert.equal(
        f.calls.some((x) => x.startsWith('bind/')),
        false,
    );
    f.inspection.acknowledgeClosed();
    assert.equal(f.inspection.snapshot().phase, 'closed');
});

test('closing admission in the ready evidence callback cannot publish a generation', async () => {
    const f = fixture();
    const emit = f.ports.emit;
    f.ports.emit = async (stage, data) => {
        await emit(stage, data);
        if (stage === 'inspection-ready-generation') f.inspection.closeAdmission();
    };
    await assert.rejects(f.inspection.retire(f.input), /closing|admission changed/);
    assert.equal(f.inspection.snapshot().phase, 'closing');
    assert.equal(f.inspection.snapshot().generation, 1);
});

test('caller mutation cannot replace the original native identity anchor', async () => {
    const f = fixture();
    const reconnect = f.ports.reconnect;
    f.ports.reconnect = async () => {
        f.identity.root.pid = 999;
        f.identity.root.created = 'substitute';
        return reconnect();
    };
    await assert.rejects(f.inspection.retire(f.input), /identity changed/);
    assert.equal(
        f.calls.some((x) => x.startsWith('bind/')),
        false,
    );
});

test('live native identity is verified before any observer binds', async () => {
    const f = fixture();
    const failure = Error('Live root identity unavailable.');
    f.ports.verifyCurrentIdentity = async () => {
        throw failure;
    };
    await assert.rejects(f.inspection.retire(f.input), (error) => error === failure);
    assert.equal(
        f.calls.some((x) => x.startsWith('bind/')),
        false,
    );
});

for (const field of [
    'nativePageId',
    'nativeContextId',
    'browserProduct',
    'pid',
    'created',
] as const) {
    test(`substituted native ${field} prevents every rebind`, async () => {
        const f = fixture(),
            reconnect = f.ports.reconnect;
        f.ports.reconnect = async () => {
            const binding = await reconnect();
            if (field === 'pid') binding.root.pid++;
            else if (field === 'created') binding.root.created += '/substituted';
            else binding[field] += '/substituted';
            return binding;
        };
        await assert.rejects(f.inspection.retire(f.input), /identity changed/);
        assert.equal(
            f.calls.some((x) => x.startsWith('bind/')),
            false,
        );
        assert.equal(f.inspection.snapshot().generation, 1);
    });
}

test('validation during admission and registration cannot recursively admit work', async () => {
    const f = fixture(undefined, 4);
    let registrationReentry: Promise<void> | undefined, admissionReentry: Promise<void> | undefined;
    let validatingAdmission = false;
    const hooks: InspectionObserver<{ wrapper: number }> = {
        async release() {},
        assertReleased() {},
        async bind() {},
        assertBound() {
            const pending = f.inspection.use('recursive', async () =>
                assert.fail('Reentered work.'),
            );
            void pending.catch(() => {});
            if (validatingAdmission) admissionReentry = pending;
            else registrationReentry = pending;
        },
    };
    f.inspection.register('aggregate-export', hooks);
    await assert.rejects(registrationReentry!, /validation/);
    validatingAdmission = true;
    await f.inspection.use('ordinary', async () => {});
    await assert.rejects(admissionReentry!, /validation/);
});

test('partial reconnect failure leaves admission closed and does not invent cleanup', async () => {
    const f = fixture(),
        retained = { partial: undefined as object | undefined };
    const failure = Error('Identity validation after Browser return failed.');
    f.ports.reconnect = async () => {
        retained.partial = {};
        throw failure;
    };
    await assert.rejects(f.inspection.retire(f.input), (error) => error === failure);
    assert.ok(retained.partial, 'Actual host must retain its partial wrapper for cleanup.');
    assert.equal(f.inspection.snapshot().phase, 'failed');
    assert.equal(
        f.calls.some((x) => x.startsWith('bind/')),
        false,
    );
    assert.equal(f.calls.includes('commit'), false);
    // The actual host/accessor ownership and cleanup join still require real integration.
});

test('ready generation remains unpublished until evidence has actually settled', async () => {
    const f = fixture(),
        entered = deferred(),
        gate = deferred(),
        emit = f.ports.emit;
    f.ports.emit = async (stage, data) => {
        await emit(stage, data);
        if (stage === 'inspection-ready-generation') {
            entered.resolve();
            await gate.promise;
        }
    };
    const pending = f.inspection.retire(f.input);
    await entered.promise;
    assert.equal(f.inspection.snapshot().phase, 'binding');
    assert.equal(f.inspection.snapshot().generation, 1);
    assert.throws(() => f.inspection.assertJoined(), /unjoined|not actually settled/);
    await assert.rejects(
        f.inspection.use('before-ack', async () => {}),
        /not ready/,
    );
    gate.resolve();
    await pending;
    assert.equal(f.inspection.snapshot().generation, 2);
});

test('missing and duplicate observer groups fail closed', async () => {
    const f = fixture(undefined, 4);
    assert.throws(
        () => f.inspection.register('host-events', f.hooks.get('host-events')!),
        /Duplicate/,
    );
    await assert.rejects(
        Promise.resolve().then(() => f.inspection.retire(f.input)),
        /Every actual/,
    );
    assert.equal(f.calls.includes('disconnect'), false);
});

test('active work and concurrent transitions prevent retirement and admission', async () => {
    const f = fixture();
    const gate = deferred();
    const work = f.inspection.use('busy', () => gate.promise);
    assert.throws(() => f.inspection.retire(f.input), /unjoined/);
    gate.resolve();
    await work;
    const pending = f.inspection.retire(f.input);
    assert.throws(() => f.inspection.retire(f.input), /not ready|already owns/);
    await assert.rejects(
        f.inspection.use('concurrent', async () => {}),
        /not ready/,
    );
    await pending;
});

for (const name of inspectionObserverNames) {
    for (const stage of ['release', 'bind'] as const) {
        test(`${name} ${stage} failure blocks ready and preserves group state`, async () => {
            const f = fixture();
            const failure = Error(name + '/' + stage);
            f.hooks.get(name)![stage] = async () => {
                throw failure;
            };
            await assert.rejects(f.inspection.retire(f.input), (error) => error === failure);
            assert.equal(f.inspection.snapshot().phase, 'failed');
            assert.equal(f.inspection.snapshot().generation, 1);
            assert.equal(
                f.inspection.snapshot().observers.find((x) => x.name === name)!.state,
                stage === 'release' ? 'releasing' : 'binding',
            );
            assert.equal(f.calls.includes('emit/inspection-ready-generation'), false);
            if (stage === 'release') assert.equal(f.calls.includes('disconnect'), false);
            await assert.rejects(
                f.inspection.use('after-failure', async () => {}),
                /not ready/,
            );
            f.inspection.assertJoined();
        });
    }
    for (const assertion of ['assertReleased', 'assertBound'] as const) {
        test(`${name} ${assertion} refuses an owner that has not settled`, async () => {
            const f = fixture(),
                failure = Error('Live observer owner: ' + name);
            const hook = f.hooks.get(name)!;
            if (assertion === 'assertReleased')
                hook.assertReleased = () => {
                    throw failure;
                };
            else {
                const bound = hook.assertBound.bind(hook);
                hook.assertBound = (page, generation) => {
                    if (generation === 2) throw failure;
                    bound(page, generation);
                };
            }
            await assert.rejects(f.inspection.retire(f.input), (error) => error === failure);
            assert.equal(f.inspection.snapshot().phase, 'failed');
            assert.equal(f.inspection.snapshot().generation, 1);
            assert.equal(f.calls.includes('emit/inspection-ready-generation'), false);
        });
    }
    for (const stage of ['release', 'bind'] as const) {
        test(`closing from ${name} ${stage} cannot continue the transition`, async () => {
            const f = fixture(),
                hook = f.hooks.get(name)!;
            if (stage === 'release') hook.release = async () => f.inspection.closeAdmission();
            else hook.bind = async () => f.inspection.closeAdmission();
            await assert.rejects(f.inspection.retire(f.input), /closing|admission changed/);
            assert.equal(f.inspection.snapshot().phase, 'closing');
            assert.equal(f.inspection.snapshot().generation, 1);
            assert.equal(f.calls.includes('commit'), false);
            if (stage === 'release') assert.equal(f.calls.includes('disconnect'), false);
        });
    }
}

for (const stage of ['ack-stop', 'commit', 'ready-evidence']) {
    test(`${stage} rejection never publishes ready`, async () => {
        const f = fixture(),
            failure = Error(stage);
        if (stage === 'ack-stop')
            f.input.acknowledgeNativeStop = async () => {
                throw failure;
            };
        if (stage === 'commit')
            f.ports.commitBinding = async () => {
                throw failure;
            };
        if (stage === 'ready-evidence') {
            const emit = f.ports.emit;
            f.ports.emit = async (name, data) => {
                if (name === 'inspection-ready-generation') throw failure;
                await emit(name, data);
            };
        }
        await assert.rejects(f.inspection.retire(f.input));
        assert.equal(f.inspection.snapshot().phase, 'failed');
        assert.equal(f.inspection.snapshot().generation, 1);
        assert.throws(() => f.inspection.assertReady(), /not ready/);
        if (stage === 'ack-stop') assert.equal(f.calls.includes('reconnect'), false);
    });
}

test('a deadline retains the actual release owner until its late settlement', async () => {
    const timers = new Map<object, () => void>();
    const clock: AggregateDiagnosticClock = {
        set(callback, milliseconds) {
            assert.equal(milliseconds, 10000);
            const handle = {};
            timers.set(handle, callback);
            return handle;
        },
        clear(handle) {
            timers.delete(handle as object);
        },
    };
    const f = fixture(clock),
        entered = deferred(),
        gate = deferred();
    f.hooks.get('host-events')!.release = async () => {
        entered.resolve();
        await gate.promise;
    };
    const pending = f.inspection.retire(f.input);
    await entered.promise;
    for (const callback of [...timers.values()]) callback();
    await assert.rejects(pending, /10000 ms/);
    assert.equal(f.inspection.snapshot().transitionCalls.length > 0, true);
    assert.throws(() => f.inspection.assertJoined(), /unjoined/);
    f.inspection.closeAdmission();
    gate.resolve();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    f.inspection.assertJoined();
    assert.equal(f.calls.includes('disconnect'), false);
    f.inspection.acknowledgeClosed();
});

for (const phase of [
    'acknowledge-native-stop',
    'verify-reconnected-identity-before-bind',
    'acknowledge-ready-generation',
]) {
    for (const depth of [1, 2, 3, 4, 5, 6, 7, 8]) {
        test(`closure at ${phase} continuation ${depth} cannot advance the generation`, async () => {
            const f = fixture(),
                emit = f.ports.emit;
            let closedGeneration: number | undefined;
            f.ports.emit = async (stage, data) => {
                await emit(stage, data);
                const row = data as { phase?: string; state?: string };
                if (
                    stage === 'inspection-transition-call' &&
                    row.phase === phase &&
                    row.state === 'settled'
                ) {
                    const after = (remaining: number) =>
                        queueMicrotask(() => {
                            if (remaining > 1) after(remaining - 1);
                            else {
                                closedGeneration = f.inspection.snapshot().generation;
                                f.inspection.closeAdmission();
                            }
                        });
                    after(depth);
                }
            };
            const inspection = new ProductInspection(f.ports);
            for (const name of inspectionObserverNames)
                inspection.register(name, f.hooks.get(name)!);
            f.inspection = inspection;
            await inspection.retire(f.input).catch(() => {});
            for (let n = 0; n < 30; n++) await Promise.resolve();
            assert.notEqual(closedGeneration, undefined);
            assert.equal(inspection.snapshot().phase, 'closing');
            assert.equal(inspection.snapshot().generation, closedGeneration);
            await assert.rejects(
                inspection.use('after-closure', async () => {}),
                /not ready/,
            );
            inspection.assertJoined();
        });
    }
}

for (const field of [
    'page',
    'nativePageId',
    'nativeContextId',
    'browserProduct',
    'pid',
    'created',
] as const) {
    test(`retained reconnect ${field} mutation during verification fails before rebind`, async () => {
        const f = fixture(),
            reconnect = f.ports.reconnect;
        let retained!: Awaited<ReturnType<typeof reconnect>>;
        f.ports.reconnect = async () => (retained = await reconnect());
        const entered = deferred(),
            gate = deferred();
        f.ports.verifyCurrentIdentity = async () => {
            entered.resolve();
            await gate.promise;
        };
        const pending = f.inspection.retire(f.input);
        await entered.promise;
        if (field === 'page') retained.page = { wrapper: 999 };
        else if (field === 'pid') retained.root.pid = 999;
        else if (field === 'created') retained.root.created = 'replacement';
        else retained[field] = 'replacement';
        gate.resolve();
        await assert.rejects(pending, /Retained reconnect/);
        assert.equal(f.inspection.snapshot().phase, 'failed');
        assert.equal(f.inspection.snapshot().generation, 1);
        assert.equal(
            f.calls.some((x) => x.startsWith('bind/')),
            false,
        );
        assert.equal(f.calls.includes('commit'), false);
    });
}

test('verification, commit and evidence share frozen descriptors without freezing the Page', async () => {
    const f = fixture(),
        seen: InspectionRebind<{ wrapper: number }>[] = [];
    const verify = f.ports.verifyCurrentIdentity,
        commit = f.ports.commitBinding,
        emit = f.ports.emit;
    f.ports.verifyCurrentIdentity = async (binding) => {
        seen.push(binding);
        assert.equal(Object.isFrozen(binding), true);
        assert.equal(Object.isFrozen(binding.root), true);
        assert.equal(Object.isFrozen(binding.page), false);
        assert.equal(Reflect.set(binding, 'page', { wrapper: 999 }), false);
        assert.equal(Reflect.set(binding.root, 'pid', 999), false);
        await verify(binding);
    };
    f.ports.commitBinding = async (binding) => {
        seen.push(binding);
        await commit(binding);
    };
    f.ports.emit = async (stage, data) => {
        if (stage === 'inspection-ready-generation') {
            const { identity } = data as { identity: Omit<InspectionRebind<unknown>, 'page'> };
            assert.equal(Object.isFrozen(identity), true);
            assert.equal(identity.root, seen[0].root);
        }
        await emit(stage, data);
    };
    await f.inspection.retire(f.input);
    assert.equal(seen.length, 3);
    assert.ok(seen.every((value) => value === seen[0]));
    assert.equal(await f.inspection.use('next-cycle', async () => 'worked'), 'worked');
});

for (const stage of ['observer-bind', 'post-bind-verification', 'commit', 'ready-evidence']) {
    test(`retained page mutation during ${stage} prevents ready publication`, async () => {
        const f = fixture(),
            reconnect = f.ports.reconnect;
        let retained!: Awaited<ReturnType<typeof reconnect>>;
        f.ports.reconnect = async () => (retained = await reconnect());
        const entered = deferred(),
            gate = deferred();
        const pause = async () => {
            entered.resolve();
            await gate.promise;
        };
        if (stage === 'observer-bind') {
            const hook = f.hooks.get('host-events')!,
                bind = hook.bind.bind(hook);
            hook.bind = async (page, generation) => {
                await bind(page, generation);
                await pause();
            };
        } else if (stage === 'post-bind-verification') {
            let count = 0;
            f.ports.verifyCurrentIdentity = async () => {
                if (++count === 2) await pause();
            };
        } else if (stage === 'commit') {
            const commit = f.ports.commitBinding;
            f.ports.commitBinding = async (binding) => {
                await commit(binding);
                await pause();
            };
        } else {
            const emit = f.ports.emit;
            f.ports.emit = async (name, data) => {
                await emit(name, data);
                if (name === 'inspection-ready-generation') await pause();
            };
        }
        const pending = f.inspection.retire(f.input);
        await entered.promise;
        retained.page = { wrapper: 999 };
        gate.resolve();
        await assert.rejects(pending, /Retained reconnect page changed/);
        assert.equal(f.inspection.snapshot().phase, 'failed');
        assert.equal(f.inspection.snapshot().generation, 1);
        await assert.rejects(
            f.inspection.use('after-substitution', async () => {}),
            /not ready/,
        );
        f.inspection.assertJoined();
    });
}
