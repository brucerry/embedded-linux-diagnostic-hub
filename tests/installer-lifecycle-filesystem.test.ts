import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyInstallerEvidence } from '../scripts/lib/staged-artifact-gate.mjs';
import { inspectInstallerCaseObservation } from '../scripts/lib/installer-lifecycle-evidence.mjs';
import { installerMemoryFixture } from './fixtures/installer-lifecycle-memory.mjs';

const offline = 'macos-bundle:offline-launch';
test('native consumer never promotes a known unqualified closure projection', async () => {
    const f = installerMemoryFixture(),
        item = f.receipt.cases.find((item) => item.id === offline)!;
    assert.equal(
        inspectInstallerCaseObservation(f.values.get(offline), item, f.expected),
        'direct-child-and-pipes-consistent-unqualified',
    );
    const parent = await realpath(os.tmpdir()),
        root = await mkdtemp(path.join(parent, 'hub-installer-consumer-'));
    try {
        for (const [file, bytes] of f.files) {
            await mkdir(path.dirname(path.join(root, file)), { recursive: true });
            await writeFile(path.join(root, file), bytes, { flag: 'wx' });
        }
        await assert.rejects(
            verifyInstallerEvidence(root, f.receipt, f.expected),
            /Installer lifecycle evidence blocked/,
        );
        f.change(offline, (v: any) => {
            v.observation.closed.closure.closeObserved = false;
        });
        const ref = item.lifecycleEvidence;
        await writeFile(path.join(root, ref.path), f.files.get(ref.path)!);
        await assert.rejects(
            verifyInstallerEvidence(root, f.receipt, f.expected),
            /process closure/,
        );
    } finally {
        assert.equal(path.dirname(root), parent);
        assert.ok(path.basename(root).startsWith('hub-installer-consumer-'));
        await rm(root, { recursive: true });
    }
});
