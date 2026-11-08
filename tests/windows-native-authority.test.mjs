import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as nativeTypes } from 'node:util';
import { WINDOWS_SETUP_ASSET } from '../scripts/lib/windows-setup-release.mjs';
import { consumeInstallerLifecycleEvidence } from '../scripts/lib/installer-lifecycle-evidence.mjs';
import {
    validateWindowsNativeRequest,
    validateWindowsNativeBuild,
    prepareWindowsNativeAuthority,
    assertWindowsNativeCapability,
    pinWindowsNativeFiles,
    observeWindowsNativeProcess,
    readWindowsNativeObservation,
    cancelWindowsNativeAuthority,
    releaseWindowsNativeAuthority,
    refuseWindowsNativeNormalClose,
    validateWindowsNativeLaunch,
    validateWindowsNativeSiblingLaunch,
    launchWindowsNativePinnedProcess,
    launchWindowsNativePinnedSiblingProcess,
    sampleWindowsNativeOwnedProcess,
    readWindowsNativeOwnedProcess,
    releaseWindowsNativeOwnedProcessHandles,
    drainWindowsNativeOwnedStdio,
    readWindowsNativeMainInspectorEndpoint,
    requestWindowsNativeNormalQuit,
    joinWindowsNativeNormalQuitTransport,
    readWindowsNativeNormalQuit,
    readWindowsNativeOwnedRelease,
} from '../scripts/lib/windows-native-authority.mjs';

const request = () => ({
    sourceCommit: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    runId: '123',
    runAttempt: '1',
    lane: 'win32-x64',
    caseId: 'windows-nsis:offline-launch',
    package: { name: 'Diagnostic-Hub-Windows-x64-Setup.exe', bytes: 100, sha256: '3'.repeat(64) },
    root: 'C:\\Owned\\case',
    expectedFiles: [
        { relativePath: 'Diagnostic Hub.exe', size: 20, sha256: '4'.repeat(64) },
        { relativePath: 'resources/app.asar', size: 30, sha256: '5'.repeat(64) },
    ],
});
const build = () => ({
    binarySHA256: '6'.repeat(64),
    sourceSHA256: '7'.repeat(64),
    bindingSHA256: '8'.repeat(64),
    nodeApi: 8,
    arch: 'x64',
    nodeVersion: '24.22.0',
});

test('selected native request labels snapshot immutably without issuing a capability', () => {
    const input = request(),
        selected = validateWindowsNativeRequest(input);
    assert.deepEqual(selected, input);
    input.package.sha256 = '0'.repeat(64);
    input.expectedFiles[0].size = 1;
    assert.equal(selected.package.sha256, '3'.repeat(64));
    assert.equal(selected.expectedFiles[0].size, 20);
    assert.ok(
        Object.isFrozen(selected) &&
            Object.isFrozen(selected.package) &&
            Object.isFrozen(selected.expectedFiles) &&
            Object.isFrozen(selected.expectedFiles[0]),
    );
    assert.throws(() => assertWindowsNativeCapability(selected, selected), /CAPABILITY_UNISSUED/);
});

test('request and build getter properties are rejected without evaluating them', () => {
    for (const [factory, validate, name] of [
        [request, validateWindowsNativeRequest, 'root'],
        [build, validateWindowsNativeBuild, 'binarySHA256'],
    ]) {
        const input = factory();
        let calls = 0;
        Object.defineProperty(input, name, {
            enumerable: true,
            get() {
                calls++;
                throw Error('getter ran');
            },
        });
        assert.throws(() => validate(input));
        assert.equal(calls, 0);
    }
});

test('request path and selected installer identity reject aliases and unsupported lanes', () => {
    for (const root of [
        'C:\\',
        'C:\\Owned\\..\\case',
        '\\\\server\\share',
        'C:\\Owned\\case:stream',
        'C:\\CON',
        'C:\\Owned\\case.',
        'relative',
    ]) {
        assert.throws(() => validateWindowsNativeRequest({ ...request(), root }));
    }
    for (const change of [
        { lane: 'darwin-arm64' },
        { caseId: 'windows-nsis:install' },
        { runAttempt: '0' },
        { sourceCommit: 'X'.repeat(40) },
        { unexpected: true },
    ])
        assert.throws(() => validateWindowsNativeRequest({ ...request(), ...change }));
    const wrong = request();
    wrong.package.name = 'arbitrary.exe';
    assert.throws(() => validateWindowsNativeRequest(wrong));
    const oversized = request();
    oversized.package.bytes = 2 * 1024 * 1024 * 1024 + 1;
    assert.throws(() => validateWindowsNativeRequest(oversized));
});

test('only the exact two bounded critical-file expectations are admitted as selected data', () => {
    for (const change of [
        (files) => files.reverse(),
        (files) => files.push({ ...files[0] }),
        (files) => {
            files[0].size = NaN;
        },
        (files) => {
            files[0].size = 0;
        },
        (files) => {
            files[0].size = 512 * 1024 * 1024 + 1;
        },
        (files) => {
            files[1].sha256 = 'invalid';
        },
        (files) => {
            files[0].relativePath = 'other.exe';
        },
    ]) {
        const input = request();
        change(input.expectedFiles);
        assert.throws(() => validateWindowsNativeRequest(input));
    }
});

test('build metadata is bounded configuration and cannot itself issue native authority', () => {
    const selected = validateWindowsNativeBuild(build());
    assert.ok(Object.isFrozen(selected));
    for (const change of [
        { binarySHA256: 'invalid' },
        { nodeApi: 9 },
        { arch: 'arm64' },
        { nodeVersion: '24.0.0' },
        { native: true },
    ])
        assert.throws(() => validateWindowsNativeBuild({ ...build(), ...change }));
    assert.throws(() => assertWindowsNativeCapability(selected, request()), /CAPABILITY_UNISSUED/);
});

test('JSON objects, flags and copied tuples cannot forge native file or process authority', async () => {
    for (const cap of [
        {},
        { native: true },
        { scope: 'native', raw: {} },
        JSON.parse(JSON.stringify(request())),
    ]) {
        assert.throws(() => assertWindowsNativeCapability(cap, request()), /CAPABILITY_UNISSUED/);
        await assert.rejects(pinWindowsNativeFiles(cap), /CAPABILITY_UNISSUED/);
        await assert.rejects(
            observeWindowsNativeProcess(cap, { pid: 4, creationTime100ns: '123' }),
            /CAPABILITY_UNISSUED/,
        );
        assert.throws(() => readWindowsNativeObservation(cap, 'file-pins'), /CAPABILITY_UNISSUED/);
        assert.throws(() => cancelWindowsNativeAuthority(cap), /CAPABILITY_UNISSUED/);
        assert.throws(() => releaseWindowsNativeAuthority(cap), /CAPABILITY_UNISSUED/);
        assert.throws(() => refuseWindowsNativeNormalClose(cap), /CAPABILITY_UNISSUED/);
    }
});

test('invalid selected requests refuse before native loader or filesystem preparation', async () => {
    await assert.rejects(
        prepareWindowsNativeAuthority({ ...request(), root: 'relative' }, build()),
    );
    await assert.rejects(
        prepareWindowsNativeAuthority(request(), { ...build(), binarySHA256: 'invalid' }),
    );
});

test('process observations reject rounded PIDs and overflowing creation identifiers before authority use', () => {
    for (const pid of [0, -1, 1.5, NaN, Infinity, 0x100000000])
        assert.throws(() => observeWindowsNativeProcess({}, { pid, creationTime100ns: '1' }));
    for (const creationTime100ns of [
        '0',
        '01',
        '-1',
        '1.5',
        '18446744073709551616',
        '9'.repeat(21),
    ])
        assert.throws(() => observeWindowsNativeProcess({}, { pid: 4, creationTime100ns }));
});

test('explicit launch inputs are confined data and cannot issue native authority', () => {
    const input = {
        action: 'launch-pinned-installed',
        profile: request().root + '\\native-launch-profile',
    };
    const selected = validateWindowsNativeLaunch(input, request());
    input.profile = 'C:\\elsewhere';
    assert.ok(Object.isFrozen(selected));
    assert.equal(selected.profile, request().root + '\\native-launch-profile');
    for (const change of [
        { action: 'install' },
        { profile: 'C:\\existing-profile' },
        { authorized: true },
    ])
        assert.throws(() => validateWindowsNativeLaunch({ ...selected, ...change }, request()));
    let reads = 0;
    const getter = { ...selected };
    Object.defineProperty(getter, 'profile', {
        enumerable: true,
        get() {
            reads++;
            throw Error('getter');
        },
    });
    assert.throws(() => validateWindowsNativeLaunch(getter, request()));
    assert.equal(reads, 0);
    for (const call of [
        () => launchWindowsNativePinnedProcess({}, selected),
        () => sampleWindowsNativeOwnedProcess({}),
        () => readWindowsNativeOwnedProcess({}),
        () => drainWindowsNativeOwnedStdio({}),
        () => readWindowsNativeMainInspectorEndpoint({}),
        () => requestWindowsNativeNormalQuit({}),
        () => joinWindowsNativeNormalQuitTransport({}),
        () => readWindowsNativeNormalQuit({}),
        () => readWindowsNativeOwnedRelease({}),
        () => releaseWindowsNativeOwnedProcessHandles({}),
    ])
        assert.throws(call, /CAPABILITY_UNISSUED/);
});

// Execute this actual wrapper's JS ownership paths with a closed VM import map.
// Model-native objects are NOT Node-API caps and never enter the production module.
// No target executable/addon/SDK is imported, loaded, compiled, or invoked.
function launchMemory() {
    const source = readFileSync(
        new URL('../scripts/lib/windows-native-authority.mjs', import.meta.url),
        'utf8',
    );
    let replacements = 0;
    const compiled = ts.transpileModule(source, {
        fileName: 'windows-native-authority.cjs',
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        transformers: {
            before: [
                (context) => (file) => {
                    const visit = (node) => {
                        if (
                            ts.isPropertyAccessExpression(node) &&
                            ts.isMetaProperty(node.expression) &&
                            node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
                            node.name.text === 'url'
                        ) {
                            replacements++;
                            return ts.factory.createStringLiteral(
                                'file:///model/scripts/lib/windows-native-authority.mjs',
                            );
                        }
                        return ts.visitEachChild(node, visit, context);
                    };
                    return ts.visitNode(file, visit);
                },
            ],
        },
        reportDiagnostics: true,
    });
    assert.equal(replacements, 1);
    assert.equal(
        (compiled.diagnostics ?? []).filter((x) => x.category === ts.DiagnosticCategory.Error)
            .length,
        0,
    );
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const directory = '/model/tests/native/windows-installer-authority';
    const binary = directory + '/build/Release/windows_installer_authority.node';
    const files = new Map([
        [
            directory + '/authority.cc',
            readFileSync(
                new URL('./native/windows-installer-authority/authority.cc', import.meta.url),
            ),
        ],
        [
            directory + '/binding.gyp',
            readFileSync(
                new URL('./native/windows-installer-authority/binding.gyp', import.meta.url),
            ),
        ],
        [binary, Buffer.from('inert model bytes, never a PE or native module')],
    ]);
    const stat = (file) => {
        assert.ok(files.has(file));
        return {
            dev: 1n,
            ino: BigInt([...files.keys()].indexOf(file) + 1),
            size: BigInt(files.get(file).length),
            mtimeNs: 1n,
            ctimeNs: 1n,
            nlink: 1n,
            isFile: () => true,
            isSymbolicLink: () => false,
        };
    };
    const counts = {
        open: 0,
        close: 0,
        load: 0,
        prepare: 0,
        acquire: 0,
        launch: 0,
        sample: 0,
        drain: 0,
        release: 0,
    };
    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((done, fail) => {
            resolve = done;
            reject = fail;
        });
        return { promise, resolve, reject };
    };
    const acquisitionStarted = deferred(),
        launchStarted = deferred(),
        handleReleaseStarted = deferred(),
        finalizerObserved = deferred(),
        drainStarted = deferred();
    const events = [];
    const readFailure = { enabled: false, error: undefined };
    const io = Object.freeze({
        async realpath(file) {
            assert.ok(files.has(file));
            return file;
        },
        async lstat(file) {
            return stat(file);
        },
        async open(file, flags) {
            assert.equal(flags, 0, 'read-only model open');
            counts.open++;
            if (readFailure.enabled) throw readFailure.error;
            const bytes = files.get(file);
            assert.ok(bytes);
            return {
                async stat() {
                    return stat(file);
                },
                async read(buffer, offset, length, position) {
                    const bytesRead = Math.min(length, bytes.length - position);
                    bytes.copy(buffer, offset, position, position + bytesRead);
                    return { bytesRead };
                },
                async close() {
                    counts.close++;
                },
            };
        },
    });
    const raw = Object.freeze({ modelOnly: true });
    const state = {
        created: false,
        attempted: false,
        returned: false,
        exited: false,
        cancelled: false,
        unknownOutput: false,
        exitCode: 259,
        hostAcquisitionSubmitted: false,
        hostReferenceAcknowledged: false,
        // Model release-ACK bookkeeping only; not a live native reference or event-loop proof.
        lifetimeJoinPending: false,
        handlesClosed: false,
        hostReleaseAcknowledged: false,
        hostFinalizerObserved: false,
        hostFinalizerAcknowledged: false,
        hostEnvironmentClosing: false,
    };
    // Authored pipe facts, not observations of Windows HANDLEs or CreatePipe order.
    // End-of-stream is explicit and independent of the model root's exited flag.
    const capture = {
        configured: false,
        parentChildCopiesClosed: false,
        acquisitionUnknown: false,
        stdout: { bytes: Buffer.alloc(0), eof: false, overflow: false },
        stderr: { bytes: Buffer.alloc(0), eof: false, overflow: false },
    };
    const captureEvents = [];
    const captureFacts = () => ({
        configured: capture.configured,
        parentChildCopiesClosed: capture.parentChildCopiesClosed,
        acquisitionUnknown: capture.acquisitionUnknown,
        stdout: {
            base64: capture.stdout.bytes.toString('base64'),
            eof: capture.stdout.eof,
            overflow: capture.stdout.overflow,
        },
        stderr: {
            base64: capture.stderr.bytes.toString('base64'),
            eof: capture.stderr.eof,
            overflow: capture.stderr.overflow,
        },
    });
    const endStdio = () => {
        capture.stdout.eof = true;
        capture.stderr.eof = true;
    };
    const facts = () => ({
        creationAttempted: state.attempted,
        creationReturned: state.returned,
        createdByThisOwner: state.created,
        processHandleRetained: state.created,
        threadHandleRetained: state.created,
        unconfirmedHandleOutput: state.unknownOutput,
        pid: state.created ? 17 : null,
        threadId: state.created ? 18 : null,
        creationTime100ns: state.created ? '123456789' : null,
        processExitObserved: state.exited,
        exitCode: state.exited ? state.exitCode : null,
        profileEmptyAtPreflight: state.created,
        hostEventLoopReferenceAcknowledged: state.hostReferenceAcknowledged,
        stdioObserved: false,
        physicalLoadedBytesVerified: false,
        physicalDescendantClosure: false,
        releaseAcceptance: false,
    });
    const acquisitionAck = () =>
        JSON.stringify({ created: true, referenced: true, cleanupMarkerRegistered: true });
    const releaseFacts = (override = {}) => {
        const value = {
            ownedHandlesClosed: state.handlesClosed,
            retainedUnknown: true,
            closedCount: state.handlesClosed ? 6 : 5,
            totalCount: 6,
            processOwnership: false,
            physicalDescendantClosure: false,
            releaseAcceptance: false,
            hostLifetimeAcquisitionSubmitted: state.hostAcquisitionSubmitted,
            hostLifetimeReleaseAcknowledged: state.hostReleaseAcknowledged,
            hostLifetimeFinalizerObserved: state.hostFinalizerObserved,
            hostLifetimeFinalizerAcknowledged: state.hostFinalizerAcknowledged,
            hostEnvironmentClosing: state.hostEnvironmentClosing,
            ...override,
        };
        if (!Object.hasOwn(override, 'retainedUnknown'))
            value.retainedUnknown = !(
                value.ownedHandlesClosed &&
                (!value.hostLifetimeAcquisitionSubmitted ||
                    (value.hostLifetimeReleaseAcknowledged &&
                        value.hostLifetimeFinalizerObserved &&
                        value.hostLifetimeFinalizerAcknowledged &&
                        !value.hostEnvironmentClosing))
            );
        return value;
    };
    const native = {
        prepare() {
            counts.prepare++;
            return raw;
        },
        assertCapability(value) {
            assert.equal(value, raw);
            return true;
        },
        async pinFiles() {
            return '{}';
        },
        async observeProcess() {
            throw Error('forbidden PID lookup');
        },
        cancel(value) {
            assert.equal(value, raw);
            state.cancelled = true;
        },
        async release() {
            throw Error('forbidden read-handle release');
        },
        refuseNormalClose() {
            throw Error('WINDOWS_ATOMIC_NORMAL_CLOSE_UNAVAILABLE');
        },
        acquireLaunchLifetime(value) {
            assert.equal(value, raw);
            counts.acquire++;
            state.hostAcquisitionSubmitted = true;
            events.push('acquire-submitted');
            acquisitionStarted.resolve();
            native.onAcquire?.();
            if (native.acquireMode === 'throw') throw native.acquireError;
            if (native.acquireMode === 'reject') return Promise.reject(native.acquireError);
            const acknowledged = () => {
                state.hostReferenceAcknowledged = true;
                state.lifetimeJoinPending = true;
                events.push('acquire-ack');
                return Object.hasOwn(native, 'acquireOutput')
                    ? native.acquireOutput
                    : acquisitionAck();
            };
            return native.acquireGate ? native.acquireGate.then(acknowledged) : acknowledged();
        },
        async launchPinnedProcess(value, profile) {
            assert.equal(value, raw);
            assert.equal(profile, request().root + '\\native-launch-profile');
            counts.launch++;
            events.push('creation-submitted');
            launchStarted.resolve();
            assert.equal(state.hostReferenceAcknowledged, true);
            capture.configured = true;
            capture.parentChildCopiesClosed = true;
            captureEvents.push('model-capture-configured-before-creation');
            native.onCaptureConfigured?.();
            state.attempted = true;
            if (native.launchGate) await native.launchGate;
            state.created = true;
            state.returned = true;
            return JSON.stringify(facts());
        },
        async drainOwnedStdio(value) {
            assert.equal(value, raw);
            counts.drain++;
            drainStarted.resolve();
            if (native.drainGate) await native.drainGate;
            return Object.hasOwn(native, 'drainOutput')
                ? native.drainOutput
                : JSON.stringify(captureFacts());
        },
        async sampleOwnedProcess(value) {
            assert.equal(value, raw);
            counts.sample++;
            return JSON.stringify(facts());
        },
        async releaseOwnedProcessHandles(value) {
            assert.equal(value, raw);
            counts.release++;
            assert.ok(!state.created || state.exited);
            if (native.releaseGate) await native.releaseGate;
            state.handlesClosed = true;
            events.push('handles-ack');
            handleReleaseStarted.resolve();
            if (state.hostAcquisitionSubmitted && state.hostReferenceAcknowledged) {
                state.hostReleaseAcknowledged = true;
                state.hostFinalizerObserved = true;
                events.push('finalizer-observed');
                finalizerObserved.resolve();
                if (native.finalizerGate) await native.finalizerGate;
                state.hostFinalizerAcknowledged = true;
                state.lifetimeJoinPending = false;
                events.push('finalizer-ack');
            }
            return JSON.stringify(releaseFacts());
        },
    };
    // Closed, manually driven ports; never installed on the outer process.
    const quit = {
        endpoint: 'ws://127.0.0.1:43123/01234567-89ab-cdef-0123-456789abcdef',
        sockets: [],
        timers: new Map(),
        requests: [],
        immediateCallbacks: [],
        context: { id: 7, uniqueId: 'model-default-context', auxData: { isDefault: true } },
        identity: { pid: 17, type: 'browser' },
        scheduled: { scheduled: true },
        openState: 1,
        holdReplies: new Set(),
        pendingReplies: new Map(),
        closeMode: 'observed',
        socketCreated: deferred(),
        closeRequested: deferred(),
        deadlineStarted: deferred(),
        pollStarted: deferred(),
        phaseStarted: { enable: deferred(), identity: deferred(), quit: deferred() },
        appQuitCalls: 0,
        timerStarts: 0,
        timerClears: 0,
        listenerAdds: 0,
        listenerRemoves: 0,
        sends: 0,
        closes: 0,
        constructors: 0,
        nextTimer: 0,
    };
    const identityExpression = '(()=>({pid:process.pid,type:process.type}))()';
    const quitExpression =
        '(()=>{const{app}=require("electron");setImmediate(()=>app.quit());return{scheduled:true};})()';
    quit.evaluateFixed = (expression) => {
        assert.ok(expression === identityExpression || expression === quitExpression);
        const realm = vm.createContext(
            {
                process: Object.freeze({ pid: 17, type: 'browser' }),
                require(name) {
                    assert.equal(name, 'electron');
                    return Object.freeze({
                        app: Object.freeze({
                            quit() {
                                quit.appQuitCalls++;
                                quit.onAppQuit?.();
                            },
                        }),
                    });
                },
                setImmediate(callback) {
                    assert.equal(typeof callback, 'function');
                    quit.immediateCallbacks.push(callback);
                },
            },
            { codeGeneration: { strings: false, wasm: false } },
        );
        return new vm.Script(expression, {
            filename: 'fixed-memory-main-inspector-expression.js',
        }).runInContext(realm, { timeout: 1000 });
    };
    quit.runAppQuit = () => {
        assert.equal(quit.immediateCallbacks.length, 1);
        quit.immediateCallbacks.shift()();
    };
    quit.microtasks = async (n = 40) => {
        for (let i = 0; i < n; i++) await Promise.resolve();
    };
    class FakeTimeout {
        constructor(id) {
            this.id = id;
        }
        ref() {
            return this;
        }
        unref() {
            return this;
        }
        hasRef() {
            return true;
        }
        refresh() {
            return this;
        }
        [Symbol.toPrimitive]() {
            return this.id;
        }
    }
    quit.startTimer = (callback, delay) => {
        quit.timerStarts++;
        if (delay === 15000) quit.deadlineStarted.resolve();
        if (delay === 20) quit.pollStarted.resolve();
        quit.onTimer?.(callback, delay);
        const handle = new FakeTimeout(++quit.nextTimer);
        quit.timers.set(handle, { callback, delay });
        if (quit.timerReturnFactory) return quit.timerReturnFactory();
        return Object.hasOwn(quit, 'timerReturn') ? quit.timerReturn : handle;
    };
    quit.stopTimer = (handle) => {
        quit.timerClears++;
        assert.ok(quit.timers.has(handle));
        quit.onClearTimer?.(handle);
        quit.timers.delete(handle);
        return quit.clearReturnFactory ? quit.clearReturnFactory() : quit.clearReturn;
    };
    quit.fireTimer = (delay) => {
        const entries = [...quit.timers].filter(([, entry]) => entry.delay === delay);
        assert.equal(entries.length, 1);
        const [handle, entry] = entries[0];
        quit.timers.delete(handle);
        entry.callback();
    };
    class FakeWebSocket {
        constructor(endpoint) {
            quit.constructors++;
            assert.equal(endpoint, quit.endpoint);
            quit.onConstruct?.();
            this.readyState = quit.openState;
            this.listeners = new Map();
            quit.sockets.push(this);
            quit.socketCreated.resolve(this);
            if (quit.constructorReturnFactory) return quit.constructorReturnFactory();
            if (Object.hasOwn(quit, 'constructorReturn')) return quit.constructorReturn;
        }
        addEventListener(type, callback) {
            quit.listenerAdds++;
            const listeners = this.listeners.get(type) ?? new Set();
            listeners.add(callback);
            this.listeners.set(type, listeners);
            quit.onAdd?.(type, callback, this);
            return quit.addReturn;
        }
        removeEventListener(type, callback) {
            quit.listenerRemoves++;
            quit.onRemove?.(type, callback, this);
            assert.equal(this.listeners.get(type)?.delete(callback), true);
            return quit.removeReturnFactory ? quit.removeReturnFactory() : quit.removeReturn;
        }
        emit(type, event = {}) {
            for (const callback of [...(this.listeners.get(type) ?? [])]) callback(event);
        }
        message(value) {
            this.emit('message', {
                data: typeof value === 'string' ? value : JSON.stringify(value),
            });
        }
        open() {
            this.readyState = 1;
            this.emit('open');
        }
        finishClose() {
            this.readyState = 3;
            this.emit('close');
        }
        send(data) {
            quit.sends++;
            const message = JSON.parse(data);
            assert.equal(typeof data, 'string');
            const phase = message.id === 1 ? 'enable' : message.id === 2 ? 'identity' : 'quit';
            assert.ok(message.id >= 1 && message.id <= 3);
            assert.equal(
                message.method,
                phase === 'enable' ? 'Runtime.enable' : 'Runtime.evaluate',
            );
            quit.requests.push(message);
            quit.phaseStarted[phase].resolve(message);
            quit.onSend?.(message, phase, this);
            const reply = () => {
                if (phase === 'enable') {
                    this.message({
                        method: 'Runtime.executionContextCreated',
                        params: { context: quit.context },
                    });
                    this.message({ id: message.id, result: {} });
                } else {
                    assert.equal(message.params.uniqueContextId, quit.context.uniqueId);
                    assert.equal(Object.hasOwn(message.params, 'contextId'), false);
                    assert.equal(
                        message.params.expression,
                        phase === 'identity' ? identityExpression : quitExpression,
                    );
                    assert.equal(message.params.includeCommandLineAPI, true);
                    assert.equal(message.params.awaitPromise, true);
                    assert.equal(message.params.returnByValue, true);
                    const actual = quit.evaluateFixed(message.params.expression);
                    if (phase === 'identity')
                        assert.deepEqual(JSON.parse(JSON.stringify(actual)), {
                            pid: 17,
                            type: 'browser',
                        });
                    else {
                        assert.deepEqual(JSON.parse(JSON.stringify(actual)), { scheduled: true });
                        assert.equal(quit.appQuitCalls, 0);
                    }
                    this.message({
                        id: message.id,
                        result: {
                            result: {
                                type: 'object',
                                value: phase === 'identity' ? quit.identity : quit.scheduled,
                            },
                        },
                    });
                }
                quit.afterReply?.(message, phase, this);
            };
            if (quit.holdReplies.has(phase)) quit.pendingReplies.set(phase, reply);
            else reply();
            return quit.sendReturnFactory ? quit.sendReturnFactory() : quit.sendReturn;
        }
        close() {
            quit.closes++;
            quit.closeRequested.resolve();
            quit.onClose?.(this);
            this.readyState = 2;
            if (quit.closeMode === 'observed') this.finishClose();
            return quit.closeReturnFactory ? quit.closeReturnFactory() : quit.closeReturn;
        }
    }
    quit.WebSocket = FakeWebSocket;
    quit.reply = (phase) => {
        const callback = quit.pendingReplies.get(phase);
        assert.equal(typeof callback, 'function');
        quit.pendingReplies.delete(phase);
        callback();
    };
    const imports = Object.freeze({
        'node:assert/strict': assert,
        'node:fs': Object.freeze({ constants: Object.freeze({ O_RDONLY: 0 }) }),
        'node:fs/promises': io,
        'node:crypto': Object.freeze({ createHash }),
        'node:process': Object.freeze({
            dlopen(module, filename) {
                assert.equal(filename, binary);
                counts.load++;
                module.exports = native;
            },
        }),
        'node:path': path,
        'node:url': Object.freeze({ fileURLToPath }),
        'node:util': Object.freeze({ types: nativeTypes }),
    });
    const context = vm.createContext(
        {
            Buffer,
            WebSocket: FakeWebSocket,
            setTimeout: quit.startTimer,
            clearTimeout: quit.stopTimer,
            process: Object.freeze({
                platform: 'win32',
                arch: 'x64',
                versions: Object.freeze({ node: '24.22.0' }),
            }),
            module: { exports: {} },
            require(name) {
                assert.ok(Object.hasOwn(imports, name), 'unknown VM import');
                return imports[name];
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    context.exports = context.module.exports;
    new vm.Script(compiled.outputText, {
        filename: 'memory-only-windows-native-authority.cjs',
    }).runInContext(context, { timeout: 1000 });
    const inside = (value) => {
        context.modelJSON = JSON.stringify(value);
        try {
            return new vm.Script('JSON.parse(modelJSON)').runInContext(context, { timeout: 1000 });
        } finally {
            delete context.modelJSON;
        }
    };
    const api = context.module.exports;
    // Actual structuredClone, followed only by plain cloned-container prototype
    // normalization to compensate the VM boundary. Never JSON-copy data/undefined,
    // change assertions, rebrand a cap, or normalize exotic builtins.
    const realmPrototypes = new vm.Script(
        '({object:Object.prototype,array:Array.prototype})',
    ).runInContext(context);
    const cloneIntoRealm = (value) => {
        const copied = structuredClone(value);
        const seen = new WeakSet();
        const rehome = (item) => {
            if (!item || typeof item !== 'object') return;
            const array = Array.isArray(item);
            if (!array && Object.getPrototypeOf(item) !== Object.prototype) return;
            if (seen.has(item)) return;
            seen.add(item);
            for (const key of Reflect.ownKeys(item)) {
                const descriptor = Object.getOwnPropertyDescriptor(item, key);
                if (Object.hasOwn(descriptor, 'value')) rehome(descriptor.value);
            }
            Object.setPrototypeOf(item, array ? realmPrototypes.array : realmPrototypes.object);
        };
        rehome(copied);
        return copied;
    };
    let lifecycle;
    const ownedRuntime = () => {
        if (lifecycle) return lifecycle;
        context.structuredClone = cloneIntoRealm;
        context.TextDecoder = TextDecoder;
        const source = readFileSync(
            new URL('../scripts/lib/windows-native-lifecycle.mjs', import.meta.url),
            'utf8',
        );
        const compiled = ts.transpileModule(source, {
            fileName: 'windows-native-lifecycle.cjs',
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
            reportDiagnostics: true,
        });
        assert.equal(
            (compiled.diagnostics ?? []).filter((x) => x.category === ts.DiagnosticCategory.Error)
                .length,
            0,
        );
        const module = { exports: {} };
        const closed = Object.freeze({
            'node:assert/strict': assert,
            'node:crypto': Object.freeze({ createHash }),
            'node:path': path,
            './windows-setup-release.mjs': Object.freeze({ WINDOWS_SETUP_ASSET }),
            './windows-native-authority.mjs': api,
        });
        const wrapper = new vm.Script(
            '(function(exports,require,module){\n' + compiled.outputText + '\n})',
            { filename: 'actual-memory-windows-native-lifecycle.cjs' },
        ).runInContext(context, { timeout: 1000 });
        wrapper(
            module.exports,
            (name) => {
                assert.ok(Object.hasOwn(closed, name), 'unknown lifecycle VM import');
                return closed[name];
            },
            module,
        );
        lifecycle = module.exports;
        return lifecycle;
    };
    const modelPins = () => ({
        host: { adminMember: false, elevated: false, integrityRid: 8192 },
        files: request().expectedFiles.map((file, index) => ({
            ...file,
            fileId: String(index + 1).repeat(32),
            volumeSerial: 'a'.repeat(16),
        })),
        leaseScope: 'named-executable-and-asar',
        fileLeasesRetained: true,
        physicalLoadedBytesVerified: false,
        releaseAcceptance: false,
    });
    // Opt-in backend data for the new tests only. The original 46 controls keep
    // their unchanged inside-profile model methods. This models the same native
    // export's second fixed command, not a real directory/HANDLE observation.
    let siblingModelUsed = false;
    const useSiblingProfileModel = () => {
        assert.equal(siblingModelUsed, false);
        siblingModelUsed = true;
        const model = {
            submitted: false,
            profiles: [],
            directory: {
                volumeSerial: 'a'.repeat(16),
                fileId: 'b'.repeat(32),
                parentFileId: 'c'.repeat(32),
                emptyAtPreflight: true,
                leaseRetained: true,
            },
        };
        const originalLaunch = native.launchPinnedProcess;
        const originalSample = native.sampleOwnedProcess;
        const siblingFacts = () => ({ ...facts(), profileDirectory: model.directory });
        native.launchPinnedProcess = async (value, profile) => {
            if (profile !== request().root + '.native-launch-profile')
                return originalLaunch(value, profile);
            assert.equal(value, raw);
            model.submitted = true;
            model.profiles.push(profile);
            counts.launch++;
            events.push('creation-submitted');
            launchStarted.resolve();
            assert.equal(state.hostReferenceAcknowledged, true);
            capture.configured = true;
            capture.parentChildCopiesClosed = true;
            captureEvents.push('model-capture-configured-before-creation');
            native.onCaptureConfigured?.();
            state.attempted = true;
            if (native.launchGate) await native.launchGate;
            state.created = true;
            state.returned = true;
            return JSON.stringify(siblingFacts());
        };
        native.sampleOwnedProcess = async (value) => {
            if (!model.submitted) return originalSample(value);
            assert.equal(value, raw);
            counts.sample++;
            return JSON.stringify(siblingFacts());
        };
        return model;
    };
    return {
        api,
        native,
        quit,
        cloneIntoRealm,
        ownedRuntime,
        modelPins,
        useSiblingProfileModel,
        expected() {
            const selected = request();
            return {
                version: '0.6.0',
                sourceCommit: selected.sourceCommit,
                sourceTree: selected.sourceTree,
                runId: selected.runId,
                runAttempt: selected.runAttempt,
                lane: selected.lane,
                artifacts: [selected.package],
            };
        },
        buildInput() {
            return inside({
                ...build(),
                binarySHA256: digest(files.get(binary)),
                sourceSHA256: digest(files.get(directory + '/authority.cc')),
                bindingSHA256: digest(files.get(directory + '/binding.gyp')),
            });
        },
        counts,
        state,
        facts,
        acquisitionAck,
        releaseFacts,
        acquisitionStarted,
        launchStarted,
        handleReleaseStarted,
        finalizerObserved,
        drainStarted,
        capture,
        captureFacts,
        captureEvents,
        endStdio,
        events,
        inside,
        async prepare() {
            const selectedBuild = {
                ...build(),
                binarySHA256: digest(files.get(binary)),
                sourceSHA256: digest(files.get(directory + '/authority.cc')),
                bindingSHA256: digest(files.get(directory + '/binding.gyp')),
            };
            const cap = await api.prepareWindowsNativeAuthority(
                inside(request()),
                inside(selectedBuild),
            );
            await api.pinWindowsNativeFiles(cap);
            assert.equal(counts.open, counts.close);
            return cap;
        },
        async prepareQuit() {
            const cap = await this.prepare();
            await api.launchWindowsNativePinnedProcess(cap, this.input());
            capture.stderr.bytes = Buffer.from('Debugger listening on ' + quit.endpoint + '\r\n');
            await api.drainWindowsNativeOwnedStdio(cap);
            return cap;
        },
        input() {
            return inside({
                action: 'launch-pinned-installed',
                profile: request().root + '\\native-launch-profile',
            });
        },
        failPreparation(error) {
            readFailure.enabled = true;
            readFailure.error = error;
        },
    };
}

test('memory launch uses the actual wrapper snapshot and never represents full lifecycle closure', async () => {
    const m = launchMemory(),
        cap = await m.prepare(),
        input = m.input();
    const launched = m.api.launchWindowsNativePinnedProcess(cap, input);
    input.profile = 'C:\\changed-after-reservation';
    const value = JSON.parse(await launched);
    assert.equal(m.counts.launch, 1);
    assert.equal(value.observation.createdByThisOwner, true);
    assert.equal(value.observation.stdioObserved, false);
    assert.equal(value.observation.releaseAcceptance, false);
    assert.throws(() => m.api.launchWindowsNativePinnedProcess(cap, m.input()), /ALREADY_RESERVED/);
    assert.throws(() => m.api.releaseWindowsNativeAuthority(cap), /OWNED_RELEASE_REQUIRED/);
    assert.throws(
        () => m.api.refuseWindowsNativeNormalClose(cap),
        /ATOMIC_NORMAL_CLOSE_UNAVAILABLE/,
    );
    const copy = m.api.readWindowsNativeOwnedProcess(cap);
    copy.fill(0);
    assert.equal(
        JSON.parse(m.api.readWindowsNativeOwnedProcess(cap)).observation.createdByThisOwner,
        true,
    );
    m.state.exited = true;
    m.endStdio();
    await m.api.drainWindowsNativeOwnedStdio(cap);
    await m.api.sampleWindowsNativeOwnedProcess(cap);
    const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    assert.equal(ack.physicalDescendantClosure, false);
    assert.equal(ack.processOwnership, false);
});

test('memory cancellation before the launch microtask prevents invocation but retains the one-use owner', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    const task = m.api.launchWindowsNativePinnedProcess(cap, m.input());
    m.api.cancelWindowsNativeAuthority(cap);
    await assert.rejects(task, (error) => {
        assert.equal(error.message, 'WINDOWS_NATIVE_PREPARATION_RETAINED');
        assert.equal(error.cause.message, 'WINDOWS_NATIVE_LAUNCH_CANCELLED_RETAINED');
        return true;
    });
    assert.equal(m.counts.launch, 0);
    assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
    const sample = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
    assert.equal(sample.observation.creationAttempted, false);
    await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    assert.equal(m.counts.release, 1);
});

test('memory late creation after cancellation retains returned handles until a real terminal sample', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    let finishLaunch;
    m.native.launchGate = new Promise((resolve) => {
        finishLaunch = resolve;
    });
    const task = m.api.launchWindowsNativePinnedProcess(cap, m.input());
    let finishRelease, releasing;
    try {
        await m.launchStarted.promise;
        assert.equal(m.counts.launch, 1);
        m.api.cancelWindowsNativeAuthority(cap);
        assert.throws(() => m.api.sampleWindowsNativeOwnedProcess(cap), /OPERATION_PENDING/);
        finishLaunch();
        await assert.rejects(task, (error) => {
            assert.equal(error.message, 'WINDOWS_NATIVE_PREPARATION_RETAINED');
            assert.equal(error.cause.message, 'WINDOWS_NATIVE_LAUNCH_CANCELLED_RETAINED');
            return true;
        });
        assert.equal(
            JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap)).observation
                .processHandleRetained,
            true,
        );
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        assert.equal(m.counts.release, 0);
        m.state.exited = true;
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        assert.equal(
            JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap)).observation.exitCode,
            259,
        );
        m.native.releaseGate = new Promise((resolve) => {
            finishRelease = resolve;
        });
        releasing = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), releasing);
        finishRelease();
        await releasing;
        assert.equal(m.counts.release, 1);
    } finally {
        finishLaunch();
        await task.catch(() => {});
        finishRelease?.();
        await releasing?.catch(() => {});
    }
});

test('memory primary errors including undefined survive later sampling failures without new launch', async () => {
    for (const primary of [new Error('first model error'), undefined]) {
        const m = launchMemory(),
            cap = await m.prepare();
        m.native.launchPinnedProcess = () => {
            m.counts.launch++;
            throw primary;
        };
        const error = await m.api.launchWindowsNativePinnedProcess(cap, m.input()).then(
            () => assert.fail('expected failure'),
            (e) => e,
        );
        const custody = error.nativeAuthorityCustody;
        assert.ok(Object.isFrozen(custody));
        assert.equal(custody.retainedAtCapture, true);
        assert.equal(custody.launchReservedAtCapture, true);
        assert.equal(custody.failedAtCapture, true);
        assert.equal(Object.hasOwn(error, 'cause'), true);
        assert.equal(error.cause, primary);
        assert.equal(
            Object.getOwnPropertyDescriptor(error, 'nativeAuthorityCustody').enumerable,
            false,
        );
        assert.equal(JSON.stringify(error), '{}');
        const laterFailure = Error('later model error');
        m.native.sampleOwnedProcess = () => {
            throw laterFailure;
        };
        const later = await m.api.sampleWindowsNativeOwnedProcess(cap).then(
            () => assert.fail('expected later failure'),
            (failure) => failure,
        );
        assert.equal(later.message, 'WINDOWS_NATIVE_LAUNCH_FAILURE_RETAINED');
        assert.equal(Object.hasOwn(later, 'cause'), true);
        assert.equal(later.cause, primary);
        assert.equal(later.errors.length, 2);
        assert.equal(Object.hasOwn(later.errors, '0'), true);
        assert.equal(later.errors[0], primary);
        assert.equal(later.errors[1], laterFailure);
        assert.equal(m.counts.launch, 1);
        m.native.sampleOwnedProcess = async () => JSON.stringify(m.facts());
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    }
});

test('memory malformed creation facts retain custody and cannot enable handle release', async () => {
    for (const mutate of [
        (x) => {
            x.physicalLoadedBytesVerified = true;
        },
        (x) => {
            x.createdByThisOwner = true;
        },
        (x) => {
            x.processExitObserved = true;
            x.exitCode = 0;
        },
        (x) => {
            x.unexpected = true;
        },
    ]) {
        const m = launchMemory(),
            cap = await m.prepare();
        m.native.launchPinnedProcess = async () => {
            const x = m.facts();
            mutate(x);
            return JSON.stringify(x);
        };
        const error = await m.api.launchWindowsNativePinnedProcess(cap, m.input()).then(
            () => assert.fail('expected failure'),
            (e) => e,
        );
        assert.ok(error.nativeAuthorityCustody);
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        assert.equal(m.counts.release, 0);
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    }
});

test('memory non-null unconfirmed failure outputs never count as released or permit retry', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    m.native.launchPinnedProcess = async () => {
        m.state.attempted = true;
        m.state.returned = true;
        m.state.unknownOutput = true;
        throw Error('creation output unknown');
    };
    await assert.rejects(m.api.launchWindowsNativePinnedProcess(cap, m.input()));
    const row = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
    assert.equal(row.observation.unconfirmedHandleOutput, true);
    assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
    assert.throws(() => m.api.launchWindowsNativePinnedProcess(cap, m.input()));
    assert.equal(m.counts.release, 0);
});

test('memory failed or unknown handle release remains once-only and cannot become process retirement', async () => {
    for (const outcome of ['reject', 'unknown', 'malformed']) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.state.exited = true;
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        m.native.releaseOwnedProcessHandles = async () => {
            m.counts.release++;
            if (outcome === 'reject') throw Error('unconfirmed CloseHandle');
            return JSON.stringify({
                ownedHandlesClosed: false,
                retainedUnknown: true,
                closedCount: 5,
                totalCount: 6,
                processOwnership: false,
                physicalDescendantClosure: outcome === 'malformed',
                releaseAcceptance: false,
                hostLifetimeAcquisitionSubmitted: m.state.hostAcquisitionSubmitted,
                hostLifetimeReleaseAcknowledged: false,
                hostLifetimeFinalizerObserved: false,
                hostLifetimeFinalizerAcknowledged: false,
                hostEnvironmentClosing: false,
            });
        };
        const task = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        if (outcome === 'unknown') assert.equal((await task).retainedUnknown, true);
        else await assert.rejects(task);
        assert.equal(m.counts.release, 1);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        assert.throws(() => m.api.readWindowsNativeOwnedProcess(cap));
    }
});

test('memory failed preparation exposes no authority record or replaceable native ports', async () => {
    const m = launchMemory();
    m.failPreparation(new Error('model pre-native read refusal'));
    const error = await m.prepare().then(
        () => assert.fail('preparation must fail'),
        (failure) => failure,
    );
    assert.equal(m.counts.load, 0);
    assert.equal(m.counts.prepare, 0);
    const custody = error.nativeAuthorityCustody;
    assert.ok(custody && typeof custody === 'object');
    // Exercise the actual old escape rather than merely checking a field name:
    // replacing public ports/flags must never recover a wrapper-branded capability.
    const counterfeit = { assertCapability: () => true, pinFiles: async () => '{"forged":true}' };
    for (const candidate of [custody, { ...custody }]) {
        for (const [key, value] of [
            ['native', counterfeit],
            ['raw', Object.freeze({ modelOnly: true })],
            ['failed', false],
            ['cancelled', false],
            ['invalidated', false],
            ['pending', new Set()],
            ['rows', new Map()],
        ])
            Reflect.set(candidate, key, value);
        const cap = candidate.cap ?? candidate;
        assert.throws(
            () => m.api.assertWindowsNativeCapability(cap, m.inside(request())),
            /CAPABILITY_UNISSUED/,
        );
        await assert.rejects(m.api.pinWindowsNativeFiles(cap), /CAPABILITY_UNISSUED/);
        assert.throws(
            () => m.api.readWindowsNativeObservation(cap, 'file-pins'),
            /CAPABILITY_UNISSUED/,
        );
        assert.throws(
            () => m.api.launchWindowsNativePinnedProcess(cap, m.input()),
            /CAPABILITY_UNISSUED/,
        );
    }
    assert.ok(Object.isFrozen(custody));
    assert.deepEqual(Object.keys(custody).sort(), [
        'cancelledAtCapture',
        'failedAtCapture',
        'launchReservedAtCapture',
        'pendingOperationsAtCapture',
        'readCustodiesAtCapture',
        'retainedAtCapture',
    ]);
    for (const value of Object.values(custody))
        assert.ok(typeof value === 'boolean' || typeof value === 'number');
    assert.equal(
        Object.getOwnPropertyDescriptor(error, 'nativeAuthorityCustody').enumerable,
        false,
    );
    assert.equal(JSON.stringify(error), '{}');
    assert.equal(m.counts.load, 0);
    assert.equal(m.counts.prepare, 0);
    assert.equal(m.counts.launch, 0);
});

test('memory host lifetime acquisition precedes creation for synchronous and held acknowledgements', async () => {
    for (const held of [false, true]) {
        const m = launchMemory(),
            cap = await m.prepare();
        let acknowledge;
        if (held)
            m.native.acquireGate = new Promise((resolve) => {
                acknowledge = resolve;
            });
        m.native.onAcquire = () => {
            assert.equal(m.counts.launch, 0);
            assert.throws(() => m.api.sampleWindowsNativeOwnedProcess(cap), /OPERATION_PENDING/);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /OPERATION_PENDING/,
            );
            assert.throws(() => m.api.releaseWindowsNativeAuthority(cap), /OWNED_RELEASE_REQUIRED/);
            assert.equal(m.counts.release, 0);
        };
        const task = m.api.launchWindowsNativePinnedProcess(cap, m.input());
        void task.catch(() => {});
        try {
            await m.acquisitionStarted.promise;
            assert.equal(m.counts.acquire, 1);
            assert.equal(m.counts.launch, 0);
            if (held) {
                assert.equal(m.state.hostReferenceAcknowledged, false);
                acknowledge();
            }
            const row = JSON.parse(await task);
            assert.equal(row.kind, 'windows-native-created-process/v2');
            assert.equal(row.observation.hostEventLoopReferenceAcknowledged, true);
            assert.equal(row.observation.createdByThisOwner, true);
            assert.deepEqual(m.events.slice(0, 3), [
                'acquire-submitted',
                'acquire-ack',
                'creation-submitted',
            ]);
            assert.equal(m.counts.launch, 1);
            assert.equal(row.observation.releaseAcceptance, false);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /LIVE_OR_UNKNOWN/,
            );
            m.state.exited = true;
            m.endStdio();
            await m.api.drainWindowsNativeOwnedStdio(cap);
            await m.api.sampleWindowsNativeOwnedProcess(cap);
            const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
            assert.equal(ack.hostLifetimeFinalizerAcknowledged, true);
            assert.equal(ack.physicalDescendantClosure, false);
        } finally {
            acknowledge?.();
            await task.catch(() => {});
        }
    }
});

test('memory rejected or malformed lifetime acquisition cannot create a process or discard original custody', async () => {
    for (const mode of ['throw', 'reject'])
        for (const primary of [Error('private acquisition error'), undefined]) {
            const m = launchMemory(),
                cap = await m.prepare();
            m.native.acquireMode = mode;
            m.native.acquireError = primary;
            const failure = await m.api.launchWindowsNativePinnedProcess(cap, m.input()).then(
                () => assert.fail('acquisition must fail'),
                (error) => error,
            );
            assert.equal(Object.hasOwn(failure, 'cause'), true);
            assert.equal(failure.cause, primary);
            assert.equal(failure.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(failure.nativeAuthorityCustody.launchReservedAtCapture, true);
            assert.equal(JSON.stringify(failure), '{}');
            assert.equal(m.counts.acquire, 1);
            assert.equal(m.counts.launch, 0);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /LIVE_OR_UNKNOWN/,
            );
            const row = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
            assert.equal(row.observation.creationAttempted, false);
            assert.equal(row.observation.hostEventLoopReferenceAcknowledged, false);
            const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
            assert.equal(ack.retainedUnknown, true);
            assert.equal(ack.hostLifetimeFinalizerAcknowledged, false);
            assert.equal(ack.releaseAcceptance, false);
            assert.equal(m.counts.release, 1);
        }
    for (const output of [
        {},
        '',
        'PRIVATE_HOST_ACK',
        'x'.repeat(4097),
        JSON.stringify({ created: false, referenced: true, cleanupMarkerRegistered: true }),
        JSON.stringify({ created: true, referenced: 1, cleanupMarkerRegistered: true }),
        JSON.stringify({ created: true, referenced: true }),
        JSON.stringify({
            created: true,
            referenced: true,
            cleanupMarkerRegistered: true,
            extra: true,
        }),
    ]) {
        const m = launchMemory(),
            cap = await m.prepare();
        m.native.acquireOutput = output;
        await assert.rejects(m.api.launchWindowsNativePinnedProcess(cap, m.input()), (error) => {
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(error.nativeAuthorityCustody.failedAtCapture, true);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.equal(m.counts.acquire, 1);
        assert.equal(m.counts.launch, 0);
        assert.throws(() => m.api.launchWindowsNativePinnedProcess(cap, m.input()));
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(ack.processOwnership, false);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(m.counts.release, 1);
    }
});

test('memory late lifetime acknowledgement after cancellation needs actual noncreation sampling and explicit release', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    let acknowledge, finishFinalizer, release;
    m.native.acquireGate = new Promise((resolve) => {
        acknowledge = resolve;
    });
    const task = m.api.launchWindowsNativePinnedProcess(cap, m.input());
    void task.catch(() => {});
    try {
        await m.acquisitionStarted.promise;
        assert.equal(m.counts.acquire, 1);
        assert.equal(m.counts.launch, 0);
        m.api.cancelWindowsNativeAuthority(cap);
        assert.throws(() => m.api.sampleWindowsNativeOwnedProcess(cap), /OPERATION_PENDING/);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /OPERATION_PENDING/,
        );
        assert.throws(() => m.api.releaseWindowsNativeAuthority(cap), /OWNED_RELEASE_REQUIRED/);
        assert.equal(m.counts.release, 0);
        acknowledge();
        await assert.rejects(task, (error) => {
            assert.equal(error.cause.message, 'WINDOWS_NATIVE_LAUNCH_CANCELLED_RETAINED');
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            return true;
        });
        assert.equal(m.state.lifetimeJoinPending, true);
        assert.equal(m.counts.launch, 0);
        assert.equal(m.counts.release, 0);
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        const row = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
        assert.equal(row.observation.creationAttempted, false);
        assert.equal(row.observation.createdByThisOwner, false);
        assert.equal(row.observation.hostEventLoopReferenceAcknowledged, true);
        m.native.finalizerGate = new Promise((resolve) => {
            finishFinalizer = resolve;
        });
        release = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), release);
        await m.finalizerObserved.promise;
        assert.equal(m.state.lifetimeJoinPending, true);
        assert.equal(m.state.hostFinalizerAcknowledged, false);
        finishFinalizer();
        const ack = await release;
        assert.equal(ack.hostLifetimeAcquisitionSubmitted, true);
        assert.equal(ack.hostLifetimeFinalizerAcknowledged, true);
        assert.equal(ack.retainedUnknown, false);
        assert.equal(ack.processOwnership, false);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(m.counts.acquire, 1);
        assert.equal(m.counts.release, 1);
    } finally {
        acknowledge();
        await task.catch(() => {});
        finishFinalizer?.();
        await release?.catch(() => {});
    }
});

test('memory handle acknowledgement alone cannot release private custody before the finalizer acknowledgement', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    await m.api.launchWindowsNativePinnedProcess(cap, m.input());
    m.state.exited = true;
    m.endStdio();
    await m.api.drainWindowsNativeOwnedStdio(cap);
    await m.api.sampleWindowsNativeOwnedProcess(cap);
    let finishFinalizer;
    m.native.finalizerGate = new Promise((resolve) => {
        finishFinalizer = resolve;
    });
    const task = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    let settled = false;
    void task.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    try {
        await m.finalizerObserved.promise;
        assert.equal(m.state.handlesClosed, true);
        assert.equal(m.state.hostFinalizerObserved, true);
        assert.equal(m.state.hostFinalizerAcknowledged, false);
        assert.equal(m.state.lifetimeJoinPending, true);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        await Promise.resolve();
        assert.equal(settled, false);
        // Observe the actual private retained Set through its bounded public owner limit;
        // no private export/issuer is added. All32 owners and IO ports are memory models.
        for (let i = 0; i < 31; i++) await m.prepare();
        const beforeOpen = m.counts.open;
        await assert.rejects(m.prepare(), /OWNER_LIMIT/);
        assert.equal(m.counts.open, beforeOpen);
        finishFinalizer();
        const ack = await task;
        assert.equal(ack.ownedHandlesClosed, true);
        assert.equal(ack.hostLifetimeReleaseAcknowledged, true);
        assert.equal(ack.hostLifetimeFinalizerObserved, true);
        assert.equal(ack.hostLifetimeFinalizerAcknowledged, true);
        assert.equal(ack.hostEnvironmentClosing, false);
        assert.equal(ack.retainedUnknown, false);
        assert.equal(ack.physicalDescendantClosure, false);
        assert.equal(ack.releaseAcceptance, false);
        const next = await m.prepare(); // Exactly one slot becomes available only after full ACK.
        assert.equal(m.api.assertWindowsNativeCapability(next, m.inside(request())), true);
        assert.equal(m.counts.release, 1);
    } finally {
        finishFinalizer();
        await task.catch(() => {});
    }
});

test('memory forced unknown and contradictory finalizer acknowledgements never permit release qualification or retries', async () => {
    for (const mode of [
        'observed-only',
        'forced-environment',
        'no-observation',
        'no-release',
        'environment-ack',
        'forged-no-acquisition',
        'type',
        'missing',
        'reject',
    ]) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.state.exited = true;
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const later = Error('private finalizer error');
        m.native.releaseOwnedProcessHandles = async () => {
            m.counts.release++;
            if (mode === 'reject') throw later;
            const row = m.releaseFacts({
                ownedHandlesClosed: true,
                closedCount: 6,
                hostLifetimeReleaseAcknowledged: true,
                hostLifetimeFinalizerObserved: true,
                hostLifetimeFinalizerAcknowledged: false,
                hostEnvironmentClosing: mode === 'forced-environment',
            });
            if (mode === 'no-observation') {
                row.hostLifetimeFinalizerObserved = false;
                row.hostLifetimeFinalizerAcknowledged = true;
            }
            if (mode === 'no-release') {
                row.hostLifetimeReleaseAcknowledged = false;
                row.hostLifetimeFinalizerAcknowledged = true;
            }
            if (mode === 'environment-ack') {
                row.hostEnvironmentClosing = true;
                row.hostLifetimeFinalizerAcknowledged = true;
            }
            if (mode === 'forged-no-acquisition') {
                row.hostLifetimeAcquisitionSubmitted = false;
                row.hostLifetimeReleaseAcknowledged = false;
                row.hostLifetimeFinalizerObserved = false;
                row.retainedUnknown = false;
            }
            if (mode === 'type') row.hostLifetimeFinalizerAcknowledged = 1;
            if (mode === 'missing') delete row.hostLifetimeFinalizerObserved;
            return JSON.stringify(row);
        };
        const task = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        if (['observed-only', 'forced-environment'].includes(mode)) {
            const ack = await task;
            assert.equal(ack.ownedHandlesClosed, true);
            assert.equal(ack.retainedUnknown, true);
            assert.equal(ack.hostLifetimeFinalizerAcknowledged, false);
            assert.equal(ack.releaseAcceptance, false);
            assert.ok(Object.isFrozen(ack));
            if (mode === 'observed-only') {
                for (let i = 0; i < 31; i++) await m.prepare();
                const beforeOpen = m.counts.open;
                await assert.rejects(m.prepare(), /OWNER_LIMIT/);
                assert.equal(m.counts.open, beforeOpen);
            }
            m.state.hostFinalizerAcknowledged = true;
            assert.equal(
                (await m.api.releaseWindowsNativeOwnedProcessHandles(cap)).retainedUnknown,
                true,
            );
        } else
            await assert.rejects(task, (error) => {
                assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
                assert.equal(error.nativeAuthorityCustody.failedAtCapture, true);
                if (mode === 'reject') assert.equal(error.cause, later);
                return true;
            });
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        assert.equal(m.counts.release, 1);
        assert.equal(m.counts.launch, 1);
        assert.throws(() => m.api.readWindowsNativeOwnedProcess(cap));
    }
});

test('memory original creation failures including undefined survive later composite finalizer rejection', async () => {
    for (const primary of [Error('first creation error'), undefined]) {
        const m = launchMemory(),
            cap = await m.prepare();
        m.native.launchPinnedProcess = () => {
            m.counts.launch++;
            throw primary;
        };
        const first = await m.api.launchWindowsNativePinnedProcess(cap, m.input()).then(
            () => assert.fail('creation must fail'),
            (error) => error,
        );
        assert.equal(first.cause, primary);
        assert.equal(first.nativeAuthorityCustody.retainedAtCapture, true);
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const later = Error('later finalizer error');
        m.native.releaseOwnedProcessHandles = () => {
            m.counts.release++;
            throw later;
        };
        const task = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        await assert.rejects(task, (error) => {
            assert.equal(error.message, 'WINDOWS_NATIVE_LAUNCH_FAILURE_RETAINED');
            assert.equal(Object.hasOwn(error, 'cause'), true);
            assert.equal(error.cause, primary);
            assert.equal(error.errors.length, 2);
            assert.equal(Object.hasOwn(error.errors, '0'), true);
            assert.equal(error.errors[0], primary);
            assert.equal(error.errors[1], later);
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        assert.equal(m.counts.acquire, 1);
        assert.equal(m.counts.launch, 1);
        assert.equal(m.counts.release, 1);
    }
});

test('memory created process observations require the acknowledged host reference without promoting native qualification', async () => {
    for (const phase of ['launch', 'sample']) {
        const m = launchMemory(),
            cap = await m.prepare();
        if (phase === 'launch') {
            const original = m.native.launchPinnedProcess;
            m.native.launchPinnedProcess = async (...args) => {
                const value = JSON.parse(await original(...args));
                value.hostEventLoopReferenceAcknowledged = false;
                return JSON.stringify(value);
            };
            await assert.rejects(
                m.api.launchWindowsNativePinnedProcess(cap, m.input()),
                (error) => {
                    assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
                    return true;
                },
            );
        } else {
            await m.api.launchWindowsNativePinnedProcess(cap, m.input());
            m.native.sampleOwnedProcess = async () =>
                JSON.stringify({ ...m.facts(), hostEventLoopReferenceAcknowledged: false });
            await assert.rejects(m.api.sampleWindowsNativeOwnedProcess(cap), (error) => {
                assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
                return true;
            });
        }
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        m.native.sampleOwnedProcess = async () => JSON.stringify(m.facts());
        m.state.exited = true;
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        const row = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
        assert.equal(row.observation.hostEventLoopReferenceAcknowledged, true);
        assert.equal(row.observation.physicalLoadedBytesVerified, false);
        assert.equal(row.observation.physicalDescendantClosure, false);
        assert.equal(row.observation.releaseAcceptance, false);
        const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(ack.hostLifetimeFinalizerAcknowledged, true);
        assert.equal(ack.processOwnership, false);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(m.counts.launch, 1);
    }
});

// These tests execute the actual JS wrapper with authored pipe/owner facts only.
// They do not test CreatePipe/ReadFile ordering, native handles, TSFN, or a target.
test('memory owned stdio needs explicit independent EOF as well as a terminal root sample', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    m.native.onCaptureConfigured = () => {
        assert.equal(m.state.attempted, false);
        assert.equal(m.capture.configured, true);
        assert.equal(m.capture.parentChildCopiesClosed, true);
    };
    await m.api.launchWindowsNativePinnedProcess(cap, m.input());
    assert.deepEqual(m.captureEvents, ['model-capture-configured-before-creation']);
    assert.equal(m.counts.drain, 0); // Creation and sampling do not poll pipes.
    const empty = await m.api.drainWindowsNativeOwnedStdio(cap);
    assert.deepEqual(JSON.parse(JSON.stringify(empty)), {
        configured: true,
        parentChildCopiesClosed: true,
        acquisitionUnknown: false,
        stdout: { bytesRetained: 0, eof: false, overflow: false },
        stderr: { bytesRetained: 0, eof: false, overflow: false },
        mainInspectorEndpointObserved: false,
    });
    assert.ok(
        Object.isFrozen(empty) && Object.isFrozen(empty.stdout) && Object.isFrozen(empty.stderr),
    );
    m.endStdio();
    await m.api.drainWindowsNativeOwnedStdio(cap);
    assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
    assert.equal(m.counts.release, 0); // EOF is not root exit.
    m.state.exited = true;
    await m.api.sampleWindowsNativeOwnedProcess(cap);
    const release = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), release);
    assert.equal((await release).releaseAcceptance, false);
    assert.equal(m.counts.release, 1);

    const n = launchMemory(),
        other = await n.prepare();
    await n.api.launchWindowsNativePinnedProcess(other, n.input());
    n.state.exited = true;
    await n.api.sampleWindowsNativeOwnedProcess(other);
    assert.throws(() => n.api.releaseWindowsNativeOwnedProcessHandles(other), /STDIO_EOF_REQUIRED/);
    await n.api.drainWindowsNativeOwnedStdio(other);
    assert.throws(() => n.api.releaseWindowsNativeOwnedProcessHandles(other), /STDIO_EOF_REQUIRED/);
    n.capture.stdout.eof = true;
    await n.api.drainWindowsNativeOwnedStdio(other);
    assert.throws(() => n.api.releaseWindowsNativeOwnedProcessHandles(other), /STDIO_EOF_REQUIRED/);
    assert.equal(n.counts.release, 0); // Root exit and one EOF are insufficient.
    n.capture.stderr.eof = true;
    await n.api.drainWindowsNativeOwnedStdio(other);
    assert.equal(
        (await n.api.releaseWindowsNativeOwnedProcessHandles(other)).retainedUnknown,
        false,
    );
});

test('memory partial null or unknown pipe observations cannot authorize owned release', async () => {
    for (const mode of ['partial', 'null', 'unknown', 'noncreation-unknown']) {
        const m = launchMemory(),
            cap = await m.prepare();
        const launch = m.api.launchWindowsNativePinnedProcess(cap, m.input());
        let originalCancellation;
        if (mode === 'noncreation-unknown') {
            m.api.cancelWindowsNativeAuthority(cap);
            const cancelled = await launch.then(
                () => assert.fail('launch must be cancelled'),
                (error) => error,
            );
            originalCancellation = cancelled.cause ?? cancelled;
            assert.match(originalCancellation.message, /LAUNCH_CANCELLED_RETAINED/);
        } else {
            await launch;
            m.state.exited = true;
        }
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        if (mode === 'partial') m.capture.parentChildCopiesClosed = false;
        if (mode === 'null') m.native.drainOutput = 'null';
        if (mode.endsWith('unknown')) m.capture.acquisitionUnknown = true;
        const failure = await m.api.drainWindowsNativeOwnedStdio(cap).then(
            () => assert.fail('partial/unknown capture must refuse'),
            (error) => error,
        );
        assert.equal(failure.nativeAuthorityCustody.retainedAtCapture, true);
        if (mode === 'noncreation-unknown') {
            assert.equal(failure.cause, originalCancellation);
            assert.equal(failure.errors[0], originalCancellation);
            assert.match(failure.errors[1].message, /STDIO_ACQUISITION_UNKNOWN/);
        } else
            assert.match(
                (failure.cause ?? failure).message,
                mode === 'partial'
                    ? /CHILD_COPY_UNKNOWN/
                    : mode === 'null'
                      ? /STDIO_SHAPE/
                      : /STDIO_ACQUISITION_UNKNOWN/,
            );
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /STDIO_OBSERVATION_UNKNOWN/,
        );
        assert.equal(m.counts.release, 0);
        assert.throws(() => m.api.launchWindowsNativePinnedProcess(cap, m.input()));
        if (mode.endsWith('unknown')) {
            m.capture.acquisitionUnknown = false;
            const later = await m.api.drainWindowsNativeOwnedStdio(cap).then(
                () => assert.fail('unknown acquisition must not reset'),
                (error) => error,
            );
            assert.match(later.errors[1].message, /STDIO_UNKNOWN_CHANGED/);
            assert.equal(later.errors[0], originalCancellation ?? failure.cause ?? failure);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /STDIO_OBSERVATION_UNKNOWN/,
            );
            assert.equal(m.counts.release, 0);
        }
        assert.equal(JSON.stringify(failure), '{}');
    }
});

test('memory cumulative stdio validates both 64KiB bounds canonical base64 and retained prefixes', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    await m.api.launchWindowsNativePinnedProcess(cap, m.input());
    m.capture.stdout.bytes = Buffer.alloc(65536, 65);
    m.capture.stderr.bytes = Buffer.alloc(65536, 66);
    const full = await m.api.drainWindowsNativeOwnedStdio(cap);
    assert.equal(full.stdout.bytesRetained, 65536);
    assert.equal(full.stderr.bytesRetained, 65536);
    assert.equal(full.stdout.overflow, false);
    assert.equal(m.api.readWindowsNativeOwnedProcess(cap).includes(Buffer.from('AAAAAA')), false);
    m.endStdio();
    await m.api.drainWindowsNativeOwnedStdio(cap);
    m.state.exited = true;
    await m.api.sampleWindowsNativeOwnedProcess(cap);
    assert.equal(
        (await m.api.releaseWindowsNativeOwnedProcessHandles(cap)).releaseAcceptance,
        false,
    );
    for (const [change, code] of [
        [
            (row) => {
                row.stdout.base64 = Buffer.alloc(65537).toString('base64');
            },
            /STDIO_BOUND/,
        ],
        [
            (row) => {
                row.stderr.base64 = Buffer.alloc(65537).toString('base64');
            },
            /STDIO_BOUND/,
        ],
        [
            (row) => {
                row.stdout.base64 = 'AB==';
            },
            /STDIO_ENCODING/,
        ],
        [
            (row) => {
                row.stderr.base64 = 'YQ';
            },
            /STDIO_ENCODING/,
        ],
        [
            (row) => {
                row.stdout.base64 = 'YQ==\n';
            },
            /STDIO_ENCODING/,
        ],
        [
            (row) => {
                row.stdout.overflow = true;
            },
            /STDIO_OVERFLOW_SHAPE/,
        ],
        [
            (row) => {
                row.stderr.extra = true;
            },
            /STDIO_SHAPE/,
        ],
        [
            (row) => {
                row.configured = 1;
            },
            /STDIO_SHAPE/,
        ],
    ]) {
        const n = launchMemory(),
            other = await n.prepare();
        await n.api.launchWindowsNativePinnedProcess(other, n.input());
        const row = n.captureFacts();
        change(row);
        n.native.drainOutput = JSON.stringify(row);
        await assert.rejects(n.api.drainWindowsNativeOwnedStdio(other), (error) => {
            assert.match((error.cause ?? error).message, code);
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            return true;
        });
        assert.equal(n.counts.release, 0);
    }
    for (const replacement of [Buffer.from('xb'), Buffer.from('a')]) {
        const n = launchMemory(),
            other = await n.prepare();
        await n.api.launchWindowsNativePinnedProcess(other, n.input());
        n.capture.stdout.bytes = Buffer.from('ab');
        n.capture.stderr.bytes = Buffer.from('stderr is independent');
        await n.api.drainWindowsNativeOwnedStdio(other);
        n.capture.stdout.bytes = replacement;
        await assert.rejects(n.api.drainWindowsNativeOwnedStdio(other), (error) => {
            assert.match((error.cause ?? error).message, /STDIO_PREFIX_CHANGED/);
            return true;
        });
    }
});

test('memory EOF and overflow stay sticky while overflow may later join component-only release', async () => {
    for (const change of [
        (stream) => {
            stream.eof = false;
        },
        (stream) => {
            stream.bytes = Buffer.from('ab');
        },
    ]) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.capture.stdout.bytes = Buffer.from('a');
        m.capture.stdout.eof = true;
        await m.api.drainWindowsNativeOwnedStdio(cap);
        change(m.capture.stdout);
        await assert.rejects(m.api.drainWindowsNativeOwnedStdio(cap), (error) => {
            assert.match((error.cause ?? error).message, /STDIO_EOF_CHANGED/);
            return true;
        });
    }
    for (const rollback of [false, true]) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.capture.stdout.bytes = Buffer.alloc(65536, 65);
        m.capture.stdout.overflow = true;
        const first = await m.api.drainWindowsNativeOwnedStdio(cap).then(
            () => assert.fail('overflow must fail capture'),
            (error) => error,
        );
        const primary = first.cause ?? first;
        assert.match(primary.message, /STDIO_CAPTURE_OVERFLOW/);
        assert.equal(first.nativeAuthorityCustody.retainedAtCapture, true);
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /NOT_ACTIVE/);
        m.state.exited = true;
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /STDIO_EOF_REQUIRED/,
        );
        m.endStdio();
        if (rollback) {
            m.capture.stdout.overflow = false;
            await assert.rejects(m.api.drainWindowsNativeOwnedStdio(cap), (error) => {
                assert.equal(error.cause, primary);
                assert.equal(error.errors[0], primary);
                assert.match(error.errors[1].message, /STDIO_OVERFLOW_CHANGED/);
                return true;
            });
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /STDIO_OBSERVATION_UNKNOWN/,
            );
            m.capture.stdout.overflow = true;
        }
        await assert.rejects(m.api.drainWindowsNativeOwnedStdio(cap), (error) => {
            assert.equal(error.cause, primary);
            assert.match(error.errors[1].message, /STDIO_CAPTURE_OVERFLOW/);
            return true;
        });
        assert.equal(m.counts.release, 0);
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /NOT_ACTIVE/);
        const task = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        const ack = await task;
        assert.equal(ack.retainedUnknown, false); // Only component HANDLE/finalizer ACK.
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(ack.physicalDescendantClosure, false);
        assert.equal(m.counts.release, 1);
        assert.equal(first.nativeAuthorityCustody.failedAtCapture, true);
    }
});

test('memory private inspector parsing handles fragmented CRLF without publishing raw bytes or reparsing lines', async () => {
    const endpoint = 'ws://127.0.0.1:43123/01234567-89ab-cdef-0123-456789abcdef';
    const line = 'Debugger listening on ' + endpoint;
    for (const ending of ['\r\n', '']) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.capture.stderr.bytes = Buffer.from(line.slice(0, 37));
        const partial = await m.api.drainWindowsNativeOwnedStdio(cap);
        assert.equal(partial.mainInspectorEndpointObserved, false);
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /ENDPOINT_MISSING/);
        m.capture.stderr.bytes = Buffer.from(line + ending);
        if (!ending) m.capture.stderr.eof = true;
        const complete = await m.api.drainWindowsNativeOwnedStdio(cap);
        assert.equal(complete.mainInspectorEndpointObserved, true);
        assert.equal(m.api.readWindowsNativeMainInspectorEndpoint(cap), endpoint);
        const repeated = await m.api.drainWindowsNativeOwnedStdio(cap);
        assert.equal(repeated.mainInspectorEndpointObserved, true); // Same cumulative line is not duplicate.
        m.capture.stderr.bytes = Buffer.from(line + ending + (ending ? 'ordinary log\r\n' : ''));
        const later = await m.api.drainWindowsNativeOwnedStdio(cap);
        assert.equal(later.mainInspectorEndpointObserved, true);
        assert.ok(Object.isFrozen(later) && Object.isFrozen(later.stderr));
        const publicBytes =
            JSON.stringify(later) + m.api.readWindowsNativeOwnedProcess(cap).toString();
        for (const secret of [
            endpoint,
            '01234567-89ab-cdef-0123-456789abcdef',
            'Debugger listening on',
            line,
            Buffer.from(line).toString('base64'),
        ])
            assert.equal(publicBytes.includes(secret), false);
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        m.state.exited = true;
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        assert.equal(
            (await m.api.releaseWindowsNativeOwnedProcessHandles(cap)).releaseAcceptance,
            false,
        );
    }
});

test('memory malformed duplicate and conflicting inspector candidates refuse without leaking private endpoints', async () => {
    const endpoint = 'ws://127.0.0.1:43123/01234567-89ab-cdef-0123-456789abcdef';
    const prefix = 'Debugger listening on ';
    const candidates = [
        endpoint.replace('127.0.0.1', 'localhost'),
        endpoint.replace('127.0.0.1', '[::1]'),
        endpoint.replace('43123', '0'),
        endpoint.replace('43123', '65536'),
        endpoint.replace('43123', '043123'),
        endpoint.replace('127.0.0.1', 'user:PRIVATE@127.0.0.1'),
        endpoint + '?PRIVATE=1',
        endpoint + '#PRIVATE',
        endpoint.replace('ws:', 'wss:'),
        endpoint.replace('abcdef', 'abcdeg'),
        endpoint + '/PRIVATE',
        endpoint + '\r',
        endpoint + '\u0000PRIVATE',
    ];
    for (const candidate of candidates) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.capture.stderr.bytes = Buffer.from(prefix + candidate + '\r\n');
        await assert.rejects(m.api.drainWindowsNativeOwnedStdio(cap), (error) => {
            assert.match((error.cause ?? error).message, /INSPECTOR_ENDPOINT_INVALID/);
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(error.message.includes(candidate), false);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /NOT_ACTIVE/);
        assert.equal(
            m.api.readWindowsNativeOwnedProcess(cap).includes(Buffer.from('Debugger listening on')),
            false,
        );
    }
    for (const second of [endpoint, endpoint.replace('43123', '43124')]) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.capture.stderr.bytes = Buffer.from(prefix + endpoint + '\n');
        await m.api.drainWindowsNativeOwnedStdio(cap);
        m.capture.stderr.bytes = Buffer.from(prefix + endpoint + '\n' + prefix + second + '\n');
        await assert.rejects(m.api.drainWindowsNativeOwnedStdio(cap), (error) => {
            assert.match((error.cause ?? error).message, /INSPECTOR_ENDPOINT_DUPLICATE/);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /NOT_ACTIVE/);
    }
});

test('memory explicit serial drains retain late results after cancellation without polling or releasing early', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    await m.api.launchWindowsNativePinnedProcess(cap, m.input());
    let acknowledge;
    m.native.drainGate = new Promise((resolve) => {
        acknowledge = resolve;
    });
    const task = m.api.drainWindowsNativeOwnedStdio(cap);
    void task.catch(() => {});
    try {
        await m.drainStarted.promise;
        assert.equal(m.counts.drain, 1);
        assert.throws(() => m.api.drainWindowsNativeOwnedStdio(cap), /OPERATION_PENDING/);
        assert.throws(() => m.api.sampleWindowsNativeOwnedProcess(cap), /OPERATION_PENDING/);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /OPERATION_PENDING/,
        );
        m.api.cancelWindowsNativeAuthority(cap);
        m.capture.stdout.bytes = Buffer.from('late private stdout');
        m.endStdio();
        acknowledge();
        const late = await task;
        assert.equal(late.stdout.bytesRetained, 19);
        assert.equal(late.stdout.eof, true);
        assert.equal(late.stderr.eof, true);
        assert.equal(m.counts.drain, 1);
        assert.equal(m.counts.release, 0);
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /NOT_ACTIVE/);
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
        m.state.exited = true;
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const release = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), release);
        const ack = await release;
        assert.equal(ack.retainedUnknown, false);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(m.counts.release, 1);
        assert.equal(m.counts.drain, 1); // No implicit final drain or automatic retry.
    } finally {
        acknowledge();
        await task.catch(() => {});
    }
});

test('memory later failed drains invalidate stale EOF and preserve the first error through once-only release', async () => {
    for (const mode of ['reject', 'malformed', 'prefix']) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.capture.stdout.bytes = Buffer.from('retained');
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        m.state.exited = true;
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const originalDrain = m.native.drainOwnedStdio;
        const primary = Error('private rejected read');
        if (mode === 'reject')
            m.native.drainOwnedStdio = async () => {
                m.counts.drain++;
                throw primary;
            };
        if (mode === 'malformed') m.native.drainOutput = '{PRIVATE';
        if (mode === 'prefix') m.capture.stdout.bytes = Buffer.from('replaced');
        const first = await m.api.drainWindowsNativeOwnedStdio(cap).then(
            () => assert.fail('new unknown read must invalidate stale EOF'),
            (error) => error,
        );
        const cause = first.cause ?? first;
        if (mode === 'reject') assert.equal(cause, primary);
        else
            assert.match(
                cause.message,
                mode === 'malformed' ? /STDIO_JSON/ : /STDIO_PREFIX_CHANGED/,
            );
        assert.equal(first.nativeAuthorityCustody.retainedAtCapture, true);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /STDIO_OBSERVATION_UNKNOWN/,
        );
        assert.equal(m.counts.release, 0);
        assert.throws(() => m.api.readWindowsNativeMainInspectorEndpoint(cap), /NOT_ACTIVE/);
        m.native.drainOwnedStdio = originalDrain;
        delete m.native.drainOutput;
        m.capture.stdout.bytes = Buffer.from('retained');
        await m.api.drainWindowsNativeOwnedStdio(cap); // Explicit reviewed current observation, never automatic retry.
        const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(ack.retainedUnknown, false);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(first.nativeAuthorityCustody.failedAtCapture, true);
        assert.equal(JSON.stringify(first), '{}');
    }
    for (const primary of [Error('original private drain failure'), undefined]) {
        const m = launchMemory(),
            cap = await m.prepare();
        await m.api.launchWindowsNativePinnedProcess(cap, m.input());
        m.endStdio();
        m.state.exited = true;
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const drain = m.native.drainOwnedStdio;
        m.native.drainOwnedStdio = () => {
            m.counts.drain++;
            throw primary;
        };
        const first = await m.api.drainWindowsNativeOwnedStdio(cap).then(
            () => assert.fail('read must fail'),
            (error) => error,
        );
        assert.equal(Object.hasOwn(first, 'cause'), true);
        assert.equal(first.cause, primary);
        assert.equal(first.nativeAuthorityCustody.retainedAtCapture, true);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /STDIO_OBSERVATION_UNKNOWN/,
        );
        m.native.drainOwnedStdio = drain;
        await m.api.drainWindowsNativeOwnedStdio(cap);
        const later = Error('later private release failure');
        m.native.releaseOwnedProcessHandles = () => {
            m.counts.release++;
            throw later;
        };
        const task = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        await assert.rejects(task, (error) => {
            assert.equal(Object.hasOwn(error, 'cause'), true);
            assert.equal(error.cause, primary);
            assert.equal(Object.hasOwn(error.errors, '0'), true);
            assert.equal(error.errors[0], primary);
            assert.equal(error.errors[1], later);
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), task);
        assert.equal(m.counts.release, 1);
        assert.equal(m.counts.launch, 1);
    }
});

// The actual fixed quit caller executes only inside launchMemory's closed VM.
// Inspector peer/root/EOF/timer facts below are authored, never native observations.
test('memory normal quit reserves before every port effect and joins fixed protocol and independent resources once', async () => {
    const m = launchMemory(),
        cap = await m.prepareQuit();
    let task;
    const assertReserved = () => {
        assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
        assert.throws(() => m.api.sampleWindowsNativeOwnedProcess(cap), /QUIT_OPERATION_PENDING/);
        assert.throws(() => m.api.drainWindowsNativeOwnedStdio(cap), /QUIT_OPERATION_PENDING/);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /QUIT_OPERATION_PENDING/,
        );
        assert.equal(m.counts.release, 0);
    };
    m.quit.onTimer = () => {
        assertReserved();
        assert.equal(m.quit.constructors, 0);
    };
    m.quit.onConstruct = () => {
        assertReserved();
        assert.equal(m.quit.timerStarts, 1);
    };
    m.quit.onSend = assertReserved;
    task = m.api.requestWindowsNativeNormalQuit(cap);
    assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
    assert.equal(m.quit.constructors, 0);
    assert.equal(m.quit.timerStarts, 0);
    const transport = m.api.joinWindowsNativeNormalQuitTransport(cap);
    assert.equal(m.api.joinWindowsNativeNormalQuitTransport(cap), transport);
    await m.quit.closeRequested.promise;
    m.quit.onTimer = undefined;
    await m.quit.microtasks();
    assert.equal(m.quit.requests.length, 3);
    assert.equal(m.quit.immediateCallbacks.length, 1);
    assert.equal(m.quit.appQuitCalls, 0); // Actual fixed expression scheduled, but has not run.
    assert.equal(m.state.exited, false);
    assert.equal(m.capture.stdout.eof, false);
    assert.equal((await transport).closedUnacknowledgedReplies, 0);
    let settled = false;
    void task.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await m.quit.microtasks();
    assert.equal(settled, false);
    m.quit.onAppQuit = () => {
        m.state.exited = true;
        m.state.exitCode = 0;
        m.endStdio();
    };
    m.quit.runAppQuit(); // Fake Electron callback, not an app/native invocation.
    m.quit.fireTimer(20);
    const result = await task;
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        identityReplyObserved: true,
        quitSchedulingReplyObserved: true,
        rootExitObserved: true,
        rootExitCode: 0,
        stdoutEOF: true,
        stderrEOF: true,
        ownedInspectorCloseObserved: true,
        closedUnacknowledgedReplies: 0,
        physicalLoadedBytesVerified: false,
        physicalDescendantClosure: false,
        releaseAcceptance: false,
    });
    assert.ok(Object.isFrozen(result));
    assert.equal(m.quit.appQuitCalls, 1);
    assert.equal(m.quit.timers.size, 0);
    assert.equal(m.quit.listenerAdds, 4);
    assert.equal(m.quit.listenerRemoves, 4);
    assert.equal(m.quit.closes, 1);
    const effects = [
        m.quit.constructors,
        m.quit.timerStarts,
        m.quit.sends,
        m.counts.sample,
        m.counts.drain,
    ];
    assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
    assert.equal(await m.api.requestWindowsNativeNormalQuit(cap), result);
    assert.equal(m.api.joinWindowsNativeNormalQuitTransport(cap), transport);
    assert.deepEqual(
        [m.quit.constructors, m.quit.timerStarts, m.quit.sends, m.counts.sample, m.counts.drain],
        effects,
    );
    assert.equal(JSON.stringify(result).includes(m.quit.endpoint), false);
    assert.equal(m.counts.release, 0); // Successful protocol/joins do not close HANDLEs/TSFN.
    const release = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), release);
    assert.equal((await release).hostLifetimeFinalizerAcknowledged, true);
    assert.equal(m.counts.release, 1);
});

test('memory normal quit binds a unique default context and fresh native PID before the sole scheduling request', async () => {
    for (const change of [
        (q) => {
            delete q.context.uniqueId;
        },
        (q) => {
            q.context.uniqueId = '';
        },
        (q) => {
            q.context.uniqueId = 'x'.repeat(257);
        },
        (q) => {
            q.context.uniqueId = 'bad\0context';
        },
        (q) => {
            q.context.id = 0;
        },
        (q) => {
            q.identity.pid = 18;
        },
        (q) => {
            q.identity.pid = '17';
        },
        (q) => {
            q.identity.type = 'renderer';
        },
        (q) => {
            q.identity.extra = true;
        },
    ]) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        change(m.quit);
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        await assert.rejects(task, (error) => {
            assert.match(
                (error.cause ?? error).message,
                /QUIT_(PROTOCOL_INVALID|IDENTITY_MISMATCH)/,
            );
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.equal(
            m.quit.requests.some((x) => x.id === 3),
            false,
        );
        assert.equal(m.quit.immediateCallbacks.length, 0);
        assert.equal(m.quit.appQuitCalls, 0);
        assert.equal(
            (await m.api.joinWindowsNativeNormalQuitTransport(cap)).ownedInspectorCloseObserved,
            true,
        );
    }
    for (const mode of ['nondefault', 'destroyed', 'replaced', 'changed-native-pid']) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        if (mode === 'nondefault') m.quit.context.auxData.isDefault = false;
        if (mode === 'destroyed' || mode === 'replaced')
            m.quit.onSend = (_message, phase, socket) => {
                if (phase !== 'identity') return;
                socket.message(
                    mode === 'destroyed'
                        ? {
                              method: 'Runtime.executionContextDestroyed',
                              params: { executionContextUniqueId: m.quit.context.uniqueId },
                          }
                        : {
                              method: 'Runtime.executionContextCreated',
                              params: {
                                  context: {
                                      id: 8,
                                      uniqueId: 'other-context',
                                      auxData: { isDefault: true },
                                  },
                              },
                          },
                );
            };
        if (mode === 'changed-native-pid') {
            let samples = 0;
            m.native.sampleOwnedProcess = async () => {
                m.counts.sample++;
                const facts = m.facts();
                if (++samples === 2) facts.pid = 19;
                return JSON.stringify(facts);
            };
        }
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        void task.catch(() => {});
        if (mode === 'nondefault') {
            await m.quit.phaseStarted.enable.promise;
            await m.quit.microtasks();
            m.quit.fireTimer(15000);
        }
        await assert.rejects(task, (error) => {
            assert.match(
                (error.cause ?? error).message,
                /QUIT_(DEADLINE|CONTEXT_LOST|CONTEXT_CHANGED|ROOT_NOT_LIVE)/,
            );
            return true;
        });
        assert.equal(
            m.quit.requests.some((x) => x.id === 3),
            false,
        );
        assert.equal(m.quit.appQuitCalls, 0);
    }
});

test('memory normal quit latches a valid scheduling reply before same-turn close but never promotes reversed or malformed ACK order', async () => {
    for (const timing of [
        'ack-close',
        'ack-context-close',
        'close-ack',
        'context-ack',
        'malformed',
    ]) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        m.quit.closeMode = 'held';
        m.quit.afterReply = (_message, phase, socket) => {
            if (phase !== 'quit' || !timing.startsWith('ack-')) return;
            if (timing === 'ack-context-close')
                socket.message({
                    method: 'Runtime.executionContextDestroyed',
                    params: { executionContextId: m.quit.context.id },
                });
            socket.finishClose();
        };
        m.quit.onSend = (_message, phase, socket) => {
            if (phase !== 'quit') return;
            if (timing === 'close-ack') socket.finishClose();
            if (timing === 'context-ack')
                socket.message({
                    method: 'Runtime.executionContextDestroyed',
                    params: { executionContextId: m.quit.context.id },
                });
        };
        if (timing === 'malformed') m.quit.scheduled.scheduled = false;
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        void task.catch(() => {});
        if (timing.startsWith('ack-')) {
            await m.quit.phaseStarted.quit.promise;
            await m.quit.microtasks();
            assert.equal(m.quit.appQuitCalls, 0);
            m.state.exited = true;
            m.state.exitCode = 0;
            m.endStdio();
            m.quit.fireTimer(20);
            const result = await task;
            assert.equal(result.quitSchedulingReplyObserved, true);
            assert.equal(result.closedUnacknowledgedReplies, 0);
            assert.equal(result.releaseAcceptance, false);
            assert.equal(m.quit.closes, 0); // Peer close ACK, never a second close request.
        } else {
            await assert.rejects(task, (error) => {
                assert.match(
                    (error.cause ?? error).message,
                    /QUIT_(REPLY_CLOSED_UNACKNOWLEDGED|TRANSPORT_CLOSED_BEFORE_QUIT_ACK|CONTEXT_LOST|SCHEDULE_NOT_ACKNOWLEDGED)/,
                );
                assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
                return true;
            });
            if (m.quit.sockets[0].readyState !== 3) m.quit.sockets[0].finishClose();
            const transport = await m.api.joinWindowsNativeNormalQuitTransport(cap);
            assert.equal(transport.ownedInspectorCloseObserved, true);
            assert.equal(m.quit.requests.length, 3);
            assert.equal(m.counts.release, 0);
        }
        assert.equal(m.quit.appQuitCalls, 0); // ACK ordering is not executing the queued app callback.
        assert.equal(m.quit.requests.filter((x) => x.id === 3).length, 1);
    }
    for (const missing of ['root', 'stdout', 'stderr', 'socket', 'nonzero']) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        m.quit.closeMode = 'held';
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        void task.catch(() => {});
        await m.quit.closeRequested.promise;
        await m.quit.microtasks();
        m.state.exited = missing !== 'root';
        m.state.exitCode = missing === 'nonzero' ? 7 : 0;
        m.capture.stdout.eof = missing !== 'stdout';
        m.capture.stderr.eof = missing !== 'stderr';
        if (missing !== 'socket') m.quit.sockets[0].finishClose();
        m.quit.fireTimer(20);
        await m.quit.microtasks();
        if (missing !== 'nonzero') m.quit.fireTimer(15000);
        await assert.rejects(task, (error) => {
            assert.match(
                (error.cause ?? error).message,
                missing === 'nonzero' ? /ROOT_EXIT_NOT_ZERO/ : /DEADLINE/,
            );
            return true;
        });
        assert.equal(m.counts.release, 0);
        if (missing === 'socket') {
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /QUIT_TRANSPORT_PENDING/,
            );
            const transport = m.api.joinWindowsNativeNormalQuitTransport(cap);
            let joined = false;
            void transport.then(() => {
                joined = true;
            });
            await m.quit.microtasks();
            assert.equal(joined, false);
            m.quit.sockets[0].finishClose();
            assert.equal((await transport).ownedInspectorCloseObserved, true);
            const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
            assert.equal(ack.releaseAcceptance, false); // Late transport closure never changes failed task.
            await assert.rejects(m.api.requestWindowsNativeNormalQuit(cap));
            assert.equal(m.quit.constructors, 1);
        }
    }
    const m = launchMemory(),
        cap = await m.prepareQuit();
    m.quit.closeMode = 'held';
    const task = m.api.requestWindowsNativeNormalQuit(cap);
    void task.catch(() => {});
    const join = m.api.joinWindowsNativeNormalQuitTransport(cap);
    Object.defineProperty(join, 'then', {
        configurable: true,
        value(resolve) {
            resolve({
                transportConstructionSubmitted: true,
                ownedInspectorCloseObserved: true,
                closedUnacknowledgedReplies: 0,
            });
        },
    });
    await m.quit.closeRequested.promise;
    await m.quit.microtasks();
    m.state.exited = true;
    m.state.exitCode = 0;
    m.endStdio();
    m.quit.fireTimer(20);
    await assert.rejects(task, (error) => {
        assert.match((error.cause ?? error).message, /QUIT_BOOKKEEPING_UNKNOWN/);
        assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
        return true;
    });
    assert.throws(
        () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
        /QUIT_TRANSPORT_PENDING/,
    );
    assert.equal(m.counts.release, 0); // Mutable public Promise is not private transport evidence.
    delete join.then;
    m.quit.sockets[0].finishClose();
    assert.equal((await join).ownedInspectorCloseObserved, true);
    assert.equal(
        (await m.api.releaseWindowsNativeOwnedProcessHandles(cap)).releaseAcceptance,
        false,
    );
    await assert.rejects(task);
    assert.equal(m.quit.constructors, 1);
    assert.equal(m.quit.requests.length, 3);
});

test('memory pending open cancellation and deadline fence every later connection callback without reconnecting', async () => {
    const first = launchMemory(),
        before = await first.prepareQuit();
    const beforeTask = first.api.requestWindowsNativeNormalQuit(before);
    first.api.cancelWindowsNativeAuthority(before);
    await assert.rejects(beforeTask, /QUIT_CANCELLED/);
    assert.equal(first.quit.timerStarts, 0);
    assert.equal(first.quit.constructors, 0);
    assert.equal(first.quit.sends, 0);
    const absent = await first.api.joinWindowsNativeNormalQuitTransport(before);
    assert.equal(absent.transportConstructionSubmitted, false);
    assert.equal(absent.ownedInspectorCloseObserved, false);
    for (const mode of ['cancel', 'deadline', 'error']) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        m.quit.openState = 0;
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        void task.catch(() => {});
        const socket = await m.quit.socketCreated.promise;
        await m.quit.microtasks();
        assert.equal(m.quit.sends, 0);
        if (mode === 'cancel') m.api.cancelWindowsNativeAuthority(cap);
        if (mode === 'deadline') m.quit.fireTimer(15000);
        if (mode === 'error') socket.emit('error');
        await assert.rejects(task, (error) => {
            assert.match(
                (error.cause ?? error).message,
                /QUIT_(CANCELLED|DEADLINE|TRANSPORT_ERROR)/,
            );
            return true;
        });
        const joined = m.api.joinWindowsNativeNormalQuitTransport(cap);
        assert.equal(m.api.joinWindowsNativeNormalQuitTransport(cap), joined);
        assert.equal((await joined).ownedInspectorCloseObserved, true);
        socket.open();
        socket.message({ id: 1, result: {} }); // All owned listeners removed; never new work.
        assert.equal(m.quit.sends, 0);
        assert.equal(m.quit.constructors, 1);
        assert.equal(m.quit.closes, 1);
        assert.equal(m.quit.listenerRemoves, 4);
        assert.equal(m.quit.timers.size, 0);
        assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
        assert.equal(m.counts.release, 0);
    }
});

test('memory synchronous constructor and send failures retain unknown custody without exposing raw exceptions or retrying', async () => {
    for (const stage of ['constructor', 'send'])
        for (const raw of [Error('PRIVATE_SOCKET_EXCEPTION'), undefined]) {
            const m = launchMemory(),
                cap = await m.prepareQuit();
            const fail = () => {
                throw raw;
            };
            if (stage === 'constructor') m.quit.onConstruct = fail;
            else m.quit.onSend = fail;
            const task = m.api.requestWindowsNativeNormalQuit(cap);
            const failure = await task.then(
                () => assert.fail('submitted effect must remain unknown'),
                (error) => error,
            );
            assert.match(
                (failure.cause ?? failure).message,
                stage === 'constructor' ? /TRANSPORT_ACQUISITION_UNKNOWN/ : /SEND_UNCONFIRMED/,
            );
            assert.equal(failure.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(failure.nativeAuthorityCustody.failedAtCapture, true);
            assert.equal(JSON.stringify(failure), '{}');
            assert.equal(failure.message.includes('PRIVATE_SOCKET_EXCEPTION'), false);
            assert.equal(m.quit.constructors, 1);
            assert.equal(m.quit.sends, stage === 'constructor' ? 0 : 1);
            assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
            const transport = m.api.joinWindowsNativeNormalQuitTransport(cap);
            assert.equal(m.api.joinWindowsNativeNormalQuitTransport(cap), transport);
            let joined = false;
            void transport.then(() => {
                joined = true;
            });
            await m.quit.microtasks();
            assert.equal(joined, false);
            m.state.exited = true;
            m.endStdio();
            await m.api.sampleWindowsNativeOwnedProcess(cap);
            await m.api.drainWindowsNativeOwnedStdio(cap);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /QUIT_TRANSPORT_PENDING/,
            );
            assert.equal(m.counts.release, 0);
            assert.equal(m.quit.constructors, 1);
        }
});

test('memory bounded inspector frames and closed unacknowledged RPCs cannot manufacture scheduling success', async () => {
    const frames = [
        '{PRIVATE',
        '[]',
        JSON.stringify({ id: 99, result: {} }),
        JSON.stringify({ method: 1 }),
        JSON.stringify({ method: 'x'.repeat(201) }),
        'x'.repeat(65537),
        Buffer.from('PRIVATE_BINARY_FRAME'),
    ];
    for (const frame of frames) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        m.quit.onSend = (_message, phase, socket) => {
            if (phase === 'enable') {
                if (Buffer.isBuffer(frame)) socket.emit('message', { data: frame });
                else socket.message(frame);
            }
        };
        await assert.rejects(m.api.requestWindowsNativeNormalQuit(cap), (error) => {
            assert.match((error.cause ?? error).message, /QUIT_PROTOCOL_INVALID/);
            assert.equal(JSON.stringify(error), '{}');
            assert.equal(error.message.includes('PRIVATE'), false);
            return true;
        });
        assert.equal(
            m.quit.requests.some((x) => x.id === 3),
            false,
        );
        assert.equal(m.counts.release, 0);
    }
    const flood = launchMemory(),
        flooded = await flood.prepareQuit();
    flood.quit.onSend = (_message, phase, socket) => {
        if (phase === 'enable')
            for (let i = 0; i < 18; i++)
                socket.message({
                    method: 'Runtime.consoleAPICalled',
                    params: { payload: 'x'.repeat(60000) },
                });
    };
    await assert.rejects(
        flood.api.requestWindowsNativeNormalQuit(flooded),
        /QUIT_PROTOCOL_INVALID/,
    );
    assert.equal(
        flood.quit.requests.some((x) => x.id === 3),
        false,
    );
    for (const phase of ['enable', 'identity', 'quit']) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        m.quit.holdReplies.add(phase);
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        void task.catch(() => {});
        await m.quit.phaseStarted[phase].promise;
        await m.quit.microtasks();
        const socket = m.quit.sockets[0];
        socket.message({ method: 'Unknown.boundedNotification', params: {} });
        assert.equal(m.quit.sends, phase === 'enable' ? 1 : phase === 'identity' ? 2 : 3);
        socket.finishClose();
        await assert.rejects(task, (error) => {
            assert.match(
                (error.cause ?? error).message,
                /QUIT_(REPLY_CLOSED_UNACKNOWLEDGED|TRANSPORT_CLOSED_BEFORE_QUIT_ACK)/,
            );
            return true;
        });
        const transport = await m.api.joinWindowsNativeNormalQuitTransport(cap);
        assert.equal(transport.closedUnacknowledgedReplies, 1);
        assert.equal(transport.ownedInspectorCloseObserved, true); // Closure, not RPC completion.
        m.quit.reply(phase); // Listener removal fences this late reply, including quit ACK.
        const sends = m.quit.sends;
        m.state.exited = true;
        m.endStdio();
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        await m.api.drainWindowsNativeOwnedStdio(cap);
        const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
        await assert.rejects(task);
        assert.equal(m.quit.sends, sends);
        assert.equal(m.quit.constructors, 1);
    }
});

test('memory native tasks remain owned after quit deadline and original native failures survive component release errors', async () => {
    for (const stage of ['initial-sample', 'post-ack-drain']) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        let resolve;
        const pending = new Promise((done) => {
            resolve = done;
        });
        let started;
        const issued = new Promise((done) => {
            started = done;
        });
        if (stage === 'initial-sample')
            m.native.sampleOwnedProcess = () => {
                m.counts.sample++;
                started();
                return pending;
            };
        else
            m.native.drainOwnedStdio = () => {
                m.counts.drain++;
                started();
                return pending;
            };
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        void task.catch(() => {});
        try {
            await issued;
            m.quit.fireTimer(15000);
            const failure = await task.then(
                () => assert.fail('deadline must fail'),
                (error) => error,
            );
            assert.match((failure.cause ?? failure).message, /QUIT_DEADLINE/);
            assert.equal(failure.nativeAuthorityCustody.pendingOperationsAtCapture, 1);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /OPERATION_PENDING/,
            );
            assert.equal(m.counts.release, 0);
            resolve(JSON.stringify(stage === 'initial-sample' ? m.facts() : m.captureFacts()));
            await m.quit.microtasks();
            m.native.sampleOwnedProcess = async () => {
                m.counts.sample++;
                return JSON.stringify(m.facts());
            };
            m.native.drainOwnedStdio = async () => {
                m.counts.drain++;
                return JSON.stringify(m.captureFacts());
            };
            m.state.exited = true;
            m.endStdio();
            await m.api.sampleWindowsNativeOwnedProcess(cap);
            await m.api.drainWindowsNativeOwnedStdio(cap);
            const transport = await m.api.joinWindowsNativeNormalQuitTransport(cap);
            assert.equal(transport.transportConstructionSubmitted, stage !== 'initial-sample');
            assert.equal(
                (await m.api.releaseWindowsNativeOwnedProcessHandles(cap)).releaseAcceptance,
                false,
            );
            await assert.rejects(task);
        } finally {
            resolve(JSON.stringify(stage === 'initial-sample' ? m.facts() : m.captureFacts()));
            await task.catch(() => {});
        }
    }
    for (const primary of [Error('PRIVATE_NATIVE_SAMPLE'), undefined]) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        m.native.sampleOwnedProcess = () => {
            m.counts.sample++;
            throw primary;
        };
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        const failure = await task.then(
            () => assert.fail('native failure must propagate'),
            (error) => error,
        );
        assert.equal(Object.hasOwn(failure, 'cause'), true);
        assert.equal(failure.cause, primary);
        assert.equal(failure.nativeAuthorityCustody.retainedAtCapture, true);
        assert.equal(m.quit.constructors, 0);
        assert.equal(
            (await m.api.joinWindowsNativeNormalQuitTransport(cap)).transportConstructionSubmitted,
            false,
        );
        m.native.sampleOwnedProcess = async () => {
            m.counts.sample++;
            return JSON.stringify(m.facts());
        };
        m.state.exited = true;
        m.endStdio();
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        await m.api.drainWindowsNativeOwnedStdio(cap);
        const later = Error('PRIVATE_COMPONENT_RELEASE');
        m.native.releaseOwnedProcessHandles = () => {
            m.counts.release++;
            throw later;
        };
        const release = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        await assert.rejects(release, (error) => {
            assert.equal(error.cause, primary);
            assert.equal(error.errors[0], primary);
            assert.equal(error.errors[1], later);
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            return true;
        });
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), release);
        assert.equal(m.counts.release, 1);
    }
    const m = launchMemory(),
        cap = await m.prepareQuit();
    let samples = 0;
    m.native.sampleOwnedProcess = async () => {
        m.counts.sample++;
        if (++samples === 3) m.api.cancelWindowsNativeAuthority(cap);
        return JSON.stringify(m.facts());
    };
    const beforeDrain = m.counts.drain;
    await assert.rejects(m.api.requestWindowsNativeNormalQuit(cap), /QUIT_CANCELLED/);
    assert.equal(m.counts.drain, beforeDrain); // Already-latched cancellation cannot submit the next poll/drain.
    assert.equal(samples, 3);
});

test('memory unknown socket and timer returns stay retained without proxy traps or false cleanup ACKs', async () => {
    for (const mode of [
        'socket-proxy',
        'timer-proxy',
        'timer-getter',
        'send-promise',
        'add-then-getter',
        'remove-promise',
        'close-promise',
        'clear-promise',
        'socket-rejected-promise',
        'timer-rejected-promise',
        'send-rejected-promise',
        'remove-rejected-promise',
        'close-rejected-promise',
        'clear-rejected-promise',
    ]) {
        const m = launchMemory(),
            cap = await m.prepareQuit();
        let traps = 0;
        const proxy = () =>
            new Proxy(
                {},
                {
                    get() {
                        traps++;
                        throw Error('proxy get');
                    },
                    getPrototypeOf() {
                        traps++;
                        throw Error('proxy prototype');
                    },
                    getOwnPropertyDescriptor() {
                        traps++;
                        throw Error('proxy descriptor');
                    },
                },
            );
        if (mode === 'socket-proxy') m.quit.constructorReturn = proxy();
        if (mode === 'timer-proxy') m.quit.timerReturn = proxy();
        if (mode === 'timer-getter')
            m.quit.timerReturn = Object.defineProperty({}, 'ref', {
                get() {
                    traps++;
                    throw Error('timer getter');
                },
            });
        if (mode === 'send-promise') m.quit.sendReturn = Promise.resolve();
        if (mode === 'add-then-getter')
            m.quit.addReturn = Object.defineProperty({}, 'then', {
                get() {
                    traps++;
                    throw Error('then getter');
                },
            });
        if (mode === 'remove-promise') m.quit.removeReturn = Promise.resolve();
        if (mode === 'close-promise') m.quit.closeReturn = Promise.resolve();
        if (mode.endsWith('rejected-promise')) {
            const field = mode.startsWith('socket-') ? 'constructor' : mode.split('-')[0];
            // Create the rejection at the actual fake port invocation, without a
            // harness catch. The actual wrapper must observe this native Promise.
            m.quit[field + 'ReturnFactory'] = () =>
                Promise.reject(Error('PRIVATE_REJECTED_PORT_RESULT'));
        }
        if (mode === 'clear-promise' || mode === 'clear-rejected-promise') {
            m.quit.clearReturn = Promise.resolve();
            m.quit.onClose = () => {
                m.state.exited = true;
                m.state.exitCode = 0;
                m.endStdio();
            };
        }
        const task = m.api.requestWindowsNativeNormalQuit(cap);
        await assert.rejects(task, (error) => {
            assert.match(
                (error.cause ?? error).message,
                /QUIT_(TRANSPORT_ACQUISITION_UNKNOWN|TIMER_RESULT_UNKNOWN|SEND_UNCONFIRMED|LISTENER_ADD_UNKNOWN|LISTENER_REMOVE_UNKNOWN|TRANSPORT_CLOSE_UNKNOWN|TIMER_CLEAR_UNKNOWN|TRANSPORT_BOOKKEEPING_UNKNOWN)/,
            );
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            assert.equal(error.message.includes('PRIVATE_REJECTED_PORT_RESULT'), false);
            assert.equal(JSON.stringify(error), '{}');
            return true;
        });
        assert.equal(traps, 0);
        m.state.exited = true;
        m.endStdio();
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        await m.api.drainWindowsNativeOwnedStdio(cap);
        assert.throws(
            () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
            /QUIT_TRANSPORT_PENDING/,
        );
        assert.equal(m.counts.release, 0);
        assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
        const transport = m.api.joinWindowsNativeNormalQuitTransport(cap);
        assert.equal(m.api.joinWindowsNativeNormalQuitTransport(cap), transport);
        if (mode === 'socket-proxy') {
            for (let i = 0; i < 31; i++) await m.prepare();
            await assert.rejects(m.prepare(), /OWNER_LIMIT/); // Private owner stays retained; no private issuer added.
        }
        assert.equal(m.quit.constructors <= 1, true);
    }
});

test('memory actual owned runtime composition issues private rows then actual shared consumption stays unqualified', async () => {
    const m = launchMemory(),
        lifecycle = m.ownedRuntime();
    m.native.pinFiles = async () => JSON.stringify(m.modelPins());
    const probe = { absent: undefined, nested: { count: 1 }, array: [undefined, { count: 2 }] };
    const copied = m.cloneIntoRealm(probe);
    assert.equal(Object.hasOwn(copied, 'absent'), true);
    assert.equal(copied.absent, undefined);
    assert.equal(Object.hasOwn(copied.array, 0), true);
    copied.nested.count = 9;
    copied.array[1].count = 9;
    assert.equal(probe.nested.count, 1);
    assert.equal(probe.array[1].count, 2);
    const expected = m.inside(m.expected()),
        binding = m.inside(request()),
        build = m.buildInput();
    const operation = lifecycle.observeWindowsNativeOwnedRuntime(expected, binding, build);
    void operation.catch(() => {});
    expected.artifacts[0].sha256 = '0'.repeat(64);
    binding.expectedFiles[0].sha256 = '0'.repeat(64);
    build.sourceSHA256 = '0'.repeat(64);
    await m.quit.pollStarted.promise;
    assert.equal(m.quit.constructors, 0);
    assert.equal([...m.quit.timers.values()].filter((x) => x.delay === 15000).length, 1);
    m.capture.stderr.bytes = Buffer.from('Debugger listening on ws://127.0.0.1:43123/');
    m.quit.fireTimer(20);
    await m.quit.microtasks();
    assert.equal(m.quit.constructors, 0); // Partial startup bytes are not an endpoint.
    m.capture.stderr.bytes = Buffer.from('Debugger listening on ' + m.quit.endpoint + '\r\n');
    m.quit.fireTimer(20);
    await m.quit.closeRequested.promise;
    await m.quit.microtasks();
    m.quit.onAppQuit = () => {
        m.state.exited = true;
        m.state.exitCode = 0;
        m.endStdio();
    };
    m.quit.runAppQuit();
    m.quit.fireTimer(20);
    const result = await operation;
    assert.equal(
        result.status,
        'selected-pinned-runtime-and-component-closure-consistent-unqualified',
    );
    assert.equal(result.componentHandlesAndLifetimeAcknowledged, true);
    for (const key of [
        'installationObserved',
        'offlineObserved',
        'uiObserved',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'installerCaseComplete',
        'releaseAcceptance',
    ])
        assert.equal(result[key], false);
    assert.equal(m.counts.acquire, 1);
    assert.equal(m.counts.launch, 1);
    assert.equal(m.counts.release, 1);
    assert.equal(m.quit.sends, 3);
    assert.equal(m.quit.appQuitCalls, 1);
    assert.equal(m.quit.constructors, 1);
    const envelope = JSON.parse(result.bytes.toString());
    assert.equal(envelope.observation.kind, 'windows-native-owned-runtime/v1');
    assert.deepEqual(Object.keys(result.originalRecords), [
        'file-pins',
        'created-process',
        'normal-quit',
        'owned-release',
    ]);
    assert.equal(envelope.package.sha256, request().package.sha256);
    assert.equal(
        envelope.observation.binding.expectedFiles[0].sha256,
        request().expectedFiles[0].sha256,
    );
    const files = new Map([
        [result.lifecycleEvidence.path, Buffer.from(result.bytes)],
        ...Object.entries(result.originalRecords).map(([role, bytes]) => [
            'windows-native/owned-runtime/' + role + '.json',
            Buffer.from(bytes),
        ]),
    ]);
    const reads = [];
    const read = async (name, maximum) => {
        reads.push(name);
        const bytes = files.get(name);
        assert.ok(bytes && bytes.length <= maximum);
        return Buffer.from(bytes);
    };
    await lifecycle.readWindowsNativeOwnedRecords(envelope.observation, read);
    reads.length = 0;
    const summary = await consumeInstallerLifecycleEvidence(
        {
            schemaVersion: 2,
            kind: 'native-installer-lifecycle',
            runId: m.expected().runId,
            runAttempt: m.expected().runAttempt,
            cases: [
                {
                    id: request().caseId,
                    lifecycleEvidence: result.lifecycleEvidence,
                    evidence: result.evidence,
                },
            ],
        },
        m.expected(),
        read,
    );
    assert.deepEqual(summary, {
        status: 'installer-lifecycle-unqualified',
        releaseAcceptance: false,
        observations: [
            {
                caseId: request().caseId,
                status: 'selected-pinned-runtime-and-component-closure-consistent-unqualified',
            },
        ],
    });
    assert.deepEqual(reads, [
        result.lifecycleEvidence.path,
        ...Object.keys(result.originalRecords).map(
            (role) => 'windows-native/owned-runtime/' + role + '.json',
        ),
    ]);
    assert.equal(JSON.stringify(envelope).includes(m.quit.endpoint), false);
});

test('memory private normal quit and release originals are issued only by real owner paths and every read is a copy', async () => {
    const m = launchMemory(),
        cap = await m.prepareQuit();
    assert.throws(() => m.api.readWindowsNativeNormalQuit(cap), /QUIT_RECORD_MISSING/);
    assert.throws(() => m.api.readWindowsNativeOwnedRelease(cap), /OWNED_RELEASE_RECORD_MISSING/);
    const task = m.api.requestWindowsNativeNormalQuit(cap);
    assert.throws(() => m.api.readWindowsNativeNormalQuit(cap), /QUIT_RECORD_MISSING/);
    await m.quit.closeRequested.promise;
    await m.quit.microtasks();
    m.state.exited = true;
    m.state.exitCode = 0;
    m.endStdio();
    m.quit.fireTimer(20);
    const outcome = await task;
    assert.ok(Object.isFrozen(outcome));
    assert.throws(() => {
        outcome.releaseAcceptance = true;
    }, TypeError);
    const originalQuit = m.api.readWindowsNativeNormalQuit(cap),
        originalText = originalQuit.toString();
    const row = JSON.parse(originalText);
    assert.equal(row.kind, 'windows-native-normal-quit/v1');
    assert.deepEqual(row.createdProcess, { pid: 17, threadId: 18, creationTime100ns: '123456789' });
    assert.deepEqual(row.identity, { pid: 17, type: 'browser' });
    originalQuit.fill(0);
    assert.equal(m.api.readWindowsNativeNormalQuit(cap).toString(), originalText);
    assert.equal(m.counts.release, 0);
    const release = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
    assert.ok(Object.isFrozen(release));
    assert.equal(release.releaseAcceptance, false);
    assert.throws(
        () => m.api.assertWindowsNativeCapability(cap, m.inside(request())),
        /NOT_ACTIVE/,
    );
    const originalRelease = m.api.readWindowsNativeOwnedRelease(cap),
        releaseText = originalRelease.toString();
    assert.equal(JSON.parse(releaseText).kind, 'windows-native-owned-release/v1');
    originalRelease.fill(0);
    assert.equal(m.api.readWindowsNativeOwnedRelease(cap).toString(), releaseText);
    assert.equal(m.api.readWindowsNativeNormalQuit(cap).toString(), originalText); // Historical bytes, not active authority.
    assert.equal(m.counts.release, 1);
});

test('memory endpoint discovery and shutdown spend the same finite quit owner and never renew its budget', async () => {
    const m = launchMemory(),
        cap = await m.prepare();
    await m.api.launchWindowsNativePinnedProcess(cap, m.input());
    const task = m.api.requestWindowsNativeNormalQuit(cap);
    void task.catch(() => {});
    await m.quit.pollStarted.promise;
    assert.equal(m.quit.constructors, 0);
    // The last permitted discovery poll consumes the shared750 allowance. The
    // subsequent shutdown poll must refuse rather than acquire a new allowance.
    for (let i = 0; i < 748; i++) {
        m.quit.fireTimer(20);
        await m.quit.microtasks();
    }
    m.capture.stderr.bytes = Buffer.from('Debugger listening on ' + m.quit.endpoint + '\n');
    m.quit.fireTimer(20);
    await assert.rejects(task, (error) => {
        assert.match((error.cause ?? error).message, /QUIT_POLL_BUDGET/);
        assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
        return true;
    });
    assert.equal(m.quit.timerStarts, 750); // One deadline plus749 authored poll delays.
    assert.equal(m.quit.requests.length, 3);
    assert.equal(m.quit.constructors, 1);
    assert.equal(m.counts.release, 0);
    assert.equal(m.api.requestWindowsNativeNormalQuit(cap), task);
    assert.throws(() => m.api.readWindowsNativeNormalQuit(cap), /QUIT_RECORD_MISSING/);
    assert.equal(m.quit.timers.size, 0);
});

test('memory actual composition validates immutable prerelease rows before any component cleanup', async () => {
    for (const corrupt of [
        (pins) => {
            pins.host.elevated = true;
        },
        (pins) => {
            pins.files[0].sha256 = '0'.repeat(64);
        },
    ]) {
        const m = launchMemory(),
            lifecycle = m.ownedRuntime();
        const pins = m.modelPins();
        corrupt(pins);
        m.native.pinFiles = async () => JSON.stringify(pins);
        m.native.onCaptureConfigured = () => {
            m.capture.stderr.bytes = Buffer.from('Debugger listening on ' + m.quit.endpoint + '\n');
        };
        const task = lifecycle.observeWindowsNativeOwnedRuntime(
            m.inside(m.expected()),
            m.inside(request()),
            m.buildInput(),
        );
        void task.catch(() => {});
        await m.quit.closeRequested.promise;
        await m.quit.microtasks();
        m.state.exited = true;
        m.state.exitCode = 0;
        m.endStdio();
        m.quit.fireTimer(20);
        const failure = await task.then(
            () => assert.fail('semantic originals must refuse before cleanup'),
            (error) => error,
        );
        assert.equal(m.counts.release, 0);
        const cap = lifecycle.windowsNativeLifecycleFailureAuthority(failure);
        assert.equal(m.api.assertWindowsNativeCapability(cap, m.inside(request())), true);
        assert.equal(
            JSON.parse(m.api.readWindowsNativeNormalQuit(cap)).kind,
            'windows-native-normal-quit/v1',
        );
        assert.throws(
            () => m.api.readWindowsNativeOwnedRelease(cap),
            /OWNED_RELEASE_RECORD_MISSING/,
        );
        const prepared = m.counts.prepare;
        await assert.rejects(
            lifecycle.observeWindowsNativeOwnedRuntime(
                m.inside(m.expected()),
                m.inside(request()),
                m.buildInput(),
            ),
            /READBACK_SCOPE_UNAVAILABLE/,
        );
        assert.equal(m.counts.prepare, prepared);
        assert.equal(m.counts.release, 0);
    }
    const m = launchMemory(),
        lifecycle = m.ownedRuntime(),
        cap = await m.prepareQuit();
    const quit = m.api.requestWindowsNativeNormalQuit(cap);
    m.api.cancelWindowsNativeAuthority(cap);
    await assert.rejects(quit, /QUIT_CANCELLED/);
    await assert.rejects(
        lifecycle.produceWindowsNativeOwnedRuntime(
            m.inside(m.expected()),
            m.inside(request()),
            cap,
        ),
        /NOT_ACTIVE/,
    );
    assert.throws(() => m.api.readWindowsNativeNormalQuit(cap), /QUIT_RECORD_MISSING/);
    assert.equal(m.counts.release, 0);
});

test('memory actual composition retains a pending finalizer and joins its original private release acknowledgement', async () => {
    const m = launchMemory(),
        lifecycle = m.ownedRuntime();
    m.native.pinFiles = async () => JSON.stringify(m.modelPins());
    m.native.onCaptureConfigured = () => {
        m.capture.stderr.bytes = Buffer.from('Debugger listening on ' + m.quit.endpoint + '\n');
    };
    let acknowledge;
    m.native.finalizerGate = new Promise((resolve) => {
        acknowledge = resolve;
    });
    const task = lifecycle.observeWindowsNativeOwnedRuntime(
        m.inside(m.expected()),
        m.inside(request()),
        m.buildInput(),
    );
    void task.catch(() => {});
    try {
        await m.quit.closeRequested.promise;
        await m.quit.microtasks();
        m.state.exited = true;
        m.state.exitCode = 0;
        m.endStdio();
        m.quit.fireTimer(20);
        await m.finalizerObserved.promise;
        let complete = false;
        void task.then(
            () => {
                complete = true;
            },
            () => {
                complete = true;
            },
        );
        await m.quit.microtasks();
        assert.equal(complete, false);
        assert.equal(m.state.handlesClosed, true);
        assert.equal(m.state.hostFinalizerAcknowledged, false);
        const prepared = m.counts.prepare;
        await assert.rejects(
            lifecycle.observeWindowsNativeOwnedRuntime(
                m.inside(m.expected()),
                m.inside(request()),
                m.buildInput(),
            ),
            /READBACK_SCOPE_UNAVAILABLE/,
        );
        assert.equal(m.counts.prepare, prepared);
        assert.equal(m.counts.release, 1);
        acknowledge();
        const result = await task;
        const released = JSON.parse(result.originalRecords['owned-release']);
        assert.equal(released.observation.hostLifetimeFinalizerAcknowledged, true);
        assert.equal(released.observation.retainedUnknown, false);
        assert.equal(result.componentHandlesAndLifetimeAcknowledged, true);
        assert.equal(result.releaseAcceptance, false);
        assert.equal(m.counts.release, 1);
    } finally {
        acknowledge();
        await task.catch(() => {});
    }
});

test('memory actual composition preserves first native Error or undefined without automatic release or admission retry', async () => {
    for (const primary of [Error('first composed native sample failure'), undefined]) {
        const m = launchMemory(),
            lifecycle = m.ownedRuntime();
        m.native.pinFiles = async () => JSON.stringify(m.modelPins());
        m.native.sampleOwnedProcess = () => {
            m.counts.sample++;
            throw primary;
        };
        const failure = await lifecycle
            .observeWindowsNativeOwnedRuntime(
                m.inside(m.expected()),
                m.inside(request()),
                m.buildInput(),
            )
            .then(
                () => assert.fail('native sample must fail'),
                (error) => error,
            );
        assert.equal(Object.hasOwn(failure, 'cause'), true);
        assert.equal(failure.cause, primary);
        assert.equal(failure.nativeAuthorityCustody.retainedAtCapture, true);
        assert.equal(m.counts.release, 0);
        assert.equal(m.quit.constructors, 0);
        const cap = lifecycle.windowsNativeLifecycleFailureAuthority(failure);
        assert.equal(
            (await m.api.joinWindowsNativeNormalQuitTransport(cap)).transportConstructionSubmitted,
            false,
        );
        assert.throws(() => m.api.readWindowsNativeNormalQuit(cap), /QUIT_RECORD_MISSING/);
        const prepared = m.counts.prepare;
        await assert.rejects(
            lifecycle.observeWindowsNativeOwnedRuntime(
                m.inside(m.expected()),
                m.inside(request()),
                m.buildInput(),
            ),
            /READBACK_SCOPE_UNAVAILABLE/,
        );
        assert.equal(m.counts.prepare, prepared);
        m.native.sampleOwnedProcess = async () => {
            m.counts.sample++;
            return JSON.stringify(m.facts());
        };
        m.state.exited = true;
        m.endStdio();
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        await m.api.drainWindowsNativeOwnedStdio(cap);
        const later = Error('later composed release failure');
        m.native.releaseOwnedProcessHandles = () => {
            m.counts.release++;
            throw later;
        };
        const release = m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        await assert.rejects(release, (error) => {
            assert.equal(error.cause, primary);
            assert.equal(error.errors[0], primary);
            assert.equal(error.errors[1], later);
            assert.equal(error.nativeAuthorityCustody.retainedAtCapture, true);
            return true;
        });
        assert.equal(m.api.releaseWindowsNativeOwnedProcessHandles(cap), release);
        assert.equal(m.counts.release, 1);
    }
});

const siblingInput = () => ({
    action: 'launch-pinned-sibling-profile',
    profile: request().root + '.native-launch-profile',
});
async function finishRuntimeModel(m, producer) {
    m.native.pinFiles = async () => JSON.stringify(m.modelPins());
    const operation = producer(m.inside(m.expected()), m.inside(request()), m.buildInput());
    void operation.catch(() => {});
    await m.quit.pollStarted.promise;
    m.capture.stderr.bytes = Buffer.from('Debugger listening on ' + m.quit.endpoint + '\r\n');
    m.quit.fireTimer(20);
    await m.quit.closeRequested.promise;
    await m.quit.microtasks();
    m.quit.onAppQuit = () => {
        m.state.exited = true;
        m.state.exitCode = 0;
        m.endStdio();
    };
    m.quit.runAppQuit();
    m.quit.fireTimer(20);
    return operation;
}

test('memory sibling launch selects only the fixed outside-profile spelling while preserving legacy inputs', () => {
    const legacy = validateWindowsNativeLaunch(
        { action: 'launch-pinned-installed', profile: request().root + '\\native-launch-profile' },
        request(),
    );
    assert.equal(legacy.profile, request().root + '\\native-launch-profile');
    const input = siblingInput(),
        selected = validateWindowsNativeSiblingLaunch(input, request());
    input.profile = 'C:\\changed-after-selection';
    assert.ok(Object.isFrozen(selected));
    assert.deepEqual(selected, siblingInput());
    // This proves lexical separation only. Native reparse/canonical ownership and
    // real shipping startup are not executed by these closed memory controls.
    const relative = path.win32.relative(request().root, selected.profile);
    assert.equal(relative.split('\\')[0], '..');
    for (const change of [
        { action: 'launch-pinned-installed' },
        { profile: legacy.profile },
        { profile: request().root },
        { profile: selected.profile + '\\' },
        { profile: selected.profile + '\\.' },
        { profile: selected.profile.toLowerCase() },
        { profile: selected.profile + ':stream' },
        { profile: '\\\\server\\share\\profile' },
        { profile: 'C:\\another-profile' },
        { authorized: true },
    ])
        assert.throws(() =>
            validateWindowsNativeSiblingLaunch({ ...selected, ...change }, request()),
        );
    assert.throws(() => validateWindowsNativeLaunch(selected, request()));
    let reads = 0;
    const getter = { ...siblingInput() };
    Object.defineProperty(getter, 'profile', {
        enumerable: true,
        get() {
            reads++;
            throw Error('profile getter');
        },
    });
    assert.throws(() => validateWindowsNativeSiblingLaunch(getter, request()));
    assert.equal(reads, 0);
    assert.throws(
        () => launchWindowsNativePinnedSiblingProcess({}, siblingInput()),
        /CAPABILITY_UNISSUED/,
    );
});

test('memory sibling reservation forwards one immutable command and retains cancelled late or malformed native facts', async () => {
    {
        const m = launchMemory(),
            profile = m.useSiblingProfileModel(),
            cap = await m.prepare(),
            input = m.inside(siblingInput());
        m.native.onAcquire = () => {
            input.profile = 'C:\\changed-during-acquisition';
            assert.throws(
                () => m.api.launchWindowsNativePinnedSiblingProcess(cap, m.inside(siblingInput())),
                /WINDOWS_NATIVE_CAPABILITY_NOT_ACTIVE/,
            );
        };
        const task = m.api.launchWindowsNativePinnedSiblingProcess(cap, input);
        input.action = 'changed-after-reservation';
        const created = JSON.parse(await task);
        assert.deepEqual(profile.profiles, [siblingInput().profile]);
        assert.equal(m.counts.acquire, 1);
        assert.equal(m.counts.launch, 1);
        assert.equal(created.kind, 'windows-native-created-process/v3');
        assert.deepEqual(created.requestedLaunch, siblingInput());
        assert.deepEqual(created.observation.profileDirectory, profile.directory);
        assert.equal(created.observation.physicalLoadedBytesVerified, false);
        assert.equal(created.observation.releaseAcceptance, false);
        const copy = m.api.readWindowsNativeOwnedProcess(cap);
        copy.fill(0);
        assert.equal(
            JSON.parse(m.api.readWindowsNativeOwnedProcess(cap)).kind,
            'windows-native-created-process/v3',
        );
        assert.throws(
            () => m.api.launchWindowsNativePinnedProcess(cap, m.input()),
            /ALREADY_RESERVED/,
        );
        assert.throws(() => m.api.readWindowsNativeNormalQuit(cap), /QUIT_RECORD_MISSING/);
        m.state.exited = true;
        m.state.exitCode = 0;
        m.endStdio();
        await m.api.drainWindowsNativeOwnedStdio(cap);
        await m.api.sampleWindowsNativeOwnedProcess(cap);
        const ack = await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(ack.ownedHandlesClosed, true);
        assert.equal(ack.releaseAcceptance, false);
        assert.equal(m.counts.release, 1);
        const released = JSON.parse(m.api.readWindowsNativeOwnedRelease(cap));
        assert.equal(released.kind, 'windows-native-owned-release/v2');
        assert.deepEqual(released.requestedLaunch, siblingInput());
    }
    {
        const m = launchMemory(),
            profile = m.useSiblingProfileModel(),
            cap = await m.prepare();
        const task = m.api.launchWindowsNativePinnedSiblingProcess(cap, m.inside(siblingInput()));
        m.api.cancelWindowsNativeAuthority(cap);
        await assert.rejects(task);
        assert.equal(profile.submitted, false);
        assert.equal(m.counts.acquire, 0);
        assert.equal(m.counts.launch, 0);
        const observed = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
        assert.equal(observed.kind, 'windows-native-created-process/v3');
        assert.equal(observed.observation.creationAttempted, false);
        assert.equal(observed.observation.profileDirectory, null); // Unknown, not fresh/absent.
        await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
        assert.equal(m.counts.release, 1);
    }
    {
        const m = launchMemory(),
            profile = m.useSiblingProfileModel(),
            cap = await m.prepare();
        let finish;
        m.native.launchGate = new Promise((resolve) => {
            finish = resolve;
        });
        const task = m.api.launchWindowsNativePinnedSiblingProcess(cap, m.inside(siblingInput()));
        void task.catch(() => {});
        try {
            await m.launchStarted.promise;
            m.api.cancelWindowsNativeAuthority(cap);
            assert.throws(() => m.api.sampleWindowsNativeOwnedProcess(cap), /OPERATION_PENDING/);
            finish();
            await assert.rejects(task);
            const late = JSON.parse(await m.api.sampleWindowsNativeOwnedProcess(cap));
            assert.deepEqual(late.observation.profileDirectory, profile.directory);
            assert.equal(late.observation.processHandleRetained, true);
            assert.throws(
                () => m.api.releaseWindowsNativeOwnedProcessHandles(cap),
                /LIVE_OR_UNKNOWN/,
            );
            assert.equal(m.counts.release, 0);
            m.state.exited = true;
            m.state.exitCode = 0;
            m.endStdio();
            await m.api.drainWindowsNativeOwnedStdio(cap);
            await m.api.sampleWindowsNativeOwnedProcess(cap);
            await m.api.releaseWindowsNativeOwnedProcessHandles(cap);
            assert.equal(m.counts.release, 1);
            assert.equal(m.counts.launch, 1);
        } finally {
            finish();
            await task.catch(() => {});
        }
    }
    for (const mode of [
        'null',
        'missing',
        'not-empty',
        'no-lease',
        'same-parent',
        'bad-volume',
        'extra',
        'flag-mismatch',
        'attempted-without-profile',
    ]) {
        const m = launchMemory(),
            profile = m.useSiblingProfileModel(),
            cap = await m.prepare();
        if (mode === 'null') profile.directory = null;
        if (mode === 'missing') profile.directory = undefined;
        if (mode === 'not-empty') profile.directory.emptyAtPreflight = false;
        if (mode === 'no-lease') profile.directory.leaseRetained = false;
        if (mode === 'same-parent') profile.directory.fileId = profile.directory.parentFileId;
        if (mode === 'bad-volume') profile.directory.volumeSerial = 'x'.repeat(16);
        if (mode === 'extra') profile.directory.fresh = true;
        if (mode === 'flag-mismatch' || mode === 'attempted-without-profile') {
            m.native.launchPinnedProcess = () => {
                m.counts.launch++;
                m.state.attempted = true;
                return JSON.stringify({
                    ...m.facts(),
                    profileDirectory: mode === 'flag-mismatch' ? profile.directory : null,
                });
            };
        }
        await assert.rejects(
            m.api.launchWindowsNativePinnedSiblingProcess(cap, m.inside(siblingInput())),
        );
        assert.equal(m.counts.launch, 1);
        assert.equal(m.counts.release, 0);
        assert.throws(() => m.api.releaseWindowsNativeOwnedProcessHandles(cap), /LIVE_OR_UNKNOWN/);
    }
});

test('memory actual sibling producer and original readback reach the real shared consumer without qualification', async () => {
    const m = launchMemory(),
        profile = m.useSiblingProfileModel(),
        lifecycle = m.ownedRuntime();
    const result = await finishRuntimeModel(m, lifecycle.observeWindowsNativeOwnedSiblingRuntime);
    assert.equal(
        result.status,
        'selected-pinned-runtime-and-component-closure-consistent-unqualified',
    );
    assert.equal(result.componentHandlesAndLifetimeAcknowledged, true);
    for (const key of [
        'installationObserved',
        'offlineObserved',
        'uiObserved',
        'physicalLoadedBytesVerified',
        'physicalDescendantClosure',
        'installerCaseComplete',
        'releaseAcceptance',
    ])
        assert.equal(result[key], false);
    assert.deepEqual(profile.profiles, [siblingInput().profile]);
    assert.equal(m.counts.launch, 1);
    assert.equal(m.counts.release, 1);
    assert.equal(m.quit.appQuitCalls, 1);
    const envelope = JSON.parse(result.bytes.toString());
    assert.equal(envelope.observation.kind, 'windows-native-owned-runtime/v2');
    const kinds = {
        'created-process': 'windows-native-created-process/v3',
        'normal-quit': 'windows-native-normal-quit/v2',
        'owned-release': 'windows-native-owned-release/v2',
    };
    for (const [role, kind] of Object.entries(kinds)) {
        const row = JSON.parse(result.originalRecords[role]);
        assert.equal(row.kind, kind);
        assert.deepEqual(row.requestedLaunch, siblingInput());
    }
    assert.deepEqual(
        envelope.observation.createdProcess.observation.profileDirectory,
        profile.directory,
    );
    const files = new Map([
        [result.lifecycleEvidence.path, Buffer.from(result.bytes)],
        ...Object.entries(result.originalRecords).map(([role, bytes]) => [
            'windows-native/owned-runtime/' + role + '.json',
            Buffer.from(bytes),
        ]),
    ]);
    const reads = [],
        read = async (name, maximum) => {
            reads.push(name);
            const bytes = files.get(name);
            assert.ok(bytes && bytes.length <= maximum);
            return Buffer.from(bytes);
        };
    await lifecycle.readWindowsNativeOwnedSiblingRecords(envelope.observation, read);
    reads.length = 0;
    const summary = await consumeInstallerLifecycleEvidence(
        {
            schemaVersion: 2,
            kind: 'native-installer-lifecycle',
            runId: m.expected().runId,
            runAttempt: m.expected().runAttempt,
            cases: [
                {
                    id: request().caseId,
                    lifecycleEvidence: result.lifecycleEvidence,
                    evidence: result.evidence,
                },
            ],
        },
        m.expected(),
        read,
    );
    assert.equal(summary.releaseAcceptance, false);
    assert.equal(summary.status, 'installer-lifecycle-unqualified');
    assert.equal(summary.observations[0].status, result.status);
    assert.deepEqual(reads, [
        result.lifecycleEvidence.path,
        ...Object.keys(result.originalRecords).map(
            (role) => 'windows-native/owned-runtime/' + role + '.json',
        ),
    ]);
    assert.equal(JSON.stringify(envelope).includes(m.quit.endpoint), false);
});

test('memory sibling rows cannot launder legacy inside-profile history or mixed version and ownership facts', async () => {
    const current = launchMemory(),
        profile = current.useSiblingProfileModel(),
        lifecycle = current.ownedRuntime();
    const result = await finishRuntimeModel(
        current,
        lifecycle.observeWindowsNativeOwnedSiblingRuntime,
    );
    const original = Object.fromEntries(
        Object.entries(result.originalRecords).map(([role, bytes]) => [role, JSON.parse(bytes)]),
    );
    const inspect = (rows) =>
        lifecycle.inspectWindowsNativeOwnedSiblingRows(
            ...['file-pins', 'created-process', 'normal-quit', 'owned-release'].map((role) =>
                current.inside(rows[role]),
            ),
            current.inside(request()),
        );
    inspect(original);
    assert.throws(() =>
        lifecycle.inspectWindowsNativeOwnedRows(
            ...['file-pins', 'created-process', 'normal-quit', 'owned-release'].map((role) =>
                current.inside(original[role]),
            ),
            current.inside(request()),
        ),
    );
    for (const change of [
        (rows) => {
            rows['created-process'].kind = 'windows-native-created-process/v2';
        },
        (rows) => {
            rows['normal-quit'].kind = 'windows-native-normal-quit/v1';
        },
        (rows) => {
            rows['owned-release'].kind = 'windows-native-owned-release/v1';
        },
        (rows) => {
            for (const role of ['created-process', 'normal-quit', 'owned-release'])
                rows[role].requestedLaunch = {
                    action: 'launch-pinned-installed',
                    profile: request().root + '\\native-launch-profile',
                };
        },
        (rows) => {
            rows['created-process'].observation.profileDirectory = null;
        },
        (rows) => {
            rows['created-process'].observation.profileDirectory.volumeSerial = 'd'.repeat(16);
        },
        (rows) => {
            rows['created-process'].observation.profileDirectory.fileId =
                profile.directory.parentFileId;
        },
        (rows) => {
            rows['created-process'].observation.profileDirectory.leaseRetained = false;
        },
    ]) {
        const changed = structuredClone(original);
        change(changed);
        assert.throws(() => inspect(changed));
    }
    const old = launchMemory(),
        legacy = old.ownedRuntime();
    const historical = await finishRuntimeModel(old, legacy.observeWindowsNativeOwnedRuntime);
    const oldEnvelope = JSON.parse(historical.bytes.toString());
    assert.equal(oldEnvelope.observation.kind, 'windows-native-owned-runtime/v1');
    assert.equal(oldEnvelope.observation.createdProcess.kind, 'windows-native-created-process/v2');
    assert.equal(
        Object.hasOwn(oldEnvelope.observation.createdProcess.observation, 'profileDirectory'),
        false,
    );
    assert.equal(
        oldEnvelope.observation.createdProcess.requestedLaunch.profile,
        request().root + '\\native-launch-profile',
    );
    const oldRows = Object.fromEntries(
        Object.entries(historical.originalRecords).map(([role, bytes]) => [
            role,
            JSON.parse(bytes),
        ]),
    );
    assert.throws(() => inspect(oldRows));
    assert.equal(historical.releaseAcceptance, false);
});
