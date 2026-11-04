import type { Page } from '@playwright/test';
import { installSshStream } from './ssh-stream';
export type CleanupFault = 'rejected-finalize' | 'lost-finalize' | 'uncertain-start';
declare global {
    interface Window {
        cleanupFaultTest: {
            starts: number; finalizes: number; pendingRetry: boolean; retriesReleased: number;
            releaseRetry(): void;
        };
    }
}
/** Fake RPC boundary only: models a rejected dispatch or lost retirement acknowledgement.
 * The production renderer/client/runner and real browser IndexedDB remain unchanged.
 * An idempotent fake receipt is not evidence that the backend/OS actually retired resources. */
export async function installCleanupFault(page: Page, mode: CleanupFault) {
    await installSshStream(page, { connection: 'cleanup-fault-connection', stdout: 'synthetic complete output', stderr: '', exitCode: 0 });
    await page.addInitScript((mode) => {
        const api = window.diagnosticHub!, original = api.automationStream!;
        let receipt: string | undefined, release: (() => void) | undefined;
        const state = { starts: 0, finalizes: 0, pendingRetry: false, retriesReleased: 0,
            releaseRetry() {
                if (!release || !state.pendingRetry) throw Error('No owned synthetic retry.');
                const owned = release; release = undefined; state.pendingRetry = false;
                state.retriesReleased++; owned();
            } };
        window.cleanupFaultTest = state;
        api.automationStream = async request => {
            if (request.action === 'start') {
                state.starts++;
                const result = await original(request);
                if (mode === 'uncertain-start') throw Error('Synthetic start reply lost after admission.');
                return result;
            }
            if (request.action !== 'finalize') return original(request);
            state.finalizes++;
            const key = JSON.stringify(request);
            if (state.finalizes === 1) {
                if (mode === 'lost-finalize') { await original(request); receipt = key; }
                throw Error('Synthetic finalize acknowledgement unavailable.');
            }
            if (state.finalizes !== 2) throw Error('Unexpected extra synthetic retry.');
            state.pendingRetry = true;
            await new Promise<void>(resolve => { release = resolve; });
            if (receipt !== undefined) {
                if (receipt !== key) throw Error('Foreign synthetic retirement receipt.');
                return { ok: true };
            }
            return original(request);
        };
    }, mode);
}
