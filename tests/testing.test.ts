import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProfile, preparePlan, validateProfile } from '../shared/testing/profile';
import { dtCells, dtReferences, dtStrings, validateInventory } from '../shared/testing/inventory';
import { createSimulation, sampleProfile, simulatedInventory } from '../shared/testing/simulation';
import { activeRun, type StartTests, type TestingTransport } from '../shared/testing/types';
import { digest } from '../shared/testing/validation';
import { readFile } from 'node:fs/promises';

test('strict profiles reject commands, credentials, unsafe values, duplicate IDs and references', () => {
    const profile = sampleProfile();
    assert.equal(validateProfile(profile).tests.length, 3);
    for (const field of ['command', 'password', 'privateKey', '__proto__']) {
        const bad = JSON.parse(JSON.stringify(profile));
        Object.defineProperty(bad, field, { value: 'bad', enumerable: true });
        assert.throws(() => validateProfile(bad), /unsupported field/);
    }
    assert.throws(() => validateProfile({ ...profile, schemaVersion: 2 }), /schema/);
    assert.throws(
        () => validateProfile({ ...profile, tests: [profile.tests[0], profile.tests[0]] }),
        /duplicate/,
    );
    assert.throws(
        () =>
            validateProfile({ ...profile, tests: [{ ...profile.tests[0], resource: 'missing' }] }),
        /reference/,
    );
    assert.throws(
        () =>
            validateProfile({
                ...profile,
                tests: [
                    { ...profile.tests[2], parameters: { register: -1, expected: 68, mask: 255 } },
                ],
            }),
        /integer/,
    );
    assert.throws(() => validateProfile({ ...profile, name: 'a'.repeat(131072) }), /size limit/);
});
test('delivered example validates and matches the disconnected demonstration', async () => {
    const example = validateProfile(
        JSON.parse(await readFile('docs/examples/simulation-board-profile.json', 'utf8')),
    );
    assert.deepEqual(example, sampleProfile());
    assert.ok(
        (await preparePlan(example, simulatedInventory())).cases.every((c) => !c.problems.length),
    );
});
test('profile digests ignore object-key order and change when acceptance changes', async () => {
    const p = sampleProfile();
    assert.equal(await digest(p), await digest(Object.fromEntries(Object.entries(p).reverse())));
    const changed = structuredClone(p);
    changed.tests[2].parameters.expected = 69;
    assert.notEqual(await digest(p), await digest(changed));
});
test('resolver handles I2C renumbering, ambiguity, console protection and wrong boards', async () => {
    const inventory = simulatedInventory(),
        profile = sampleProfile();
    inventory.resources[2].path = '/sys/bus/i2c/devices/27-0048';
    inventory.resources[2].metadata.bus = '27';
    let plan = await preparePlan(profile, inventory);
    assert.equal(plan.cases[2].resource?.metadata.bus, '27');
    assert.equal(plan.cases[2].problems.length, 0);
    inventory.resources.push({ ...inventory.resources[1], id: 'duplicate', path: '/dev/ttyS2' });
    plan = await preparePlan(profile, inventory);
    assert.match(plan.cases[1].problems.join(), /ambiguous/);
    inventory.resources.pop();
    inventory.resources[1].console = true;
    assert.match((await preparePlan(profile, inventory)).cases[1].problems.join(), /console/);
    inventory.device.model = 'Other board';
    assert.match((await preparePlan(profile, inventory)).cases[0].problems.join(), /model/);
    inventory.device.model = 'Simulated engineering board';
    inventory.nodes.push({
        path: inventory.resources[2].ofNode,
        properties: { status: '64697361626c656400' },
    });
    assert.match((await preparePlan(profile, inventory)).cases[2].problems.join(), /disabled/);
});
test('DT binary values and provider references use big endian cells and provider cell counts', () => {
    assert.deepEqual(dtCells('0000000100000012'), [1, 18]);
    assert.deepEqual(dtStrings('61636d652c626f61726400'), ['acme,board']);
    const inv = simulatedInventory();
    inv.nodes.push({
        path: '/gpio@1000',
        properties: { phandle: '00000001', '#gpio-cells': '00000002' },
    });
    assert.deepEqual(dtReferences(inv, 'gpio', '000000010000001200000001'), [
        { provider: '/gpio@1000', cells: [18, 1] },
    ]);
    assert.throws(() => dtReferences(inv, 'gpio', '0000000200000012'), /Unknown/);
    assert.throws(() => dtCells('0001'), /cell array/);
});
test('drafts retain provenance and cannot guess approved I2C registers or fixtures', async () => {
    const inv = simulatedInventory(),
        profile = draftProfile(inv);
    assert.equal(profile.tests[2].parameters.register, null);
    assert.match((await preparePlan(profile, inv)).cases[2].problems.join(), /Complete/);
    inv.complete = false;
    inv.issues = ['Permission denied'];
    assert.match((await preparePlan(sampleProfile(), inv)).cases[0].problems.join(), /incomplete/);
    assert.throws(
        () =>
            validateInventory({
                ...inv,
                resources: [{ ...inv.resources[0], path: '/etc/passwd' }],
            }),
        /LED/,
    );
});
async function request(transport: TestingTransport): Promise<StartTests> {
    const inventory = await transport.discoverTests(),
        profile = sampleProfile();
    return {
        profile,
        inventoryId: inventory.id,
        testIds: profile.tests.map((t) => t.id),
        sequence: 'bench',
        readiness: {
            reviewed: true,
            fixtures: Object.fromEntries(
                profile.tests.map((t) => [t.id, { ready: true, identity: 'Fixture A' }]),
            ),
        },
    };
}
async function waitRun(transport: TestingTransport) {
    for (let i = 0; i < 200; i++) {
        const run = await transport.readTestRun();
        if (!activeRun(run)) return run!;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw Error('Run did not finish.');
}
test('simulation requires LED feedback and records measurements without device access', async () => {
    const transport = createSimulation({ delayMs: 1 });
    const run = await transport.startTests(await request(transport));
    const done = await waitRun(transport);
    assert.equal(done.phase, 'review');
    assert.equal(done.verdict, 'Inconclusive');
    assert.deepEqual(
        done.cases.map((c) => c.verdict),
        ['Inconclusive', 'Pass', 'Pass'],
    );
    const reviewed = await transport.confirmTest({
        runId: run.id,
        testId: done.cases[0].test.id,
        value: 'yes',
    });
    assert.equal(reviewed.verdict, 'Pass');
    assert.equal(reviewed.mode, 'simulated');
    await assert.rejects(
        transport.confirmTest({ runId: run.id, testId: done.cases[0].test.id, value: 'yes' }),
        /observation/,
    );
});
test('cancellation skips later cases, stale IDs fail and fixtures block the affected case', async () => {
    const transport = createSimulation({ delayMs: 100 });
    const req = await request(transport),
        run = await transport.startTests(req);
    await assert.rejects(transport.startTests(req), /active/);
    await assert.rejects(transport.cancelTests('other'), /stale/);
    const cancelled = await transport.cancelTests(run.id);
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.cases[0].verdict, 'Inconclusive');
    assert.equal(cancelled.cases[1].verdict, 'Skipped');
    const next = await request(transport);
    next.readiness.fixtures[next.testIds[2]].ready = false;
    await transport.startTests(next);
    const done = await waitRun(transport);
    assert.equal(done.cases[2].verdict, 'Blocked');
});
test('identity mismatch fails instead of equating successful execution with Pass', async () => {
    const transport = createSimulation({ delayMs: 1 }),
        req = await request(transport);
    req.profile.tests[2].parameters.expected = 69;
    await transport.startTests(req);
    const done = await waitRun(transport);
    assert.equal(done.cases[2].verdict, 'Fail');
    assert.equal(done.verdict, 'Fail');
});
