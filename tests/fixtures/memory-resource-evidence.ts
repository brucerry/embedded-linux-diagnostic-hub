import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

/** Attempt every sync and every close even when an earlier operation fails. */
export async function syncCloseEvidence(
    handles: { sync(): Promise<unknown>; close(): Promise<unknown> }[],
) {
    const errors: unknown[] = [];
    await Promise.all(
        handles.map(async (handle) => {
            try {
                await handle.sync();
            } catch (error) {
                errors.push(error);
            }
            try {
                await handle.close();
            } catch (error) {
                errors.push(error);
            }
        }),
    );
    return errors;
}
export async function writeDurableEvidence(file: string, bytes: string) {
    const handle = await fs.open(file, 'wx');
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}
/** An actual bounded read, including files that grow after stat; never read-then-truncate. */
export async function readEvidence(file: string, maximumBytes: number) {
    assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes > 0);
    const handle = await fs.open(file, 'r');
    try {
        const info = await handle.stat();
        assert.ok(info.isFile() && info.size <= maximumBytes, 'Evidence file bound exceeded.');
        const bytes = Buffer.alloc(maximumBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        assert.ok(offset <= maximumBytes, 'Evidence grew beyond its byte bound.');
        return bytes.toString('utf8', 0, offset);
    } finally {
        await handle.close();
    }
}
