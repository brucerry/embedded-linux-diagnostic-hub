import { summarize } from './diagnostics/metrics';
import { probes } from './diagnostics/probes';
import type { Snapshot } from './types';

export function createReport(snapshot: Snapshot) {
    return {
        application: 'Diagnostic Hub',
        applicationVersion: '0.1.0',
        ...snapshot,
        summary: summarize(snapshot),
        diagnostics: snapshot.results.map((result) => ({
            ...result,
            title: probes.find((probe) => probe.id === result.id)?.title,
            command: result.command || probes.find((probe) => probe.id === result.id)?.command,
        })),
    };
}

export const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export function validateSnapshot(input: unknown, requireComplete = false): Snapshot {
    const invalid = () => {
        throw new Error(
            'Unsupported report. Import a Diagnostic Hub JSON report with schema version 1.',
        );
    };
    const text = (value: unknown, limit: number): value is string =>
        typeof value === 'string' && value.length <= limit;
    const date = (value: unknown): value is string =>
        text(value, 40) && Number.isFinite(Date.parse(value));
    if (!input || typeof input !== 'object') return invalid();
    const value = input as Record<string, unknown>;
    if (
        value.schemaVersion !== 1 ||
        (value.mode !== 'demo' && value.mode !== 'ssh') ||
        !text(value.endpoint, 512) ||
        !text(value.username, 64) ||
        !date(value.capturedAt)
    )
        return invalid();
    const results = value.diagnostics ?? value.results;
    if (
        !Array.isArray(results) ||
        results.length < 1 ||
        results.length > probes.length ||
        (requireComplete && results.length !== probes.length)
    )
        return invalid();
    const seen = new Set<string>();
    const normalized = results.map((raw) => {
        if (!raw || typeof raw !== 'object') return invalid();
        const item = raw as Record<string, unknown>;
        if (
            typeof item.id !== 'string' ||
            !probes.some((probe) => probe.id === item.id) ||
            seen.has(item.id)
        )
            return invalid();
        seen.add(item.id);
        if (
            !text(item.stdout, 262144) ||
            !text(item.stderr, 262144) ||
            item.stdout.length + item.stderr.length > 262144 + 4096
        )
            return invalid();
        if (
            item.exitCode !== null &&
            (typeof item.exitCode !== 'number' || !Number.isSafeInteger(item.exitCode))
        )
            return invalid();
        const expectedStatus =
            item.exitCode === 0 ? 'collected' : item.exitCode === 127 ? 'unavailable' : 'error';
        if (
            item.status !== expectedStatus ||
            !date(item.collectedAt) ||
            typeof item.durationMs !== 'number' ||
            !Number.isFinite(item.durationMs) ||
            item.durationMs < 0 ||
            typeof item.truncated !== 'boolean'
        )
            return invalid();
        if (item.command !== undefined && !text(item.command, 8192)) return invalid();
        return {
            id: item.id,
            status: expectedStatus,
            stdout: item.stdout,
            stderr: item.stderr,
            exitCode: item.exitCode as number | null,
            durationMs: item.durationMs,
            collectedAt: item.collectedAt,
            truncated: item.truncated,
            ...(typeof item.command === 'string' ? { command: item.command } : {}),
        } as Snapshot['results'][number];
    });
    for (const probe of probes) {
        if (!seen.has(probe.id))
            normalized.push({
                id: probe.id,
                status: 'unavailable',
                stdout: '',
                stderr: 'This diagnostic was not collected in the imported report.',
                exitCode: 127,
                durationMs: 0,
                collectedAt: value.capturedAt,
                truncated: false,
            });
    }
    return {
        schemaVersion: 1,
        mode: value.mode,
        endpoint: value.endpoint,
        username: value.username,
        capturedAt: value.capturedAt,
        results: normalized,
    };
}

export function parseReport(content: string): Snapshot {
    if (new TextEncoder().encode(content).byteLength > MAX_REPORT_BYTES)
        throw new Error('The report exceeds the 16 MiB import limit.');
    let data: unknown;
    try {
        data = JSON.parse(content);
    } catch {
        throw new Error('The selected file is not valid JSON.');
    }
    return validateSnapshot(data);
}
