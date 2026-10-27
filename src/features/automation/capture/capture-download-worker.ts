import { IndexedDbCaptureStore } from './indexeddb-store';
import { IndexedDbConsoleJournal } from './indexeddb-console';
import { consoleExportSource } from './console-export-source';
import {
    CaptureExportBroker,
    captureExportSource,
    type ExportClient,
    type ExportReportSource,
} from './export-broker';
import { captureScope } from '../../../../shared/capture-query';
import type { CaptureReportFormat, CaptureReportScope } from '../../../../shared/capture-report';

interface WorkerClient extends ExportClient {
    postMessage(message: unknown): void;
}
interface Lifetime {
    waitUntil(task: Promise<unknown>): void;
}
interface WorkerMessage extends Lifetime {
    data: {
        type?: string;
        id?: string;
        nonce?: string;
        format?: CaptureReportFormat;
        scope?: CaptureReportScope;
        source?: 'capture' | 'console';
    };
    source: WorkerClient | null;
    ports: MessagePort[];
}
interface WorkerFetch extends Lifetime {
    request: Request;
    clientId: string;
    resultingClientId: string;
    respondWith(response: Promise<Response>): void;
}
interface Host {
    registration: { scope: string };
    skipWaiting(): Promise<void>;
    clients: {
        get(id: string): Promise<WorkerClient | undefined>;
        matchAll(options: { type: string; includeUncontrolled?: boolean }): Promise<WorkerClient[]>;
        claim(): Promise<void>;
    };
    addEventListener(type: 'install' | 'activate', callback: (event: Lifetime) => void): void;
    addEventListener(type: 'message', callback: (event: WorkerMessage) => void): void;
    addEventListener(type: 'fetch', callback: (event: WorkerFetch) => void): void;
}
const host = globalThis as unknown as Host;
let brokerPromise: Promise<CaptureExportBroker> | undefined;
let capturePromise: Promise<IndexedDbCaptureStore> | undefined;
const captures = () =>
    (capturePromise ??= IndexedDbCaptureStore.open().catch((error) => {
        capturePromise = undefined;
        throw error;
    }));
let consolePromise: Promise<IndexedDbConsoleJournal> | undefined;
const consoles = () =>
    (consolePromise ??= IndexedDbConsoleJournal.open().catch((error) => {
        consolePromise = undefined;
        throw error;
    }));
const lazyCaptures: ExportReportSource = {
    filename: 'automation-results',
    validateScope: captureScope,
    pin: async () => (await captures()).pin(),
    async *streamReport(format, scope, through, progress) {
        yield* captureExportSource(await captures()).streamReport(format, scope, through, progress);
    },
};
const broker = () =>
    (brokerPromise ??= (async () =>
        new CaptureExportBroker(
            lazyCaptures,
            {
                scope: host.registration.scope,
                now: () => performance.now(),
                client: (id) => host.clients.get(id),
                clients: () => host.clients.matchAll({ type: 'window' }),
                notify: async (id, message) => {
                    (await host.clients.get(id))?.postMessage(message);
                },
            },
            60000,
            consoleExportSource(consoles),
        ))().catch((error) => {
        brokerPromise = undefined;
        throw error;
    }));
host.addEventListener('install', (event) => event.waitUntil(host.skipWaiting()));
host.addEventListener('activate', (event) => event.waitUntil(host.clients.claim()));
host.addEventListener('message', (event) =>
    event.waitUntil(
        (async () => {
            const port = event.ports[0];
            if (!port) return;
            try {
                if (!event.source?.id || !event.data || typeof event.data !== 'object')
                    throw Error('Missing export client.');
                const service = await broker(),
                    data = event.data;
                let value: unknown;
                if (data.type === 'capture-export-prepare')
                    value = await service.prepare(
                        event.source.id,
                        data.format!,
                        data.scope,
                        data.source,
                    );
                else if (data.type === 'capture-export-claim')
                    value = await service.claim(data.nonce!, event.source.id);
                else if (data.type === 'capture-export-status')
                    value = await service.status(data.id!, event.source.id);
                else if (data.type === 'capture-export-cancel')
                    value = await service.cancel(data.id!, event.source.id);
                else throw Error('Unknown export operation.');
                port.postMessage({ ok: true, value });
            } catch (error) {
                port.postMessage({
                    ok: false,
                    error: String(error instanceof Error ? error.message : error).slice(0, 512),
                });
            } finally {
                port.close();
            }
        })(),
    ),
);
const frameHtml = () =>
    '<!doctype html><html><head><meta charset="utf-8"><title>Capture download</title></head><body><script src="' +
    new URL('capture-download-frame.js', host.registration.scope).href +
    '"></script></body></html>';
host.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url),
        scope = new URL(host.registration.scope),
        relative = url.pathname.slice(scope.pathname.length);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    if (relative.startsWith('__capture_export_frame/')) {
        event.respondWith(
            (async () => {
                try {
                    await (
                        await broker()
                    ).frame(
                        relative.slice('__capture_export_frame/'.length),
                        event.resultingClientId,
                    );
                } catch {
                    /* The helper delivers a client-bound claim error to its parent instead of hanging. */
                }
                return new Response(frameHtml(), {
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store',
                        'Content-Security-Policy':
                            "default-src 'none'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
                    },
                });
            })(),
        );
    } else if (relative.startsWith('__capture_export/')) {
        event.respondWith(
            (async () => {
                try {
                    const download = await (
                        await broker()
                    ).download(relative.slice('__capture_export/'.length), {
                        clientId: event.clientId,
                        referrer: event.request.referrer,
                        mode: event.request.mode,
                    });
                    event.waitUntil(download.done);
                    return new Response(download.stream, {
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'Content-Disposition':
                                'attachment; filename="' + download.filename + '"',
                            'Cache-Control': 'no-store',
                            'X-Content-Type-Options': 'nosniff',
                        },
                    });
                } catch {
                    return new Response('Capture export unavailable or owned by another client.', {
                        status: 403,
                        headers: { 'Cache-Control': 'no-store' },
                    });
                }
            })(),
        );
    }
});
