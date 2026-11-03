import type { ReorderObserver } from './reorder-diagnostic';

export const REORDER_DIAGNOSTIC_BYTES = 32 * 1024;
const field = (input: unknown, key: string): unknown => {
    if (!input || typeof input !== 'object') return undefined;
    return Object.getOwnPropertyDescriptor(input, key)?.value;
};
const list = (input: unknown, max: number): unknown[] => {
    if (!Array.isArray(input)) return [];
    return Array.from({ length: Math.min(input.length, max) }, (_, i) => field(input, String(i)));
};
const choice = (input: unknown, allowed: readonly string[]) =>
    typeof input === 'string' && allowed.includes(input) ? input : 'other';
const number = (input: unknown) => typeof input === 'number' && Number.isFinite(input) && Math.abs(input) <= 1_000_000
    ? Math.round(input * 1000) / 1000 : null;
const uuid = (input: unknown) => typeof input === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input) ? input : null;
const hash = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input) ? input : null;
const rect = (input: unknown) => ['x', 'y', 'width', 'height'].map(key => number(field(input, key)));
const node = (input: unknown) => ({
    tag: choice(field(input, 'tag'), ['SPAN', 'LI', 'OL', 'INPUT', 'TEXTAREA', 'LABEL', 'BUTTON', 'DIV', 'SECTION', 'MAIN', 'BODY', 'HTML']),
    role: choice(field(input, 'role'), ['img', 'button', 'checkbox', 'textbox', 'region', 'group', 'navigation']),
    row: uuid(field(input, 'row')),
});
const snapshot = (input: unknown) => ({
    view: list(field(input, 'view'), 4).map(number),
    rows: list(field(input, 'rows'), 3).map(row => ({
        id: uuid(field(row, 'id')), draggable: field(row, 'draggable') === true,
        placeholder: field(row, 'placeholder') === true, rect: rect(field(row, 'rect')),
    })),
    source: rect(field(input, 'source')), target: rect(field(input, 'target')),
    notice: choice(field(input, 'notice'), ['empty', 'cancelled', 'updated', 'moved']),
    hidden: field(input, 'hidden') === true, running: field(input, 'running') === true,
    dialogs: number(field(input, 'dialogs')),
});
const eventTypes = ['pointerdown', 'mousedown', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'scroll'];

/** Whitelist structural fields only. Never serialize arbitrary objects, errors or content. */
export function encodeReorderDiagnostic(input: unknown, sdk: unknown): string {
    try {
        const raw = field(input, 'data');
        const events = list(field(raw, 'events'), 64).map(event => ({
            type: choice(field(event, 'type'), eventTypes),
            phase: choice(field(event, 'phase'), ['capture', 'bubble']),
            ms: number(field(event, 'ms')), trusted: field(event, 'trusted') === true,
            prevented: field(event, 'prevented') === true,
            button: number(field(event, 'button')), buttons: number(field(event, 'buttons')),
            x: number(field(event, 'x')), y: number(field(event, 'y')),
            target: node(field(event, 'target')), hit: node(field(event, 'hit')),
            transfer: {
                types: list(field(field(event, 'transfer'), 'types'), 8)
                    .map(value => choice(value, ['text/plain', 'text/html', 'Files'])),
                allowed: choice(field(field(event, 'transfer'), 'allowed'), ['none', 'copy', 'link', 'move', 'copyLink', 'copyMove', 'linkMove', 'all', 'uninitialized']),
                drop: choice(field(field(event, 'transfer'), 'drop'), ['none', 'copy', 'link', 'move']),
            },
            state: snapshot(field(event, 'state')),
        }));
        const payload = {
            kind: 'automation-reorder-diagnostic', schema: 1,
            status: choice(field(input, 'status'), ['active', 'not-started', 'install-failed', 'collect-failed']),
            markFailed: field(input, 'markFailed') === true,
            disposeFailed: field(input, 'disposeFailed') === true,
            observerErrors: number(field(raw, 'observerErrors')),
            overflow: field(raw, 'overflow') === true,
            counts: Object.fromEntries(eventTypes.flatMap(type => ['capture', 'bubble'].map(phase => {
                const key = type + ':' + phase;
                return [key, number(field(field(raw, 'counts'), key))];
            }))),
            sdk: {
                status: choice(field(sdk, 'status'), ['available', 'unavailable']),
                version: field(sdk, 'version') === '1.63.0' ? '1.63.0' : 'other',
                packageSha256: hash(field(sdk, 'packageSha256')),
                coreSha256: hash(field(sdk, 'coreSha256')),
                coreBytes: typeof field(sdk, 'coreBytes') === 'number' && Number.isSafeInteger(field(sdk, 'coreBytes'))
                    && Number(field(sdk, 'coreBytes')) >= 0 && Number(field(sdk, 'coreBytes')) <= 64 * 1024 * 1024
                    ? field(sdk, 'coreBytes') : null,
            },
            snapshots: list(field(raw, 'snapshots'), 3).map(item => ({
                stage: choice(field(item, 'stage'), ['before', 'after-gesture', 'final']),
                state: snapshot(field(item, 'state')),
            })),
            events, droppedAtSerialization: 0,
            invalidOrOversizeNumbers: 'null',
            limitation: 'Instrumented mocked browser observation; no inferred cause or native qualification.',
        };
        let encoded = JSON.stringify(payload);
        while (new TextEncoder().encode(encoded).length > REORDER_DIAGNOSTIC_BYTES && events.length) {
            // Keep a short initial prefix and the recent tail while space permits.
            events.splice(events.length > 8 ? 8 : 0, 1);
            payload.droppedAtSerialization++;
            encoded = JSON.stringify(payload);
        }
        if (new TextEncoder().encode(encoded).length > REORDER_DIAGNOSTIC_BYTES)
            return '{"kind":"automation-reorder-diagnostic","schema":1,"status":"size-fallback"}';
        return encoded;
    } catch {
        return '{"kind":"automation-reorder-diagnostic","schema":1,"status":"serialization-failed"}';
    }
}

/** Diagnostics must never replace the test's original success/failure. */
export async function emitReorderDiagnostic(
    observer: ReorderObserver, sdk: unknown, write: (line: string) => void = line => console.log(line),
): Promise<void> {
    let data: unknown, status = observer.status, disposeFailed = false;
    try { data = await observer.handle?.evaluate(api => api.finish()); }
    catch { status = 'collect-failed'; }
    finally {
        try { await observer.handle?.dispose(); } catch { disposeFailed = true; }
    }
    try { write(encodeReorderDiagnostic({ data, status, markFailed: observer.markFailed, disposeFailed }, sdk)); }
    catch { /* A broken diagnostic output channel must not mask the test error. */ }
}
