import type { ProbeResult, Snapshot } from '../../shared/types';
import type { NetworkOperation, NetworkSection } from '../../shared/diagnostics/network/evidence';

export const maximumCounter = '18446744073709551615';
export const primaryAddress =
    '7: eth0: <UP> mtu 1500 state UP\n    inet 192.0.2.7/24 scope global eth0\n';
const oversizedKey = '9'.repeat(400);
const section = (
    id: string,
    operation: NetworkOperation,
    stdout: string,
    at: string,
): NetworkSection => ({
    id,
    operation,
    stdout,
    stderr: '',
    exitCode: 0,
    status: 'collected',
    collectedAt: at,
    durationMs: 1,
    truncated: false,
    scope: 'all',
    source: 'live',
    command: 'synthetic retained evidence; never execute',
});
const primary = (
    id: string,
    stdout: string,
    at: string,
    sections: NetworkSection[] = [],
): ProbeResult => ({
    id,
    stdout,
    stderr: '',
    exitCode: 0,
    status: 'collected',
    collectedAt: at,
    durationMs: 1,
    truncated: false,
    command: 'synthetic primary; never execute',
    networkEvidence: { version: 1, omissions: [], sections },
});
export interface LanJsonFixture {
    phase: 'malformed-link' | 'address-fallback' | 'exact-counter';
    operation: 'ip-link-json' | 'ip-address-json';
    sourceProbe: 'ethernet' | 'interfaces';
    sourceId: string;
    raw: string;
    warning?: string;
    snapshot: Snapshot;
}
export function lanJsonFixtures(): LanJsonFixture[] {
    const definitions = [
        {
            phase: 'malformed-link',
            operation: 'ip-link-json',
            sourceProbe: 'ethernet',
            sourceId: 'syntax-link',
            raw: `[{"ifname":"fabricated0","ifindex":31,${oversizedKey}:1}]`,
        },
        {
            phase: 'address-fallback',
            operation: 'ip-address-json',
            sourceProbe: 'interfaces',
            sourceId: 'syntax-address',
            raw: `[{"ifname":"fabricated1","ifindex":99,${oversizedKey}:1}]`,
        },
        {
            phase: 'exact-counter',
            operation: 'ip-link-json',
            sourceProbe: 'ethernet',
            sourceId: 'syntax-counter',
            raw: `[{"ifname":"eth0","ifindex":7,"flags":["UP"],"operstate":"UP","mtu":1500,"stats64":{"rx":{"bytes":${maximumCounter}}}}]`,
        },
    ] as const;
    return definitions.map((value, index) => {
        const at = `2026-11-04T00:00:0${index}.000Z`;
        const evidence = section(value.sourceId, value.operation, value.raw, at);
        return {
            ...value,
            ...(value.phase === 'exact-counter'
                ? {}
                : {
                      warning: `Some ${value.sourceId} JSON could not be interpreted; raw evidence is retained.`,
                  }),
            snapshot: {
                schemaVersion: 1,
                mode: 'ssh',
                endpoint: `${value.phase}.synthetic.invalid:22`,
                username: 'fixture',
                capturedAt: at,
                results: [
                    primary('ethernet', '', at, value.sourceProbe === 'ethernet' ? [evidence] : []),
                    primary(
                        'interfaces',
                        value.phase === 'address-fallback' ? primaryAddress : '',
                        at,
                        value.sourceProbe === 'interfaces' ? [evidence] : [],
                    ),
                ],
            },
        };
    });
}
