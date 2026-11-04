import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { produceWebArchive } from '../../scripts/lib/web-archive-producer.mjs';
import { produceGatewayArchive } from '../../scripts/lib/gateway-archive-producer.mjs';
import { sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';
import { pipelineFixture, sourceFixture, syntheticTools } from './gateway-producer-memory';

export function carrier(files: Map<string, Buffer>, deflate = false, descriptors = false): Buffer {
    const local: Buffer[] = [],
        directory: Buffer[] = [];
    let offset = 0;
    for (const [name, bytes] of files) {
        const encoded = zipSync({ [name]: bytes }, { level: 0 }),
            crc = Buffer.from(encoded).readUInt32LE(14),
            filename = Buffer.from(name);
        const blocks: Buffer[] = [];
        for (let at = 0; at < bytes.length || (!bytes.length && !blocks.length); at += 65535) {
            const data = bytes.subarray(at, at + 65535),
                head = Buffer.alloc(5);
            head[0] = at + 65535 >= bytes.length ? 1 : 0;
            head.writeUInt16LE(data.length, 1);
            head.writeUInt16LE(data.length ^ 0xffff, 3);
            blocks.push(head, data);
        }
        const data = deflate ? Buffer.concat(blocks) : bytes,
            flags = 0x800 | (descriptors ? 8 : 0),
            header = Buffer.alloc(30),
            central = Buffer.alloc(46);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(deflate ? 8 : 0, 8);
        header.writeUInt16LE(filename.length, 26);
        if (!descriptors) {
            header.writeUInt32LE(crc, 14);
            header.writeUInt32LE(data.length, 18);
            header.writeUInt32LE(bytes.length, 22);
        }
        central.writeUInt32LE(0x02014b50);
        central.writeUInt16LE(3 * 256 + 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(bytes.length, 24);
        central.writeUInt16LE(filename.length, 28);
        central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        const descriptor = Buffer.alloc(descriptors ? 16 : 0);
        if (descriptors) {
            descriptor.writeUInt32LE(0x08074b50);
            descriptor.writeUInt32LE(crc, 4);
            descriptor.writeUInt32LE(data.length, 8);
            descriptor.writeUInt32LE(bytes.length, 12);
        }
        local.push(header, filename, data, descriptor);
        directory.push(central, filename);
        offset += header.length + filename.length + data.length + descriptor.length;
    }
    const central = Buffer.concat(directory),
        end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.size, 8);
    end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, central, end]);
}

let nextReaderJob = 9000;
export async function readbackFixture(scope: 'web' | 'gateway' = 'gateway') {
    let record: any, context: any;
    const files = new Map<string, Buffer>();
    if (scope === 'gateway') {
        const f = pipelineFixture();
        ({ record } = await produceGatewayArchive(f.context, f.options, f.io));
        context = f.context;
        for (const name of [record.archive.name, record.checksum.name, 'gateway-build.json'])
            files.set(
                name,
                f.filesystem.bytes('/project/validation/gateway-test/artifacts/' + name),
            );
    } else {
        const f = sourceFixture(
            new Map([
                ['vite.config.mts', Buffer.from('synthetic shipping Vite config, never executed')],
            ]),
        );
        context = { ...f.context, scope: 'web', jobKey: 'web_archive' };
        const runtime = syntheticTools().runtime,
            vite = '/synthetic/vite/bin/vite.js';
        const io = {
            packageJSON: async () => f.files.get('package.json'),
            builder: async () => ({
                runtime,
                viteEntryPath: vite,
                viteEntrySHA256: 'e'.repeat(64),
            }),
            build: async () => ({
                pid: 123,
                exitCode: 0,
                signal: null,
                error: null,
                command: [
                    runtime.executablePath,
                    vite,
                    'build',
                    '--config',
                    '/project/vite.config.mts',
                    '--mode',
                    'web',
                    '--outDir',
                    '/project/validation/web/site',
                ],
                environment: { NODE_ENV: 'production', WEB_BASE_PATH: './' },
            }),
            output: async () =>
                new Map(
                    [
                        'index.html',
                        'capture-download-sw.js',
                        'capture-download-frame.js',
                        'assets/main.js',
                    ].map((name) => [name, Buffer.from('synthetic compiled ' + name)]),
                ),
            writeArchive: async (name: string, bytes: Buffer) => {
                files.set(name, Buffer.from(bytes));
                return { name, bytes: bytes.length, sha256: sourceDigest(bytes) };
            },
            readArchive: async (name: string) => Buffer.from(files.get(name)!),
            writeChecksum: async (name: string, bytes: Buffer) => {
                files.set(name, Buffer.from(bytes));
                return { name, bytes: bytes.length, sha256: sourceDigest(bytes) };
            },
            readChecksum: async (name: string) => Buffer.from(files.get(name)!),
            writeRecord: async (_value: unknown, bytes: Buffer) => {
                files.set('web-build.json', Buffer.from(bytes));
                return { name: 'web-build.json', bytes: bytes.length, sha256: sourceDigest(bytes) };
            },
            readBuildRecord: async () => Buffer.from(files.get('web-build.json')!),
        };
        record = await produceWebArchive(context, f.provider, io);
    }
    let encoded = carrier(files),
        services = 0;
    const selection = {
        context,
        service: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            repositoryId: '4242',
            workflowId: '500',
            workflowPath: '.github/workflows/produce-archives.yml',
            jobId: '700',
            jobName: 'Produce selected archive',
            artifactId: '600',
            artifactName: 'synthetic-selected-archive',
        },
        reader: {
            runId: '900',
            runAttempt: '1',
            jobId: String(nextReaderJob++),
            toolingCommit: 'f'.repeat(40),
        },
    };
    const observation = () => ({
        apiOrigin: 'https://api.github.com',
        repository: selection.service.repository,
        repositoryId: selection.service.repositoryId,
        run: {
            id: context.runId,
            attempt: context.runAttempt,
            headSHA: context.sourceCommit,
            workflowId: selection.service.workflowId,
            workflowPath: selection.service.workflowPath,
            status: 'completed',
            conclusion: 'success',
        },
        job: {
            id: selection.service.jobId,
            runId: context.runId,
            runAttempt: context.runAttempt,
            headSHA: context.sourceCommit,
            name: selection.service.jobName,
            status: 'completed',
            conclusion: 'success',
        },
        artifact: {
            id: selection.service.artifactId,
            name: selection.service.artifactName,
            runId: context.runId,
            headSHA: context.sourceCommit,
            sizeInBytes: encoded.length,
            digest: 'sha256:' + sourceDigest(encoded),
            expired: false,
        },
    });
    const controls: any = {},
        events: string[] = [],
        active = new Set<any>();
    async function open(request: any) {
        events.push('open:' + request.kind);
        if (controls.throwOpenKind === request.kind) throw controls.primary;
        if (controls.holdOpenKind === request.kind)
            await new Promise<void>((resolve) => {
                controls.releaseOpen = resolve;
            });
        let bytes: Buffer;
        if (request.kind === 'service') {
            const value = observation();
            services++;
            const mutate = services === 1 ? controls.before : controls.after;
            if (mutate) mutate(value);
            bytes = controls.serviceBytes ?? Buffer.from(JSON.stringify(value) + '\n');
        } else bytes = Buffer.from(encoded);
        let at = 0;
        const handle = {
            ...request,
            async read(max: number) {
                assert.equal(max, 65536);
                if (controls.readErrorKind === request.kind) throw controls.primary;
                if (at === bytes.length) return null;
                const result = bytes.subarray(at, at + Math.min(max, 127));
                at += result.length;
                return result;
            },
            async close() {
                events.push('close:' + request.kind);
                if (controls.holdCloseKind === request.kind)
                    await new Promise<void>((resolve) => {
                        controls.releaseClose = resolve;
                    });
                if (controls.closeErrorKind === request.kind) throw controls.cleanup;
                active.delete(handle);
            },
        };
        if (controls.foreignKind === request.kind) handle.owner = '0'.repeat(32);
        active.add(handle);
        return handle;
    }
    const ports = { openService: open, openArtifact: open };
    return {
        selection,
        record,
        files,
        controls,
        events,
        active,
        ports,
        observation,
        get services() {
            return services;
        },
        get encoded() {
            return encoded;
        },
        setCarrier(bytes: Buffer) {
            encoded = Buffer.from(bytes);
        },
        repack(deflate = false, descriptors = false) {
            encoded = carrier(files, deflate, descriptors);
        },
    };
}
