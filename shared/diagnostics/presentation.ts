import type { ProbeResult, Snapshot } from '../types';
import { evidencePresentation, type EvidenceTable } from './evidence';
import { parseFilesystems, parseMemory } from './metrics';
import { processCpu, processResources, processSample, type ProcessSample } from './processes';
export { evidencePresentation, type EvidenceNode, type EvidenceTable } from './evidence';

export interface Reading {
    key: string;
    label: string;
    value: number;
    unit: string;
    group?: string;
    series?: 'used' | 'free';
}
export interface HistoryFrame {
    capturedAt: string;
    readings: Record<string, Reading[]>;
    processes?: ProcessSample;
}
export const HISTORY_LIMIT = 120;

export function evidenceTable(id: string, result: ProbeResult): EvidenceTable {
    return evidencePresentation(id, result).table ?? { columns: [], rows: [] };
}

export function graphReadings(
    id: string,
    result: ProbeResult,
    snapshot?: Snapshot,
    previous?: ProcessSample,
): Reading[] {
    if (result.status !== 'collected') return [];
    const make = (key: string, label: string, value: number, unit: string): Reading => ({
        key,
        label,
        value,
        unit,
    });
    if (id === 'processes') {
        const parsed = processResources(result);
        return (
            parsed?.records.flatMap((record) => {
                // Start time prevents joining different processes that reuse a PID.
                if (record.start === undefined) return [];
                const key = `process:${record.pid}:${record.start}`;
                const label = `${record.name} (PID ${record.pid})`;
                const cpu = processCpu(record, parsed.totalTicks, previous);
                return [
                    ...(record.rss !== undefined
                        ? [
                              make(
                                  `${key}:rss`,
                                  `${label} · Resident memory`,
                                  record.rss / 1024,
                                  'MiB',
                              ),
                          ]
                        : []),
                    ...(record.virtual !== undefined
                        ? [
                              make(
                                  `${key}:virtual`,
                                  `${label} · Virtual memory`,
                                  record.virtual / 1024,
                                  'MiB',
                              ),
                          ]
                        : []),
                    ...(record.swap !== undefined
                        ? [make(`${key}:swap`, `${label} · Swap`, record.swap / 1024, 'MiB')]
                        : []),
                    ...(cpu !== undefined
                        ? [make(`${key}:cpu`, `${label} · CPU (system)`, cpu, '%')]
                        : []),
                ];
            }) ?? []
        );
    }
    if (id === 'load')
        return result.stdout
            .trim()
            .split(/\s+/)
            .slice(0, 3)
            .flatMap((v, i) =>
                Number.isFinite(Number(v)) && v !== ''
                    ? [
                          make(
                              String(i),
                              ['1 minute', '5 minutes', '15 minutes'][i],
                              Number(v),
                              'load',
                          ),
                      ]
                    : [],
            );
    const pair = (
        group: string,
        label: string,
        used: number,
        free: number,
        freeLabel = 'Free',
    ): Reading[] => [
        { ...make(`${group}:used`, `${label} · Used`, used / 1024, 'MiB'), group, series: 'used' },
        {
            ...make(`${group}:free`, `${label} · ${freeLabel}`, free / 1024, 'MiB'),
            group,
            series: 'free',
        },
    ];
    if (id === 'memory') {
        const m = parseMemory(result.stdout),
            free = m.free ?? m.available;
        return [
            ...(m.total > 0 && free !== null && free >= 0 && free <= m.total
                ? pair(
                      'ram',
                      m.free !== null ? 'RAM (used includes caches)' : 'RAM',
                      m.total - free,
                      free,
                      m.free !== null ? 'Free' : 'Available',
                  )
                : []),
            ...(m.available !== null && m.free !== null
                ? [make('available', 'Available RAM', m.available / 1024, 'MiB')]
                : []),
            ...(m.swapTotal > 0 && m.swapFree >= 0 && m.swapFree <= m.swapTotal
                ? pair('swap', 'Swap', m.swapTotal - m.swapFree, m.swapFree)
                : []),
        ];
    }
    if (['storage', 'flash', 'blockdevices'].includes(id)) {
        const storage =
            id === 'storage'
                ? result
                : snapshot?.results.find((r) => r.id === 'storage' && r.status === 'collected');
        if (!storage) return [];
        const devices = [...result.stdout.matchAll(/^\/sys\/block\/([^/]+)\/size=/gm)].map(
            (m) => m[1],
        );
        const matchesBlock = (name: string) =>
            devices.some(
                (device) =>
                    name === `/dev/${device}` ||
                    new RegExp(
                        `^/dev/${device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\d$/.test(device) ? 'p' : ''}\\d+$`,
                    ).test(name),
            );
        return parseFilesystems(storage.stdout)
            .filter(
                (f) =>
                    f.mount !== '/rom' &&
                    f.used >= 0 &&
                    f.available >= 0 &&
                    f.used + f.available <= f.total &&
                    (id === 'storage' ||
                        (id === 'flash'
                            ? /^\/dev\/(?:ubi\d+_\d+|mtdblock\d+)$/.test(f.name)
                            : matchesBlock(f.name))),
            )
            .flatMap((f) =>
                pair(
                    `fs:${f.name}:${f.mount}`,
                    `${f.mount} (${f.name})`,
                    f.used,
                    f.available,
                    'Free (available)',
                ),
            );
    }
    if (!['temperature', 'current', 'power', 'fans', 'ethernet'].includes(id)) return [];
    const attributes = new Map(
        result.stdout
            .trim()
            .split('\n')
            .map((line) => {
                const at = line.indexOf('=');
                return [line.slice(0, at), line.slice(at + 1)];
            }),
    );
    const seen = new Set<string>();
    return result.stdout
        .trim()
        .split('\n')
        .flatMap((line) => {
            const match = line.match(/^(\/[^=]+)=(-?\d+(?:\.\d+)?)$/);
            if (!match) return [];
            const key = match[1],
                field = key.split('/').at(-1)!;
            let unit: string,
                scale = 1;
            if (id === 'temperature' && /^(temp|temp\d+_input)$/.test(field)) {
                const typePath = key.replace(/_input$/, '_type');
                if (field !== 'temp' && attributes.get(typePath) === '4') unit = 'mV';
                else {
                    unit = '°C';
                    scale = 1000;
                }
            } else if (id === 'current' && /^in\d+_input$/.test(field)) unit = 'mV';
            else if (id === 'current' && /^curr\d+_input$/.test(field)) unit = 'mA';
            else if (
                (id === 'current' && /^power\d+_(input|average)$/.test(field)) ||
                (id === 'power' && field === 'power_now')
            )
                unit = 'µW';
            else if (id === 'power' && ['voltage_now', 'microvolts'].includes(field)) unit = 'µV';
            else if (id === 'power' && field === 'current_now') unit = 'µA';
            else if (id === 'fans' && /^fan\d+_input$/.test(field)) unit = 'RPM';
            else if (id === 'ethernet' && /^(rx|tx)_(packets|errors)$/.test(field)) unit = 'count';
            else return [];
            const value = Number(match[2]) / scale;
            if (!Number.isFinite(value) || seen.has(key)) return [];
            seen.add(key);
            const label = key.replace(/^\/sys\/class\//, '').replace(/\/statistics\//, '/');
            return [make(key, label, value, unit)];
        });
}

export function historyFrame(snapshot: Snapshot, previous?: HistoryFrame): HistoryFrame {
    const processes = snapshot.results.find((r) => r.id === 'processes');
    const sample = processes ? processSample(processes) : undefined;
    return {
        capturedAt: snapshot.capturedAt,
        readings: Object.fromEntries(
            snapshot.results.map((result) => [
                result.id,
                graphReadings(result.id, result, snapshot, previous?.processes),
            ]),
        ),
        ...(sample ? { processes: sample } : {}),
    };
}
