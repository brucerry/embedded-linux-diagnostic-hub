import { CaptureStorageError, type CaptureRepository } from '../../shared/capture-store';

export const workerQuotaMessage = 'Private synthetic export read quota control.';
let fault:
    | { action: 'hold' | 'quota'; entered: boolean; released: boolean; release?: () => void }
    | undefined;
const wrapped = new WeakSet<object>();
let activeReads = 0;
/** Private service-worker fixture only. The real iterator keeps its real read lease. */
export const workerReadFault = {
    arm(action: 'hold' | 'quota') {
        if (!['hold', 'quota'].includes(action)) throw Error('Unknown private worker read fault.');
        if (fault && !fault.released) throw Error('Worker read fault already armed.');
        fault = { action, entered: false, released: false };
    },
    status() {
        return fault
            ? { action: fault.action, entered: fault.entered, released: fault.released }
            : null;
    },
    activeReads() {
        return activeReads;
    },
    release() {
        if (!fault?.entered || fault.released || !fault.release)
            throw Error('No held real worker read.');
        fault.released = true;
        fault.release();
    },
    clear() {
        if (fault?.entered && !fault.released) throw Error('Cannot abandon real worker read gate.');
        fault = undefined;
    },
    wrap<T extends Pick<CaptureRepository, 'read'>>(store: T): T {
        if (wrapped.has(store)) throw Error('Worker store read already wrapped.');
        wrapped.add(store);
        const read = store.read;
        store.read = async function* (id: string) {
            activeReads++;
            try {
                for await (const item of read.call(this, id)) {
                    const current = fault;
                    if (current && !current.entered) {
                        current.entered = true;
                        if (current.action === 'quota') {
                            current.released = true;
                            throw new CaptureStorageError('quota', workerQuotaMessage);
                        }
                        await new Promise<void>((resolve) => {
                            current.release = resolve;
                        });
                    }
                    yield item;
                }
            } finally {
                activeReads--;
            }
        };
        return store;
    },
};
