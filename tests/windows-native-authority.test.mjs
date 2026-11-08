import assert from 'node:assert/strict';
import test from 'node:test';
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
