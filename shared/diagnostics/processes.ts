import type { ProbeResult } from '../types';
import type { EvidenceTable } from './evidence';

// A fixed read-only procfs collector. Races with exiting processes are expected;
// only readable fields are emitted. No process is opened for control or signalling.
export const PROCESS_COMMAND =
    'if [ -r /proc/stat ] && command -v awk >/dev/null 2>&1; then\n{ printf ' +
    "'HUB_PROCESS_RESOURCES_V1\\n';\nawk '/^cpu / { sum=0; for(i=2;i<=9;i++) sum+=$i; printf " +
    '"SystemCPU: %.0f\\n",sum } /^MemTotal:/ { print }\' /proc/stat /proc/meminfo;\nfor item in ' +
    '/proc/[0-9]*; do [ -r "$item/status" ] || continue; printf \'PID: %s\\n\' "${item##*/}"; cat ' +
    '"$item/status" "$item/stat" 2>/dev/null; done;\n} | awk ' +
    "'/^HUB_PROCESS_RESOURCES_V1$|^SystemCPU:|^MemTotal:|^PID:|^Name:|^State:|^Uid:|^VmRSS:|^Vm" +
    'Size:|^VmSwap:|^Threads:|^[0-9]+ \\(.*\\) [A-Za-z] / { print; if(/^Name:/) count++ } END { ' +
    "if(!count) exit 127 }';\nelif command -v ps >/dev/null 2>&1; then ps aux 2>/dev/null || " +
    'ps; else exit 127; fi';

export interface ProcessRecord {
    pid: number;
    name: string;
    uid?: number;
    state: string;
    rss?: number;
    virtual?: number;
    swap?: number;
    threads?: number;
    ticks?: number;
    start?: number;
}
export interface ProcessResources {
    totalTicks?: number;
    memoryTotal?: number;
    records: ProcessRecord[];
}
export interface ProcessSample {
    totalTicks: number;
    records: { pid: number; start: number; ticks: number }[];
}
const number = (value: string | undefined) =>
    value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : undefined;

export function processResources(result: ProbeResult): ProcessResources | undefined {
    if (result.status !== 'collected' || !result.stdout.startsWith('HUB_PROCESS_RESOURCES_V1\n'))
        return;
    const resources: ProcessResources = { records: [] };
    let record: ProcessRecord | undefined;
    for (const line of result.stdout.split('\n')) {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (match) {
            const [, key, value] = match;
            if (key === 'SystemCPU') resources.totalTicks = number(value);
            else if (key === 'MemTotal') resources.memoryTotal = number(value.split(/\s+/)[0]);
            else if (key === 'PID') {
                const pid = number(value);
                record = pid === undefined ? undefined : { pid, name: '', state: '' };
                if (record && resources.records.length < 2000) resources.records.push(record);
            } else if (record) {
                if (key === 'Name') record.name = value;
                else if (key === 'State') record.state = value;
                else if (key === 'Uid')
                    record.uid = number(value.split(/\s+/)[1]); // effective UID
                else if (key === 'Threads') record.threads = number(value);
                else if (['VmRSS', 'VmSize', 'VmSwap'].includes(key) && /^\d+\s+kB$/.test(value))
                    record[key === 'VmRSS' ? 'rss' : key === 'VmSize' ? 'virtual' : 'swap'] =
                        number(value.split(/\s+/)[0]);
            }
        } else if (record) {
            // The command name may contain spaces or ')'; split after its final ') '.
            const stat = line.match(/^(\d+) \(.*\) (.*)$/);
            if (!stat || Number(stat[1]) !== record.pid) continue;
            const fields = stat[2].trim().split(/\s+/);
            const user = number(fields[11]),
                system = number(fields[12]);
            record.ticks =
                user !== undefined && system !== undefined && Number.isSafeInteger(user + system)
                    ? user + system
                    : undefined;
            record.start = number(fields[19]);
        }
    }
    resources.records = resources.records.filter((r) => r.name);
    return resources;
}

export function processSample(result: ProbeResult): ProcessSample | undefined {
    const parsed = processResources(result);
    if (parsed?.totalTicks === undefined) return;
    return {
        totalTicks: parsed.totalTicks,
        records: parsed.records.flatMap((r) =>
            r.ticks !== undefined && r.start !== undefined
                ? [{ pid: r.pid, start: r.start, ticks: r.ticks }]
                : [],
        ),
    };
}

export function processCpu(
    record: ProcessRecord,
    totalTicks: number | undefined,
    previous?: ProcessSample,
    previousLookup?: ReadonlyMap<number, ProcessSample['records'][number]>,
): number | undefined {
    const old = previousLookup
        ? previousLookup.get(record.pid)
        : previous?.records.find((r) => r.pid === record.pid);
    const delta = totalTicks !== undefined && previous ? totalTicks - previous.totalTicks : 0;
    const ticks =
        old && old.start === record.start && record.ticks !== undefined
            ? record.ticks - old.ticks
            : -1;
    return delta > 0 && ticks >= 0 && ticks <= delta ? (100 * ticks) / delta : undefined;
}

export function processTable(
    result: ProbeResult,
    previous?: ProcessSample,
): EvidenceTable | undefined {
    const parsed = processResources(result);
    if (!parsed?.records.length) return;
    const previousLookup = new Map(previous?.records.map((record) => [record.pid, record]));
    const mib = (value?: number) => (value === undefined ? '' : (value / 1024).toFixed(2));
    return {
        columns: [
            'PID',
            'Process',
            'UID',
            'State',
            'Resident MiB',
            'Virtual MiB',
            'Memory %',
            'Swap MiB',
            'Threads',
            'CPU % (system)',
        ],
        rows: parsed.records.map((r) => {
            const cpu =
                processCpu(r, parsed.totalTicks, previous, previousLookup)?.toFixed(2) ?? '';
            return [
                String(r.pid),
                r.name,
                r.uid === undefined ? '' : String(r.uid),
                r.state,
                mib(r.rss),
                mib(r.virtual),
                r.rss !== undefined && parsed.memoryTotal
                    ? ((100 * r.rss) / parsed.memoryTotal).toFixed(2)
                    : '',
                mib(r.swap),
                r.threads === undefined ? '' : String(r.threads),
                cpu,
            ];
        }),
    };
}
