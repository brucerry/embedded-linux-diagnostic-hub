import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

assert.equal(process.argv.length, 3);
const root = resolve(process.argv[2]);
const manifest = (mode) => {
    const output = join(root, mode);
    assert.ok(statSync(join(output, 'index.html')).size > 0);
    const assets = join(output, 'assets');
    const files = readdirSync(assets, { withFileTypes: true });
    assert.ok(files.length > 0 && files.every((item) => item.isFile()));
    return Object.fromEntries(
        files.map(({ name }) => [
            name,
            createHash('sha256').update(readFileSync(join(assets, name))).digest('hex'),
        ]),
    );
};
const desktop = manifest('production');
assert.deepEqual(manifest('web'), desktop);
for (const name of ['capture-download-sw.js', 'capture-download-frame.js']) {
    const code = readFileSync(join(root, 'web', name), 'utf8');
    assert.ok(code.length > 0);
    new Script(code, { filename: name });
}
console.log(JSON.stringify({ matchingAssets: Object.keys(desktop).length, qualification: false }));
