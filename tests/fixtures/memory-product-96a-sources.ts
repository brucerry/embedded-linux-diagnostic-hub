/** Frozen test data only. Never import or run these historical product sources. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import inventory from './memory-product-96a-sources.json';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const archiveSHA256 = '29122c4c5f3bd9b9e2029132667ae0479a673b8f5912db06478fef9f5b169d71';
const rawSHA256 = '4a91a5fe18db739ace744d97ac1d8ec639d2bbc4231ab4daee4c55154cd57cd0';
export const historicalProductCommit = '96a56cdbb462320c54fe74022d7436e665a31d31';

export function decodeHistoricalProductSources(archive: Uint8Array) {
    if (
        createHash('sha256').update(JSON.stringify(inventory)).digest('hex') !==
        '40d509ff9aede2840e716f8ff7f91b0aca49dd58d7a7586282079950c3cc1f66'
    )
        throw Error('Historical product manifest changed.');
    if (hash(archive) !== archiveSHA256) throw Error('Historical product archive changed.');
    const bytes = gunzipSync(archive, { maxOutputLength: 515913 });
    if (bytes.length !== 515913 || hash(bytes) !== rawSHA256)
        throw Error('Historical product source bytes changed.');
    if (inventory.sourceCommit !== historicalProductCommit || inventory.files.length !== 25)
        throw Error('Historical product inventory changed.');
    let offset = 0;
    const sources = new Map<string, string>();
    for (const row of inventory.files) {
        if (sources.has(row.path) || !/^(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.tsx?$/.test(row.path))
            throw Error('Historical product path is not canonical.');
        const source = bytes.subarray(offset, offset + row.bytes);
        offset += row.bytes;
        if (hash(source) !== row.sha256)
            throw Error('Historical product preimage changed: ' + row.path);
        const gitBlob = createHash('sha1')
            .update('blob ' + source.length + '\0')
            .update(source)
            .digest('hex');
        if (gitBlob !== row.gitBlob)
            throw Error('Historical product Git blob changed: ' + row.path);
        sources.set(row.path, source.toString('utf8'));
    }
    if (offset !== bytes.length) throw Error('Historical product inventory incomplete.');
    return sources;
}

let materialization: Promise<string> | undefined;
/** Own, bounded temporary source data: no package, compiler, runtime or app is launched. */
export function historicalProductSourceRoot() {
    return (materialization ??= (async () => {
        const archive = await fs.readFile(
            new URL('./memory-product-96a-sources.blobs.gz', import.meta.url),
        );
        const sources = decodeHistoricalProductSources(archive);
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-product-96a-data-'));
        for (const [file, source] of sources) {
            const target = path.join(root, file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, source, { flag: 'wx', mode: 0o400 });
        }
        return root;
    })());
}
