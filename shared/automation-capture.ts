import { CaptureWriter } from './capture-writer';
import { storageError, type CaptureHeader, type CaptureRepository } from './capture-store';
import type {
    CommandOutputSink,
    StoredCommandCapture,
    StreamedCommandCapture,
} from './automation-stream';

/** Begin before sending, stop on storage failure, and retain ownership through the durable fence. */
export async function captureToRepository(
    store: CaptureRepository,
    header: CaptureHeader,
    signal: AbortSignal,
    produce: (sink: CommandOutputSink, signal: AbortSignal) => Promise<StreamedCommandCapture>,
): Promise<StoredCommandCapture> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let writer: CaptureWriter;
    try {
        writer = await CaptureWriter.begin(store, header, cancel);
    } catch (error) {
        signal.removeEventListener('abort', cancel);
        throw error; // No command was sent; storage initialization must fail closed.
    }
    let capture: StreamedCommandCapture = {
        stdout: '',
        stderr: '',
        exitCode: null,
        completion: 'cancelled',
        truncated: false,
        chunks: [],
        previewClipped: false,
    };
    try {
        if (!controller.signal.aborted) {
            try {
                capture = await produce(
                    {
                        append: (bytes, receivedAt, stream) =>
                            writer.append(bytes, receivedAt, stream),
                        flush: () => writer.flush(),
                        rejectObservation: (bytes, error) => writer.rejectObservation(bytes, error),
                    },
                    controller.signal,
                );
            } catch (error) {
                capture.completion = controller.signal.aborted ? 'cancelled' : 'transport-error';
                capture.stderr = storageError(error).message;
            }
        }
        try {
            const stored = await writer.finish(capture.completion);
            return {
                ...capture,
                previewClipped: capture.previewClipped || writer.previewClipped,
                stored,
            };
        } catch (error) {
            await writer.abort(error);
            const failure = writer.error ?? storageError(error);
            return {
                ...capture,
                completion: 'storage-error',
                truncated: true,
                stored: {
                    ...writer.snapshot,
                    state: 'incomplete',
                    reason: 'storage-error',
                    failure: { code: failure.code, message: failure.message },
                    observedBytes: writer.observedBytes,
                },
            };
        }
    } finally {
        signal.removeEventListener('abort', cancel);
        // A producer must have stopped and drained before its promise resolves. No background
        // append or release is allowed to outlive this function's completion fence.
    }
}
