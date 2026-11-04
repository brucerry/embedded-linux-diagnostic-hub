import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySoak } from './fixtures/memory-resource-verifier';

function beforeImport(pattern?: RegExp) {
    return (error: unknown) => {
        assert.ok(error instanceof Error);
        const observed = error as Error & {
            driverImports: number;
            childEvidenceRetained: boolean;
            virtualIPCClosed: boolean;
        };
        assert.equal(observed.driverImports, 0, 'Preflight failure admitted an adapter import.');
        assert.equal(observed.childEvidenceRetained, false);
        assert.equal(observed.virtualIPCClosed, false);
        if (pattern) assert.match(observed.message, pattern);
        return true;
    };
}

test('virtual child independently verifies retained raw Git/source bridge before work and durable handoff', async () => {
    const result = await verifySoak({ policy: true });
    assert.equal(result.driverImports, 1);
    assert.equal(result.childEvidenceRetained, true);
    assert.equal(result.virtualIPCClosed, true);
    assert.equal(result.realProcessesQueried, 0);
    assert.equal(result.realCycles, 0);
});

for (const failure of ['missing', 'malformed', 'foreign', 'read'] as const)
    test(
        'virtual child source bridge ' + failure + ' fails with zero adapter imports',
        async () => {
            await assert.rejects(verifySoak({ sourceBridgeFailure: failure }), beforeImport());
        },
    );

for (const failure of ['missing', 'duplicate', 'foreign'] as const)
    test('virtual child source pin ' + failure + ' fails with zero adapter imports', async () => {
        await assert.rejects(verifySoak({ sourcePinFailure: failure }), beforeImport());
    });

test('source preflight time cannot admit late adapter import', async () => {
    await assert.rejects(
        verifySoak({ sourceBridgeDelayMs: 2340000 }),
        beforeImport(/work budget|work deadline|work admission/i),
    );
});

test('source changed after virtual work holds IPC and refuses child handoff', async () => {
    const result = await verifySoak({ policy: true, sourceMutationAfterReceipt: true });
    assert.equal(result.driverImports, 1);
    assert.equal(result.childEvidenceRetained, false);
    assert.equal(result.virtualIPCClosed, false);
    assert.equal(result.evidenceSynced, true);
    assert.equal(result.evidenceClosed, true);
    assert.equal(result.realProcessesQueried, 0);
});

test('a separately pinned legacy fingerprint cannot disagree with the retained source bridge before import', async () => {
    await assert.rejects(
        verifySoak({ mismatchedSourceFingerprint: true }),
        beforeImport(/source differs from frozen inventory/),
    );
});
