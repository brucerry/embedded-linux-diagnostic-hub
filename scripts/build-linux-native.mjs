import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native/linux-rename-noreplace/rename-noreplace.c');
const binding = path.join(root, 'native/linux-rename-noreplace/binding.gyp');
const headers = path.resolve(path.dirname(process.execPath), '../include/node');
const compiler = '/usr/bin/cc';
const filename = 'diagnostic_hub_rename_noreplace.node';
const held = new Set(); // No failure cleanup, compiler retry, native load or installer dispatch.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (yes, code) => {
    if (!yes) throw Error(code);
};
function regular(file, maximum, uid) {
    const before = fs.lstatSync(file);
    need(
        before.isFile() &&
            !before.isSymbolicLink() &&
            before.nlink === 1 &&
            before.size > 0 &&
            before.size <= maximum &&
            (before.uid === 0 || before.uid === uid) &&
            (before.mode & 0o7022) === 0 &&
            fs.realpathSync(file) === file,
        'LINUX_NATIVE_BUILD_INPUT',
    );
    const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    held.add(fd);
    const active = fs.fstatSync(fd);
    need(
        active.dev === before.dev &&
            active.ino === before.ino &&
            active.size === before.size &&
            active.mode === before.mode,
        'LINUX_NATIVE_BUILD_INPUT_CHANGED',
    );
    const bytes = Buffer.alloc(before.size);
    let used = 0;
    while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
        need(count > 0 && count <= bytes.length - used, 'LINUX_NATIVE_BUILD_READ');
        used += count;
    }
    const after = fs.fstatSync(fd);
    need(
        after.dev === before.dev &&
            after.ino === before.ino &&
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs,
        'LINUX_NATIVE_BUILD_INPUT_CHANGED',
    );
    return { bytes, sha256: sha(bytes), fd };
}
function ancestors(directory, uid) {
    let cursor = '/';
    for (const part of directory.split('/').filter(Boolean)) {
        cursor = path.posix.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        need(
            stat.isDirectory() &&
                !stat.isSymbolicLink() &&
                (stat.uid === 0 || stat.uid === uid) &&
                (stat.mode & 0o7022) === 0 &&
                fs.realpathSync(cursor) === cursor,
            'LINUX_NATIVE_BUILD_PARENT',
        );
    }
}
/** One local fixed C/Node-API8 compile into a fresh caller-selected private directory. */
export async function buildLinuxNative(outputDirectory) {
    need(
        process.platform === 'linux' && process.arch === 'x64' && process.getuid && process.geteuid,
        'LINUX_NATIVE_BUILD_PLATFORM',
    );
    const uid = process.getuid();
    need(uid > 0 && uid === process.geteuid(), 'LINUX_NATIVE_BUILD_USER');
    need(
        typeof outputDirectory === 'string' &&
            outputDirectory.startsWith('/') &&
            outputDirectory.length <= 4096 &&
            path.posix.normalize(outputDirectory) === outputDirectory &&
            outputDirectory !== '/' &&
            !/[\\\x00-\x1f\x7f]/.test(outputDirectory),
        'LINUX_NATIVE_BUILD_OUTPUT',
    );
    const parent = path.dirname(outputDirectory);
    ancestors(parent, uid);
    ancestors(headers, uid);
    const c = regular(source, 1024 * 1024, uid),
        gyp = regular(binding, 65536, uid);
    const headerHashes = {};
    for (const name of [
        'node_api.h',
        'node_api_types.h',
        'js_native_api.h',
        'js_native_api_types.h',
    ])
        headerHashes[name] = regular(path.join(headers, name), 1024 * 1024, uid).sha256;
    // mkdir without recursive/exist-ok refuses all pre-existing output, including symlinks.
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const directoryFD = fs.openSync(
        outputDirectory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    held.add(directoryFD);
    const directory = fs.fstatSync(directoryFD);
    need(
        directory.uid === uid &&
            (directory.mode & 0o7777) === 0o700 &&
            fs.realpathSync('/proc/self/fd/' + directoryFD) === outputDirectory,
        'LINUX_NATIVE_BUILD_OUTPUT_CHANGED',
    );
    const output = path.join(outputDirectory, filename);
    const args = [
        '-std=c17',
        '-shared',
        '-fPIC',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fvisibility=hidden',
        '-DNAPI_VERSION=8',
        '-I',
        headers,
        source,
        '-o',
        output,
    ];
    // No shell, npm, node-gyp, download, compiler option/env port or automatic retry.
    const child = spawn(compiler, args, {
        cwd: outputDirectory,
        shell: false,
        stdio: 'inherit',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: outputDirectory },
    });
    held.add(child); // Adopt the process before listener registration; no kill/cancel path.
    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0 && signal === null) {
                held.delete(child);
                resolve();
            } else reject(Error('LINUX_NATIVE_BUILD_COMPILER_FAILED'));
        });
    });
    need(
        fs.realpathSync('/proc/self/fd/' + directoryFD) === outputDirectory &&
            fs.lstatSync(outputDirectory).ino === directory.ino &&
            fs.lstatSync(outputDirectory).dev === directory.dev,
        'LINUX_NATIVE_BUILD_OUTPUT_CHANGED',
    );
    need(
        sha(regular(source, 1024 * 1024, uid).bytes) === c.sha256 &&
            sha(regular(binding, 65536, uid).bytes) === gyp.sha256,
        'LINUX_NATIVE_BUILD_SOURCE_CHANGED',
    );
    const binary = regular(output, 32 * 1024 * 1024, uid);
    need(
        binary.bytes.length >= 64 &&
            binary.bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
            binary.bytes[4] === 2 &&
            binary.bytes[5] === 1 &&
            binary.bytes.readUInt16LE(16) === 3 &&
            binary.bytes.readUInt16LE(18) === 62,
        'LINUX_NATIVE_BUILD_ELF',
    );
    fs.fsyncSync(binary.fd);
    fs.fsyncSync(directoryFD);
    const info = {
        schemaVersion: 1,
        abiVersion: 1,
        napiVersion: 8,
        statusVersion: 1,
        platform: 'linux',
        arch: 'x64',
        filename,
        bytes: binary.bytes.length,
        sha256: binary.sha256,
        sourceSHA256: c.sha256,
        bindingSHA256: gyp.sha256,
        headerHashes,
    };
    fs.writeFileSync(
        path.join(outputDirectory, 'build-info.json'),
        JSON.stringify(info, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
    );
    fs.fsyncSync(directoryFD);
    for (const item of held)
        if (typeof item === 'number') {
            fs.closeSync(item);
            held.delete(item);
        }
    return Object.freeze(info);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output-dir') {
        process.stderr.write('LINUX_NATIVE_BUILD_ARGUMENTS\n');
        process.exitCode = 1;
    } else
        void buildLinuxNative(args[1])
            .then((info) => {
                process.stdout.write(JSON.stringify(info) + '\n');
            })
            .catch(() => {
                process.stderr.write('LINUX_NATIVE_BUILD_FAILED_RETAINED\n');
                process.exitCode = 1;
            });
}
