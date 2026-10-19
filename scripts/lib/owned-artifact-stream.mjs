// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';

const readers = new Map();
export const artifactReaderState = () => [...readers.values()].map((value) => ({ ...value }));
export function assertArtifactReadersClosed() {
    assert(readers.size === 0, 'Owned artifact readers remain open/uncertain');
}

/** Identity-bound EOF and successful descriptor closure precede semantic acknowledgement. */
/** @param {string} file @param {(chunks:AsyncIterable<Uint8Array>)=>Promise<any>} validate @param {{limit?:number,expectedBytes?:number,io?:any,signal?:AbortSignal}} options */
export async function inspectOwnedArtifact(
    file,
    validate,
    { limit = 134217728, expectedBytes, io = fsp, signal } = {},
) {
    assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 134217728);
    signal?.throwIfAborted();
    const before = await io.lstat(file, { bigint: true });
    assert(
        before.isFile() &&
            !before.isSymbolicLink() &&
            before.nlink === 1n &&
            before.size > 0n &&
            before.size <= BigInt(limit),
        'Owned artifact invalid/oversized',
    );
    if (expectedBytes !== undefined)
        assert(before.size === BigInt(expectedBytes), 'Artifact byte receipt mismatch');
    signal?.throwIfAborted();
    assertArtifactReadersClosed();
    const prefix = Buffer.alloc(64),
        buffer = Buffer.alloc(65536),
        hash = createHash('sha256');
    const handle = await io.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    readers.set(handle, { file, phase: 'reading' });
    const same = (value) => {
        assert(value.isFile() && !value.isSymbolicLink());
        for (const key of ['dev', 'ino', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
            assert(value[key] === before[key], 'Owned artifact rebound/mutated: ' + key);
    };
    let eof = false,
        started = false,
        bytes = 0,
        digest = '';
    let prefixBytes = 0;
    async function* chunks() {
        assert(!started, 'Artifact stream reused');
        started = true;
        for (;;) {
            signal?.throwIfAborted();
            const read = await handle.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) break;
            const part = buffer.subarray(0, read.bytesRead);
            bytes += part.length;
            assert(bytes <= limit && BigInt(bytes) <= before.size, 'Artifact grew during read');
            hash.update(part);
            if (prefixBytes < 64) {
                const n = Math.min(64 - prefixBytes, part.length);
                part.copy(prefix, prefixBytes, 0, n);
                prefixBytes += n;
            }
            yield part;
        }
        assert(BigInt(bytes) === before.size, 'Artifact truncated during read');
        same(await handle.stat({ bigint: true }));
        same(await io.lstat(file, { bigint: true }));
        digest = hash.digest('hex');
        eof = true;
    }
    let result;
    try {
        same(await handle.stat({ bigint: true }));
        result = await validate(chunks());
        signal?.throwIfAborted();
        assert(eof, 'Semantic validator returned before exact artifact EOF');
    } finally {
        try {
            await handle.close();
            readers.delete(handle);
        } catch (error) {
            readers.set(handle, {
                file,
                phase: 'close-failed',
                error: String(error).slice(0, 512),
            });
            throw error;
        }
    }
    return {
        result,
        bytes,
        sha256: digest,
        prefix: prefix.subarray(0, prefixBytes),
        readBufferBytes: buffer.length,
        descriptorClosed: true,
        wholeFileMaterialized: false,
    };
}
export async function inspectViewerArtifact(file, expectedBytes, options = {}) {
    return inspectOwnedArtifact(
        file,
        async (chunks) => {
            for await (const ignored of chunks) void ignored;
            return null;
        },
        { ...options, expectedBytes },
    );
}
