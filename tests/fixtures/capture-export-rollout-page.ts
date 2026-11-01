import type { startBrowserCaptureExport } from '../../src/features/automation/capture/browser-export';
import type { IndexedDbCaptureStore } from '../../src/features/automation/capture/indexeddb-store';
import type { CaptureWriter } from '../../shared/capture-writer';

type Api = {
    start: typeof startBrowserCaptureExport;
    Store: typeof IndexedDbCaptureStore;
    Writer: typeof CaptureWriter;
};
type Outcome = { state: 'pending' | 'resolved' | 'rejected'; detail?: unknown };
interface Attempt {
    start: Outcome;
    completed: Outcome;
    cancel: Outcome;
    diagnostics: { retirement: string; message: string }[];
    id?: string;
    handle?: Awaited<ReturnType<Api['start']>>;
    cancelCalls: number;
}
export interface RolloutPage {
    boot(): Promise<void>;
    seed(): Promise<string>;
    snapshot(): {
        generation: string;
        attempts: Omit<Attempt, 'handle'>[];
        helper: { activeExports: number; slots: number; busy: number } | null;
        frames: number;
        controls: string[];
    };
}
declare global {
    interface Window {
        exportRollout: RolloutPage;
        __rolloutHelperProbe?: () => { activeExports: number; slots: number; busy: number };
    }
}
/** Invoked only by the separately built fixture entry in an admitted browser. */
export function installRolloutPage(api: Api, generation: string) {
    if (window.exportRollout) throw Error('Rollout page already installed.');
    const attempts: Attempt[] = [], controls: string[] = [];
    let captureId: string | undefined, booted = false;
    const detail = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 512);
    const cancelled = () => {
        const current = attempts.at(-1);
        if (!current?.handle || ++current.cancelCalls > 3) throw Error('No owned rollout cancellation.');
        current.cancel = { state: 'pending' };
        void current.handle.cancel().then(
            () => { current.cancel = { state: 'resolved' }; },
            (error) => { current.cancel = { state: 'rejected', detail: detail(error) }; },
        );
    };
    document.getElementById('rollout-start')!.addEventListener('click', () => {
        if (!captureId || attempts.length >= 2) throw Error('Rollout attempt bound/no capture.');
        const attempt: Attempt = {
            start: { state: 'pending' }, completed: { state: 'pending' },
            cancel: { state: 'pending' }, cancelCalls: 0, diagnostics: [],
        };
        attempts.push(attempt);
        void api.start('json', { ids: [captureId] }, 'capture', (diagnostic) => {
            if (attempt.diagnostics.length >= 16) throw Error('Rollout diagnostic bound.');
            attempt.diagnostics.push({ ...diagnostic });
        }).then((handle) => {
            attempt.id = handle.id; attempt.handle = handle;
            attempt.start = { state: 'resolved' };
            void handle.completed.then(
                (value) => { attempt.completed = { state: 'resolved', detail: value }; },
                (error) => { attempt.completed = { state: 'rejected', detail: detail(error) }; },
            );
        }, (error) => {
            attempt.start = { state: 'rejected', detail: detail(error) };
        });
    });
    document.getElementById('rollout-cancel')!.addEventListener('click', cancelled);
    window.exportRollout = {
        async boot() {
            if (booted) throw Error('Rollout boot cannot be replayed.');
            booted = true;
            const base = new URL('./', document.baseURI);
            await navigator.serviceWorker.register(new URL('capture-download-sw.js', base), { scope: base.href });
            const registration = await navigator.serviceWorker.ready;
            if (registration.scope !== base.href) throw Error('Unexpected rollout scope.');
            // Controller activation is observed by the driver, never synthesized here.
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (controls.length >= 8) throw Error('Rollout transition bound.');
                controls.push(navigator.serviceWorker.controller?.scriptURL ?? 'none');
            });
        },
        async seed() {
            if (captureId) throw Error('Rollout capture already seeded.');
            const store = await api.Store.open();
            const writer = await api.Writer.begin(store, {
                transport: 'serial', receiveTimeSource: 'local-client', runId: 'rollout-synthetic',
                stepId: 'one', command: 'synthetic only', name: 'Worker rollout fixture',
                startedAt: '2026-10-31T00:00:00.000Z',
            });
            await writer.append(new TextEncoder().encode('bounded synthetic rollout output\r\n# '),
                '2026-10-31T00:00:00.000Z', 'serial');
            await writer.finish('prompt-observed');
            captureId = writer.id;
            await store.close();
            return captureId;
        },
        snapshot() {
            return {
                generation,
                attempts: structuredClone(attempts.map(({ handle: _handle, ...state }) => state)),
                helper: window.__rolloutHelperProbe?.() ?? null,
                frames: document.querySelectorAll('iframe').length,
                controls: [...controls],
            };
        },
    };
}
