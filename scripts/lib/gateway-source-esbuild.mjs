import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const SOURCE_ESBUILD_REF = 'refs/heads/ci/v060-gateway-source-tool-buildonly-20261119';

const directories = {
    esbuild: ['LICENSE.md', 'bin', 'lib', 'package.json'],
    'esbuild/bin': ['esbuild'],
    'esbuild/lib': ['main.d.ts', 'main.js'],
    '@esbuild': ['linux-x64'],
    '@esbuild/linux-x64': ['bin'],
    '@esbuild/linux-x64/bin': ['esbuild'],
};
const files = {
    'esbuild/LICENSE.md': [
        1069, 'b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681', false,
    ],
    'esbuild/bin/esbuild': [
        9336, '8d2ff811a001eeaebaa6c88749e5d31013ef9b1c3aef976af4652f4993984980', true,
    ],
    'esbuild/lib/main.d.ts': [
        23551, 'e078310f23f0ccfa28a6ac81b5fad81f27150e921f92ab6e648caab42e2d9a14', false,
    ],
    'esbuild/lib/main.js': [
        97773, 'd52d8f3bc8af4261cb113b34ea67bd9d6c2692afb11d94c2c43b43554d61964c', false,
    ],
    'esbuild/package.json': [
        379, '93527957a89fb0306875f1f9d1b565bcfcb3bf6d5bc37e9e970817c9d39630e4', false,
    ],
    '@esbuild/linux-x64/bin/esbuild': [
        11427966, 'ed59354772a53bc6aa5b7c4219338e1522fb73a8e5fff3f6fc2d036ad8726494', true,
    ],
};

function safeOwnerMode(stat, uid) {
    assert.ok((stat.uid === uid || stat.uid === 0) && !(stat.mode & 0o7022),
        'Source-derived esbuild custody mismatch.');
}

async function verifyDirectory(path, uid, filesystem) {
    assert.equal(await filesystem.realpath(path), path, 'Source-derived esbuild directory alias.');
    const stat = await filesystem.lstat(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    safeOwnerMode(stat, uid);
}

/** Required on every toolchain observation of the distinct build-only branch.
 * The existing owned stable reader supplies bytes. This covers the two esbuild
 * slots and their ancestors. It grants no acquisition or execution authority.
 */
export async function verifySourceDerivedEsbuild(root, uid, filesystem, systemRoot, read) {
    assert.ok(posix.isAbsolute(root) && root !== '/' && posix.normalize(root) === root);
    assert.ok(Number.isSafeInteger(uid) && uid > 0);
    assert.equal(await systemRoot.realpath(), '/');
    const system = await systemRoot.lstat();
    assert.ok(system.isDirectory() && !system.isSymbolicLink());
    safeOwnerMode(system, 0);
    const base = posix.join(root, 'node_modules');
    const parents = [];
    for (let path = base; path !== '/'; path = posix.dirname(path))
        parents.push(path);
    for (const path of parents.reverse()) await verifyDirectory(path, uid, filesystem);

    for (const [relative, names] of Object.entries(directories)) {
        const path = posix.join(base, relative);
        await verifyDirectory(path, uid, filesystem);
        assert.deepEqual((await filesystem.readdir(path)).sort(), [...names].sort(),
            'Source-derived esbuild inventory mismatch.');
    }
    for (const [relative, [size, sha256, executable]] of Object.entries(files)) {
        const path = posix.join(base, relative);
        const stat = await filesystem.lstat(path);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === size);
        safeOwnerMode(stat, uid);
        assert.equal(Boolean(stat.mode & 0o100), executable);
        const bytes = await read(path, size, filesystem);
        assert.ok(bytes instanceof Uint8Array && bytes.byteLength === size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256,
            'Source-derived esbuild input digest mismatch.');
    }
}
