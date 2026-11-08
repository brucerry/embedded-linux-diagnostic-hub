import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { pipelineFixture, sourceFixture } from './gateway-producer-memory.ts';
import { fixture as httpMemory } from './final-gateway-session-memory.ts';
import { shippingSshMemory } from './shipping-gateway-ssh-memory.ts';
import { NetworkCollector } from '../../backend/ssh/network.ts';
import { probes } from '../../shared/diagnostics/probes.ts';
import { produceGatewayArchive } from '../../scripts/lib/gateway-archive-producer.mjs';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Member = {
    name: string;
    bytes?: Buffer;
    type?: number;
    mode?: number;
    prefix?: string;
    mutate?: (h: Buffer) => void;
};
// Independent authored USTAR fixture. No tar process, npm package or payload code is executed.
function tar(members: Member[], tail: Buffer = Buffer.alloc(1024)) {
    const chunks: Buffer[] = [];
    for (const m of members) {
        const head = Buffer.alloc(512),
            bytes = m.bytes ?? Buffer.alloc(0);
        head.write(m.name, 0, 100, 'utf8');
        const octal = (at: number, n: number, width: number) =>
            head.write(n.toString(8).padStart(width - 1, '0') + '\0', at, width, 'ascii');
        octal(100, m.mode ?? 0o644, 8);
        octal(108, 1000, 8);
        octal(116, 1000, 8);
        octal(124, bytes.length, 12);
        octal(136, 123456, 12);
        head[156] = m.type ?? 48;
        head.write('ustar\0' + '00', 257, 8, 'ascii');
        if (m.prefix) head.write(m.prefix, 345, 155, 'utf8');
        m.mutate?.(head);
        head.fill(32, 148, 156);
        const sum = head.reduce((a, b) => a + b, 0);
        head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        chunks.push(head, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
    return gzipSync(Buffer.concat([...chunks, tail]));
}
const members = (name = 'ssh2', version = '1.17.0'): Member[] => [
    {
        name: 'package/package.json',
        bytes: Buffer.from(JSON.stringify({ name, version, main: 'lib/index.js' })),
    },
    {
        name: 'package/lib/index.js',
        bytes: Buffer.from('// authored synthetic bytes, never loaded\nπ\n'),
    },
    { name: 'package/LICENSE', bytes: Buffer.from('synthetic license') },
];

/** Complete in-memory composition. Dependency/payload/Node bytes are authored inert data;
 * none is imported, compiled or executed. HTTP responses are event doubles, not a Gateway. */
export async function shippingExecutorMemory() {
    const bundles = ['ssh2', 'dep'].map((name) => ({
        path: 'node_modules/' + name,
        list: members(name, name === 'ssh2' ? '1.17.0' : '1.0.0'),
    }));
    const archives = bundles.map((b) => ({ path: b.path, bytes: tar(b.list) }));
    const lock: any = structuredClone(sourceFixture().lock);
    for (const row of archives)
        lock.packages[row.path].integrity =
            'sha512-' + createHash('sha512').update(row.bytes).digest('base64');
    const f = pipelineFixture(new Map([['package-lock.json', Buffer.from(JSON.stringify(lock))]])),
        ssh = shippingSshMemory(),
        http = httpMemory(),
        calls: string[] = [],
        controls: any = {};
    const nodeBytes = Buffer.from('synthetic exact Node file bytes; never executed');
    f.tools.runtime.executableSHA256 = hash(nodeBytes);
    const { record } = await produceGatewayArchive(f.context, f.options, f.io);
    const root = '/installed/gateway',
        nodePath = '/runtime/node';
    for (const row of record.payload)
        f.filesystem.write(
            root + '/' + row.path,
            f.filesystem.bytes(record.lockPreparation.cwd + '/' + row.path),
        );
    for (const b of bundles)
        for (const m of b.list)
            f.filesystem.write(
                root + '/' + b.path + '/' + m.name.slice('package/'.length),
                m.bytes!,
            );
    f.filesystem.write(nodePath, nodeBytes);
    const adjust = (stat: any, file: string) => ({
        ...stat,
        uid: 1000,
        mode: file === nodePath ? 0o100755 : stat.mode,
    });
    const filesystem = {
        ...f.filesystem.fs,
        lstat: async (file: string) => adjust(await f.filesystem.fs.lstat(file), file),
        open: async (file: string, flags: number) => {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const handle = await f.filesystem.fs.open(file, 'r');
            return { ...handle, stat: async () => adjust(await handle.stat(), file) };
        },
    };
    const input = {
        archive: f.filesystem.bytes(
            record.lockPreparation.cwd.replace(/\/stage$/, '') +
                '/artifacts/' +
                record.archive.name,
        ),
        recordBytes: Buffer.from(JSON.stringify(record) + '\n'),
        context: f.context,
        sourceLockBytes: f.files.get('package-lock.json')!,
        selection: { root, uid: 1000, node: { path: nodePath, sha256: hash(nodeBytes) } },
        dependencyArchives: archives,
        token: 'a'.repeat(64),
        attemptId: 'b'.repeat(32),
    };
    const child: any = new EventEmitter();
    Object.assign(child, {
        pid: 99,
        spawnfile: nodePath,
        spawnargs: [nodePath, root + '/dist-gateway/main.cjs'],
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        signalCode: null,
    });
    let client: any,
        results: any[] = [];
    let acknowledgeStop!: () => void, acknowledgeFixtureClose!: () => void;
    const normalCloseRequested = new Promise<void>((resolve) => {
            acknowledgeStop = resolve;
        }),
        fixtureCloseRequested = new Promise<void>((resolve) => {
            acknowledgeFixtureClose = resolve;
        });
    const tcpClose = ssh.tcp.close.bind(ssh.tcp);
    ssh.tcp.close = (callback: any) => {
        acknowledgeFixtureClose();
        return tcpClose(callback);
    };
    http.controls.mutate = (role: string, value: any) => {
        if (role === 'snapshot') {
            value.results = results;
            if (controls.badSnapshot) value.results = results.slice(1);
        }
        if (role === 'disconnect' || role === 'cancel') client?.end();
    };
    function closeChild() {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        if (!controls.holdPipes) {
            child.stdout.emit('close');
            child.stderr.emit('close');
        }
    }
    child.kill = (signal: string) => {
        calls.push('SIGTERM');
        acknowledgeStop();
        assert.equal(signal, 'SIGTERM');
        if (!controls.holdChild) queueMicrotask(closeChild);
        return true;
    };
    const ports = {
        filesystem,
        createFixture() {
            calls.push('fixture-factory');
            if (controls.throwFactory) throw Error('inert unknown acquisition');
            if (controls.throwUndefinedFactory) throw undefined;
            if (controls.throwFalseFactory) throw false;
            return controls.foreignFixture
                ? {}
                : controls.asyncFixture
                  ? Promise.resolve(ssh.fixture)
                  : ssh.fixture;
        },
        runtime: {
            ...http.ports,
            launch(file: string, args: string[], options: any) {
                calls.push('launch');
                assert.equal(file, nodePath);
                assert.deepEqual(args, [root + '/dist-gateway/main.cjs']);
                assert.equal(options.shell, false);
                queueMicrotask(() => {
                    void (async () => {
                        child.emit('spawn');
                        ssh.discover();
                        await ssh.pulse();
                        client = ssh.authenticate();
                        const collector = new NetworkCollector();
                        const collect = (probe: any) =>
                            collector.collect(probe, async (id: string, command: string) => {
                                const channel = ssh.exec(
                                    client,
                                    'export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; ' +
                                        command,
                                );
                                await ssh.pulse();
                                assert.equal(channel.closed, true);
                                return {
                                    id,
                                    command,
                                    stdout: Buffer.concat(channel.out).toString(),
                                    stderr: Buffer.concat(channel.err).toString(),
                                    exitCode: channel.code,
                                    status: channel.code === 0 ? 'collected' : 'unavailable',
                                    durationMs: 0,
                                    collectedAt: '2026-11-07T00:00:00.000Z',
                                    truncated: false,
                                } as any;
                            });
                        for (let i = 0; i < probes.length; i += 3)
                            results.push(
                                ...(await Promise.all(probes.slice(i, i + 3).map(collect))),
                            );
                        child.stdout.emit(
                            'data',
                            Buffer.from(
                                'Diagnostic Hub gateway listening on 127.0.0.1:58731. Place behind HTTPS for website use.\n',
                            ),
                        );
                    })().catch((error) => child.emit('error', error));
                });
                return child;
            },
        },
    };
    return {
        input,
        ports,
        ssh,
        http,
        child,
        calls,
        controls,
        closeChild,
        normalCloseRequested,
        fixtureCloseRequested,
        filesystem: f.filesystem,
        record,
        nodeBytes,
        root,
        nodePath,
        pulse: async () => {
            for (let i = 0; i < 1200; i++) await Promise.resolve();
        },
    };
}
