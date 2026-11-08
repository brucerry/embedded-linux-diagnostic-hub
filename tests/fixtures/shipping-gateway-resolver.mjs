import assert from 'node:assert/strict';
import path from 'node:path';
import { types } from 'node:util';
import { pathToFileURL } from 'node:url';

const retained = new Set();
const entries = Object.freeze({
    ssh2: 'node_modules/ssh2/lib/index.js',
    asn1: 'node_modules/asn1/lib/index.js',
    'bcrypt-pbkdf': 'node_modules/bcrypt-pbkdf/index.js',
    'safer-buffer': 'node_modules/safer-buffer/safer.js',
    tweetnacl: 'node_modules/tweetnacl/nacl-fast.js',
});
const observeRejection = (value) => {
    if (types.isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
};

/** Native caller keeps this uncertainty set under its already-issued outer/namespace owner. */
export function assertShippingGatewayLifetime(assertActive, root, unknown) {
    const lease = {};
    unknown.add(lease); // Before a custodian callback can throw or return an unsupported operation.
    try {
        const value = assertActive(root);
        lease.value = value;
        observeRejection(value);
        assert.equal(value, undefined, 'Lifetime must acknowledge synchronously with void.');
        unknown.delete(lease);
    } catch (error) {
        lease.error = error;
        throw error;
    }
}

/** Only the admitted SSH2 fixture's required JS/JSON files; never an execution/provenance grant.
 * Registration is an effect: this owner is retained before dispatch. The hook stays owned until
 * the separately owned host exits; prepareClose is NOT deregistration or namespace retirement. */
export function createShippingGatewayResolver(root, files, ports) {
    assert.ok(root.startsWith('/') && root !== '/' && path.posix.normalize(root) === root);
    assert.ok(!/[\\\x00-\x20\x7f]/.test(root) && root.length <= 4096);
    assert.ok(Array.isArray(files) && files.length > 0 && files.length <= 4096);
    const allowed = new Map();
    for (const row of files) {
        const relative = row.path;
        assert.ok(
            typeof relative === 'string' &&
                relative.startsWith('node_modules/') &&
                path.posix.normalize(relative) === relative &&
                !/[\\\x00-\x20\x7f]/.test(relative) &&
                !relative.split('/').includes('..') &&
                /^[a-f0-9]{64}$/.test(row.sha256),
        );
        const url = pathToFileURL(root + '/' + relative).href;
        assert.equal(allowed.has(url), false);
        allowed.set(url, relative.endsWith('.json') ? 'json' : 'commonjs');
    }
    const fixed = new Map(
        Object.entries(entries).map(([name, file]) => [
            name,
            pathToFileURL(root + '/' + file).href,
        ]),
    );
    for (const url of fixed.values())
        assert.ok(allowed.has(url), 'Required fixture entry is absent.');
    for (const key of ['registerHooks', 'isBuiltin', 'onFailure'])
        assert.equal(typeof ports[key], 'function');
    ports = Object.freeze({ ...ports });
    const anchor = pathToFileURL(root + '/dist-gateway/main.cjs').href;
    const omitted = new Map([
        ['cpu-features', pathToFileURL(root + '/node_modules/ssh2/lib/protocol/constants.js').href],
        [
            './crypto/build/Release/sshcrypto.node',
            pathToFileURL(root + '/node_modules/ssh2/lib/protocol/crypto.js').href,
        ],
    ]);
    const missing = new Set();
    let registered = false,
        closing = false,
        failed = false,
        uncertain = false,
        inFlight = 0,
        resolutions = 0,
        handle;
    const unknown = new Set();
    function fail(error, unproved = false) {
        failed = true;
        uncertain ||= unproved;
        try {
            const result = ports.onFailure(error);
            observeRejection(result);
            assert.equal(result, undefined);
        } catch {
            uncertain = true;
        }
    }
    const owner = Object.freeze({
        snapshot: () =>
            Object.freeze({
                registered,
                closing,
                failed,
                uncertain,
                inFlight,
                resolutions,
                optionalOmissions: missing.size,
                unknown: unknown.size,
                namespaceRetirement: null,
                wholeGroupRetirement: null,
                releaseAcceptance: false,
            }),
        assertActive() {
            assert.ok(registered && !closing && !failed && !uncertain && inFlight === 0);
        },
        prepareClose() {
            if (closing) return;
            assert.ok(registered && !uncertain && inFlight === 0);
            closing = true;
        },
    });
    retained.add(owner);
    function resolve(specifier, context, next) {
        let entered = false,
            expectedOmission = false;
        try {
            assert.ok(registered && !uncertain && !failed && resolutions++ < 4096 && inFlight < 16);
            assert.ok(
                typeof specifier === 'string' &&
                    specifier.length <= 8192 &&
                    typeof next === 'function',
            );
            assert.ok(context && typeof context === 'object' && !types.isProxy(context));
            const parent = Object.getOwnPropertyDescriptor(context, 'parentURL');
            assert.ok(parent && Object.hasOwn(parent, 'value') && typeof parent.value === 'string');
            assert.ok(parent.value === anchor || allowed.get(parent.value) === 'commonjs');
            inFlight++;
            entered = true;
            if (omitted.has(specifier)) {
                assert.ok(
                    !closing && parent.value === omitted.get(specifier) && !missing.has(specifier),
                );
                missing.add(specifier);
                expectedOmission = true;
                throw Object.assign(Error('Reviewed optional fixture dependency is omitted.'), {
                    code: 'MODULE_NOT_FOUND',
                });
            }
            const builtin = ports.isBuiltin(specifier);
            observeRejection(builtin);
            if (typeof builtin !== 'boolean') unknown.add(builtin);
            assert.equal(typeof builtin, 'boolean');
            assert.ok(!closing || builtin, 'Module resolution after close preparation.');
            if (fixed.has(specifier))
                return { url: fixed.get(specifier), format: 'commonjs', shortCircuit: true };
            assert.ok(
                builtin || specifier.startsWith('.') || specifier.startsWith('file:'),
                'Unknown bare fixture dependency.',
            );
            const result = next(specifier, context);
            unknown.add(result);
            observeRejection(result);
            assert.ok(
                result &&
                    typeof result === 'object' &&
                    !types.isProxy(result) &&
                    !types.isPromise(result),
            );
            assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(result)));
            const descriptors = Object.getOwnPropertyDescriptors(result);
            assert.ok(
                Reflect.ownKeys(descriptors).every(
                    (k) =>
                        typeof k === 'string' &&
                        ['url', 'format', 'shortCircuit', 'importAttributes'].includes(k) &&
                        Object.hasOwn(descriptors[k], 'value'),
                ),
            );
            assert.ok(
                result.shortCircuit === undefined || typeof result.shortCircuit === 'boolean',
            );
            if (result.importAttributes !== undefined) {
                const attrs = result.importAttributes;
                assert.ok(
                    attrs &&
                        typeof attrs === 'object' &&
                        !types.isProxy(attrs) &&
                        [null, Object.prototype].includes(Object.getPrototypeOf(attrs)),
                );
                const fields = Object.getOwnPropertyDescriptors(attrs);
                assert.ok(
                    Reflect.ownKeys(fields).every(
                        (key) =>
                            typeof key === 'string' &&
                            key.length <= 256 &&
                            Object.hasOwn(fields[key], 'value') &&
                            typeof fields[key].value === 'string' &&
                            fields[key].value.length <= 256,
                    ),
                );
                assert.ok(Object.keys(fields).length <= 16);
            }
            assert.equal(typeof result.url, 'string');
            if (builtin) {
                assert.equal(
                    result.url,
                    specifier.startsWith('node:') ? specifier : 'node:' + specifier,
                );
                assert.ok(result.format === undefined || result.format === 'builtin');
            } else {
                assert.ok(
                    allowed.has(result.url),
                    'Resolved file is outside the admitted fixture inventory.',
                );
                assert.ok(/\.(?:js|json)$/.test(result.url), 'Unsupported fixture module format.');
                assert.ok(result.format === undefined || result.format === allowed.get(result.url));
            }
            unknown.delete(result);
            return result;
        } catch (error) {
            if (!expectedOmission) fail(error, unknown.size > 0);
            throw error;
        } finally {
            if (entered) inFlight--;
        }
    }
    try {
        handle = ports.registerHooks({ resolve });
        unknown.add(handle);
        observeRejection(handle);
        assert.ok(
            handle &&
                typeof handle === 'object' &&
                !types.isProxy(handle) &&
                !types.isPromise(handle),
        );
        const prototype = Object.getPrototypeOf(handle);
        assert.ok(!types.isProxy(prototype));
        const method =
            Object.getOwnPropertyDescriptor(handle, 'deregister') ??
            Object.getOwnPropertyDescriptor(prototype ?? {}, 'deregister');
        assert.ok(
            method &&
                Object.hasOwn(method, 'value') &&
                typeof method.value === 'function' &&
                !('then' in handle),
        );
        unknown.delete(handle);
        registered = true;
        owner.assertActive();
    } catch (error) {
        fail(error, true);
        throw Object.assign(Error('Fixture resolver registration is unacknowledged.'), {
            cause: error,
            owner,
        });
    }
    return owner;
}
