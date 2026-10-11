import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { UUID, SHELL_MAJORS } from '../../linux/gnome-genie/geometry.js';
import { legacyExtension, legacyGeometry } from './genie-legacy.mjs';

export const GENIE_SOURCE = ['LICENSE', 'app-icon.png', 'extension.js', 'geometry.js', 'setup.py'];
export const GENIE_FILES = [...GENIE_SOURCE, 'build-info.js', 'metadata.json'].sort();
export const GENIE_FORMATS = ['modern', 'legacy42'];
export function formatShells(format) {
    if (!GENIE_FORMATS.includes(format)) throw Error('Unknown companion format.');
    return format === 'legacy42' ? [42] : SHELL_MAJORS;
}
export function genieAsset(version, format = 'modern') {
    formatShells(format);
    return `Diagnostic-Hub-Genie${format === 'legacy42' ? '-Legacy42' : ''}-${version}.zip`;
}
export const buildModule = (build) =>
    `${build.format === 'legacy42' ? 'var' : 'export const'} BUILD = Object.freeze(${JSON.stringify(build)});\n`;

export function sourceHash(files) {
    const hash = createHash('sha256');
    for (const name of [...GENIE_SOURCE].sort()) hash.update(name + '\0').update(files[name]);
    return hash.digest('hex');
}

export async function createGeniePackage(root, version, commit, format = 'modern') {
    const shells = formatShells(format);
    const { zipSync } = await import('fflate');
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) {
        throw Error('Companion requires a release version and immutable source commit.');
    }
    const files = {};
    for (const name of GENIE_SOURCE) {
        const file =
            name === 'LICENSE'
                ? path.join(root, 'LICENSE')
                : name === 'app-icon.png'
                  ? path.join(root, 'public', name)
                  : path.join(root, 'linux/gnome-genie', name);
        if (!(await lstat(file)).isFile()) throw Error(`Invalid companion source: ${name}`);
        files[name] = new Uint8Array(await readFile(file));
    }
    if (format === 'legacy42') {
        const adapter = path.join(root, 'linux/gnome-genie/legacy-entry.js');
        if (!(await lstat(adapter)).isFile()) throw Error('Invalid legacy adapter source.');
        files['extension.js'] = new TextEncoder().encode(
            legacyExtension(
                new TextDecoder().decode(files['extension.js']),
                await readFile(adapter, 'utf8'),
            ),
        );
        files['geometry.js'] = new TextEncoder().encode(
            legacyGeometry(new TextDecoder().decode(files['geometry.js'])),
        );
    }
    const build = { version, commit, format, sourceHash: sourceHash(files) };
    const metadata = JSON.parse(
        await readFile(path.join(root, 'linux/gnome-genie/metadata.json'), 'utf8'),
    );
    metadata['shell-version'] = shells.map(String);
    metadata['version-name'] = version;
    metadata['diagnostic-hub'] = build;
    files['metadata.json'] = new TextEncoder().encode(JSON.stringify(metadata, null, 4) + '\n');
    files['build-info.js'] = new TextEncoder().encode(buildModule(build));
    const zip = zipSync(
        Object.fromEntries(
            GENIE_FILES.map((name) => [
                name,
                [
                    files[name],
                    { level: 9, mtime: new Date('2000-01-01T00:00:00Z'), attrs: 0x81a40000 },
                ],
            ]),
        ),
    );
    validateGeniePackage(zip, version, commit, files, format);
    return { zip, build, files };
}

export function validateGeniePackage(bytes, version, commit, expectedFiles, format = 'modern') {
    const shells = formatShells(format);
    const zip = Buffer.from(bytes);
    const end = zip.length - 22;
    if (
        zip.length > 2 * 1024 * 1024 ||
        end < 0 ||
        zip.readUInt32LE(end) !== 0x06054b50 ||
        zip.readUInt16LE(end + 20) !== 0 ||
        zip.readUInt16LE(end + 10) !== GENIE_FILES.length
    ) {
        throw Error('Invalid companion ZIP directory.');
    }
    const entries = new Map();
    const centralStart = zip.readUInt32LE(end + 16);
    let position = centralStart;
    let expanded = 0;
    for (let index = 0; index < GENIE_FILES.length; index++) {
        if (position + 46 > end || zip.readUInt32LE(position) !== 0x02014b50)
            throw Error('Invalid ZIP member.');
        const nameLength = zip.readUInt16LE(position + 28);
        const mode = (zip.readUInt32LE(position + 38) >>> 16) & 0xf000;
        const name = zip.subarray(position + 46, position + 46 + nameLength).toString('utf8');
        const size = zip.readUInt32LE(position + 24);
        if (
            !GENIE_FILES.includes(name) ||
            entries.has(name) ||
            ![0, 0x8000].includes(mode) ||
            zip.readUInt16LE(position + 8) & 1 ||
            ![0, 8].includes(zip.readUInt16LE(position + 10))
        ) {
            throw Error('Unsafe companion archive member.');
        }
        entries.set(name, {
            size,
            crc: zip.readUInt32LE(position + 16),
            method: zip.readUInt16LE(position + 10),
            compressed: zip.readUInt32LE(position + 20),
            offset: zip.readUInt32LE(position + 42),
        });
        expanded += size;
        position +=
            46 + nameLength + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32);
    }
    if (position !== end || expanded > 2 * 1024 * 1024)
        throw Error('Invalid companion ZIP bounds.');
    const files = {};
    for (const [name, entry] of entries) {
        const offset = entry.offset;
        if (
            offset + 30 > centralStart ||
            zip.readUInt32LE(offset) !== 0x04034b50 ||
            zip.readUInt16LE(offset + 8) !== entry.method ||
            zip.readUInt16LE(offset + 6) & 1
        ) {
            throw Error('Invalid companion ZIP local header.');
        }
        const nameLength = zip.readUInt16LE(offset + 26);
        if (zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8') !== name) {
            throw Error('Companion ZIP local name mismatch.');
        }
        const start = offset + 30 + nameLength + zip.readUInt16LE(offset + 28);
        if (start + entry.compressed > centralStart)
            throw Error('Invalid companion ZIP payload bounds.');
        const payload = zip.subarray(start, start + entry.compressed);
        files[name] =
            entry.method === 8
                ? inflateRawSync(payload, { maxOutputLength: Math.max(1, entry.size) })
                : payload;
    }
    if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(GENIE_FILES)) {
        throw Error('Unexpected companion archive contents.');
    }
    for (const name of GENIE_FILES) {
        let crc = 0xffffffff;
        for (const byte of files[name]) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        if (
            files[name].length !== entries.get(name).size ||
            (crc ^ 0xffffffff) >>> 0 !== entries.get(name).crc
        ) {
            throw Error('Companion ZIP integrity mismatch.');
        }
    }
    const metadata = JSON.parse(new TextDecoder().decode(files['metadata.json']));
    const build = metadata['diagnostic-hub'];
    if (
        metadata.uuid !== UUID ||
        metadata['version-name'] !== version ||
        JSON.stringify(metadata['shell-version']) !== JSON.stringify(shells.map(String)) ||
        build?.version !== version ||
        build.format !== format ||
        build.commit !== commit ||
        build.sourceHash !== sourceHash(files) ||
        new TextDecoder().decode(files['build-info.js']) !== buildModule(build)
    ) {
        throw Error('Companion release or source identity mismatch.');
    }
    if (
        expectedFiles &&
        GENIE_FILES.some(
            (name) => !Buffer.from(files[name]).equals(Buffer.from(expectedFiles[name])),
        )
    ) {
        throw Error('Companion source parity mismatch.');
    }
    return build;
}
