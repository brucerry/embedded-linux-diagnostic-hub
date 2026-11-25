import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rename, symlink, writeFile } from 'node:fs/promises';
import {
    requiresStagedMacRuntimeBinding,
    validateStagedMacRuntimeBinding,
} from '../scripts/lib/staged-mac-runtime.mjs';
import {
    digest,
    laneFiles,
    validateRetainedRuntimeIdentity,
    verifyEvidence,
} from '../scripts/lib/staged-artifact-gate.mjs';
import {
    fixtureMacMarker,
    fixtureMacRuntime,
    stageMacRuntimeFixture,
} from './fixtures/staged-mac-runtime-memory.mjs';

function setup(lane = 'darwin-arm64') {
    const expected = {
        lane,
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        runId: '123',
        runAttempt: '2',
        artifacts: laneFiles('0.6.0', lane).map((name) => ({
            name,
            bytes: 7,
            sha256: digest(name),
        })),
    };
    const actual = {
        ...fixtureMacRuntime,
        platform: 'darwin',
        arch: lane.slice('darwin-'.length),
        version: expected.version,
        asset: 'Diagnostic-Hub-macos-' + lane.slice('darwin-'.length) + '.zip',
        packaged: true,
        contextsSeparated: true,
        pageNodeAbsent: true,
        osSandboxed: true,
        sandbox: true,
        rendererPID: 101,
        versions: { electron: '44.5.1', node: '24.21.0', chrome: 'synthetic' },
    };
    const receipt = {
        applications: [actual],
        cases: [
            {
                id: 'bundle-helper-installer',
                status: 'passed',
                exitCode: 0,
                signal: null,
                evidence: [],
            },
        ],
    };
    return { actual, expected, receipt };
}

test('both Mac architectures reload exact helper bytes and correlate distinct shipping executable/ASAR pins', async (t) => {
    for (const lane of ['darwin-arm64', 'darwin-x64']) {
        const f = setup(lane);
        const files = await stageMacRuntimeFixture(t, f.expected, f.receipt);
        const macRuntimeBinding = await files.readBinding();
        assert.deepEqual(await readFile(files.markerFile), fixtureMacMarker);
        // The production workflow retains the original helper marker under its own case.
        await verifyEvidence(files.output, f.receipt.cases);
        assert.equal(
            validateRetainedRuntimeIdentity(
                f.actual,
                f.receipt,
                { ...f.expected, macRuntimeBinding },
                'installed-runtime-identity',
            ),
            f.actual,
        );
        assert.equal(
            validateStagedMacRuntimeBinding(
                f.actual,
                { ...f.expected, macRuntimeBinding },
                f.receipt,
            ),
            f.actual,
        );
        assert.ok(!('qualification' in macRuntimeBinding));
    }
});

test('agreed runtime summary cannot hide either wrong hash or the same bytes at another installed path', async (t) => {
    const f = setup();
    const files = await stageMacRuntimeFixture(t, f.expected, f.receipt);
    const expected = { ...f.expected, macRuntimeBinding: await files.readBinding() };
    for (const [change, message] of [
        [{ executableSHA256: '1'.repeat(64) }, /executable SHA-256 differs/],
        [{ asarSHA256: '1'.repeat(64) }, /ASAR SHA-256 differs/],
        [
            { executable: f.actual.executable.replace('hub-model', 'other') },
            /executable is not helper-installed/,
        ],
        [{ asar: f.actual.asar.replace('hub-model', 'other') }, /ASAR is not helper-installed/],
    ] as const) {
        const actual = { ...f.actual, ...change };
        assert.throws(
            () =>
                validateRetainedRuntimeIdentity(
                    actual,
                    { ...f.receipt, applications: [actual] },
                    expected,
                    'installed-runtime-identity',
                ),
            message,
        );
    }
    assert.throws(
        () =>
            validateRetainedRuntimeIdentity(
                f.actual,
                f.receipt,
                { ...f.expected, macRuntimeBinding: { ...expected.macRuntimeBinding } },
                'installed-runtime-identity',
            ),
        /Missing independently read current Mac runtime binding/,
    );
    assert.throws(
        () =>
            validateRetainedRuntimeIdentity(
                f.actual,
                f.receipt,
                { ...expected, runAttempt: '3' },
                'installed-runtime-identity',
            ),
        /different run/,
    );
});

test('missing, misplaced, duplicated, changed or aliased helper marker remains blocked', async (t) => {
    const f = setup();
    const files = await stageMacRuntimeFixture(t, f.expected, f.receipt);
    const helper = f.receipt.cases[0];
    (helper.evidence as unknown[]).pop();
    await assert.rejects(files.readBinding(), /unique pinned Mac input/);
    (helper.evidence as unknown[]).push(files.marker, files.marker);
    await assert.rejects(files.readBinding(), /unique pinned Mac input/);
    (helper.evidence as unknown[]).pop();
    helper.status = 'failed';
    await assert.rejects(files.readBinding());
    helper.status = 'passed';
    const other = structuredClone(helper);
    other.id = 'installed-desktop';
    f.receipt.cases.push(other);
    assert.strictEqual(other.evidence.length, 1);
    await assert.rejects(files.readBinding(), /must belong only to its own case/);
    f.receipt.cases.pop();

    const rewrites = [
        Buffer.from(fixtureMacMarker.toString().replaceAll('hub-model', 'hut-model')),
        Buffer.from(
            fixtureMacMarker.toString().replaceAll('/hub-model/', '/hub-model/../hub-model/'),
        ),
        Buffer.concat([fixtureMacMarker, fixtureMacMarker]),
        Buffer.concat([fixtureMacMarker, Buffer.from('\n')]),
        Buffer.from(
            fixtureMacMarker
                .toString()
                .replace('/Contents/MacOS/Diagnostic Hub', '/Contents/MacOS/wrong'),
        ),
    ];
    await writeFile(files.markerFile, rewrites[0]);
    await assert.rejects(files.readBinding(), /Mac input bytes changed/);
    for (const value of rewrites.slice(1)) {
        await writeFile(files.markerFile, value);
        Object.assign(files.marker, { bytes: value.length, sha256: digest(value) });
        await assert.rejects(files.readBinding(), /canonical helper|helper marker|does not belong/);
    }
    await writeFile(files.markerFile, fixtureMacMarker);
    Object.assign(files.marker, {
        bytes: fixtureMacMarker.length,
        sha256: digest(fixtureMacMarker),
    });
    await rename(files.markerFile, files.markerFile + '.alias-target');
    await symlink(files.markerFile + '.alias-target', files.markerFile);
    await assert.rejects(files.readBinding(), /Aliased staged Mac input/);
});

test('shipping build-info must match selected bytes, artifact digest, source, architecture and current payload', async (t) => {
    const f = setup();
    const files = await stageMacRuntimeFixture(t, f.expected, f.receipt);
    await writeFile(files.manifestFile, Buffer.from('unexpected'));
    await assert.rejects(files.readBinding(), /length changed/);
    for (const update of [
        { arch: 'x64' },
        { version: '0.5.2' },
        { commit: 'f'.repeat(40) },
        { sha256: '1'.repeat(64) },
        { payloadIdentity: undefined },
        { asarSHA256: '2'.repeat(64) },
    ]) {
        await files.setManifest({ ...files.info, ...update });
        await assert.rejects(files.readBinding());
    }
    await files.setManifest(files.info);
    const bytes = await readFile(files.manifestFile, 'utf8');
    await files.setManifest(
        Buffer.from(bytes.replace('"arch": "arm64",', '"arch": "arm64", "arch": "arm64",')),
    );
    await assert.rejects(files.readBinding(), /unambiguous/);
});

test('historical and non-Mac lanes do not gain a new staging requirement', () => {
    assert.equal(
        requiresStagedMacRuntimeBinding({ lane: 'darwin-arm64', version: '0.5.2' }),
        false,
    );
    assert.equal(requiresStagedMacRuntimeBinding({ lane: 'linux-x64', version: '0.6.0' }), false);
    assert.equal(requiresStagedMacRuntimeBinding({ lane: 'win32-x64', version: '0.6.0' }), false);
    assert.equal(
        requiresStagedMacRuntimeBinding({ lane: 'darwin-x64', version: '0.6.0-rc.1' }),
        true,
    );
});
