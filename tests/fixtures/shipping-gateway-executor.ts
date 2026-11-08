import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFinalGatewayObserver } from '../../scripts/lib/final-gateway-runtime.mjs';
import { parseGatewayArchiveBuildRecord } from '../../scripts/lib/gateway-build-record.mjs';
import { startDiagnosticGatewayRuntime } from '../../scripts/lib/diagnostic-gateway-runtime.mjs';
import { assertShippingGatewaySshFixture } from './shipping-gateway-ssh.ts';

const retained = new Set<object>();
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function deferred() {
    let resolve!: (value: any) => void, reject!: (error: unknown) => void;
    const promise = new Promise<any>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function keys(value: any, names: string[]) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}

/** Nonshipping composition of the existing final-byte observer, raw CLI controller and
 * issued SSH target. Explicit ports only; preparation has no IO, loader, key or process effect.
 * Namespace loading/native crypto preparation must remain inside the separately owned factory.
 * This is a diagnostic, never an execution permission or authenticated producer capability. */
export function prepareShippingGatewayExecutor(raw: any, ports: any) {
    keys(raw, [
        'archive',
        'recordBytes',
        'context',
        'sourceLockBytes',
        'selection',
        'dependencyArchives',
        'token',
        'attemptId',
    ]);
    keys(ports, ['filesystem', 'createFixture', 'runtime']);
    assert.equal(typeof ports.createFixture, 'function');
    assert.match(raw.token, /^[a-f0-9]{64}$/);
    assert.match(raw.attemptId, /^[a-f0-9]{32}$/);
    for (const [name, cap] of [
        ['archive', 128 * 1024 ** 2],
        ['recordBytes', 16 * 1024 ** 2],
        ['sourceLockBytes', 16 * 1024 ** 2],
    ] as const)
        assert.ok(Buffer.isBuffer(raw[name]) && raw[name].length > 0 && raw[name].length <= cap);
    assert.ok(
        Array.isArray(raw.dependencyArchives) &&
            raw.dependencyArchives.length > 0 &&
            raw.dependencyArchives.length <= 128,
    );
    let total = 0;
    const archives = raw.dependencyArchives.map((row: any) => {
        keys(row, ['path', 'bytes']);
        assert.ok(
            typeof row.path === 'string' &&
                Buffer.isBuffer(row.bytes) &&
                row.bytes.length > 0 &&
                row.bytes.length <= 16 * 1024 ** 2,
        );
        total += row.bytes.length;
        assert.ok(total <= 256 * 1024 ** 2);
        return { path: row.path, bytes: Buffer.from(row.bytes) };
    });
    const selected = structuredClone(raw.selection),
        context = structuredClone(raw.context),
        recordBytes = Buffer.from(raw.recordBytes),
        sourceLock = Buffer.from(raw.sourceLockBytes),
        archive = Buffer.from(raw.archive),
        token = raw.token,
        attemptId = raw.attemptId;
    const record = parseGatewayArchiveBuildRecord(recordBytes, context);
    // Same exact executable as the acknowledged build, not a matching version string.
    assert.equal(selected.node.sha256, record.builder.runtime.executableSHA256);
    const observer = createFinalGatewayObserver(
        archive,
        recordBytes,
        context,
        sourceLock,
        selected,
        ports.filesystem,
    );
    const factory = ports.createFixture.bind(ports),
        runtimePorts = Object.freeze({ ...ports.runtime });
    for (const name of ['launch', 'request', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof runtimePorts[name], 'function');
    let used = false;
    return Object.freeze({
        start() {
            assert.equal(used, false, 'Shipping workload is one-use.');
            used = true;
            const result = deferred(),
                closed = deferred();
            let fixture: any,
                runtime: any,
                unknownFactory: any,
                primary: unknown,
                failed = false,
                phase = 'installation-census',
                fixtureCloseSubmitted = false;
            const snapshot = () =>
                Object.freeze({
                    phase,
                    failed,
                    observer: observer.snapshot(),
                    fixture: fixture?.snapshot() ?? null,
                    runtime: runtime?.snapshot() ?? null,
                    unknownFactoryRetained: unknownFactory !== undefined,
                    authenticatedProducerProvenance: null,
                    wholeGroupRetirement: null,
                    releaseAcceptance: false,
                });
            const owner = Object.freeze({
                result: result.promise,
                closed: closed.promise,
                snapshot,
            });
            retained.add(owner);
            const fail = (error: unknown) => {
                if (!failed) primary = error;
                failed = true;
                result.reject(
                    Object.assign(
                        Error(
                            'Shipping Gateway workload failed; unacknowledged custody retained.',
                            { cause: primary },
                        ),
                        { owner },
                    ),
                );
            };
            function closeFixture() {
                if (!fixture) return;
                if (fixtureCloseSubmitted) return fixture.closed;
                fixtureCloseSubmitted = true; // Never repeat an uncertain close.
                return fixture.close();
            }
            void (async () => {
                let value: any,
                    installation: any,
                    origin: any,
                    knownClosed = false;
                try {
                    installation = await observer.observeInstallation();
                    origin = observer.observeDependencyOrigin(archives);
                    phase = 'fixture-acquisition';
                    // Capture before validation. An async/unknown acquisition cannot be discarded.
                    unknownFactory = { acquisitionUnknown: true };
                    const acquired = factory();
                    unknownFactory = acquired ?? unknownFactory;
                    if (acquired && typeof acquired.then === 'function')
                        void Promise.resolve(acquired).then(
                            (late) => {
                                unknownFactory = { returned: acquired, late };
                            },
                            () => {},
                        );
                    assertShippingGatewaySshFixture(acquired);
                    fixture = acquired;
                    unknownFactory = undefined;
                    fixture.failure.catch((error: unknown) => {
                        fail(error);
                        try {
                            void closeFixture();
                        } catch (closeError) {
                            fail(closeError);
                        }
                    });
                    await fixture.start();
                    phase = 'raw-cli-workload';
                    runtime = startDiagnosticGatewayRuntime(
                        {
                            root: selected.root,
                            nodePath: selected.node.path,
                            port: 58731,
                            token,
                            version: context.version,
                        },
                        { ...runtimePorts, observer },
                        fixture.sessionInput(attemptId),
                    );
                    // A fixture failure is reported promptly; cleanup still joins the owned CLI.
                    value = await Promise.race([runtime.result, fixture.failure]);
                    await runtime.closed;
                } catch (error) {
                    fail(error);
                }
                phase = 'joining-known-resources';
                try {
                    const fixtureClose = closeFixture();
                    await Promise.all([fixtureClose, runtime?.closed]);
                    const custody = observer.snapshot();
                    assert.equal(
                        custody.pendingIO + custody.descriptors + custody.listenersHeld,
                        0,
                    );
                    assert.equal(unknownFactory, undefined);
                    knownClosed = true;
                    if (!failed) {
                        const fixtureReceipt = fixture.verifyComplete();
                        const receipt = {
                            schema: 'shipping-gateway-session-diagnostic-v1',
                            context,
                            archive: record.archive,
                            buildRecordSHA256: hash(recordBytes),
                            sourceLockSHA256: record.sourceLockSHA256,
                            preparedLockSHA256: record.preparedLockSHA256,
                            selectedNode: installation.selectedNode,
                            installationSHA256: installation.treeSHA256,
                            dependencyOrigin: {
                                sha256: hash(Buffer.from(JSON.stringify(origin) + '\n')),
                                packages: origin.packages.length,
                                files: origin.files.length,
                                loadedCodeObserved: false,
                            },
                            runtime: value.receipt,
                            fixture: fixtureReceipt,
                            authenticatedProducerProvenance: null,
                            loadedCodeIdentity: null,
                            wholeGroupRetirement: null,
                            releaseAcceptance: false,
                        };
                        // selectedNode contains file identity/digest, never executable bytes or credentials.
                        assert.equal(receipt.selectedNode.content, undefined);
                        assert.ok(Buffer.byteLength(JSON.stringify(receipt) + '\n') <= 16384);
                        phase = 'known-resources-closed';
                        retained.delete(owner);
                        closed.resolve(snapshot());
                        result.resolve({ receipt, observation: value.observation });
                    } else {
                        phase = 'failed-known-resources-closed';
                        retained.delete(owner);
                        closed.resolve(snapshot());
                    }
                } catch (error) {
                    phase = knownClosed ? 'failed-known-resources-closed' : 'retirement-unproved';
                    fail(error);
                    if (knownClosed) {
                        retained.delete(owner);
                        closed.resolve(snapshot());
                    }
                }
            })();
            return owner;
        },
    });
}
