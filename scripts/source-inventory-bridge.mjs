import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    observeSourceBridge,
    verifySourceBridge,
    parseSourceBridge,
    SOURCE_LIMITS,
    sourceDigest,
} from './lib/committed-source-bridge.mjs';
import {
    localSourceProvider,
    readStableSourceFile,
    writeSourceBridge,
} from './lib/committed-source-provider.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...raw] = process.argv.slice(2),
    args = new Map();
assert.ok(
    ['observe', 'verify'].includes(mode),
    'Use observe or verify; no product/release operation is supported.',
);
for (const arg of raw) {
    const match = /^--(commit|tree|output|input)=(.+)$/.exec(arg);
    assert.ok(match && !args.has(match[1]), 'Unknown, empty or duplicate source bridge argument.');
    args.set(match[1], match[2]);
}
assert.deepEqual(
    [...args.keys()].sort(),
    mode === 'observe' ? ['commit', 'output', 'tree'] : ['commit', 'input', 'tree'],
);
const expected = { sourceCommit: args.get('commit'), sourceTree: args.get('tree') };
assert.match(expected.sourceCommit, /^[a-f0-9]{40}$/);
assert.match(expected.sourceTree, /^[a-f0-9]{40}$/);
const provider = await localSourceProvider(root);
if (mode === 'observe') {
    const record = await observeSourceBridge(expected, provider),
        file = await writeSourceBridge(root, args.get('output'), record);
    console.log(
        JSON.stringify({
            status: record.status,
            qualification: false,
            releaseAcceptance: false,
            file,
            sourceCommit: record.sourceCommit,
            sourceTree: record.sourceTree,
            sourceFingerprint: record.sourceFingerprint,
            bytesSHA256: sourceDigest(JSON.stringify(record) + '\n'),
        }),
    );
} else {
    const relative = args.get('input');
    assert.ok(
        !path.isAbsolute(relative) && relative.split(/[\\/]/)[0] === 'validation',
        'Read a relative validation/ source bridge.',
    );
    const file = await readStableSourceFile(root, relative, SOURCE_LIMITS.metadata),
        value = parseSourceBridge(file.bytes);
    await verifySourceBridge(value, expected, provider);
    console.log(
        JSON.stringify({
            status: 'verified-non-qualifying-source-bridge',
            qualification: false,
            releaseAcceptance: false,
            sourceCommit: value.sourceCommit,
            sourceTree: value.sourceTree,
            sourceFingerprint: value.sourceFingerprint,
        }),
    );
}
