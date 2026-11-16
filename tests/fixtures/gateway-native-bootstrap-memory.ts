import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { pipelineFixture } from './gateway-producer-memory';
import { metadataFixture } from './github-service-metadata-memory';
import { gitObjectID } from '../../scripts/lib/committed-source-bridge.mjs';
import { createGatewayJobBootstrapModel } from '../../scripts/lib/gateway-job-bootstrap.mjs';

export async function nativeBootstrapFixture(kind = 'tag', layers = 1) {
    const p = pipelineFixture(),
        f = p.filesystem,
        root = '/project',
        node = '/tools/bin/node';
    f.records.delete('/project/validation'); // Only a memory directory, to model a genuinely fresh slot.
    for (const [name, bytes] of p.files) f.write(root + '/' + name, bytes);
    f.write(node, Buffer.from('Inert Node executable bytes.'));
    f.write('/usr/bin/git', Buffer.from('Inert Git executable bytes.'));
    f.write(root + '/node_modules/esbuild/bin/esbuild', p.tools.esbuildEntryBytes);
    f.write(
        '/tools/lib/node_modules/npm/bin/npm-cli.js',
        Buffer.from('Inert npm script, never executed.'),
    );
    f.write(
        '/tools/lib/node_modules/npm/package.json',
        Buffer.from(JSON.stringify({ version: '11.19.1' })),
    );
    const [commit] = await p.provider.objects([p.context.sourceCommit]);
    const tags: any[] = [];
    let target = commit;
    for (let n = 0; n < layers; n++) {
        const bytes = Buffer.from(
            `object ${target.oid}\ntype ${target.type}\ntag v0.6.0\n\nMemory annotated tag.\n`,
        );
        target = { oid: gitObjectID('tag', bytes), type: 'tag', bytes };
        tags.unshift(target);
    }
    const top = kind === 'tag' ? target : commit,
        ref = kind === 'tag' ? 'refs/tags/v0.6.0' : 'refs/heads/ci/gateway-bootstrap-fixture';
    const controls: any = {},
        events: string[] = [],
        children: any[] = [],
        timers = new Set<any>();
    const http = await metadataFixture({
        bodyFor(path) {
            const url = new URL('https://api.github.com' + path);
            if (url.pathname.includes('/git/ref/'))
                return {
                    ref,
                    object: { sha: top.oid, type: top.type, url: 'Ignored response URL.' },
                };
            if (url.pathname.includes('/git/tags/')) {
                const oid = url.pathname.split('/').at(-1)!;
                const at = tags.findIndex((t) => t.oid === oid);
                assert.ok(at >= 0);
                const next = tags[at + 1] ?? commit;
                return {
                    sha: oid,
                    object: { sha: next.oid, type: next.type, url: 'Ignored response URL.' },
                };
            }
            assert.ok(url.pathname.endsWith('/git/commits/' + commit.oid));
            return { sha: commit.oid, tree: { sha: p.context.sourceTree } };
        },
    });
    const stat = async (file: string) => {
        const value = await f.fs.lstat(file);
        const metadata = {
            ...value,
            uid: 1000,
            gid: 1000,
            mode: file === node || file === '/usr/bin/git' ? 0o100755 : value.mode,
        };
        return { ...metadata, ...controls.stat?.(file, metadata) };
    };
    const dirs = new Set<any>();
    const filesystem: any = {
        ...f.fs,
        lstat: stat,
        async open(file: string, flags: number) {
            assert.ok(flags & constants.O_NOFOLLOW);
            if (flags & constants.O_DIRECTORY) {
                const handle = {
                    stat: () => stat(file),
                    async sync() {},
                    async close() {
                        dirs.delete(handle);
                    },
                };
                dirs.add(handle);
                return handle;
            }
            const h = await f.fs.open(file, flags & constants.O_EXCL ? 'wx' : 'r');
            return {
                ...h,
                stat: () => stat(file),
                async write(buffer: Buffer, offset: number, length: number, position: number) {
                    const old = f.bytes(file),
                        next = Buffer.alloc(Math.max(old.length, position + length));
                    old.copy(next);
                    buffer.copy(next, position, offset, offset + length);
                    f.write(file, next);
                    return { bytesWritten: length };
                },
            };
        },
        async opendir(file: string) {
            const rows = await f.fs.readdir(file);
            let at = 0;
            const h = {
                async read() {
                    return rows[at++] ?? null;
                },
                async close() {
                    dirs.delete(h);
                },
            };
            dirs.add(h);
            return h;
        },
    };
    const rawObjects = async (ids: string[]) =>
        Promise.all(
            ids.map(
                async (oid) =>
                    tags.find((t) => t.oid === oid) ?? (await p.provider.objects([oid]))[0],
            ),
        );
    const ports: any = {
        filesystem,
        now: () => 0,
        setTimer(fn: Function) {
            timers.add(fn);
            return fn;
        },
        clearTimer(fn: Function) {
            timers.delete(fn);
        },
        launch(file: string, args: string[], options: any) {
            const child: any = new EventEmitter();
            child.pid = 1000 + children.length;
            child.exitCode = null;
            child.signalCode = null;
            child.spawnfile = file;
            child.spawnargs = [file, ...args];
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdin = options.stdio[0] === 'pipe' ? new EventEmitter() : null;
            const record: any = { file, args: [...args], input: undefined, closed: false };
            children.push(record);
            if (child.stdin)
                child.stdin.end = (bytes: Buffer, ack: Function) => {
                    record.input = bytes.toString();
                    child.stdin.emit('finish');
                    ack(null);
                    child.stdin.emit('close');
                    return child.stdin;
                };
            queueMicrotask(async () => {
                child.emit('spawn');
                let out = Buffer.alloc(0),
                    code = 0;
                try {
                    if (file === '/usr/bin/git') {
                        const tail = args.slice(6);
                        events.push('git:' + tail[0]);
                        if (tail[0] === 'rev-parse')
                            out = Buffer.from(
                                (tail[1] === '--show-toplevel'
                                    ? root
                                    : tail[1] === '--show-object-format'
                                      ? 'sha1'
                                      : tail[1] === '--show-prefix'
                                        ? ''
                                        : tail[2] === 'HEAD'
                                          ? commit.oid
                                          : p.context.sourceTree) + '\n',
                            );
                        else if (tail[0] === 'config') code = 1;
                        else if (tail[0] === 'show-ref') out = Buffer.from(top.oid + '\n');
                        else if (tail[0] === 'ls-files') {
                            const state = await p.provider.state();
                            out = Buffer.from(
                                state.index
                                    .map((r: any) => `${r.mode} ${r.oid} ${r.stage}\t${r.path}\0`)
                                    .join(''),
                            );
                        } else {
                            assert.equal(tail[0], 'cat-file');
                            const objects = await rawObjects(record.input.trim().split('\n'));
                            out = Buffer.concat(
                                objects.map((o: any) => {
                                    const header = Buffer.from(
                                        `${o.oid} ${o.type} ${o.bytes.length}\n`,
                                    );
                                    return tail[1] === '--batch-check'
                                        ? header
                                        : Buffer.concat([header, o.bytes, Buffer.from('\n')]);
                                }),
                            );
                        }
                    } else {
                        assert.equal(file, node);
                        assert.equal(options.shell, false);
                        if (args[0].endsWith('/esbuild/bin/esbuild')) {
                            events.push('build');
                            const outfile = args.find((a) => a.startsWith('--outfile='));
                            assert.ok(typeof outfile === 'string');
                            f.write(
                                outfile.slice(10),
                                Buffer.from('module.exports = "inert compiled entry";\n'),
                            );
                        } else {
                            events.push('lock');
                            assert.ok(
                                args.includes('--offline') && args.includes('--ignore-scripts'),
                            );
                            const name = options.cwd + '/package-lock.json';
                            f.write(
                                name,
                                Buffer.from(
                                    JSON.stringify(JSON.parse(f.bytes(name).toString()), null, 2) +
                                        '\n',
                                ),
                            );
                        }
                    }
                    controls.output?.(record);
                    if (controls.holdClose) {
                        controls.releaseClose = () => finish();
                        return;
                    }
                    finish();
                } catch (error) {
                    child.emit('error', error);
                    finish(1);
                }
                function finish(status = code) {
                    if (out.length) child.stdout.emit('data', out);
                    child.stdout.emit('close');
                    child.stderr.emit('close');
                    child.emit('exit', status, null);
                    record.closed = true;
                    child.emit('close', status, null);
                }
            });
            return child;
        },
    };
    const environment: any = {
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: root,
        GITHUB_EVENT_PATH: '/events/push.json',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: ref,
        GITHUB_SHA: commit.oid,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: kind === 'tag' ? 'build' : 'gateway_build',
        GITHUB_WORKFLOW_REF: `brucerry/embedded-linux-diagnostic-hub/.github/workflows/${kind === 'tag' ? 'release.yml' : 'bootstrap-buildonly.yml'}@${ref}`,
        GITHUB_WORKFLOW_SHA: commit.oid,
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
    };
    const event = {
        repository: { full_name: environment.GITHUB_REPOSITORY, private: false },
        ref,
        after: top.oid,
        deleted: false,
    };
    f.write(environment.GITHUB_EVENT_PATH, Buffer.from(JSON.stringify(event)));
    const entryFile = root + '/scripts/build-gateway-tag-archive.mjs';
    const runtime = {
        environment,
        entryFile,
        argv: [node, entryFile, ...(kind === 'tag' ? [] : ['--qualify-branch'])],
        execArgv: [],
        execPath: node,
        version: 'v24.22.0',
        versions: { node: '24.22.0' },
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
    };
    return {
        p,
        f,
        http,
        ports,
        runtime,
        event,
        top,
        tags,
        controls,
        events,
        children,
        timers,
        dirs,
        make: () => createGatewayJobBootstrapModel(runtime, ports, http.host, http.clock),
    };
}
