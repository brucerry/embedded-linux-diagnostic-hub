import test from 'node:test';
import assert from 'node:assert/strict';
import { wirelessSummary } from '../shared/diagnostics/network/wireless';
import { parseReport } from '../shared/report';
const at = '2028-02-29T12:00:00Z',
    huge = '9'.repeat(400);
function input(raw: string, link?: string, survey?: string) {
    const probe = (id: string, stdout: string) => ({
        id,
        stdout,
        stderr: '',
        exitCode: 0,
        status: 'collected',
        durationMs: 1,
        collectedAt: at,
        truncated: false,
    });
    const sections = [
        ...(link === undefined
            ? []
            : [
                  {
                      ...probe('link', link),
                      operation: 'iw-link',
                      scope: 'wlan0',
                      source: 'live',
                      command: 'synthetic',
                  },
              ]),
        ...(survey === undefined
            ? []
            : [
                  {
                      ...probe('survey', survey),
                      operation: 'iw-survey',
                      scope: 'wlan0',
                      source: 'live',
                      command: 'synthetic',
                  },
              ]),
    ];
    return parseReport(
        JSON.stringify({
            schemaVersion: 1,
            mode: 'demo',
            endpoint: 'synthetic.invalid',
            username: 'fixture',
            capturedAt: at,
            results: [
                {
                    ...probe('wireless', raw),
                    networkEvidence: { version: 1, sections, omissions: [] },
                },
            ],
        }),
    );
}
const iw = (index = '7', freq = '5180') =>
    'phy#0\n Interface wlan0\n ifindex ' +
    index +
    '\n type managed\n channel 36 (' +
    freq +
    ' MHz), width: 80 MHz\n';
test('wireless numeric overflow stays unknown without false survey noise and preserves raw evidence', () => {
    for (const value of [
        huge,
        '9007199254740993',
        'Infinity',
        'NaN',
        '-5180',
        '+5180',
        '1e309',
        '5180junk',
    ]) {
        const snapshot = input(
            iw(value, value),
            'freq: ' + value + '\n',
            'frequency: ' + value + ' MHz [in use]\nnoise: -95 dBm\n',
        );
        const before = JSON.stringify(snapshot),
            model = wirelessSummary(snapshot),
            iface = model.interfaces[0];
        assert.equal(iface.ifindex, undefined, value);
        assert.equal(iface.frequency, undefined, value);
        assert.equal(iface.noise, undefined, value);
        assert.ok(model.warnings.length > 0);
        assert.equal(JSON.stringify(snapshot), before);
    }
    for (const value of [
        huge,
        '9007199254740993',
        '-2.4',
        '+2.4',
        '1e309',
        'NaN',
        '0.' + '0'.repeat(400) + '1',
    ]) {
        const snapshot = input('wlan0 ESSID: "Lab"\n Frequency: ' + value + ' GHz\n');
        assert.equal(wirelessSummary(snapshot).interfaces[0].frequency, undefined);
    }
});
test('normal inventory/link/legacy readings keep units, signs and original identities', () => {
    const model = wirelessSummary(
        input(
            iw(),
            'freq: 5180  \nsignal: -45 dBm\n',
            'frequency: 5180 MHz [in use]\nnoise: -95 dBm\n',
        ),
    );
    assert.equal(model.interfaces[0].ifindex, 7);
    assert.equal(model.interfaces[0].frequency, 5180);
    assert.equal(model.interfaces[0].noise, '-95 dBm');
    assert.equal(model.interfaces[0].signal, '-45 dBm');
    assert.deepEqual(model.warnings, []);
    for (const [token, expected] of [
        ['2.462 GHz', 2462],
        ['2.462GHz', 2462],
        ['2462 MHz', 2462],
        ['0 MHz', 0],
        ['123.4567 MHz', 123.4567],
    ] as const)
        assert.equal(
            wirelessSummary(input('wlan0 ESSID: "Lab"\n Frequency: ' + token + '\n')).interfaces[0]
                .frequency,
            expected,
        );
    assert.equal(wirelessSummary(input(iw(), 'freq: 2412 MHz\n')).interfaces[0].frequency, 2412);
});
test('malformed explicit identity cannot acquire state through a unique name-only fallback', () => {
    const snapshot = input(iw('9007199254740993'));
    snapshot.results.find((r) => r.id === 'ethernet')!.status = 'collected';
    snapshot.results.find((r) => r.id === 'ethernet')!.exitCode = 0;
    snapshot.results.find((r) => r.id === 'ethernet')!.stdout =
        '/sys/class/net/wlan0/operstate=UP\n/sys/class/net/wlan0/carrier=1\n';
    const iface = wirelessSummary(snapshot).interfaces[0];
    assert.equal(iface.admin, undefined);
    assert.equal(iface.state, undefined);
    assert.equal(iface.carrier, undefined);
});
