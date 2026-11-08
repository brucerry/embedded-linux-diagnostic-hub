/** A received negative reply is safe only when it proves this exact request was not admitted. */
export interface ExportNonAdmission {
    version: 1;
    requestId: string;
    state: 'not-admitted';
}

export function isExportNonAdmissionReply(input: unknown, requestId: string): boolean {
    if (!input || typeof input !== 'object') return false;
    const reply = input as { ok?: unknown; error?: unknown; nonAdmission?: unknown };
    if (
        reply.ok !== false ||
        typeof reply.error !== 'string' ||
        reply.error.length > 512 ||
        !reply.nonAdmission ||
        typeof reply.nonAdmission !== 'object' ||
        Array.isArray(reply.nonAdmission)
    )
        return false;
    const receipt = reply.nonAdmission as Record<string, unknown>;
    return (
        Object.keys(receipt).sort().join(',') === 'requestId,state,version' &&
        receipt.version === 1 &&
        receipt.state === 'not-admitted' &&
        receipt.requestId === requestId
    );
}
