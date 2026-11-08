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
    typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
        ? String(value)
        : undefined;
function flags(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((flag) => typeof flag === 'string')
        ? value
        : undefined;
}
function addressPrefix(family: unknown, value: unknown): string | undefined {
    const maximum = family === 'inet' ? 32 : family === 'inet6' ? 128 : undefined;
    const length = safeNumber(value);
    return maximum !== undefined && length !== undefined && length <= maximum
        ? String(length)
        : undefined;
}
export function lanSummary(snapshot: Snapshot): NetworkSummary {
    const interfaces = new Map<string, InterfaceSummary>();
    const warnings: string[] = [];
    const invalidIndex = (value: unknown, source: ProbeResult) => {
        if (value === undefined || safeNumber(value) !== undefined) return false;
        warnings.push(
            'Some ' +
                source.id +
                ' interface index could not be interpreted; raw evidence is retained.',
        );
        return true;
    };
    const textMtu = (line: string, source: ProbeResult, previous?: string) => {
        const marker = /(?:^|[ \t])mtu(?=[ \t\r]|$)/.exec(line);
        if (!marker) return previous;
        const token = line
            .slice(marker.index + marker[0].length)
            .trim()
            .split(/[ \t]+/, 1)[0];
        if (/^\d+$/.test(token)) return token;
        warnings.push(
            'Some ' + source.id + ' MTU could not be interpreted; raw evidence is retained.',
        );
        return undefined;
    };
    // Look ahead only to establish identity ambiguity; interpretation warnings still
    // follow the original source order below, and decoded JSON is reused.
    const decoded = new Map<ProbeResult, Record<string, unknown>[] | undefined>();
    const decodeRecords = (r: ProbeResult, warn = true): Record<string, unknown>[] | undefined => {
        if (!decoded.has(r)) {
            try {
                decoded.set(r, records(r.stdout));
            } catch {
                decoded.set(r, undefined);
            }
        }
        const values = decoded.get(r);
        if (values === undefined && warn)
            warnings.push(
                'Some ' + r.id + ' JSON could not be interpreted; raw evidence is retained.',
            );
        return values;
    };
    const readRecords = (r: ProbeResult) => decodeRecords(r) ?? [];
    const links = section(snapshot, 'ethernet', 'ip-link-json').filter(
        (r) => r.status === 'collected',
    );
    const legacy = result(snapshot, 'interfaces');
    const addressSections = section(snapshot, 'interfaces', 'ip-address-json').filter(
        (r) => r.status === 'collected',
    );
    const textLinks = !links.length
        ? section(snapshot, 'ethernet', 'ip-link-text').filter((r) => r.status === 'collected')
        : [];
    const knownIndices = new Map<string, Set<number>>();
    const remember = (name: string, index: number | undefined) => {
        if (index === undefined) return;
        const indices = knownIndices.get(name) ?? new Set<number>();
        indices.add(index);
        knownIndices.set(name, indices);
    };
    for (const r of [...links, ...addressSections])
        for (const record of decodeRecords(r, false) ?? [])
            if (typeof record.ifname === 'string')
                remember(record.ifname, safeNumber(record.ifindex));
    const useLegacy =
        !addressSections.some((r) => decodeRecords(r, false) !== undefined) &&
        legacy &&
        (!addressSections.length || legacy.status === 'collected');
    if (useLegacy)
        for (const line of legacy.stdout.split('\n')) {
            const m = line.match(/^(\S+):\s+([^:]+):/);
            if (m) remember(m[2].replace(/@.*$/, ''), safeNumber(m[1]));
        }
    for (const r of textLinks)
        for (const line of r.stdout.split('\n')) {
            const m = line.match(/^(\S+):\s+([^:]+):\s+<(.*?)>/);
            if (m) remember(m[2].replace(/@.*$/, ''), safeNumber(m[1]));
        }
    const unassigned = new Map<string, InterfaceSummary>();
    const seenIndices = new Map<string, Set<number>>();
    const ensure = (name: string, index?: number) => {
        const known = knownIndices.get(name);
        if (index === undefined && known && known.size > 1) {
            warnings.push(
                name +
                    ': multiple interface indices were observed; name-only observations kept unassigned.',
            );
            let iface = unassigned.get(name);
            if (!iface) {
                iface = { id: name, name, kind: 'Unclassified', groups: [] };
                unassigned.set(name, iface);
            }
            return iface;
        }
        if (index !== undefined) {
            const seen = seenIndices.get(name) ?? new Set<number>();
            if (seen.size && !seen.has(index))
                warnings.push(
                    name +
                        ': interface identity changed during collection; conflicting records kept separate.',
                );
            seen.add(index);
            seenIndices.set(name, seen);
        }
        // Stable tuple keys prevent order-dependent selection and name/#index collisions.
        const key = JSON.stringify([name, index ?? known?.values().next().value ?? null]);
        let iface = interfaces.get(key);
        if (!iface) {
            iface = { id: key, name, ifindex: index, kind: 'Unclassified', groups: [] };
            interfaces.set(key, iface);
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
    for (const r of links)
        for (const record of readRecords(r)) {
            if (typeof record.ifname !== 'string' || invalidIndex(record.ifindex, r)) continue;
            const iface = ensure(record.ifname, safeNumber(record.ifindex));
            const f = flags(record.flags),
                info = obj(record.linkinfo),
                data = obj(info.info_data);
            if (f) iface.admin = f.includes('UP') ? 'Enabled' : 'Disabled';
            iface.carrier =
                record.carrier !== undefined
                    ? record.carrier === 1
                        ? 'Present'
                        : record.carrier === 0
                          ? 'Absent'
                          : (text(record.carrier) ?? iface.carrier)
                    : f?.includes('LOWER_UP')
                      ? 'Present'
                      : f?.includes('NO-CARRIER')
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
                        ...(unassigned.get(record.ifname) === iface
                            ? [
                                  ...field('Operational state', record.operstate),
                                  ...field('MAC', record.address),
                                  ...field('Carrier', record.carrier),
                              ]
                            : []),
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
    let decodedAddresses = false;
    // Preserve warning order while distinguishing a decoded empty array from failure.
    for (const r of addressSections) {
        const values = decodeRecords(r);
        if (values !== undefined) {
            decodedAddresses = true;
            for (const record of values) {
                if (typeof record.ifname !== 'string' || invalidIndex(record.ifindex, r)) continue;
                const iface = ensure(record.ifname, safeNumber(record.ifindex));
                if (!iface.mac) iface.mac = text(record.address);
                if (!iface.mtu) iface.mtu = text(record.mtu);
                const f = flags(record.flags);
                if (!iface.admin && f) iface.admin = f.includes('UP') ? 'Enabled' : 'Disabled';
                if (!iface.state) iface.state = text(record.operstate);
                for (const [index, address] of (Array.isArray(record.addr_info)
                    ? record.addr_info
                    : []
                ).entries()) {
                    const a = obj(address);
                    const prefix = addressPrefix(a.family, a.prefixlen);
                    if (a.prefixlen !== undefined && prefix === undefined)
                        warnings.push(
                            'Some ' +
                                r.id +
                                ' address prefix could not be interpreted; raw evidence is retained.',
                        );
                    iface.groups.push(
                        group(
                            'address-' + index,
                            'Address ' + (text(a.local) ?? ''),
                            [
                                ...field('Family', a.family),
                                ...field(
                                    'Address / prefix',
                                    text(a.local) !== undefined
                                        ? text(a.local) + (prefix !== undefined ? '/' + prefix : '')
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
        }
    }
    if (!decodedAddresses && legacy && (!addressSections.length || legacy.status === 'collected')) {
        let iface: InterfaceSummary | undefined;
        for (const line of legacy.stdout.split('\n')) {
            const header = line.match(/^\d+:\s+([^:]+):\s*<(.*?)>/);
            const simple = line.match(/^(\S+):\s+([^:]+):/);
            const ifconfig = line.match(/^(\S+?)(?::\s+flags=|\s+Link encap:)/);
            if (simple || ifconfig) {
                if (simple && invalidIndex(simple[1], legacy)) {
                    iface = undefined;
                    continue;
                }
                iface = ensure(
                    (simple?.[2] ?? ifconfig![1]).replace(/@.*$/, ''),
                    simple ? safeNumber(simple[1]) : undefined,
                );
                if (header) {
                    iface.admin = header[2].split(',').includes('UP') ? 'Enabled' : 'Disabled';
                    iface.mtu = textMtu(line, legacy, iface.mtu);
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
        for (const r of textLinks) {
            let iface: InterfaceSummary | undefined;
            for (const line of r.stdout.split('\n')) {
                const m = line.match(/^(\S+):\s+([^:]+):\s+<(.*?)>/);
                if (m) {
                    if (invalidIndex(m[1], r)) {
                        iface = undefined;
                        continue;
                    }
                    iface = ensure(m[2].replace(/@.*$/, ''), safeNumber(m[1]));
                    iface.admin = m[3].split(',').includes('UP') ? 'Enabled' : 'Disabled';
                    iface.carrier = m[3].includes('LOWER_UP')
                        ? 'Present'
                        : m[3].includes('NO-CARRIER')
                          ? 'Absent'
                          : iface.carrier;
                    iface.state = line.match(/\bstate\s+(\S+)/)?.[1] ?? iface.state;
                    iface.mtu = textMtu(line, r, iface.mtu);
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
    for (const [name, iface] of unassigned)
        for (const detail of iface.groups)
            groups.push({
                ...detail,
                id: 'unassigned-' + groups.length,
                title: name + ' · index unresolved · ' + detail.title,
                note: 'Name-only observation; multiple interface indices were observed. Not assigned to an indexed interface.',
            });
    return { interfaces: [...interfaces.values()], groups, warnings: parseWarnings(warnings) };
}
