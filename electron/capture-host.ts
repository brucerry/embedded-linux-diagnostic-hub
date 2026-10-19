import { NativeCaptureStore, saveCaptureExport } from './capture-store';
import { CaptureRpcServer, type CaptureRpcReply } from '../shared/capture-rpc';
import { CaptureStorageError } from '../shared/capture-store';
import { captureScope } from '../shared/capture-query';
import {
    streamCaptureReport,
    type CaptureReportFormat,
    type CaptureReportScope,
} from '../shared/capture-report';

/** Destination selection remains in trusted main; renderer requests contain no paths. */
export class NativeCaptureHost {
    private server: CaptureRpcServer;
    private exports = new Set<Promise<boolean>>();
    private shutting?: Promise<void>;
    private closing = false;
    private constructor(
        private store: NativeCaptureStore,
        private destination: (format: CaptureReportFormat) => Promise<string | null>,
    ) {
        this.server = new CaptureRpcServer(store, (format, scope) => this.save(format, scope));
    }
    static async open(
        profile: string,
        ownership: { profileOwned: true },
        destination: (format: CaptureReportFormat) => Promise<string | null>,
    ) {
        return new NativeCaptureHost(
            await NativeCaptureStore.open(profile, ownership),
            destination,
        );
    }
    dispatch(request: unknown) {
        if (this.closing)
            return Promise.resolve<CaptureRpcReply>({
                ok: false,
                error: { code: 'io', message: 'Native capture storage is shutting down.' },
            });
        return this.server.dispatch(request);
    }
    reset() {
        return this.server.reset();
    }
    private save(format: CaptureReportFormat, scope: CaptureReportScope) {
        if (this.closing || this.exports.size >= 2)
            return Promise.reject(
                new CaptureStorageError('busy', 'Finish another native capture export first.'),
            );
        scope = captureScope(scope);
        const pending = (async () => {
            const pin = await this.store.pin();
            const report = streamCaptureReport(this.store, format, scope, pin.through);
            try {
                // Validate pinned membership before opening a native Save dialog. Retain
                // only the first bounded report chunk, then continue the same iterator.
                const first = await report.next();
                if (first.done)
                    throw new CaptureStorageError('integrity', 'Capture report produced no data.');
                const file = await this.destination(format);
                if (!file) return false;
                // Native Save dialog confirmation is the sole authority to replace a destination.
                await saveCaptureExport(
                    file,
                    (async function* () {
                        yield first.value;
                        yield* report;
                    })(),
                    true,
                );
                return true;
            } finally {
                try {
                    await report.return(undefined);
                } finally {
                    await pin.release();
                }
            }
        })();
        this.exports.add(pending);
        void pending.finally(() => this.exports.delete(pending)).catch(() => {});
        return pending;
    }
    shutdown() {
        return (this.shutting ??= (async () => {
            this.closing = true;
            const failures: unknown[] = [],
                pendingExports = [...this.exports];
            try {
                await this.server.dispose();
            } catch (error) {
                failures.push(error);
            }
            const exports = await Promise.allSettled(pendingExports);
            for (const result of exports)
                if (result.status === 'rejected') failures.push(result.reason);
            try {
                await this.store.close();
            } catch (error) {
                failures.push(error);
            }
            if (failures.length)
                throw new AggregateError(
                    failures,
                    'Native capture shutdown failed after cleanup attempts: ' +
                        failures.map((error) => String(error).slice(0, 512)).join('; '),
                );
        })());
    }
}
