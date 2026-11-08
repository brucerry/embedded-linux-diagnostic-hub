import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReport } from '../shared/report';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { wirelessSummary } from '../shared/diagnostics/network/wireless';
import { field } from '../shared/diagnostics/network/model';
const stamp = '2028-02-29T12:00:00Z';
const bad = { toString: null };
function fixture(kind: string) {
    const link: Record<string, unknown> = {
        ifname: 'eth0',
        ifindex: 7,
        flags: ['UP'],
        carrier: 1,
        mtu: 1500,
        operstate: 'UP',
    };
    const address: Record<string, unknown> = {
        family: 'inet',
        local: '192.0.2.7',
        prefixlen: 24,
        flags: ['permanent'],
    };
    if (kind === 'link-flags') link.flags = [bad];
    if (kind === 'link-mtu') link.mtu = bad;
    if (kind === 'link-carrier') link.carrier = bad;
    if (kind === 'address-prefix') address.prefixlen = bad;
    if (kind === 'address-family') address.family = bad;
    if (kind === 'address-flags') address.flags = [bad];
    const probe = (id: string, stdout = '') => ({
        id,
        stdout,
        stderr: '',
        exitCode: 0,
        status: 'collected',
        durationMs: 1,
        collectedAt: stamp,
        truncated: false,
    });
    const section = (operation: string, id: string, record: unknown) => ({
        ...probe(id, JSON.stringify([record])),
        operation,
        scope: 'all',
        source: 'live',
        command: 'synthetic read-only evidence',
    });
    return {
        schemaVersion: 1,
        mode: 'demo',
        endpoint: 'synthetic.invalid:22',
        username: 'fixture',
        capturedAt: stamp,
        results: [
            {
                ...probe('ethernet'),
                networkEvidence: {
                    version: 1,
                    sections: [section('ip-link-json', 'link', link)],
                    omissions: [],
                },
            },
            {
                ...probe('interfaces'),
                networkEvidence: {
                    version: 1,
                    sections: [
                        section('ip-address-json', 'address', {
                            ifname: 'eth0',
                            ifindex: 7,
                            addr_info: [address],
                        }),
                    ],
                    omissions: [],
                },
            },
            probe('wireless', 'phy#0\n\tInterface eth0\n\t\tifindex 7\n'),
        ],
    };
}
test('imported malformed field shapes cannot crash LAN/WLAN summaries or erase useful evidence', () => {
    const good = parseReport(JSON.stringify(fixture('valid')));
    const valid = lanSummary(good).interfaces.find((i) => i.name === 'eth0')!;
    assert.equal(valid.mtu, '1500');
    assert.equal(valid.admin, 'Enabled');
    assert.equal(valid.carrier, 'Present');
    for (const kind of [
        'link-flags',
        'link-mtu',
        'link-carrier',
        'address-prefix',
        'address-family',
        'address-flags',
    ]) {
        const input = fixture(kind);
        const firstResult = input.results[0];
        assert.ok('networkEvidence' in firstResult);
        const links = firstResult.networkEvidence.sections;
        const first = JSON.parse(links[0].stdout)[0];
        links[0].stdout = JSON.stringify([
            first,
            { ifname: 'eth1', ifindex: 9, flags: ['UP'], mtu: 9000, carrier: 0 },
        ]);
        const content = JSON.stringify(input);
        assert.ok(new TextEncoder().encode(content).length < 8192);
        const parsed = parseReport(content);
        const before = JSON.stringify(parsed);
        const model = lanSummary(parsed);
        assert.doesNotThrow(() => wirelessSummary(parsed));
        const iface = model.interfaces.find((i) => i.name === 'eth0')!,
            sibling = model.interfaces.find((i) => i.name === 'eth1')!;
        assert.equal(sibling.mtu, '9000');
        assert.equal(sibling.admin, 'Enabled');
        assert.equal(sibling.carrier, 'Absent');
        assert.equal(iface.ifindex, 7);
        if (kind === 'link-flags')
            assert.equal(
                iface.admin,
                undefined,
                'Malformed flags cannot imply Enabled or Disabled',
            );
        if (kind === 'link-mtu') assert.equal(iface.mtu, undefined);
        if (kind === 'link-carrier') assert.equal(iface.carrier, undefined);
        const fields = iface.groups.flatMap((g) => g.fields);
        if (['link-mtu', 'address-family', 'address-flags'].includes(kind))
            assert.ok(
                fields.some((f) => f.value === 'Not interpretable; inspect raw evidence.'),
                kind,
            );
        if (kind === 'address-prefix') {
            assert.ok(
                fields.some((f) => f.label === 'Address / prefix' && f.value === '192.0.2.7'),
            );
            assert.ok(
                model.warnings.some((w) => w.includes('address prefix could not be interpreted')),
            );
        }
        assert.equal(JSON.stringify(model).includes('[object Object]'), false);
        assert.equal(
            JSON.stringify(parsed),
            before,
            'Keep all raw bytes, schema flags, identity and provenance unchanged',
        );
    }
});

test('network detail formatting keeps scalar values and marks unsupported shapes without object coercion', () => {
    for (const [input, expected] of [
        [0, '0'],
        [false, 'false'],
        ['', ''],
        [['UP', 'LOWER_UP'], 'UP, LOWER_UP'],
        [[], ''],
    ] as const)
        assert.deepEqual(field('Value', input), [{ label: 'Value', value: expected }]);
    assert.deepEqual(field('Missing', null), []);
    assert.deepEqual(field('Missing', undefined), []);
    for (const input of [bad, [bad], { a: 1 }, NaN, Infinity])
        assert.deepEqual(field('Value', input), [
            { label: 'Value', value: 'Not interpretable; inspect raw evidence.' },
        ]);
});
test('nested and null optional fields preserve independent carrier evidence without inventing flags or prefixes', () => {
    for (const nested of [false, true]) {
        const input = fixture('valid');
        const ethernet = input.results[0],
            interfaces = input.results[1];
        assert.ok('networkEvidence' in ethernet && 'networkEvidence' in interfaces);
        ethernet.stdout = '/sys/class/net/eth0/carrier=0\n';
        const link = JSON.parse(ethernet.networkEvidence.sections[0].stdout)[0];
        link.flags = nested ? [['UP']] : null;
        link.mtu = nested ? [1500] : null;
        link.carrier = nested ? [1] : null;
        ethernet.networkEvidence.sections[0].stdout = JSON.stringify([link]);
        const address = JSON.parse(interfaces.networkEvidence.sections[0].stdout)[0];
        address.addr_info[0].prefixlen = nested ? [[24]] : null;
        address.addr_info[0].family = nested ? [['inet']] : null;
        address.addr_info[0].flags = [null];
        interfaces.networkEvidence.sections[0].stdout = JSON.stringify([address]);
        const parsed = parseReport(JSON.stringify(input)),
            before = JSON.stringify(parsed);
        const model = lanSummary(parsed),
            iface = model.interfaces.find((i) => i.name === 'eth0')!;
        assert.equal(iface.admin, undefined);
        assert.equal(iface.mtu, undefined);
        assert.equal(
            iface.carrier,
            'Absent',
            'Malformed optional data must not erase independent sysfs evidence',
        );
        assert.ok(
            iface.groups.some((g) =>
                g.fields.some((f) => f.label === 'Address / prefix' && f.value === '192.0.2.7'),
            ),
        );
        assert.equal(
            model.warnings.filter((w) => w.includes('address prefix could not be interpreted'))
                .length,
            1,
        );
        assert.doesNotThrow(() => wirelessSummary(parsed));
        assert.equal(JSON.stringify(parsed), before);
    }
    const emptyFlags = fixture('valid'),
        ethernet = emptyFlags.results[0];
    assert.ok('networkEvidence' in ethernet);
    const link = JSON.parse(ethernet.networkEvidence.sections[0].stdout)[0];
    link.flags = [];
    ethernet.networkEvidence.sections[0].stdout = JSON.stringify([link]);
    assert.equal(
        lanSummary(parseReport(JSON.stringify(emptyFlags))).interfaces[0].admin,
        'Disabled',
        'Valid empty flags retain their meaning',
    );
});

test('malformed-prefix warnings stay bounded while valid string prefixes and raw observations survive', () => {
    const input = fixture('valid'),
        interfaces = input.results[1];
    assert.ok('networkEvidence' in interfaces);
    const base = interfaces.networkEvidence.sections[0];
    interfaces.networkEvidence.sections = Array.from({ length: 17 }, (_, index) => ({
        ...base,
        id: 'prefix-' + index,
        stdout: JSON.stringify([
            {
                ifname: 'eth' + (index + 1),
                ifindex: index + 20,
                addr_info: [{ family: 'inet', local: '192.0.2.' + (index + 1), prefixlen: [[24]] }],
            },
        ]),
    }));
    const encoded = JSON.stringify(input);
    assert.ok(new TextEncoder().encode(encoded).length < 32768);
    const parsed = parseReport(encoded),
        before = JSON.stringify(parsed),
        model = lanSummary(parsed);
    assert.equal(model.warnings.length, 16);
    assert.ok(model.warnings[0].includes('prefix-0 '));
    assert.ok(model.warnings[15].includes('prefix-15 '));
    assert.equal(
        model.interfaces.filter((i) => i.groups.some((g) => g.title.startsWith('Address '))).length,
        17,
    );
    assert.equal(JSON.stringify(parsed), before);
    const valid = fixture('valid'),
        addresses = valid.results[1];
    assert.ok('networkEvidence' in addresses);
    const address = JSON.parse(addresses.networkEvidence.sections[0].stdout)[0];
    address.addr_info[0].prefixlen = '24';
    addresses.networkEvidence.sections[0].stdout = JSON.stringify([address]);
    const summary = lanSummary(parseReport(JSON.stringify(valid)));
    assert.deepEqual(summary.warnings, []);
    assert.ok(
        summary.interfaces[0].groups.some((g) => g.fields.some((f) => f.value === '192.0.2.7/24')),
    );
});
