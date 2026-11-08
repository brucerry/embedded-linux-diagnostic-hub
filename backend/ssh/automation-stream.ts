import type { Client, ClientChannel } from 'ssh2';
import type { Completion, TerminationEvidence } from '../../shared/automation';
import {
    CommandPreview,
    type CommandOutputSink,
    type StreamedCommandCapture,
} from '../../shared/automation-stream';
import { CAPTURE_STORAGE, CaptureStorageError } from '../../shared/capture-store';

/** Awaited observations preserve callback order and pause both SSH receive streams until credit. */
export function captureStreamingCommand(
    client: Client,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    sink: CommandOutputSink,
): Promise<StreamedCommandCapture> {
    return new Promise((resolve) => {
        let channel: ClientChannel | undefined,
            stopped: Completion | undefined,
            closed = false,
            opened = false,
            ended = false,
            errEnded = false,
            settled = false,
            pendingBytes = 0,
            pending = Promise.resolve(),
            exitCode: number | null = null,
            termination: TerminationEvidence | undefined;
        const preview = new CommandPreview();
        const observeExit = (
            code: number | null,
            name?: string,
            core?: boolean,
            message?: string,
        ) => {
            if (
                typeof code === 'number' &&
                Number.isInteger(code) &&
                code >= 0 &&
                code <= 4294967295
            )
                exitCode = code;
            if (typeof name === 'string' && name)
                termination = {
                    signal: name.slice(0, 128),
                    coreDumped: typeof core === 'boolean' ? core : null,
                    message: typeof message === 'string' ? message.slice(0, 4096) : null,
                    truncated:
                        name.length > 128 || (typeof message === 'string' && message.length > 4096),
                };
        };
        const finish = () => {
            if (settled || !closed || pendingBytes || (!stopped && opened && (!ended || !errEnded)))
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            client.off('close', disconnected);
            resolve({
                ...preview.finish(),
                exitCode,
                completion:
                    stopped ??
                    (termination ? 'signalled' : exitCode !== null ? 'exit' : 'uncertain-close'),
                truncated: false,
                chunks: [],
                previewClipped: preview.clipped,
                ...(termination ? { termination } : {}),
            });
        };
        const stop = (reason: Completion) => {
            if (settled) return;
            stopped ??= reason;
            channel?.close();
            // Drain discarded post-stop input so stream lifecycle events can settle. No more sink writes.
            channel?.resume();
            channel?.stderr.resume();
            finish();
        };
        const cancel = () => stop('cancelled');
        const disconnected = () => {
            closed = true;
            stop('transport-error');
        };
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        signal.addEventListener('abort', cancel, { once: true });
        client.prependOnceListener('close', disconnected);
        if (signal.aborted) {
            closed = true;
            cancel();
            return;
        }
        const append = (stream: 'stdout' | 'stderr', input: Buffer) => {
            if (stopped || settled || !input.length) return;
            channel!.pause();
            channel!.stderr.pause();
            if (pendingBytes + input.length > CAPTURE_STORAGE.backlogBytes) {
                try {
                    sink.rejectObservation(
                        input.length,
                        new CaptureStorageError(
                            'backlog',
                            'SSH receive backlog exceeded its bounded credit.',
                        ),
                    );
                } catch {}
                stop('transport-error');
                return;
            }
            const bytes = Uint8Array.from(input),
                receivedAt = new Date().toISOString();
            pendingBytes += bytes.length;
            pending = pending
                .then(async () => {
                    // Already-observed queued bytes are joined, even when cancellation arrives during IO.
                    await sink.append(bytes, receivedAt, stream);
                    preview.append(bytes, stream);
                })
                .catch(() => stop('transport-error'))
                .finally(() => {
                    pendingBytes -= bytes.length;
                    if (!stopped && !pendingBytes) {
                        channel?.resume();
                        channel?.stderr.resume();
                    }
                    finish();
                });
        };
        try {
            client.exec(command, (error, stream) => {
                if (error) {
                    closed = true;
                    stop('transport-error');
                    return;
                }
                channel = stream;
                opened = true;
                stream.on('data', (b: Buffer) => append('stdout', b));
                stream.stderr.on('data', (b: Buffer) => append('stderr', b));
                stream.on('exit', observeExit);
                stream.on('end', () => {
                    ended = true;
                    finish();
                });
                stream.stderr.on('end', () => {
                    errEnded = true;
                    finish();
                });
                stream.on('error', () => stop('transport-error'));
                stream.stderr.on('error', () => stop('transport-error'));
                stream.on(
                    'close',
                    (code: number | null, name?: string, core?: boolean, message?: string) => {
                        observeExit(code, name, core, message);
                        closed = true;
                        finish();
                    },
                );
                if (stopped) stop(stopped);
            });
        } catch {
            closed = true;
            stop('transport-error');
        }
    });
}
