/** Private observer barrier only. Production before-quit and cleanup are never bypassed. */
export function createNativeQuitObserver<T>(ports: {
    phase(): string; snapshot(): T; validate(value: T): void; write(value: T): void;
    schedule(callback: () => void): void; requestQuit(): void;
}) {
    let ready = false, release = false, queued = false, receiptAcknowledged = false;
    let error: string | null = null, originalError: unknown;
    const fail = (stage: string, cause: unknown) => {
        originalError = cause; error = 'Private native quit observer failed: ' + stage;
        ready = false; release = false;
    };
    const schedule = () => {
        if (error) throw Error(error);
        if (queued) return;
        queued = true;
        try { ports.schedule(() => {
            queued = false;
            try { ports.requestQuit(); } catch (cause) { fail('request', cause); }
        }); } catch (cause) { queued = false; fail('schedule', cause); throw cause; }
    };
    return {
        get ready() { return ready; }, get release() { return release; }, get error() { return error; },
        get receiptAcknowledged() { return receiptAcknowledged; }, get scheduled() { return queued; },
        failure() { return originalError; },
        request: schedule,
        allow() {
            if (!ready || release || ports.phase() !== 'ready' || error) throw Error('Private native quit barrier not ready.');
            release = true; schedule();
        },
        observeWillQuit(event: { preventDefault(): void }) {
            try {
                if (receiptAcknowledged) throw Error('Duplicate native final quit event.');
                if (error || ports.phase() !== 'ready') throw Error('Production quit did not acknowledge cleanup.');
                const snapshot = ports.snapshot(); ports.validate(snapshot);
                if (!release) { event.preventDefault(); ready = true; return; }
                ports.write(snapshot); receiptAcknowledged = true;
            } catch (cause) { event.preventDefault(); fail('snapshot-or-receipt', cause); }
        },
    };
}
