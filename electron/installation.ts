import { physicalFS } from './physical-fs';
import { createHash } from 'node:crypto';
const { createReadStream } = physicalFS;
const { lstat, readFile, readlink, realpath } = physicalFS.promises;
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

export interface InstallationLocationObservation {
    root: string;
    executable: string;
    record: InstallationRecord;
    manifest: InstallationManifest;
    automaticUpdateQualified: false;
    payloadIntegrity: 'not-checked';
}

export interface ObservedInstallation extends Omit<
    InstallationLocationObservation,
    'payloadIntegrity'
> {
    payloadIntegrity: 'declared-files-verified';
}

function samePath(left: string, right: string): boolean {
    return process.platform === 'win32'
        ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
        : path.resolve(left) === path.resolve(right);
}

function descendant(root: string, filename: string): boolean {
    const relative = path.relative(root, filename);
    return (
        Boolean(relative) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..')
    );
}

async function regularFile(root: string, relative: string) {
    const filename = path.join(root, ...relative.split('/'));
    if (!descendant(root, filename)) throw Error('Installation path escapes its owned root.');
    let current = root;
    for (const component of relative.split('/')) {
        current = path.join(current, component);
        if ((await lstat(current)).isSymbolicLink())
            throw Error('Installation file path redirects through a link.');
    }
    const stat = await lstat(filename);
    if (!stat.isFile()) throw Error('Installation file is not a regular file.');
    if (!descendant(root, await realpath(filename)))
        throw Error('Installation file leaves its owned root.');
    return { filename, stat };
}

async function metadata(root: string, filename: string, limit: number): Promise<Buffer> {
    const file = await regularFile(root, filename);
    if (file.stat.size > limit) throw Error('Installation metadata exceeds its bound.');
    const content = await readFile(file.filename);
    if (content.length > limit) throw Error('Installation metadata exceeds its bound.');
    return content;
}

async function digestFile(root: string, relative: string, bytes: number, sha256: string) {
    const file = await regularFile(root, relative);
    if (file.stat.size !== bytes) throw Error('Installed file size does not match its release.');
    const hash = createHash('sha256');
    let read = 0;
    for await (const chunk of createReadStream(file.filename)) {
        read += chunk.length;
        if (read > bytes) throw Error('Installed file changed during verification.');
        hash.update(chunk);
    }
    if (read !== bytes || hash.digest('hex') !== sha256)
        throw Error('Installed file integrity does not match its release.');
    // Recheck path/identity after reading; mtime is never accepted as hash evidence.
    const after = await regularFile(root, relative);
    if (
        after.stat.size !== file.stat.size ||
        after.stat.ino !== file.stat.ino ||
        after.stat.dev !== file.stat.dev
    )
        throw Error('Installed file changed during verification.');
}

/**
 * Native/helpers supply an explicitly selected root and actual process observations.
 * No renderer-selected path, portable environment spoof or generic exe fallback is accepted.
 * This observes bounded local metadata/path/version, not payload or publisher trust.
 * Full declared-file verification, complete extraction inventory and OS signatures
 * remain separate responsibilities. It does not enable automatic updates.
 */
export async function observeInstallationLocation(
    selectedRoot: string,
    observed: { platform: string; arch: string; version: string; executable: string },
): Promise<InstallationLocationObservation> {
    if (!path.isAbsolute(selectedRoot) || selectedRoot.length > 4096)
        throw Error('Invalid installation root.');
    const rootStat = await lstat(selectedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw Error('Installation root is not a real directory.');
    const root = await realpath(selectedRoot);
    const record = validateInstallationRecord(
        JSON.parse(
            (await metadata(root, INSTALLATION_RECORD, MAX_INSTALLATION_RECORD_BYTES)).toString(
                'utf8',
            ),
        ),
    );
    const bytes = await metadata(root, INSTALLATION_MANIFEST, MAX_INSTALLATION_MANIFEST_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== record.manifestSHA256)
        throw Error('Installation release manifest has changed.');
    const manifest = validateInstallationManifest(JSON.parse(bytes.toString('utf8')));
    const executable = path.join(root, ...manifest.entryPoint.split('/'));
    if (
        manifest.platform !== observed.platform ||
        manifest.arch !== observed.arch ||
        manifest.version !== observed.version ||
        !samePath(
            path.join(path.resolve(selectedRoot), ...manifest.entryPoint.split('/')),
            observed.executable,
        ) ||
        (manifest.platform === 'darwin'
            ? record.profile !== 'existing-mac'
            : record.profile !== 'dedicated')
    )
        throw Error('Running application does not match its installed identity.');
    await regularFile(root, manifest.entryPoint);
    return {
        root,
        executable,
        record,
        manifest,
        automaticUpdateQualified: false,
        payloadIntegrity: 'not-checked',
    };
}

/** Full declared-payload integrity qualification; never call this to gate startup. */
export async function observeInstallation(
    selectedRoot: string,
    observed: { platform: string; arch: string; version: string; executable: string },
): Promise<ObservedInstallation> {
    const location = await observeInstallationLocation(selectedRoot, observed);
    const { root, executable, record, manifest } = location;
    for (const entry of manifest.files) {
        if (entry.kind === 'file') {
            await digestFile(root, entry.path, entry.bytes, entry.sha256);
        } else {
            const link = path.join(root, ...entry.path.split('/'));
            // Parent directories cannot redirect; the final declared framework link can.
            const parent = path.posix.dirname(entry.path);
            if (parent !== '.') {
                let current = root;
                for (const component of parent.split('/')) {
                    current = path.join(current, component);
                    const stat = await lstat(current);
                    if (!stat.isDirectory() || stat.isSymbolicLink())
                        throw Error('Installation link parent is unsafe.');
                }
            }
            if (!(await lstat(link)).isSymbolicLink() || (await readlink(link)) !== entry.target)
                throw Error('Installed link does not match its release.');
            const target = await realpath(link);
            const payload =
                manifest.layout === 'macos-bundle'
                    ? path.join(root, 'Diagnostic Hub.app')
                    : path.join(root, 'app');
            if (!descendant(payload, target))
                throw Error('Installed link leaves its declared payload.');
        }
    }
    return {
        root,
        executable,
        record,
        manifest,
        automaticUpdateQualified: false,
        payloadIntegrity: 'declared-files-verified',
    };
}
