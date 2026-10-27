import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductProgram } from './memory-product-gateway-target';
import { validHostRequest } from './memory-resource-gateway-host';

test('private target byte programs are bounded and copy their configuration', () => {
    const value = {
        command: 'fixture',
        stdoutBytes: 64 * 1024 ** 2,
        stderrBytes: 16384,
        delayMs: 1,
    };
    const parsed = validateProductProgram(value);
    assert.deepEqual(parsed, value);
    assert.notEqual(parsed, value);
    for (const bad of [
        { ...value, stdoutBytes: Infinity },
        { ...value, stdoutBytes: -1 },
        { ...value, stderrBytes: NaN },
        { ...value, chunkBytes: 0 },
        { ...value, chunkBytes: 16385 },
        { ...value, delayMs: 1001 },
        { ...value, exitCode: 256 },
        { ...value, stall: 'yes' },
        { ...value, command: 'x'.repeat(8193) },
    ])
        assert.throws(() => validateProductProgram(bad));
});
test('private controls are rejected by the unchanged default host protocol', () => {
    const request = {
        version: 1,
        nonce: 'fixture',
        id: 1,
        action: 'control',
        payload: { action: 'snapshot' },
    };
    assert.equal(validHostRequest(request, 'fixture'), false);
    assert.equal(validHostRequest(request, 'fixture', true), true);
    assert.equal(validHostRequest({ ...request, nonce: 'wrong' }, 'fixture', true), false);
    assert.equal(
        validHostRequest({ ...request, payload: 'x'.repeat(16400) }, 'fixture', true),
        false,
    );
});
