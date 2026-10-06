import type { ProbeResult } from '../types';
import { parseFilesystems } from './metrics';
import { processTable } from './processes';

export interface EvidenceTable {
    columns: string[];
    rows: string[][];
}
export interface EvidenceNode {
    key: string;
    label: string;
    value?: string;
    children?: EvidenceNode[];
}
export interface EvidencePresentation {
    table?: EvidenceTable;
    tree?: EvidenceNode[];
    note?: string;
}
const empty: EvidencePresentation = {};
const MAX_NODES = 4000;
const MAX_DEPTH = 32;
const table = (columns: string[], rows: string[][], note?: string): EvidencePresentation =>
    rows.length ? { table: { columns, rows }, ...(note ? { note } : {}) } : empty;
const pathKey = (path: string[]) => JSON.stringify(path);
const valueText = (value: unknown): string => JSON.stringify(value) ?? String(value);

function jsonPresentation(id: string, value: object): EvidencePresentation {
    let count = 0,
        limited = false;
    const flatten: string[][] = [];
    function nodes(data: unknown, path: string[], depth: number): EvidenceNode[] {
        return Object.entries(data as Record<string, unknown>).flatMap<EvidenceNode>(
            ([label, child]) => {
                if (++count > MAX_NODES) {
                    limited = true;
                    return [];
                }
                const next = [...path, label];
                const nested = child !== null && typeof child === 'object';
                const entries = nested ? Object.keys(child as object).length : 0;
                if (nested && entries && depth >= MAX_DEPTH) {
                    limited = true;
                    return [
                        {
                            key: pathKey(next),
                            label,
                            value: 'See Standard output for deeper content.',
                        },
                    ];
                }
                if (nested && entries)
                    return [{ key: pathKey(next), label, children: nodes(child, next, depth + 1) }];
                const text = valueText(child);
                flatten.push([
                    next.join('.'),
                    typeof child === 'string' && child !== '' ? child : text,
                ]);
                return [{ key: pathKey(next), label, value: text }];
            },
        );
    }
    const tree = nodes(value, [], 0);
    const note = limited
        ? 'Structured display is limited to 4,000 fields and 32 levels. Full evidence is available in Standard output.'
        : undefined;
    // Board metadata is a compact record; nested release fields become explicit key paths.
    if (id === 'board') return table(['Field', 'Value'], flatten, note);
    return tree.length ? { tree, ...(note ? { note } : {}) } : empty;
}

function sysfsTable(lines: string[]): EvidencePresentation {
    const rows: string[][] = [];
    for (const line of lines) {
        const match = line.match(/^(\/[^=]+)=(.*)$/);
        if (match) rows.push([match[1], match[2]]);
        else if (rows.length) rows.at(-1)![1] += '\n' + line;
        else return empty;
    }
    return table(['Field / path', 'Value'], rows);
}

// Keep every line inside its actual device/interface group rather than guessing columns.
function groupedTree(
    lines: string[],
    header: (line: string) => { label: string; value: string } | null,
): EvidencePresentation {
    const roots: EvidenceNode[] = [];
    let current: EvidenceNode | undefined;
    let stack: { indent: number; node: EvidenceNode }[] = [];
    for (const [index, line] of lines.entries()) {
        if (index >= MAX_NODES) return empty;
        const group = header(line);
        if (group) {
            current = {
                key: `${group.label}:${roots.filter((node) => node.label === group.label).length}`,
                ...group,
                children: [],
            };
            roots.push(current);
            stack = [];
        } else if (current && line.trim()) {
            const indent = line.match(/^\s*/)?.[0].replace(/\t/g, '    ').length ?? 0;
            while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
            if (stack.length >= MAX_DEPTH) return empty;
            const parent = stack.at(-1)?.node ?? current;
            const children = (parent.children ??= []);
            const label = line.trim();
            const child = {
                key: `${parent.key}:${label}:${children.filter((n) => n.label === label).length}`,
                label,
            };
            children.push(child);
            stack.push({ indent, node: child });
        } else if (line.trim()) return empty;
    }
    return roots.length ? { tree: roots } : empty;
}

function indentedTree(lines: string[]): EvidencePresentation {
    const roots: EvidenceNode[] = [];
    let count = 0;
    const stack: { indent: number; node: EvidenceNode; path: string[] }[] = [];
    for (const line of lines.filter((line) => line.trim())) {
        const indent = line.match(/^\s*/)?.[0].replace(/\t/g, '    ').length ?? 0;
        while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
        const label = line.trim();
        const siblings = stack.length ? (stack.at(-1)!.node.children ??= []) : roots;
        const occurrence = siblings.filter((n) => n.label === label).length;
        const path = [...(stack.at(-1)?.path ?? []), `${label}:${occurrence}`];
        const node: EvidenceNode = { key: pathKey(path), label };
        siblings.push(node);
        stack.push({ indent, node, path });
        if (stack.length > MAX_DEPTH || ++count > MAX_NODES) return empty;
    }
    return roots.some((n) => n.children?.length) ? { tree: roots } : empty;
}

function headerTable(
    lines: string[],
    kind: 'processes' | 'services' | 'routes',
): EvidencePresentation {
    const headerIndex = lines.findIndex((line) =>
        kind === 'processes'
            ? /^\s*(?:USER\s+PID|PID\s+USER)\b/.test(line)
            : kind === 'services'
              ? /^\s*UNIT\s+LOAD\s+ACTIVE\s+SUB\s+DESCRIPTION\s*$/.test(line)
              : /^\s*(?:Destination\s+Gateway|Iface\s+Destination)\b/.test(line),
    );
    if (headerIndex < 0) return empty;
    const columns = lines[headerIndex].trim().split(/\s+/);
    // 'Mounted on' is handled by df parsing, never by this generic header parser.
    const rows = lines.slice(headerIndex + 1).flatMap((line) => {
        const text = line.replace(/^\s*●\s*/, '').trim();
        const tokens = text.split(/\s+/);
        const record =
            kind === 'processes'
                ? /^\d+$/.test(tokens[columns.indexOf('PID')] ?? '')
                : kind === 'services'
                  ? /^\S+\.service$/.test(tokens[0])
                  : kind === 'routes' && /^\S+$/.test(tokens[0]);
        if (!record || tokens.length < columns.length) return [];
        const pattern = new RegExp('^' + '(\\S+)\\s+'.repeat(columns.length - 1) + '(.*)$');
        const match = text.match(pattern);
        return match ? [match.slice(1)] : [];
    });
    return table(columns, rows);
}

function routeTable(lines: string[]): EvidencePresentation {
    const legacy = headerTable(lines, 'routes');
    if (legacy.table) {
        if (legacy.table.columns[0] === 'Iface')
            legacy.table.columns = legacy.table.columns.map((c) =>
                ['Destination', 'Gateway', 'Mask'].includes(c) ? `${c} (hex)` : c,
            );
        return legacy;
    }
    if (lines.some((line) => /^\s/.test(line) || /\bnexthop\b/.test(line))) return empty;
    const rows = lines.flatMap((line) => {
        const tokens = line.trim().split(/\s+/);
        let type = '';
        if (
            [
                'unreachable',
                'blackhole',
                'prohibit',
                'throw',
                'local',
                'broadcast',
                'multicast',
            ].includes(tokens[0])
        )
            type = tokens.shift()!;
        const destination = tokens.shift()!;
        if (!/^(?:default|[\da-fA-F:.]+(?:\/\d+)?)$/.test(destination)) return [];
        const fields: Record<string, string> = {};
        const remaining: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
            if (
                ['via', 'dev', 'proto', 'scope', 'src', 'metric'].includes(tokens[i]) &&
                tokens[i + 1]
            )
                fields[tokens[i]] = tokens[++i];
            else remaining.push(tokens[i]);
        }
        return [
            [
                destination,
                fields.via ?? '',
                fields.dev ?? '',
                fields.proto ?? '',
                fields.scope ?? '',
                fields.src ?? '',
                fields.metric ?? '',
                [type, ...remaining].filter(Boolean).join(' '),
            ],
        ];
    });
    return rows.length === lines.length
        ? table(
              [
                  'Destination',
                  'Gateway',
                  'Interface',
                  'Protocol',
                  'Scope',
                  'Source',
                  'Metric',
                  'Other attributes',
              ],
              rows,
          )
        : empty;
}

export const LOG_COLUMNS = [
    'Date',
    'Time',
    'Host',
    'Facility / level',
    'Program',
    'PID',
    'Kernel time (s)',
    'Message',
];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function logTable(output: string): EvidencePresentation {
    let recognized = 0,
        unmatched = 0;
    const rows: string[][] = [];
    for (const line of output.trimEnd().split('\n')) {
        if (/^\s+/.test(line) && rows.length) {
            rows.at(-1)![7] += '\n' + line;
            continue;
        }
        let date = '',
            time = '',
            host = '',
            facility = '',
            program = '',
            pid = '',
            kernelTime = '',
            rest = line;
        let matched = false;
        const openwrt = line.match(
            /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d{4})\s+(.*)$/,
        );
        const iso = line.match(
            /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/,
        );
        const syslog = line.match(/^(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.*)$/);
        const kernel = line.match(/^\[\s*(\d+(?:\.\d+)?)\]\s?(.*)$/);
        if (openwrt && months.includes(openwrt[1])) {
            date = `${openwrt[4]}-${String(months.indexOf(openwrt[1]) + 1).padStart(2, '0')}-${openwrt[2].padStart(2, '0')}`;
            time = openwrt[3];
            rest = openwrt[5];
            matched = true;
        } else if (iso) {
            date = iso[1];
            time = iso[2];
            rest = iso[3];
            matched = true;
        } else if (syslog && months.includes(syslog[1])) {
            date = `${syslog[1]} ${syslog[2]}`;
            time = syslog[3];
            rest = syslog[4];
            matched = true;
        } else if (kernel) {
            kernelTime = kernel[1];
            program = 'kernel';
            rest = kernel[2];
            matched = true;
        }
        if (matched && !kernel) {
            const priority = rest.match(
                /^([\w-]+\.(?:emerg|alert|crit|err|error|warning|warn|notice|info|debug))\s+(.*)$/,
            );
            if (priority) {
                facility = priority[1];
                rest = priority[2];
            }
            // OpenWrt has no hostname field; journal/syslog commonly place one before the tag.
            const tag = rest.match(/^(?:(\S+)\s+)?([\w./@+-]+)(?:\[(\d+)\])?:\s?(.*)$/);
            if (tag) {
                host = tag[1] ?? '';
                program = tag[2];
                pid = tag[3] ?? '';
                rest = tag[4];
            }
            const bootTime =
                program === 'kernel' ? rest.match(/^\[\s*(\d+(?:\.\d+)?)\]\s?(.*)$/) : null;
            if (bootTime) {
                kernelTime = bootTime[1];
                rest = bootTime[2];
            }
        }
        if (matched) recognized++;
        else unmatched++;
        rows.push([date, time, host, facility, program, pid, kernelTime, rest]);
    }
    return recognized
        ? table(
              LOG_COLUMNS,
              rows,
              unmatched
                  ? `${unmatched} unrecognized log line${unmatched === 1 ? '' : 's'} retained in Message without guessed fields. Raw output preserves the original formatting.`
                  : undefined,
          )
        : empty;
}

const sysfsIds = new Set([
    'leds',
    'ethernet',
    'i2c',
    'spi',
    'flash',
    'blockdevices',
    'mmc',
    'usb',
    'pcie',
    'power',
    'current',
    'temperature',
    'ddr',
    'display',
    'gpio',
    'rtc',
    'watchdog',
    'iio',
    'fans',
]);
export function evidencePresentation(id: string, result: ProbeResult): EvidencePresentation {
    if (result.status !== 'collected' || !result.stdout.trim()) return empty;
    const text = result.stdout.trim();
    const lines = text.split('\n');
    if (/^[\[{]/.test(text)) {
        try {
            const json: unknown = JSON.parse(text);
            if (json !== null && typeof json === 'object') return jsonPresentation(id, json);
        } catch {
            /* A textual/kernel header beginning with '[' is not necessarily JSON. */
        }
    }
    if (sysfsIds.has(id)) return sysfsTable(lines);
    if (id === 'board')
        return lines.length === 1 ? table(['Field', 'Value'], [['Model', text]]) : empty;
    if (id === 'identity')
        return lines.length === 4
            ? table(
                  ['Field', 'Value'],
                  lines.map((value, i) => [
                      ['System', 'Hostname', 'Kernel', 'Architecture'][i],
                      value,
                  ]),
              )
            : empty;
    if (id === 'release') {
        const rows = lines
            .filter((line) => !/^\s*#/.test(line) && line.trim())
            .map((line) => line.match(/^([A-Za-z_][\w]*)=(.*)$/));
        return rows.every(Boolean)
            ? table(
                  ['Field', 'Value'],
                  rows.map((match) => [match![1], match![2].replace(/^(["'])(.*)\1$/, '$2')]),
              )
            : empty;
    }
    if (id === 'memory')
        return table(
            ['Field', 'Value', 'Unit'],
            lines.flatMap((line) => {
                const m = line.match(/^(\w+):\s+(\d+)(?:\s+(\S+))?$/);
                return m ? [[m[1], m[2], m[3] || '']] : [];
            }),
        );
    if (id === 'storage')
        return table(
            ['Filesystem', 'Total KiB', 'Used KiB', 'Available KiB', 'Used %', 'Mount'],
            parseFilesystems(text).map((f) => [
                f.name,
                String(f.total),
                String(f.used),
                String(f.available),
                String(f.percent),
                f.mount,
            ]),
        );
    if (id === 'uptime') {
        const m = text.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
        return m
            ? table(
                  ['Field', 'Value', 'Unit'],
                  [
                      ['Uptime', m[1], 's'],
                      ['Aggregate CPU idle time', m[2], 's'],
                  ],
              )
            : empty;
    }
    if (id === 'load') {
        const m = text.match(
            /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+)\s+(\d+))?$/,
        );
        return m
            ? table(
                  ['Field', 'Value'],
                  [
                      ['1 minute', m[1]],
                      ['5 minutes', m[2]],
                      ['15 minutes', m[3]],
                      ...(m[4]
                          ? [
                                ['Runnable tasks', m[4]],
                                ['Total tasks', m[5]],
                                ['Last PID', m[6]],
                            ]
                          : []),
                  ],
              )
            : empty;
    }
    if (id === 'cpu')
        return groupedTree(lines, (line) => {
            const m = line.match(/^processor\s*:\s*(\d+)$/);
            return m ? { label: `Processor ${m[1]}`, value: '' } : null;
        });
    if (id === 'interfaces')
        return groupedTree(lines, (line) => {
            const ip = line.match(/^(\d+):\s+([^:]+):\s*(<[^>]*>.*)$/);
            const ifconfig = line.match(/^(\S+?)(?::\s+(?=flags=\d+)|\s+Link encap:)(.*)$/);
            return ip
                ? { label: ip[2], value: `Index ${ip[1]} · ${ip[3]}` }
                : ifconfig
                  ? { label: ifconfig[1], value: ifconfig[2] }
                  : null;
        });
    if (id === 'routes') return routeTable(lines);
    if (id === 'processes') {
        const resources = processTable(result);
        return resources ? { table: resources } : headerTable(lines, 'processes');
    }
    if (id === 'services') {
        const units = headerTable(lines, 'services');
        if (units.table) return units;
        const names = lines;
        return names.every((name) => /^[A-Za-z0-9_@][\w@.+-]*$/.test(name))
            ? table(
                  ['Service'],
                  names.map((name) => [name]),
              )
            : empty;
    }
    if (id === 'logs') return logTable(result.stdout);
    if (id === 'wireless' && /^Inter-\|/m.test(text) && /link level noise/.test(text)) {
        const rows = lines
            .slice(2)
            .map((line) =>
                line.match(
                    /^\s*([^:]+):\s*([\da-fA-F]+)\s+(-?\d+\.?)\s+(-?\d+\.?)\s+(-?\d+\.?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/,
                ),
            );
        return rows.every(Boolean)
            ? table(
                  [
                      'Interface',
                      'Status (hex)',
                      'Link quality (raw)',
                      'Signal (raw)',
                      'Noise (raw)',
                      'Discarded NWID',
                      'Discarded crypt',
                      'Discarded fragments',
                      'Discarded retries',
                      'Discarded misc',
                      'Missed beacons',
                  ],
                  rows.map((m) => m!.slice(1).map((v) => v.trim())),
                  'Raw Wireless Extensions quality fields; trailing dots are update markers. Signal/noise units are not inferred.',
              )
            : empty;
    }
    if (id === 'wireless' && /^phy#\d+/m.test(text)) return indentedTree(lines);
    if (id === 'wireless' && /^\S+\s+ESSID:/.test(text))
        return groupedTree(lines, (line) => {
            const m = line.match(/^(\S+)\s+(ESSID:.*)$/);
            return m ? { label: m[1], value: m[2] } : null;
        });
    if (id === 'buttons') {
        if (text.startsWith('/')) return sysfsTable(lines);
        const blocks = text.split(/\n\s*\n/);
        const nodes = blocks.map((block, index) => {
            const name = block.match(/^N:\s+Name="(.*)"$/m)?.[1];
            return {
                key: `input:${index}`,
                label: name ?? `Input device ${index + 1}`,
                children: block
                    .split('\n')
                    .map((line, i) => ({ key: `input:${index}:${i}`, label: line })),
            };
        });
        return blocks.every((block) => /^I:\s+Bus=/m.test(block)) ? { tree: nodes } : empty;
    }
    if (id === 'uart')
        return table(
            ['Port', 'Driver', 'Address', 'IRQ', 'Transmitted', 'Received', 'Other attributes'],
            lines.flatMap((line) => {
                const m = line.match(/^(\d+):\s+uart:(\S+)\s+(.*)$/);
                if (!m) return [];
                const fields = Object.fromEntries(
                    [...m[3].matchAll(/(mmio|port|irq|tx|rx):([^\s]+)/g)].map((match) => [
                        match[1],
                        match[2],
                    ]),
                );
                return [
                    [
                        m[1],
                        m[2],
                        fields.mmio ?? fields.port ?? '',
                        fields.irq ?? '',
                        fields.tx ?? '',
                        fields.rx ?? '',
                        m[3].replace(/(?:mmio|port|irq|tx|rx):[^\s]+\s*/g, '').trim(),
                    ],
                ];
            }),
        );
    if (id === 'i2s') {
        const cards: EvidenceNode[] = [];
        let current: EvidenceNode | undefined;
        for (const [index, line] of lines.entries()) {
            const card = line.match(/^\s*(\d+)\s+\[([^\]]+)\]\s*:\s*(.*)$/);
            const pcm = line.match(/^(\d+)-(\d+):\s*(.*)$/);
            if (card) {
                current = {
                    key: `card:${Number(card[1])}`,
                    label: `Card ${card[1]} · ${card[2].trim()}`,
                    value: card[3],
                    children: [],
                };
                cards.push(current);
            } else if (pcm) {
                const parent = cards.find((n) => n.key === `card:${Number(pcm[1])}`);
                if (!parent) return empty;
                parent.children!.push({
                    key: `${parent.key}:pcm:${pcm[2]}`,
                    label: `PCM ${pcm[1]}-${pcm[2]}`,
                    value: pcm[3],
                });
            } else if (current && line.trim())
                current.children!.push({ key: `${current.key}:${index}`, label: line.trim() });
            else if (line.trim()) return empty;
        }
        return cards.length ? { tree: cards } : empty;
    }
    return empty;
}
