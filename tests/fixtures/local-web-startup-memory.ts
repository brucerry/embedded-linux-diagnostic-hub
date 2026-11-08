import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';
import { produceLocalWebArchive } from '../../scripts/lib/web-archive-producer.mjs';
import { webBuildFixture } from './archive-readback-memory';

export function localArchiveFixture() {
    const f = webBuildFixture();
    const context = {
        scope: 'local-web-diagnostic',
        version: f.context.version,
        sourceCommit: f.context.sourceCommit,
        sourceTree: f.context.sourceTree,
        diagnosticId: 'a'.repeat(32),
    };
    f.io.writeRecord = async (_record: unknown, bytes: Buffer) => {
        f.files.set('local-web-build.json', Buffer.from(bytes));
        return { name: 'local-web-build.json', bytes: bytes.length, sha256: sourceDigest(bytes) };
    };
    return { ...f, context };
}
export async function localStartupFixture() {
    const f = localArchiveFixture();
    const record = await produceLocalWebArchive(f.context, f.source.provider, f.io);
    const input = {
        context: f.context,
        observer: { diagnosticId: f.context.diagnosticId, toolingCommit: 'c'.repeat(40) },
        buildRecordBytes: f.files.get('local-web-build.json')!,
        archiveBytes: f.files.get(record.archive.name)!,
        checksumBytes: f.files.get(record.checksum.name)!,
    };
    const controls: any = {
        creates: 0,
        closes: 0,
        pageCloses: 0,
        engine: 'chromium',
        primary: null,
        pageCloseGate: null,
        hostCloseGate: null,
        pageCloseError: null,
        hostCloseError: null,
        omitCloseEvent: false,
        pageError: false,
        drift: false,
        failedRequest: false,
    };
    let handler: any;
    const server: any = new EventEmitter();
    server.listen = (port: number, address: string, callback: () => void) => {
        assert.equal(port, 0);
        assert.equal(address, '127.0.0.1');
        callback();
    };
    server.address = () => ({ address: '127.0.0.1', port: 43123 });
    server.close = (callback: (error?: unknown) => void) => {
        controls.closes++;
        if (controls.hostCloseGate) {
            controls.hostCloseGate.enter();
            controls.hostCloseGate.promise.then(() => callback(controls.hostCloseError));
        } else callback(controls.hostCloseError);
    };
    const ports = {
        createServer(h: any) {
            controls.creates++;
            handler = h;
            return server;
        },
    };
    const request = (url: string) => {
        const response: any = new EventEmitter();
        response.writeHead = (status: number) => {
            response.status = status;
            return response;
        };
        response.end = (b: Buffer) => {
            response.body = Buffer.from(b ?? '');
            response.emit('close');
        };
        response.destroy = () => response.emit('close');
        handler({ method: 'GET', url }, response);
        return response;
    };
    const page: any = new EventEmitter();
    let closed = false,
        url = 'about:blank';
    page.url = () => url;
    page.isClosed = () => closed;
    page.context = () => ({
        browser: () => ({
            browserType: () => ({ name: () => controls.engine }),
            version: () => 'synthetic-sdk-version',
        }),
    });
    page.getByRole = (role: string, options: any) => ({
        waitFor: async (wait: any) => {
            assert.ok(
                (role === 'button' && options.name === 'Connect target device') ||
                    (role === 'region' && options.name === 'Device time'),
            );
            assert.equal(options.exact, true);
            assert.deepEqual(wait, { state: 'visible', timeout: 15000 });
        },
    });
    page.goto = async (target: string, options: any) => {
        assert.deepEqual(options, { waitUntil: 'networkidle', timeout: 30000 });
        if (controls.primary) throw controls.primary;
        url = target;
        const response = (relative: string) => {
            const served = request('/artifact/' + relative);
            const result = {
                status: () => served.status,
                url: () => target + relative,
                body: async () => served.body,
            };
            page.emit('response', result);
            return result;
        };
        const html = response('');
        response('assets/main.js');
        if (controls.pageError) page.emit('pageerror', Error('synthetic'));
        if (controls.failedRequest) page.emit('requestfailed', {});
        if (controls.drift) {
            url += 'other';
            page.emit('framenavigated', {});
            url = target;
        }
        return html;
    };
    page.close = async () => {
        controls.pageCloses++;
        if (controls.pageCloseGate) {
            controls.pageCloseGate.enter();
            await controls.pageCloseGate.promise;
        }
        if (controls.pageCloseError) throw controls.pageCloseError;
        closed = true;
        if (!controls.omitCloseEvent) page.emit('close');
    };
    return { ...f, record, input, page, controls, ports };
}
export function acknowledgedGate() {
    let release!: () => void, enter!: () => void;
    const promise = new Promise<void>((r) => {
        release = r;
    });
    const entered = new Promise<void>((r) => {
        enter = r;
    });
    return { promise, entered, release, enter };
}
