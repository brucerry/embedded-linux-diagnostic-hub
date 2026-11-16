// Source/memory integration only. Generated package members are never evaluated as code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import { runSameJobGatewayHealthSmoke } from '../scripts/lib/gateway-same-job-health-smoke.mjs';
import { pipelineFixture } from './fixtures/gateway-producer-memory';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sri = (bytes: Buffer) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const pulse = async () => {
    for (let i = 0; i < 2000; i++) await Promise.resolve();
};
const names = ['asn1', 'bcrypt-pbkdf', 'safer-buffer', 'ssh2', 'tweetnacl'];
const versions: Record<string, string> = {
    asn1: '0.2.6',
    'bcrypt-pbkdf': '1.0.2',
    'safer-buffer': '2.1.2',
    ssh2: '1.17.0',
    tweetnacl: '0.14.5',
};
function archive(files: Map<string, Buffer>) {
    const chunks: Buffer[] = [];
    for (const [name, bytes] of files) {
        const head = Buffer.alloc(512);
        head.write('package/' + name, 0, 100, 'utf8');
        const octal = (at: number, value: number, width: number) =>
            head.write(value.toString(8).padStart(width - 1, '0') + '\0', at, width, 'ascii');
        octal(100, 0o644, 8);
        octal(108, 1000, 8);
        octal(116, 1000, 8);
        octal(124, bytes.length, 12);
        octal(136, 0, 12);
        head[156] = 48;
        head.write('ustar\0' + '00', 257, 8, 'ascii');
        head.fill(32, 148, 156);
        head.write(
            head
                .reduce((a, b) => a + b, 0)
                .toString(8)
                .padStart(6, '0') + '\0 ',
            148,
            8,
            'ascii',
        );
        chunks.push(head, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
    return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function fixture() {
    const manifest = {
        name: 'embedded-linux-diagnostic-hub',
        version: '0.6.0',
        license: 'MIT',
        dependencies: { ssh2: '^1.17.0' },
    };
    const lock: any = {
        name: manifest.name,
        version: manifest.version,
        requires: true,
        lockfileVersion: 3,
        packages: {
            '': { ...manifest },
        },
    };
    const memberFiles = new Map<string, Map<string, Buffer>>(),
        originals: any[] = [];
    for (const name of names) {
        const files = new Map([
            [
                'package.json',
                Buffer.from(
                    JSON.stringify({ name, version: versions[name], main: 'lib/index.js' }),
                ),
            ],
            ['lib/index.js', Buffer.from('// memory-only ' + name + '; never loaded')],
        ]);
        memberFiles.set(name, files);
        const bytes = archive(files);
        originals.push({ path: 'node_modules/' + name, bytes });
        lock.packages['node_modules/' + name] = {
            version: versions[name],
            resolved: `https://registry.npmjs.org/${name}/-/${name}-${versions[name]}.tgz`,
            integrity: sri(bytes),
            ...(name === 'ssh2'
                ? {
                      dependencies: { asn1: '^0.2.6', 'bcrypt-pbkdf': '^1.0.2' },
                      hasInstallScript: true,
                  }
                : {}),
            ...(name === 'asn1' ? { dependencies: { 'safer-buffer': '~2.1.0' } } : {}),
            ...(name === 'bcrypt-pbkdf' ? { dependencies: { tweetnacl: '^0.14.3' } } : {}),
        };
    }
    const sourcePackageBytes = Buffer.from(JSON.stringify(manifest)),
        sourceLockBytes = Buffer.from(JSON.stringify(lock));
    const f = pipelineFixture(
        new Map([
            ['package.json', sourcePackageBytes],
            ['package-lock.json', sourceLockBytes],
        ]),
    );
    const nodeBytes = Buffer.from('memory Node bytes; never executable');
    Object.assign(f.tools.runtime, {
        node: 'v24.22.2',
        versions: { node: '24.22.2' },
        executableSHA256: hash(nodeBytes),
    });
    const { record } = await produceGatewayArchive(f.context, f.options, f.io);
    const artifactRoot = '/project/validation/gateway-test/artifacts/';
    const readback = {
        archiveBytes: f.filesystem.bytes(artifactRoot + record.archive.name),
        checksumBytes: f.filesystem.bytes(artifactRoot + record.checksum.name),
        recordBytes: f.filesystem.bytes(artifactRoot + 'gateway-build.json'),
        sourcePackageBytes,
        sourceLockBytes,
        compiledBytes: f.filesystem.bytes('/project/validation/gateway-test/build/main.cjs'),
    };
    const input: any = {
        readback,
        expected: {
            context: f.context,
            buildRecord: {
                name: 'gateway-build.json',
                bytes: readback.recordBytes.length,
                sha256: hash(readback.recordBytes),
            },
            artifacts: [record.archive, record.checksum],
        },
        builder: record.builder,
        sourceRoot: '/project',
        temporaryRoot: '/job-temp',
        uid: 1000,
    };
    f.filesystem.directory('/job-temp');
    f.filesystem.write(f.tools.runtime.executablePath, nodeBytes);
    const controls: any = {},
        calls: string[] = [],
        timers: any[] = [],
        children: any[] = [],
        requests: any[] = [];
    const metadata = (stat: any, file: string) => ({
        ...stat,
        uid: controls.unsafeTemp && file === '/job-temp' ? 0 : 1000,
        gid: 1000,
        mode: file === f.tools.runtime.executablePath ? 0o100755 : stat.mode,
    });
    const filesystem = {
        ...f.filesystem.fs,
        async lstat(file: string) {
            return metadata(await f.filesystem.fs.lstat(file), file);
        },
        async open(file: string, flags: number) {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const handle = await f.filesystem.fs.open(file, 'r');
            return { ...handle, stat: async () => metadata(await handle.stat(), file) };
        },
    };
    const ports: any = {
        filesystem,
        custody: { snapshot: () => ({ descriptors: f.filesystem.handles.size, memoryOnly: true }) },
        async writeExclusive(file: string, bytes: Buffer) {
            calls.push('write');
            assert.equal(f.filesystem.records.has(file), false);
            if (controls.writeFailure) throw undefined;
            f.filesystem.write(file, bytes);
        },
        async installRuntimeInputs(value: any) {
            calls.push('prepare-runtime');
            assert.ok(value.sourceLockBytes.equals(sourceLockBytes));
            assert.ok(value.installRoot.startsWith('/job-temp/'));
            assert.ok(!value.installRoot.startsWith('/project/'));
            if (!controls.noInstallation)
                for (const [name, files] of memberFiles)
                    for (const [leaf, bytes] of files)
                        f.filesystem.write(
                            value.installRoot + '/node_modules/' + name + '/' + leaf,
                            bytes,
                        );
            if (controls.installedTamper)
                f.filesystem.write(
                    value.installRoot + '/node_modules/ssh2/lib/index.js',
                    Buffer.from('tampered'),
                );
            if (controls.optional)
                f.filesystem.write(
                    value.installRoot + '/node_modules/cpu-features/package.json',
                    Buffer.from('{}'),
                );
            if (controls.nodeTamper)
                f.filesystem.write(f.tools.runtime.executablePath, Buffer.from('different Node'));
            if (controls.missingArchive) return originals.slice(1);
            if (controls.extraArchive) return [...originals, originals[0]];
            return originals.map((row) => ({
                ...row,
                bytes:
                    controls.archiveTamper && row.path.endsWith('/ssh2')
                        ? Buffer.from('bad archive')
                        : Buffer.from(row.bytes),
            }));
        },
        async resolveModule(parent: string, specifier: string) {
            calls.push('resolve:' + specifier);
            if (specifier === 'ssh2')
                return controls.parentResolution
                    ? '/project/node_modules/ssh2/lib/index.js'
                    : parent.replace(/\/package\.json$/, '/node_modules/ssh2/lib/index.js');
            if (controls.nativeResolution) return '/memory/native.node';
            throw Object.assign(Error('authored absent'), { code: 'MODULE_NOT_FOUND' });
        },
        randomBytes(n: number) {
            assert.equal(n, 32);
            return Buffer.alloc(n, 0xab);
        },
        setTimer(callback: Function, ms: number) {
            const timer = { callback, ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer: any) {
            timer.cleared = true;
        },
        now: () => 0,
        assertSettled() {
            if (controls.asyncSettlement) return Promise.reject(undefined);
            assert.equal(f.filesystem.handles.size, 0);
        },
        launch(file: string, args: string[], options: any) {
            calls.push('launch');
            assert.equal(file, f.tools.runtime.executablePath);
            assert.equal(options.shell, false);
            assert.equal(options.env.HUB_GATEWAY_HOST, '127.0.0.1');
            assert.equal(options.env.SSH_AUTH_SOCK, undefined);
            assert.equal(options.env.NODE_PATH, undefined);
            assert.equal(options.env.HOME, undefined);
            const child: any = new EventEmitter();
            Object.assign(child, {
                pid: 777,
                stdin: null,
                exitCode: null,
                signalCode: null,
                spawnfile: file,
                spawnargs: [file, ...args],
                stdout: new EventEmitter(),
                stderr: new EventEmitter(),
                signals: 0,
            });
            child.kill = (signal: string) => {
                assert.equal(signal, 'SIGTERM');
                child.signals++;
                queueMicrotask(() => {
                    child.stdout.emit('close');
                    child.stderr.emit('close');
                    child.emit('exit', 0, null);
                    child.emit('close', 0, null);
                });
                return true;
            };
            children.push(child);
            queueMicrotask(() => {
                child.emit('spawn');
                child.stdout.emit(
                    'data',
                    Buffer.from(
                        'Diagnostic Hub gateway listening on 127.0.0.1:58731. Place behind HTTPS for website use.\n',
                    ),
                );
            });
            return child;
        },
        request(options: any, callback: Function) {
            assert.equal(options.hostname, '127.0.0.1');
            assert.equal(options.path, '/api/health');
            assert.equal(options.method, 'GET');
            assert.equal(options.agent, false);
            const role = requests.length,
                request: any = new EventEmitter(),
                response: any = new EventEmitter(),
                socket: any = new EventEmitter();
            requests.push(options);
            Object.assign(socket, {
                connecting: true,
                remoteAddress: '127.0.0.1',
                localAddress: '127.0.0.1',
                remotePort: 58731,
            });
            Object.assign(response, {
                statusCode: [200, 401, 403][role],
                complete: true,
                headers: {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                    ...(role === 2 ? {} : { 'access-control-allow-origin': 'http://127.0.0.1' }),
                },
            });
            request.end = () => {
                queueMicrotask(() => {
                    request.emit('socket', socket);
                    socket.emit('connect');
                    request.emit('finish');
                    callback(response);
                    response.emit(
                        'data',
                        Buffer.from(
                            role === 0
                                ? JSON.stringify({
                                      version: '0.6.0',
                                      activeSessions: 0,
                                      connectionCancellation: true,
                                  })
                                : '{}',
                        ),
                    );
                    response.emit('end');
                    response.emit('close');
                    request.emit('close');
                    socket.emit('close');
                });
                return request;
            };
            return request;
        },
    };
    return { ...f, input, ports, controls, calls, timers, children, requests };
}

test('same-job memory composition derives real byte observations before its fake child is launched', async () => {
    const f = await fixture(),
        result = await runSameJobGatewayHealthSmoke(f.input, f.ports);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].signals, 1);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(
        result.dependencyOrigin.packages.map((row: any) => row.path).sort(),
        names.map((name) => 'node_modules/' + name),
    );
    assert.equal(result.configuredTargetAuthenticated, false);
    assert.equal(result.jobAuthentication, null);
    assert.equal(result.uploadAttribution, null);
    assert.equal(result.releaseAcceptance, false);
    assert.equal(f.filesystem.handles.size, 0);
    assert.ok(f.timers.every((timer) => timer.cleared));
    assert.ok(!JSON.stringify(result).includes('ab'.repeat(32)));
});

for (const which of ['archive', 'checksum', 'source', 'run', 'job', 'builder', 'node-version'])
    test('rejects ' + which + ' mismatch before any installation or child', async () => {
        const f = await fixture();
        if (which === 'archive') f.input.readback.archiveBytes[0] ^= 1;
        if (which === 'checksum') f.input.readback.checksumBytes[0] ^= 1;
        if (which === 'source')
            f.input.expected.context = {
                ...f.input.expected.context,
                sourceCommit: 'f'.repeat(40),
            };
        if (which === 'run')
            f.input.expected.context = { ...f.input.expected.context, runId: '999' };
        if (which === 'job')
            f.input.expected.context = { ...f.input.expected.context, jobKey: 'foreign_job' };
        if (which === 'builder') f.input.builder = { ...f.input.builder, npmVersion: '0.0.1' };
        if (which === 'node-version')
            f.input.builder = {
                ...f.input.builder,
                runtime: { ...f.input.builder.runtime, node: 'v24.22.0' },
            };
        await assert.rejects(runSameJobGatewayHealthSmoke(f.input, f.ports));
        assert.deepEqual(f.calls, []);
        assert.equal(f.children.length, 0);
    });

for (const which of [
    'missingArchive',
    'extraArchive',
    'archiveTamper',
    'noInstallation',
    'installedTamper',
    'optional',
    'nodeTamper',
    'parentResolution',
    'nativeResolution',
])
    test(
        'rejects ' + which + ' rather than trusting installer labels or parent packages',
        async () => {
            const f = await fixture();
            f.controls[which] = true;
            await assert.rejects(runSameJobGatewayHealthSmoke(f.input, f.ports));
            assert.equal(f.children.length, 0);
            assert.equal(f.requests.length, 0);
            assert.equal(f.calls.filter((call) => call === 'prepare-runtime').length, 1);
        },
    );

test('unsafe temporary ownership refuses the fixture without creating or adopting a namespace', async () => {
    const f = await fixture();
    f.controls.unsafeTemp = true;
    await assert.rejects(runSameJobGatewayHealthSmoke(f.input, f.ports));
    assert.equal(f.filesystem.records.has('/job-temp/diagnostic-hub-gateway-123-attempt-1'), false);
    assert.deepEqual(f.calls, []);
});
test('an existing namespace is refused intact rather than cleaned or reused', async () => {
    const f = await fixture(),
        existing = '/job-temp/diagnostic-hub-gateway-123-attempt-1';
    f.filesystem.directory(existing);
    f.filesystem.write(existing + '/held.txt', Buffer.from('preserved'));
    await assert.rejects(runSameJobGatewayHealthSmoke(f.input, f.ports));
    assert.equal(f.filesystem.bytes(existing + '/held.txt').toString(), 'preserved');
    assert.equal(f.children.length, 0);
});
test('payload write failure preserves raw undefined and custody without cleanup or child', async () => {
    const f = await fixture();
    f.controls.writeFailure = true;
    const error: any = await runSameJobGatewayHealthSmoke(f.input, f.ports).catch(
        (value: unknown) => value,
    );
    assert.equal(error.cause, undefined);
    assert.equal(error.owner.snapshot().failed, true);
    assert.equal(error.owner.custody, f.ports.custody);
    assert.equal(f.children.length, 0);
    assert.ok(f.filesystem.records.has('/job-temp/diagnostic-hub-gateway-123-attempt-1'));
    assert.equal(error.owner.snapshot().operations.at(-1).state, 'rejected-effects-not-inferred');
});
test('unsupported async settlement acknowledgement cannot label even a closed memory child successful', async () => {
    const f = await fixture();
    f.controls.asyncSettlement = true;
    const error: any = await runSameJobGatewayHealthSmoke(f.input, f.ports).catch(
        (value: unknown) => value,
    );
    await pulse();
    assert.equal(error.owner.snapshot().failed, true);
    assert.equal(error.owner.snapshot().retired, false);
    assert.equal(error.owner.snapshot().unknownReturns, 1);
    assert.equal(f.children[0].signals, 1);
});

test('unsupported random acquisition retains its operation and rejected return without a child', async () => {
    const f = await fixture();
    f.ports.randomBytes = () => Promise.reject(undefined);
    const error: any = await runSameJobGatewayHealthSmoke(f.input, f.ports).catch(
        (value: unknown) => value,
    );
    await pulse();
    const snapshot = error.owner.snapshot();
    assert.equal(snapshot.failed, true);
    assert.equal(snapshot.unknownReturns, 1);
    assert.equal(snapshot.operations.at(-1).phase, 'random-token');
    assert.equal(snapshot.operations.at(-1).state, 'unsupported-return');
    assert.equal(f.children.length, 0);
});

test('asynchronous custody snapshot fails closed before namespace creation and keeps the owner', async () => {
    const f = await fixture();
    let unsupported: Promise<unknown> | undefined;
    f.ports.custody.snapshot = () => (unsupported ??= Promise.reject(undefined));
    const error: any = await runSameJobGatewayHealthSmoke(f.input, f.ports).catch(
        (value: unknown) => value,
    );
    await pulse();
    const snapshot = error.owner.snapshot();
    assert.equal(snapshot.failed, true);
    assert.equal(snapshot.suppliedCustody.status, 'unknown');
    assert.equal(snapshot.unknownReturns, 1);
    assert.equal(error.owner.custody, f.ports.custody);
    assert.equal(f.filesystem.records.has('/job-temp/diagnostic-hub-gateway-123-attempt-1'), false);
    assert.equal(f.children.length, 0);
});
