import assert from 'node:assert/strict';
import test from 'node:test';
import { lanSummary } from '../shared/diagnostics/network/lan';
import type { NetworkOperation, NetworkSection } from '../shared/diagnostics/network/evidence';
import type { ProbeResult, Snapshot } from '../shared/types';

test('LAN keeps indexed identities separate when an interface name changes owner during collection', () => {
    const observations = [
        {
            index: 7, mac: '02:00:00:00:00:07', mtu: 1500, bytes: 101, errors: 1,
            address: '192.0.2.7', linkAt: '2026-10-29T12:00:00.000Z',
            addressAt: '2026-10-29T12:00:02.000Z',
        },
        {
            index: 19, mac: '02:00:00:00:00:19', mtu: 9000, bytes: 202, errors: 2,
            address: '192.0.2.19', linkAt: '2026-10-29T12:00:01.000Z',
            addressAt: '2026-10-29T12:00:03.000Z',
        },
    ];
    const section = (
        id: string, operation: NetworkOperation, collectedAt: string, record: unknown,
    ): NetworkSection => ({
        id, operation, collectedAt, scope: 'all', source: 'live', status: 'collected',
        stdout: JSON.stringify([record]), stderr: '', exitCode: 0, durationMs: 1, truncated: false,
    });
    const probe = (id: string, sections: NetworkSection[]): ProbeResult => ({
        id, status: 'collected', stdout: '', stderr: '', exitCode: 0, durationMs: 4,
        collectedAt: '2026-10-29T12:00:04.000Z', truncated: false,
        networkEvidence: { version: 1, omissions: [], sections },
    });
    // Synthetic observations only. No collector, ip command, device or network API is imported.
    const input: Snapshot = {
        schemaVersion: 1, mode: 'demo', endpoint: 'synthetic.invalid:22', username: 'fixture',
        capturedAt: '2026-10-29T12:00:04.000Z',
        results: [
            probe('ethernet', observations.map((value) => section(
                'link-' + value.index, 'ip-link-json', value.linkAt,
                {
                    ifname: 'eth0', ifindex: value.index, address: value.mac, mtu: value.mtu,
                    flags: ['UP'], operstate: 'UNKNOWN', link_type: 'ether',
                    stats64: { rx: { bytes: value.bytes, errors: value.errors } },
                },
            ))),
            probe('interfaces', observations.map((value) => section(
                'address-' + value.index, 'ip-address-json', value.addressAt,
                {
                    ifname: 'eth0', ifindex: value.index,
                    addr_info: [{ family: 'inet', local: value.address, prefixlen: 24, scope: 'global' }],
                },
            ))),
        ],
    };
    assert.ok(new TextEncoder().encode(JSON.stringify(input)).length < 4096);
    assert.ok(input.results.every((result) => result.networkEvidence!.sections.length === 2));
    const before = structuredClone(input);
    const model = lanSummary(input);
    assert.equal(model.interfaces.length, 2);
    assert.equal(new Set(model.interfaces.map((iface) => iface.id)).size, 2);
    assert.deepEqual(model.interfaces.map((iface) => iface.ifindex).sort((a, b) => a! - b!), [7, 19]);
    for (const expected of observations) {
        const iface = model.interfaces.find((value) => value.ifindex === expected.index)!;
        assert.ok(iface);
        assert.equal(iface.name, 'eth0');
        assert.equal(iface.mac, expected.mac);
        assert.equal(iface.mtu, String(expected.mtu));
        assert.equal(iface.groups.length, 3, 'One link, counter and address group per identity.');
        const link = iface.groups.find((group) => group.id === 'link')!;
        assert.equal(link.source, expected.linkAt);
        assert.deepEqual(link.fields.filter((field) => field.label === 'Interface index'), [
            { label: 'Interface index', value: String(expected.index) },
        ]);
        const counters = iface.groups.find((group) => group.id === 'counters')!;
        assert.equal(counters.source, expected.linkAt);
        assert.deepEqual(counters.fields, [
            { label: 'rx bytes (bytes)', value: String(expected.bytes) },
            { label: 'rx errors (count)', value: String(expected.errors) },
        ]);
        const addresses = iface.groups.filter((group) => group.id.startsWith('address-'));
        assert.equal(addresses.length, 1);
        assert.equal(addresses[0].source, expected.addressAt);
        assert.deepEqual(addresses[0].fields.filter((field) => field.label === 'Address / prefix'), [
            { label: 'Address / prefix', value: expected.address + '/24' },
        ]);
    }
    // Link19 and address19 both encounter the conflict; the user should see one warning.
    assert.deepEqual(model.warnings, [
        'eth0: interface identity changed during collection; conflicting records kept separate.',
    ]);
    assert.deepEqual(model.groups, []);
    assert.deepEqual(input, before, 'Summarizing must preserve all raw observations.');
});
