const { copyFile, chmod } = require('node:fs/promises');
const path = require('node:path');
const { createReviewPackager } = require('./lib/linux-review-after-pack.cjs');

module.exports = async ({ electronPlatformName, appOutDir, arch, packager }) => {
    if (electronPlatformName !== 'linux') return;
    // electron-builder's pinned builder-util Arch.x64 is 1. Other Linux architectures refuse.
    await createReviewPackager()({ electronPlatformName, appOutDir,
        arch: arch === 1 ? 'x64' : 'unsupported', version: packager.appInfo.version,
        source: path.join(__dirname, '..', 'dist-electron', 'linux-setup-review.cjs') });
    // The AppImage target copies this over its generated launcher, preserving sandbox behavior.
    const launcher = path.join(appOutDir, 'AppRun');
    await copyFile(path.join(__dirname, 'linux-launcher.sh'), launcher);
    await chmod(launcher, 0o755);
};
