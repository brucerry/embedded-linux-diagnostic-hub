import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { distributable, releaseAssets } from './lib/release-assets.mjs';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'Use a semantic release version.');
assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Tag must match package.json version.');
if (process.argv.includes('--assets')) {
    const files = (await readdir('release')).filter(distributable).sort();
    assert.deepEqual(files, releaseAssets(version));
    for (const file of files) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path.join('release', file))) hash.update(chunk);
        assert.equal(
            await readFile(`release/${file}.sha256`, 'utf8'),
            `${hash.digest('hex')}  ${file}\n`,
        );
    }
    const info = JSON.parse(
        (await readFile('release/build-info.json', 'utf8')).replace(/^\uFEFF/, ''),
    );
    assert.equal(info.version, version);
    assert.equal(info.commit, process.env.GITHUB_SHA);
    assert.ok(['Valid', 'NotSigned'].includes(info.signature));
    const linux = JSON.parse(await readFile('release/linux-build-info.json', 'utf8'));
    assert.equal(linux.version, version);
    assert.equal(linux.commit, process.env.GITHUB_SHA);
    assert.equal(linux.platform, 'linux');
    assert.equal(linux.arch, 'x64');
    const signing =
        info.signature === 'Valid'
            ? 'Windows Authenticode signature: valid.'
            : 'Unsigned engineering preview. Windows may show an unknown-publisher warning.';
    await writeFile(
        'release/notes.md',
        `Portable Windows 10/11 x64 and Linux x64 desktop applications, relocatable static website, and lab SSH gateway package.\n\n${signing}\n\nDownload Diagnostic-Hub.exe on Windows, or Diagnostic-Hub-linux-x64.AppImage on Linux. Download-and-run commands require no administrator privileges; see docs/downloads.md. Linux PC acceptance is still pending. Windows/Linux 32-bit desktops are not supported by this Electron runtime. The desktop connects over SSH without internet; the website needs a separately deployed HTTPS gateway. See the repository README for setup and validation limits.\n\nCommit: ${info.commit}\n`,
    );
}
console.log(`Release version verified: v${version}`);
