import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseDirectRequest } from '../shared/testing/direct';
import { sampleProfile, simulatedInventory, createSimulation } from '../shared/testing/simulation';
import { activeRun } from '../shared/testing/types';
import { profileFieldErrors } from '../src/features/testing/validation';

test('direct JSON accepts profiles and explicit selections while recording fixture readiness', async () => {
    const profile = sampleProfile();
    const plain = parseDirectRequest(JSON.stringify(profile));
    assert.equal(plain.sequence, 'bench');
    assert.deepEqual(plain.testIds, profile.sequences[0].tests);
    assert.equal(plain.readiness.reviewed, true);
    assert.equal(plain.readiness.fixtures['test-led-1'].ready, true);
    const request = parseDirectRequest(
        await readFile('docs/examples/simulation-run-request.json', 'utf8'),
    );
    assert.deepEqual(request.testIds, ['test-uart-2', 'test-i2c-3']);
    assert.equal(request.sequence, '');
    assert.equal(request.readiness.fixtures['test-uart-2'].identity, 'Simulated loopback fixture');
    assert.deepEqual(
        parseDirectRequest(JSON.stringify({ ...profile, sequences: [] })).testIds,
        plain.testIds,
    );
    const target = createSimulation({ delayMs: 1 });
    const inventory = await target.discoverTests();
    await target.startTests({ ...request, inventoryId: inventory.id });
    while (activeRun(await target.readTestRun())) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await target.readTestRun())?.verdict, 'Pass');
});

test('direct JSON rejects unsafe, incomplete, ambiguous and fabricated inputs before transport', () => {
    const profile = sampleProfile();
    const bad = [
        '{',
        ' '.repeat(164000),
        JSON.stringify({ profile, sequence: 'bench', testIds: ['test-uart-2'] }),
        JSON.stringify({ profile, sequence: 'missing' }),
        JSON.stringify({ profile, testIds: [] }),
        JSON.stringify({ profile, testIds: ['missing'] }),
        JSON.stringify({ profile, command: 'reboot' }),
        JSON.stringify({ profile, observations: { 'test-led-1': 'yes' } }),
        JSON.stringify({ profile, fixtures: { unknown: { ready: true, identity: '' } } }),
    ];
    for (const source of bad) assert.throws(() => parseDirectRequest(source));
    for (const property of ['fixture', 'expected'] as const) {
        const value = structuredClone(profile);
        value.tests[0][property] = '';
        assert.throws(() => parseDirectRequest(JSON.stringify(value)), /complete/);
    }
    for (const level of [null, -1, 65536]) {
        const value = structuredClone(profile);
        value.tests[0].parameters.level = level;
        assert.throws(() => parseDirectRequest(JSON.stringify(value)));
    }
    const missing = structuredClone(profile);
    missing.resources[0].selector = {};
    assert.throws(() => parseDirectRequest(JSON.stringify(missing)), /selector/);
});

test('unready fixtures remain blocked in direct runs and field validation identifies correctable inputs', async () => {
    const profile = sampleProfile();
    const request = parseDirectRequest(
        JSON.stringify({
            profile,
            testIds: ['test-uart-2'],
            fixtures: {
                'test-uart-2': { ready: false, identity: 'Missing fixture' },
            },
        }),
    );
    const target = createSimulation({ delayMs: 1 });
    const inventory = await target.discoverTests();
    await target.startTests({ ...request, inventoryId: inventory.id });
    while (activeRun(await target.readTestRun())) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await target.readTestRun())?.verdict, 'Blocked');
    assert.deepEqual(profileFieldErrors(profile, simulatedInventory()), {});
    profile.name = '';
    profile.tests[0].fixture = '';
    profile.tests[0].parameters.cycles = 21;
    profile.tests[0].parameters.level = 256;
    profile.resources[1].selector = {};
    const errors = profileFieldErrors(profile, simulatedInventory());
    for (const key of [
        'name',
        'tests.0.fixture',
        'tests.0.parameters.cycles',
        'tests.0.parameters.level',
        'tests.1.mapping',
    ])
        assert.ok(errors[key], key);
    profile.name = 'Fixed';
    profile.tests[0].parameters.cycles = 3;
    assert.equal(
        profileFieldErrors(profile, simulatedInventory())['tests.0.parameters.cycles'],
        undefined,
    );
});
