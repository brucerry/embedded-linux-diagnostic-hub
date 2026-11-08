import assert from 'node:assert/strict';

const issued = new WeakMap<object, object>();
const closureBrand: unique symbol = Symbol('verified-product-parent-closure');

/** A process/connection join receipt, never a successful per-cycle worker retirement. */
export type ProductParentClosure = Readonly<{
    disposition: 'verified-parent-closure';
    hostId: string;
    pageClosed: true;
    connectionClosed: true;
    processHistoryExited: true;
    [closureBrand]: true;
}>;

/** The host binds these reads/joins to its actual page, connection and process sampler. */
export function createProductParentClosureWitness(input: {
    page: object;
    hostId: string;
    hostCleanupVerified(): boolean;
    pageClosed(): boolean;
    connectionClosed(): boolean;
    joinProcessHistory(): Promise<void>;
}) {
    assert.ok(input.hostId);
    const { page, hostId, hostCleanupVerified, pageClosed, connectionClosed, joinProcessHistory } =
        input;
    let receipt: ProductParentClosure | undefined;
    function requireClosed() {
        assert.equal(hostCleanupVerified(), true, 'Parent host cleanup is unverified.');
        assert.equal(pageClosed(), true, 'Exact parent page remains live or unknown.');
        assert.equal(connectionClosed(), true, 'Exact parent connection remains live or unknown.');
    }
    return {
        async join(): Promise<ProductParentClosure> {
            requireClosed();
            // The actual PID/creation sampler must join; caller-supplied booleans cannot
            // replace a failed, missing or ambiguous process-history acknowledgement.
            await joinProcessHistory();
            requireClosed();
            if (!receipt) {
                const next: ProductParentClosure = Object.freeze({
                    disposition: 'verified-parent-closure',
                    hostId,
                    pageClosed: true,
                    connectionClosed: true,
                    processHistoryExited: true,
                    [closureBrand]: true as const,
                });
                issued.set(next, page);
                receipt = next;
            }
            return receipt;
        },
    };
}

export function requireProductParentClosure(value: ProductParentClosure, page: object) {
    assert.ok(
        value && issued.get(value) === page,
        'Missing, forged or unrelated parent-closure receipt.',
    );
    return value;
}
