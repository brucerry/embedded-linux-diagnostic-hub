import assert from 'node:assert/strict';
import test from 'node:test';
import { wirelessSummary } from '../shared/diagnostics/network/wireless';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { validateNetworkEvidence, type NetworkSection } from '../shared/diagnostics/network/evidence';
import type { Snapshot, ProbeResult } from '../shared/types';

// Actual pure summaries and bounded synthetic evidence only; no collector or device.
const stamp = '2026-10-31T09:00:00.000Z';
function fixture(wirelessIndex?: number, linkIndices = [7, 19]): Snapshot {
    const link = (index: number): NetworkSection => ({
        id: 'link-' + index, operation: 'ip-link-json', scope: 'all', source: 'live',
        command: 'synthetic imported observation only', collectedAt: stamp, durationMs: 1,
        status: 'collected', exitCode: 0, stderr: '', truncated: false,
        stdout: JSON.stringify([{ ifname: 'wlan0', ifindex: index, flags: index === 7 ? ['UP', 'LOWER_UP'] : [],
            carrier: index === 7 ? 1 : 0, operstate: index === 7 ? 'UP' : 'DOWN',
            address: index === 7 ? '02:00:00:00:00:07' : '02:00:00:00:00:19', link_type: 'ether' }]),
    });
    const rawWireless = wirelessIndex === undefined
        ? 'wlan0 ESSID: "Synthetic Lab"\n          Mode: Client  Channel: 1\n          Signal: -50 dBm\n'
        : 'phy#0\n\tInterface wlan0\n\t\tifindex ' + wirelessIndex + '\n\t\ttype managed\n';
    const wireless: ProbeResult = { id: 'wireless', command: 'synthetic wireless observation only',
        status: 'collected', exitCode: 0, stdout: rawWireless, stderr: '', durationMs: 1,
        collectedAt: stamp, truncated: false };
    const ethernet: ProbeResult = { id: 'ethernet', command: 'synthetic link observations only',
        status: 'collected', exitCode: 0, stdout: '', stderr: '', durationMs: 2,
        collectedAt: stamp, truncated: false,
        networkEvidence: { version: 1, sections: linkIndices.map(link), omissions: [] } };
    assert.deepEqual(validateNetworkEvidence(ethernet.networkEvidence, ethernet), ethernet.networkEvidence);
    const snapshot: Snapshot = { schemaVersion: 1, mode: 'ssh', endpoint: 'synthetic.invalid:22', username: 'fixture',
        capturedAt: stamp, results: [wireless, ethernet] };
    assert.ok(new TextEncoder().encode(JSON.stringify(snapshot)).length < 4096);
    return snapshot;
}

const ambiguity = 'wlan0: multiple link identities match this wireless interface; administrative/carrier/operating state not merged.';
function summarize(input: Snapshot) {
    const before = structuredClone(input), lan = lanSummary(input), model = wirelessSummary(input);
    assert.deepEqual(input, before, 'Merging summary state must not rewrite raw source evidence.');
    assert.equal(model.interfaces.length, 1);
    return { lan, model, iface: model.interfaces[0] };
}
test('wireless without an index leaves conflicting same-name link state unknown in either source order', () => {
    for (const order of [[7, 19], [19, 7]]) {
        const input = fixture(undefined, order), { lan, model, iface } = summarize(input);
        assert.equal(lan.interfaces.length, 2); assert.equal(new Set(lan.interfaces.map(item => item.id)).size, 2);
        for (const item of lan.interfaces) {
            assert.equal(item.state, item.ifindex === 7 ? 'UP' : 'DOWN');
            assert.equal(item.mac, item.ifindex === 7 ? '02:00:00:00:00:07' : '02:00:00:00:00:19');
        }
        assert.equal(iface.name, 'wlan0'); assert.equal(iface.kind, 'Wi-Fi (iwinfo)');
        assert.equal(iface.ifindex, undefined); assert.equal(iface.ssid, 'Synthetic Lab');
        assert.equal(iface.admin, undefined); assert.equal(iface.carrier, undefined); assert.equal(iface.state, undefined);
        assert.equal(iface.signal, '-50 dBm');
        assert.equal(model.warnings.filter(value => value === ambiguity).length, 1);
        assert.ok(model.warnings.includes('Reduced fallback observations; iw PHY capability and current-channel noise are unavailable.'));
        assert.ok(model.warnings.length <= 16); assert.ok(ambiguity.length <= 256);
        assert.ok(iface.groups.some(group => group.id === 'legacy' && group.source === stamp));
    }
});
test('wireless explicit index selects the corresponding link identity even when a conflicting name appears first', () => {
    const { lan, model, iface } = summarize(fixture(19));
    assert.deepEqual(lan.interfaces.map(item => item.ifindex), [7, 19]);
    assert.equal(iface.ifindex, 19); assert.equal(iface.admin, 'Disabled');
    assert.equal(iface.carrier, 'Absent'); assert.equal(iface.state, 'DOWN');
    assert.equal(model.warnings.includes(ambiguity), false);
});
test('wireless fallback keeps the established unique-name link state without inventing a wireless index', () => {
    const { lan, model, iface } = summarize(fixture(undefined, [19]));
    assert.equal(lan.interfaces.length, 1); assert.equal(iface.ifindex, undefined);
    assert.equal(iface.admin, 'Disabled'); assert.equal(iface.carrier, 'Absent'); assert.equal(iface.state, 'DOWN');
    assert.equal(model.warnings.includes(ambiguity), false); assert.equal(model.warnings.length, 1);
});
