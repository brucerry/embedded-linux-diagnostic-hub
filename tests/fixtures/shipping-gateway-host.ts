import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { types } from 'node:util';
import { startInstrumentedChildOutput } from '../../scripts/lib/instrumented-gateway-output.mjs';
import { assertShippingGatewayLifetime } from './shipping-gateway-resolver.mjs';

const retained = new Set<object>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function deferred() {
    let resolve!: (value: any) => void, reject!: (error: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function data(value: any, name: string) {
    assert.ok(value && typeof value === 'object' && !types.isProxy(value));
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
}

/** A command plan only: no build, source observation, output adoption or execution admission.
 * The existing producer builds the shipping archive separately. This bundle exports a nonshipping
 * host function; it neither auto-activates nor accepts a serialized lifetime grant. */
export function shippingGatewayHostBuildCommand(selection: {
    sourceRoot: string;
    outputRoot: string;
    nodePath: string;
    esbuildPath: string;
}) {
    assert.deepEqual(Object.keys(selection).sort(), [
        'esbuildPath',
        'nodePath',
        'outputRoot',
        'sourceRoot',
    ]);
    for (const value of Object.values(selection)) {
        assert.equal(typeof value, 'string');
        assert.ok(value.startsWith('/') && path.posix.normalize(value) === value);
        assert.notEqual(value, '/');
        assert.ok(!/[\\\x00-\x1f\x7f]/.test(value));
    }
    assert.ok(selection.esbuildPath.endsWith('/esbuild/bin/esbuild'));
    assert.notEqual(selection.outputRoot, selection.sourceRoot);
    assert.ok(!selection.outputRoot.startsWith(selection.sourceRoot + '/'));
    return Object.freeze([
        selection.nodePath,
        selection.esbuildPath,
        selection.sourceRoot + '/tests/fixtures/shipping-gateway-host-native.mts',
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--external:ssh2',
        '--outfile=' + selection.outputRoot + '/shipping-gateway-host.cjs',
        '--metafile=' + selection.outputRoot + '/shipping-gateway-host.meta.json',
    ]);
}

/** Receives real caller inputs and explicit native/fake ports. No default ports or activation.
 * result acknowledges the existing diagnostic receipt write. closed is a separate join and stays
 * pending when the native namespace has no retirement proof. Neither means host/group retirement. */
export function prepareShippingGatewayHost(raw: any, supplied: any) {
    assert.deepEqual(Object.keys(supplied).sort(), [
        'assertRuntime',
        'lifetime',
        'prepareCaller',
        'setFailure',
        'stdout',
    ]);
    const ports = Object.freeze({ ...supplied });
    for (const key of ['assertRuntime', 'prepareCaller', 'setFailure'])
        assert.equal(typeof ports[key], 'function');
    const lifetime = data(ports.lifetime, 'assertActive');
    assert.equal(typeof lifetime, 'function');
    // Bound before cloning. The actual caller independently validates the exact input/schema.
    for (const [key, limit] of [
        ['archive', 128 * 1024 ** 2],
        ['recordBytes', 16 * 1024 ** 2],
        ['sourceLockBytes', 16 * 1024 ** 2],
    ] as const)
        assert.ok(Buffer.isBuffer(raw[key]) && raw[key].length > 0 && raw[key].length <= limit);
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
    const copy = structuredClone(raw);
    const input = {
        ...copy,
        archive: Buffer.from(copy.archive),
        recordBytes: Buffer.from(copy.recordBytes),
        sourceLockBytes: Buffer.from(copy.sourceLockBytes),
        dependencyArchives: copy.dependencyArchives.map((row: any) => ({
            ...row,
            bytes: Buffer.from(row.bytes),
        })),
    };
    let used = false;
    return Object.freeze({
        start() {
            assert.equal(used, false, 'Host is one-use.');
            used = true;
            const result = deferred(),
                closed = deferred(),
                unknown = new Set<any>(),
                acquisitions = new Set<any>();
            let caller: any,
                output: any,
                failed = false,
                cancelled = false,
                emitted = false,
                callerClosed = false,
                outputClosed = false,
                done = false,
                retired = false,
                closeRequested = false;
            function observe(value: any) {
                unknown.add(value);
                if (types.isPromise(value))
                    void Promise.prototype.then.call(
                        value,
                        (late) => unknown.add(late),
                        () => {},
                    );
            }
            function acquired(value: any) {
                acquisitions.add(value); // Retain the actual return even if later validation fails.
                if (types.isPromise(value)) observe(value);
                else if (value && typeof value === 'object' && !types.isProxy(value)) {
                    for (const key of ['result', 'closed', 'failure']) {
                        const descriptor = Object.getOwnPropertyDescriptor(value, key);
                        if (
                            descriptor &&
                            Object.hasOwn(descriptor, 'value') &&
                            types.isPromise(descriptor.value)
                        )
                            void Promise.prototype.then.call(descriptor.value, undefined, () => {});
                    }
                }
            }
            function failureStatus() {
                try {
                    const value = ports.setFailure();
                    if (value !== undefined) observe(value);
                } catch (error) {
                    observe(error);
                }
            }
            function fail(error: unknown) {
                failed = true;
                failureStatus();
                result.reject(
                    Object.assign(
                        Error('Shipping host failed; unresolved custody retained.', {
                            cause: error,
                        }),
                        { owner },
                    ),
                );
            }
            function join() {
                if (!done || !callerClosed || (output && !outputClosed) || unknown.size || retired)
                    return;
                retired = true;
                retained.delete(owner);
                closed.resolve(owner.snapshot());
            }
            function requestClose() {
                if (!caller || closeRequested) return;
                closeRequested = true;
                try {
                    const value = caller.close();
                    if (value !== data(caller, 'closed')) {
                        observe(value);
                        throw Error('Unknown caller close join.');
                    }
                } catch (error) {
                    observe(error);
                    fail(error);
                }
            }
            function active() {
                assert.equal(
                    cancelled || failed,
                    false,
                    'Host cancelled or failed before next effect.',
                );
                assertShippingGatewayLifetime(
                    lifetime.bind(ports.lifetime),
                    input.selection.root,
                    unknown,
                );
            }
            const owner = Object.freeze({
                result: result.promise,
                closed: closed.promise,
                snapshot: () =>
                    Object.freeze({
                        failed,
                        cancelled,
                        diagnosticEmitted: emitted,
                        callerAcquired: Boolean(caller),
                        callerClosed,
                        outputWriteRetired: outputClosed,
                        unknownOperations: unknown.size,
                        acquisitionValuesRetained: acquisitions.size,
                        done,
                        knownResourcesJoined: retired,
                        inheritedPipeClosure: null,
                        hostRetirement: null,
                        namespaceRetirement: null,
                        cryptoWorkerRetirement: null,
                        wholeGroupRetirement: null,
                        releaseAcceptance: false,
                    }),
                close() {
                    if (!emitted) {
                        cancelled = true;
                        fail(Error('Host cancellation requested.'));
                    }
                    requestClose();
                    return closed.promise;
                },
            });
            retained.add(owner); // Before runtime/lifetime callbacks, preparation, start or output.
            void Promise.resolve().then(async () => {
                try {
                    active();
                    const checking = {};
                    unknown.add(checking);
                    const checked = ports.assertRuntime(input.selection);
                    if (checked !== undefined) {
                        observe(checked);
                        throw Error('Unknown runtime assertion.');
                    }
                    unknown.delete(checking);
                    active();
                    const acquiring = {};
                    unknown.add(acquiring);
                    let prepared: any;
                    try {
                        prepared = ports.prepareCaller(input, ports.lifetime);
                        acquired(prepared);
                    } catch (error) {
                        observe(error);
                        throw error;
                    }
                    if (types.isPromise(prepared)) {
                        observe(prepared);
                        throw Error('Async caller preparation is unsupported.');
                    }
                    assert.equal(typeof data(prepared, 'start'), 'function');
                    active();
                    let value: any;
                    try {
                        value = prepared.start();
                        acquired(value);
                    } catch (error) {
                        observe(error);
                        throw error;
                    }
                    if (types.isPromise(value)) {
                        observe(value);
                        throw Error('Async caller acquisition is unsupported.');
                    }
                    assert.ok(value && !types.isProxy(value) && Object.isFrozen(value));
                    for (const key of ['result', 'closed'])
                        assert.ok(types.isPromise(data(value, key)));
                    assert.equal(typeof data(value, 'close'), 'function');
                    caller = value;
                    acquisitions.clear(); // The validated original owner is now retained as caller.
                    unknown.delete(acquiring);
                    void Promise.prototype.then.call(
                        caller.closed,
                        () => {
                            callerClosed = true;
                            join();
                        },
                        fail,
                    );
                    if (cancelled) requestClose();
                    const observed = await caller.result;
                    active();
                    const receipt = observed.receipt;
                    assert.equal(receipt.schema, 'shipping-gateway-session-diagnostic-v1');
                    assert.deepEqual(receipt.context, input.context);
                    assert.equal(receipt.archive.sha256, digest(input.archive));
                    assert.equal(receipt.buildRecordSHA256, digest(input.recordBytes));
                    assert.equal(receipt.sourceLockSHA256, digest(input.sourceLockBytes));
                    assert.equal(receipt.selectedNode.path, input.selection.node.path);
                    assert.equal(receipt.selectedNode.sha256, input.selection.node.sha256);
                    for (const key of [
                        'authenticatedProducerProvenance',
                        'loadedCodeIdentity',
                        'wholeGroupRetirement',
                    ])
                        assert.equal(receipt[key], null);
                    assert.equal(receipt.releaseAcceptance, false);
                    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
                    assert.ok(bytes.length <= 16384, 'Diagnostic receipt exceeds 16 KiB.');
                    active();
                    output = startInstrumentedChildOutput(bytes, ports.stdout, () => {
                        failed = true;
                        failureStatus();
                    });
                    void output.closed.then(() => {
                        outputClosed = true;
                        join();
                    }, fail);
                    await output.result;
                    assert.equal(cancelled || failed, false);
                    emitted = true;
                    result.resolve(receipt);
                    // In particular, do not await native caller.closed to permit natural host exit.
                } catch (error) {
                    fail(error);
                    requestClose();
                } finally {
                    done = true;
                    if (!caller && unknown.size === 0) callerClosed = true;
                    join();
                }
            });
            return owner;
        },
    });
}
