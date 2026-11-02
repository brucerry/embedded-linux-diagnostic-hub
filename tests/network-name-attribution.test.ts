import test from 'node:test';
import assert from 'node:assert/strict';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { parseReport } from '../shared/report';
const at = '2028-02-29T12:00:00Z', unindexedAt = '2028-02-29T12:00:03Z';
function fixture(order: number[] = [7, 19], first = false, addressOnly = false) {
    const probe = (id: string, stdout = '') => ({
        id, stdout, stderr: '', exitCode: 0, status: 'collected', durationMs: 1,
        collectedAt: at, truncated: false,
    });
    const section = (id: string, operation: string, stdout: string, scope = 'all') => ({
        ...probe(id, stdout), operation, scope, source: 'live', command: 'synthetic',
    });
    const indexed = addressOnly ? [] : order.map((i) => section('link' + i, 'ip-link-json', JSON.stringify([{
        ifname: 'eth0', ifindex: i, flags: i === 7 ? ['UP'] : [], operstate: i === 7 ? 'UP' : 'DOWN',
        mtu: i === 7 ? 1500 : 9000, address: '02:00:00:00:00:' + i,
    }])));
    const nameOnly = { ...section('name-link', 'ip-link-json', JSON.stringify([{
        ifname: 'eth0', flags: ['UP'], operstate: 'NAME-ONLY', mtu: 1234, address: '02:00:00:00:00:99',
    }])), collectedAt: unindexedAt };
    const address = (i?: number) => section('address' + (i ?? 'unknown'), 'ip-address-json', JSON.stringify([{
        ifname: 'eth0', ...(i === undefined ? {} : { ifindex: i }),
        addr_info: [{ family: 'inet', local: i === undefined ? '203.0.113.99' : '192.0.2.' + i, prefixlen: 24 }],
    }]));
    const sections = [
        ...(first ? [nameOnly] : []), ...indexed, ...(!first ? [nameOnly] : []),
        section('speed', 'ethtool', 'Speed: 1000Mb/s\nDuplex: Full\n', 'eth0'),
        section('neighbor', 'ip-neighbor-json', JSON.stringify([{
            dev: 'eth0', dst: '192.0.2.100', lladdr: '00:00:00:00:00:aa', state: ['STALE'],
        }])),
    ];
    // Actual report validation/model only; no collector, device API or storage is imported.
    return parseReport(JSON.stringify({
        schemaVersion: 1, mode: 'demo', endpoint: 'synthetic.invalid', username: 'fixture', capturedAt: at,
        results: [
            { ...probe('ethernet', '/sys/class/net/eth0/carrier=1\n/sys/class/net/eth0/operstate=SYSFS-NAME\n'),
                networkEvidence: { version: 1, sections, omissions: [] } },
            { ...probe('interfaces'), networkEvidence: {
                version: 1, sections: [address(), ...order.map((i) => address(i))], omissions: [],
            } },
        ],
    }));
}
const ambiguity = 'eth0: multiple interface indices were observed; name-only observations kept unassigned.';
for (const order of [[7, 19], [19, 7]]) for (const first of [false, true])
    for (const addressOnly of [false, true])
        test(`LAN leaves name-only observations unassigned: indices ${order}, first=${first}, addressOnly=${addressOnly}`, () => {
            const input = fixture(order, first, addressOnly), before = JSON.stringify(input);
            const model = lanSummary(input);
            assert.equal(model.interfaces.length, 2);
            assert.equal(new Set(model.interfaces.map((i) => i.id)).size, 2);
            assert.equal(model.warnings.filter((w) => w === ambiguity).length, 1);
            for (const index of [7, 19]) {
                const iface = model.interfaces.find((i) => i.ifindex === index)!;
                assert.ok(iface);
                assert.equal(iface.id, JSON.stringify(['eth0', index]));
                assert.ok(iface.groups.some((g) => g.fields.some((f) => f.value === `192.0.2.${index}/24`)));
                assert.ok(iface.groups.every((g) => !['physical', 'sysfs'].includes(g.id)));
                assert.ok(iface.groups.every((g) => !g.id.startsWith('neighbor-')));
                assert.ok(iface.groups.every((g) => !g.fields.some((f) => f.value === '203.0.113.99/24')));
                assert.equal(iface.mtu, addressOnly ? undefined : index === 7 ? '1500' : '9000');
                assert.equal(iface.state, addressOnly ? undefined : index === 7 ? 'UP' : 'DOWN');
                assert.equal(iface.carrier, undefined, 'Name-only sysfs carrier must not become indexed carrier.');
            }
            const unassigned = model.groups.filter((g) => g.note?.includes('Name-only observation'));
            assert.equal(unassigned.length, 5, 'Separate link/address/sysfs/physical/neighbor source groups survive.');
            assert.equal(new Set(unassigned.map((g) => g.id)).size, 5);
            assert.ok(unassigned.every((g) => g.title.startsWith('eth0 · index unresolved · ')));
            assert.ok(unassigned.every((g) => g.source === at || g.source === unindexedAt));
            for (const value of ['NAME-ONLY', '1234', '203.0.113.99/24', '1000Mb/s', 'SYSFS-NAME', '192.0.2.100'])
                assert.ok(unassigned.some((g) => g.fields.some((f) => f.value === value)), value);
            assert.equal(JSON.stringify(input), before);
        });
test('LAN preserves single-index and name-only fallbacks without ambiguity warnings', () => {
    for (const order of [[7], []]) {
        const input = fixture(order, true), model = lanSummary(input);
        assert.equal(model.interfaces.length, 1);
        assert.equal(model.interfaces[0].ifindex, order[0]);
        assert.ok(model.interfaces[0].groups.some((g) => g.id === 'physical'));
        assert.ok(model.interfaces[0].groups.some((g) => g.id === 'sysfs'));
        assert.ok(model.interfaces[0].groups.some((g) => g.fields.some((f) => f.value === '203.0.113.99/24')));
        assert.deepEqual(model.warnings, []);
        assert.ok(model.groups.every((g) => !g.note?.includes('Name-only observation')));
        assert.deepEqual(model.groups.map((g) => g.id), ['routes-legacy']);
    }
});
test('LAN attributes primary indexed text by index but keeps index-less ifconfig addresses unresolved', () => {
    for (const indexed of [true, false]) {
        const input = fixture();
        const address = input.results.find((r) => r.id === 'interfaces')!;
        delete address.networkEvidence;
        address.stdout = indexed ? '19: eth0: <UP> mtu 1900 state UP\n    inet 198.51.100.19/24\n'
            : 'eth0: flags=4163<UP> mtu 1700\n    inet 198.51.100.99 netmask 255.255.255.0\n';
        const model = lanSummary(input);
        const perInterface = model.interfaces.flatMap((i) => i.groups).filter((g) => g.id.startsWith('legacy-address-'));
        assert.equal(perInterface.length, indexed ? 1 : 0);
        if (indexed) {
            assert.equal(model.interfaces.find((i) => i.ifindex === 19)!.mtu, '1900');
            assert.ok(model.interfaces.find((i) => i.ifindex === 19)!.groups.includes(perInterface[0]));
        } else assert.ok(model.groups.some((g) => g.note && g.fields.some((f) => f.value.includes('198.51.100.99'))));
    }
});
test('LAN discovers ambiguity in active legacy link headers but ignores failed indexed sections', () => {
    const input = fixture([], true);
    const ethernet = input.results.find((r) => r.id === 'ethernet')!;
    const sections = ethernet.networkEvidence!.sections;
    sections.splice(sections.findIndex((s) => s.operation === 'ip-link-json'), 1);
    sections.push({ ...sections[0], id: 'text-links', operation: 'ip-link-text', scope: 'all',
        stdout: '7: eth0: <UP> mtu 1500 state UP\n19: eth0: <NO-CARRIER> mtu 9000 state DOWN\n' });
    let model = lanSummary(input);
    assert.deepEqual(model.interfaces.map((i) => i.ifindex), [7, 19]);
    assert.ok(model.interfaces.every((i) => !i.groups.some((g) => g.id === 'physical')));
    assert.ok(model.groups.some((g) => g.note && g.fields.some((f) => f.value === '1000Mb/s')));
    const failed = fixture([7]);
    failed.results[0].networkEvidence!.sections.push({ ...sections[0], id: 'failed-index19', operation: 'ip-link-json',
        status: 'error', stdout: '[{"ifname":"eth0","ifindex":19}]' });
    model = lanSummary(failed);
    assert.equal(model.interfaces.length, 1);
    assert.deepEqual(model.warnings, []);
    assert.ok(model.interfaces[0].groups.some((g) => g.id === 'physical'));
});
test('LAN tuple identity does not collide with a literal name containing an index suffix', () => {
    const input = fixture();
    input.results[0].networkEvidence!.sections.push({ ...input.results[0].networkEvidence!.sections[0], id: 'literal-name',
        stdout: '[{"ifname":"eth0#19","ifindex":99,"mtu":777}]' });
    const model = lanSummary(input);
    assert.equal(model.interfaces.length, 3);
    assert.equal(new Set(model.interfaces.map((i) => i.id)).size, 3);
    assert.equal(model.interfaces.find((i) => i.name === 'eth0#19')!.mtu, '777');
    assert.ok(model.warnings.every((w) => w.startsWith('eth0:')));
});
