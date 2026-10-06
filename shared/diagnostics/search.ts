import type { Probe } from '../types';
import { categoryLabels } from './probes';

export type MatchKind = 'Exact match' | 'Partial match' | 'Related match' | 'Very less match';
export interface DiagnosticMatch {
    probe: Probe;
    kind?: MatchKind;
    rank: number;
    score: number;
}
const aliases: Record<string, string[]> = {
    memory: ['ram', 'ddr', 'heap', 'allocation'],
    ddr: ['ram', 'ecc', 'memory errors'],
    flash: ['nand', 'nor', 'mtd', 'firmware', 'capacity'],
    storage: ['disk', 'space', 'capacity', 'filesystem', 'flash'],
    blockdevices: ['disk', 'drive', 'capacity'],
    mmc: ['sd card', 'emmc', 'storage'],
    ethernet: ['lan', 'wired', 'link', 'network'],
    wireless: ['wifi', 'wlan', 'radio', 'network'],
    interfaces: ['lan', 'wifi', 'wlan', 'address', 'ip', 'link'],
    routes: ['gateway', 'routing', 'network'],
    uart: ['serial', 'console'],
    i2c: ['iic', 'bus'],
    i2s: ['sound', 'pcm', 'alsa'],
    spi: ['bus'],
    power: ['voltage', 'rail', 'supply'],
    current: ['ampere', 'amps', 'voltage'],
    temperature: ['thermal', 'heat', 'sensor'],
    fans: ['cooling', 'rpm', 'thermal'],
    processes: ['task', 'cpu usage', 'memory usage', 'rss', 'resource', 'pid'],
    cpu: ['processor', 'soc', 'cores'],
    load: ['cpu', 'performance'],
    services: ['daemon', 'systemd', 'procd'],
    logs: ['syslog', 'journal', 'dmesg', 'debug'],
    leds: ['light', 'indicator'],
    buttons: ['key', 'switch'],
    display: ['video', 'screen', 'hdmi', 'dp'],
    rtc: ['clock', 'time'],
    watchdog: ['reset', 'hang'],
    iio: ['adc', 'sensor'],
};
export const normalizeSearch = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) return 3;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    let previous: number[] = [];
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            next[j] = Math.min(
                next[j - 1] + 1,
                row[j] + 1,
                row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                next[j] = Math.min(next[j], previous[j - 2] + 1);
        }
        previous = row;
        row = next;
    }
    return row[b.length];
}
export function searchDiagnostics(items: Probe[], query: string): DiagnosticMatch[] {
    const needle = normalizeSearch(query).slice(0, 160);
    if (!needle) return items.map((probe) => ({ probe, rank: 0, score: 0 }));
    const terms = needle.split(' ');
    return items
        .flatMap<DiagnosticMatch>((probe) => {
            const title = normalizeSearch(probe.title),
                id = normalizeSearch(probe.id);
            const primary = `${id} ${title}`;
            const description = normalizeSearch(probe.description);
            const related = normalizeSearch(
                `${categoryLabels[probe.category]} ${(aliases[probe.id] ?? []).join(' ')}`,
            );
            if (needle === title || needle === id)
                return [{ probe, kind: 'Exact match', rank: 0, score: 0 }];
            if (terms.every((t) => `${primary} ${description}`.includes(t)))
                return [
                    {
                        probe,
                        kind: 'Partial match',
                        rank: 1,
                        score: primary.includes(needle)
                            ? 0
                            : terms.every((t) => primary.includes(t))
                              ? 1
                              : 2,
                    },
                ];
            if (terms.every((t) => `${primary} ${description} ${related}`.includes(t)))
                return [{ probe, kind: 'Related match', rank: 2, score: 0 }];
            const words = `${primary} ${related}`.split(' ');
            const scores = terms.map((term) =>
                words.some((word) => word === term)
                    ? 0
                    : term.length < 4
                      ? 3
                      : Math.min(
                            3,
                            ...words
                                .filter((word) => word.length >= 4)
                                .map((word) => distance(term, word)),
                        ),
            );
            if (scores.every((score, i) => score <= (terms[i].length >= 7 ? 2 : 1)))
                return [
                    {
                        probe,
                        kind: 'Very less match',
                        rank: 3,
                        score: scores.reduce((a, b) => a + b, 0),
                    },
                ];
            return [];
        })
        .sort(
            (a, b) =>
                a.rank - b.rank ||
                a.score - b.score ||
                items.indexOf(a.probe) - items.indexOf(b.probe),
        );
}
