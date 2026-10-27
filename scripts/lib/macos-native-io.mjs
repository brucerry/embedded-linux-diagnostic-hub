import assert from 'node:assert/strict';
import nativeFS from 'node:fs';
import path from 'node:path';
import { spawn as nativeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { release as osRelease } from 'node:os';
import { NATIVE_TASK, NATIVE_LIMITS } from './macos-native-contract.mjs';

// Fixed local test IO only. Construction/import does not query files, allocate, or launch.
export function createMacNativeIO(start = performance.now(), dependencies = {}) {
    const fs = dependencies.fs ?? nativeFS,
        spawn = dependencies.spawn ?? nativeSpawn;
    const now = dependencies.now ?? (() => performance.now());
    let fail;
    const failed = new Promise((_, reject) => {
        fail = reject;
    });
    void failed.catch(() => {});
    const state = {
        root: null,
        claim: null,
        rootAllocated: false,
        deadline: start + NATIVE_LIMITS.windowMs,
        reason: null,
        sequence: 0,
        pending: new Map(),
        fds: new Set(),
        allocations: [],
        children: [],
        desktops: [],
        terminalBytes: 0,
        terminalRows: 0,
        evidenceBytes: 0,
    };
    const freeze = (reason) => {
        if (!state.reason) {
            state.reason = reason;
            fail(Error(reason));
        }
    };
    const gate = () => {
        if (state.reason) throw Error(state.reason);
        if (now() >= state.deadline) {
            freeze('native-deadline');
            throw Error('native-deadline');
        }
    };
    function sync(label, work, adopt) {
        gate();
        const id = ++state.sequence,
            record = { label, phase: 'submitted' };
        state.pending.set(id, record);
        try {
            const value = work();
            record.phase = 'returned';
            record.value = value;
            adopt?.(value);
            gate();
            state.pending.delete(id);
            return value;
        } catch (error) {
            record.phase = record.phase === 'returned' ? 'returned' : 'rejected';
            record.error = error;
            freeze('native-io-refusal');
            throw Error('native-io-refusal');
        }
    }
    async function wait(label, work) {
        gate();
        const id = ++state.sequence,
            record = { label, phase: 'submitted', task: null };
        state.pending.set(id, record);
        let timer;
        try {
            record.task = Promise.resolve()
                .then(() => {
                    gate();
                    return work();
                })
                .then((value) => {
                    record.phase = 'returned';
                    record.value = value;
                    return value;
                });
            void record.task.catch(() => {});
            const value = await Promise.race([
                record.task,
                failed,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => {
                            freeze('native-deadline');
                            reject(Error('native-deadline'));
                        },
                        Math.max(0, state.deadline - now()),
                    );
                }),
            ]);
            gate();
            state.pending.delete(id);
            return value;
        } catch (error) {
            record.error = error;
            freeze('native-async-refusal');
            throw Error('native-async-refusal');
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    function plainParent(file) {
        const parent = path.dirname(file);
        assert.equal(
            sync('canonical-parent', () => fs.realpathSync(parent)),
            parent,
        );
    }
    function writable(file) {
        assert.ok(
            state.root &&
                (file === state.root || file === state.claim || file.startsWith(state.root + '/')),
        );
        assert.equal(path.normalize(file), file);
        plainParent(file);
    }
    function open(file, flags, mode) {
        return sync(
            'open',
            () => fs.openSync(file, flags, mode),
            (fd) => state.fds.add(fd),
        );
    }
    function close(fd) {
        sync(
            'close',
            () => fs.closeSync(fd),
            () => state.fds.delete(fd),
        );
    }
    function regular(fd) {
        const s = sync('fstat', () => fs.fstatSync(fd));
        assert.ok(s.isFile() && s.nlink === 1);
        return s;
    }
    function stable(a, b) {
        for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'])
            assert.equal(a[key], b[key]);
    }
    function read(file, cap) {
        plainParent(file);
        const fd = open(
            file,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        const before = regular(fd);
        assert.ok(before.size <= cap);
        const bytes = Buffer.alloc(before.size);
        let at = 0;
        while (at < bytes.length) {
            const n = sync('read', () => fs.readSync(fd, bytes, at, bytes.length - at, null));
            assert.ok(n > 0);
            at += n;
        }
        assert.equal(
            sync('read-eof', () => fs.readSync(fd, Buffer.alloc(1), 0, 1, null)),
            0,
        );
        stable(before, regular(fd));
        close(fd);
        return bytes;
    }
    function hash(file, expectedBytes) {
        plainParent(file);
        const fd = open(
            file,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        const before = regular(fd);
        assert.equal(before.size, expectedBytes);
        const chunk = Buffer.alloc(65536),
            digest = createHash('sha256');
        let total = 0;
        for (;;) {
            const n = sync('hash-read', () =>
                fs.readSync(fd, chunk, 0, Math.min(chunk.length, expectedBytes - total + 1), null),
            );
            if (!n) break;
            total += n;
            assert.ok(total <= expectedBytes);
            digest.update(chunk.subarray(0, n));
        }
        stable(before, regular(fd));
        close(fd);
        assert.equal(total, expectedBytes);
        return { bytes: total, sha256: digest.digest('hex') };
    }
    function publish(file, bytes, cap = 65536, mode = 0o600, evidence = false) {
        assert.ok(Buffer.isBuffer(bytes) && bytes.length <= cap);
        writable(file);
        if (evidence) {
            assert.ok(state.evidenceBytes + bytes.length <= NATIVE_LIMITS.evidenceBytes);
            state.evidenceBytes += bytes.length;
        }
        const fd = open(
            file,
            fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW,
            mode,
        );
        let at = 0;
        while (at < bytes.length) {
            const n = sync('write', () =>
                fs.writeSync(fd, bytes, at, Math.min(65536, bytes.length - at)),
            );
            assert.ok(n > 0);
            at += n;
        }
        sync('sync', () => fs.fsyncSync(fd));
        close(fd);
        const parent = open(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        sync('parent-sync', () => fs.fsyncSync(parent));
        close(parent);
        assert.deepEqual(read(file, cap), bytes);
    }
    function mkdir(directory, mode = 0o700) {
        writable(directory);
        sync(
            'mkdir',
            () => fs.mkdirSync(directory, { mode }),
            () => {
                state.allocations.push(directory);
                if (directory === state.root) state.rootAllocated = true;
            },
        );
        sync('new-directory-mode', () => fs.chmodSync(directory, mode));
        const s = sync('directory-type', () => fs.lstatSync(directory));
        assert.ok(s.isDirectory() && !s.isSymbolicLink());
        assert.equal(
            sync('directory-canonical', () => fs.realpathSync(directory)),
            directory,
        );
    }
    function take(bytes) {
        if (state.reason || state.terminalBytes + bytes > NATIVE_LIMITS.terminalBytes) {
            freeze('terminal-cap');
            return false;
        }
        state.terminalBytes += bytes;
        return true;
    }
    function row() {
        gate();
        assert.ok(state.terminalRows < NATIVE_LIMITS.terminalRows);
        state.terminalRows++;
    }
    async function child(executable, args, env, cwd) {
        row();
        const record = {
            executable,
            args: [...args],
            child: null,
            stdout: [],
            stderr: [],
            stdoutBytes: 0,
            stderrBytes: 0,
            exitObserved: false,
            closeObserved: false,
            stdoutEOF: false,
            stderrEOF: false,
            exitCode: null,
            signal: null,
            error: 'none',
        };
        state.children.push(record);
        return wait(
            'child-close',
            () =>
                new Promise((resolve, reject) => {
                    gate();
                    const owned = spawn(executable, args, {
                        cwd,
                        env,
                        shell: false,
                        detached: false,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    record.child = owned;
                    for (const stream of ['stdout', 'stderr']) {
                        owned[stream].on('data', (value) => {
                            record[stream + 'Bytes'] += value.length;
                            if (
                                record[stream + 'Bytes'] > NATIVE_LIMITS.streamBytes ||
                                !take(value.length)
                            ) {
                                freeze('child-stream-cap');
                                return;
                            }
                            record[stream].push(Buffer.from(value));
                        });
                        owned[stream].on('end', () => {
                            record[stream + 'EOF'] = true;
                        });
                        owned[stream].on('error', () => {
                            record.error = 'spawn-error';
                            freeze('child-stream-error');
                            reject(Error('child-stream-error'));
                        });
                    }
                    owned.on('error', () => {
                        record.error = 'spawn-error';
                        freeze('child-error');
                        reject(Error('child-error'));
                    });
                    owned.on('exit', (code, signal) => {
                        record.exitObserved = true;
                        record.exitCode = code;
                        record.signal = signal;
                    });
                    owned.on('close', () => {
                        record.closeObserved = true;
                        if (!record.exitObserved || !record.stdoutEOF || !record.stderrEOF) {
                            freeze('child-closure-unknown');
                            reject(Error('child-closure-unknown'));
                            return;
                        }
                        resolve({
                            command: [executable, ...args],
                            exitObserved: true,
                            exitCode: record.exitCode,
                            signal: record.signal,
                            error: record.error,
                            stdout: Buffer.concat(record.stdout).toString('utf8'),
                            stderr: Buffer.concat(record.stderr).toString('utf8'),
                        });
                    });
                    gate();
                }),
        );
    }
    function tree(root, expected) {
        assert.ok(root.startsWith(state.root + '/'));
        assert.equal(
            sync('tree-root', () => fs.realpathSync(root)),
            root,
        );
        const rootStat = sync('tree-root-stat', () => fs.lstatSync(root));
        assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
        const rows = [
            {
                path: '.',
                kind: 'directory',
                mode: rootStat.mode & 0o777,
                dev: rootStat.dev,
                ino: rootStat.ino,
            },
        ];
        const directoryRows = [
            { path: '.', kind: 'directory' },
            ...expected.filter((item) => item.kind === 'directory'),
        ];
        for (const directory of directoryRows) {
            const dir = directory.path === '.' ? root : path.join(root, directory.path);
            const children = expected
                .filter((item) => path.posix.dirname(item.path) === directory.path)
                .map((item) => path.posix.basename(item.path))
                .sort();
            assert.deepEqual(sync('tree-enumeration', () => fs.readdirSync(dir)).sort(), children);
        }
        for (const item of expected) {
            const file = path.join(root, item.path);
            plainParent(file);
            const stat = sync('tree-lstat', () => fs.lstatSync(file));
            const row = { ...item, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
            if (item.kind === 'directory') assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
            else if (item.kind === 'symlink') {
                assert.ok(stat.isSymbolicLink());
                assert.equal(
                    sync('tree-link', () => fs.readlinkSync(file)),
                    item.target,
                );
            } else {
                assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
                assert.deepEqual(hash(file, item.bytes), {
                    bytes: item.bytes,
                    sha256: item.sha256,
                });
            }
            if (item.mode !== undefined) assert.equal(row.mode, item.mode);
            rows.push(row);
        }
        return rows;
    }
    function copyTree(source, destination, expected) {
        const snapshot = tree(source, expected);
        mkdir(destination, snapshot[0].mode);
        for (const node of snapshot
            .filter((item) => item.path !== '.' && item.kind === 'directory')
            .sort((a, b) => a.path.split('/').length - b.path.split('/').length))
            mkdir(path.join(destination, node.path), node.mode);
        for (const node of snapshot.filter((item) => item.kind !== 'directory')) {
            const from = path.join(source, node.path),
                to = path.join(destination, node.path);
            writable(to);
            if (node.kind === 'symlink') sync('copy-link', () => fs.symlinkSync(node.target, to));
            else {
                const input = open(
                    from,
                    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
                );
                const output = open(
                    to,
                    fs.constants.O_WRONLY |
                        fs.constants.O_CREAT |
                        fs.constants.O_EXCL |
                        fs.constants.O_NOFOLLOW,
                    node.mode,
                );
                let at = 0;
                const buffer = Buffer.alloc(65536);
                while (at < node.bytes) {
                    const n = sync('copy-read', () =>
                        fs.readSync(
                            input,
                            buffer,
                            0,
                            Math.min(buffer.length, node.bytes - at),
                            null,
                        ),
                    );
                    assert.ok(n > 0);
                    let written = 0;
                    while (written < n) {
                        const k = sync('copy-write', () =>
                            fs.writeSync(output, buffer, written, n - written),
                        );
                        assert.ok(k > 0);
                        written += k;
                    }
                    at += n;
                }
                sync('new-copy-mode', () => fs.fchmodSync(output, node.mode));
                sync('copy-sync', () => fs.fsyncSync(output));
                close(output);
                close(input);
            }
        }
        tree(destination, expected);
        return snapshot;
    }
    function removeTree(root, expected, snapshot) {
        tree(root, expected);
        const records = [...snapshot].sort(
            (a, b) =>
                b.path.split('/').length - a.path.split('/').length || (a.path < b.path ? 1 : -1),
        );
        for (const node of records) {
            const file = node.path === '.' ? root : path.join(root, node.path);
            writable(file);
            const current = sync('remove-identity', () => fs.lstatSync(file));
            assert.equal(current.dev, node.dev);
            assert.equal(current.ino, node.ino);
            if (node.kind === 'file')
                assert.deepEqual(hash(file, node.bytes), {
                    bytes: node.bytes,
                    sha256: node.sha256,
                });
            if (node.kind === 'directory') sync('remove-empty-directory', () => fs.rmdirSync(file));
            else sync('remove-file-or-link', () => fs.unlinkSync(file));
        }
    }
    return {
        state,
        gate,
        freeze,
        sync,
        wait,
        read,
        hash,
        publish,
        mkdir,
        tree,
        copyTree,
        removeTree,
        child,
        take,
        row,
        nowUTC: () => Date.now(),
        setExpiry: (expiry, allowance) => {
            state.deadline = Math.min(state.deadline, now() + expiry - Date.now() - allowance);
            gate();
        },
        metadata: () => ({
            platform: process.platform,
            arch: process.arch,
            node: process.versions.node,
            executable: process.execPath,
            osRelease: osRelease(),
        }),
        canonicalDir: (dir) => sync('canonical-input-parent', () => fs.realpathSync(dir)),
        absent: (file) =>
            sync('expected-absence', () => {
                try {
                    fs.lstatSync(file);
                    return false;
                } catch (error) {
                    if (error.code === 'ENOENT') return true;
                    throw error;
                }
            }),
        stat: (file) => sync('owned-stat', () => fs.lstatSync(file)),
        freeBytes: () => {
            const st = sync('free-space', () => fs.statfsSync(NATIVE_TASK));
            return BigInt(st.bavail) * BigInt(st.bsize);
        },
        async claim(admitted) {
            gate();
            state.root = admitted.parsed.root;
            state.claim = state.root + '.SPENT.json';
            const bytes = Buffer.from(
                JSON.stringify({ state: 'SPENT', ...admitted.summary }) + '\n',
            );
            assert.ok(bytes.length <= NATIVE_LIMITS.admissionBytes);
            publish(state.claim, bytes, NATIVE_LIMITS.admissionBytes, 0o600, true);
        },
        allocateRoot() {
            mkdir(state.root);
            state.rootAllocated = true;
        },
        async sourceContext(cwd, approval) {
            const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
            const head = await child('/usr/bin/git', ['rev-parse', 'HEAD'], env, cwd),
                branch = await child('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], env, cwd),
                clean = await child(
                    '/usr/bin/git',
                    ['status', '--porcelain', '--untracked-files=no'],
                    env,
                    cwd,
                );
            for (const value of [head, branch, clean])
                assert.ok(value.exitCode === 0 && value.signal === null && value.error === 'none');
            assert.equal(head.stdout.trim(), approval.sourceCommit);
            assert.equal(branch.stdout.trim(), approval.sourceTree);
            assert.equal(clean.stdout, '');
        },
        withinWindow: () => !state.reason && now() < state.deadline,
        beforeExpiry: () => now() < state.deadline,
        needsHold: () =>
            [...state.pending.values()].some((item) => item.phase === 'submitted') ||
            state.fds.size > 0 ||
            state.children.some((item) => !item.closeObserved) ||
            state.desktops.some((item) => !item.closed),
    };
}
