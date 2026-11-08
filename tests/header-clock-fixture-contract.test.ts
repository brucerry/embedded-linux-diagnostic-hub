import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { automationRequest } from '../shared/automation';
import { CAPTURE_STORAGE } from '../shared/capture-store';
import { streamCapabilities, streamRequest } from '../shared/ssh-stream-rpc';
import { parseDeviceClock, validateDeviceClock } from '../shared/diagnostics/device-clock';
import { clockOutput } from './fixtures/device-clock';

// Read only these fixed fixture/producer sources. Never import Playwright or mount the app.
const spec = readFileSync('tests/ui/header-clock-ownership.spec.ts', 'utf8');
const fixture = readFileSync('tests/ui/fixtures/ssh-stream.ts', 'utf8');
const runner = readFileSync('src/features/automation/runner.ts', 'utf8');
const connection = spec.match(/connection: '([^']+)'/)?.[1];
assert.ok(connection);
const token = (name: string) => {
    const match = fixture.match(new RegExp(name + " = '([a-f0-9])'\\.repeat\\((\\d+)\\)"));
    assert.ok(match, 'Pinned synthetic ' + name + ' declaration');
    return match[1].repeat(Number(match[2]));
};
const epoch = token('epoch'),
    capability = token('capability');
// The renderer supplies real request IDs; this deterministic representative has its exact shape.
assert.ok(runner.includes("crypto.randomUUID().replaceAll('-', '')"));
const id = '00000000000040008000000000000001';
assert.ok(spec.includes(".fill('header ownership fixture')"));
assert.ok(spec.includes("getByLabel('Command timeout', { exact: true }).fill('300')"));
const request = { id, connection, command: 'header ownership fixture', timeoutMs: 300_000 };

test('historical short owner is rejected by actual start and read validators', () => {
    assert.equal('header-owner'.length, 12);
    assert.throws(
        () => automationRequest({ ...request, connection: 'header-owner' }),
        /connection is invalid/,
    );
    assert.throws(
        () =>
            streamRequest({
                protocol: 1,
                action: 'start',
                epoch,
                request: { ...request, connection: 'header-owner' },
            }),
        /connection is invalid/,
    );
    assert.throws(
        () =>
            streamRequest({
                protocol: 1,
                action: 'read',
                id,
                connection: 'header-owner',
                capability,
            }),
        /Invalid SSH stream owner/,
    );
});

test('both header cases share valid fixture connection epoch capability and renderer-shaped request identity', () => {
    assert.equal(connection.length, 20);
    assert.equal(epoch.length, 32);
    assert.equal(capability.length, 64);
    assert.deepEqual(automationRequest(request), request);
    assert.equal(
        streamCapabilities(
            {
                protocol: 1,
                independentStream: 1,
                receiveTimeSource: 'local-client',
                frameBytes: CAPTURE_STORAGE.frameBytes,
                backlogBytes: CAPTURE_STORAGE.backlogBytes,
                epoch,
            },
            'local-client',
        ),
        epoch,
    );
    assert.deepEqual(streamRequest({ protocol: 1, action: 'start', epoch, request }), {
        protocol: 1,
        action: 'start',
        epoch,
        request,
    });
    for (const action of ['read', 'cancel', 'finalize', 'ack'] as const) {
        const input: Record<string, unknown> = {
            protocol: 1,
            action,
            id,
            connection,
            capability,
            ...(action === 'ack' ? { sequence: 0 } : {}),
        };
        assert.deepEqual(streamRequest(input), input);
    }
    // Both tests must still reach the same helper and retain the original freshness assertions.
    assert.equal((spec.match(/const flow = await activeFlow\(page\);/g) ?? []).length, 2);
    assert.ok(spec.includes('window.headerOwnershipTest.readPending)).toBe(true)'));
});

test('initial and resumed synthetic clock responses pass the actual clock validator', () => {
    const args = spec.match(/clockOutput\('([^']+)', '([^']+)', '([^']+)', '([^']+)'\)/);
    assert.ok(args);
    const initial = validateDeviceClock({
        status: 'available',
        sample: parseDeviceClock(clockOutput()),
    });
    const fresh = validateDeviceClock({
        status: 'available',
        sample: parseDeviceClock(clockOutput(args[1], args[2], args[3], args[4])),
    });
    assert.equal(initial.status, 'available');
    assert.equal(fresh.status, 'available');
    if (initial.status !== 'available' || fresh.status !== 'available')
        assert.fail('Missing sample');
    assert.equal(initial.sample.time.slice(0, 5), '16:35');
    assert.equal(fresh.sample.time.slice(0, 5), '17:36');
});
