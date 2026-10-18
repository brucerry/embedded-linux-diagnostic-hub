import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
export type ProcessRow = { pid: number; parent: number; created: string; rssBytes: number | null };
type Row = ProcessRow;
export async function readLinuxProcesses(
    io: { list(): Promise<string[]>; read(file: string): Promise<string> } = {
        list: () => fs.readdir('/proc'),
        read: (file) => fs.readFile(file, 'utf8'),
    },
): Promise<Row[]> {
    const result: Row[] = [];
    for (const name of await io.list()) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const raw = await io.read(`/proc/${name}/stat`),
                fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
            const status = await io.read(`/proc/${name}/status`),
                match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
            if (fields[0] !== 'Z')
                result.push({
                    pid: Number(name),
                    parent: Number(fields[1]),
                    created: fields[19],
                    rssBytes: match ? Number(match[1]) * 1024 : null,
                });
        } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
                throw error;
        }
    }
    return result;
}
export async function readProcessTable(): Promise<Row[]> {
    if (process.platform === 'linux') return readLinuxProcesses();
    const windows = process.platform === 'win32';
    const stdout = await new Promise<string>((resolve, reject) =>
        execFile(
            windows ? 'powershell.exe' : 'ps',
            windows
                ? [
                      '-NoProfile',
                      '-NonInteractive',
                      '-Command',
                      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="Created";e={$_.CreationDate.ToUniversalTime().ToString("o")}},WorkingSetSize | ConvertTo-Json -Compress',
                  ]
                : ['-axo', 'pid=,ppid=,lstart=,rss='],
            { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 ** 2 },
            (error, text) => (error ? reject(error) : resolve(text)),
        ),
    );
    if (windows)
        return JSON.parse(stdout).map((row: Record<string, string | number>) => ({
            pid: Number(row.ProcessId),
            parent: Number(row.ParentProcessId),
            created: typeof row.Created === 'string' ? row.Created : '',
            rssBytes: Number(row.WorkingSetSize),
        }));
    return stdout
        .trim()
        .split('\n')
        .flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\d+)\s*$/.exec(line);
            return match
                ? [
                      {
                          pid: Number(match[1]),
                          parent: Number(match[2]),
                          created: match[3],
                          rssBytes: Number(match[4]) * 1024,
                      },
                  ]
                : [];
        });
}
/** Roots must come from this fixture's launched children, never an ambient process name. */
export class ProcessSampler {
    private identities = new Map<string, { pid: number; created: string; root: boolean }>();
    private rootInstances = new Map<number, string>();
    constructor(
        private roots: number[],
        private readTable: () => Promise<Row[]> = readProcessTable,
    ) {}
    async sample() {
        const rows = await this.readTable();
        const key = (row: Pick<Row, 'pid' | 'created'>) => JSON.stringify([row.pid, row.created]);
        for (const pid of this.roots) {
            const row = rows.find((value) => value.pid === pid);
            if (!this.rootInstances.has(pid)) {
                if (!row?.created) throw Error(`Owned root identity unavailable: ${pid}.`);
                this.rootInstances.set(pid, row.created);
                this.identities.set(key(row), { pid, created: row.created, root: true });
            }
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const row of rows) {
                const parent = rows.find((value) => value.pid === row.parent);
                if (parent && this.identities.has(key(parent)) && !this.identities.has(key(row))) {
                    if (!row.created)
                        throw Error(`Owned descendant identity unavailable: ${row.pid}.`);
                    this.identities.set(key(row), {
                        pid: row.pid,
                        created: row.created,
                        root: false,
                    });
                    changed = true;
                }
            }
        }
        if (this.identities.size > 256) throw Error('Owned process identity bound exceeded.');
        return [...this.identities.values()].map(({ pid, created, root }) => {
            if (rows.some((value) => value.pid === pid && !value.created))
                throw Error(`Owned process liveness unknown: ${pid}.`);
            const row = rows.find((value) => value.pid === pid && value.created === created);
            return {
                pid,
                created,
                role: root ? 'fixture-root' : 'owned-descendant',
                state: row ? ('running' as const) : ('terminated' as const),
                rssBytes: row?.rssBytes ?? null,
                heapUsedBytes: null,
                externalBytes: null,
                arrayBuffersBytes: null,
                unsupported: [
                    'OS sample has no JS/native allocation breakdown',
                    ...(row && row.rssBytes === null
                        ? ['OS RSS unavailable for a live process']
                        : []),
                ],
            };
        });
    }
    async assertExited() {
        const remaining = (await this.sample()).filter((row) => row.state === 'running');
        if (remaining.length)
            throw Error(`Owned descendants still running: ${JSON.stringify(remaining)}`);
    }
}
