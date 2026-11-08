import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    produceMacOfflineLifecycle,
    MAC_OFFLINE_RECORD_LIMITS,
} from '../scripts/lib/macos-offline-lifecycle.mjs';
import {
    consumeInstallerLifecycleEvidence,
    inspectInstallerCaseObservation,
} from '../scripts/lib/installer-lifecycle-evidence.mjs';
import { macPayloadIdentity } from '../scripts/lib/macos-payload-identity.mjs';
import { installerMemoryFixture } from './fixtures/installer-lifecycle-memory.mjs';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const id = 'macos-bundle:offline-launch';
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function fixture() {
    const base = installerMemoryFixture(),
        expected = base.expected;
    const before = structuredClone(base.values.get(id).observation.prequit);
    const closed = structuredClone(base.values.get(id).observation.closed);
    before.ownerId = '1'.repeat(32) + ':macos-bundle:offline-launch:1:42';
    closed.ownerId = before.ownerId;
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
    const archive = expected.artifacts.find((row: any) => row.name.endsWith('.zip'))!;
    const values: Record<string, any> = {
        prequit: before,
        closed,
        installedPayload: {
            schemaVersion: 1,
            kind: 'macos-installed-payload-sample',
            caseId: id,
            version: expected.version,
            sourceCommit: expected.sourceCommit,
            sourceTree: expected.sourceTree,
            archive: structuredClone(archive),
            payloadIdentity: structuredClone(payload),
            qualification: false,
        },
        shippingBuildInfo: {
            platform: 'darwin',
            arch: 'arm64',
            version: expected.version,
            commit: expected.sourceCommit,
            asset: archive.name,
            sha256: archive.sha256,
            asarSHA256: payload.asarSHA256,
            payloadIdentity: structuredClone(payload),
            bundleIdentifier: 'dev.diagnostichub.desktop',
            minimumMacOSVersion: '13.0.0',
            signature: 'ad-hoc',
            adHocIntegrityVerified: true,
            notarized: false,
            gatekeeperDownloadedAppQualified: false,
        },
    };
    const files = new Map<string, Buffer>(),
        records: Record<string, any> = {};
    const update = (role: string, value = values[role]) => {
        values[role] = value;
        const bytes = json(value),
            file = 'offline-launch/evidence/' + role + '.json';
        files.set(file, bytes);
        records[role] = { path: file, bytes: bytes.length, sha256: hash(bytes) };
    };
    for (const role of Object.keys(values)) update(role);
    let reads = 0;
    const read = async (file: string, max: number) => {
        reads++;
        assert.ok(files.get(file)!.length <= max);
        return Buffer.from(files.get(file)!);
    };
    const bind = (result: any) => {
        const item = base.receipt.cases.find((row: any) => row.id === id)!;
        item.lifecycleEvidence = { ...result.lifecycleEvidence };
        item.evidence = structuredClone(result.evidence);
        base.files.set(result.lifecycleEvidence.path, result.bytes);
        for (const [path, bytes] of files) base.files.set(path, bytes);
        return item;
    };
    return { base, expected, values, files, records, read, update, bind, reads: () => reads };
}
test('existing payload and closure records produce a case and are independently reread without promotion', async () => {
    const f = fixture();
    const legacy = await consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read);
    assert.equal(
        legacy.observations.find((row: any) => row.caseId === id)?.status,
        'direct-child-and-pipes-consistent-unqualified',
    );
    const result = await produceMacOfflineLifecycle(f.expected, f.records, f.read);
    const item = f.bind(result),
        value = JSON.parse(result.bytes.toString());
    assert.equal(
        inspectInstallerCaseObservation(value, item, f.expected),
        'shipping-payload-and-direct-child-consistent-unqualified',
    );
    assert.equal(result.releaseAcceptance, false);
    let reads = 0;
    const outcome = await consumeInstallerLifecycleEvidence(
        f.base.receipt,
        f.expected,
        async (file: string) => {
            reads++;
            return f.base.files.get(file)!;
        },
    );
    assert.equal(reads, 13); // Nine case envelopes and four source records.
    assert.equal(outcome.releaseAcceptance, false);
    assert.equal(outcome.status, 'installer-lifecycle-unqualified');
    assert.equal(f.reads(), 4);
});
for (const [label, role, change] of [
    [
        'wrong source',
        'installedPayload',
        (v: any) => {
            v.sourceCommit = 'd'.repeat(40);
        },
    ],
    [
        'wrong tree',
        'installedPayload',
        (v: any) => {
            v.sourceTree = 'd'.repeat(40);
        },
    ],
    [
        'wrong case',
        'installedPayload',
        (v: any) => {
            v.caseId = 'macos-bundle:repair';
        },
    ],
    [
        'wrong archive',
        'installedPayload',
        (v: any) => {
            v.archive.sha256 = 'd'.repeat(64);
        },
    ],
    [
        'wrong executable',
        'installedPayload',
        (v: any) => {
            v.payloadIdentity.executableSHA256 = 'd'.repeat(64);
        },
    ],
    [
        'wrong ASAR',
        'installedPayload',
        (v: any) => {
            v.payloadIdentity.asarSHA256 = 'd'.repeat(64);
        },
    ],
    [
        'wrong inventory',
        'installedPayload',
        (v: any) => {
            v.payloadIdentity.inventorySHA256 = 'd'.repeat(64);
        },
    ],
    [
        'qualified sample',
        'installedPayload',
        (v: any) => {
            v.qualification = true;
        },
    ],
    [
        'wrong arch',
        'shippingBuildInfo',
        (v: any) => {
            v.arch = 'x64';
        },
    ],
    [
        'missing shipping identity',
        'shippingBuildInfo',
        (v: any) => {
            delete v.payloadIdentity;
        },
    ],
    [
        'foreign owner',
        'prequit',
        (v: any) => {
            v.ownerId = 'foreign';
        },
    ],
    [
        'reused PID',
        'prequit',
        (v: any) => {
            v.ownerId = '1'.repeat(32) + ':macos-bundle:offline-launch:1:43';
        },
    ],
    [
        'missing closure',
        'closed',
        (v: any) => {
            v.closure.closeObserved = false;
        },
    ],
    [
        'missing pipe EOF',
        'closed',
        (v: any) => {
            v.closure.streams.stdoutEOF = false;
        },
    ],
    [
        'forced exit',
        'closed',
        (v: any) => {
            v.closure.signal = 'SIGKILL';
        },
    ],
    [
        'pending ownership',
        'closed',
        (v: any) => {
            v.closure.mainPendingCount = 1;
        },
    ],
    [
        'invented retirement',
        'closed',
        (v: any) => {
            v.closure.physicalDescendantClosure = true;
        },
    ],
] as const)
    test('honestly rehashed actual-record projection rejects ' + label, async () => {
        const f = fixture();
        change(f.values[role]);
        f.update(role);
        await assert.rejects(produceMacOfflineLifecycle(f.expected, f.records, f.read));
    });
for (const role of ['prequit', 'closed', 'installedPayload', 'shippingBuildInfo'])
    test('final readback checks raw bytes for ' + role, async () => {
        const f = fixture(),
            result = await produceMacOfflineLifecycle(f.expected, f.records, f.read);
        f.bind(result);
        f.base.files.set(f.records[role].path, Buffer.from('changed'));
        await assert.rejects(
            consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        );
    });
test('honestly rehashed raw record cannot differ from its embedded projection', async () => {
    const f = fixture(),
        result = await produceMacOfflineLifecycle(f.expected, f.records, f.read);
    const value = JSON.parse(result.bytes.toString());
    f.values.closed.closure.mainPendingCount = 99;
    f.update('closed');
    value.observation.records.closed = f.records.closed;
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    result.bytes = bytes;
    result.lifecycleEvidence.bytes = bytes.length;
    result.lifecycleEvidence.sha256 = hash(bytes);
    result.evidence[0] = { ...result.lifecycleEvidence };
    result.evidence[result.evidence.findIndex((ref: any) => ref.path === f.records.closed.path)] = {
        ...f.records.closed,
    };
    f.bind(result);
    await assert.rejects(
        consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        /projection differs/,
    );
});
for (const mode of [
    'missing',
    'escape',
    'reuse',
    'oversize',
    'wrong hash',
    'invalid UTF8',
    'duplicate key',
])
    test('source-record intake rejects ' + mode, async () => {
        const f = fixture(),
            ref = f.records.prequit;
        if (mode === 'missing') delete f.records.closed;
        if (mode === 'escape') ref.path = '../outside';
        if (mode === 'reuse') f.records.closed = { ...ref };
        if (mode === 'oversize') ref.bytes = MAC_OFFLINE_RECORD_LIMITS.prequit + 1;
        if (mode === 'wrong hash') ref.sha256 = 'd'.repeat(64);
        if (mode === 'invalid UTF8' || mode === 'duplicate key') {
            const bytes =
                mode === 'invalid UTF8'
                    ? Buffer.from([0xff])
                    : Buffer.from('{"ownerId":1,"ownerId":2}');
            f.files.set(ref.path, bytes);
            ref.bytes = bytes.length;
            ref.sha256 = hash(bytes);
        }
        await assert.rejects(produceMacOfflineLifecycle(f.expected, f.records, f.read));
    });
test('invalid run or package context refuses before source reads', async () => {
    for (const mode of ['runId', 'runAttempt', 'lane', 'package']) {
        const f = fixture();
        if (mode === 'package') f.expected.artifacts = [];
        else (f.expected as any)[mode] = '';
        await assert.rejects(produceMacOfflineLifecycle(f.expected, f.records, f.read));
        assert.equal(f.reads(), 0);
    }
});
test('producer freezes caller context and references before an awaited read', async () => {
    const f = fixture();
    const result = await produceMacOfflineLifecycle(
        f.expected,
        f.records,
        async (file: string, max: number) => {
            f.expected.runId = '999';
            f.records.closed.sha256 = 'd'.repeat(64);
            return f.read(file, max);
        },
    );
    assert.equal(JSON.parse(result.bytes.toString()).runId, '123');
});
test('reader refuses missing source reference and stale run instead of trusting embedded data', async () => {
    for (const mode of ['reference', 'run']) {
        const f = fixture(),
            result = await produceMacOfflineLifecycle(f.expected, f.records, f.read);
        const item = f.bind(result);
        if (mode === 'reference') item.evidence.pop();
        else f.expected.runId = '999';
        await assert.rejects(
            consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        );
    }
});
