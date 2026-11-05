import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { parseWebArchiveBuildRecord } from './web-archive-producer.mjs';
import { openWebArchiveBytes } from './inner-archive-inspection.mjs';

const issued = new WeakMap(),
    pages = new WeakSet();
const hash = (b) => createHash('sha256').update(b).digest('hex');
const mime = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    ico: 'image/x-icon',
    woff2: 'font/woff2',
    json: 'application/json',
};
function memberPath(url, prefix) {
    assert.ok(typeof url === 'string' && Buffer.byteLength(url) <= 8192 && url.startsWith(prefix));
    const raw = url.split('?')[0];
    assert.ok(!raw.includes('#') && !/[\\\x00-\x20\x7f]/.test(raw));
    const relative = decodeURIComponent(raw.slice(prefix.length)) || 'index.html';
    assert.ok(relative.split('/').every((part) => part && part !== '.' && part !== '..'));
    assert.ok(!/[\\\x00-\x1f\x7f]/.test(relative));
    assert.equal(
        encodeURI(relative),
        raw.slice(prefix.length) || 'index.html',
        'Noncanonical web resource path.',
    );
    return relative;
}
/** Real archive-byte request handler and loopback host. No build, extraction, script or API injection.
 * Not invoked by any workflow/CLI. Production/archive provenance and runtime admission stay separate.
 */
export function createFinalWebHost(
    archive,
    recordBytes,
    selected,
    { prefix = '/artifact/' } = {},
    ports = { createServer: (handler) => http.createServer(handler) },
) {
    assert.match(prefix, /^\/(?:[A-Za-z0-9_-]+\/)+$/);
    const record = parseWebArchiveBuildRecord(recordBytes, selected),
        contents = openWebArchiveBytes(archive, record);
    const files = new Map(record.payload.map((row) => [row.path, { ...row }]));
    let phase = 'prepared',
        server,
        origin,
        listenPromise,
        closePromise,
        failure;
    const sockets = new Set(),
        responses = new Set(),
        socketJoins = new Set(),
        responseJoins = new Set();
    const token = randomBytes(32).toString('hex');
    const fail = (error) => {
        failure ??= error;
        phase = 'failed';
    };
    const state = () =>
        Object.freeze({
            phase,
            sockets: sockets.size,
            responses: responses.size,
            failure: Boolean(failure),
            listenerClosed: phase === 'closed',
            processRetirementProven: false,
        });
    function handler(req, res) {
        const pending = {};
        responses.add(pending);
        const joined = new Promise((resolve) =>
            res.once('close', () => {
                responses.delete(pending);
                responseJoins.delete(joined);
                resolve();
            }),
        );
        responseJoins.add(joined);
        res.once('error', fail);
        if (phase !== 'listening') {
            res.writeHead(503).end();
            return;
        }
        try {
            if (!['GET', 'HEAD'].includes(req.method)) {
                res.writeHead(405, { Allow: 'GET, HEAD' }).end();
                return;
            }
            let path;
            try {
                path = memberPath(req.url, prefix);
            } catch {
                res.writeHead(400).end();
                return;
            }
            if (!files.has(path)) {
                res.writeHead(404).end();
                return;
            }
            const bytes = contents.read(path),
                row = files.get(path);
            assert.equal(bytes.length, row.bytes);
            assert.equal(hash(bytes), row.sha256);
            res.writeHead(200, {
                'Content-Type': mime[path.split('.').at(-1)] ?? 'application/octet-stream',
                'Content-Length': bytes.length,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) {
            fail(error);
            res.destroy(error);
        }
    }
    const host = Object.freeze({
        snapshot: state,
        listen() {
            if (listenPromise) return listenPromise;
            assert.equal(phase, 'prepared');
            phase = 'binding';
            listenPromise = (async () => {
                try {
                    server = ports.createServer(handler);
                    server.on('connection', (socket) => {
                        sockets.add(socket);
                        socket.once('error', fail);
                        const joined = new Promise((resolve) =>
                            socket.once('close', () => {
                                sockets.delete(socket);
                                socketJoins.delete(joined);
                                resolve();
                            }),
                        );
                        socketJoins.add(joined);
                    });
                    server.on('error', fail);
                    await new Promise((resolve, reject) => {
                        server.once('error', reject);
                        server.listen(0, '127.0.0.1', resolve);
                    });
                    const address = server.address();
                    assert.ok(
                        address &&
                            address.address === '127.0.0.1' &&
                            Number.isSafeInteger(address.port) &&
                            address.port > 0 &&
                            address.port <= 65535,
                    );
                    assert.equal(failure, undefined);
                    origin = `http://127.0.0.1:${address.port}`;
                    phase = 'listening';
                    return Object.freeze({ origin, prefix, hostOwner: token });
                } catch (error) {
                    fail(error);
                    throw error;
                }
            })();
            return listenPromise;
        },
        close() {
            if (closePromise) return closePromise;
            closePromise = (async () => {
                if (phase === 'prepared') {
                    contents.releaseBytes();
                    phase = 'closed';
                    return state();
                }
                if (listenPromise) await listenPromise.catch(() => {});
                assert.ok(server, 'No acknowledged host allocation; custody cannot be inferred.');
                phase = 'closing';
                await new Promise((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
                // No destroy/closeAllConnections or timeout-as-retirement. Existing requests may hold forever.
                await Promise.all([...responseJoins, ...socketJoins]);
                assert.equal(responses.size, 0);
                assert.equal(sockets.size, 0);
                contents.releaseBytes();
                phase = 'closed';
                return state();
            })().catch((error) => {
                fail(error);
                throw error;
            });
            return closePromise;
        },
    });
    issued.set(host, {
        binding() {
            assert.equal(phase, 'listening');
            assert.equal(failure, undefined);
            return { origin, prefix, hostOwner: token };
        },
        row: (path) => files.get(path),
        read: (path) => contents.read(path),
        record: structuredClone(record),
        recordSHA256: hash(recordBytes),
    });
    return host;
}
/** Uses an already-owned fresh Playwright Page and only public browser/UI operations.
 * The caller keeps page/browser/process custody, including failures. No launch/close/GC/hidden hook.
 */
export class FinalWebObservationFailure extends Error {
    constructor(error, custody) {
        super('Final web observation failed; caller retains page/browser custody.', {
            cause: error,
        });
        this.custody = custody;
    }
}

export async function observeFinalWebStartup(
    host,
    page,
    observer,
    profile = { maxResponseBytes: 256 * 1024 ** 2, maxResponses: 4096 },
) {
    assert.deepEqual(Object.keys(profile).sort(), ['maxResponseBytes', 'maxResponses']);
    assert.ok(
        Number.isSafeInteger(profile.maxResponseBytes) &&
            profile.maxResponseBytes > 0 &&
            profile.maxResponseBytes <= 256 * 1024 ** 2,
    );
    assert.ok(
        Number.isSafeInteger(profile.maxResponses) &&
            profile.maxResponses > 0 &&
            profile.maxResponses <= 4096,
    );
    profile = Object.freeze({ ...profile });
    assert.ok(issued.has(host), 'Unissued archive host.');
    assert.ok(
        page && typeof page === 'object' && !pages.has(page),
        'Page observation already admitted.',
    );
    assert.equal(page.url(), 'about:blank', 'A fresh owned page is required.');
    assert.deepEqual(Object.keys(observer).sort(), [
        'jobId',
        'runAttempt',
        'runId',
        'toolingCommit',
    ]);
    for (const key of ['jobId', 'runId', 'runAttempt'])
        assert.match(observer[key], /^[1-9][0-9]{0,31}$/);
    assert.match(observer.toolingCommit, /^[a-f0-9]{40}$/);
    const selected = issued.get(host),
        binding = selected.binding(),
        browser = page.context().browser();
    const engine = browser.browserType().name(),
        version = browser.version();
    assert.ok(
        ['chromium', 'firefox', 'webkit'].includes(engine) &&
            typeof version === 'string' &&
            version.length > 0 &&
            version.length <= 256,
    );
    pages.add(page);
    const pending = new Set(),
        observed = new Map(),
        bodies = new WeakMap();
    let firstError,
        bodyBytes = 0,
        reservedBodyBytes = 0,
        events = 0,
        detached = false;
    const fail = (error) => {
        firstError ??= error;
    };
    const onError = () => fail(Error('The shipping page reported a runtime error.'));
    const custody = Object.freeze({
        snapshot: () =>
            Object.freeze({
                callbacksDetached: detached,
                responseReadsPending: pending.size,
                pageClosedReported: page.isClosed(),
                browserProcessRetirement: 'not-observed',
            }),
        joinPendingReads: () => Promise.all([...pending]),
    });
    function readResponse(response) {
        if (bodies.has(response)) return bodies.get(response);
        const work = (async () => {
            assert.ok(
                ++events <= profile.maxResponses,
                'Runtime response observation bound exceeded.',
            );
            const url = response.url();
            assert.ok(
                url.startsWith(binding.origin + '/'),
                'External runtime response unsupported.',
            );
            const path = memberPath(url.slice(binding.origin.length), binding.prefix),
                row = selected.row(path);
            assert.ok(
                row && response.status() === 200,
                'Unexpected or failed shipping resource response.',
            );
            reservedBodyBytes += row.bytes;
            assert.ok(
                reservedBodyBytes <= profile.maxResponseBytes,
                'Runtime response reservation exceeded.',
            );
            const bytes = await response.body();
            assert.ok(Buffer.isBuffer(bytes));
            bodyBytes += bytes.length;
            assert.ok(
                bodyBytes <= profile.maxResponseBytes,
                'Runtime response body allocation exceeded.',
            );
            assert.equal(bytes.length, row.bytes);
            assert.equal(
                hash(bytes),
                row.sha256,
                'Runtime response body differs from final archive.',
            );
            observed.set(path, { path, bytes: bytes.length, sha256: row.sha256 });
            return bytes;
        })();
        const task = work.then(
            (bytes) => {
                pending.delete(task);
                return bytes;
            },
            (error) => {
                pending.delete(task);
                fail(error);
                throw error;
            },
        );
        pending.add(task);
        bodies.set(response, task);
        task.catch(() => {});
        return task;
    }
    const onResponse = (response) => {
        readResponse(response);
    };
    let actionError;
    try {
        // The callbacks are retained until removal is acknowledged synchronously by the SDK.

        assert.equal(
            page.on('pageerror', onError),
            page,
            'Unsupported async listener registration.',
        );
        assert.equal(
            page.on('response', onResponse),
            page,
            'Unsupported async listener registration.',
        );
        const response = await page.goto(binding.origin + binding.prefix, {
            waitUntil: 'networkidle',
            timeout: 30000,
        });
        assert.ok(response && response.status() === 200);
        assert.equal(response.url(), binding.origin + binding.prefix);
        const html = await readResponse(response);
        assert.ok(
            html.equals(selected.read('index.html')),
            'Navigation document differs from final archive.',
        );
        await page
            .getByRole('button', { name: 'Connect target device', exact: true })
            .waitFor({ state: 'visible', timeout: 15000 });
        await page
            .getByRole('region', { name: 'Device time', exact: true })
            .waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
        actionError = error;
    }
    try {
        assert.equal(page.off('response', onResponse), page);
        assert.equal(page.off('pageerror', onError), page);
        detached = true;
    } catch (error) {
        fail(error);
    }
    await Promise.allSettled([...pending]); // No rejection/deadline is treated as response retirement.
    if (actionError || firstError)
        throw new FinalWebObservationFailure(actionError ?? firstError, custody);
    try {
        assert.ok(detached);
        assert.equal(pending.size, 0);
        selected.binding();
        const record = {
            schemaVersion: 1,
            kind: 'final-web-runtime-observation',
            scope: 'public-ui-startup',
            observationProfile: { ...profile },
            selectedSource: {
                commit: selected.record.context.sourceCommit,
                tree: selected.record.context.sourceTree,
                version: selected.record.context.version,
                buildRecordSHA256: selected.recordSHA256,
            },
            archive: { ...selected.record.archive },
            observer: { ...observer, engineReported: engine, browserVersionReported: version },
            host: binding,
            observations: {
                navigationDocumentSHA256: hash(selected.read('index.html')),
                resources: [...observed.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
                responseObjectsRead: events,
                responseBodyBytes: bodyBytes,
                startupControlsVisible: true,
                observerCallbacksJoined: true,
                adapterInstalledHooks: [],
            },
            executableIdentity: null,
            gatewayRuntime: null,
            productOwnership: null,
            processRetirement: null,
            reviewedPolicy: null,
            normalGC: null,
            forcedGC: null,
            releaseAcceptance: false,
        };
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        assert.ok(bytes.length <= 1024 ** 2);
        // Canonical emission to the owning caller only; no persistence, upload or publication acknowledgement is invented.
        return Object.freeze({ record: structuredClone(record), bytes, sha256: hash(bytes) });
    } catch (error) {
        throw new FinalWebObservationFailure(error, custody);
    }
}
