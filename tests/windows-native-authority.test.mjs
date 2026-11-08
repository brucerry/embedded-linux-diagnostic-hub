import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    launchWindowsNativePinnedProcess,
    sampleWindowsNativeOwnedProcess,
    readWindowsNativeOwnedProcess,
    releaseWindowsNativeOwnedProcessHandles,
    drainWindowsNativeOwnedStdio,
    readWindowsNativeMainInspectorEndpoint,
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
        let resolve;
        const promise = new Promise((done) => {
            resolve = done;
        });
        return { promise, resolve };
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
    });
    const context = vm.createContext(
        {
            Buffer,
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
    return {
        api,
        native,
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
