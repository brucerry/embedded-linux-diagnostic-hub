// Separate inert stage: no downloader, package installation, Gateway or SSH launch.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedWebFiles } from './lib/owned-web-files.mjs';
import { readCurrentGatewayBuildFile } from './lib/current-gateway-build.mjs';
import {
    parseGatewayPackageHandoff,
    verifyGatewayRuntimePackage,
} from './lib/gateway-package-handoff.mjs';
import { startInstrumentedChildOutput } from './lib/instrumented-gateway-output.mjs';

let outputAttempted = false;
async function emit(which, bytes) {
    assert.equal(outputAttempted, false);
    outputAttempted = true;
    await startInstrumentedChildOutput(bytes, process[which], () => {
        process.exitCode = 1;
    }).result;
}

export async function readGatewayRuntimePackage(bytes, originalSHA256, source, root, files, uid) {
    assert.match(originalSHA256, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), originalSHA256);
    const selected = parseGatewayPackageHandoff(bytes);
    const read = (name, limit) => readCurrentGatewayBuildFile(root + '/' + name, limit, uid, files);
    const stage = 'validation/gateway-current-build';
    const name = selected.artifacts[0].name;
    const input = {
        recordBytes: await read(stage + '/artifacts/gateway-build.json', 16 * 1024 ** 2),
        archiveBytes: await read(stage + '/artifacts/' + name, 128 * 1024 ** 2),
        checksumBytes: await read(stage + '/artifacts/' + name + '.sha256', 1024),
        compiledBytes: await read(stage + '/build/main.cjs', 64 * 1024 ** 2),
        sourcePackageBytes: await read('package.json', 4 * 1024 ** 2),
        sourceLockBytes: await read('package-lock.json', 4 * 1024 ** 2),
    };
    const record = verifyGatewayRuntimePackage(bytes, input, source);
    return { selected, record, readback: input };
}
export async function checkGatewayRuntimePackage(...args) {
    return (await readGatewayRuntimePackage(...args)).selected;
}
async function main() {
    try {
        assert.equal(process.argv.length, 5);
        const parts = [];
        let total = 0,
            chunks = 0;
        for await (const part of process.stdin) {
            total += part.length;
            assert.ok(Buffer.isBuffer(part) && total <= 16 * 1024 && ++chunks <= 1024);
            parts.push(part);
        }
        const owned = createOwnedWebFiles(fs);
        const root = await fs.realpath(process.cwd());
        await checkGatewayRuntimePackage(
            Buffer.concat(parts),
            process.argv[2],
            {
                sourceCommit: process.argv[3],
                sourceTree: process.argv[4],
            },
            root,
            owned.filesystem,
            process.getuid(),
        );
        owned.owner.assertSettled();
        await emit(
            'stdout',
            Buffer.from(
                'Gateway runtime package readback verified; no execution or release qualification.\n',
            ),
        );
    } catch {
        process.exitCode = 1;
        if (!outputAttempted) {
            try {
                await emit(
                    'stderr',
                    Buffer.from(
                        'Gateway runtime package readback refused; no runtime submitted.\n',
                    ),
                );
            } catch {
                /* Original output uncertainty is retained; no retry. */
            }
        }
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main();
}
