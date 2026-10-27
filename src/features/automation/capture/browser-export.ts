import { CaptureStorageError } from '../../../../shared/capture-store';
import type { CaptureReportFormat, CaptureReportScope } from '../../../../shared/capture-report';

let activeExports = 0;
// Bound both active and reusable helper browsing contexts; no per-download context accumulation.
const helpers: { frame: HTMLIFrameElement; busy: boolean }[] = [];
function rpc<T>(worker: ServiceWorker, message: unknown, timeout = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel(),
            timer = setTimeout(() => {
                channel.port1.close();
                reject(
                    new CaptureStorageError(
                        'io',
                        'Export worker restarted or stopped responding; retry the export.',
                    ),
                );
            }, timeout);
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            channel.port1.close();
            event.data?.ok
                ? resolve(event.data.value)
                : reject(new CaptureStorageError('io', event.data?.error ?? 'Export failed.'));
        };
        try {
            worker.postMessage(message, [channel.port2]);
        } catch (error) {
            clearTimeout(timer);
            channel.port1.close();
            reject(error);
        }
    });
}
/** Called from an explicit browser export action; requires the web build's narrowly scoped helper. */
export async function startBrowserCaptureExport(
    format: CaptureReportFormat,
    scope: CaptureReportScope = {},
    source: 'capture' | 'console' = 'capture',
) {
    if (
        !isSecureContext ||
        !navigator.serviceWorker ||
        !['https:', 'http:'].includes(location.protocol)
    )
        throw new CaptureStorageError(
            'unsupported',
            'Streaming export requires this site on HTTPS or localhost.',
        );
    if (activeExports >= 4)
        throw new CaptureStorageError('busy', 'Finish or cancel another download first.');
    activeExports++;
    let frame: HTMLIFrameElement | undefined,
        heartbeat: ReturnType<typeof setInterval> | undefined,
        timer: ReturnType<typeof setTimeout> | undefined;
    let slot: (typeof helpers)[number] | undefined;
    let worker: ServiceWorker | undefined,
        id: string | undefined,
        ended = false;
    let complete!: (value: { state: 'stream-sent'; bytes: number }) => void,
        fail!: (error: unknown) => void;
    const completed = new Promise<{ state: 'stream-sent'; bytes: number }>((resolve, reject) => {
        complete = resolve;
        fail = reject;
    });
    void completed.catch(() => {});
    const cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(timer);
        if (slot) slot.busy = false;
        window.removeEventListener('message', helper);
        navigator.serviceWorker.removeEventListener('message', status);
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        activeExports--;
    };
    const finish = (error?: unknown, bytes = 0) => {
        if (ended) return;
        ended = true;
        if (error && worker && id)
            void rpc(worker, { type: 'capture-export-cancel', id }).catch(() => {});
        cleanup();
        error ? fail(error) : complete({ state: 'stream-sent', bytes });
    };
    const changed = () =>
        finish(
            new CaptureStorageError(
                'io',
                'Export worker changed; the download may be incomplete. Retry export.',
            ),
        );
    let nonce = '';
    const helper = (event: MessageEvent) => {
        if (
            event.source !== frame?.contentWindow ||
            event.origin !== location.origin ||
            event.data?.nonce !== nonce
        )
            return;
        if (event.data.type === 'capture-export-helper-ready') {
            clearTimeout(timer);
            frame.contentWindow!.postMessage(
                { type: 'capture-export-start', nonce },
                location.origin,
            );
        } else if (event.data.type === 'capture-export-helper-error')
            finish(new CaptureStorageError('io', event.data.error));
    };
    const result = (value: { state: string; bytes: number; error?: string }) => {
        if (value.state === 'stream-sent') finish(undefined, value.bytes);
        else if (value.state === 'failed')
            finish(new CaptureStorageError('io', value.error ?? 'Download failed.'));
    };
    const status = (event: MessageEvent) => {
        if (
            event.source === worker &&
            event.data?.type === 'capture-export-status' &&
            event.data.id === id
        )
            result(event.data);
    };
    try {
        const base = new URL('./', document.baseURI),
            script = new URL('capture-download-sw.js', base);
        const existing = await navigator.serviceWorker.getRegistration(base.href);
        if (
            existing?.scope === base.href &&
            existing.active &&
            existing.active.scriptURL !== script.href
        )
            throw new CaptureStorageError(
                'unsupported',
                'Another application owns this site worker; use native export.',
            );
        await navigator.serviceWorker.register(script.href, { scope: base.href });
        const registration = await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new CaptureStorageError(
                            'unsupported',
                            'The export worker could not activate.',
                        ),
                    ),
                10000,
            );
            void navigator.serviceWorker.ready.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
        if (
            registration.scope !== base.href ||
            !registration.active ||
            registration.active.scriptURL !== script.href
        )
            throw new CaptureStorageError(
                'unsupported',
                'This site cannot establish its scoped export worker.',
            );
        worker = registration.active;
        if (navigator.serviceWorker.controller?.scriptURL !== script.href)
            await new Promise<void>((resolve, reject) => {
                const changed = () => {
                    if (navigator.serviceWorker.controller?.scriptURL === script.href) {
                        clearTimeout(timer);
                        navigator.serviceWorker.removeEventListener('controllerchange', changed);
                        resolve();
                    }
                };
                const timer = setTimeout(() => {
                    navigator.serviceWorker.removeEventListener('controllerchange', changed);
                    reject(
                        new CaptureStorageError(
                            'unsupported',
                            'The export worker could not control this page.',
                        ),
                    );
                }, 10000);
                navigator.serviceWorker.addEventListener('controllerchange', changed);
                changed();
            });
        // The initial claim can change the page controller; listen for later changes only after preparation.
        const prepared = await rpc<{ id: string; frameUrl: string; nonce: string }>(worker, {
            type: 'capture-export-prepare',
            format,
            scope,
            source,
        });
        id = prepared.id;
        nonce = prepared.nonce;
        window.addEventListener('message', helper);
        navigator.serviceWorker.addEventListener('message', status);
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        slot = helpers.find((helper) => !helper.busy);
        if (!slot) {
            if (helpers.length >= 4)
                throw new CaptureStorageError('busy', 'Download helper ownership is full.');
            frame = document.createElement('iframe');
            frame.hidden = true;
            frame.title = 'Capture export download';
            frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-downloads');
            slot = { frame, busy: true };
            helpers.push(slot);
        }
        slot.busy = true;
        frame = slot.frame;
        frame.src = prepared.frameUrl;
        if (!frame.isConnected) document.body.append(frame);
        timer = setTimeout(
            () =>
                finish(
                    new CaptureStorageError(
                        'io',
                        'Export helper could not start. This site may block its download frame.',
                    ),
                ),
            10000,
        );
        let pinging = false;
        heartbeat = setInterval(() => {
            if (ended || pinging) return;
            pinging = true;
            void rpc<{ state: string; bytes: number; error?: string }>(
                worker!,
                { type: 'capture-export-status', id },
                5000,
            )
                .then(result)
                .catch(finish)
                .finally(() => {
                    pinging = false;
                });
        }, 5000);
        return {
            id: id!,
            completed,
            cancel: async () => {
                if (!ended) {
                    await rpc(worker!, { type: 'capture-export-cancel', id }).catch(() => {});
                    finish(new CaptureStorageError('io', 'Export cancelled.'));
                }
            },
        };
    } catch (error) {
        if (worker && id) await rpc(worker, { type: 'capture-export-cancel', id }).catch(() => {});
        finish(error);
        throw error;
    }
}
