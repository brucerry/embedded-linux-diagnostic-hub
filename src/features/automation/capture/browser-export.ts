import { CaptureStorageError, validId } from '../../../../shared/capture-store';
import type { CaptureReportFormat, CaptureReportScope } from '../../../../shared/capture-report';
import { isExportNonAdmissionReply } from './export-admission';

class ExportNotAdmittedError extends CaptureStorageError {}

let activeExports = 0;
// Bound both active and reusable helper browsing contexts; no per-download context accumulation.
const helpers: { frame: HTMLIFrameElement; busy: boolean }[] = [];
function rpc<T>(
    worker: ServiceWorker,
    message: unknown,
    timeout = 10000,
    prepareRequestId?: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel(),
            timer = setTimeout(() => {
                channel.port1.close();
                reject(
                    new CaptureStorageError(
                        'io',
                        'Export worker did not acknowledge the request; cleanup is uncertain.',
                    ),
                );
            }, timeout);
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            channel.port1.close();
            event.data?.ok
                ? resolve(event.data.value)
                : reject(
                      prepareRequestId && isExportNonAdmissionReply(event.data, prepareRequestId)
                          ? new ExportNotAdmittedError('io', event.data.error)
                          : new CaptureStorageError('io', event.data?.error ?? 'Export failed.'),
                  );
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
export interface BrowserExportDiagnostic {
    retirement: 'pending' | 'blocked';
    message: string;
}
/** Transfer failure is diagnostic; only an explicit retirement receipt releases ownership. */
export async function startBrowserCaptureExport(
    format: CaptureReportFormat,
    scope: CaptureReportScope = {},
    source: 'capture' | 'console' = 'capture',
    onDiagnostic?: (value: BrowserExportDiagnostic) => void,
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
    const services = navigator.serviceWorker;
    let frame: HTMLIFrameElement | undefined, slot: (typeof helpers)[number] | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined,
        timer: ReturnType<typeof setTimeout> | undefined;
    let worker: ServiceWorker | undefined,
        id: string | undefined,
        nonce = '';
    let retired = false,
        preparePosted = false,
        protocolAccepted = false,
        cancelStarted = false,
        stopping = false,
        controllerChanged = false;
    let firstFailure: unknown, notificationError: unknown, cleanupFailure: unknown;
    let hasFailure = false,
        hasCleanupFailure = false;
    let complete!: (value: { state: 'stream-sent'; bytes: number }) => void,
        fail!: (error: unknown) => void;
    let acknowledge!: () => void;
    const retirement = new Promise<void>((resolve) => {
        acknowledge = resolve;
    });
    const completed = new Promise<{ state: 'stream-sent'; bytes: number }>((resolve, reject) => {
        complete = resolve;
        fail = reject;
    });
    void completed.catch(() => {});
    const note = (error: unknown, blocked = false, cleanupError?: unknown, remember = true) => {
        if (remember && !hasFailure) {
            firstFailure = error;
            hasFailure = true;
        }
        let detail = cleanupError ?? (blocked && error !== firstFailure ? error : undefined);
        if (blocked && !hasCleanupFailure) {
            cleanupFailure = detail ?? error;
            hasCleanupFailure = true;
        }
        // Poll replies and notifications can cross. A prior pending snapshot cannot
        // erase an unacknowledged cleanup failure or its original diagnostic.
        if (detail === undefined && hasCleanupFailure && cleanupFailure !== firstFailure)
            detail = cleanupFailure;
        const remainsBlocked = blocked || hasCleanupFailure;
        const message = new CaptureStorageError(
            'io',
            String(
                hasFailure
                    ? firstFailure instanceof Error
                        ? firstFailure.message
                        : firstFailure
                    : error instanceof Error
                      ? error.message
                      : error,
            ) +
                (detail !== undefined
                    ? '; cleanup: ' + String(detail instanceof Error ? detail.message : detail)
                    : '') +
                (remainsBlocked
                    ? ' Cleanup is not acknowledged; this export remains blocked.'
                    : ' Waiting for export cleanup acknowledgement.'),
        ).message;
        if (remainsBlocked) {
            clearInterval(heartbeat);
            clearTimeout(timer);
        }
        try {
            onDiagnostic?.({ retirement: remainsBlocked ? 'blocked' : 'pending', message });
        } catch (error) {
            notificationError ??= error;
        }
    };
    const cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(timer);
        if (slot) slot.busy = false;
        window.removeEventListener('message', helper);
        services.removeEventListener('message', status);
        services.removeEventListener('controllerchange', changed);
        activeExports--;
    };
    const accept = (input: unknown) => {
        if (retired) return true;
        if (!input || typeof input !== 'object') return false;
        const value = input as {
            id?: unknown;
            retirement?: unknown;
            state?: unknown;
            bytes?: unknown;
            error?: unknown;
        };
        if (
            !protocolAccepted ||
            value.id !== id ||
            value.retirement !== 'acknowledged' ||
            !['stream-sent', 'failed'].includes(value.state as string) ||
            !Number.isSafeInteger(value.bytes) ||
            (value.bytes as number) < 0 ||
            (value.error !== undefined &&
                (typeof value.error !== 'string' || value.error.length > 512))
        )
            return false;
        retired = true;
        cleanup();
        acknowledge();
        // A Cancel that loses to already-proved success must not relabel that success.
        if (value.state === 'stream-sent')
            complete({ state: 'stream-sent', bytes: value.bytes as number });
        else {
            const error = hasFailure
                ? firstFailure
                : new CaptureStorageError('io', value.error ?? 'Export failed.');
            const errors = [error];
            if (hasCleanupFailure && cleanupFailure !== error) errors.push(cleanupFailure);
            if (notificationError !== undefined) errors.push(notificationError);
            fail(
                errors.length === 1
                    ? error
                    : new AggregateError(
                          errors,
                          new CaptureStorageError(
                              'io',
                              String(error instanceof Error ? error.message : error) +
                                  '; export cleanup diagnostics retained.',
                          ).message,
                          { cause: error },
                      ),
            );
        }
        return true;
    };
    const requestCancel = () => {
        if (retired || cancelStarted || !worker || !id) return;
        cancelStarted = true;
        stopping = true;
        clearTimeout(timer);
        const target = worker,
            job = id;
        void Promise.resolve()
            .then(() => rpc(target, { type: 'capture-export-cancel', id: job }))
            .then(
                (receipt) => {
                    if (!accept(receipt))
                        note(
                            new CaptureStorageError(
                                'io',
                                'Export cleanup receipt was not acknowledged.',
                            ),
                            true,
                        );
                },
                (error) => {
                    if (!retired) note(error, true);
                },
            );
    };
    const cancel = () => {
        if (!retired) {
            note(new CaptureStorageError('io', 'Export cancelled.'));
            requestCancel();
        }
        // Never reject early: late admission in ConsoleResultsOwner awaits this before completed.
        return retirement;
    };
    const changed = () => {
        if (retired) return;
        if (!controllerChanged) {
            controllerChanged = true;
            stopping = true;
            note(
                new CaptureStorageError('io', 'Export worker changed; cleanup is uncertain.'),
                true,
            );
        }
        requestCancel();
    };
    const helper = (event: MessageEvent) => {
        if (
            retired ||
            stopping ||
            event.source !== frame?.contentWindow ||
            event.origin !== location.origin ||
            event.data?.nonce !== nonce
        )
            return;
        if (event.data.type === 'capture-export-helper-ready') {
            clearTimeout(timer);
            frame!.contentWindow!.postMessage(
                { type: 'capture-export-start', nonce },
                location.origin,
            );
        } else if (event.data.type === 'capture-export-helper-error') {
            note(new CaptureStorageError('io', event.data.error));
            requestCancel();
        }
    };
    const result = (input: unknown) => {
        if (retired || !input || typeof input !== 'object') return;
        const value = input as {
            id?: unknown;
            retirement?: unknown;
            state?: unknown;
            error?: unknown;
            cleanupError?: unknown;
        };
        if (value.id !== id) return;
        if (accept(value)) return;
        if (value.state === 'closing' || value.state === 'failed') {
            stopping = true;
            note(
                new CaptureStorageError(
                    'io',
                    typeof value.error === 'string' ? value.error : 'Export cleanup is pending.',
                ),
                value.retirement === 'blocked' || value.retirement !== 'pending',
                value.cleanupError,
                typeof value.error === 'string',
            );
        } else if (value.state === 'stream-sent') {
            note(
                new CaptureStorageError('io', 'Export cleanup receipt was not acknowledged.'),
                true,
            );
        }
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
        // URL equality is not worker identity. No remote job exists before prepare is posted.
        if (services.controller !== worker)
            throw new CaptureStorageError(
                'io',
                'Export worker changed before preparation; no export was started.',
            );
        services.addEventListener('controllerchange', changed);
        if (services.controller !== worker) changed();
        if (controllerChanged)
            throw new CaptureStorageError(
                'io',
                'Export worker changed before preparation; no export was started.',
            );
        // Observe changes throughout the RPC; never replay prepare on a replacement worker.
        const requestId = crypto.randomUUID();
        preparePosted = true;
        const prepared = await rpc<{
            id: string;
            frameUrl: string;
            nonce: string;
            retirementProtocol?: number;
        }>(
            worker,
            { type: 'capture-export-prepare', requestId, format, scope, source },
            10000,
            requestId,
        );
        validId(prepared.id);
        id = prepared.id;
        validId(prepared.nonce);
        nonce = prepared.nonce;

        if (typeof prepared.frameUrl !== 'string' || prepared.retirementProtocol !== 1)
            throw new CaptureStorageError(
                'unsupported',
                'The export worker does not support acknowledged retirement.',
            );
        protocolAccepted = true;
        window.addEventListener('message', helper);
        services.addEventListener('message', status);
        if (services.controller !== worker && !controllerChanged) changed();
        if (controllerChanged) {
            requestCancel();
            await retirement;
            return { id, completed, cancel };
        }
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
        timer = setTimeout(() => {
            note(
                new CaptureStorageError(
                    'io',
                    'Export helper could not start. This site may block its download frame.',
                ),
            );
            requestCancel();
        }, 10000);
        let pinging = false;
        heartbeat = setInterval(() => {
            if (retired || pinging) return;
            pinging = true;
            void rpc(worker!, { type: 'capture-export-status', id }, 5000)
                .then(result)
                .catch((error) => {
                    if (!retired) {
                        note(error, true);
                        requestCancel();
                    }
                })
                .finally(() => {
                    pinging = false;
                });
        }, 5000);
        return { id, completed, cancel };
    } catch (error) {
        if (!preparePosted || error instanceof ExportNotAdmittedError) {
            cleanup();
            fail(error);
            throw error;
        }
        note(error, true);
        requestCancel();
        // Keep the caller's startup fence if the worker may own resources, including unknown id.
        await retirement;
        return { id: id!, completed, cancel };
    }
}
