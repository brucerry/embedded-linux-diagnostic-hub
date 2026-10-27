import {
    appendFrames,
    bytesBase64,
    CaptureStorageError,
    newCapture,
    storedCapture,
    type CaptureRepository,
    type StoredCapture,
} from './capture-store';

/** Complete raw evidence is streamed; bounded preview text is never used as an export source. */
export async function* streamCaptureJson(
    store: CaptureRepository,
    id: string,
): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    let metadata: StoredCapture | undefined,
        verified: StoredCapture | undefined,
        count = 0;
    for await (const event of store.read(id)) {
        if (event.type === 'metadata') {
            if (metadata) throw new CaptureStorageError('integrity', 'Duplicate capture metadata.');
            metadata = storedCapture(event.capture);
            if (metadata.state === 'active')
                throw new CaptureStorageError(
                    'busy',
                    'Finish or cancel capture before exporting it.',
                );
            verified = newCapture(metadata.id, metadata.sequence, metadata.header);
            yield encoder.encode(
                '{"schemaVersion":3,"capture":' +
                    JSON.stringify(metadata) +
                    ',"outcome":' +
                    JSON.stringify((await store.result?.(id)) ?? null) +
                    ',"rawObservations":[',
            );
        } else {
            if (!metadata || !verified)
                throw new CaptureStorageError(
                    'integrity',
                    'Capture data arrived before its metadata.',
                );
            verified = appendFrames(verified, [event.frame]);
            const { bytes, ...provenance } = event.frame;
            yield encoder.encode(
                (count++ ? ',' : '') +
                    JSON.stringify({ ...provenance, base64: bytesBase64(bytes) }),
            );
        }
    }
    if (
        !metadata ||
        !verified ||
        metadata.committedBytes !== verified.committedBytes ||
        metadata.committedFrames !== verified.committedFrames ||
        metadata.observations !== verified.observations ||
        metadata.firstReceivedAt !== verified.firstReceivedAt ||
        metadata.lastReceivedAt !== verified.lastReceivedAt ||
        JSON.stringify(metadata.pendingObservation) !== JSON.stringify(verified.pendingObservation)
    )
        throw new CaptureStorageError(
            'integrity',
            'Stored raw evidence does not match its committed counters.',
        );
    yield encoder.encode(
        '],"captureComplete":' +
            String(metadata.state === 'complete') +
            ',"verifiedCommittedBytes":' +
            verified.committedBytes +
            '}\n',
    );
}
