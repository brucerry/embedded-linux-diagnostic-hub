import assert from 'node:assert/strict';
import { constants as bufferConstants } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const snapshotFields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
function snapshot(stat, maximum) {
    assert.ok(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n,
        'Qualification receipt requires a regular single-link file.',
    );
    for (const field of snapshotFields)
        assert.equal(typeof stat[field], 'bigint', 'Exact receipt file metadata is required.');
    assert.ok(
        stat.size > 0n && stat.size <= BigInt(maximum),
        'Invalid or unbounded qualification receipt.',
    );
    return Object.fromEntries(snapshotFields.map((field) => [field, stat[field]]));
}

/** The injected boundary is for deterministic IO controls; it grants no release authority. */
export function createBoundedReceiptReader(io) {
    return async function readBoundedJSON(file, maximum = 1024 * 1024) {
        assert.ok(typeof file === 'string' && file.length > 0 && !file.includes('\0'));
        assert.ok(
            Number.isSafeInteger(maximum) && maximum > 0 && maximum < bufferConstants.MAX_LENGTH,
            'Invalid qualification receipt byte bound.',
        );
        const before = snapshot(await io.lstat(file, { bigint: true }), maximum);
        let handle;
        let value;
        let failure;
        let failed = false;
        try {
            handle = await io.open(file, io.flags);
            assert.deepEqual(
                snapshot(await handle.stat({ bigint: true }), maximum),
                before,
                'Qualification receipt changed before descriptor acquisition.',
            );
            const size = Number(before.size);
            // One extra byte witnesses growth without ever reading an unbounded stream.
            const bytes = Buffer.alloc(size + 1);
            let offset = 0;
            for (;;) {
                const length = Math.min(64 * 1024, bytes.length - offset);
                const read = await handle.read(bytes, offset, length, offset);
                assert.ok(
                    read.buffer === bytes &&
                        Number.isSafeInteger(read.bytesRead) &&
                        read.bytesRead >= 0 &&
                        read.bytesRead <= length,
                    'Invalid receipt descriptor read acknowledgement.',
                );
                if (read.bytesRead === 0) break;
                offset += read.bytesRead;
                assert.ok(offset <= size, 'Qualification receipt grew during read.');
            }
            assert.equal(offset, size, 'Qualification receipt shrank during read.');
            assert.deepEqual(
                snapshot(await handle.stat({ bigint: true }), maximum),
                before,
                'Qualification receipt descriptor changed during read.',
            );
            assert.deepEqual(
                snapshot(await io.lstat(file, { bigint: true }), maximum),
                before,
                'Qualification receipt path changed during read.',
            );
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                bytes.subarray(0, size),
            );
            value = JSON.parse(text);
        } catch (error) {
            failed = true;
            failure = error;
        } finally {
            if (handle) {
                try {
                    await handle.close();
                } catch (cleanup) {
                    failure = failed
                        ? new AggregateError(
                              [failure, cleanup],
                              'Receipt read and descriptor close both failed.',
                              { cause: failure },
                          )
                        : cleanup;
                    failed = true;
                }
            }
        }
        if (failed) throw failure;
        return value;
    };
}

// Nonblocking prevents a raced POSIX FIFO open from waiting; no-follow is used where supported.
// Descriptor/path metadata comparisons remain mandatory on every platform, before any byte read.
export const readBoundedJSON = createBoundedReceiptReader({
    lstat,
    open,
    flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
});
