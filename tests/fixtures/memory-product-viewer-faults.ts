/** Private-build-only gates at the actual viewer request/codec boundary. No product messages. */
export const VIEWER_CODEC_FAILURE = 'Private synthetic viewer codec boundary failure.';
export type ViewerFaultAction = 'hold-request' | 'hold-codec-throw';
export type ViewerFaultFormat = 'png' | 'pdf';
export type ViewerFaultRealm = 'page' | 'worker';
export interface ViewerFaultTicket {
    version: 1;
    id: string;
    action: ViewerFaultAction;
    format: ViewerFaultFormat;
}
export interface ViewerFaultStatus {
    version: 1;
    realm: ViewerFaultRealm;
    ticket: ViewerFaultTicket | null;
    gates: readonly { id: string; stage: 'request' | 'codec'; released: boolean }[];
    counters: {
        dispatched: number;
        requestEntered: number;
        codecEntered: number;
        released: number;
        settled: number;
        aborted: number;
        failuresInjected: number;
        cleared: number;
    };
    events: readonly { ordinal: number; event: string; ticketId: string; at: string }[];
    droppedEvents: number;
}
function validFormat(value: unknown): asserts value is ViewerFaultFormat {
    if (value !== 'png' && value !== 'pdf') throw Error('Private viewer fault needs PNG or PDF.');
}
export function validViewerFaultTicket(value: unknown): ViewerFaultTicket {
    const ticket = value as ViewerFaultTicket;
    if (
        !ticket ||
        typeof ticket !== 'object' ||
        Array.isArray(ticket) ||
        ticket.version !== 1 ||
        typeof ticket.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(ticket.id) ||
        !['hold-request', 'hold-codec-throw'].includes(ticket.action) ||
        Object.keys(ticket).sort().join(',') !== 'action,format,id,version'
    )
        throw Error('Invalid private viewer fault ticket.');
    validFormat(ticket.format);
    return { ...ticket };
}

/** Factory is separately exercised with modeled gates; this is not a product-owner ledger. */
export function createViewerFaultRealm(
    realm: ViewerFaultRealm,
    makeId = () => crypto.randomUUID() as string,
) {
    if (!['page', 'worker'].includes(realm)) throw Error('Unknown viewer fault realm.');
    let ticket: ViewerFaultTicket | undefined,
        consumed = false,
        ordinal = 0,
        droppedEvents = 0;
    const counters = {
        dispatched: 0,
        requestEntered: 0,
        codecEntered: 0,
        released: 0,
        settled: 0,
        aborted: 0,
        failuresInjected: 0,
        cleared: 0,
    };
    const events: { ordinal: number; event: string; ticketId: string; at: string }[] = [];
    const gates = new Map<
        string,
        { stage: 'request' | 'codec'; released: boolean; release(): void }
    >();
    const note = (event: string, id: string) => {
        events.push({ ordinal: ++ordinal, event, ticketId: id, at: new Date().toISOString() });
        if (events.length > 64) {
            events.shift();
            droppedEvents++;
        }
    };
    async function hold(stage: 'request' | 'codec', signal?: AbortSignal) {
        const id = ticket!.id;
        if (gates.size) throw Error('A private viewer fault gate is already pending.');
        if (signal?.aborted) {
            counters.aborted++;
            throw new DOMException('Export cancelled.', 'AbortError');
        }
        let abort: (() => void) | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                gates.set(id, { stage, released: false, release: resolve });
                if (signal) {
                    abort = () => {
                        counters.aborted++;
                        note('aborted', id);
                        reject(new DOMException('Export cancelled.', 'AbortError'));
                    };
                    signal.addEventListener('abort', abort, { once: true });
                }
                note('held-' + stage, id);
            });
        } finally {
            if (abort) signal!.removeEventListener('abort', abort);
            gates.delete(id);
            counters.settled++;
            note('settled-' + stage, id);
        }
    }
    const api = {
        version: 1 as const,
        realm,
        arm(action: ViewerFaultAction, format: ViewerFaultFormat) {
            validFormat(format);
            if (ticket || gates.size)
                throw Error('Clear the previous settled private fault first.');
            ticket = validViewerFaultTicket({ version: 1, id: makeId(), action, format });
            consumed = false;
            note('armed', ticket.id);
            return { ...ticket };
        },
        /** Added only to the real postMessage payload by the private guarded build. */
        requestTicket(format: string) {
            if (!ticket || ticket.format !== format) return undefined;
            counters.dispatched++;
            note('dispatched', ticket.id);
            return { ...ticket };
        },
        /** Awaited at the real worker onmessage entry, before the existing canvas fallback. */
        async enterRequest(input: unknown, format: string) {
            if (input === undefined) return;
            if (realm !== 'worker')
                throw Error('Viewer request gate belongs to the actual worker.');
            const incoming = validViewerFaultTicket(input);
            if (incoming.format !== format || ticket)
                throw Error('Private viewer request identity changed.');
            ticket = incoming;
            counters.requestEntered++;
            note('request-entered', ticket.id);
            if (ticket.action === 'hold-request') await hold('request');
        },
        /** Synthetic throw at the actual encode boundary; underlying native codec is not invoked. */
        async beforeCodec(input: { format: string; mime: string; signal?: AbortSignal }) {
            if (
                !ticket ||
                ticket.format !== input.format ||
                consumed ||
                ticket.action !== 'hold-codec-throw'
            )
                return;
            const mime = ticket.format === 'png' ? 'image/png' : 'image/jpeg';
            if (input.mime !== mime) throw Error('Private viewer codec boundary MIME changed.');
            consumed = true;
            const id = ticket.id;
            counters.codecEntered++;
            note('codec-entered', id);
            await hold('codec', input.signal);
            counters.failuresInjected++;
            note('codec-synthetic-throw', id);
            throw Error(VIEWER_CODEC_FAILURE);
        },
        release(id: string) {
            const gate = gates.get(id);
            if (!gate || gate.released) throw Error('No matching unreleased private viewer gate.');
            gate.released = true;
            counters.released++;
            note('released-' + gate.stage, id);
            gate.release();
        },
        clear() {
            if (gates.size) throw Error('Cannot clear a pending private viewer gate.');
            if (ticket) {
                counters.cleared++;
                note('cleared', ticket.id);
            }
            ticket = undefined;
            consumed = false;
        },
        status(): ViewerFaultStatus {
            return {
                version: 1,
                realm,
                ticket: ticket ? { ...ticket } : null,
                gates: [...gates].map(([id, gate]) => ({
                    id,
                    stage: gate.stage,
                    released: gate.released,
                })),
                counters: { ...counters },
                events: events.map((x) => ({ ...x })),
                droppedEvents,
            };
        },
    };
    return api;
}
export type ViewerFaultApi = ReturnType<typeof createViewerFaultRealm>;
declare global {
    var __memoryProductViewerFaults: ViewerFaultApi | undefined;
}

/** Call only from private source transforms. This module is absent from public product imports. */
export function installViewerFaultRealm(
    realm: ViewerFaultRealm = typeof document === 'undefined' ? 'worker' : 'page',
): ViewerFaultApi {
    const current = globalThis.__memoryProductViewerFaults;
    if (current) {
        if (current.version !== 1 || current.realm !== realm)
            throw Error('Private viewer realm collision.');
        return current;
    }
    return (globalThis.__memoryProductViewerFaults = createViewerFaultRealm(realm));
}
