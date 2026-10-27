import type { Snapshot, ProbeResult } from '../../types';
import { lanSummary } from './lan';
import {
    field,
    group,
    result,
    section,
    parseWarnings,
    type InterfaceSummary,
    type NetworkSummary,
    type DetailField,
} from './model';
export function wirelessInventory(output: string): InterfaceSummary[] {
    const interfaces: InterfaceSummary[] = [];
    let phy: string | undefined,
        iface: InterfaceSummary | undefined,
        link: import('./model').DetailGroup | undefined;
    for (const line of output.split('\n')) {
        const p = line.match(/^phy#(\d+)/),
            i = line.match(/^\s*Interface\s+(.+)$/);
        if (p) {
            phy = 'phy' + p[1];
            iface = undefined;
            link = undefined;
            continue;
        }
        if (i) {
            iface = {
                id: (phy ?? 'unknown') + '/' + i[1].trim(),
                name: i[1].trim(),
                phy,
                kind: 'Wi-Fi',
                groups: [],
            };
            interfaces.push(iface);
            link = undefined;
            continue;
        }
        if (!iface) continue;
        if (/MLD with links:/.test(line)) {
            iface.frequency = undefined;
            iface.channel = undefined;
            iface.width = undefined;
            iface.txPower = undefined;
            continue;
        }
        const marker =
            line.match(/^\s*-\s*link(?:\s+ID\s+(\d+))?(.*)$/i) ??
            line.match(/^\s*link\[(\d+)\](.*)$/i);
        if (marker) {
            link = group(
                'radio-link-' + (marker[1] ?? iface.groups.length),
                'Radio link ' + (marker[1] ?? 'identity not reported'),
                field('Link identity', line.trim()),
            );
            iface.groups.push(link);
            continue;
        }
        const m = line.trim().match(/^(ifindex|wdev|addr|ssid|type|channel|txpower)\s+(.*)$/);
        if (!m) continue;
        const value = m[2];
        if (!link) {
            if (m[1] === 'ifindex' && /^\d+$/.test(value)) iface.ifindex = Number(value);
            if (m[1] === 'addr') iface.mac = value;
            if (m[1] === 'ssid') iface.ssid = value;
            if (m[1] === 'type') iface.mode = value;
            if (m[1] === 'txpower') iface.txPower = value;
            if (m[1] === 'channel') {
                iface.channel = value.match(/^(\d+)/)?.[1];
                const f = value.match(/\((\d+) MHz\)/)?.[1];
                if (f) iface.frequency = Number(f);
                iface.width = value.match(/width:\s*([^,]+)/)?.[1];
            }
        }
        const detail =
            link ??
            iface.groups.find((g) => g.id === 'interface') ??
            group('interface', 'Current radio/interface', []);
        detail.fields.push(...field(m[1], value));
        if (!iface.groups.includes(detail)) iface.groups.unshift(detail);
    }
    return interfaces.slice(0, 128);
}

function legacyInventory(output: string): InterfaceSummary[] {
    const entries: InterfaceSummary[] = [];
    let current: InterfaceSummary | undefined,
        block = '';
    const finish = () => {
        if (!current) return;
        current.groups.push(group('legacy', 'Reduced iwinfo observations', lineFields(block)));
        entries.push(current);
    };
    for (const line of output.split('\n')) {
        const header = line.match(/^(\S+)\s+ESSID:\s*"(.*)"/);
        if (header) {
            finish();
            current = {
                id: 'legacy/' + header[1],
                name: header[1],
                ssid: header[2],
                kind: 'Wi-Fi (iwinfo)',
                groups: [],
            };
            block = '';
        }
        if (!current) continue;
        block += line + '\n';
        current.mode = line.match(/\bMode:\s*(\S+)/)?.[1] ?? current.mode;
        current.channel = line.match(/\bChannel:\s*(\d+)/)?.[1] ?? current.channel;
        const frequency = line.match(/\bFrequency:\s*(\d+(?:\.\d+)?)\s*(GHz|MHz)/);
        if (frequency)
            current.frequency = Number(frequency[1]) * (frequency[2] === 'GHz' ? 1000 : 1);
        current.txPower = line.match(/Tx-Power:\s*(-?\d+(?:\.\d+)?\s*dBm)/)?.[1] ?? current.txPower;
        current.signal = line.match(/Signal:\s*(-?\d+(?:\.\d+)?\s*dBm)/)?.[1] ?? current.signal;
    }
    finish();
    if (entries.length) return entries.slice(0, 128);
    for (const m of output.matchAll(
        /^\s*([^\s:]+):\s*([\da-f]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/gim,
    ))
        entries.push({
            id: 'proc/' + m[1],
            name: m[1],
            kind: 'Wi-Fi (procfs)',
            groups: [
                group('proc-wireless', 'Reduced driver observations (units not established)', [
                    ...field('Driver status', m[2]),
                    ...field('Link quality (driver units)', m[3]),
                    ...field('Signal level (driver units)', m[4]),
                    ...field('Noise level (driver units)', m[5]),
                ]),
            ],
        });
    return entries.slice(0, 128);
}

export function wirelessSummary(snapshot: Snapshot): NetworkSummary {
    const raw = result(snapshot, 'wireless'),
        warnings: string[] = [];
    const interfaces = raw?.status === 'collected' ? wirelessInventory(raw.stdout) : [];
    if (!interfaces.length && raw?.status === 'collected') {
        interfaces.push(...legacyInventory(raw.stdout));
        if (interfaces.length)
            warnings.push(
                'Reduced fallback observations; iw PHY capability and current-channel noise are unavailable.',
            );
    }
    const groups = [];
    const links = lanSummary(snapshot).interfaces;
    for (const iface of interfaces) {
        const link = links.find(
            (i) =>
                i.name === iface.name &&
                (i.ifindex === undefined ||
                    iface.ifindex === undefined ||
                    i.ifindex === iface.ifindex),
        );
        if (link) {
            iface.admin = link.admin;
            iface.carrier = link.carrier;
            iface.state = link.state;
        }
        if (raw) for (const detail of iface.groups) detail.source = raw.collectedAt;
        iface.association = /^(AP|Master|AP\/VLAN|monitor|mesh point|P2P-GO)$/i.test(
            iface.mode ?? '',
        )
            ? 'Not applicable to this mode'
            : 'Not reported';
        const connection = section(snapshot, 'wireless', 'iw-link').find(
            (r) => r.scope === iface.name && r.status === 'collected',
        );
        if (connection) {
            const connected = connection.stdout.match(/^Connected to\s+(\S+)/m);
            const multi =
                /\bMLD\b|^\s*Link \d+:/m.test(connection.stdout) ||
                iface.groups.some((g) => g.id.startsWith('radio-link-'));
            iface.association = connected
                ? multi
                    ? 'Associated (multi-link)'
                    : 'Associated'
                : /Not connected\./.test(connection.stdout)
                  ? 'Not associated'
                  : 'Not reported';
            iface.bssid = multi ? undefined : connected?.[1];
            iface.ssid = connection.stdout.match(/^\s*SSID:\s*(.*)$/m)?.[1] ?? iface.ssid;
            const frequency = connection.stdout.match(/^\s*freq:\s*(\d+)/m)?.[1];
            if (frequency && !multi) {
                if (iface.frequency !== undefined && iface.frequency !== Number(frequency)) {
                    iface.channel = undefined;
                    iface.width = undefined;
                    iface.txPower = undefined;
                    warnings.push(
                        iface.name +
                            ': inventory and link frequencies changed between reads; channel/width/power are not merged.',
                    );
                }
                iface.frequency = Number(frequency);
            }
            if (!multi)
                iface.signal = connection.stdout.match(
                    /^\s*signal:\s*(-?\d+(?:\.\d+)?\s*dBm)/m,
                )?.[1];
            iface.groups.push(
                group(
                    'connection',
                    'Current association / reported PHY rate',
                    lineFields(connection.stdout),
                    connection,
                ),
            );
        }
        const stations = section(snapshot, 'wireless', 'iw-stations').find(
            (r) => r.scope === iface.name && r.status === 'collected',
        );
        if (stations) {
            let fields: DetailField[] | undefined,
                title = '',
                index = 0;
            const finish = () => {
                if (fields)
                    iface.groups.push(
                        group(
                            'peer-' + index++,
                            'Peer ' + title + ' / reported PHY rates',
                            fields!,
                            stations,
                        ),
                    );
            };
            for (const line of stations.stdout.split('\n')) {
                const peer = line.match(/^Station\s+(\S+)(.*)$/);
                if (peer) {
                    finish();
                    title = peer[1];
                    fields = [...field('Peer', peer[1]), ...field('Interface', iface.name)];
                } else if (fields) {
                    const marker = line.match(
                        /^\s*(?:Link\s+(\d+):|link\s*ID|link\s*id|link\[(\d+)\])\s*:?\s*(.*)$/i,
                    );
                    if (marker) {
                        finish();
                        title =
                            title.split(' / link ')[0] +
                            ' / link ' +
                            (marker[1] ?? marker[2] ?? marker[3]);
                        fields = [...field('Link identity', line.trim())];
                    } else fields.push(...lineFields(line));
                }
            }
            finish();
            iface.peers = (stations.stdout.match(/^Station\s+/gm) ?? []).length;
            if (
                !iface.signal &&
                iface.mode === 'managed' &&
                !/^\s*Link \d+:/m.test(stations.stdout) &&
                !iface.groups.some((g) => g.id.startsWith('radio-link-'))
            )
                iface.signal = stations.stdout.match(/^\s*signal:\s*(.*dBm)/m)?.[1];
        }
        const survey = section(snapshot, 'wireless', 'iw-survey').find(
            (r) => r.scope === iface.name && r.status === 'collected',
        );
        if (survey) {
            const blocks = survey.stdout
                .split(/(?=^\s*frequency:)/m)
                .filter((b) => /^\s*frequency:/m.test(b));
            const current = blocks.filter(
                (b) =>
                    /\[in use\]/.test(b) &&
                    Number(b.match(/frequency:\s*(\d+)/)?.[1]) === iface.frequency,
            );
            if (current.length === 1)
                iface.noise = current[0].match(/noise:\s*(-?\d+(?:\.\d+)?\s*dBm)/)?.[1];
            for (const [index, block] of blocks.entries())
                iface.groups.push(
                    group(
                        'survey-' + index,
                        'Survey ' + (block.match(/frequency:\s*(.*)/)?.[1] ?? ''),
                        lineFields(block),
                        survey,
                    ),
                );
        }
        const power = section(snapshot, 'wireless', 'iw-power-save').find(
            (r) => r.scope === iface.name && r.status === 'collected',
        );
        if (power)
            iface.groups.push(group('power-save', 'Power saving', lineFields(power.stdout), power));
    }
    for (const r of section(snapshot, 'wireless', 'iw-phy').filter(
        (r) => r.status === 'collected',
    )) {
        const capability: DetailField[] = [],
            channels: DetailField[] = [];
        let band = '',
            scope = '',
            capabilityBlock = '';
        for (const line of r.stdout.split('\n')) {
            const b = line.match(/^\s*(Band\s+\d+):/);
            if (b) {
                band = b[1];
                scope = '';
            }
            const s = line.match(/^\s*(HE|EHT) Iftypes:\s*(.*)/);
            if (s) scope = s[1] + ' ' + s[2];
            if (/^\s*(Supported interface modes|valid interface combinations):/i.test(line))
                capabilityBlock = line.trim();
            else if (
                /^\s*[A-Za-z].*:$/.test(line) &&
                !/Iftypes|Capabilities|MCS|Frequencies/.test(line)
            )
                capabilityBlock = '';
            if (/^\s*DFS (state|CAC time):/.test(line) && channels.length)
                channels[channels.length - 1].value += '; ' + line.trim();
            const channel = line.match(/^\s*\*\s+(\d+) MHz\s+\[(\d+)\]\s*(.*)$/);
            if (channel)
                channels.push({
                    label: band + ' · channel ' + channel[2] + ' · ' + channel[1] + ' MHz',
                    value: channel[3] || 'Listed; availability not established',
                });
            else if (
                (capabilityBlock && /^\s*[\*#]/.test(line)) ||
                /supported interface modes|valid interface combinations|Capabilities|\bVHT\b|HT20|HT40|SGI|STBC|LDPC|AMSDU|AMPDU|HE Iftypes|EHT Iftypes|MCS|NSS|MHz|\* (managed|AP|monitor|mesh|P2P)|max.*(streams|interfaces)/i.test(
                    line,
                )
            )
                capability.push({
                    label: [band, scope, capabilityBlock].filter(Boolean).join(' · ') || 'Radio',
                    value: line.trim(),
                });
        }
        groups.push(group('cap-' + r.scope, 'Capabilities · ' + r.scope, capability, r));
        if (channels.length)
            groups.push(
                group('channels-' + r.scope, 'Channels and restrictions · ' + r.scope, channels, r),
            );
        if (!capability.length && !channels.length)
            warnings.push(r.scope + ': capability text is unrecognized; inspect raw evidence.');
    }
    for (const r of section(snapshot, 'wireless', 'iw-regulatory').filter(
        (r) => r.status === 'collected',
    ))
        groups.push(
            group(
                'regulatory',
                'Regulatory domains / rules (global and PHY scopes)',
                field('Reported rules', r.stdout),
                r,
            ),
        );
    const version = section(snapshot, 'wireless', 'iw-version').find(
        (r) => r.status === 'collected',
    );
    if (version)
        groups.push(
            group('iw-version', 'Tool version', field('iw', version.stdout.trim()), version),
        );
    if (!interfaces.length && raw?.stdout.trim())
        groups.push(
            group(
                'wireless-legacy',
                'Wireless fallback / unrecognized inventory',
                field('Reported evidence', raw.stdout),
                raw,
            ),
        );
    return { interfaces, groups, warnings: parseWarnings(warnings) };
}
function lineFields(output: string): DetailField[] {
    return output
        .split('\n')
        .flatMap((line) => {
            const match = line.match(/^\s*([^:]+):\s*(.*)$/);
            return match
                ? [{ label: match[1].trim(), value: match[2].trim() }]
                : line.trim()
                  ? [{ label: 'Reported detail', value: line.trim() }]
                  : [];
        })
        .slice(0, 2000);
}
