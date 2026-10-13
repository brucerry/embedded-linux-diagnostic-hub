import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkCollector } from '../backend/ssh/network';
import { ExecSlots } from '../backend/ssh/exec-budget';
import { shellArgument, validateNetworkEvidence } from '../shared/diagnostics/network/evidence';
import { networkJson } from '../shared/diagnostics/network/json';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { wirelessSummary } from '../shared/diagnostics/network/wireless';
import { probes } from '../shared/diagnostics/probes';
import { createReport, parseReport } from '../shared/report';
import { demoSnapshot } from './fixtures/snapshots';
import type { ProbeResult } from '../shared/types';
const stamp = '2026-10-13T12:00:00Z';
const evidence = (
    id: string,
    stdout: string,
    exitCode: number | null = 0,
    stderr = '',
): ProbeResult => ({
    id,
    stdout,
    stderr,
    exitCode,
    status: exitCode === 0 ? 'collected' : exitCode === 127 ? 'unavailable' : 'error',
    collectedAt: stamp,
    durationMs: 1,
    truncated: false,
});
const iw =
    'phy#0\n\tInterface wlan0\n\t\tifindex 3\n\t\twdev 0x1\n\t\taddr 02:00:00:00:00:01\n\t\tssid <b>Lab</b>\n\t\ttype managed\n\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz\n\t\ttxpower 0.00 dBm\n';
test('wireless collection keeps denied survey, caches capabilities with original timestamps and never scans', async () => {
    const collector = new NetworkCollector(),
        commands: string[] = [];
    const exec = async (
        id: string,
        command: string,
        limits: { timeoutMs: number; maxBytes: number },
    ) => {
        assert.ok(limits.timeoutMs <= 12000 && limits.maxBytes <= 262144);
        commands.push(command);
        if (id === 'wireless') return evidence(id, iw);
        if (id.startsWith('iw-survey')) return evidence(id, '', 1, 'Operation not permitted');
        if (id.startsWith('iw-phy'))
            return evidence(
                id,
                'Wiphy phy0\n\tBand 1:\n\t\tHE Iftypes: managed\n\t\tFrequencies:\n\t\t\t* 5180 MHz [36] (23.0 dBm) (no IR)\n',
            );
        if (id.startsWith('iw-link'))
            return evidence(
                id,
                'Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: <b>Lab</b>\n\tfreq: 5180\n\tsignal: -45 dBm\n\ttx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz VHT-NSS 2\n',
            );
        return evidence(id, '');
    };
    const first = await collector.collect(
        probes.find((p) => p.id === 'wireless')!,
        exec,
    );
    assert.equal(
        first.networkEvidence?.sections.find((s) => s.operation === 'iw-survey')?.status,
        'error',
    );
    const count = commands.filter((c) => c.includes('phy phy0 info')).length;
    const next = await collector.collect(
        probes.find((p) => p.id === 'wireless')!,
        exec,
    );
    assert.equal(commands.filter((c) => c.includes('phy phy0 info')).length, count);
    const cached = next.networkEvidence!.sections.find((s) => s.operation === 'iw-phy')!;
    assert.equal(cached.source, 'cached');
    assert.equal(cached.collectedAt, stamp);
    await collector.collect(
        probes.find((p) => p.id === 'wireless')!,
        exec,
        { forceNetworkCapabilities: true },
    );
    assert.equal(commands.filter((c) => c.includes('phy phy0 info')).length, count + 1);
    assert.ok(commands.every((c) => !/\bscan\b|\bset\b|\bsudo\b/.test(c)));
    const snapshot = demoSnapshot();
    snapshot.results = snapshot.results.map((r) => (r.id === 'wireless' ? first : r));
    const model = wirelessSummary(snapshot);
    assert.equal(model.interfaces[0].ssid, '<b>Lab</b>');
    assert.equal(model.interfaces[0].txPower, '0.00 dBm');
    assert.equal(model.interfaces[0].signal, '-45 dBm');
    assert.equal(model.interfaces[0].noise, undefined);
    assert.ok(
        model.groups.some((g) => g.id === 'channels-phy0' && g.fields[0].value.includes('no IR')),
    );
    assert.deepEqual(
        parseReport(JSON.stringify(createReport(snapshot))).results.find((r) => r.id === 'wireless')
            ?.networkEvidence,
        first.networkEvidence,
    );
});
test('ip format rejection falls back while permission denial does not', async () => {
    for (const denied of [false, true]) {
        const calls: string[] = [];
        const collector = new NetworkCollector();
        const result = await collector.collect(
            probes.find((p) => p.id === 'routes')!,
            async (id, command) => {
                calls.push(id);
                if (id === 'routes') return evidence(id, 'default via 1.2.3.4 dev eth0');
                if (id.includes('json'))
                    return evidence(
                        id,
                        '',
                        1,
                        denied ? 'Permission denied' : 'Option -j is unknown option',
                    );
                return evidence(id, 'default via 1.2.3.4 dev eth0');
            },
        );
        assert.equal(
            calls.some((id) => id.includes('text')),
            !denied,
        );
        assert.equal(result.status, 'collected');
        assert.equal(
            result.networkEvidence!.sections.filter((s) => s.status === 'error').length,
            2,
        );
    }
});
test('safe selector quoting, precision retention and malformed report evidence', () => {
    assert.equal(shellArgument("wl'an;$()"), "'wl'\\''an;$()'");
    for (const name of ['', '-x', 'wl\nfoo', 'a\0b']) assert.throws(() => shellArgument(name));
    const parsed = networkJson(
        '[{"counter":18446744073709551615,"string":"12345678901234567890 \\" x","zero":0}]',
    ) as { counter: string; string: string; zero: number }[];
    assert.equal(parsed[0].counter, '18446744073709551615');
    assert.equal(parsed[0].zero, 0);
    assert.equal(parsed[0].string, '12345678901234567890 " x');
    const section = {
        ...evidence('test', ''),
        operation: 'iw-survey',
        scope: 'wlan0',
        source: 'live',
        command: 'iw dev wlan0 survey dump',
    };
    assert.throws(() =>
        validateNetworkEvidence(
            { version: 1, sections: [section, section], omissions: [] },
            evidence('primary', ''),
        ),
    );
    assert.throws(() =>
        validateNetworkEvidence(
            { version: 1, sections: [{ ...section, exitCode: 1 }], omissions: [] },
            evidence('primary', ''),
        ),
    );
    assert.throws(() =>
        validateNetworkEvidence(
            { version: 1, sections: [{ ...section, stdout: 'x'.repeat(262144) }], omissions: [] },
            evidence('primary', 'x'),
        ),
    );
    assert.throws(() => networkJson('['.repeat(34) + '0' + ']'.repeat(34)));
});
test('LAN preserves UNKNOWN, topology, addresses, multipath, neighbors and exact counters', () => {
    const snapshot = demoSnapshot();
    const lan = snapshot.results.find((r) => r.id === 'ethernet')!;
    lan.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence(
                    'links',
                    '[{"ifindex":7,"ifname":"br-lan","flags":["UP","LOWER_UP"],"operstate":"UNKNOWN","mtu":1500,"link_type":"ether","linkinfo":{"info_kind":"bridge"},"stats64":{"rx":{"bytes":18446744073709551615,"errors":0}}}]',
                ),
                operation: 'ip-link-json',
                scope: 'all',
                source: 'live',
                command: 'ip -j -d -s link show',
            },
            {
                ...evidence(
                    'neighbors',
                    '[{"dst":"192.0.2.1","dev":"br-lan","lladdr":"00:11:22:33:44:55","state":["STALE"]}]',
                ),
                operation: 'ip-neighbor-json',
                scope: 'all',
                source: 'live',
                command: 'ip -j neigh show',
            },
        ],
    };
    const addresses = snapshot.results.find((r) => r.id === 'interfaces')!;
    addresses.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence(
                    'addresses',
                    '[{"ifindex":7,"ifname":"br-lan","addr_info":[{"family":"inet","local":"192.0.2.2","prefixlen":24,"scope":"global","dynamic":true},{"family":"inet6","local":"2001:db8::2","prefixlen":64,"tentative":true}]}]',
                ),
                operation: 'ip-address-json',
                scope: 'all',
                source: 'live',
                command: 'ip -j address show',
            },
        ],
    };
    const routes = snapshot.results.find((r) => r.id === 'routes')!;
    routes.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence(
                    'routes4',
                    '[{"dst":"default","table":100,"multipath":[{"gateway":"192.0.2.1","dev":"br-lan","weight":1},{"gateway":"192.0.2.3","dev":"br-lan","weight":2}]}]',
                ),
                operation: 'ip-route4-json',
                scope: 'IPv4/all tables',
                source: 'live',
                command: 'ip -j -4 route show table all',
            },
        ],
    };
    const model = lanSummary(snapshot),
        iface = model.interfaces.find((i) => i.name === 'br-lan')!;
    assert.equal(iface.state, 'UNKNOWN');
    assert.equal(iface.admin, 'Enabled');
    assert.equal(iface.kind, 'bridge');
    assert.equal(iface.groups.filter((g) => g.id.startsWith('address')).length, 2);
    assert.ok(
        iface.groups
            .find((g) => g.id === 'counters')!
            .fields.some((f) => f.value === '18446744073709551615'),
    );
    assert.ok(
        iface.groups
            .find((g) => g.id.startsWith('neighbor'))!
            .fields.some((f) => f.value === 'STALE'),
    );
    assert.ok(
        model.groups.some((g) =>
            g.fields.some((f) => f.label === 'multipath' && f.value.includes('weight')),
        ),
    );
});
test('survey requires in-use matching frequency and AP empty peer set is valid', () => {
    const snapshot = demoSnapshot(),
        raw = snapshot.results.find((r) => r.id === 'wireless')!;
    raw.stdout = iw.replace('type managed', 'type AP');
    raw.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence('stations', ''),
                operation: 'iw-stations',
                scope: 'wlan0',
                source: 'live',
                command: 'iw dev wlan0 station dump',
            },
            {
                ...evidence(
                    'survey',
                    'Survey data from wlan0\n\tfrequency: 2412 MHz [in use]\n\tnoise: -95 dBm\n\tfrequency: 5180 MHz\n\tnoise: 0 dBm\n',
                ),
                operation: 'iw-survey',
                scope: 'wlan0',
                source: 'live',
                command: 'iw dev wlan0 survey dump',
            },
        ],
    };
    let iface = wirelessSummary(snapshot).interfaces[0];
    assert.equal(iface.association, 'Not applicable to this mode');
    assert.equal(iface.peers, 0);
    assert.equal(iface.noise, undefined);
    raw.networkEvidence.sections[1].stdout = 'frequency: 5180 MHz [in use]\nnoise: 0 dBm\n';
    iface = wirelessSummary(snapshot).interfaces[0];
    assert.equal(iface.noise, '0 dBm');
});
test('session exec slots never exceed three concurrent jobs', async () => {
    const slots = new ExecSlots();
    let active = 0,
        max = 0;
    await Promise.all(
        Array.from({ length: 12 }, () =>
            slots.run(async () => {
                active++;
                max = Math.max(max, active);
                await new Promise<void>((r) => setImmediate(r));
                active--;
            }),
        ),
    );
    assert.equal(max, 3);
    assert.equal(active, 0);
});
test('upstream MLO link blocks stay separate without an invented aggregate channel or signal', () => {
    const snapshot = demoSnapshot(),
        wireless = snapshot.results.find((r) => r.id === 'wireless')!;
    wireless.stdout =
        'phy#0\n\tInterface wlan0\n\t\tifindex 3\n\t\ttype managed\n\t\tssid 海岸 lab\n\t\tMLD with links:\n\t\t - link ID  0 link addr 02:00:00:00:00:01\n\t\t channel 36 (5180 MHz), width: 80 MHz\n\t\t txpower 23.00 dBm\n\t\t - link ID  1 link addr 02:00:00:00:00:02\n\t\t channel 5 (5975 MHz), width: 160 MHz\n\t\t txpower 18.00 dBm\n';
    wireless.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence(
                    'mlo-station',
                    'Station 00:11:22:33:44:55 (on wlan0)\n\tLink 0:\n\t\taddress: 02:00:00:00:00:01\n\t\tsignal: -45 dBm\n\tLink 1:\n\t\taddress: 02:00:00:00:00:02\n\t\tsignal: -65 dBm\n',
                ),
                operation: 'iw-stations',
                scope: 'wlan0',
                source: 'live',
                command: 'iw dev wlan0 station dump',
            },
        ],
    };
    const iface = wirelessSummary(snapshot).interfaces[0];
    assert.equal(iface.ssid, '海岸 lab');
    assert.equal(iface.frequency, undefined);
    assert.equal(iface.txPower, undefined);
    assert.equal(iface.signal, undefined);
    assert.equal(iface.groups.filter((g) => g.id.startsWith('radio-link-')).length, 2);
    assert.ok(
        iface.groups.some(
            (g) => g.title.includes('link 0') && g.fields.some((f) => f.value === '-45 dBm'),
        ),
    );
    assert.ok(
        iface.groups.some(
            (g) => g.title.includes('link 1') && g.fields.some((f) => f.value === '-65 dBm'),
        ),
    );
});
test('exec queue cancellation removes work instead of executing it later', async () => {
    const slots = new ExecSlots();
    let release!: () => void;
    const held = new Promise<void>((r) => {
        release = r;
    });
    const running = [slots.run(() => held), slots.run(() => held), slots.run(() => held)];
    const abort = new AbortController();
    let started = false;
    const queued = slots.run(
        async () => {
            started = true;
        },
        { signal: abort.signal },
    );
    abort.abort();
    await assert.rejects(queued, /cancelled/);
    await assert.rejects(
        slots.run(
            async () => {
                started = true;
            },
            { timeoutMs: 10 },
        ),
        /timed out/,
    );
    release();
    await Promise.all(running);
    assert.equal(started, false);
});
test('budget exhaustion records omitted operations without synthetic executions', async () => {
    const collector = new NetworkCollector();
    let calls = 0;
    const result = await collector.collect(
        probes.find((p) => p.id === 'ethernet')!,
        async (id) => {
            calls++;
            return evidence(id, 'x'.repeat(262144));
        },
    );
    assert.equal(calls, 1);
    assert.equal(result.networkEvidence!.sections.length, 0);
    assert.ok(result.networkEvidence!.omissions.every((o) => o.reason.includes('budget')));
});

test('frequency changes do not combine old channel/width/power with a new link observation', () => {
    const snapshot = demoSnapshot(),
        wireless = snapshot.results.find((r) => r.id === 'wireless')!;
    wireless.stdout = iw;
    wireless.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence(
                    'link',
                    'Connected to 02:00:00:00:00:02\n\tSSID: changed\n\tfreq: 2412\n\tsignal: -40 dBm',
                ),
                operation: 'iw-link',
                scope: 'wlan0',
                source: 'live',
                command: 'iw dev wlan0 link',
            },
        ],
    };
    const model = wirelessSummary(snapshot),
        iface = model.interfaces[0];
    assert.equal(iface.frequency, 2412);
    assert.equal(iface.channel, undefined);
    assert.equal(iface.width, undefined);
    assert.equal(iface.txPower, undefined);
    assert.match(model.warnings.join(' '), /changed between reads/);
});

test('reduced iwinfo/procfs fallback and failed primary sources never invent modern radio fields', () => {
    const snapshot = demoSnapshot(),
        wireless = snapshot.results.find((r) => r.id === 'wireless')!;
    wireless.stdout =
        'wlan0 ESSID: "Lab network"\n    Mode: Master  Channel: 11 (2.462 GHz)\n    Tx-Power: 17 dBm  Signal: -50 dBm\n';
    wireless.status = 'collected';
    const info = wirelessSummary(snapshot);
    assert.equal(info.interfaces[0].mode, 'Master');
    assert.equal(info.interfaces[0].channel, '11');
    assert.equal(info.interfaces[0].signal, '-50 dBm');
    assert.equal(info.interfaces[0].noise, undefined);
    assert.match(info.warnings.join(' '), /Reduced/);
    wireless.stdout = 'Inter-| sta-| Quality\n wlan0: 0000 70. -50. -90. 0 0 0\n';
    const proc = wirelessSummary(snapshot);
    assert.equal(proc.interfaces[0].signal, undefined);
    assert.equal(proc.interfaces[0].noise, undefined);
    assert.ok(proc.interfaces[0].groups[0].fields.some((f) => f.label.includes('driver units')));
    wireless.stdout = iw;
    wireless.status = 'error';
    assert.equal(wirelessSummary(snapshot).interfaces.length, 0);
    const ethernet = snapshot.results.find((r) => r.id === 'ethernet')!;
    ethernet.status = 'error';
    snapshot.results = snapshot.results.filter((r) => ['wireless', 'ethernet'].includes(r.id));
    assert.equal(lanSummary(snapshot).interfaces.length, 0);
});

test('PHY details retain interface combinations and DFS/CAC under their channel scope', () => {
    const snapshot = demoSnapshot(),
        wireless = snapshot.results.find((r) => r.id === 'wireless')!;
    wireless.stdout = iw;
    wireless.networkEvidence = {
        version: 1,
        omissions: [],
        sections: [
            {
                ...evidence(
                    'phy',
                    'Wiphy phy0\n\tSupported interface modes:\n\t\t* managed\n\t\t* monitor\n\tvalid interface combinations:\n\t\t* #{ managed } <= 1, #{ AP } <= 1,\n\t\t  total <= 2, #channels <= 1\n\tBand 1:\n\t\tVHT Capabilities (0x0):\n\t\tHE Iftypes: managed\n\t\t\tHE MAC Capabilities: 0x01\n\t\tEHT Iftypes: AP\n\t\t\tEHT PHY Capabilities: 0x02\n\t\tFrequencies:\n\t\t\t* 5260 MHz [52] (20.0 dBm) (radar detection)\n\t\t\t  DFS state: usable\n\t\t\t  DFS CAC time: 60000 ms',
                ),
                operation: 'iw-phy',
                scope: 'phy0',
                source: 'live',
                command: 'iw phy phy0 info',
            },
        ],
    };
    const model = wirelessSummary(snapshot),
        cap = model.groups.find((g) => g.id === 'cap-phy0')!,
        channels = model.groups.find((g) => g.id === 'channels-phy0')!;
    assert.ok(cap.fields.some((f) => f.value.includes('#{ managed }')));
    assert.ok(cap.fields.some((f) => f.label.includes('HE managed')));
    assert.ok(cap.fields.some((f) => f.label.includes('EHT AP')));
    assert.match(channels.fields[0].value, /DFS state: usable/);
    assert.match(channels.fields[0].value, /60000 ms/);
    for (const mode of ['managed', 'AP', 'mesh point', 'monitor']) {
        wireless.stdout = iw.replace('type managed', 'type ' + mode);
        const iface = wirelessSummary(snapshot).interfaces[0];
        assert.equal(iface.mode, mode);
        if (mode !== 'managed') assert.equal(iface.association, 'Not applicable to this mode');
    }
});
