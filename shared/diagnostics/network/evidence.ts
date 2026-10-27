import type { ProbeResult } from '../../types';
export const NETWORK_OPERATIONS = [
    'ip-address-json',
    'ip-link-json',
    'ip-link-text',
    'ip-route4-json',
    'ip-route4-text',
    'ip-route6-json',
    'ip-route6-text',
    'ip-neighbor-json',
    'ip-neighbor-text',
    'ethtool',
    'iw-info',
    'iw-link',
    'iw-stations',
    'iw-survey',
    'iw-phy',
    'iw-regulatory',
    'iw-version',
    'iw-power-save',
] as const;
export type NetworkOperation = (typeof NETWORK_OPERATIONS)[number];
export interface NetworkSection extends Omit<ProbeResult, 'networkEvidence'> {
    operation: NetworkOperation;
    scope: string;
    source: 'live' | 'cached';
}
export interface NetworkOmission {
    operation: NetworkOperation;
    scope: string;
    reason: string;
}
export interface NetworkEvidence {
    version: 1;
    sections: NetworkSection[];
    omissions: NetworkOmission[];
}
export interface CollectOptions {
    forceNetworkCapabilities?: boolean;
}
export function collectOptions(value: unknown): CollectOptions {
    if (value === undefined) return {};
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => key !== 'forceNetworkCapabilities') ||
        (Object.hasOwn(value, 'forceNetworkCapabilities') &&
            typeof (value as CollectOptions).forceNetworkCapabilities !== 'boolean')
    )
        throw Error('Invalid collection options.');
    return {
        forceNetworkCapabilities: (value as CollectOptions).forceNetworkCapabilities === true,
    };
}
export function shellArgument(value: string): string {
    if (!value || value.length > 128 || /^[\-]/.test(value) || /[\x00-\x1f\x7f]/.test(value))
        throw Error('Unsupported network interface selector.');
    return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function outputBytes(value: { stdout: string; stderr: string }) {
    return new TextEncoder().encode(value.stdout + value.stderr).length;
}
export function validateNetworkEvidence(
    value: unknown,
    primary: { stdout: string; stderr: string },
): NetworkEvidence {
    const invalid = (): never => {
        throw Error('Unsupported network evidence in this report.');
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const raw = value as NetworkEvidence;
    if (
        raw.version !== 1 ||
        !Array.isArray(raw.sections) ||
        raw.sections.length > 96 ||
        !Array.isArray(raw.omissions) ||
        raw.omissions.length > 32
    )
        return invalid();
    const text = (v: unknown, limit: number): v is string =>
        typeof v === 'string' && v.length <= limit;
    const operation = (v: unknown): v is NetworkOperation =>
        NETWORK_OPERATIONS.includes(v as NetworkOperation);
    const scope = (v: unknown): v is string => text(v, 128) && !/[\x00-\x1f\x7f]/.test(v);
    let bytes = outputBytes(primary);
    const seen = new Set<string>();
    const sections = raw.sections.map((s) => {
        if (
            !s ||
            typeof s !== 'object' ||
            !text(s.id, 256) ||
            !s.id ||
            seen.has(s.id) ||
            !operation(s.operation) ||
            !scope(s.scope) ||
            Object.hasOwn(s, 'networkEvidence') ||
            !text(s.command, 8192) ||
            !text(s.stdout, 262144) ||
            !text(s.stderr, 262144) ||
            !['live', 'cached'].includes(s.source) ||
            !text(s.collectedAt, 40) ||
            !Number.isFinite(Date.parse(s.collectedAt)) ||
            !Number.isFinite(s.durationMs) ||
            s.durationMs < 0 ||
            typeof s.truncated !== 'boolean' ||
            (s.exitCode !== null && !Number.isSafeInteger(s.exitCode)) ||
            s.status !==
                (s.exitCode === 0 ? 'collected' : s.exitCode === 127 ? 'unavailable' : 'error')
        )
            return invalid();
        seen.add(s.id);
        bytes += outputBytes(s);
        return {
            id: s.id,
            operation: s.operation,
            scope: s.scope,
            source: s.source,
            command: s.command,
            stdout: s.stdout,
            stderr: s.stderr,
            status: s.status,
            exitCode: s.exitCode,
            durationMs: s.durationMs,
            collectedAt: s.collectedAt,
            truncated: s.truncated,
        };
    });
    if (bytes > 256 * 1024) return invalid();
    const omissions = raw.omissions.map((o) => {
        if (!o || !operation(o.operation) || !scope(o.scope) || !text(o.reason, 512))
            return invalid();
        return { operation: o.operation, scope: o.scope, reason: o.reason };
    });
    return { version: 1, sections, omissions };
}
export function evidenceReason(
    result: Pick<ProbeResult, 'status' | 'stderr' | 'truncated' | 'exitCode'>,
): string {
    if (result.truncated) return 'Limited / truncated';
    if (result.status === 'collected') return 'Collected';
    if (/permission denied|operation not permitted|not authorized/i.test(result.stderr))
        return 'Permission denied';
    if (/timed out|deadline/i.test(result.stderr)) return 'Timed out';
    if (
        /not supported|unsupported|invalid option|unrecognized option|unknown option|not implemented/i.test(
            result.stderr,
        )
    )
        return 'Unsupported';
    if (result.exitCode === 127) return 'Missing tool / unavailable';
    if (/disconnected|no such device|network is down/i.test(result.stderr))
        return 'Disconnected / interface unavailable';
    return 'Command failed';
}
export function unsupportedFormat(result: Pick<ProbeResult, 'status' | 'stderr'>): boolean {
    return (
        result.status !== 'collected' &&
        /(?:invalid|unrecognized|unknown|unsupported|illegal) option|option.*(?:not recognized|not supported)|BusyBox.*Usage:/is.test(
            result.stderr,
        )
    );
}
