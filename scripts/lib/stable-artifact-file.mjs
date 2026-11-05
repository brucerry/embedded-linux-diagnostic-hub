import assert from 'node:assert/strict';
import path from 'node:path';
import { WEB_ARCHIVE_LIMITS } from './web-archive-limits.mjs';

export async function readStableArtifactFile(root, relative, maximum, filesystem) {
    assert.ok(path.isAbsolute(root));
    assert.ok(
        Number.isSafeInteger(maximum) && maximum > 0 && maximum <= WEB_ARCHIVE_LIMITS.archive,
    );
    assert.ok(typeof relative === 'string' && relative && !/[\\:\x00-\x1f\x7f]/.test(relative));
    assert.ok(relative.split('/').every((part) => part && part !== '.' && part !== '..'));
    const file = path.join(root, relative);
    assert.equal(await filesystem.realpath(file), file);
    const before = await filesystem.lstat(file);
    const same = (value) => {
        assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
        for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'])
            assert.equal(value[key], before[key]);
    };
    same(before);
    assert.ok(Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= maximum);
    const handle = await filesystem.open(file, 'r'),
        errors = [];
    let value;
    try {
        same(await handle.stat());
        const chunks = [],
            buffer = Buffer.alloc(Math.min(65536, before.size + 1));
        let total = 0;
        for (;;) {
            const { bytesRead } = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, maximum + 1 - total),
                null,
            );
            if (!bytesRead) break;
            total += bytesRead;
            assert.ok(total <= maximum);
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        assert.equal(total, before.size);
        same(await handle.stat());
        same(await filesystem.lstat(file));
        assert.equal(await filesystem.realpath(file), file);
        value = { bytes: Buffer.concat(chunks) };
    } catch (error) {
        errors.push(error);
    }
    try {
        await handle.close();
    } catch (error) {
        errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
        throw new AggregateError(errors, 'Artifact read/close failed.', { cause: errors[0] });
    assert.ok(value);
    return value;
}
