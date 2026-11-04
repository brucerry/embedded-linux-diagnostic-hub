import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { observeOwnedChild } from '../../scripts/lib/owned-child.mjs';
import { gitObjectID, sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';

export function memoryFilesystem() {
    const records = new Map<string, any>(),
        handles = new Set<any>(),
        events: string[] = [];
    const hooks: Record<string, any> = {};
    let serial = 1,
        clock = 1;
    function directory(file: string) {
        if (records.has(file)) return;
        const parent = path.posix.dirname(file);
        if (parent !== file) directory(parent);
        records.set(file, {
            kind: 'directory',
            ino: serial++,
            bytes: Buffer.alloc(0),
            time: clock++,
        });
    }
    function write(file: string, bytes: Buffer, replace = false) {
        directory(path.posix.dirname(file));
        let entry = records.get(file);
        if (!entry || replace) {
            entry = { kind: 'file', ino: serial++, bytes: Buffer.alloc(0), time: clock++ };
            records.set(file, entry);
        }
        entry.bytes = Buffer.from(bytes);
        entry.time = clock++;
        return entry;
    }
    function stat(entry: any) {
        if (!entry) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
        return {
            dev: 1,
            ino: entry.ino,
            mode: entry.kind === 'directory' ? 0o40755 : 0o100644,
            size: entry.kind === 'file' ? entry.bytes.length : 0,
            mtimeMs: entry.time,
            ctimeMs: entry.time,
            nlink: entry.nlink ?? 1,
            isFile: () => entry.kind === 'file',
            isDirectory: () => entry.kind === 'directory',
            isSymbolicLink: () => entry.kind === 'link',
        };
    }
    directory('/project/validation');
    const fs = {
        async realpath(file: string) {
            const entry = records.get(file);
            if (!entry) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
            return entry.target ?? file;
        },
        async lstat(file: string) {
            return stat(records.get(file));
        },
        async mkdir(file: string) {
            events.push('mkdir:' + file);
            if (records.has(file)) throw Object.assign(Error('EEXIST'), { code: 'EEXIST' });
            assert.equal(records.get(path.posix.dirname(file))?.kind, 'directory');
            records.set(file, {
                kind: 'directory',
                ino: serial++,
                bytes: Buffer.alloc(0),
                time: clock++,
            });
        },
        async readdir(file: string) {
            assert.equal(records.get(file)?.kind, 'directory');
            return [...records]
                .filter(([name]) => path.posix.dirname(name) === file && name !== file)
                .map(([name, entry]) => ({
                    name: path.posix.basename(name),
                    isFile: () => entry.kind === 'file',
                    isDirectory: () => entry.kind === 'directory',
                    isSymbolicLink: () => entry.kind === 'link',
                }));
        },
        async open(file: string, flags: string) {
            events.push('open:' + flags + ':' + file);
            if (hooks.open) await hooks.open(file, flags);
            if (flags === 'wx') {
                if (records.has(file)) throw Object.assign(Error('EEXIST'), { code: 'EEXIST' });
                write(file, Buffer.alloc(0));
            } else assert.equal(flags, 'r');
            const entry = records.get(file);
            assert.equal(entry?.kind, 'file');
            let at = 0;
            const handle = {
                file,
                closed: false,
                async stat() {
                    return stat(entry);
                },
                async writeFile(bytes: Buffer) {
                    events.push('write:' + file);
                    if (hooks.write) await hooks.write(file);
                    entry.bytes = Buffer.from(bytes);
                    entry.time = clock++;
                },
                async sync() {
                    events.push('sync:' + file);
                    if (hooks.sync) await hooks.sync(file);
                },
                async read(buffer: Buffer, offset: number, length: number) {
                    if (hooks.read) await hooks.read(file);
                    const n = Math.min(length, entry.bytes.length - at);
                    entry.bytes.copy(buffer, offset, at, at + n);
                    at += n;
                    return { bytesRead: n };
                },
                async close() {
                    events.push('close:' + file);
                    if (hooks.close) await hooks.close(file);
                    handle.closed = true;
                    handles.delete(handle);
                },
            };
            handles.add(handle);
            return handle;
        },
    };
    return {
        fs,
        records,
        handles,
        events,
        hooks,
        directory,
        write,
        bytes: (file: string) => Buffer.from(records.get(file).bytes),
    };
}
export async function observedLifecycle(mode = 'normal') {
    const child = new EventEmitter() as any;
    child.pid = 123;
    child.kill = () => {
        throw Error('No forced cleanup admitted.');
    };
    const timers = new Map<number, { fn(): void; at: number }>();
    let next = 1,
        now = 0;
    const clock = {
        now: () => now,
        set(fn: () => void, delay: number) {
            const id = next++;
            timers.set(id, { fn, at: now + delay });
            return id;
        },
        clear(id: number) {
            timers.delete(id);
        },
    };
    const observer = observeOwnedChild(child, {
        totalMs: 100,
        reserveMs: 10,
        clock,
        requestStop() {},
    });
    child.emit('spawn');
    const code = mode === 'nonzero' ? 1 : 0;
    if (mode !== 'pending') child.emit('exit', code, null);
    if (!['pending', 'no-close'].includes(mode)) child.emit('close', code, null);
    if (['pending', 'no-close'].includes(mode)) {
        now = 100;
        for (const [id, timer] of [...timers])
            if (timer.at <= now) {
                timers.delete(id);
                timer.fn();
            }
    }
    return observer.outcome;
}
export function sourceFixture() {
    const sri = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
    const dep = (name: string, version = '1.0.0', extra = {}) => ({
        version,
        resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        integrity: sri,
        license: 'MIT',
        ...extra,
    });
    const source = {
        name: 'embedded-linux-diagnostic-hub',
        version: '0.6.0',
        license: 'MIT',
        dependencies: { ssh2: '^1.17.0', unused: '^1.0.0' },
    };
    const lock = {
        name: source.name,
        version: source.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
            '': {
                name: source.name,
                version: source.version,
                dependencies: source.dependencies,
                license: 'MIT',
            },
            'node_modules/ssh2': dep('ssh2', '1.17.0', {
                dependencies: { dep: '^1.0.0' },
                optionalDependencies: { opt: '^1.0.0' },
                hasInstallScript: true,
            }),
            'node_modules/dep': dep('dep'),
            'node_modules/opt': dep('opt', '1.0.0', { optional: true }),
            'node_modules/unused': dep('unused'),
        },
    };
    const files = new Map<string, Buffer>([
        ['package.json', Buffer.from(JSON.stringify(source))],
        ['package-lock.json', Buffer.from(JSON.stringify(lock))],
        ['.env.gateway.example', Buffer.from('SYNTHETIC_EXAMPLE_ONLY=1\n')],
        ['LICENSE', Buffer.from('MIT synthetic source')],
        ['gateway/Caddyfile.example', Buffer.from('synthetic proxy configuration')],
        ['docs/gateway.md', Buffer.from('synthetic Gateway instructions')],
        ['gateway/main.ts', Buffer.from('synthetic source entry, never executed')],
    ]);
    const objects = new Map<string, any>(),
        index: any[] = [];
    const object = (type: string, bytes: Buffer) => {
        const oid = gitObjectID(type, bytes);
        objects.set(oid, { oid, type, bytes: Buffer.from(bytes) });
        return oid;
    };
    function tree(prefix: string): string {
        const entries = new Map<string, any>();
        for (const [full, bytes] of files) {
            if (!full.startsWith(prefix)) continue;
            const rest = full.slice(prefix.length),
                slash = rest.indexOf('/');
            if (slash >= 0) entries.set(rest.slice(0, slash), { mode: '40000' });
            else {
                const oid = object('blob', bytes);
                entries.set(rest, { mode: '100644', oid });
                index.push({ path: full, mode: '100644', oid, stage: 0 });
            }
        }
        const values = [...entries].map(([name, entry]) => ({
            name,
            mode: entry.mode,
            oid: entry.oid ?? tree(prefix + name + '/'),
        }));
        values.sort((a, b) =>
            Buffer.compare(
                Buffer.from(a.name + (a.mode === '40000' ? '/' : '\0')),
                Buffer.from(b.name + (b.mode === '40000' ? '/' : '\0')),
            ),
        );
        return object(
            'tree',
            Buffer.concat(
                values.map((entry) =>
                    Buffer.concat([
                        Buffer.from(entry.mode + ' ' + entry.name + '\0'),
                        Buffer.from(entry.oid, 'hex'),
                    ]),
                ),
            ),
        );
    }
    const sourceTree = tree(''),
        sourceCommit = object(
            'commit',
            Buffer.from(
                `tree ${sourceTree}\nauthor Synthetic <test@example.invalid> 0 +0000\ncommitter Synthetic <test@example.invalid> 0 +0000\n\nSynthetic only.\n`,
            ),
        );
    index.sort((a, b) => (a.path < b.path ? -1 : 1));
    const provider = {
        async state() {
            return { sourceCommit, sourceTree, index: structuredClone(index) };
        },
        async objects(ids: string[]) {
            return ids.map((id) => ({
                ...objects.get(id),
                bytes: Buffer.from(objects.get(id).bytes),
            }));
        },
        async entries(relative: string) {
            const names = new Map<string, string>(),
                prefix = relative ? relative + '/' : '';
            for (const name of files.keys()) {
                if (!name.startsWith(prefix)) continue;
                const rest = name.slice(prefix.length),
                    at = rest.indexOf('/');
                names.set(at < 0 ? rest : rest.slice(0, at), at < 0 ? 'file' : 'directory');
            }
            return [...names].map(([name, kind]) => ({ name, kind }));
        },
        async file(name: string) {
            return { mode: '100644', bytes: Buffer.from(files.get(name)!) };
        },
    };
    const context = {
        scope: 'gateway',
        version: source.version,
        sourceCommit,
        sourceTree,
        runId: '123',
        runAttempt: '1',
        jobKey: 'gateway_archive',
    };
    return { source, lock, files, provider, context, dep };
}
export const syntheticTools = () => ({
    runtime: {
        executablePath: '/synthetic/node',
        executableSHA256: 'a'.repeat(64),
        node: 'v24.19.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24.19.0' },
        execArgv: [],
        nodeOptions: null,
    },
    esbuildEntryPath: '/synthetic/esbuild/bin/esbuild',
    esbuildEntrySHA256: sourceDigest(
        Buffer.from('#!/usr/bin/env node\n// synthetic esbuild entry, never executed\n'),
    ),
    esbuildEntryFormat: 'node-script',
    esbuildEntryBytes: Buffer.from(
        '#!/usr/bin/env node\n// synthetic esbuild entry, never executed\n',
    ),
    npmEntryPath: '/synthetic/npm/bin/npm-cli.js',
    npmEntrySHA256: 'c'.repeat(64),
    npmVersion: '11.0.0',
    npmPackageSHA256: 'd'.repeat(64),
});
export function pipelineFixture() {
    const source = sourceFixture(),
        filesystem = memoryFilesystem(),
        tools = syntheticTools(),
        plans: any[] = [];
    const options = { sourceRoot: '/project', leaf: 'gateway-test' };
    const controls: any = {};
    const io = {
        filesystem: filesystem.fs,
        async sourceFactory(root: string) {
            assert.equal(root, options.sourceRoot);
            return source.provider;
        },
        async observeToolchain() {
            return structuredClone(tools);
        },
        async execute(plan: any) {
            plans.push(plan);
            if (controls.throwRole === plan.role) throw controls.failure;
            if (plan.role === 'build') {
                const output = plan.command
                    .find((value: string) => value.startsWith('--outfile='))
                    .slice(10);
                filesystem.write(
                    output,
                    Buffer.from('module.exports = "synthetic compiled entry";\n'),
                );
                if (controls.afterBuild) controls.afterBuild();
            } else {
                assert.ok(
                    plan.command.includes('--offline') && plan.command.includes('--ignore-scripts'),
                );
                const file = path.join(plan.cwd, 'package-lock.json'),
                    value = JSON.parse(filesystem.bytes(file).toString());
                if (controls.lock) controls.lock(value, filesystem, plan);
                filesystem.write(file, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
            }
            if (controls.holdRole === plan.role)
                await new Promise<void>((resolve) => {
                    controls.release = resolve;
                });
            const lifecycle = await observedLifecycle(
                controls.modeRole === plan.role ? controls.mode : 'normal',
            );
            return {
                owner: controls.foreignOwner === plan.role ? 'f'.repeat(32) : plan.owner,
                id: plan.id,
                role: plan.role,
                cwd: plan.cwd,
                command: [...plan.command],
                lifecycle,
            };
        },
    };
    return { ...source, filesystem, tools, plans, options, io, controls };
}
