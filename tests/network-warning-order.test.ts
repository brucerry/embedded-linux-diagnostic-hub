import test from 'node:test';
import assert from 'node:assert/strict';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { validateNetworkEvidence } from '../shared/diagnostics/network/evidence';
import type { Snapshot, ProbeResult } from '../shared/types';
import type { NetworkSection } from '../shared/diagnostics/network/evidence';

const stamp = '2026-10-30T15:00:00.000Z';
const identityWarning = 'eth0: interface identity changed during collection; conflicting records kept separate.';
const parseWarning = (index: number) => 'Some bad-address-' + index + ' JSON could not be interpreted; raw evidence is retained.';
function section(id: string, operation: NetworkSection['operation'], stdout: string): NetworkSection {
    return { id, operation, scope: 'all', source: 'live', command: 'synthetic imported evidence only',
        status: 'collected', stdout, stderr: '', exitCode: 0, durationMs: 1,
        collectedAt: stamp, truncated: stdout === '[' };
}
function probe(id: string, sections: NetworkSection[]): ProbeResult {
    const value: ProbeResult = { id, command: 'synthetic primary evidence only', status: 'collected',
        stdout: '', stderr: '', exitCode: 0, durationMs: 1, collectedAt: stamp, truncated: false,
        networkEvidence: { version: 1, sections, omissions: [] } };
    assert.deepEqual(validateNetworkEvidence(value.networkEvidence, value), value.networkEvidence);
    return value;
}
function fixture(): Snapshot {
    return { schemaVersion: 1, mode: 'ssh', endpoint: 'synthetic.invalid:22', username: 'fixture',
        capturedAt: stamp, results: [
            probe('ethernet', [section('link-index7', 'ip-link-json', JSON.stringify([
                { ifname: 'eth0', ifindex: 7, flags: ['UP'], link_type: 'ether' },
            ]))]),
            probe('interfaces', [section('valid-address-index19', 'ip-address-json', JSON.stringify([
                { ifname: 'eth0', ifindex: 19, addr_info: [{ family: 'inet', local: '192.0.2.19', prefixlen: 24 }] },
            ])), ...Array.from({ length: 16 }, (_, index) => section('bad-address-' + index, 'ip-address-json', '['))]),
        ] };
}
test('LAN preserves identity-warning order at the existing cap when later address JSON cannot decode', () => {
    const input = fixture(), before = structuredClone(input);
    assert.ok(new TextEncoder().encode(JSON.stringify(input)).length < 16384);
    const model = lanSummary(input);
    assert.deepEqual(model.warnings, [identityWarning, ...Array.from({ length: 15 }, (_, index) => parseWarning(index))]);
    assert.equal(model.warnings.length, 16);
    assert.equal(model.warnings.includes(parseWarning(15)), false);
    assert.equal(model.interfaces.length, 2);
    assert.equal(new Set(model.interfaces.map((iface) => iface.id)).size, 2);
    assert.deepEqual(model.interfaces.map((iface) => iface.ifindex).sort((a, b) => a! - b!), [7, 19]);
    const address = model.interfaces.find((iface) => iface.ifindex === 19)!.groups.find((group) => group.id === 'address-0')!;
    assert.equal(address.source, stamp);
    assert.ok(address.fields.some((field) => field.label === 'Address / prefix' && field.value === '192.0.2.19/24'));
    assert.deepEqual(input, before, 'Warning ordering must not rewrite raw evidence or source identities.');
});
