/** Explicit preparation only: the parent establishes process identity before admitting work. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
assert(process.connected);
const [mode, installer, expectedSHA256] = process.argv.slice(2);
assert(mode === 'install' || mode === 'version');
const go = new Promise((resolve, reject) => {
    process.once('disconnect', () =>
        reject(Error('Preparation owner disconnected before admission')),
    );
    process.once('message', (m) => {
        try {
            assert.equal(m?.kind, 'admit-electron-preparation');
            resolve();
        } catch (e) {
            reject(e);
        }
    });
});
process.send({ kind: 'electron-preparation-ready', pid: process.pid, mode });
await go;
process.disconnect();
if (mode === 'install') {
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'x64');
    assert.equal(process.version, 'v24.22.0');
    assert.equal(
        createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
        expectedSHA256,
    );
    const require = createRequire(import.meta.url);
    const extractor = require('@electron-internal/extract-zip');
    const esbuild = require('esbuild');
    const playwright = require('playwright');
    const vite = await import('vite');
    const rolldown = await import('rolldown');
    const css = require('lightningcss');
    assert.equal(typeof extractor.extract, 'function');
    assert.equal(typeof playwright._electron.launch, 'function');
    assert.equal(typeof vite.build, 'function');
    assert.equal(typeof rolldown.rolldown, 'function');
    assert.equal(typeof css.transform, 'function');
    console.log(
        JSON.stringify({
            kind: 'pilot-launch-modules-loaded',
            esbuild: esbuild.version,
            playwrightElectron: true,
            vite: true,
            rolldown: true,
            lightningcss: true,
            nativeExtractor: true,
        }),
    );
    // Use the exact pinned official entry; the lazy Electron index is never loaded.
    createRequire(import.meta.url)(installer);
} else {
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'x64');
    assert.equal(process.versions.electron, '44.5.1');
    assert.equal(typeof createRequire(import.meta.url)('node:sqlite').DatabaseSync, 'function');
    console.log(
        JSON.stringify({
            kind: 'settled-electron-version',
            version: process.versions.electron,
            platform: process.platform,
            arch: process.arch,
            sqlite: true,
        }),
    );
}
