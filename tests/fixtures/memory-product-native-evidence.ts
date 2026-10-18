import assert from 'node:assert/strict';
import fs from 'node:fs';
/** Private final native journal: bounded before writing, every descriptor synced and closed. */
export function writeNativeReceipt(file: string, value: string) {
    const bytes = Buffer.from(value);
    assert.ok(bytes.length <= 128 * 1024, 'Native exit receipt exceeds pre-write bound.');
    const fd = fs.openSync(file, 'wx', 0o600),
        errors: unknown[] = [];
    try {
        fs.writeFileSync(fd, bytes);
    } catch (error) {
        errors.push(error);
    }
    try {
        fs.fsyncSync(fd);
    } catch (error) {
        errors.push(error);
    }
    try {
        fs.closeSync(fd);
    } catch (error) {
        errors.push(error);
    }
    if (errors.length)
        throw new AggregateError(errors, 'Native exit evidence is not durable/closed.');
}
/** Private wrapper keeps the actual report producer and refuses oversize chunks before its file writer. */
export async function* boundedNativeReport(chunks: AsyncIterable<string | Uint8Array>) {
    let bytes = 0;
    for await (const chunk of chunks) {
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        assert.ok(bytes <= 128 * 1024 ** 2, 'Actual native report exceeds private file budget.');
        yield chunk;
    }
}
