import type { Page, Response, Worker } from '@playwright/test';
import type { PassiveStage } from './loopback-diagnostics';

interface Sink {
    observe(stage: PassiveStage): void;
    observerFailed(): void;
    observerStopped(): void;
    observerOverflow(): void;
}

// Only metadata events are observed. No body/header/error text or URL is retained.
export function installLoopbackPassiveObserver(page: Page, appOrigin: string, gatewayOrigin: string, sink: Sink) {
    let active = true, admissions = 0, pending = 0;
    const seenResponses = new WeakSet<Response>(), seenWorkers = new WeakSet<Worker>();
    const workerDetach: (() => void)[] = [];
    const admit = () => {
        if (admissions === 32) { sink.observerOverflow(); return false; }
        admissions++; return true;
    };
    const failed = () => { if (active) sink.observerFailed(); };
    const onResponse = (response: Response) => {
        if (!active || seenResponses.has(response)) return;
        try {
            const url = new URL(response.url());
            if (url.origin !== gatewayOrigin || url.username || url.password || url.search || url.hash ||
                !/^\/api\/sessions\/[A-Za-z0-9_-]{32}\/snapshot$/.test(url.pathname) || response.request().method() !== 'POST') return;
            seenResponses.add(response);
            if (!admit()) return;
            const status = response.status();
            const group = Number.isInteger(status) && status >= 100 && status < 600 ? Math.floor(status / 100) : 0;
            sink.observe(group ? `snapshot-status-${group}xx` as PassiveStage : 'snapshot-status-other');
            pending++;
            void response.finished().then(result => {
                pending--;
                if (active) sink.observe(result === null ? 'snapshot-finished' : 'snapshot-finish-failed');
            }, () => {
                pending--;
                if (active) sink.observe('snapshot-finish-failed');
            }).catch(failed);
        } catch { failed(); }
    };
    const onWorker = (worker: Worker) => {
        if (!active || seenWorkers.has(worker)) return;
        try {
            const url = new URL(worker.url());
            if (url.origin !== appOrigin || url.username || url.password || url.hash ||
                url.pathname !== '/src/services/history.worker.ts' || url.search !== '?worker_file&type=module') return;
            seenWorkers.add(worker);
            if (!admit()) return;
            sink.observe('history-worker-created');
            let closed = false;
            const onClose = () => {
                if (active && !closed) { closed = true; sink.observe('history-worker-closed'); }
            };
            workerDetach.push(() => worker.off('close', onClose));
            worker.on('close', onClose);
        } catch { failed(); }
    };
    function stop() {
        if (!active) return;
        if (pending) sink.observerFailed(); // A pending observation is not completion proof.
        active = false;
        for (const detach of [() => page.off('response', onResponse), () => page.off('worker', onWorker), ...workerDetach]) {
            try { detach(); } catch { sink.observerFailed(); }
        }
        workerDetach.length = 0;
        sink.observerStopped();
    }
    try { page.on('response', onResponse); page.on('worker', onWorker); }
    catch (error) { sink.observerFailed(); stop(); throw error; }
    return {stop};
}
