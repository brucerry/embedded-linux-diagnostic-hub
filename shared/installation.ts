import semver from 'semver';
const { gt, valid } = semver;

export const INSTALLATION_PRODUCT = 'dev.diagnostichub.desktop';
export const INSTALLATION_RECORD = '.diagnostic-hub-installation.json';
export const INSTALLATION_MANIFEST = '.diagnostic-hub-release.json';
export const MAX_INSTALLATION_RECORD_BYTES = 16 * 1024;
export const MAX_INSTALLATION_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_INSTALLATION_FILES = 20_000;
export const MAX_INSTALLATION_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export type InstalledLayout =
    'windows-nsis' | 'windows-folder' | 'macos-bundle' | 'linux-folder' | 'linux-appimage';

const layouts = {
    'windows-nsis': { platform: 'win32', arch: ['x64'], entry: 'Diagnostic Hub.exe', payload: '' },
    'windows-folder': {
        platform: 'win32',
        arch: ['x64'],
        entry: 'app/Diagnostic Hub.exe',
        payload: 'app/',
    },
    'macos-bundle': {
        platform: 'darwin',
        arch: ['x64', 'arm64'],
        entry: 'Diagnostic Hub.app/Contents/MacOS/Diagnostic Hub',
        payload: 'Diagnostic Hub.app/',
    },
    'linux-folder': {
        platform: 'linux',
        arch: ['x64'],
        entry: 'app/diagnostic-hub',
        payload: 'app/',
    },
    'linux-appimage': {
        platform: 'linux',
        arch: ['x64'],
        entry: 'Diagnostic-Hub-linux-x64.AppImage',
        payload: '',
    },
} as const;

export type InstallationFile =
    | { kind: 'file'; path: string; bytes: number; sha256: string }
    | { kind: 'link'; path: string; target: string };

export interface InstallationManifest {
    schemaVersion: 1;
    product: typeof INSTALLATION_PRODUCT;
    layout: InstalledLayout;
    platform: 'win32' | 'darwin' | 'linux';
    arch: 'x64' | 'arm64';
    version: string;
    sourceCommit: string;
    entryPoint: string;
    files: InstallationFile[];
}

export interface InstallationRecord {
    schemaVersion: 1;
    product: typeof INSTALLATION_PRODUCT;
    installationId: string;
    manifestSHA256: string;
    profile: 'dedicated' | 'existing-mac';
}

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw Error('Invalid installation metadata.');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !fields.includes(key)))
        throw Error('Unsupported installation metadata fields.');
    return value;
}

function hash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function version(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 128 && valid(value) === value;
}

export function supportedInstallHost(platform: string, arch: string): boolean {
    return (
        ((platform === 'win32' || platform === 'linux') && arch === 'x64') ||
        (platform === 'darwin' && (arch === 'x64' || arch === 'arm64'))
    );
}

function relativeFile(value: unknown, windows: boolean): string {
    if (
        typeof value !== 'string' ||
        !value ||
        value.length > 1024 ||
        /[\\\x00-\x1f\x7f]/.test(value) ||
        value.startsWith('/') ||
        /^[a-z]:/i.test(value) ||
        value.split('/').some((part) => !part || part === '.' || part === '..')
    )
        throw Error('Unsafe installation file path.');
    if (
        windows &&
        value
            .split('/')
            .some(
                (part) =>
                    /[<>:"|?*]/.test(part) ||
                    /[. ]$/.test(part) ||
                    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(part),
            )
    )
        throw Error('Unsafe Windows installation filename.');
    return value;
}

export function validateInstallationRecord(input: unknown): InstallationRecord {
    const value = record(input, [
        'schemaVersion',
        'product',
        'installationId',
        'manifestSHA256',
        'profile',
    ]);
    if (
        value.schemaVersion !== 1 ||
        value.product !== INSTALLATION_PRODUCT ||
        typeof value.installationId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            value.installationId,
        ) ||
        !hash(value.manifestSHA256) ||
        !['dedicated', 'existing-mac'].includes(value.profile as string)
    )
        throw Error('Invalid installation identity.');
    return {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        installationId: value.installationId,
        manifestSHA256: value.manifestSHA256,
        profile: value.profile as InstallationRecord['profile'],
    };
}

export function validateInstallationManifest(input: unknown): InstallationManifest {
    const value = record(input, [
        'schemaVersion',
        'product',
        'layout',
        'platform',
        'arch',
        'version',
        'sourceCommit',
        'entryPoint',
        'files',
    ]);
    if (
        value.schemaVersion !== 1 ||
        value.product !== INSTALLATION_PRODUCT ||
        typeof value.layout !== 'string' ||
        !Object.hasOwn(layouts, value.layout) ||
        !version(value.version) ||
        typeof value.sourceCommit !== 'string' ||
        !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
        !Array.isArray(value.files) ||
        !value.files.length ||
        value.files.length > MAX_INSTALLATION_FILES
    )
        throw Error('Invalid installation release manifest.');
    const layout = value.layout as InstalledLayout;
    const expected = layouts[layout];
    if (
        value.platform !== expected.platform ||
        !supportedInstallHost(value.platform as string, value.arch as string) ||
        !(expected.arch as readonly string[]).includes(value.arch as string) ||
        value.entryPoint !== expected.entry
    )
        throw Error('Installation platform, architecture or entry point does not match.');
    const seen = new Set<string>();
    let bytes = 0;
    const files: InstallationFile[] = value.files.map((input) => {
        const item = record(input, ['kind', 'path', 'bytes', 'sha256', 'target']);
        const filename = relativeFile(item.path, value.platform === 'win32');
        if (
            !filename.startsWith(expected.payload) ||
            filename === INSTALLATION_RECORD ||
            filename === INSTALLATION_MANIFEST
        )
            throw Error('Installation file is outside the declared payload.');
        const key = filename.normalize('NFC');
        const collisionKey = value.platform === 'linux' ? key : key.toLowerCase();
        if (seen.has(collisionKey)) throw Error('Duplicate installation file path.');
        seen.add(collisionKey);
        if (item.kind === 'file') {
            if (
                item.target !== undefined ||
                !Number.isSafeInteger(item.bytes) ||
                (item.bytes as number) < 0 ||
                (item.bytes as number) > MAX_INSTALLATION_PAYLOAD_BYTES ||
                !hash(item.sha256)
            )
                throw Error('Invalid installation file integrity record.');
            bytes += item.bytes as number;
            if (bytes > MAX_INSTALLATION_PAYLOAD_BYTES)
                throw Error('Installation payload exceeds its bound.');
            return {
                kind: 'file',
                path: filename,
                bytes: item.bytes as number,
                sha256: item.sha256,
            };
        }
        if (
            item.kind !== 'link' ||
            value.platform === 'win32' ||
            layout === 'linux-appimage' ||
            item.bytes !== undefined ||
            item.sha256 !== undefined ||
            typeof item.target !== 'string' ||
            !item.target ||
            item.target.length > 1024 ||
            /[\\\x00-\x1f\x7f]/.test(item.target) ||
            item.target.startsWith('/') ||
            /^[a-z]:/i.test(item.target)
        )
            throw Error('Unsupported installation link.');
        const components = filename.split('/').slice(0, -1);
        for (const component of item.target.split('/')) {
            if (!component || component === '.') continue;
            if (component === '..') {
                if (!components.length) throw Error('Installation link escapes its payload.');
                components.pop();
            } else {
                components.push(component);
            }
        }
        const target = components.join('/');
        if (
            target === '..' ||
            target.startsWith('../') ||
            !target.startsWith(expected.payload) ||
            target === expected.payload.slice(0, -1)
        )
            throw Error('Installation link escapes its payload.');
        return { kind: 'link', path: filename, target: item.target };
    });
    if (!files.some((file) => file.kind === 'file' && file.path === expected.entry))
        throw Error('Installation entry point is absent.');
    return {
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout,
        platform: value.platform as InstallationManifest['platform'],
        arch: value.arch as InstallationManifest['arch'],
        version: value.version,
        sourceCommit: value.sourceCommit,
        entryPoint: expected.entry,
        files,
    };
}

export type InstallationAction = 'install' | 'launch' | 'update' | 'repair';

export function installationActions(
    installedVersion: string | null,
    candidateVersion: string | null,
): InstallationAction[] {
    if (
        (installedVersion !== null && !version(installedVersion)) ||
        (candidateVersion !== null && !version(candidateVersion))
    )
        throw Error('Invalid installation maintenance version.');
    if (!installedVersion) return candidateVersion ? ['install'] : [];
    if (!candidateVersion || gt(installedVersion, candidateVersion)) return ['launch'];
    return gt(candidateVersion, installedVersion) ? ['launch', 'update'] : ['launch', 'repair'];
}
