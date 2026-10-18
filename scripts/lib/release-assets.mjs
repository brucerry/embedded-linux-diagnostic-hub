import { gte, valid } from 'semver';
import { WINDOWS_SETUP_ASSET, windowsSetupInfoName } from './windows-setup-release.mjs';

export const WINDOWS_ASSET = 'Diagnostic-Hub.exe';
export const LINUX_ASSET = 'Diagnostic-Hub-linux-x64.AppImage';
export const LINUX_ARCHIVE = 'Diagnostic-Hub-linux-x64.tar.gz';
export const LAUNCHERS = ['download-run.ps1', 'download-run.sh', 'download-run-macos.sh'];

// Historical catalogs remain immutable. The approved assisted setup starts with v0.6.0.
export function includesWindowsSetup(version) {
    if (!valid(version)) throw Error('A semantic release version is required.');
    return gte(version, '0.6.0-0');
}

export function releaseMetadata(version) {
    return [
        'build-info.json',
        'linux-build-info.json',
        'macos-build-info-x64.json',
        'macos-build-info-arm64.json',
        ...(includesWindowsSetup(version) ? [windowsSetupInfoName(WINDOWS_SETUP_ASSET)] : []),
    ].sort();
}

export function releaseCatalog(version) {
    return [
        ...releaseAssets(version).flatMap((name) => [name, name + '.sha256']),
        ...releaseMetadata(version),
    ].sort();
}

export function releaseAssets(version) {
    return [
        WINDOWS_ASSET,
        ...(includesWindowsSetup(version) ? [WINDOWS_SETUP_ASSET] : []),
        LINUX_ASSET,
        LINUX_ARCHIVE,
        'Diagnostic-Hub-macos-x64.zip',
        'Diagnostic-Hub-macos-arm64.zip',
        `Diagnostic-Hub-Gateway-${version}.tar.gz`,
        `Diagnostic-Hub-Web-${version}.zip`,
        ...LAUNCHERS,
    ].sort();
}

export function distributable(file) {
    return /\.(exe|AppImage|tar\.gz|zip)$/.test(file) || LAUNCHERS.includes(file);
}
