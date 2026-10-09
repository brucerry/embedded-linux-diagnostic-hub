import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation, sampleProfile } from '../shared/testing/simulation';
import { activeRun, type TestRun } from '../shared/testing/types';
import {
    createTestReport,
    parseTestReport,
    reportHtml,
    validateTestReport,
} from '../shared/testing/report';
import { preparePlan } from '../shared/testing/profile';
import { TestController, blankEvidence } from '../shared/testing/runner';
import { simulatedInventory } from '../shared/testing/simulation';
import { discoveryWire } from './fixtures/testing';
import { parseDiscovery } from '../shared/testing/inventory';
export async function reportFixture(): Promise<TestRun> {
    const target = createSimulation({ delayMs: 1 });
    const inventory = await target.discoverTests(),
        profile = sampleProfile();
    const first = await target.startTests({
        profile,
        inventoryId: inventory.id,
        testIds: profile.tests.map((t) => t.id),
        sequence: 'bench',
        readiness: {
            reviewed: true,
            fixtures: Object.fromEntries(
                profile.tests.map((t) => [t.id, { ready: true, identity: 'Fixture α' }]),
            ),
        },
    });
    while (activeRun(await target.readTestRun())) await new Promise((r) => setTimeout(r, 2));
    return target.confirmTest({ runId: first.id, testId: profile.tests[0].id, value: 'yes' });
}
test('reports round trip and reject forged verdicts, readiness, profile digests and secret fields', async () => {
    const report = createTestReport(await reportFixture());
    const imported = await parseTestReport(JSON.stringify(report));
    assert.equal(imported.imported, true);
    assert.deepEqual(imported.run, report.run);
    for (const modify of [
        (r: typeof report) => {
            r.run.cases[1].evidence!.measured = '00';
        },
        (r: typeof report) => {
            r.run.profileDigest = '0'.repeat(64);
        },
        (r: typeof report) => {
            r.run.readiness.reviewed = false;
        },
        (r: typeof report) => {
            r.run.cases[0].evidence!.cleanup = 'unverified';
        },
        (r: typeof report) => {
            Object.assign(r.run, { password: 'secret' });
        },
        (r: typeof report) => {
            Object.assign(r.run.cases[0].evidence!, { terminalOutput: 'secret' });
        },
        (r: typeof report) => {
            r.run.cases[0].evidence!.stdout = 'x'.repeat(65537);
        },
    ]) {
        const bad = structuredClone(report);
        modify(bad);
        await assert.rejects(validateTestReport(bad));
    }
    await assert.rejects(parseTestReport(' '.repeat(16 * 1024 * 1024 + 1)), /16 MiB/);
    await assert.rejects(parseTestReport('{'), /valid JSON/);
});
test('HTML escapes Unicode, markup, metadata and long evidence without external assets or scripts', async () => {
    const report = createTestReport(await reportFixture());
    report.run.profile.name = '<img src=https://example.invalid onerror=alert(1)> 裝置 α';
    report.run.cases[0].evidence!.stdout = '<script>alert(1)</script>\n' + 'long'.repeat(2000);
    report.run.cases[2].evidence!.measured = 0;
    const html = reportHtml(report);
    assert.match(html, /&lt;img/);
    assert.match(html, /裝置 α/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script|<img|<link|<iframe/);
    assert.match(html, /Observed value<\/dt><dd>0<\/dd>/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /SIMULATED DATA/);
});
test('discovery reconciles aliases, mux provenance and disabled DT nodes while preserving binary evidence', async () => {
    const inv = simulatedInventory();
    inv.nodes.push(
        {
            path: '/aliases',
            properties: { serial1: Buffer.from('/soc/serial@1000\0').toString('hex') },
        },
        {
            path: '/soc/i2c@2000/mux@70/i2c@1/disabled@48',
            properties: { status: '64697361626c656400', reg: '00000048' },
        },
    );
    inv.resources[2].controller = '/soc/i2c@2000/mux@70/i2c@1';
    inv.resources[2].metadata.bus = '27';
    inv.resources[2].path = '/sys/bus/i2c/devices/27-0048';
    const parsed = parseDiscovery(discoveryWire(inv), 'fixture:22', 'engineer');
    assert.equal(parsed.resources[2].controller, inv.resources[2].controller);
    assert.deepEqual(parsed.nodes, inv.nodes);
    assert.equal(parsed.resources.length, 3);
    assert.equal((await preparePlan(sampleProfile(), parsed)).cases[2].problems.length, 0);
    assert.throws(
        () => parseDiscovery(discoveryWire(inv).replace('HUB-INVENTORY-END', ''), 'a', 'b'),
        /Incomplete/,
    );
    assert.throws(
        () =>
            parseDiscovery(discoveryWire(inv).replace('C\tpython3\t1', 'C\tpython3\t2'), 'a', 'b'),
        /Malformed/,
    );
    const incomplete = parseDiscovery(
        discoveryWire({ ...inv, issues: ['Permission denied'] }),
        'a',
        'b',
    );
    assert.equal(incomplete.complete, false);
    assert.match(
        (await preparePlan(sampleProfile(), incomplete)).cases[0].problems.join(),
        /incomplete/,
    );
    inv.capabilities.python3 = false;
    assert.match((await preparePlan(sampleProfile(), inv)).cases[1].problems.join(), /Python/);
});
test('changed generations and unsafe cleanup block further operations; stop/continue remain serial', async () => {
    let inv = simulatedInventory(),
        calls = 0;
    const controller = new TestController(
        async () => structuredClone(inv),
        async () => {
            calls++;
            return { ...blankEvidence('ok', 'unsafe'), exitCode: 0, cleanup: 'unverified' };
        },
    );
    await controller.discoverInventory();
    const p = sampleProfile();
    const request = {
        profile: p,
        inventoryId: inv.id,
        testIds: p.tests.map((t) => t.id),
        sequence: 'bench',
        readiness: {
            reviewed: true,
            fixtures: Object.fromEntries(
                p.tests.map((t) => [t.id, { ready: true, identity: 'A' }]),
            ),
        },
    };
    inv.device.bootId = 'rebooted';
    await assert.rejects(controller.start(request), /inventory changed/);
    assert.equal(calls, 0);
    await controller.discoverInventory();
    await controller.start(request);
    while (controller.busy) await new Promise((r) => setTimeout(r, 2));
    assert.equal(calls, 1);
    assert.equal(controller.read()!.verdict, 'Inconclusive');
    await assert.rejects(controller.start(request), /Cleanup/);
    controller.interrupt('lost');
    assert.throws(() =>
        controller.confirm({ runId: controller.read()!.id, testId: p.tests[0].id, value: 'yes' }),
    );
    const target = createSimulation({ delayMs: 1, uartFault: true });
    const fresh = await target.discoverTests();
    p.sequences[0].stopOnFailure = true;
    await target.startTests({ ...request, profile: p, inventoryId: fresh.id });
    while (activeRun(await target.readTestRun())) await new Promise((r) => setTimeout(r, 2));
    assert.deepEqual(
        (await target.readTestRun())!.cases.map((c) => c.verdict),
        ['Inconclusive', 'Fail', 'Skipped'],
    );
});
test('late execution responses cannot rewrite sealed interruption evidence', async () => {
    const inventory = simulatedInventory();
    let release!: (value: ReturnType<typeof blankEvidence>) => void;
    const controller = new TestController(
        async () => structuredClone(inventory),
        () => new Promise((resolve) => (release = resolve)),
    );
    const profile = sampleProfile();
    await controller.discoverInventory();
    await controller.start({
        profile,
        inventoryId: inventory.id,
        testIds: [profile.tests[0].id],
        sequence: '',
        readiness: {
            reviewed: true,
            fixtures: { [profile.tests[0].id]: { ready: true, identity: 'A' } },
        },
    });
    controller.interrupt('Target replaced.');
    const sealed = controller.read();
    release({
        ...blankEvidence('ok', 'Late completion'),
        exitCode: 0,
        cleanup: 'verified',
        measured: 'pattern-executed',
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(controller.read(), sealed);
});
test('preparing another run does not expose or cancel a previously completed run as current work', async () => {
    const inventory = simulatedInventory();
    let hold = false,
        release!: (value: typeof inventory) => void;
    const controller = new TestController(
        () =>
            hold
                ? new Promise((resolve) => (release = resolve))
                : Promise.resolve(structuredClone(inventory)),
        async () => ({ ...blankEvidence('ok', 'Identity observed'), exitCode: 0, measured: 68 }),
    );
    const profile = sampleProfile(),
        testId = profile.tests[2].id,
        request = {
            profile,
            inventoryId: inventory.id,
            testIds: [testId],
            sequence: '',
            readiness: { reviewed: true, fixtures: { [testId]: { ready: true, identity: 'A' } } },
        };
    await controller.discoverInventory();
    await controller.start(request);
    while (controller.busy) await new Promise((r) => setImmediate(r));
    const previous = controller.read()!;
    hold = true;
    const pending = controller.start(request);
    assert.throws(() => controller.readProgress(), /preparation/);
    assert.equal((await controller.cancel(previous.id)).phase, 'complete');
    controller.interrupt('Disconnected during preparation.');
    release(inventory);
    await assert.rejects(pending, /connection changed/i);
    assert.deepEqual(controller.readProgress(), previous);
});
