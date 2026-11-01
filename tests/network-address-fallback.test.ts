import test from 'node:test';
import assert from 'node:assert/strict';
import { lanSummary } from '../shared/diagnostics/network/lan';
import type { Snapshot, ProbeResult } from '../shared/types';
import type { NetworkSection } from '../shared/diagnostics/network/evidence';

const primaryAt = '2026-10-30T14:00:00.000Z';
const jsonAt = '2026-10-30T14:00:01.000Z';
const primaryText = '2: eth0: <UP> mtu 1500 state UP\n    inet 192.0.2.2/24 scope global eth0\n';
const warning = 'Some ip-address-json:all JSON could not be interpreted; raw evidence is retained.';
function optional(stdout: string, status: ProbeResult['status'] = 'collected'): NetworkSection {
    return {
        id: 'ip-address-json:all', operation: 'ip-address-json', scope: 'all', source: 'live',
        command: 'synthetic optional JSON evidence only', status, stdout,
        stderr: status === 'unavailable' ? 'ip is not installed.' : status === 'error' ? 'Permission denied' : '',
        exitCode: status === 'unavailable' ? 127 : status === 'error' ? 1 : 0,
        durationMs: 1, collectedAt: jsonAt, truncated: stdout === '[',
    };
}
function fixture(sections: NetworkSection[], primaryStatus: ProbeResult['status'] = 'collected'): Snapshot {
    return {
        schemaVersion: 1, mode: 'demo', endpoint: 'synthetic.invalid:22', username: 'fixture',
        capturedAt: jsonAt,
        results: [{
            id: 'interfaces', command: 'synthetic primary text evidence only', status: primaryStatus,
            stdout: primaryText, stderr: primaryStatus === 'error' ? 'Synthetic primary failure' : '',
            exitCode: primaryStatus === 'collected' ? 0 : 1, durationMs: 1, collectedAt: primaryAt,
            truncated: false, networkEvidence: { version: 1, sections, omissions: [] },
        }],
    };
}
function summarize(input: Snapshot) {
    assert.ok(new TextEncoder().encode(JSON.stringify(input)).length < 4096);
    const before = structuredClone(input), model = lanSummary(input);
    assert.deepEqual(input, before, 'Summary must not rewrite primary or optional evidence.');
    return model;
}
function textAddress(input: Snapshot) {
    const model = summarize(input);
    assert.equal(model.interfaces.length, 1);
    const iface = model.interfaces[0];
    assert.equal(iface.name, 'eth0'); assert.equal(iface.admin, 'Enabled');
    assert.equal(iface.mtu, '1500'); assert.equal(iface.state, 'UP');
    assert.equal(iface.groups.length, 1);
    const address = iface.groups[0];
    assert.equal(address.title, 'Address (legacy text)');
    assert.equal(address.source, primaryAt);
    assert.deepEqual(address.fields, [{ label: 'Reported address', value: 'inet 192.0.2.2/24 scope global eth0' }]);
    return model;
}

test('LAN preserves readable primary address text when collected optional JSON cannot decode', () => {
    for (const stdout of ['[', '{}']) {
        const input = fixture([optional(stdout)]);
        assert.deepEqual(textAddress(input).warnings, [warning]);
        assert.equal(input.results[0].networkEvidence!.sections[0].stdout, stdout);
        assert.equal(input.results[0].networkEvidence!.sections[0].truncated, stdout === '[');
    }
});

test('LAN valid empty address JSON remains authoritative alongside a failed optional decode', () => {
    for (const mixed of [false, true]) {
        const empty = optional('[]'); empty.id = 'empty-address-json';
        const model = summarize(fixture(mixed ? [optional('['), empty] : [empty]));
        assert.deepEqual(model.interfaces, []);
        assert.deepEqual(model.warnings, mixed ? [warning] : []);
    }
});

test('LAN unavailable or denied address JSON retains its existing primary text fallback', () => {
    for (const status of ['unavailable', 'error'] as const) {
        const input = fixture([optional('', status)]);
        assert.deepEqual(textAddress(input).warnings, []);
        assert.equal(input.results[0].networkEvidence!.sections[0].status, status);
    }
});

test('LAN decode failure cannot authorize text fallback from a failed primary source', () => {
    const model = summarize(fixture([optional('[')], 'error'));
    assert.deepEqual(model.interfaces, []);
    assert.deepEqual(model.warnings, [warning]);
});

test('LAN decoded address records remain authoritative beside an undecodable optional source', () => {
    const valid = optional(JSON.stringify([{
        ifname: 'eth0', ifindex: 2, flags: ['UP'], mtu: 1500, operstate: 'UP',
        addr_info: [{ family: 'inet', local: '192.0.2.77', prefixlen: 24, scope: 'global' }],
    }]));
    valid.id = 'valid-address-json';
    const model = summarize(fixture([optional('['), valid]));
    assert.equal(model.interfaces.length, 1); assert.equal(model.interfaces[0].ifindex, 2);
    const groups = model.interfaces[0].groups;
    assert.equal(groups.length, 1); assert.equal(groups[0].title, 'Address 192.0.2.77');
    assert.equal(groups[0].source, jsonAt);
    assert.ok(groups[0].fields.some((f) => f.label === 'Address / prefix' && f.value === '192.0.2.77/24'));
    assert.ok(groups.every((g) => !g.id.startsWith('legacy-address-')));
    assert.deepEqual(model.warnings, [warning]);
});
