import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../shared/report';
import { lanSummary } from '../shared/diagnostics/network/lan';
const at = '2028-02-29T12:00:00Z';
function fixture(prefix: unknown, family: unknown = 'inet', literal?: string) {
    const rows = [
        { family, local: family === 'inet6' ? '2001:db8::7' : '192.0.2.7', prefixlen: prefix },
        { family: 'inet', local: '192.0.2.8', prefixlen: 24 },
    ];
    let stdout = JSON.stringify([{ ifname: 'eth0', ifindex: 7, addr_info: rows }]);
    if (literal !== undefined) stdout = stdout.replace('"PREFIX_TOKEN"', literal);
    const probe = (id: string, stdout = '') => ({
        id,
        stdout,
        stderr: '',
        exitCode: 0,
        status: 'collected',
        durationMs: 1,
        collectedAt: at,
        truncated: false,
    });
    return parseReport(
        JSON.stringify({
            schemaVersion: 1,
            mode: 'demo',
            endpoint: 'synthetic.invalid',
            username: 'fixture',
            capturedAt: at,
            results: [
                {
                    ...probe('interfaces'),
                    networkEvidence: {
                        version: 1,
                        sections: [
                            {
                                ...probe('addresses', stdout),
                                operation: 'ip-address-json',
                                scope: 'all',
                                source: 'live',
                                command: 'synthetic',
                            },
                        ],
                        omissions: [],
                    },
                },
            ],
        }),
    );
}
const address = (s: ReturnType<typeof fixture>) =>
    lanSummary(s).interfaces[0].groups[0].fields.find((f) => f.label === 'Address / prefix')!.value;
test('invalid prefix scalars or unknown families leave addresses intact without manufacturing CIDR suffixes', () => {
    for (const family of ['inet', 'inet6'])
        for (const value of [
            true,
            false,
            null,
            [],
            {},
            -1,
            1.5,
            '-1',
            '+1',
            '24junk',
            '1e1',
            '1.5',
            'Infinity',
            'NaN',
            '9'.repeat(400),
            Number.MAX_SAFE_INTEGER + 1,
            family === 'inet' ? 33 : 129,
        ]) {
            const snapshot = fixture(value, family),
                before = JSON.stringify(snapshot),
                model = lanSummary(snapshot),
                local = family === 'inet6' ? '2001:db8::7' : '192.0.2.7';
            assert.equal(
                model.interfaces[0].groups[0].fields.find((f) => f.label === 'Address / prefix')!
                    .value,
                local,
            );
            assert.ok(
                model.warnings.some((w) => w.includes('address prefix could not be interpreted')),
            );
            assert.ok(model.interfaces[0].groups[1].fields.some((f) => f.value === '192.0.2.8/24'));
            assert.equal(model.interfaces[0].ifindex, 7);
            assert.equal(JSON.stringify(snapshot), before);
        }
    for (const family of ['unknown', 'INET', null, {}, ['inet']]) {
        const snapshot = fixture(0, family);
        assert.equal(address(snapshot), '192.0.2.7');
        assert.ok(lanSummary(snapshot).warnings.length > 0);
    }
    for (const literal of ['1e309', '-1e309'])
        assert.equal(address(fixture('PREFIX_TOKEN', 'inet', literal)), '192.0.2.7');
});
test('family-specific prefix zero and endpoints accept numeric and whole decimal string inputs', () => {
    for (const [family, maximum, local] of [
        ['inet', 32, '192.0.2.7'],
        ['inet6', 128, '2001:db8::7'],
    ] as const)
        for (const value of [0, maximum, String(0), String(maximum), '000']) {
            const snapshot = fixture(value, family),
                before = JSON.stringify(snapshot),
                model = lanSummary(snapshot);
            assert.equal(address(snapshot), local + '/' + Number(value));
            assert.deepEqual(model.warnings, []);
            assert.equal(JSON.stringify(snapshot), before);
        }
    const missing = fixture(undefined);
    assert.equal(address(missing), '192.0.2.7');
    assert.deepEqual(lanSummary(missing).warnings, []);
    assert.equal(
        address(fixture(1e1)),
        '192.0.2.7/10',
        'Numeric JSON value is validated as a number, distinct from a string exponent',
    );
});
