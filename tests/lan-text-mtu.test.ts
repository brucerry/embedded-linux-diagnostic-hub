import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../shared/report';
import { lanSummary } from '../shared/diagnostics/network/lan';
const at = '2028-02-29T12:00:00Z';
function fixture(token: string, optional: boolean, spacing = ' ', ending = '\n') {
    const line =
        '7: eth0: <UP,LOWER_UP>' +
        spacing +
        'mtu' +
        spacing +
        token +
        spacing +
        'state UP' +
        ending;
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
                    ...probe('ethernet'),
                    ...(optional
                        ? {
                              networkEvidence: {
                                  version: 1,
                                  sections: [
                                      {
                                          ...probe('links', line),
                                          operation: 'ip-link-text',
                                          scope: 'all',
                                          source: 'live',
                                          command: 'synthetic',
                                      },
                                  ],
                                  omissions: [],
                              },
                          }
                        : {}),
                },
                probe('interfaces', optional ? '' : line),
            ],
        }),
    );
}
test('both text MTU paths reject whole malformed tokens while preserving valid flags/state and raw evidence', () => {
    for (const optional of [false, true])
        for (const token of [
            '1e309',
            '1500junk',
            '1500.5',
            '-1500',
            '+1500',
            'Infinity',
            'NaN',
            '1500/24',
            '',
        ]) {
            const snapshot = fixture(token, optional),
                before = JSON.stringify(snapshot),
                model = lanSummary(snapshot),
                iface = model.interfaces[0];
            assert.equal(iface.mtu, undefined, token);
            assert.equal(iface.admin, 'Enabled');
            assert.equal(iface.state, 'UP');
            assert.ok(model.warnings.some((w) => w.includes('MTU could not be interpreted')));
            assert.equal(JSON.stringify(snapshot), before);
        }
});
test('whole decimal MTUs preserve exact text without numeric or hardware bounds across whitespace and CRLF', () => {
    for (const optional of [false, true])
        for (const token of ['1500', '9000', '0', '001500', '9'.repeat(400)])
            for (const spacing of [' ', '\t']) {
                const snapshot = fixture(token, optional, spacing, '\r\n'),
                    before = JSON.stringify(snapshot),
                    model = lanSummary(snapshot);
                assert.equal(model.interfaces[0].mtu, token);
                assert.equal(model.interfaces[0].admin, 'Enabled');
                assert.deepEqual(model.warnings, []);
                assert.equal(JSON.stringify(snapshot), before);
            }
});
test('MTU parsing cannot consume the next line or inherit a prior valid value after an explicit malformed field', () => {
    for (const optional of [false, true]) {
        const snapshot = fixture('1500', optional),
            result = snapshot.results.find((r) => r.id === (optional ? 'ethernet' : 'interfaces'))!;
        const line = '7: eth0: <UP> mtu\n1500 state DOWN\n';
        if (optional) result.networkEvidence!.sections[0].stdout = line;
        else result.stdout = line;
        const model = lanSummary(snapshot);
        assert.equal(model.interfaces[0].mtu, undefined);
        assert.equal(model.interfaces[0].admin, 'Enabled');
        assert.ok(model.warnings.some((w) => w.includes('MTU could not be interpreted')));
    }
    const snapshot = fixture('1500', true),
        result = snapshot.results.find((r) => r.id === 'ethernet')!;
    result.networkEvidence!.sections[0].stdout += '7: eth0: <UP> mtu 1e309 state UP\n';
    assert.equal(lanSummary(snapshot).interfaces[0].mtu, undefined);
    result.networkEvidence!.sections[0].stdout =
        '7: eth0: <UP> mtu 1500 state UP\n7: eth0: <UP> state UP\n';
    assert.equal(
        lanSummary(snapshot).interfaces[0].mtu,
        '1500',
        'A later omitted field does not erase prior explicit evidence',
    );
});
