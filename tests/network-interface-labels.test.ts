import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../shared/report';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { interfaceLabel } from '../shared/diagnostics/network/model';
import { networkIdentityReport } from './fixtures/network-identity';

test('actual indexed LAN identities have distinguishable labels without changing tuple values or evidence', () => {
    const source = networkIdentityReport(),
        encoded = JSON.stringify(source);
    assert.ok(Buffer.byteLength(encoded) < 4096);
    const snapshot = parseReport(encoded),
        before = JSON.stringify(snapshot);
    const model = lanSummary(snapshot);
    assert.deepEqual(
        model.interfaces.map((iface) => iface.id),
        ['["eth0",7]', '["eth0",19]', '["eth1",null]'],
    );
    assert.deepEqual(model.interfaces.map(interfaceLabel), [
        'eth0 · ifindex 7',
        'eth0 · ifindex 19',
        'eth1',
    ]);
    assert.equal(new Set(model.interfaces.map(interfaceLabel)).size, 3);
    assert.deepEqual(
        model.interfaces.map((iface) => iface.mtu),
        ['1500', '9000', '1200'],
    );
    assert.ok(
        model.warnings.includes(
            'eth0: interface identity changed during collection; conflicting records kept separate.',
        ),
    );
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(JSON.stringify(source), encoded);
});

test('labels retain optional PHY/kind context and display reported zero without inventing a missing index', () => {
    assert.equal(interfaceLabel({ name: 'eth1', kind: 'Unclassified' }), 'eth1');
    assert.equal(
        interfaceLabel({ name: 'wlan0', ifindex: 3, phy: 'phy0', kind: 'Wireless' }),
        'wlan0 · ifindex 3 · phy0 · Wireless',
    );
    assert.equal(
        interfaceLabel({ name: 'wlan0', phy: 'phy0', kind: 'Wireless' }),
        'wlan0 · phy0 · Wireless',
    );
    assert.equal(
        interfaceLabel({ name: 'lo', ifindex: 0, kind: 'Loopback' }),
        'lo · ifindex 0 · Loopback',
    );
});
