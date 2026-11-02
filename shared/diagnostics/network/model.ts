import type { ProbeResult, Snapshot } from '../../types';
import type { NetworkOperation, NetworkSection } from './evidence';
export interface DetailField {
    label: string;
    value: string;
}
export interface DetailGroup {
    id: string;
    title: string;
    fields: DetailField[];
    source?: string;
    note?: string;
}
export interface InterfaceSummary {
    id: string;
    name: string;
    kind: string;
    mode?: string;
    phy?: string;
    ifindex?: number;
    state?: string;
    admin?: string;
    carrier?: string;
    mac?: string;
    mtu?: string;
    ssid?: string;
    bssid?: string;
    association?: string;
    frequency?: number;
    channel?: string;
    width?: string;
    txPower?: string;
    signal?: string;
    noise?: string;
    peers?: number;
    groups: DetailGroup[];
}
export interface NetworkSummary {
    interfaces: InterfaceSummary[];
    groups: DetailGroup[];
    warnings: string[];
}
const scalar = (value: unknown): value is string | number | boolean =>
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
export function field(label: string, value: unknown): DetailField[] {
    if (value === undefined || value === null) return [];
    let readable = 'Not interpretable; inspect raw evidence.';
    if (scalar(value)) readable = String(value);
    else if (Array.isArray(value) && value.every(scalar)) readable = value.join(', ');
    return [{ label, value: readable }];
}
export const result = (snapshot: Snapshot, id: string) => snapshot.results.find((r) => r.id === id);
export function section(
    snapshot: Snapshot,
    id: string,
    operation: NetworkOperation,
): NetworkSection[] {
    return (
        result(snapshot, id)?.networkEvidence?.sections.filter((s) => s.operation === operation) ??
        []
    );
}
export function source(r: ProbeResult & { source?: string }): string {
    return (
        (r.source === 'cached' ? 'Cached · ' : '') +
        r.collectedAt +
        (r.truncated ? ' · truncated' : '')
    );
}
export function group(
    id: string,
    title: string,
    fields: DetailField[],
    r?: ProbeResult,
): DetailGroup {
    return { id, title, fields, ...(r ? { source: source(r) } : {}) };
}
export function safeNumber(value: unknown): number | undefined {
    const number =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && /^\d+$/.test(value)
              ? Number(value)
              : NaN;
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
export function parseWarnings(warnings: string[]): string[] {
    return [...new Set(warnings)].slice(0, 16);
}
