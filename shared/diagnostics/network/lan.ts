import type { Snapshot, ProbeResult } from '../../types';
import { decimal, records } from './json';
import {
    field,
    group,
    result,
    section,
    safeNumber,
    parseWarnings,
    type DetailField,
    type InterfaceSummary,
    type NetworkSummary,
} from './model';

function obj(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
const text = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
function flags(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
}
export function lanSummary(snapshot: Snapshot): NetworkSummary {
    const interfaces = new Map<string, InterfaceSummary>();
    const warnings: string[] = [];
    const ensure = (name: string, index?: number) => {
        let iface = interfaces.get(name);
        if (
            iface &&
            index !== undefined &&
            iface.ifindex !== undefined &&
            index !== iface.ifindex
        ) {
            warnings.push(
                name +
                    ': interface identity changed during collection; conflicting records kept separate.',
            );
            const key = name + '#' + index;
            iface = interfaces.get(key);
            if (!iface) {
                iface = { id: key, name, ifindex: index, kind: 'Unclassified', groups: [] };
                interfaces.set(key, iface);
            }
            return iface;
        }
        if (!iface) {
            iface = { id: name, name, ifindex: index, kind: 'Unclassified', groups: [] };
            interfaces.set(name, iface);
        }
        if (index !== undefined) iface.ifindex = index;
        return iface;
    };
    const lan = result(snapshot, 'ethernet');
    if (lan?.status === 'collected') {
        const values = new Map<string, DetailField[]>();
        for (const m of lan.stdout.matchAll(/^\/sys\/class\/net\/([^/]+)\/(.+)=(.*)$/gm)) {
            const iface = ensure(m[1]);
            if (m[2] === 'operstate') iface.state = m[3];
            if (m[2] === 'carrier')
                iface.carrier = m[3] === '1' ? 'Present' : m[3] === '0' ? 'Absent' : m[3];
            const fields = values.get(m[1]) ?? [];
            fields.push({ label: m[2].replace('statistics/', ''), value: m[3] });
            values.set(m[1], fields);
        }
        for (const [name, fields] of values)
            ensure(name).groups.push(
                group('sysfs', 'Kernel link attributes / cumulative counters', fields, lan),
            );
    }
    const readRecords = (r: ProbeResult): Record<string, unknown>[] => {
        try {
            return records(r.stdout);
        } catch {
            warnings.push(
                'Some ' + r.id + ' JSON could not be interpreted; raw evidence is retained.',
            );
            return [];
        }
    };
    const links = section(snapshot, 'ethernet', 'ip-link-json').filter(
        (r) => r.status === 'collected',
    );
    for (const r of links)
        for (const record of readRecords(r)) {
            if (typeof record.ifname !== 'string') continue;
            const iface = ensure(record.ifname, safeNumber(record.ifindex));
            const f = flags(record.flags),
                info = obj(record.linkinfo),
                data = obj(info.info_data);
            if (Array.isArray(record.flags))
                iface.admin = f.includes('UP') ? 'Enabled' : 'Disabled';
            iface.carrier =
                record.carrier !== undefined
                    ? record.carrier === 1
                        ? 'Present'
                        : record.carrier === 0
                          ? 'Absent'
                          : String(record.carrier)
                    : f.includes('LOWER_UP')
                      ? 'Present'
                      : f.includes('NO-CARRIER')
                        ? 'Absent'
                        : iface.carrier;
            iface.state = text(record.operstate) ?? iface.state;
            iface.mac = text(record.address);
            iface.mtu = text(record.mtu);
            iface.kind =
                text(info.info_kind) ??
                (record.link_type === 'loopback' ? 'Loopback' : 'Unclassified');
            const counters: DetailField[] = [];
            for (const [direction, stats] of Object.entries(obj(record.stats64 ?? record.stats))) {
                for (const [name, value] of Object.entries(obj(stats))) {
                    const count = decimal(value);
                    if (count !== undefined)
                        counters.push({
                            label:
                                direction +
                                ' ' +
                                name +
                                (name === 'bytes' ? ' (bytes)' : ' (count)'),
                            value: count,
                        });
                }
            }
            iface.groups.push(
                group(
                    'link',
                    'Link and topology',
                    [
                        ...field('Interface index', record.ifindex),
                        ...field('Type', record.link_type),
                        ...field('Kind', iface.kind),
                        ...field('Flags', record.flags),
                        ...field('Master', record.master),
                        ...field('Lower link index', record.link_index),
                        ...field('Lower link', record.link),
                        ...field('MTU', record.mtu),
                        ...field('Queue discipline', record.qdisc),
                        ...Object.entries(data).flatMap(([key, value]) =>
                            typeof value === 'string' || typeof value === 'number'
                                ? field(key, value)
                                : [],
                        ),
                    ],
                    r,
                ),
            );
            if (counters.length)
                iface.groups.push(group('counters', 'Cumulative kernel counters', counters, r));
        }
    const legacy = result(snapshot, 'interfaces');
    const addressSections = section(snapshot, 'interfaces', 'ip-address-json').filter(
        (r) => r.status === 'collected',
    );
    if (addressSections.length) {
        for (const r of addressSections)
            for (const record of readRecords(r)) {
                if (typeof record.ifname !== 'string') continue;
                const iface = ensure(record.ifname, safeNumber(record.ifindex));
                if (!iface.mac) iface.mac = text(record.address);
                if (!iface.mtu) iface.mtu = text(record.mtu);
                if (!iface.admin && Array.isArray(record.flags))
                    iface.admin = flags(record.flags).includes('UP') ? 'Enabled' : 'Disabled';
                if (!iface.state) iface.state = text(record.operstate);
                for (const [index, address] of (Array.isArray(record.addr_info)
                    ? record.addr_info
                    : []
                ).entries()) {
                    const a = obj(address);
                    iface.groups.push(
                        group(
                            'address-' + index,
                            'Address ' + (text(a.local) ?? ''),
                            [
                                ...field('Family', a.family),
                                ...field(
                                    'Address / prefix',
                                    text(a.local) !== undefined
                                        ? text(a.local) +
                                              (a.prefixlen !== undefined ? '/' + a.prefixlen : '')
                                        : undefined,
                                ),
                                ...field('Scope', a.scope),
                                ...field('Label', a.label),
                                ...field('Peer', a.peer),
                                ...field('Broadcast', a.broadcast),
                                ...field('Valid lifetime', a.valid_life_time),
                                ...field('Preferred lifetime', a.preferred_life_time),
                                ...field('Flags', a.flags),
                                ...[
                                    'dynamic',
                                    'tentative',
                                    'dadfailed',
                                    'deprecated',
                                    'temporary',
                                    'secondary',
                                ].flatMap((k) => field(k, a[k])),
                            ],
                            r,
                        ),
                    );
                }
            }
    } else if (legacy) {
        let iface: InterfaceSummary | undefined;
        for (const line of legacy.stdout.split('\n')) {
            const header = line.match(
                /^\d+:\s+([^:]+):\s*<(.*?)>.*?mtu\s+(\d+).*?(?:state\s+(\S+))?/,
            );
            const simple = line.match(/^\d+:\s+([^:]+):/);
            const ifconfig = line.match(/^(\S+?)(?::\s+flags=|\s+Link encap:)/);
            if (simple || ifconfig) {
                iface = ensure((simple?.[1] ?? ifconfig![1]).replace(/@.*$/, ''));
                if (header) {
                    iface.admin = header[2].split(',').includes('UP') ? 'Enabled' : 'Disabled';
                    iface.mtu = header[3];
                }
                const state = line.match(/\bstate\s+(\S+)/);
                if (state) iface.state = state[1];
            } else if (iface && /^\s*(inet6? |inet addr:)/.test(line)) {
                iface.groups.push(
                    group(
                        'legacy-address-' + iface.groups.length,
                        'Address (legacy text)',
                        field('Reported address', line.trim()),
                        legacy,
                    ),
                );
            }
        }
    }
    if (!links.length) {
        for (const r of section(snapshot, 'ethernet', 'ip-link-text').filter(
            (r) => r.status === 'collected',
        )) {
            let iface: InterfaceSummary | undefined;
            for (const line of r.stdout.split('\n')) {
                const m = line.match(/^(\d+):\s+([^:]+):\s+<(.*?)>/);
                if (m) {
                    iface = ensure(m[2].replace(/@.*$/, ''), Number(m[1]));
                    iface.admin = m[3].split(',').includes('UP') ? 'Enabled' : 'Disabled';
                    iface.carrier = m[3].includes('LOWER_UP')
                        ? 'Present'
                        : m[3].includes('NO-CARRIER')
                          ? 'Absent'
                          : iface.carrier;
                    iface.state = line.match(/\bstate\s+(\S+)/)?.[1] ?? iface.state;
                    iface.mtu = line.match(/\bmtu\s+(\d+)/)?.[1] ?? iface.mtu;
                    iface.groups.push(
                        group('link-text', 'Link (legacy text)', field('Reported link', line), r),
                    );
                } else if (iface && line.trim())
                    iface.groups.at(-1)!.fields.push(...field('Detail', line.trim()));
            }
        }
    }
    for (const r of section(snapshot, 'ethernet', 'ethtool').filter(
        (r) => r.status === 'collected',
    )) {
        const iface = ensure(r.scope);
        const fields: DetailField[] = [];
        let current: DetailField | undefined;
        for (const line of r.stdout.split('\n')) {
            const m = line.match(/^\s*([^:]+):\s*(.*)$/);
            if (m) {
                current = { label: m[1].trim(), value: m[2].trim() };
                fields.push(current);
            } else if (current && line.trim()) current.value += ' ' + line.trim();
        }
        iface.groups.push(
            group('physical', 'Optional Ethernet settings / supported modes', fields, r),
        );
    }
    const groups = [];
    const routes = result(snapshot, 'routes');
    const routeSections = [
        ...section(snapshot, 'routes', 'ip-route4-json'),
        ...section(snapshot, 'routes', 'ip-route6-json'),
    ].filter((r) => r.status === 'collected');
    for (const r of routeSections) {
        for (const [index, record] of readRecords(r).entries()) {
            const fields = Object.entries(record).flatMap(([key, value]) =>
                key === 'multipath' || key === 'nexthops'
                    ? [{ label: key, value: JSON.stringify(value) }]
                    : typeof value === 'string' || typeof value === 'number'
                      ? field(key, value)
                      : field(key, Array.isArray(value) ? value : undefined),
            );
            fields.unshift(...field('Family / collection scope', r.scope));
            groups.push(
                group(
                    'route-' + r.id + '-' + index,
                    'Route ' + (text(record.dst) ?? 'default'),
                    fields,
                    r,
                ),
            );
        }
    }
    for (const r of [
        ...section(snapshot, 'routes', 'ip-route4-text'),
        ...section(snapshot, 'routes', 'ip-route6-text'),
    ].filter((r) => r.status === 'collected'))
        groups.push(
            group(
                'routes-' + r.id,
                'Routes (' + r.scope + ')',
                field('Reported routes', r.stdout),
                r,
            ),
        );
    if (!routeSections.length && routes)
        groups.push(
            group(
                'routes-legacy',
                'IPv4 routes (legacy scope)',
                field('Reported routes', routes.stdout),
                routes,
            ),
        );
    for (const r of section(snapshot, 'ethernet', 'ip-neighbor-json').filter(
        (r) => r.status === 'collected',
    )) {
        for (const [index, record] of readRecords(r).entries()) {
            const iface = typeof record.dev === 'string' ? ensure(record.dev) : undefined;
            const detail = group(
                'neighbor-' + index,
                'Neighbor ' + (text(record.dst) ?? ''),
                [
                    ...field('Destination', record.dst),
                    ...field('Device', record.dev),
                    ...field('MAC', record.lladdr),
                    ...field('NUD state', record.state),
                    ...field('Flags', record.flags),
                ],
                r,
            );
            if (iface) iface.groups.push(detail);
            else groups.push(detail);
        }
    }
    for (const r of section(snapshot, 'ethernet', 'ip-neighbor-text').filter(
        (r) => r.status === 'collected',
    ))
        groups.push(
            group(
                'neighbors-text',
                'Neighbors (legacy text)',
                field('Reported neighbors', r.stdout),
                r,
            ),
        );
    return { interfaces: [...interfaces.values()], groups, warnings: parseWarnings(warnings) };
}
