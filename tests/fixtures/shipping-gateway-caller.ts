import assert from 'node:assert/strict';
import { types } from 'node:util';
import { createFinalGatewayObserver } from '../../scripts/lib/final-gateway-runtime.mjs';
import { prepareShippingGatewayExecutor } from './shipping-gateway-executor.ts';

const retained = new Set<object>();
function deferred() {
    let resolve!: (value: any) => void, reject!: (error: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function data(value: any, key: string) {
    assert.ok(value && typeof value === 'object' && !types.isProxy(value));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
}

/** Actual composition, with explicit native/fake ports. Preparation has no IO or loading effect.
 * result reports only the existing diagnostic observation. closed additionally requires the
 * namespace owner's independent acknowledgement; initialization settlement never supplies it. */
export function prepareShippingGatewayCaller(raw: any, supplied: any) {
    assert.deepEqual(
        Object.keys(raw).sort(),
        [
            'archive',
            'recordBytes',
            'context',
            'sourceLockBytes',
            'selection',
            'dependencyArchives',
            'token',
            'attemptId',
        ].sort(),
    );
    for (const [key, maximum] of [
        ['archive', 128 * 1024 ** 2],
        ['recordBytes', 16 * 1024 ** 2],
        ['sourceLockBytes', 16 * 1024 ** 2],
    ] as const)
        assert.ok(Buffer.isBuffer(raw[key]) && raw[key].length > 0 && raw[key].length <= maximum);
    assert.ok(
        Array.isArray(raw.dependencyArchives) &&
            raw.dependencyArchives.length > 0 &&
            raw.dependencyArchives.length <= 128,
    );
    let total = 0;
    for (const row of raw.dependencyArchives) {
        assert.ok(
            Buffer.isBuffer(row.bytes) &&
                row.bytes.length > 0 &&
                row.bytes.length <= 16 * 1024 ** 2,
        );
        total += row.bytes.length;
        assert.ok(total <= 256 * 1024 ** 2);
    }
    assert.deepEqual(Object.keys(supplied).sort(), [
        'createFixture',
        'filesystem',
        'prepareNamespace',
        'runtime',
    ]);
    const ports = Object.freeze({ ...supplied });
    assert.equal(typeof ports.prepareNamespace, 'function');
    assert.equal(typeof ports.createFixture, 'function');
    const input = {
        ...structuredClone({
            ...raw,
            archive: undefined,
            recordBytes: undefined,
            sourceLockBytes: undefined,
            dependencyArchives: undefined,
        }),
        archive: Buffer.from(raw.archive),
        recordBytes: Buffer.from(raw.recordBytes),
        sourceLockBytes: Buffer.from(raw.sourceLockBytes),
        dependencyArchives: raw.dependencyArchives.map((row: any) => ({
            path: row.path,
            bytes: Buffer.from(row.bytes),
        })),
    };
    const census = createFinalGatewayObserver(
        input.archive,
        input.recordBytes,
        input.context,
        input.sourceLockBytes,
        input.selection,
        ports.filesystem,
    );
    let loaded: any,
        initialized = false,
        cancelled = false,
        factoryUsed = false,
        namespaceActive = () => false;
    const execution = prepareShippingGatewayExecutor(input, {
        filesystem: ports.filesystem,
        runtime: ports.runtime,
        createFixture() {
            assert.ok(initialized && !cancelled && !factoryUsed && namespaceActive());
            factoryUsed = true;
            return ports.createFixture(loaded);
        },
    });
    let used = false;
    return Object.freeze({
        start() {
            assert.equal(used, false, 'Caller is one-use.');
            used = true;
            const result = deferred(),
                closed = deferred();
            let phase = 'admitting',
                namespace: any,
                returned: any,
                runtime: any,
                primary: unknown,
                failed = false,
                acquired = false,
                unknown = false,
                initAttempted = false,
                initSettled = false,
                namespaceCloseRequested = false,
                namespaceClose: any,
                observed = false,
                retired = false;
            const late = new Set<any>();
            function fail(error: unknown) {
                if (retired) return;
                if (!failed) primary = error;
                failed = true;
                result.reject(
                    Object.assign(
                        Error('Shipping caller failed; unresolved custody remains owned.', {
                            cause: primary,
                        }),
                        { owner },
                    ),
                );
            }
            function closeNamespace() {
                if (!namespace || namespaceCloseRequested) return namespaceClose;
                namespaceCloseRequested = true;
                try {
                    namespaceClose = namespace.close();
                    late.add(namespaceClose);
                    if (types.isPromise(namespaceClose))
                        void Promise.prototype.then.call(namespaceClose, undefined, () => {});
                    assert.equal(namespaceClose, data(namespace, 'closed'));
                } catch (error) {
                    unknown = true;
                    fail(error);
                }
                return namespaceClose;
            }
            const owner = Object.freeze({
                result: result.promise,
                closed: closed.promise,
                snapshot: () =>
                    Object.freeze({
                        phase,
                        failed,
                        cancelled,
                        namespaceAcquisitionAttempted: acquired,
                        unknownAcquisitionOrClosure: unknown,
                        initializationAttempted: initAttempted,
                        initializationSettled: initSettled,
                        namespaceCloseRequested,
                        lateValuesRetained: late.size,
                        executor: runtime?.snapshot() ?? null,
                        admission: census.snapshot(),
                        observed,
                        retired,
                        namespaceRetirement: null,
                        wholeGroupRetirement: null,
                        releaseAcceptance: false,
                    }),
                close() {
                    if (retired) return closed.promise;
                    if (!observed) {
                        cancelled = true;
                        fail(Error('Caller cancellation requested.'));
                    }
                    // The worker submits namespace close only after admission/initialization and
                    // the existing executor's closure join. Cancellation is not interruption.
                    return closed.promise;
                },
            });
            retained.add(owner); // Before any admission IO, factory, hook registration or require.
            namespaceActive = () => !failed && !cancelled;
            void Promise.resolve().then(async () => {
                try {
                    assert.equal(cancelled, false);
                    await census.observeInstallation();
                    const origin = census.observeDependencyOrigin(input.dependencyArchives);
                    assert.equal(cancelled, false);
                    phase = 'namespace-acquisition';
                    acquired = true;
                    unknown = true;
                    returned = ports.prepareNamespace(
                        Object.freeze({
                            root: input.selection.root,
                            context: structuredClone(input.context),
                            sourceLockBytes: Buffer.from(input.sourceLockBytes),
                            origin: structuredClone(origin),
                        }),
                        owner,
                    );
                    if (types.isPromise(returned))
                        void Promise.prototype.then.call(
                            returned,
                            (value) => {
                                late.add(value);
                            },
                            () => {},
                        );
                    assert.ok(
                        returned &&
                            typeof returned === 'object' &&
                            !types.isPromise(returned) &&
                            !types.isProxy(returned) &&
                            Object.isFrozen(returned),
                    );
                    for (const key of ['start', 'close', 'snapshot'])
                        assert.equal(typeof data(returned, key), 'function');
                    assert.ok(
                        types.isPromise(data(returned, 'closed')) &&
                            types.isPromise(data(returned, 'failure')),
                    );
                    namespace = returned;
                    unknown = false;
                    void Promise.prototype.then.call(namespace.failure, undefined, fail);
                    void Promise.prototype.then.call(
                        namespace.closed,
                        () => {
                            if (!namespaceCloseRequested) {
                                unknown = true;
                                fail(Error('Namespace closure preceded its owned close request.'));
                            }
                        },
                        fail,
                    );
                    assert.equal(cancelled, false);
                    phase = 'initializing';
                    initAttempted = true;
                    let initializing;
                    try {
                        initializing = namespace.start();
                    } catch (error) {
                        unknown = true;
                        throw error;
                    }
                    late.add(initializing);
                    if (!types.isPromise(initializing)) unknown = true;
                    assert.ok(
                        types.isPromise(initializing),
                        'Initialization must return an observed native Promise.',
                    );
                    try {
                        loaded = await initializing;
                    } finally {
                        initSettled = true;
                    }
                    assert.equal(cancelled || failed, false);
                    initialized = true;
                    phase = 'workload';
                    runtime = execution.start();
                    const output = await runtime.result;
                    await runtime.closed;
                    assert.equal(cancelled || failed, false);
                    observed = true;
                    result.resolve(output);
                } catch (error) {
                    fail(error);
                }
                phase = 'joining';
                try {
                    if (runtime) await runtime.closed;
                    if (namespace) {
                        const pending = closeNamespace();
                        assert.ok(types.isPromise(pending));
                        await pending; // Rejection is not closure acknowledgement.
                    }
                    assert.equal(unknown, false);
                    const state = census.snapshot();
                    assert.equal(state.pendingIO + state.descriptors + state.listenersHeld, 0);
                    retired = true;
                    phase = failed ? 'failed-known-resources-closed' : 'known-resources-closed';
                    retained.delete(owner);
                    closed.resolve(owner.snapshot());
                } catch (error) {
                    phase = 'retirement-unproved';
                    fail(error);
                }
            });
            return owner;
        },
    });
}
