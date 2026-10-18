import { physicalFS } from './physical-fs';
import { assertNoMaintenance } from './installation-maintenance';
import { createHash } from 'node:crypto';
const { lstatSync, mkdirSync, readFileSync, realpathSync } = physicalFS;
import path from 'node:path';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_RECORD,
    MAX_INSTALLATION_MANIFEST_BYTES,
    MAX_INSTALLATION_RECORD_BYTES,
    type InstallationManifest,
    type InstallationRecord,
    validateInstallationManifest,
    validateInstallationRecord,
} from '../shared/installation';
import { portableExecutable } from './update-receipt';

export interface DesktopStartupContext {
    platform: string;
    arch: string;
    packaged: boolean;
    executable: string;
    version: string;
    environment: NodeJS.ProcessEnv;
    appData: string;
    profileOverride?: string;
}

export interface DesktopStartup {
    delivery: 'portable' | 'installed' | 'unavailable';
    currentPath: string | null;
    installation?: {
        root: string;
        record: InstallationRecord;
        manifest: InstallationManifest;
        payloadIntegrity: 'not-checked';
    };
    profilePath?: string;
}

function samePath(left: string, right: string) {
    return process.platform === 'win32'
        ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
        : path.resolve(left) === path.resolve(right);
}

function inside(root: string, candidate: string) {
    const relative = path.relative(root, candidate);
    return (
        relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'))
    );
}

function statIfPresent(filename: string) {
    try {
        return lstatSync(filename);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function markedInstallation(root: string): boolean {
    const record = statIfPresent(path.join(root, INSTALLATION_RECORD));
    const manifest = statIfPresent(path.join(root, INSTALLATION_MANIFEST));
    if ((record && !manifest) || (manifest && !record))
        throw Error('Installation identity is incomplete. Run verified setup to repair it.');
    return Boolean(record || manifest);
}

function regularMetadata(root: string, filename: string, bound: number) {
    const file = path.join(root, filename);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > bound)
        throw Error('Installed setup metadata is unsafe or exceeds its bound.');
    const bytes = readFileSync(file);
    if (bytes.length > bound) throw Error('Installed setup metadata exceeds its bound.');
    return bytes;
}

function observeRoot(root: string, context: DesktopStartupContext) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Installed application root must not be a link.');
    const canonical = realpathSync(root);
    assertNoMaintenance(canonical);
    const record = validateInstallationRecord(
        JSON.parse(
            regularMetadata(canonical, INSTALLATION_RECORD, MAX_INSTALLATION_RECORD_BYTES).toString(
                'utf8',
            ),
        ),
    );
    const bytes = regularMetadata(
        canonical,
        INSTALLATION_MANIFEST,
        MAX_INSTALLATION_MANIFEST_BYTES,
    );
    if (createHash('sha256').update(bytes).digest('hex') !== record.manifestSHA256)
        throw Error('Installed release metadata has changed. Run verified setup to repair it.');
    const manifest = validateInstallationManifest(JSON.parse(bytes.toString('utf8')));
    const lexicalEntry = path.join(root, ...manifest.entryPoint.split('/'));
    if (
        manifest.platform !== context.platform ||
        manifest.arch !== context.arch ||
        manifest.version !== context.version ||
        !samePath(lexicalEntry, context.executable) ||
        (context.platform === 'darwin'
            ? record.profile !== 'existing-mac'
            : record.profile !== 'dedicated')
    )
        throw Error(
            'Installed setup identity does not match the running app. Run verified setup to repair it.',
        );
    let entry = canonical;
    for (const component of manifest.entryPoint.split('/')) {
        entry = path.join(entry, component);
        if (lstatSync(entry).isSymbolicLink())
            throw Error('Installed launch path redirects through a link.');
    }
    if (!lstatSync(entry).isFile()) throw Error('Installed launch entry is not a regular file.');
    return { root: canonical, record, manifest, payloadIntegrity: 'not-checked' as const };
}

/** Resolve an existing ancestor before creating anything; never create profile data inside app. */
function prospectiveCanonical(filename: string) {
    let existing = path.resolve(filename);
    const missing: string[] = [];
    while (!statIfPresent(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) throw Error('Profile path has no existing directory ancestor.');
        missing.unshift(path.basename(existing));
        existing = parent;
    }
    const stat = lstatSync(existing);
    if (!stat.isDirectory() && !stat.isSymbolicLink())
        throw Error('Profile ancestor is not a directory.');
    const canonical = realpathSync(existing);
    if (!lstatSync(canonical).isDirectory()) throw Error('Profile ancestor is not a directory.');
    return path.join(canonical, ...missing);
}

export function selectDesktopStartup(context: DesktopStartupContext): DesktopStartup {
    if (!context.packaged) return { delivery: 'portable', currentPath: null };
    if (!path.isAbsolute(context.executable) || context.executable.length > 4096)
        return { delivery: 'unavailable', currentPath: null };
    let roots: string[] = [];
    if (context.platform === 'win32' || context.platform === 'linux') {
        roots = [path.dirname(context.executable), path.dirname(path.dirname(context.executable))];
    } else if (context.platform === 'darwin') {
        const marker = path.sep + 'Contents' + path.sep + 'MacOS' + path.sep;
        const index = context.executable.lastIndexOf(marker);
        if (index > 0) roots = [path.dirname(context.executable.slice(0, index))];
    }
    for (const root of roots) {
        if (!markedInstallation(root)) continue;
        const installation = observeRoot(root, context);
        let profilePath: string | undefined;
        if (installation.record.profile === 'dedicated') {
            if (!path.isAbsolute(context.appData) || context.appData.length > 4096)
                throw Error('Per-user profile storage is unavailable.');
            const selected =
                context.profileOverride ||
                path.join(
                    context.appData,
                    'DiagnosticHub',
                    'profiles',
                    installation.record.installationId,
                );
            if (!path.isAbsolute(selected) || selected.length > 4096)
                throw Error('Installed profile must be an absolute user-selected path.');
            const canonical = prospectiveCanonical(selected);
            if (inside(installation.root, canonical))
                throw Error(
                    'Installed profile must remain outside the replaceable application folder.',
                );
            mkdirSync(canonical, { recursive: true, mode: 0o700 });
            profilePath = realpathSync(canonical);
            if (inside(installation.root, profilePath))
                throw Error('Installed profile location changed into the application folder.');
        }
        return {
            delivery: 'installed',
            currentPath: path.join(
                installation.root,
                ...installation.manifest.entryPoint.split('/'),
            ),
            installation,
            profilePath,
        };
    }
    const currentPath = portableExecutable(
        context.platform,
        context.packaged,
        context.executable,
        context.environment,
    );
    // Registered AppImage layouts are not mistaken for the legacy portable update contract.
    if (
        context.platform === 'linux' &&
        currentPath &&
        markedInstallation(path.dirname(currentPath))
    )
        throw Error(
            'Managed AppImage startup is not qualified. Use the portable AppImage or guided complete-folder setup.',
        );
    return {
        delivery: currentPath || context.platform === 'darwin' ? 'portable' : 'unavailable',
        currentPath,
    };
}

/** Canonicalize a selected native profile before Electron acquires its process singleton. */
export function canonicalProfilePath(profile: string): string {
    if (!path.isAbsolute(profile) || profile.length > 4096)
        throw Error('Application profile must be an absolute path.');
    const canonical = prospectiveCanonical(profile);
    mkdirSync(canonical, { recursive: true, mode: 0o700 });
    return realpathSync(canonical);
}
