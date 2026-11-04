import type { Snapshot } from '../types';

export function evidence(snapshot: Snapshot | null, id: string): string {
    const result = snapshot?.results.find((item) => item.id === id);
    return result?.status === 'collected' ? result.stdout : '';
}

function integerCounter(token: string): number | null {
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return Number.isSafeInteger(value) ? value : null;
}

export function parseMemory(text: string) {
    const values: Record<string, number> = {};
    for (const line of text.split('\n')) {
        const match = line.match(/^(\w+):\s+(\d+)\s+kB\s*$/);
        if (match) {
            const value = integerCounter(match[2]);
            if (value !== null) values[match[1]] = value;
        }
    }
    const total = values.MemTotal ?? 0;
    const withinTotal = (value: number | undefined, capacity: number): number | null =>
        value === undefined || (capacity > 0 && value > capacity) ? null : value;
    const available = withinTotal(values.MemAvailable, total);
    const free = withinTotal(values.MemFree, total);
    const swapTotal = values.SwapTotal ?? 0;
    return {
        total,
        available,
        free,
        usedPercent: total && available !== null ? Math.round((1 - available / total) * 100) : null,
        swapTotal,
        swapFree: withinTotal(values.SwapFree, swapTotal),
    };
}

export function parseFilesystems(text: string) {
    return text
        .trim()
        .split('\n')
        .slice(1)
        .flatMap((line) => {
            const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
            if (!match) return [];
            const total = integerCounter(match[2]),
                used = integerCounter(match[3]),
                available = integerCounter(match[4]),
                percent = integerCounter(match[5]);
            if (total === null || used === null || available === null || percent === null)
                return [];
            return [{ name: match[1], total, used, available, percent, mount: match[6] }];
        });
}

export function parseRelease(text: string): string {
    const values: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
    return (
        values.PRETTY_NAME ||
        values.DISTRIB_DESCRIPTION ||
        [values.NAME, values.VERSION_ID].filter(Boolean).join(' ') ||
        'Unknown Linux'
    );
}

// The uptime probe reads /proc/uptime. Its first field is non-negative decimal
// seconds; missing/malformed evidence must not become a zero/boot observation.
export function parseUptimeSeconds(text: string): number | null {
    const token = text.trim().split(/\s+/)[0];
    if (!/^\d+(?:\.\d+)?$/.test(token)) return null;
    const seconds = Number(token);
    const [whole, fraction = ''] = token.split('.');
    if (
        !Number.isFinite(seconds) ||
        seconds > Number.MAX_SAFE_INTEGER ||
        (Number(whole) === Number.MAX_SAFE_INTEGER && /[1-9]/.test(fraction)) ||
        (seconds === 0 && /[1-9]/.test(token))
    )
        return null;
    return seconds;
}

export function formatUptime(text: string): string {
    const seconds = parseUptimeSeconds(text);
    if (seconds === null) return 'Unavailable';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}

export function formatKiB(value: number): string {
    return value >= 1048576
        ? `${(value / 1048576).toFixed(1)} GiB`
        : `${Math.round(value / 1024)} MiB`;
}

export function formatMemoryDetail(memory: ReturnType<typeof parseMemory>): string {
    if (!memory.total) return 'Memory data unavailable';
    const remaining = memory.available ?? memory.free;
    return remaining === null
        ? `Availability unknown · ${formatKiB(memory.total)} total`
        : `${formatKiB(remaining)} ${memory.available === null ? 'free' : 'available'} of ${formatKiB(memory.total)}`;
}

export function summarize(snapshot: Snapshot | null) {
    const identity = evidence(snapshot, 'identity').trim().split('\n');
    const memory = parseMemory(evidence(snapshot, 'memory'));
    const filesystems = parseFilesystems(evidence(snapshot, 'storage'));
    const findings: { level: 'warning' | 'info'; title: string; detail: string; probe: string }[] =
        [];
    const writableFilesystems = filesystems.filter(
        (item) =>
            item.mount !== '/rom' &&
            !(
                item.mount === '/' &&
                item.name.startsWith('overlay') &&
                filesystems.some((fs) => fs.mount === '/overlay')
            ),
    );
    for (const fs of writableFilesystems.filter((item) => item.percent >= 85)) {
        findings.push({
            level: 'warning',
            title: `Low space on ${fs.mount}`,
            detail: `${fs.percent}% used. Inspect filesystem usage before adding logs or images.`,
            probe: 'storage',
        });
    }
    if (memory.usedPercent !== null && memory.usedPercent >= 85) {
        findings.push({
            level: 'warning',
            title: 'Limited available memory',
            detail: `${memory.usedPercent}% of RAM is not available. Review allocations before a stress test.`,
            probe: 'memory',
        });
    }
    const lan = snapshot?.results.find((item) => item.id === 'ethernet');
    if (lan?.status === 'collected' && /^Warning:/m.test(lan.stderr))
        findings.push({
            level: 'warning',
            title: 'LAN: some attributes unavailable',
            detail: 'Valid interface readings were collected. Inspect Standard error for skipped attributes; an interface being down does not establish a hardware fault.',
            probe: 'ethernet',
        });
    for (const result of (snapshot?.results ?? []).filter((item) => item.status === 'error')) {
        findings.push({
            level: result.status === 'error' ? 'warning' : 'info',
            title: `${result.id}: ${result.status === 'unavailable' ? 'capability unavailable' : 'collection failed'}`,
            detail: result.stderr.trim() || 'Inspect the raw evidence for this diagnostic.',
            probe: result.id,
        });
    }
    return {
        hostname: identity[1] || 'Linux device',
        kernel: identity[2] || 'Unavailable',
        architecture: identity[3] || 'Unavailable',
        distro: parseRelease(evidence(snapshot, 'release')),
        uptime: formatUptime(evidence(snapshot, 'uptime')),
        load: evidence(snapshot, 'load').trim().split(/\s+/).filter(Boolean).slice(0, 3),
        memory,
        filesystems,
        findings,
    };
}
