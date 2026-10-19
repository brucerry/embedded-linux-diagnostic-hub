import assert from 'node:assert/strict';
/** Additive transport charges. Packet bytes are informational for extent transport, not double-counted. */
export class SoakPhysicalCharges {
    constructor() {
        this.totals = {
            packetBytes: 0,
            localPacketBytes: 0,
            localEnvelopeBytes: 0,
            extentBase64Bytes: 0,
            extentEnvelopeBytes: 0,
            commitBytes: 0,
            controlBytes: 0,
            physicalBytes: 0,
            physicalRows: 0,
            localTransactions: 0,
            extentTransactions: 0,
        };
    }
    observe(row, bytes) {
        assert(Number.isSafeInteger(bytes) && bytes > 0);
        const t = this.totals;
        t.physicalRows++;
        t.physicalBytes += bytes;
        if (row.kind === 'soak-local') {
            assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes < bytes);
            t.packetBytes += row.bytes;
            t.localPacketBytes += row.bytes;
            t.localEnvelopeBytes += bytes - row.bytes;
            t.localTransactions++;
        } else if (row.kind === 'soak-extent') {
            const base64Bytes =
                typeof row.base64 === 'string' ? row.base64.length : row.base64Bytes;
            assert(Number.isSafeInteger(base64Bytes) && base64Bytes > 0 && base64Bytes < bytes);
            if (row.index === 0) {
                t.packetBytes += row.bytes;
                t.extentTransactions++;
            }
            t.extentBase64Bytes += base64Bytes;
            t.extentEnvelopeBytes += bytes - base64Bytes;
        } else if (row.kind === 'soak-commit') t.commitBytes += bytes;
        else t.controlBytes += bytes;
        assert(
            t.localPacketBytes +
                t.localEnvelopeBytes +
                t.extentBase64Bytes +
                t.extentEnvelopeBytes +
                t.commitBytes +
                t.controlBytes ===
                t.physicalBytes,
            'Physical charge conservation',
        );
    }
    snapshot() {
        return { ...this.totals };
    }
}
