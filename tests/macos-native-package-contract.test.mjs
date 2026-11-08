import assert from 'node:assert/strict';
import test from 'node:test';
import { runMacNativeCLI } from './macos-installer-native-cli.mjs';
import {
    NATIVE_EFFECTS,
    NATIVE_LIMITS,
    normalizeMacTree,
} from '../scripts/lib/macos-native-contract.mjs';
import { digest } from '../scripts/lib/staged-artifact-gate.mjs';
import { macPayloadIdentity } from '../scripts/lib/macos-payload-identity.mjs';

const NATIVE_TASK = '/synthetic/mac-native-task';

// Controlled binding data only. No native IO, extraction, helper or app is invoked.
function fixture() {
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    const nonce = '1'.repeat(32);
    const root = NATIVE_TASK + '/diagnostic-hub-v060-macos-native-run-' + nonce;
    const files = new Map();
    const calls = [];
    const writeJSON = (file, value) => files.set(file, Buffer.from(JSON.stringify(value)));
    const sourcePins = ['node', 'tsx', 'playwright'].map((role) => ({
        role,
        path: NATIVE_TASK + '/mock/' + role,
    }));
    for (const pin of sourcePins)
        files.set(pin.path, Buffer.from('inert-' + pin.role + '-identity'));
    const inputs = {};
    for (const role of ['current', 'prior']) {
        const prefix = NATIVE_TASK + '/mock/' + role;
        const zip = Buffer.from(role + '-not-an-actual-zip');
        files.set(prefix + '.zip', zip);
        const info = {
            platform: 'darwin',
            arch: 'arm64',
            version: role === 'current' ? '0.6.0' : '0.5.2',
            commit: (role === 'current' ? 'a' : 'b').repeat(40),
            asset: 'Diagnostic-Hub-macos-arm64.zip',
            sha256: digest(zip),
            asarSHA256: digest('inert-asar'),
            bundleIdentifier: 'dev.diagnostichub.desktop',
            minimumMacOSVersion: '13.0.0',
            signature: 'ad-hoc',
            adHocIntegrityVerified: true,
            notarized: false,
            gatekeeperDownloadedAppQualified: false,
        };
        writeJSON(prefix + '.json', info);
        writeJSON(prefix + '.tree.json', {
            files: [
                ...['Contents', 'Contents/Resources', 'Contents/MacOS'].map((path) => ({
                    path,
                    kind: 'directory',
                    mode: 0o755,
                })),
                {
                    path: 'Contents/Info.plist',
                    kind: 'file',
                    bytes: 1,
                    sha256: digest('plist'),
                    mode: 0o644,
                },
                {
                    path: 'Contents/Resources/app.asar',
                    kind: 'file',
                    bytes: 1,
                    sha256: info.asarSHA256,
                    mode: 0o644,
                },
                {
                    path: 'Contents/MacOS/Diagnostic Hub',
                    kind: 'file',
                    bytes: 1,
                    sha256: digest('main'),
                    mode: 0o755,
                },
            ],
        });
        info.payloadIdentity = macPayloadIdentity(
            normalizeMacTree(JSON.parse(files.get(prefix + '.tree.json'))),
        );
        writeJSON(prefix + '.json', info);
        inputs[role] = {
            zip: prefix + '.zip',
            info: prefix + '.json',
            tree: prefix + '.tree.json',
            zipBytes: zip.length,
            zipSHA256: digest(zip),
            infoSHA256: digest(files.get(prefix + '.json')),
            treeSHA256: digest(files.get(prefix + '.tree.json')),
        };
    }
    const approval = {
        operation: 'macos-native-installer-lifecycle',
        approved: true,
        nonce,
        root,
        sourceRoot: NATIVE_TASK + '/mock/source',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'c'.repeat(40),
        windowMs: NATIVE_LIMITS.windowMs,
        clockAllowanceMs: 0,
        minimumFreeBytes: 1,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + NATIVE_LIMITS.windowMs).toISOString(),
        effects: [...NATIVE_EFFECTS],
        inputs,
        pins: sourcePins.map((pin) => ({
            ...pin,
            bytes: files.get(pin.path).length,
            sha256: digest(files.get(pin.path)),
        })),
    };
    const forbidden = (name) => () => {
        calls.push(name);
        throw Error('Native actor forbidden in this binding-only test: ' + name);
    };
    const io = {
        taskRoot: NATIVE_TASK,
        state: { rootAllocated: false, claim: null, reason: null },
        needsHold: () => false,
        beforeExpiry: () => true,
        gate() {},
        nowUTC: () => now + 1,
        setExpiry() {},
        canonicalDir: (name) => name,
        absent: () => true,
        metadata: () => ({
            platform: 'darwin',
            arch: 'arm64',
            node: '24.22.0',
            executable: sourcePins[0].path,
        }),
        read(name, cap) {
            const bytes = files.get(name);
            assert.ok(bytes && bytes.length <= cap);
            return Buffer.from(bytes);
        },
        hash(name, expectedBytes) {
            const bytes = files.get(name);
            assert.ok(bytes);
            assert.equal(bytes.length, expectedBytes);
            return { bytes: bytes.length, sha256: digest(bytes) };
        },
        ...Object.fromEntries(
            [
                'freeBytes',
                'claim',
                'sourceContext',
                'allocateRoot',
                'publish',
                'child',
                'mkdir',
            ].map((name) => [name, forbidden(name)]),
        ),
    };
    const mutateJSON = (role, kind, change) => {
        const file = inputs[role][kind];
        const value = JSON.parse(files.get(file));
        change(value);
        writeJSON(file, value);
        inputs[role][kind + 'SHA256'] = digest(files.get(file));
    };
    const run = async (mode = '--validate') => {
        const approvalPath = NATIVE_TASK + '/mock/approval.json';
        writeJSON(approvalPath, approval);
        return runMacNativeCLI(
            [
                mode,
                '--task-root',
                NATIVE_TASK,
                ...['node', 'tsx', 'playwright'].flatMap((role) => [
                    '--' + role,
                    sourcePins.find((pin) => pin.role === role).path,
                ]),
                '--approval',
                approvalPath,
                '--approval-sha256',
                digest(files.get(approvalPath)),
                '--root',
                root,
                '--source-root',
                approval.sourceRoot,
                ...['current', 'prior'].flatMap((role) =>
                    ['zip', 'info', 'tree'].flatMap((kind) => [
                        '--' + role + '-' + kind,
                        inputs[role][kind],
                    ]),
                ),
            ],
            {
                createIO: () => io,
                sourcePins: () => sourcePins,
                createEffects: forbidden('createEffects'),
                runActions: forbidden('runActions'),
            },
        );
    };
    return { files, calls, inputs, approval, mutateJSON, run };
}

test('controlled valid bindings validate without claiming execution or qualification', async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.exitCode, 0, result.output);
    const output = JSON.parse(result.output);
    assert.equal(output.status, 'INPUT_BINDINGS_VALIDATED_ONLY');
    assert.equal(output.nativeEffects, false);
    assert.equal(output.qualificationStatus, 'unverified');
    assert.deepEqual(f.calls, []);
});

for (const role of ['current', 'prior']) {
    for (const mode of [0o000, 0o600, 0o644, 0o666, 0o011]) {
        test(
            role + ' main without owner execute permission refuses: ' + mode.toString(8),
            async () => {
                const f = fixture();
                f.mutateJSON(role, 'tree', (tree) => {
                    const main = tree.files.find(
                        (entry) => entry.path === 'Contents/MacOS/Diagnostic Hub',
                    );
                    main.mode = mode;
                });
                const result = await f.run();
                assert.equal(result.exitCode, 2, result.output);
                assert.equal(result.state.phase, 'input-validation');
                assert.match(
                    result.state.failure.message,
                    /main executable must be owner-executable/,
                );
                assert.deepEqual(f.calls, []);
            },
        );
    }
}

for (const role of ['current', 'prior']) {
    test(role + ' nonexecutable main refuses --run before SPENT or native actors', async () => {
        const f = fixture();
        f.mutateJSON(role, 'tree', (tree) => {
            const main = tree.files.find((entry) => entry.path === 'Contents/MacOS/Diagnostic Hub');
            main.mode = 0o644;
        });
        const result = await f.run('--run');
        assert.equal(result.exitCode, 2, result.output);
        assert.equal(result.state.phase, 'input-validation');
        assert.match(result.state.failure.message, /main executable must be owner-executable/);
        assert.deepEqual(f.calls, []);
    });
}

for (const [name, change] of [
    ['ZIP bytes', (f, role) => f.files.set(f.inputs[role].zip, Buffer.from('changed'))],
    ['manifest bytes', (f, role) => f.files.set(f.inputs[role].info, Buffer.from('{}'))],
    ['inventory bytes', (f, role) => f.files.set(f.inputs[role].tree, Buffer.from('{}'))],
    [
        'architecture',
        (f, role) => {
            f.mutateJSON(role, 'info', (info) => {
                info.arch = 'x64';
            });
        },
    ],
    [
        'ASAR hash',
        (f, role) => {
            f.mutateJSON(role, 'tree', (tree) => {
                const asar = tree.files.find(
                    (entry) => entry.path === 'Contents/Resources/app.asar',
                );
                asar.sha256 = '0'.repeat(64);
            });
        },
    ],
]) {
    for (const role of ['current', 'prior']) {
        test(role + ' mismatched ' + name + ' refuses before native actors', async () => {
            const f = fixture();
            change(f, role);
            assert.equal((await f.run()).exitCode, 2);
            assert.deepEqual(f.calls, []);
        });
    }
}

for (const mode of [0o100, 0o500, 0o700, 0o755]) {
    test('normalized bundle preserves owner-executable main mode ' + mode.toString(8), () => {
        const f = fixture();
        const tree = JSON.parse(f.files.get(f.inputs.current.tree));
        const main = tree.files.find((entry) => entry.path === 'Contents/MacOS/Diagnostic Hub');
        main.mode = mode;
        assert.equal(normalizeMacTree(tree).find((entry) => entry.path === main.path).mode, mode);
    });
}

for (const [label, change] of [
    [
        'missing current inventory binding',
        (f) =>
            f.mutateJSON('current', 'info', (v) => {
                delete v.payloadIdentity;
            }),
    ],
    [
        'changed main bytes with honestly rehashed input tree',
        (f) =>
            f.mutateJSON('current', 'tree', (v) => {
                v.files.find((r) => r.path === 'Contents/MacOS/Diagnostic Hub').sha256 =
                    digest('replacement');
            }),
    ],
    [
        'changed executable permissions',
        (f) =>
            f.mutateJSON('current', 'tree', (v) => {
                v.files.find((r) => r.path === 'Contents/MacOS/Diagnostic Hub').mode = 0o700;
            }),
    ],
    [
        'changed auxiliary file',
        (f) =>
            f.mutateJSON('current', 'tree', (v) => {
                v.files.find((r) => r.path === 'Contents/Info.plist').sha256 =
                    digest('replacement');
            }),
    ],
])
    test('shipping inventory binding refuses ' + label + ' before native actors', async () => {
        const f = fixture();
        change(f);
        assert.equal((await f.run('--run')).exitCode, 2);
        assert.deepEqual(f.calls, []);
    });
