const { copyFile, chmod } = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ electronPlatformName, appOutDir }) => {
    if (electronPlatformName !== 'linux') return;
    // The AppImage target copies this over its generated launcher, preserving sandbox behavior.
    const launcher = path.join(appOutDir, 'AppRun');
    await copyFile(path.join(__dirname, 'linux-launcher.sh'), launcher);
    await chmod(launcher, 0o755);
};
