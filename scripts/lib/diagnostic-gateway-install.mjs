import assert from 'node:assert/strict';
import path from 'node:path';
import { parseGatewayArchiveBuildRecord } from './gateway-build-record.mjs';
import { openGatewayArchiveBytes } from './inner-archive-inspection.mjs';

/** Checked member copies into a NEW owned namespace only. Explicit owned file ports must retain
 * rejected/unknown acquisition and write custody. No extraction subprocess, chmod, deletion or retry.
 */
export async function prepareDiagnosticGatewayInstall(archive, recordBytes, expected, directory, filesystem, writeExclusive) {
    assert.ok(directory.startsWith('/') && path.posix.normalize(directory) === directory && directory.endsWith('/validation/gateway-runtime'));
    assert.equal(typeof writeExclusive, 'function');
    const record = parseGatewayArchiveBuildRecord(recordBytes, expected);
    const contents = openGatewayArchiveBytes(archive, record);
    try {
        assert.equal(await filesystem.realpath(path.dirname(directory)), path.dirname(directory));
        await filesystem.mkdir(directory); // EEXIST refuses previous work; no adoption.
        for (const leaf of ['install', 'cache', 'config']) await filesystem.mkdir(directory + '/' + leaf);
        for (const leaf of ['dist-gateway', 'docs', 'gateway']) await filesystem.mkdir(directory + '/install/' + leaf);
        await writeExclusive(directory + '/config/user.npmrc', Buffer.alloc(0));
        await writeExclusive(directory + '/config/global.npmrc', Buffer.alloc(0));
        for (const file of record.payload) await writeExclusive(directory + '/install/' + file.path, contents.read(file.path));
        return Object.freeze({ directory, installRoot: directory + '/install', files: record.payload.length });
    } finally { contents.releaseBytes(); }
}
