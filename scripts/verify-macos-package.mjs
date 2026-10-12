import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { extractFile, listPackage } from '@electron/asar';

assert.equal(process.platform, 'darwin', 'Mac package verification must run on macOS.');
const [app, arch] = process.argv.slice(2);
assert.ok(
    app && ['x64', 'arm64'].includes(arch),
    'Usage: node scripts/verify-macos-package.mjs app.app x64|arm64',
);
assert.equal(process.arch, arch, 'Qualify the native architecture, not an emulated build.');
for (const file of [
    'Contents/MacOS/Diagnostic Hub',
    'Contents/Frameworks/Electron Framework.framework/Electron Framework',
]) {
    const kind = execFileSync('/usr/bin/file', [path.join(app, file)], { encoding: 'utf8' });
    assert.match(kind, /Mach-O 64-bit/);
    assert.match(kind, arch === 'x64' ? /x86_64/ : /arm64/);
}
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], {
    encoding: 'utf8',
});
assert.equal(signature.status, 0);
assert.match(
    signature.stderr,
    /Signature=adhoc/,
    'This qualification uses an ad-hoc integrity signature, not a Developer ID identity.',
);
const identifier = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')],
    { encoding: 'utf8' },
).trim();
assert.equal(identifier, 'dev.diagnostichub.desktop');
const archive = path.join(app, 'Contents/Resources/app.asar');
assert.equal(
    listPackage(archive).some((file) => /(?:genie|native-window|taskbar-query|koffi)/i.test(file)),
    false,
    'Retired effects must stay absent.',
);
for (const folder of ['dist/assets', 'dist-electron']) {
    for (const file of readdirSync(folder)) {
        if (folder === 'dist-electron' && !['main.cjs', 'preload.cjs'].includes(file)) continue;
        assert.ok(
            readFileSync(path.join(folder, file)).equals(
                extractFile(archive, path.join(folder, file)),
            ),
            'Packaged bundle mismatch: ' + file,
        );
    }
}
for (const file of ['app-icon.svg', 'app-icon.png', 'app-icon.ico'])
    assert.ok(
        readFileSync(path.join('public', file)).equals(
            extractFile(archive, path.join('dist', file)),
        ),
        'Packaged brand asset mismatch: ' + file,
    );
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(
    JSON.stringify({
        platform: 'darwin',
        arch,
        version,
        source: process.env.GITHUB_SHA,
        bundleIdentifier: identifier,
        adHocIntegrityVerified: true,
        packagedSourceMatches: true,
        asarSHA256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
        distribution: false,
        gatekeeperDownloadedAppQualified: false,
    }),
);
