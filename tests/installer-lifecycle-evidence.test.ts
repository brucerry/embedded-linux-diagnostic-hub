import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateInstallerReceipt } from '../scripts/lib/staged-artifact-gate.mjs';
import { consumeInstallerLifecycleEvidence } from '../scripts/lib/installer-lifecycle-evidence.mjs';
import { installerMemoryFixture } from './fixtures/installer-lifecycle-memory.mjs';

const offline = 'macos-bundle:offline-launch';
test('case-bound existing Mac closure facts are consistency only and every lane remains unqualified', async () => {
    for (const lane of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
        const f = installerMemoryFixture(lane);
        validateInstallerReceipt(f.receipt, f.expected);
        const result = await consumeInstallerLifecycleEvidence(f.receipt, f.expected, f.read);
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.status, 'installer-lifecycle-unqualified');
        assert.equal(result.observations.length, f.receipt.cases.length);
        assert.ok(result.observations.some((item) => item.status === 'unsupported-native-case'));
    }
});
for (const [field, value] of [
    ['runId', '122'],
    ['runAttempt', '1'],
    ['runId', undefined],
    ['runAttempt', undefined],
    ['runId', 123],
    ['runAttempt', '0'],
    ['runId', '1'.repeat(33)],
] as const)
    test('installer summary refuses stale or invalid ' + field + ':' + value, () => {
        const f = installerMemoryFixture();
        (f.receipt as any)[field] = value;
        assert.throws(() => validateInstallerReceipt(f.receipt, f.expected));
    });
for (const [label, update] of [
    [
        'stale run',
        (v: any) => {
            v.runId = '122';
        },
    ],
    [
        'stale attempt',
        (v: any) => {
            v.runAttempt = '1';
        },
    ],
    [
        'wrong lane',
        (v: any) => {
            v.lane = 'darwin-x64';
        },
    ],
    [
        'wrong package',
        (v: any) => {
            v.package.sha256 = 'd'.repeat(64);
        },
    ],
    [
        'wrong case',
        (v: any) => {
            v.caseId = 'macos-bundle:install';
        },
    ],
    [
        'diagnostic schema',
        (v: any) => {
            v.kind = 'macos-installer-helper-fixture';
        },
    ],
    [
        'missing process close',
        (v: any) => {
            v.observation.closed.closure.closeObserved = false;
        },
    ],
    [
        'missing exit',
        (v: any) => {
            v.observation.closed.closure.exitObserved = false;
        },
    ],
    [
        'missing stdout EOF',
        (v: any) => {
            v.observation.closed.closure.streams.stdoutEOF = false;
        },
    ],
    [
        'missing stderr EOF',
        (v: any) => {
            v.observation.closed.closure.streams.stderrEOF = false;
        },
    ],
    [
        'wrong owner',
        (v: any) => {
            v.observation.closed.ownerId = 'replacement';
        },
    ],
    [
        'replacement PID',
        (v: any) => {
            v.observation.closed.closure.pid++;
        },
    ],
    [
        'failed exit',
        (v: any) => {
            v.observation.closed.closure.exitCode = 1;
        },
    ],
    [
        'forced signal',
        (v: any) => {
            v.observation.closed.closure.signal = 'SIGKILL';
        },
    ],
    [
        'pending custody',
        (v: any) => {
            v.observation.closed.closure.mainPendingCount = 1;
        },
    ],
    [
        'offline unproved',
        (v: any) => {
            v.observation.prequit.identity.offline = false;
        },
    ],
    [
        'relabelled descendant proof',
        (v: any) => {
            v.observation.closed.closure.physicalDescendantClosure = true;
        },
    ],
] as const)
    test('honestly rehashed lifecycle evidence refuses ' + label, async () => {
        const f = installerMemoryFixture();
        f.change(offline, update);
        await assert.rejects(consumeInstallerLifecycleEvidence(f.receipt, f.expected, f.read));
    });
test('a single log or semantic observation cannot be assigned to two installer cases', () => {
    for (const role of ['path', 'sha256', 'lifecycleEvidence']) {
        const f = installerMemoryFixture(),
            a = f.receipt.cases[0],
            b = f.receipt.cases[1];
        if (role === 'lifecycleEvidence') b.lifecycleEvidence = { ...a.lifecycleEvidence };
        else (b.evidence[0] as any)[role] = (a.evidence[0] as any)[role];
        assert.throws(() => validateInstallerReceipt(f.receipt, f.expected));
    }
});
test('expected run and package binding is snapshotted before asynchronous readback', async () => {
    const f = installerMemoryFixture();
    const first = f.expected.runId;
    await assert.rejects(
        consumeInstallerLifecycleEvidence(f.receipt, f.expected, async (file: string) => {
            f.expected.runId = '999';
            f.receipt.runId = '999';
            const bytes = await f.read(file);
            if (file.includes('offline-launch')) return Buffer.from('changed');
            return bytes;
        }),
        /changed after verification/,
    );
    assert.equal(first, '123');
});
test('both initial ingestion and final readback invoke the semantic installer gate', async () => {
    const code = await readFile('scripts/staged-artifact-gate.mjs', 'utf8');
    assert.equal((code.match(/await verifyInstallerEvidence\(/g) ?? []).length, 2);
    assert.match(code, /await verifyInstallerEvidence\(\s*path.dirname\(input\),\s*installer,/);
    assert.match(code, /await verifyInstallerEvidence\(\s*installerRoot,\s*receipt.installer,/);
    assert.match(code, /readBoundedReceiptBytes\(\s*path.join\(installerRoot,\s*'receipt.json'\)/);
});
