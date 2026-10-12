export const WINDOWS_ASSET = 'Diagnostic-Hub.exe';
export const LINUX_ASSET = 'Diagnostic-Hub-linux-x64.AppImage';
export const LINUX_ARCHIVE = 'Diagnostic-Hub-linux-x64.tar.gz';
export const LAUNCHERS = ['download-run.ps1', 'download-run.sh'];

export function releaseAssets(version) {
    return [
        WINDOWS_ASSET,
        LINUX_ASSET,
        LINUX_ARCHIVE,
        `Diagnostic-Hub-Gateway-${version}.tar.gz`,
        `Diagnostic-Hub-Web-${version}.zip`,
        ...LAUNCHERS,
    ].sort();
}

export function distributable(file) {
    return /\.(exe|AppImage|tar\.gz|zip)$/.test(file) || LAUNCHERS.includes(file);
}
