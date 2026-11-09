import { INSTALLATION_PRODUCT } from './installation.ts';

export interface SetupBootIdentity {
    transactionId: string;
    installationId: string;
    manifestSHA256: string;
    version: string;
    root: string;
    nativeExecutable: string;
}

/** Matches shared ACK identity fields; callers retain their native/profile/age checks. */
export function matchesSetupBootIdentity(
    input: unknown,
    expected: SetupBootIdentity,
    samePath: (actual: string, expected: string) => boolean,
): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const ack = input as Record<string, unknown>;
    if (ack.schemaVersion !== 1 || ack.product !== INSTALLATION_PRODUCT) return false;
    for (const key of ['transactionId', 'installationId', 'manifestSHA256', 'version'] as const) {
        if (typeof expected[key] !== 'string' || typeof ack[key] !== 'string') return false;
        if (ack[key] !== expected[key]) return false;
    }
    return (
        typeof expected.root === 'string' &&
        typeof ack.root === 'string' &&
        typeof expected.nativeExecutable === 'string' &&
        typeof ack.nativeExecutable === 'string' &&
        samePath(ack.root, expected.root) &&
        samePath(ack.nativeExecutable, expected.nativeExecutable)
    );
}
