import assert from 'node:assert/strict';
import { gte, valid } from 'semver';
import {
    WINDOWS_SETUP_ASSET,
    windowsSetupInfoName,
    validateWindowsSetupInfo,
} from './windows-setup-release.mjs';

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

export function releaseAssets(version, profile = undefined) {
    assertReleaseProfile(version, profile);
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

export const LEGACY_RELEASE_PROFILE = 'legacy';
export const WINDOWS_SETUP_RELEASE_PROFILE = 'windows-setup';
function assertReleaseProfile(version, profile) {
    const expected = includesWindowsSetup(version)
        ? WINDOWS_SETUP_RELEASE_PROFILE
        : LEGACY_RELEASE_PROFILE;
    if (profile !== undefined) {
        assert.equal(valid(version), version, 'Use the selected semantic release version.');
        assert.equal(
            profile,
            expected,
            'Profile must match the version-derived release catalogue.',
        );
    }
    return expected;
}

/** Additive inventory/content verification; all complete-release defaults remain version-derived. */
export function validateReleaseCatalogue({
    version,
    profile,
    files,
    setupInfo,
    setupExpected,
    inventoryOnly = false,
}) {
    assertReleaseProfile(version, profile);
    const assets = releaseAssets(version);
    assert.ok(
        Array.isArray(files) && files.every((file) => typeof file === 'string'),
        'Invalid release inventory.',
    );
    assert.equal(new Set(files).size, files.length, 'Duplicate release entry.');
    assert.deepEqual(
        files.filter(distributable).sort(),
        assets,
        'Unexpected or missing distributable.',
    );
    if (includesWindowsSetup(version)) {
        const descriptor = windowsSetupInfoName(WINDOWS_SETUP_ASSET);
        assert.deepEqual(
            files.filter((file) => file.endsWith('.sha256')).sort(),
            assets.map((file) => file + '.sha256').sort(),
            'Unexpected or missing checksum sidecar.',
        );
        assert.deepEqual(
            files.filter((file) => file.endsWith('.info.json')).sort(),
            [descriptor],
            'Unexpected or missing setup descriptor.',
        );
        assert.equal(typeof inventoryOnly, 'boolean');
        if (!inventoryOnly) {
            assert.ok(
                setupInfo && setupExpected,
                'Both descriptor and independently measured identity are required.',
            );
            assert.equal(setupExpected.version, version);
            assert.equal(setupExpected.asset, WINDOWS_SETUP_ASSET);
            validateWindowsSetupInfo(setupInfo, setupExpected);
        }
    } else {
        assert.equal(setupInfo, undefined, 'Historical catalogue cannot adopt setup metadata.');
        assert.equal(setupExpected, undefined, 'Historical catalogue cannot adopt setup metadata.');
    }
    return assets;
}
