import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';

export type ResultAnnouncement = Readonly<{
    kind: 'result';
    schema: 1;
    sourceSHA256: string;
    resultSHA256: string;
}>;
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export function announceResult(bytes: string, sourceSHA256: string): ResultAnnouncement {
    assert.match(sourceSHA256, /^[a-f0-9]{64}$/);
    return Object.freeze({ kind: 'result', schema: 1, sourceSHA256, resultSHA256: digest(bytes) });
}
/** The receiver must verify the exact create-only file before acknowledging delivery. */
export function verifyResultAnnouncement(message: unknown, bytes: string, sourceSHA256: string) {
    assert.deepEqual(
        message,
        announceResult(bytes, sourceSHA256),
        'Final IPC receipt identity mismatch.',
    );
    const result = JSON.parse(bytes) as Record<string, unknown>;
    assert.equal(result.sourceSHA256, sourceSHA256);
    return result;
}

/** A send return value is backpressure information, never proof of receipt delivery. */
export function sendResultAndAwaitAck(
    channel: {
        events: EventEmitter;
        connected(): boolean;
        send(message: ResultAnnouncement, callback: (error: Error | null) => void): void;
    },
    announcement: ResultAnnouncement,
    options: { signal?: AbortSignal } = {},
): Promise<{ sendCallbackObserved: true; matchingAcknowledgementObserved: true }> {
    return new Promise((resolve, reject) => {
        let terminal = false,
            sent = false,
            acknowledged = false;
        const cleanup = () => {
            clearTimeout(timer);
            channel.events.removeListener('message', onMessage);
            channel.events.removeListener('disconnect', onDisconnect);
            channel.events.removeListener('close', onClose);
            channel.events.removeListener('error', onError);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error: unknown) => {
            if (terminal) return;
            terminal = true;
            cleanup();
            reject(error);
        };
        const complete = () => {
            if (terminal || !sent || !acknowledged) return;
            terminal = true;
            cleanup();
            resolve({ sendCallbackObserved: true, matchingAcknowledgementObserved: true });
        };
        const onMessage = (value: unknown) => {
            if (
                !value ||
                typeof value !== 'object' ||
                !('kind' in value) ||
                value.kind !== 'result-ack'
            )
                return;
            try {
                assert.deepEqual(value, {
                    kind: 'result-ack',
                    schema: 1,
                    resultSHA256: announcement.resultSHA256,
                });
                acknowledged = true;
                complete();
            } catch (error) {
                fail(error);
            }
        };
        const onDisconnect = () =>
            fail(Error('Final receipt IPC disconnected before delivery joined.'));
        const onClose = () => fail(Error('Final receipt IPC closed before delivery joined.'));
        const onError = (error: unknown) => fail(error);
        const onAbort = () =>
            fail(options.signal?.reason ?? Error('Final receipt handoff interrupted.'));
        const timer = setTimeout(
            () => fail(Error('Final receipt acknowledgement exceeded10000ms.')),
            10000,
        );
        channel.events.on('message', onMessage);
        channel.events.on('disconnect', onDisconnect);
        channel.events.on('close', onClose);
        channel.events.on('error', onError);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) {
            onAbort();
            return;
        }
        if (!channel.connected()) {
            onDisconnect();
            return;
        }
        try {
            channel.send(announcement, (error) => {
                if (error) fail(error);
                else {
                    sent = true;
                    complete();
                }
            });
        } catch (error) {
            fail(error);
        }
    });
}
