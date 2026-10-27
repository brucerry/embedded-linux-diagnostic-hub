import { createHash } from 'node:crypto';
import type { LinuxEnvelopePlan } from './linux-setup-envelope.ts';
import { validatePrivateLinuxSource, validatePrivateLinuxBuild } from './linux-build-record.mjs';
const hash = (x: Buffer) => createHash('sha256').update(x).digest('hex');
const boundedJSON = (bytes: Buffer) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65536)
        throw Error('LINUX_RELEASE_RECORD_CAP');
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
};
function closed(x: unknown, fields: string[]) {
    if (!x || typeof x !== 'object' || Array.isArray(x) ||
        Object.keys(x).sort().join('\n') !== fields.slice().sort().join('\n'))
        throw Error('LINUX_RELEASE_RECORD');
    return x as Record<string, unknown>;
}
/** Verify actual record bytes against independently selected digests, not a trust Boolean. */
export function validateLinuxObservationRecords(plan: LinuxEnvelopePlan, selection: unknown,
    releaseBytes: Buffer, buildBytes: Buffer) {
    const snapshot = structuredClone(selection);
    if (snapshot && typeof snapshot === 'object' && 'mode' in snapshot && snapshot.mode === 'private-build')
        return validatePrivateObservationRecords(plan, snapshot, releaseBytes, buildBytes);
    const v = closed(snapshot, ['repository', 'tag', 'version', 'sourceCommit',
        'archiveSHA256', 'archiveBytes', 'releaseRecordSHA256', 'buildRecordSHA256']);
    if (v.repository !== 'brucerry/embedded-linux-diagnostic-hub' || v.tag !== 'v' + plan.version ||
        v.version !== plan.version || v.sourceCommit !== plan.sourceCommit ||
        v.archiveSHA256 !== plan.archive.sha256 || v.archiveBytes !== plan.archive.bytes ||
        typeof v.releaseRecordSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.releaseRecordSHA256) ||
        typeof v.buildRecordSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.buildRecordSHA256))
        throw Error('LINUX_RELEASE_SELECTION');
    const release = boundedJSON(releaseBytes), build = boundedJSON(buildBytes);
    if (!release || typeof release !== 'object' || Array.isArray(release) ||
        hash(releaseBytes) !== v.releaseRecordSHA256 || hash(buildBytes) !== v.buildRecordSHA256)
        throw Error('LINUX_RELEASE_RECORD_HASH');
    const base = 'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases';
    if (release.tag_name !== v.tag || release.target_commitish !== v.sourceCommit || release.draft !== false ||
        typeof release.prerelease !== 'boolean' || release.html_url !== base + '/tag/' + v.tag ||
        !Array.isArray(release.assets) || release.assets.length > 64)
        throw Error('LINUX_RELEASE_IDENTITY');
    const matching = release.assets.filter(asset => asset && typeof asset === 'object' &&
        (asset as Record<string, unknown>).name === plan.archive.asset) as Record<string, unknown>[];
    if (matching.length !== 1 || matching[0].browser_download_url !== base + '/download/' + v.tag + '/' + plan.archive.asset)
        throw Error('LINUX_RELEASE_ASSET');
    closed(build, ['version', 'commit', 'platform', 'arch', 'assets', 'validation']);
    const assets = closed(build.assets, ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz']);
    if (build.version !== plan.version || build.commit !== plan.sourceCommit || build.platform !== 'linux' ||
        build.arch !== 'x64' || assets[plan.archive.asset] !== plan.archive.sha256 ||
        typeof assets['Diagnostic-Hub-linux-x64.AppImage'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(assets['Diagnostic-Hub-linux-x64.AppImage'] as string) ||
        typeof build.validation !== 'string' || build.validation.length > 1024)
        throw Error('LINUX_BUILD_IDENTITY');
    return { repository: v.repository, tag: v.tag, version: plan.version, sourceCommit: plan.sourceCommit,
        archiveSHA256: plan.archive.sha256, archiveBytes: plan.archive.bytes,
        releaseRecordSHA256: hash(releaseBytes), releaseRecordBytes: releaseBytes.length,
        buildRecordSHA256: hash(buildBytes), buildRecordBytes: buildBytes.length,
        provenance: 'selected-unsigned-release-integrity' as const, compiledSourceProven: false };
}
/** Explicit private source/build facts. No tag, release URL, draft status or publication is invented. */
function validatePrivateObservationRecords(plan: LinuxEnvelopePlan, selection: unknown,
    sourceBytes: Buffer, buildBytes: Buffer) {
    const v = closed(selection, ['mode', 'repository', 'version', 'sourceCommit', 'sourceTree',
        'sourceManifestSHA256', 'buildId', 'archiveSHA256', 'archiveBytes', 'sourceRecordSHA256', 'buildRecordSHA256']);
    if (v.mode !== 'private-build' || v.repository !== 'brucerry/embedded-linux-diagnostic-hub' ||
        v.version !== plan.version || v.sourceCommit !== plan.sourceCommit ||
        v.archiveSHA256 !== plan.archive.sha256 || v.archiveBytes !== plan.archive.bytes ||
        typeof v.sourceRecordSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceRecordSHA256) ||
        typeof v.buildRecordSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.buildRecordSHA256))
        throw Error('LINUX_PRIVATE_SELECTION');
    const source = validatePrivateLinuxSource(boundedJSON(sourceBytes));
    const rawBuild = boundedJSON(buildBytes);
    if (hash(sourceBytes) !== v.sourceRecordSHA256 || hash(buildBytes) !== v.buildRecordSHA256)
        throw Error('LINUX_PRIVATE_RECORD_HASH');
    if (source.repository !== v.repository || source.version !== v.version || source.commit !== v.sourceCommit ||
        source.tree !== v.sourceTree || source.sourceManifestSHA256 !== v.sourceManifestSHA256 || source.buildId !== v.buildId)
        throw Error('LINUX_PRIVATE_SOURCE_SELECTION');
    const build = validatePrivateLinuxBuild(rawBuild, source, v.sourceRecordSHA256);
    if (build.assets[plan.archive.asset] !== plan.archive.sha256 || build.archiveBytes !== plan.archive.bytes)
        throw Error('LINUX_PRIVATE_ARCHIVE');
    return { repository: v.repository, version: plan.version, sourceCommit: plan.sourceCommit,
        sourceTree: source.tree, sourceManifestSHA256: source.sourceManifestSHA256, buildId: source.buildId,
        archiveSHA256: plan.archive.sha256, archiveBytes: plan.archive.bytes,
        sourceRecordSHA256: hash(sourceBytes), sourceRecordBytes: sourceBytes.length,
        buildRecordSHA256: hash(buildBytes), buildRecordBytes: buildBytes.length,
        validationStatus: build.validation.status,
        provenance: 'selected-unsigned-private-build-integrity' as const, compiledSourceProven: false };
}
/** Select exact record slots before IO; cross-mode path substitutions are not accepted. */
export function linuxObservationRecordPaths(input: unknown) {
    const records = structuredClone(input);
    const privateMode = records && typeof records === 'object' && 'selection' in records &&
        records.selection && typeof records.selection === 'object' && 'mode' in records.selection &&
        records.selection.mode === 'private-build';
    const v = closed(records, privateMode ? ['buildPath', 'sourcePath', 'selection'] : ['buildPath', 'releasePath', 'selection']);
    return { primaryPath: privateMode ? v.sourcePath : v.releasePath, buildPath: v.buildPath,
        primaryKind: privateMode ? 'source' as const : 'release' as const, selection: v.selection };
}
/** Compare actual observed body hashes/modes with the selected existing envelope inventory. */
export function assertLinuxObservedMembers(plan: LinuxEnvelopePlan, entries: unknown) {
    if (!Array.isArray(entries) || entries.length !== plan.files.length + plan.directories.length || entries.length > 40000)
        throw Error('LINUX_OBSERVED_MEMBER_COUNT');
    const files = [], directories: string[] = [], seen = new Set<string>();
    for (const input of entries) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('LINUX_OBSERVED_MEMBER');
        const item = input as Record<string, unknown>;
        closed(item, item.kind === 'file' ? ['kind', 'path', 'bytes', 'sha256', 'mode'] : ['kind', 'path', 'mode']);
        if (typeof item.path !== 'string' || seen.has(item.path.normalize('NFC')) ||
            !Number.isSafeInteger(item.mode) || (item.mode as number) < 0 || (item.mode as number) > 0o777 ||
            ((item.mode as number) & 0o022)) throw Error('LINUX_OBSERVED_MEMBER');
        seen.add(item.path.normalize('NFC'));
        if (item.kind === 'file') {
            if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 ||
                (item.bytes as number) > 2 * 1024 ** 3 || typeof item.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('LINUX_OBSERVED_MEMBER');
            files.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, mode: item.mode });
        }
        else if (item.kind === 'directory' && ((item.mode as number) & 0o500) === 0o500) directories.push(item.path);
        else throw Error('LINUX_OBSERVED_MEMBER');
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
    if (JSON.stringify(files) !== JSON.stringify(plan.files) || JSON.stringify(directories) !== JSON.stringify(plan.directories))
        throw Error('LINUX_OBSERVED_MEMBER_MISMATCH');
}
export function assertLinuxObservedDescriptor(plan: LinuxEnvelopePlan, bytes: Buffer) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024 ||
        bytes.toString('utf8') !== plan.descriptor || hash(bytes) !== plan.descriptorSHA256)
        throw Error('LINUX_OBSERVED_DESCRIPTOR');
}

type ArchiveEntry = { kind: 'file'; path: string; mode: number; bytes: number; sha256: string } |
    { kind: 'directory'; path: string; mode: number };
/** Established electron-builder tar prefix -> flat ROOT/app payload; raw facts stay explicit. */
export function normalizeLinuxPackagerCensus(input: unknown, asset: string) {
    if (asset !== 'Diagnostic-Hub-linux-x64.tar.gz') throw Error('LINUX_ARCHIVE_ASSET');
    const rootName = asset.slice(0, -'.tar.gz'.length);
    const c = closed(structuredClone(input), ['format', 'entries', 'files', 'directories', 'payloadBytes',
        'expandedBytes', 'compressedBytes', 'compressedSHA256']);
    const maxExpanded = 2 * 1024 ** 3 + 40000 * 512 + 20000 * 511 + 10240;
    if (c.format !== 'ustar' || !Array.isArray(c.entries) || !c.entries.length || c.entries.length > 40000 ||
        !Number.isSafeInteger(c.files) || (c.files as number) < 1 || (c.files as number) > 20000 ||
        !Number.isSafeInteger(c.directories) || (c.directories as number) < 1 || (c.directories as number) > 20000 ||
        !Number.isSafeInteger(c.payloadBytes) || (c.payloadBytes as number) < 0 || (c.payloadBytes as number) > 2 * 1024 ** 3 ||
        !Number.isSafeInteger(c.expandedBytes) || (c.expandedBytes as number) < 1024 ||
        (c.expandedBytes as number) > maxExpanded || (c.expandedBytes as number) % 512 ||
        !Number.isSafeInteger(c.compressedBytes) || (c.compressedBytes as number) < 1 ||
        (c.compressedBytes as number) > 2 * 1024 ** 3 || typeof c.compressedSHA256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(c.compressedSHA256)) throw Error('LINUX_ARCHIVE_CENSUS');
    const safeName = (value: unknown): string => {
        if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') ||
            /^[a-z]:/i.test(value) || /[\\\x00-\x1f\x7f]/.test(value) ||
            value.split('/').some(part => !part || part === '.' || part === '..'))
            throw Error('LINUX_ARCHIVE_NAMESPACE');
        return value;
    };
    const actualEntries: ArchiveEntry[] = c.entries.map((value): ArchiveEntry => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('LINUX_ARCHIVE_MEMBER');
        const entry = value as Record<string, unknown>;
        closed(entry, entry.kind === 'file' ? ['kind', 'path', 'mode', 'bytes', 'sha256'] : ['kind', 'path', 'mode']);
        const filename = safeName(entry.path), mode = entry.mode as number;
        if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o022) || !(mode & 0o400))
            throw Error('LINUX_ARCHIVE_MEMBER');
        if (entry.kind === 'directory' && (mode & 0o100)) return { kind: 'directory', path: filename, mode };
        if (entry.kind !== 'file' || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 ||
            (entry.bytes as number) > 2 * 1024 ** 3 || typeof entry.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('LINUX_ARCHIVE_MEMBER');
        return { kind: 'file', path: filename, mode, bytes: entry.bytes as number, sha256: entry.sha256 };
    });
    const namespace = (entries: ArchiveEntry[]) => {
        const kinds = new Map<string, string>(), parents = new Set<string>();
        for (const entry of entries) {
            const key = safeName(entry.path).normalize('NFC');
            if (kinds.has(key) || entry.kind === 'file' && parents.has(key)) throw Error('LINUX_ARCHIVE_ALIAS');
            const parts = entry.path.split('/'); parts.pop();
            while (parts.length) {
                const parent = parts.join('/').normalize('NFC');
                if (kinds.get(parent) === 'file') throw Error('LINUX_ARCHIVE_ALIAS');
                parents.add(parent); if (parents.size > 20000) throw Error('LINUX_ARCHIVE_COUNT'); parts.pop();
            }
            kinds.set(key, entry.kind);
        }
        for (const parent of parents) if (kinds.get(parent) !== 'directory') throw Error('LINUX_ARCHIVE_PARENT');
    };
    namespace(actualEntries); // Validate before stripping ANY prefix.
    const roots = actualEntries.filter(entry => entry.path === rootName);
    if (roots.length !== 1 || roots[0].kind !== 'directory') throw Error('LINUX_ARCHIVE_WRAPPER');
    const payloadEntries: ArchiveEntry[] = [];
    for (const entry of actualEntries) {
        if (entry.path === rootName) continue;
        if (!entry.path.startsWith(rootName + '/')) throw Error('LINUX_ARCHIVE_MIXED_ROOT');
        payloadEntries.push({ ...entry, path: safeName(entry.path.slice(rootName.length + 1)) });
    }
    namespace(payloadEntries); // Also reject aliases/collisions in the mapped namespace.
    payloadEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const files = actualEntries.filter(entry => entry.kind === 'file');
    const directories = actualEntries.length - files.length;
    const payloadBytes = files.reduce((total, entry) => total + (entry.kind === 'file' ? entry.bytes : 0), 0);
    if (files.length !== c.files || directories !== c.directories || payloadBytes !== c.payloadBytes ||
        actualEntries.length !== (c.files as number) + (c.directories as number) ||
        Buffer.byteLength(JSON.stringify(actualEntries)) > 4 * 1024 ** 2 ||
        Buffer.byteLength(JSON.stringify(payloadEntries)) > 4 * 1024 ** 2)
        throw Error('LINUX_ARCHIVE_CENSUS');
    return { profile: 'electron-builder-linux-prefix' as const, format: 'ustar' as const, rootName, archiveRoot: { ...roots[0] }, actualEntries, payloadEntries, files: files.length,
        archiveDirectories: directories, directories: directories - 1,
        actualEntriesSHA256: hash(Buffer.from(JSON.stringify(actualEntries))),
        payloadEntriesSHA256: hash(Buffer.from(JSON.stringify(payloadEntries))) };
}
