import type { CaptureFrame } from '../../shared/capture-store';

/** Browser-safe verifier for the existing private fixture; never alters its output geometry. */
export class SerialGeometryRead {
    private rows: [number, string, string][] = [];
    private remaining: number;
    private tailBytes: Uint8Array;
    private prompt = new TextEncoder().encode('\r\nqualification# ');
    private failure: unknown;
    constructor(
        private bodyBytes: number,
        tail: string,
    ) {
        if (
            !Number.isSafeInteger(bodyBytes) ||
            bodyBytes < 0 ||
            bodyBytes > 64 * 1024 ** 2 ||
            typeof tail !== 'string'
        )
            throw Error('Invalid selected geometry expectation.');
        this.remaining = bodyBytes;
        this.tailBytes = new TextEncoder().encode(tail);
        if (this.tailBytes.length > Math.min(256, bodyBytes))
            throw Error('Invalid selected tail expectation.');
    }
    append(frame: CaptureFrame) {
        if (this.failure) throw this.failure;
        try {
            const length = this.remaining ? Math.min(16384, this.remaining) : this.prompt.length;
            if (
                this.rows.length >= 4097 ||
                frame.observation !== this.rows.length ||
                frame.stream !== 'serial' ||
                frame.offset !== 0 ||
                frame.totalBytes !== length ||
                frame.bytes.length !== length
            )
                throw Error('Selected Serial observation geometry mismatch.');
            if (this.rows.length >= Math.ceil(this.bodyBytes / 16384) + 1)
                throw Error('Unexpected observation after prompt.');
            for (let i = 0; i < length; i++) {
                const absolute = this.bodyBytes - this.remaining + i,
                    start = this.bodyBytes - this.tailBytes.length;
                const expected = this.remaining
                    ? absolute >= start
                        ? this.tailBytes[absolute - start]
                        : 120
                    : this.prompt[i];
                if (frame.bytes[i] !== expected)
                    throw Error(
                        'Selected Serial full raw bytes differ from producer body/tail/prompt.',
                    );
            }
            if (
                typeof frame.receivedAt !== 'string' ||
                !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(frame.receivedAt) ||
                !/^[a-f0-9]{8}$/.test(frame.crc32)
            )
                throw Error('Missing observation timestamp/CRC provenance.');
            this.rows.push([frame.observation, frame.receivedAt, frame.crc32]);
            this.remaining = Math.max(0, this.remaining - length);
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }
    finish() {
        if (this.failure) throw this.failure;
        if (this.remaining || this.rows.length !== Math.ceil(this.bodyBytes / 16384) + 1)
            throw Error('Incomplete selected Serial observations.');
        return {
            schema: 1,
            expectedChunkBytes: 16384,
            actualChunkBytes: 16384,
            bodyBytes: this.bodyBytes,
            promptBytes: this.prompt.length,
            bodyObservations: Math.ceil(this.bodyBytes / 16384),
            observations: this.rows.length,
            shared: {
                stream: 'serial',
                offset: 0,
                lengthRule: 'min(remaining body bytes,16384), followed by one exact17-byte prompt',
            },
            provenanceColumns: ['observation', 'receivedAt', 'crc32'],
            provenance: this.rows,
            everyRawByteVerified: true,
            producerTimestampClaim: false,
            timestampMeaning:
                'Original persisted host receive time; no device emission-time claim.',
        };
    }
}
