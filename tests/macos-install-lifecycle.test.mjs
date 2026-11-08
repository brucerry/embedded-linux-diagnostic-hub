// Authored in-memory controls only; none are installed/native observations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { produceMacInstallLifecycle } from '../scripts/lib/macos-install-lifecycle.mjs';
import {
    consumeInstallerLifecycleEvidence,
    inspectInstallerCaseObservation,
} from '../scripts/lib/installer-lifecycle-evidence.mjs';
import { macPayloadIdentity } from '../scripts/lib/macos-payload-identity.mjs';
import { projectMacHelperChild } from '../scripts/lib/macos-installer-child.mjs';
import { installerMemoryFixture } from './fixtures/installer-lifecycle-memory.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const id = 'macos-bundle:install';
function fixture(lane = 'darwin-arm64') {
    const base = installerMemoryFixture(lane),
        expected = base.expected;
    const archive = expected.artifacts.find(
        (row) => row.name === 'Diagnostic-Hub-macos-' + lane.slice(7) + '.zip',
    );
    const payload = macPayloadIdentity([
        { path: 'Contents', kind: 'directory', mode: 0o755 },
        { path: 'Contents/MacOS', kind: 'directory', mode: 0o755 },
        { path: 'Contents/Resources', kind: 'directory', mode: 0o755 },
        ...[
            'Contents/Info.plist',
            'Contents/Resources/app.asar',
            'Contents/MacOS/Diagnostic Hub',
        ].map((path) => ({ path, kind: 'file', mode: 0o755, bytes: 1, sha256: hash(path) })),
    ]);
    const root = '/synthetic/task/diagnostic-hub-v060-macos-native-run-' + '1'.repeat(32);
    const operation = {
        operationId: '1'.repeat(32) + ':' + id + ':helper:1',
        caseId: id,
        observerSource: { commit: expected.sourceCommit, tree: expected.sourceTree },
        package: { ...archive, version: expected.version, sourceCommit: expected.sourceCommit },
        fixtureRoot: root + '/install',
        helper: root + '/bin/download-run-macos.sh',
    };
    const command = [
        '/bin/bash',
        operation.helper,
        '--version',
        'v' + expected.version,
        '--directory',
        operation.fixtureRoot + '/Applications',
        '--no-launch',
    ];
    const stdout = Buffer.from('synthetic saved payload\n'),
        stderr = Buffer.alloc(0);
    const child = projectMacHelperChild(
        {
            request: { executable: command[0], args: command.slice(1), operation },
            error: 'none',
            exitObserved: true,
            closeObserved: true,
            exitCode: 0,
            signal: null,
            stdoutEOF: true,
            stderrEOF: true,
        },
        1,
        Object.fromEntries(
            [
                ['stdout', stdout],
                ['stderr', stderr],
            ].map(([name, bytes]) => [
                name,
                { path: 'child-1.' + name, bytes: bytes.length, sha256: hash(bytes) },
            ]),
        ),
    );
    const absent = {
        exists: false,
        version: null,
        asarSHA256: null,
        profileFiles: [],
        reportFiles: [],
    };
    const values = {
        actionCase: {
            id,
            status: 'verified',
            actions: [
                {
                    method: 'prepare',
                    returned: true,
                    facts: {
                        id,
                        root: operation.fixtureRoot,
                        target: operation.fixtureRoot + '/Applications/Diagnostic Hub.app',
                        fresh: true,
                    },
                },
                { method: 'snapshot', returned: true, facts: absent },
                {
                    method: 'install',
                    returned: true,
                    facts: {
                        command,
                        exitObserved: true,
                        exitCode: 0,
                        signal: null,
                        error: 'none',
                    },
                },
                {
                    method: 'snapshot',
                    returned: true,
                    facts: {
                        ...absent,
                        exists: true,
                        version: expected.version,
                        asarSHA256: payload.asarSHA256,
                    },
                },
            ],
        },
        helperChild: structuredClone(child),
        installedPayload: {
            schemaVersion: 1,
            kind: 'macos-installed-payload-sample',
            caseId: id,
            version: expected.version,
            sourceCommit: expected.sourceCommit,
            sourceTree: expected.sourceTree,
            archive: { ...archive },
            payloadIdentity: { ...payload },
            qualification: false,
        },
        shippingBuildInfo: {
            platform: 'darwin',
            arch: lane.slice(7),
            version: expected.version,
            commit: expected.sourceCommit,
            source: expected.sourceCommit,
            packagedSourceMatches: true,
            distribution: true,
            asset: archive.name,
            sha256: archive.sha256,
            asarSHA256: payload.asarSHA256,
            payloadIdentity: { ...payload },
            bundleIdentifier: 'dev.diagnostichub.desktop',
            minimumMacOSVersion: '13.0.0',
            signature: 'ad-hoc',
            adHocIntegrityVerified: true,
            notarized: false,
            gatekeeperDownloadedAppQualified: false,
        },
    };
    const paths = {
        actionCase: 'evidence/install-only-case.json',
        helperChild: 'evidence/child-1.json',
        installedPayload: 'install/evidence/installed-payload-1.json',
        shippingBuildInfo: 'evidence/current-shipping-build-info.json',
    };
    const files = new Map([
            ['evidence/child-1.stdout', stdout],
            ['evidence/child-1.stderr', stderr],
        ]),
        records = {};
    const update = (role) => {
        const bytes = json(values[role]),
            path = paths[role];
        files.set(path, bytes);
        records[role] = { path, bytes: bytes.length, sha256: hash(bytes) };
    };
    for (const role of Object.keys(values)) update(role);
    const reads = [];
    const read = async (path, maximum) => {
        reads.push(path);
        assert.ok(files.has(path));
        const bytes = files.get(path);
        assert.ok(bytes.length <= maximum);
        return Buffer.from(bytes);
    };
    const bind = (result) => {
        const item = base.receipt.cases.find((row) => row.id === id);
        item.lifecycleEvidence = { ...result.lifecycleEvidence };
        item.evidence = structuredClone(result.evidence);
        base.files.set(result.lifecycleEvidence.path, result.bytes);
        for (const [path, bytes] of files) base.files.set(path, bytes);
        return item;
    };
    return { base, expected, values, records, files, reads, read, update, bind };
}

test('four original install records and both original streams produce only an unqualified case', async () => {
    for (const lane of ['darwin-arm64', 'darwin-x64']) {
        const f = fixture(lane),
            result = await produceMacInstallLifecycle(f.expected, f.records, f.read);
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.caseId, id);
        assert.equal(f.reads.length, 6);
        assert.ok(f.reads.includes('evidence/child-1.stderr')); // Empty original is still read.
        const item = f.bind(result),
            envelope = JSON.parse(result.bytes);
        assert.equal(
            inspectInstallerCaseObservation(envelope, item, f.expected),
            'installed-payload-and-helper-consistent-unqualified',
        );
        assert.equal(envelope.runId, f.expected.runId);
        assert.equal(envelope.observation.installedPayload.qualification, false);
    }
});

test('the real shared consumer rereads all originals on every invocation and never promotes the case', async () => {
    const f = fixture(),
        result = await produceMacInstallLifecycle(f.expected, f.records, f.read);
    f.bind(result);
    for (let i = 0; i < 2; i++) {
        const reads = [];
        const outcome = await consumeInstallerLifecycleEvidence(
            f.base.receipt,
            f.expected,
            async (path, maximum) => {
                reads.push(path);
                const bytes = f.base.files.get(path);
                assert.ok(bytes && bytes.length <= maximum);
                return Buffer.from(bytes);
            },
        );
        assert.equal(reads.length, 15); // Nine case envelopes, four originals, two streams.
        assert.equal(outcome.status, 'installer-lifecycle-unqualified');
        assert.equal(outcome.releaseAcceptance, false);
        assert.equal(
            outcome.observations.find((row) => row.caseId === id).status,
            'installed-payload-and-helper-consistent-unqualified',
        );
    }
});

test('honestly rehashed operation payload command and current-producer contradictions are rejected', async () => {
    const changes = [
        [
            'helperChild',
            (v) => {
                v.operation.observerSource.commit = 'd'.repeat(40);
            },
        ],
        [
            'helperChild',
            (v) => {
                v.operation.package.sha256 = 'd'.repeat(64);
            },
        ],
        [
            'helperChild',
            (v) => {
                v.operation.operationId = v.operation.operationId.replace('helper:1', 'helper:2');
            },
        ],
        [
            'helperChild',
            (v) => {
                v.command.pop();
            },
        ],
        [
            'helperChild',
            (v) => {
                v.stdoutEOF = false;
            },
        ],
        [
            'helperChild',
            (v) => {
                v.closeObserved = false;
            },
        ],
        [
            'helperChild',
            (v) => {
                v.exitCode = 7;
            },
        ],
        [
            'actionCase',
            (v) => {
                v.actions[0].facts.root = '/synthetic/other/install';
                v.actions[0].facts.target =
                    '/synthetic/other/install/Applications/Diagnostic Hub.app';
            },
        ],
        [
            'actionCase',
            (v) => {
                v.actions[1].facts.exists = true;
                v.actions[1].facts.version = '0.5.2';
                v.actions[1].facts.asarSHA256 = 'd'.repeat(64);
            },
        ],
        [
            'actionCase',
            (v) => {
                v.actions[2].facts.command[1] = '/synthetic/other-helper';
            },
        ],
        [
            'actionCase',
            (v) => {
                v.actions.push(structuredClone(v.actions[3]));
            },
        ],
        [
            'actionCase',
            (v) => {
                v.actions[3].facts.asarSHA256 = 'd'.repeat(64);
            },
        ],
        [
            'installedPayload',
            (v) => {
                v.caseId = 'macos-bundle:repair';
            },
        ],
        [
            'installedPayload',
            (v) => {
                v.sourceTree = 'd'.repeat(40);
            },
        ],
        [
            'installedPayload',
            (v) => {
                v.archive.sha256 = 'd'.repeat(64);
            },
        ],
        [
            'installedPayload',
            (v) => {
                v.payloadIdentity.inventorySHA256 = 'd'.repeat(64);
            },
        ],
        [
            'installedPayload',
            (v) => {
                v.qualification = true;
            },
        ],
        [
            'shippingBuildInfo',
            (v) => {
                v.arch = 'x64';
            },
        ],
        [
            'shippingBuildInfo',
            (v) => {
                v.source = 'd'.repeat(40);
            },
        ],
        [
            'shippingBuildInfo',
            (v) => {
                v.packagedSourceMatches = false;
            },
        ],
        [
            'shippingBuildInfo',
            (v) => {
                v.distribution = false;
            },
        ],
    ];
    for (const [role, change] of changes) {
        const f = fixture();
        change(f.values[role]);
        f.update(role);
        await assert.rejects(produceMacInstallLifecycle(f.expected, f.records, f.read), role);
    }
});

test('post-production changes to any original record or stream are refused at consumer readback', async () => {
    for (const changed of [
        'evidence/install-only-case.json',
        'evidence/child-1.json',
        'install/evidence/installed-payload-1.json',
        'evidence/current-shipping-build-info.json',
        'evidence/child-1.stdout',
        'evidence/child-1.stderr',
    ]) {
        const f = fixture(),
            result = await produceMacInstallLifecycle(f.expected, f.records, f.read);
        f.bind(result);
        f.base.files.set(changed, Buffer.from('changed after production\n'));
        await assert.rejects(
            consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
            changed,
        );
    }
});

test('matching labels cannot replace or relocate exact records and canonical complete bytes', async () => {
    for (const defect of [
        'missing',
        'outside-child',
        'wrong-child',
        'trailing',
        'duplicate',
        'partial',
    ]) {
        const f = fixture();
        if (defect === 'missing') delete f.records.installedPayload;
        if (defect === 'outside-child') f.records.helperChild.path = '../child-1.json';
        if (defect === 'wrong-child') f.records.helperChild.path = 'evidence/child-2.json';
        if (['trailing', 'duplicate', 'partial'].includes(defect)) {
            const ref = f.records.actionCase;
            const bytes =
                defect === 'trailing'
                    ? Buffer.concat([f.files.get(ref.path), Buffer.from(' ')])
                    : defect === 'duplicate'
                      ? Buffer.from('{"id":"macos-bundle:install","id":"macos-bundle:install"}\n')
                      : Buffer.from('{');
            f.files.set(ref.path, bytes);
            Object.assign(ref, { bytes: bytes.length, sha256: hash(bytes) });
        }
        await assert.rejects(produceMacInstallLifecycle(f.expected, f.records, f.read), defect);
    }
});

test('selected package and run labels are validated without becoming a native-origin issuer', async () => {
    for (const mutate of [
        (v) => {
            v.runId = '0';
        },
        (v) => {
            v.runAttempt = 1;
        },
        (v) => {
            v.sourceTree = 'd'.repeat(40);
        },
        (v) => {
            v.lane = 'win32-x64';
        },
        (v) => {
            v.artifacts = [];
        },
    ]) {
        const f = fixture();
        mutate(f.expected);
        await assert.rejects(produceMacInstallLifecycle(f.expected, f.records, f.read));
    }
});
