import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkCollector } from '../backend/ssh/network';
import { validateNetworkEvidence } from '../shared/diagnostics/network/evidence';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { wirelessInventory } from '../shared/diagnostics/network/wireless';
import type { Probe, ProbeResult, Snapshot } from '../shared/types';

const stamp = '2028-02-29T00:00:00.000Z';
function result(id: string, stdout: string): ProbeResult {
    return { id, stdout, stderr: '', exitCode: 0, status: 'collected', durationMs: 1,
        collectedAt: stamp, truncated: false };
}
async function collect(id: string, raw: string, options: { exhaust?: boolean; collector?: NetworkCollector } = {}) {
    const calls: string[] = [];
    const output = await (options.collector ?? new NetworkCollector()).collect(
        { id, command: 'fixed synthetic primary' } as Probe,
        async (key, _command, limits) => {
            calls.push(key);
            return result(key, key === id ? id === 'wireless' ? raw : '' :
                key === 'ip-link-json:all' ? raw : options.exhaust && key === 'iw-regulatory:global'
                    ? 'x'.repeat(limits.maxBytes) : '');
        },
    );
    return { calls, output };
}
function valid(output: ProbeResult) {
    const evidence = output.networkEvidence!;
    assert.deepEqual(validateNetworkEvidence(evidence, output), evidence);
    assert.equal(new Set(evidence.sections.map((s) => s.id)).size, evidence.sections.length);
}
const ethernet = (name: string, index: number) => ({ ifname: name, ifindex: index, link_type: 'ether' });
const radio = (name: string, index: number, phy = 0, mode = 'managed') =>
    `phy#${phy}\n Interface ${name}\n  ifindex ${index}\n  type ${mode}\n`;

test('Ethernet deduplicates exact getter selectors but retains raw distinct indexed identities', async () => {
    const rows = [ethernet('eth0', 7), ethernet('eth0', 7), ethernet('eth0', 19), ethernet('eth1', 20)];
    const raw = JSON.stringify(rows), f = await collect('ethernet', raw);
    valid(f.output);
    assert.deepEqual(f.calls.filter((id) => id.startsWith('ethtool:')), ['ethtool:eth0', 'ethtool:eth1']);
    assert.equal(f.output.networkEvidence!.sections.find((s) => s.operation === 'ip-link-json')!.stdout, raw);
    const snapshot: Snapshot = { schemaVersion: 1, mode: 'demo', endpoint: 'synthetic.invalid', username: 'fixture',
        capturedAt: stamp, results: [f.output] };
    const model = lanSummary(snapshot);
    assert.deepEqual(model.interfaces.map((i) => i.ifindex).sort((a, b) => a! - b!), [7, 19, 20]);
    assert.ok(model.warnings.some((w) => w.includes('multiple interface indices')));
});

test('Ethernet unique selector order and first16 limit ignore repeated discovery rows', async () => {
    const rows = [...Array.from({ length: 24 }, () => ethernet('eth0', 7)),
        ...Array.from({ length: 16 }, (_, i) => ethernet('eth' + (i + 1), i + 8))];
    const raw = JSON.stringify(rows), f = await collect('ethernet', raw);
    valid(f.output);
    assert.deepEqual(f.calls.filter((id) => id.startsWith('ethtool:')),
        Array.from({ length: 16 }, (_, i) => 'ethtool:eth' + i));
    assert.deepEqual(f.output.networkEvidence!.omissions,
        [{ operation: 'ethtool', scope: 'all', reason: 'First 16 optional interfaces only.' }]);
    assert.equal(f.output.networkEvidence!.sections.find((s) => s.operation === 'ip-link-json')!.stdout, raw);
});

test('WLAN getter selectors are unique while PHY and indexed discovery evidence stays separate', async () => {
    const raw = radio('wlan0', 7) + radio('wlan0', 7) + radio('wlan0', 19, 1) + radio('wlan1', 20, 1);
    const f = await collect('wireless', raw);
    valid(f.output);
    assert.equal(f.output.stdout, raw);
    for (const op of ['iw-link', 'iw-stations', 'iw-survey', 'iw-power-save'])
        assert.deepEqual(f.calls.filter((id) => id.startsWith(op + ':')), [op + ':wlan0', op + ':wlan1']);
    assert.deepEqual(f.calls.filter((id) => id.startsWith('iw-phy:')), ['iw-phy:phy0', 'iw-phy:phy1']);
    assert.deepEqual(wirelessInventory(f.output.stdout).map((i) => i.ifindex), [7, 7, 19, 20]);
});

test('WLAN unique first8 order and eligible link getter survive duplicate and mixed-mode rows', async () => {
    const raw = radio('wlan0', 7, 0, 'AP') + radio('wlan0', 7).repeat(20) +
        Array.from({ length: 8 }, (_, i) => radio('wlan' + (i + 1), i + 8)).join('');
    const f = await collect('wireless', raw);
    valid(f.output);
    for (const op of ['iw-link', 'iw-stations', 'iw-survey', 'iw-power-save'])
        assert.deepEqual(f.calls.filter((id) => id.startsWith(op + ':')),
            Array.from({ length: 8 }, (_, i) => op + ':wlan' + i));
    assert.deepEqual(f.output.networkEvidence!.omissions,
        [{ operation: 'iw-info', scope: 'all', reason: 'First eight interfaces only.' }]);
    assert.equal(f.output.stdout, raw);
});

test('duplicate discovery does not multiply budget omissions or capability-cache sections', async () => {
    const raw = radio('wlan0', 7).repeat(20) + radio('wlan1', 19, 1);
    const exhausted = await collect('wireless', raw, { exhaust: true });
    valid(exhausted.output);
    assert.equal(exhausted.output.stdout, raw);
    assert.equal(exhausted.output.networkEvidence!.omissions.filter((o) => o.operation === 'iw-stations' && o.scope === 'wlan0').length, 1);
    assert.ok(exhausted.output.networkEvidence!.omissions.some((o) => o.scope === 'wlan1'));
    const collector = new NetworkCollector();
    await collect('wireless', raw, { collector });
    const cached = await collect('wireless', raw, { collector });
    valid(cached.output);
    assert.deepEqual(cached.calls.filter((id) => id.startsWith('iw-phy:') || id === 'iw-version:tool'), []);
    const sections = cached.output.networkEvidence!.sections.filter((s) => s.source === 'cached');
    assert.deepEqual(sections.map((s) => s.id), ['iw-version:tool', 'iw-phy:phy0', 'iw-phy:phy1']);
    assert.ok(sections.every((s) => s.collectedAt === stamp));
});

test('ordinary distinct selectors and sysfs fallback keep existing order without omissions', async () => {
    for (const id of ['ethernet', 'wireless']) {
        const f = await collect(id, id === 'ethernet' ? JSON.stringify([ethernet('eth2', 2), ethernet('eth0', 7)]) :
            radio('wlan2', 2) + radio('wlan0', 7));
        valid(f.output);
        assert.deepEqual(f.calls.filter((key) => key.startsWith(id === 'ethernet' ? 'ethtool:' : 'iw-link:')),
            id === 'ethernet' ? ['ethtool:eth2', 'ethtool:eth0'] : ['iw-link:wlan2', 'iw-link:wlan0']);
        assert.deepEqual(f.output.networkEvidence!.omissions, []);
    }
    const calls: string[] = [];
    const output = await new NetworkCollector().collect({ id: 'ethernet', command: 'fixed primary' } as Probe,
        async (key) => { calls.push(key); return result(key, key === 'ethernet'
            ? '/sys/class/net/eth2/carrier=1\n/sys/class/net/eth2/operstate=up\n/sys/class/net/eth0/carrier=1\n'
            : key === 'ip-link-json:all' ? '[]' : ''); });
    valid(output);
    assert.deepEqual(calls.filter((key) => key.startsWith('ethtool:')), ['ethtool:eth2', 'ethtool:eth0']);
});
