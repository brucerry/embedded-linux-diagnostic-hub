import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
    PLATFORM_LANES,
    nativeRuntimeBindings,
    validateNativeRuntimeIdentity,
    validateRetainedRuntimeIdentity,
} from '../scripts/lib/staged-artifact-gate.mjs';

// Observations shaped exactly like staged-artifact-native.mts, entirely synthetic.
function fixture(lane = 'linux-x64') {
    const definition = PLATFORM_LANES.find((item) => item.id === lane)!;
    const expected = { version: '0.6.0', lane };
    const applications = Object.values(nativeRuntimeBindings(lane)).map((asset, i) => ({
        asset,
        packaged: true,
        version: expected.version,
        platform: definition.platform,
        arch: definition.arch,
        executable: definition.platform === 'win32' ? 'C:\\synthetic\\hub.exe' : '/synthetic/hub',
        asar:
            definition.platform === 'win32'
                ? 'C:\\synthetic\\resources\\app.asar'
                : '/synthetic/resources/app.asar',
        executableSHA256: String(i + 1).repeat(64),
        asarSHA256: String(i + 3).repeat(64),
        rendererPID: 101 + i,
        contextsSeparated: true,
        pageNodeAbsent: true,
        osSandboxed: true,
        sandbox: true,
        versions: { electron: '44.5.1', node: '24.21.0', chrome: 'synthetic' },
    }));
    return { expected, receipt: { applications }, applications };
}

test('all native lanes bind each fixed runtime case to its own designated artifact', () => {
    const fixed: Record<string, Record<string, string>> = {
        'win32-x64': { 'portable-runtime-identity': 'Diagnostic-Hub.exe' },
        'linux-x64': {
            'appimage-runtime-identity': 'Diagnostic-Hub-linux-x64.AppImage',
            'archive-runtime-identity': 'Diagnostic-Hub-linux-x64.tar.gz',
        },
        'darwin-x64': { 'installed-runtime-identity': 'Diagnostic-Hub-macos-x64.zip' },
        'darwin-arm64': { 'installed-runtime-identity': 'Diagnostic-Hub-macos-arm64.zip' },
    };
    for (const lane of PLATFORM_LANES) {
        const f = fixture(lane.id);
        assert.deepEqual(nativeRuntimeBindings(lane.id), fixed[lane.id]);
        assert.equal(Object.isFrozen(nativeRuntimeBindings(lane.id)), true);
        for (const [caseId, asset] of Object.entries(nativeRuntimeBindings(lane.id))) {
            const actual = f.applications.find((item) => item.asset === asset)!;
            assert.equal(validateNativeRuntimeIdentity(actual, { ...f.expected, caseId }), actual);
            assert.equal(
                validateRetainedRuntimeIdentity(actual, f.receipt, f.expected, caseId),
                actual,
            );
        }
    }
    assert.throws(() => nativeRuntimeBindings('unsupported'));
});

test('swapped Linux observations cannot borrow another matching application summary', () => {
    const f = fixture();
    for (const [index, caseId] of [
        'appimage-runtime-identity',
        'archive-runtime-identity',
    ].entries()) {
        const swapped = f.applications[1 - index];
        // Exact former comparison accepted both swaps; hashes and summary equality are insufficient.
        assert.deepEqual(
            swapped,
            f.receipt.applications.find((app) => app.asset === swapped.asset),
        );
        assert.throws(
            () => validateRetainedRuntimeIdentity(swapped, f.receipt, f.expected, caseId),
            /different staged asset/,
        );
    }
});

for (const field of ['contextsSeparated', 'pageNodeAbsent', 'osSandboxed', 'sandbox'] as const)
    test('missing or failed ' + field + ' cannot be hidden behind a sandbox summary', () => {
        const f = fixture();
        for (const value of [undefined, null, false, 1, 'true']) {
            const actual = { ...f.applications[0], [field]: value };
            assert.throws(
                () =>
                    validateNativeRuntimeIdentity(actual, {
                        ...f.expected,
                        caseId: 'appimage-runtime-identity',
                    }),
                /native observation/,
            );
        }
    });

test('observed renderer and packaged paths are mandatory without platform path rewriting', () => {
    for (const lane of PLATFORM_LANES) {
        const f = fixture(lane.id),
            caseId = Object.keys(nativeRuntimeBindings(lane.id))[0];
        for (const update of [
            { rendererPID: null },
            { rendererPID: 0 },
            { rendererPID: -1 },
            { rendererPID: 1.5 },
            { rendererPID: Number.MAX_SAFE_INTEGER + 1 },
            { executable: undefined },
            { executable: 'relative' },
            { asar: undefined },
            { asar: 'relative/app.asar' },
            {
                asar:
                    lane.platform === 'win32'
                        ? 'C:\\synthetic\\other.asar'
                        : '/synthetic/other.asar',
            },
            { executableSHA256: 'unknown' },
            { asarSHA256: 'unknown' },
            { version: '0.5.2' },
            { packaged: false },
        ])
            assert.throws(() =>
                validateNativeRuntimeIdentity(
                    { ...f.applications[0], ...update },
                    {
                        ...f.expected,
                        caseId,
                    },
                ),
            );
    }
});

test('retained evidence cannot replace, duplicate or omit its designated summary', () => {
    const f = fixture(),
        actual = f.applications[0],
        caseId = 'appimage-runtime-identity';
    assert.throws(() =>
        validateRetainedRuntimeIdentity(actual, { applications: [] }, f.expected, caseId),
    );
    assert.throws(() =>
        validateRetainedRuntimeIdentity(
            actual,
            { applications: [actual, actual] },
            f.expected,
            caseId,
        ),
    );
    assert.throws(
        () =>
            validateRetainedRuntimeIdentity(
                { ...actual, asarSHA256: 'f'.repeat(64) },
                f.receipt,
                f.expected,
                caseId,
            ),
        /summary differs/,
    );
    assert.throws(() =>
        validateRetainedRuntimeIdentity(actual, f.receipt, f.expected, 'portable-runtime-identity'),
    );
    assert.throws(() =>
        validateRetainedRuntimeIdentity(
            actual,
            f.receipt,
            { ...f.expected, lane: 'darwin-x64' },
            'installed-runtime-identity',
        ),
    );
});

test('final verifier uses fixed-case binding after retained evidence rehash and bounded JSON read', async () => {
    const source = await readFile('scripts/staged-artifact-gate.mjs', 'utf8');
    const verifier = source.slice(
        source.indexOf("} else if (mode === 'verify')"),
        source.indexOf("} else if (mode === 'verify-producers')"),
    );
    assert.ok(
        verifier.indexOf('await verifyEvidence(output, receipt.cases)') <
            verifier.indexOf('validateRetainedRuntimeIdentity('),
    );
    assert.match(verifier, /readBoundedJSON\([\s\S]*64 \* 1024/);
    assert.match(
        verifier,
        /validateRetainedRuntimeIdentity\(\s*identity,\s*receipt,\s*\{ \.\.\.selected, lane: lane\.id \},\s*item\.id,/,
    );
    assert.doesNotMatch(
        verifier,
        /applications\.find\(\(app\) => app\.asset === identity\.asset\)/,
    );
});
