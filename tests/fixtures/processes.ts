import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

interface ProcessInfo {
    pid: number;
    parent: number;
    started: string;
    state: string;
    command: string;
}

async function processes(): Promise<ProcessInfo[]> {
    const entries = await readdir('/proc');
    const result = await Promise.all(
        entries
            .filter((entry) => /^\d+$/.test(entry))
            .map(async (entry) => {
                try {
                    const raw = await readFile(`/proc/${entry}/stat`, 'utf8');
                    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
                    return {
                        pid: Number(entry),
                        parent: Number(fields[1]),
                        started: fields[19],
                        state: fields[0],
                        command: await readFile(`/proc/${entry}/cmdline`, 'utf8'),
                    };
                } catch {
                    // Processes may exit between reading the directory and their metadata.
                    return undefined;
                }
            }),
    );
    return result.filter((entry): entry is ProcessInfo => entry !== undefined);
}

// AppImage relaunch detaches from Playwright. Scope cleanup to the test's private profile
// and its descendants, including Chromium helpers without a profile argument.
export async function stopProfileProcesses(profile: string): Promise<void> {
    const marker = `--user-data-dir=${profile}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Electron can rewrite argv into one space-separated process title in /proc.
    const matches = new RegExp(`(?:^|[\\0\\s])${marker}(?=$|[\\0\\s])`);
    const owned = new Map<number, string>();
    async function remaining() {
        const current = (await processes()).filter(
            (entry) => entry.pid > 1 && entry.pid !== process.pid && entry.state !== 'Z',
        );
        for (const entry of current) {
            if (matches.test(entry.command)) owned.set(entry.pid, entry.started);
        }
        let added: boolean;
        do {
            added = false;
            for (const entry of current) {
                const parent = current.find((candidate) => candidate.pid === entry.parent);
                if (parent && owned.get(parent.pid) === parent.started && !owned.has(entry.pid)) {
                    owned.set(entry.pid, entry.started);
                    added = true;
                }
            }
        } while (added);
        return current.filter((entry) => owned.get(entry.pid) === entry.started);
    }
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        const deadline = Date.now() + 3000;
        do {
            const active = await remaining();
            if (!active.length) return;
            for (const entry of active) {
                try {
                    process.kill(entry.pid, signal);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                }
            }
            await delay(100);
        } while (Date.now() < deadline);
    }
    const active = await remaining();
    if (active.length)
        throw Error(`Test processes did not stop: ${active.map((entry) => entry.pid).join(', ')}`);
}
