export type ConnectionFailureCode =
    'network' | 'authentication' | 'host-key' | 'policy' | 'cancelled' | 'cleanup';

export class ConnectionFailure extends Error {
    constructor(
        public readonly code: ConnectionFailureCode,
        message: string,
    ) {
        super(message);
        this.name = 'ConnectionFailure';
    }
}

export function connectionFailure(error: unknown): ConnectionFailure {
    if (error instanceof ConnectionFailure) return error;
    // contextBridge copies Error messages but does not preserve custom properties/prototypes.
    const encoded =
        error instanceof Error ? /^HUB_CONNECTION_FAILURE:([a-z-]+)$/.exec(error.message) : null;
    if (encoded && Object.hasOwn(CONNECTION_FAILURE_MESSAGES, encoded[1])) {
        const code = encoded[1] as ConnectionFailureCode;
        return new ConnectionFailure(code, CONNECTION_FAILURE_MESSAGES[code]);
    }
    if (
        error &&
        typeof error === 'object' &&
        (('level' in error && error.level === 'client-authentication') ||
            ('code' in error && [13, 14, 15].includes(error.code as number)))
    )
        return new ConnectionFailure(
            'authentication',
            'SSH authentication failed. Correct the credentials and connect again.',
        );
    return new ConnectionFailure('network', 'SSH connection failed. Check the target and network.');
}

export function connectionAttemptId(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value))
        throw new ConnectionFailure('policy', 'Invalid connection attempt.');
    return value;
}

export const CONNECTION_FAILURE_MESSAGES: Record<ConnectionFailureCode, string> = {
    network: 'SSH connection failed. Check the target and network.',
    authentication: 'SSH authentication failed. Correct the credentials and connect again.',
    'host-key': 'SSH host identity was not approved. Verify the device and connect again.',
    policy: 'Connection settings or access policy were rejected. Correct them and connect again.',
    cancelled: 'Connection cancelled.',
    cleanup: 'Could not confirm connection cleanup. Reconnect only after checking the gateway.',
};
