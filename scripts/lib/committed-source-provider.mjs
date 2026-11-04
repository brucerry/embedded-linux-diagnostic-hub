import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { SOURCE_LIMITS } from './committed-source-bridge.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
    oid = /^[a-f0-9]{40}$/;
const gitLimit = SOURCE_LIMITS.total + 8 * 1024 ** 2;
function failures(errors, message) {
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, message, { cause: errors[0] });
}
function same(before, after) {
    assert.ok(
        after.isFile() && !after.isSymbolicLink() && after.nlink === 1,
        'Source file is aliased or special.',
    );
    for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'])
        assert.equal(after[field], before[field], 'Source changed during stable read.');
}
/** @param {{realpath: Function, lstat: Function, open: Function}} filesystem */
export async function readStableSourceFile(
    root,
    relative,
    maximum = SOURCE_LIMITS.blob,
    filesystem = fs,
) {
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= SOURCE_LIMITS.blob);
    assert.ok(
        typeof relative === 'string' &&
            relative.length > 0 &&
            !relative
                .split('/')
                .some((part) => !part || part === '.' || part === '..' || part.includes('\\')),
    );
    const file = path.join(root, ...relative.split('/'));
    assert.equal(await filesystem.realpath(file), file, 'Source file path is not canonical.');
    const before = await filesystem.lstat(file);
    same(before, before);
    assert.ok(before.size >= 0 && before.size <= maximum, 'Source file bound exceeded.');
    const handle = await filesystem.open(file, 'r'),
        errors = [];
    let result;
    try {
        same(before, await handle.stat());
        const buffer = Buffer.alloc(Math.min(64 * 1024, before.size + 1)),
            chunks = [];
        let size = 0;
        for (;;) {
            const { bytesRead } = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, maximum + 1 - size),
                null,
            );
            if (!bytesRead) break;
            size += bytesRead;
            assert.ok(size <= maximum, 'Source file grew beyond bound.');
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        assert.equal(size, before.size);
        same(before, await handle.stat());
        same(before, await filesystem.lstat(file));
        assert.equal(await filesystem.realpath(file), file);
        result = { mode: before.mode & 0o100 ? '100755' : '100644', bytes: Buffer.concat(chunks) };
    } catch (error) {
        errors.push(error);
    }
    try {
        await handle.close();
    } catch (error) {
        errors.push(error);
    }
    failures(errors, 'Source read/close failed.');
    assert.ok(result);
    return result;
}
/** Local raw-object reads only: no checkout, filters, remote, hooks, fsmonitor or index refresh. */
export async function localSourceProvider(
    directory,
    {
        filesystem = fs,
        execute = execFileSync,
        platform = process.platform,
        environment = process.env,
    } = {},
) {
    assert.ok(path.isAbsolute(directory));
    assert.equal(await filesystem.realpath(directory), directory);
    assert.notEqual(
        platform,
        'win32',
        'Native executable-mode evidence on Windows is unsupported.',
    );
    for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_COMMON_DIR',
        'GIT_NAMESPACE',
        'GIT_CONFIG',
        'GIT_CONFIG_SYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_PARAMETERS',
        'GIT_REPLACE_REF_BASE',
        'GIT_SHALLOW_FILE',
    ])
        assert.ok(environment[key] === undefined, 'Ambient Git override is unsupported: ' + key);
    const commandEnvironment = Object.freeze({
        ...environment,
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
    });
    const git = (args, input, maximum = gitLimit, missing = false) => {
        try {
            return execute(
                'git',
                [
                    '--no-replace-objects',
                    '--no-pager',
                    '-c',
                    'core.fsmonitor=false',
                    '-c',
                    'core.untrackedCache=false',
                    '-c',
                    'core.hooksPath=/dev/null',
                    ...args,
                ],
                {
                    cwd: directory,
                    input,
                    maxBuffer: maximum,
                    env: commandEnvironment,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: false,
                    timeout: 30000,
                },
            );
        } catch (error) {
            if (missing && error.status === 1 && error.stdout?.length === 0) return Buffer.alloc(0);
            throw new Error(
                'Read-only Git operation failed: ' +
                    args[0] +
                    '; status=' +
                    String(error.status ?? error.code ?? 'unknown'),
            );
        }
    };
    const text = (args) => decoder.decode(git(args, undefined, 1024 * 1024)).trim();
    assert.equal(text(['rev-parse', '--show-toplevel']), directory);
    assert.equal(
        text(['rev-parse', '--show-object-format']),
        'sha1',
        'Only SHA1 Git object format is supported.',
    );
    assert.equal(text(['rev-parse', '--show-prefix']), '');
    assert.equal(
        git(
            [
                'config',
                '--includes',
                '--name-only',
                '--get-regexp',
                '^(extensions\.partialclone|remote\..*\.promisor)$',
            ],
            undefined,
            1024 * 1024,
            true,
        ).length,
        0,
        'Partial/promisor source is unsupported; no lazy fetch is permitted.',
    );
    return {
        async state() {
            const sourceCommit = text(['rev-parse', '--verify', 'HEAD']),
                sourceTree = text(['rev-parse', '--verify', 'HEAD^{tree}']);
            assert.match(sourceCommit, oid);
            assert.match(sourceTree, oid);
            const raw = git(['ls-files', '--stage', '--sparse', '-z'], undefined, 8 * 1024 ** 2),
                index = [];
            let offset = 0;
            while (offset < raw.length) {
                const end = raw.indexOf(0, offset);
                assert.ok(end > offset);
                const entry = decoder.decode(raw.subarray(offset, end)),
                    tab = entry.indexOf('\t');
                assert.ok(tab > 0);
                const fields = entry.slice(0, tab).split(' ');
                assert.equal(fields.length, 3);
                assert.match(fields[1], oid);
                assert.match(fields[2], /^[0-3]$/);
                index.push({
                    path: entry.slice(tab + 1),
                    mode: fields[0],
                    oid: fields[1],
                    stage: Number(fields[2]),
                });
                assert.ok(index.length <= SOURCE_LIMITS.files);
                offset = end + 1;
            }
            return { sourceCommit, sourceTree, index };
        },
        async objects(ids) {
            assert.ok(ids.length > 0 && ids.length <= 64);
            ids.forEach((value) => assert.match(value, oid));
            const metadata = decoder.decode(
                git(['cat-file', '--batch-check'], ids.join('\n') + '\n', 1024 * 1024),
            );
            assert.ok(metadata.endsWith('\n'));
            const lines = metadata.slice(0, -1).split('\n');
            assert.equal(lines.length, ids.length);
            let total = 0;
            const headers = lines.map((line, i) => {
                const fields = line.split(' ');
                assert.equal(fields.length, 3);
                assert.equal(fields[0], ids[i]);
                assert.ok(['commit', 'tree', 'blob'].includes(fields[1]));
                assert.match(fields[2], /^(?:0|[1-9]\d*)$/);
                const size = Number(fields[2]);
                assert.ok(Number.isSafeInteger(size) && size <= SOURCE_LIMITS[fields[1]]);
                total += size;
                assert.ok(total <= SOURCE_LIMITS.total);
                return fields;
            });
            const raw = git(
                    ['cat-file', '--batch'],
                    ids.join('\n') + '\n',
                    total + ids.length * 128,
                ),
                result = [];
            let offset = 0;
            for (const wanted of ids) {
                const end = raw.indexOf(10, offset);
                assert.ok(end > offset);
                const fields = decoder.decode(raw.subarray(offset, end)).split(' ');
                assert.equal(fields.length, 3);
                assert.equal(fields[0], wanted);
                assert.deepEqual(
                    fields,
                    headers[result.length],
                    'Git object changed between size and body reads.',
                );
                assert.ok(['commit', 'tree', 'blob'].includes(fields[1]));
                assert.match(fields[2], /^(?:0|[1-9]\d*)$/);
                const size = Number(fields[2]);
                assert.ok(Number.isSafeInteger(size) && size <= SOURCE_LIMITS.blob);
                const start = end + 1;
                assert.ok(start + size < raw.length && raw[start + size] === 10);
                result.push({
                    oid: wanted,
                    type: fields[1],
                    bytes: Buffer.from(raw.subarray(start, start + size)),
                });
                offset = start + size + 1;
            }
            assert.equal(offset, raw.length);
            return result;
        },
        async entries(relative) {
            const full = relative ? path.join(directory, ...relative.split('/')) : directory;
            assert.equal(
                await filesystem.realpath(full),
                full,
                'Source directory is not canonical.',
            );
            const stat = await filesystem.lstat(full);
            assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
            const handle = await filesystem.opendir(full),
                entries = [],
                errors = [];
            try {
                for (;;) {
                    const entry = await handle.read();
                    if (!entry) break;
                    assert.ok(entries.length < SOURCE_LIMITS.entries);
                    entries.push({
                        name: entry.name,
                        kind: entry.isSymbolicLink()
                            ? 'symlink'
                            : entry.isDirectory()
                              ? 'directory'
                              : entry.isFile()
                                ? 'file'
                                : 'special',
                    });
                }
                const after = await filesystem.lstat(full);
                assert.equal(after.dev, stat.dev);
                assert.equal(after.ino, stat.ino);
                assert.equal(after.mtimeMs, stat.mtimeMs);
                assert.equal(after.ctimeMs, stat.ctimeMs);
                assert.equal(await filesystem.realpath(full), full);
            } catch (error) {
                errors.push(error);
            }
            try {
                await handle.close();
            } catch (error) {
                errors.push(error);
            }
            failures(errors, 'Source directory read/close failed.');
            return entries;
        },
        file: (relative) =>
            readStableSourceFile(directory, relative, SOURCE_LIMITS.blob, filesystem),
    };
}
/** @param {{realpath: Function, lstat: Function, open: Function, mkdir: Function}} filesystem */
export async function writeSourceBridge(root, relative, record, filesystem = fs) {
    const destination = path.resolve(root, relative),
        base = path.join(root, 'validation'),
        pathFromBase = path.relative(base, destination);
    assert.ok(
        pathFromBase && !pathFromBase.startsWith('..') && !path.isAbsolute(pathFromBase),
        'Source bridge output must stay under validation/.',
    );
    let current = root;
    for (const part of path.relative(root, path.dirname(destination)).split(path.sep)) {
        current = path.join(current, part);
        try {
            await filesystem.mkdir(current);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const stat = await filesystem.lstat(current);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        assert.equal(await filesystem.realpath(current), current);
    }
    const bytes = JSON.stringify(record) + '\n';
    assert.ok(Buffer.byteLength(bytes) <= SOURCE_LIMITS.metadata);
    const handle = await filesystem.open(destination, 'wx'),
        errors = [];
    try {
        await handle.writeFile(bytes);
    } catch (error) {
        errors.push(error);
    }
    try {
        await handle.sync();
    } catch (error) {
        errors.push(error);
    }
    try {
        await handle.close();
    } catch (error) {
        errors.push(error);
    }
    failures(errors, 'Source bridge write/sync/close failed.');
    return destination;
}
