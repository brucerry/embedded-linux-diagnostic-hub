import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SSH2_BIGINT_GENERATED_SOURCE = '(function anonymous(\n) {\nreturn 2n ** 32n\n})';
export const SSH2_BIGINT_ORIGIN_SHA256 =
    'd46a25cc158456c4a82b686ceed9a8267dc7d1bb69b6fd1d1f9b09d467951b4d';
const integrity =
    'sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==';
const hash = (b) => createHash('sha256').update(b).digest('hex');
/** A prelaunch plan, never expanded from Inspector notifications. This is one known pure constant
 * constructor site, not generic eval support. Runtime admission also requires the exact source
 * AND Inspector's creation frame bound to this verified file/site/context.
 */
export function deriveInstrumentedGeneratedInventory(scripts, root) {
    assert.ok(
        typeof root === 'string' &&
            root.startsWith('/') &&
            path.posix.normalize(root) === root &&
            Buffer.byteLength(root) <= 4096 &&
            !/[\\\x00-\x20\x7f]/.test(root),
    );
    const originPath = path.posix.join(root, 'node_modules/ssh2/lib/protocol/node-fs-compat.js'),
        bytes = scripts.get(originPath);
    assert.ok(Buffer.byteLength(originPath) <= 4096);
    if (bytes === undefined) return [];
    assert.ok(
        Buffer.isBuffer(bytes) &&
            bytes.length === 3647 &&
            hash(bytes) === SSH2_BIGINT_ORIGIN_SHA256,
        'Unsupported generated-code origin.',
    );
    const packageBytes = scripts.get(root + '/node_modules/ssh2/package.json'),
        lockBytes = scripts.get(root + '/package-lock.json');
    assert.ok(
        Buffer.isBuffer(packageBytes) &&
            packageBytes.length <= 1024 ** 2 &&
            Buffer.isBuffer(lockBytes) &&
            lockBytes.length <= 1024 ** 2,
    );
    const pkg = JSON.parse(packageBytes.toString('utf8')),
        lock = JSON.parse(lockBytes.toString('utf8'));
    assert.equal(pkg.name, 'ssh2');
    assert.equal(pkg.version, '1.17.0');
    const selected = lock.packages['node_modules/ssh2'];
    assert.equal(selected.version, '1.17.0');
    assert.equal(selected.integrity, integrity);
    assert.ok(selected.optional === undefined || selected.optional === false);
    const source = bytes.toString('utf8'),
        needle = "new Function('return 2n ** 32n')()",
        at = source.indexOf(needle);
    assert.ok(at >= 0 && source.indexOf(needle, at + 1) === -1);
    const prefix = source.slice(0, at),
        line = prefix.split('\n').length - 1,
        column = prefix.length - prefix.lastIndexOf('\n') - 1;
    assert.equal(line, 50);
    assert.equal(column, 11);
    return [
        {
            identity: 'ssh2-max-32bit-bigint-function-v1',
            originPath,
            originSHA256: SSH2_BIGINT_ORIGIN_SHA256,
            originLine: line,
            originColumn: column,
            sourceBytes: 44,
            sourceUnits: 44,
            sourceSHA256: hash(SSH2_BIGINT_GENERATED_SOURCE),
            nodeVersion: 'v24.22.0',
            packageVersion: '1.17.0',
            packageIntegrity: integrity,
            requireCreationStack: true,
        },
    ];
}
export function generatedReceiptRowsMatch(rows, inventory) {
    assert.ok(
        Array.isArray(rows) &&
            rows.length <= 1 &&
            Array.isArray(inventory) &&
            inventory.length <= 1,
    );
    const seen = new Set();
    for (const row of rows) {
        assert.deepEqual(
            Object.keys(row).sort(),
            [
                'identity',
                'sourceSHA256',
                'sourceBytes',
                'creatorSourceVerified',
                'creationStackVerified',
            ].sort(),
        );
        const expected = inventory.find((v) => v.identity === row.identity);
        assert.ok(expected && !seen.has(row.identity));
        seen.add(row.identity);
        assert.equal(row.sourceSHA256, expected.sourceSHA256);
        assert.equal(row.sourceBytes, expected.sourceBytes);
        assert.equal(row.creatorSourceVerified, true);
        assert.equal(row.creationStackVerified, true);
    }
    return structuredClone(rows);
}
