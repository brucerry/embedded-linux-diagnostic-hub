import { historyFrame, type HistoryFrame } from '../../shared/diagnostics/presentation';
import type { Snapshot } from '../../shared/types';

// Only diagnostic evidence crosses this boundary; connection credentials stay in the session.
self.onmessage = (event: MessageEvent<{ snapshot: Snapshot; previous?: HistoryFrame }>) => {
    try {
        self.postMessage({ frame: historyFrame(event.data.snapshot, event.data.previous) });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
