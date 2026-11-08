// Synthetic sequential link observations. No command is executed.
export const NETWORK_IDENTITY_AT = '2028-02-29T12:00:00.000Z';
export function networkIdentityReport() {
    const probe = (id: string, stdout = '') => ({
        id,
        stdout,
        stderr: '',
        status: 'collected',
        exitCode: 0,
        collectedAt: NETWORK_IDENTITY_AT,
        durationMs: 1,
        truncated: false,
    });
    const section = (id: string, operation: string, stdout: string) => ({
        ...probe(id, stdout),
        operation,
        scope: 'all',
        source: 'live',
        command: 'synthetic retained observation; never execute',
    });
    return {
        schemaVersion: 1,
        mode: 'ssh',
        endpoint: 'synthetic.invalid:22',
        username: 'fixture',
        capturedAt: NETWORK_IDENTITY_AT,
        results: [
            {
                ...probe('ethernet'),
                networkEvidence: {
                    version: 1,
                    omissions: [],
                    sections: [
                        section(
                            'links',
                            'ip-link-json',
                            JSON.stringify([
                                {
                                    ifname: 'eth0',
                                    ifindex: 7,
                                    flags: ['UP'],
                                    operstate: 'UP',
                                    mtu: 1500,
                                },
                                {
                                    ifname: 'eth0',
                                    ifindex: 19,
                                    flags: [],
                                    operstate: 'DOWN',
                                    mtu: 9000,
                                },
                                { ifname: 'eth1', flags: ['UP'], operstate: 'UNKNOWN', mtu: 1200 },
                            ]),
                        ),
                    ],
                },
            },
            {
                ...probe('interfaces'),
                networkEvidence: {
                    version: 1,
                    omissions: [],
                    sections: [
                        section(
                            'addresses',
                            'ip-address-json',
                            JSON.stringify([
                                {
                                    ifname: 'eth0',
                                    ifindex: 7,
                                    addr_info: [
                                        { family: 'inet', local: '192.0.2.7', prefixlen: 24 },
                                    ],
                                },
                                {
                                    ifname: 'eth0',
                                    ifindex: 19,
                                    addr_info: [
                                        { family: 'inet', local: '192.0.2.19', prefixlen: 24 },
                                    ],
                                },
                            ]),
                        ),
                    ],
                },
            },
        ],
    };
}
