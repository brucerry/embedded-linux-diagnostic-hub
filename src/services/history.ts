import { graphReadings, type HistoryFrame } from '../../shared/diagnostics/presentation';
import { processSample } from '../../shared/diagnostics/processes';
import type { Snapshot } from '../../shared/types';

// Creating a worker per collection also releases its raw evidence when processing finishes.
export async function prepareHistory(
    snapshot: Snapshot,
    previous?: HistoryFrame,
): Promise<HistoryFrame> {
    if (location.protocol !== 'file:') {
        try {
            return await new Promise<HistoryFrame>((resolve, reject) => {
                const worker = new Worker(new URL('./history.worker.ts', import.meta.url), {
                    type: 'module',
                    name: 'diagnostic-history',
                });
                const timeout = setTimeout(
                    () => finish(new Error('History processing timed out.')),
                    30_000,
                );
                function finish(error?: Error, frame?: HistoryFrame) {
                    clearTimeout(timeout);
                    worker.terminate();
                    if (error) reject(error);
                    else resolve(frame!);
                }
                worker.onmessage = (
                    event: MessageEvent<{ frame?: HistoryFrame; error?: string }>,
                ) => {
                    if (event.data.frame) finish(undefined, event.data.frame);
                    else finish(new Error(event.data.error || 'Could not prepare history.'));
                };
                worker.onerror = (event) => {
                    event.preventDefault();
                    finish(new Error('History worker unavailable.'));
                };
                worker.onmessageerror = () => finish(new Error('Could not receive history.'));
                try {
                    worker.postMessage({ snapshot, previous });
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            });
        } catch {
            // Portable file:// pages and browsers restricting workers still collect correctly.
        }
    }
    const frame: HistoryFrame = { capturedAt: snapshot.capturedAt, readings: {} };
    for (const result of snapshot.results) {
        // Yield between checks so hover, scrolling and animation frames can run in the fallback.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        frame.readings[result.id] = graphReadings(result.id, result, snapshot, previous?.processes);
        if (result.id === 'processes') frame.processes = processSample(result);
    }
    return frame;
}
