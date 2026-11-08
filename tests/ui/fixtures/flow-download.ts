import type { Download } from '@playwright/test';

export const FLOW_FILE_READ_BYTES = 8 * 1024 * 1024;
export const FLOW_COHORT_READ_BYTES = 32 * 1024 * 1024;

/** Read only an SDK-owned download, with byte limits; this is not a filesystem quota. */
export async function readFlowDownload(
    download: Pick<Download, 'failure' | 'createReadStream'>,
    remainingBytes: number,
): Promise<Buffer> {
    if (
        !Number.isSafeInteger(remainingBytes) ||
        remainingBytes < 0 ||
        remainingBytes > FLOW_COHORT_READ_BYTES
    )
        throw Error('Invalid remaining flow-download read budget.');
    const failure = await download.failure();
    if (failure !== null) throw Error('Flow export download failed: ' + failure);
    const stream = await download.createReadStream();
    if (!stream) throw Error('Flow export download has no readable stream.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw Error('Flow download returned non-byte data.');
        bytes += chunk.byteLength;
        if (bytes > FLOW_FILE_READ_BYTES || bytes > remainingBytes)
            throw Error('Flow download exceeds its test read budget.');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, bytes);
}
