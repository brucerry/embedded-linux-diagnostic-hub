import { EventEmitter } from 'node:events';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sourceFixture, syntheticTools } from './gateway-producer-memory.ts';
import { observeSourceBridge } from '../../scripts/lib/committed-source-bridge.mjs';
import { carrierCRC32 } from '../../scripts/lib/artifact-carrier-zip.mjs';
import { validateWebArchiveBuildRecord } from '../../scripts/lib/web-archive-producer.mjs';
import {
    createFinalWebHost,
    observeFinalWebStartup,
} from '../../scripts/lib/final-web-runtime.mjs';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const canonical = (value) => Buffer.from(JSON.stringify(value) + '\n');
// Authored ordinary ZIP bytes, not a substitute for testing the producer's fflate encoder.
function zip(files) {
    const local = [],
        central = [];
    let offset = 0;
    for (const [filename, bytes] of files) {
        const name = Buffer.from(filename),
            data = deflateRawSync(bytes);
        const head = Buffer.alloc(30),
            entry = Buffer.alloc(46),
            crc = carrierCRC32(bytes);
        head.writeUInt32LE(0x04034b50);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x800, 6);
        head.writeUInt16LE(8, 8);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(data.length, 18);
        head.writeUInt32LE(bytes.length, 22);
        head.writeUInt16LE(name.length, 26);
        entry.writeUInt32LE(0x02014b50);
        entry.writeUInt16LE(3 * 256 + 20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x800, 8);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(bytes.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
        entry.writeUInt32LE(offset, 42);
        local.push(head, name, data);
        central.push(entry, name);
        offset += head.length + name.length + data.length;
    }
    const directory = Buffer.concat(central),
        end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.size, 8);
    end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

/** Synthetic build declarations plus the actual public startup emitter with event doubles.
 * No compiler/codec package, HTTP listener, browser, application or payload script executes.
 */
export async function startupEvidenceFixture({ repeat = false } = {}) {
    const source = sourceFixture(new Map([['vite.config.mts', Buffer.from('synthetic config')]]));
    const context = { ...source.context, scope: 'web', jobKey: 'web_archive' };
    const bridge = await observeSourceBridge(
        { sourceCommit: context.sourceCommit, sourceTree: context.sourceTree },
        source.provider,
    );
    const runtime = syntheticTools().runtime,
        empty = sha(Buffer.alloc(0));
    const payload = new Map(
        ['index.html', 'capture-download-sw.js', 'capture-download-frame.js', 'assets/main.js']
            .sort()
            .map((name) => [name, Buffer.from('synthetic payload, never executed: ' + name)]),
    );
    const archiveBytes = zip(payload),
        archive = {
            name: 'Diagnostic-Hub-Web-0.6.0.zip',
            bytes: archiveBytes.length,
            sha256: sha(archiveBytes),
        };
    const checksumBytes = Buffer.from(archive.sha256 + '  ' + archive.name + '\n');
    const record = {
        schemaVersion: 1,
        kind: 'web-source-build-archive',
        status: 'built',
        context,
        sourceBridgeSHA256: sha(canonical(bridge)),
        sourceBridge: bridge,
        builder: {
            runtime,
            viteEntryPath: '/synthetic/vite/bin/vite.js',
            viteEntrySHA256: 'e'.repeat(64),
        },
        build: {
            preset: 'shipping-vite-web',
            pid: 123,
            exitCode: 0,
            signal: null,
            error: null,
            command: [
                runtime.executablePath,
                '/synthetic/vite/bin/vite.js',
                'build',
                '--config',
                '/project/vite.config.mts',
                '--mode',
                'web',
                '--outDir',
                '/project/validation/web/site',
            ],
            environment: { NODE_ENV: 'production', WEB_BASE_PATH: './' },
            custody: {
                policy: 'owned-direct-child-no-signals-v1',
                environmentSHA256: 'c'.repeat(64),
                bounds: {
                    deadlineMs: 600000,
                    stdoutBytes: 16777216,
                    stderrBytes: 1048576,
                    chunksPerStream: 4096,
                },
                spawn: true,
                exit: true,
                childClose: true,
                elapsedMs: 0,
                descendantRetirement: 'not-observed',
                stdout: { bytes: 0, closed: true, sha256: empty },
                stderr: { bytes: 0, closed: true, sha256: empty },
            },
        },
        archive,
        checksum: {
            name: archive.name + '.sha256',
            bytes: checksumBytes.length,
            sha256: sha(checksumBytes),
        },
        payload: [...payload].map(([path, bytes]) => ({
            path,
            bytes: bytes.length,
            sha256: sha(bytes),
        })),
        productRuntime: null,
        loaderProvenance: null,
        normalGC: null,
        forcedGC: null,
        releaseAcceptance: false,
    };
    validateWebArchiveBuildRecord(record, context);
    const files = new Map([['web/web-build.json', canonical(record)]]);
    const observer = {
        runId: context.runId,
        runAttempt: context.runAttempt,
        jobId: '222',
        toolingCommit: 'c'.repeat(40),
    };
    for (const engine of ['chromium', 'firefox', 'webkit']) {
        const server = new EventEmitter();
        let handler;
        server.listen = (_port, _address, done) => done();
        server.address = () => ({ address: '127.0.0.1', port: 43123 });
        server.close = (done) => done();
        const host = createFinalWebHost(
            archiveBytes,
            files.get('web/web-build.json'),
            context,
            {},
            {
                createServer(callback) {
                    handler = callback;
                    return server;
                },
            },
        );
        await host.listen();
        const page = new EventEmitter();
        let url = 'about:blank';
        page.url = () => url;
        page.isClosed = () => false;
        page.context = () => ({
            browser: () => ({
                browserType: () => ({ name: () => engine }),
                version: () => 'synthetic-' + engine,
            }),
        });
        page.getByRole = () => ({ waitFor: async () => {} });
        page.goto = async (target) => {
            url = target;
            let navigation;
            for (const member of ['', 'assets/main.js', ...(repeat ? ['assets/main.js'] : [])]) {
                const response = new EventEmitter();
                response.writeHead = (status) => {
                    response.statusCode = status;
                    return response;
                };
                response.end = (body) => {
                    response.bytes = body;
                    response.emit('close');
                };
                handler({ url: '/artifact/' + member, method: 'GET' }, response);
                const observed = {
                    url: () => target + member,
                    status: () => response.statusCode,
                    body: async () => response.bytes,
                };
                page.emit('response', observed);
                navigation ??= observed;
            }
            return navigation;
        };
        const emitted = await observeFinalWebStartup(host, page, observer);
        files.set('web/' + engine + '-startup.json', emitted.bytes);
        await host.close();
    }
    const expected = { ...context, artifacts: [record.archive, record.checksum] };
    delete expected.jobKey;
    const receipt = {
        scope: 'web',
        browserVersions: {
            chromium: 'synthetic-chromium',
            firefox: 'synthetic-firefox',
            webkit: 'synthetic-webkit',
        },
        cases: [
            'web-archive-source-integrity',
            'web-chromium',
            'web-firefox',
            'web-webkit',
            'web-product-resource-qualification',
        ].map((id) => ({
            id,
            evidence: /** @type {Array<{path: string, bytes: number, sha256: string}>} */ ([]),
        })),
    };
    for (const [file, bytes] of files) {
        const id =
            file === 'web/web-build.json'
                ? 'web-archive-source-integrity'
                : 'web-' + file.split('/')[1].split('-')[0];
        receipt.cases
            .find((row) => row.id === id)
            .evidence.push({ path: file, bytes: bytes.length, sha256: sha(bytes) });
    }
    return {
        record,
        receipt,
        expected,
        files,
        observer,
        read: async (file) => JSON.parse(files.get(file).toString()),
    };
}
