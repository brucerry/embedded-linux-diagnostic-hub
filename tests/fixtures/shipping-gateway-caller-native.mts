// Definition-only. No CLI activation, package loading, credentials, hooks or native handles at import.
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createRequire, registerHooks, isBuiltin } from 'node:module';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { userInfo } from 'node:os';
import { createOwnedWebFiles } from '../../scripts/lib/owned-web-files.mjs';
import { readStableArtifactFile } from '../../scripts/lib/stable-artifact-file.mjs';
import {
    deriveSshReadinessPlan,
    cachedSshInitialization,
} from '../../scripts/lib/instrumented-gateway-ssh-readiness.mjs';
import {
    createShippingGatewayResolver,
    assertShippingGatewayLifetime,
} from './shipping-gateway-resolver.mjs';
import { prepareShippingGatewayCaller } from './shipping-gateway-caller.ts';
import { prepareNativeShippingGatewayTarget } from './shipping-gateway-ssh-native.mts';

const retained = new Set<object>();
function deferred() {
    let resolve!: (value: any) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Uses existing native bindings. lifetime is an external custodian's reviewed live assertion,
 * never a JSON execution grant, timeout or substitute for a normal-retirement observer.
 * The selected archive/install/dependency/Node inputs must already exist; no setup is performed. */
export function prepareNativeShippingGatewayCaller(input: any, lifetime: any) {
    assert.ok(lifetime && typeof lifetime === 'object' && !types.isProxy(lifetime));
    const descriptor = Object.getOwnPropertyDescriptor(lifetime, 'assertActive');
    assert.ok(
        descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function',
    );
    const lifetimeUnknown = new Set();
    const assertActive = (root: string) =>
        assertShippingGatewayLifetime(descriptor.value.bind(lifetime), root, lifetimeUnknown);
    const selected = structuredClone(input.selection);
    return prepareShippingGatewayCaller(input, {
        filesystem,
        runtime: {
            launch(file: string, args: string[], options: any) {
                assertActive(selected.root);
                return spawn(file, args, options);
            },
            request,
            setTimer: setTimeout,
            clearTimer: (timer: any) => {
                clearTimeout(timer);
            },
            now: () => performance.now(),
        },
        createFixture(loaded: any) {
            assertActive(selected.root);
            return prepareNativeShippingGatewayTarget(loaded);
        },
        prepareNamespace(binding: any) {
            assert.equal(binding.root, selected.root);
            const ready = deferred(),
                closed = deferred(),
                failure = deferred();
            const owned = createOwnedWebFiles(filesystem),
                io = owned.filesystem;
            let used = false,
                closing = false,
                settled = false,
                attempted = false,
                failed = false,
                guard: any,
                loading: any,
                pending = false;
            function fail(error: unknown) {
                failed = true;
                ready.reject(error);
                failure.reject(error);
            }
            function joinBeforeEffects() {
                if (!closing || !settled || pending || attempted || lifetimeUnknown.size) return;
                const state = owned.owner.snapshot();
                if (state.pending + state.handles + state.uncertainPublications === 0) {
                    retained.delete(owner);
                    closed.resolve(owner.snapshot());
                }
            }
            function prepareGuardClose() {
                if (closing && settled && guard && !guard.snapshot().closing) {
                    try {
                        guard.prepareClose();
                    } catch (error) {
                        fail(error);
                    }
                }
            }
            const owner = Object.freeze({
                closed: closed.promise,
                failure: failure.promise,
                snapshot: () =>
                    Object.freeze({
                        used,
                        closing,
                        initializationSettled: settled,
                        loaderAttempted: attempted,
                        failed,
                        unknownLifetimeOperations: lifetimeUnknown.size,
                        pendingAdmission: pending,
                        files: owned.owner.snapshot(),
                        resolver: guard?.snapshot() ?? null,
                        namespaceRetirement: null,
                        cryptoWorkerRetirement: null,
                        wholeGroupRetirement: null,
                        releaseAcceptance: false,
                    }),
                start() {
                    assert.equal(used || closing, false, 'Namespace initialization is one-use.');
                    used = true;
                    void Promise.resolve().then(async () => {
                        pending = true;
                        try {
                            assertActive(binding.root);
                            assert.equal(process.platform, 'linux');
                            assert.match(process.version, /^v24\./);
                            assert.equal(process.execPath, selected.node.path);
                            assert.deepEqual(process.execArgv, []);
                            assert.equal(process.env.NODE_OPTIONS, undefined);
                            assert.equal(process.env.NODE_PATH, undefined);
                            assert.equal(process.getuid?.(), selected.uid);
                            assert.equal(await io.realpath(binding.root), binding.root);
                            const require = createRequire(binding.root + '/dist-gateway/main.cjs');
                            const search = require.resolve.paths('ssh2');
                            assert.ok(
                                Array.isArray(search) &&
                                    search.length <= 64 &&
                                    search.includes(binding.root + '/node_modules'),
                            );
                            // Child has the same executable and a closed env without HOME/NODE_PATH.
                            // Check the parent's real resolver list plus the passwd-home fallback
                            // locations the unchanged child can use; never create or clean these paths.
                            const home = userInfo().homedir;
                            const external = new Set([
                                ...search,
                                path.posix.join(home, '.node_modules'),
                                path.posix.join(home, '.node_libraries'),
                            ]);
                            for (const directory of external) {
                                assert.ok(
                                    directory.startsWith('/') &&
                                        path.posix.normalize(directory) === directory,
                                );
                                if (directory === binding.root + '/node_modules') continue;
                                try {
                                    await filesystem.lstat(directory);
                                    assert.fail('External Node lookup directory must be absent.');
                                } catch (error: any) {
                                    assert.equal(error?.code, 'ENOENT');
                                }
                            }
                            const read = async (relative: string) => {
                                const bytes = (
                                    await readStableArtifactFile(
                                        binding.root,
                                        relative,
                                        1024 ** 2,
                                        io,
                                    )
                                ).bytes;
                                const recorded = binding.origin.files.find(
                                    (row: any) => row.path === relative,
                                );
                                assert.ok(
                                    recorded &&
                                        recorded.bytes === bytes.length &&
                                        recorded.sha256 === hash(bytes),
                                );
                                return bytes;
                            };
                            const crypto = 'node_modules/ssh2/lib/protocol/crypto.js',
                                pkg = 'node_modules/ssh2/package.json';
                            const scripts = new Map([
                                [binding.root + '/' + crypto, await read(crypto)],
                                [binding.root + '/' + pkg, await read(pkg)],
                                [binding.root + '/package-lock.json', binding.sourceLockBytes],
                            ]);
                            const plan = deriveSshReadinessPlan(scripts, binding.root);
                            owned.owner.assertSettled();
                            assert.equal(closing, false);
                            assertActive(binding.root);
                            for (const row of binding.origin.files)
                                assert.equal(
                                    Object.getOwnPropertyDescriptor(
                                        require.cache,
                                        binding.root + '/' + row.path,
                                    ),
                                    undefined,
                                    'Fixture dependency was preloaded.',
                                );
                            attempted = true; // Before registration, ordinary require or async crypto work.
                            guard = createShippingGatewayResolver(
                                binding.root,
                                binding.origin.files,
                                {
                                    registerHooks,
                                    isBuiltin,
                                    onFailure: fail,
                                },
                            );
                            guard.assertActive();
                            const loaded = require('ssh2');
                            guard.assertActive();
                            loading = cachedSshInitialization(require.cache, plan);
                            assert.ok(types.isPromise(loading));
                            await loading; // Join exactly the existing cached Promise; never call its factory.
                            guard.assertActive();
                            assert.equal(closing || failed, false);
                            ready.resolve(loaded);
                        } catch (error) {
                            fail(error);
                        } finally {
                            pending = false;
                            settled = true;
                            prepareGuardClose();
                            joinBeforeEffects();
                        }
                    });
                    return ready.promise;
                },
                close() {
                    if (!closing) {
                        closing = true;
                        if (!used) {
                            settled = true;
                            ready.reject(Error('Namespace closed before initialization.'));
                        }
                        prepareGuardClose();
                        joinBeforeEffects();
                    }
                    // No in-process API proves SSH2/Wasm/crypto-worker retirement or retires the
                    // process-lifetime resolver. After attempted registration this remains held.
                    return closed.promise;
                },
            });
            retained.add(owner); // Synchronous owner exists before start() can perform any effect.
            return owner;
        },
    });
}
