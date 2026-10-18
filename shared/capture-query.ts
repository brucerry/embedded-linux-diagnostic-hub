import {
    CAPTURE_STORAGE,
    CaptureStorageError,
    integer,
    validId,
    type CaptureRepository,
    type StoredCapture,
} from './capture-store';
import type { AutomationOutcome } from './automation-result';

export interface CaptureFilter {
    transport?: 'serial' | 'ssh';
    completion?: string;
    name?: string;
    query?: string;
}
export interface CaptureScope {
    runId?: string;
    title?: string;
    ids?: string[];
    filter?: CaptureFilter;
}
export const CATALOG_WINDOW = { rows: 20, selected: 1000 } as const;
const completions = [
    'exit',
    'signalled',
    'uncertain-close',
    'prompt-observed',
    'timeout',
    'cancelled',
    'transport-error',
    'storage-error',
    'output-limit',
    'metadata-missing',
];
export function captureScope(input: unknown = {}): CaptureScope {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
        throw new CaptureStorageError('invalid', 'Invalid capture scope.');
    const scope = input as CaptureScope;
    if (
        Object.keys(scope).some((key) => !['runId', 'title', 'ids', 'filter'].includes(key)) ||
        (scope.runId !== undefined &&
            (typeof scope.runId !== 'string' || scope.runId.length > 128)) ||
        (scope.title !== undefined && (typeof scope.title !== 'string' || scope.title.length > 256))
    )
        throw new CaptureStorageError('invalid', 'Invalid capture scope field.');
    if (scope.ids !== undefined) {
        if (
            !Array.isArray(scope.ids) ||
            scope.ids.length > CATALOG_WINDOW.selected ||
            scope.filter !== undefined
        )
            throw new CaptureStorageError(
                'invalid',
                'Select at most 1000 captures, or use an uncapped filtered/all export.',
            );
        for (const id of scope.ids) {
            if (typeof id !== 'string')
                throw new CaptureStorageError('invalid', 'Invalid selected capture.');
            validId(id);
        }
        if (new Set(scope.ids).size !== scope.ids.length)
            throw new CaptureStorageError('invalid', 'Duplicate selected capture.');
    }
    if (scope.filter !== undefined) {
        const f = scope.filter;
        if (
            !f ||
            typeof f !== 'object' ||
            Array.isArray(f) ||
            Object.keys(f).some(
                (key) => !['transport', 'completion', 'name', 'query'].includes(key),
            ) ||
            (f.transport !== undefined && !['serial', 'ssh'].includes(f.transport)) ||
            (f.completion !== undefined && !completions.includes(f.completion)) ||
            (f.name !== undefined && (typeof f.name !== 'string' || f.name.length > 256)) ||
            (f.query !== undefined && (typeof f.query !== 'string' || f.query.length > 256))
        )
            throw new CaptureStorageError('invalid', 'Invalid capture filter.');
    }
    return structuredClone(scope);
}
/** Safe readable projection: strips controls/OSC rather than interpreting output-supplied actions. */
export class PlainCaptureText {
    private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
    append(text: string) {
        let result = '';
        for (const c of text) {
            if (this.state === 'string') {
                if (c === '\x07' || c === '\x9c') this.state = 'text';
                else if (c === '\x1b') this.state = 'string-escape';
                continue;
            }
            if (this.state === 'string-escape') {
                this.state = c === '\\' ? 'text' : 'string';
                continue;
            }
            if (this.state === 'escape') {
                if (c === '[') this.state = 'csi';
                else if ([']', 'P', '_', '^', 'X'].includes(c)) this.state = 'string';
                else if (c < ' ' || c > '/') this.state = 'text';
                continue;
            }
            if (this.state === 'csi') {
                if (c >= '@' && c <= '~') this.state = 'text';
                continue;
            }
            if (c === '\x1b') {
                this.state = 'escape';
                continue;
            }
            if (c === '\x9b') {
                this.state = 'csi';
                continue;
            }
            if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(c)) {
                this.state = 'string';
                continue;
            }
            if (c === '\r') result += '\n';
            else if (
                c === '\n' ||
                c === '\t' ||
                (c >= ' ' && c !== '\x7f' && !(c >= '\x80' && c <= '\x9f'))
            )
                result += c;
        }
        return result;
    }
}
export function captureCompletion(outcome: AutomationOutcome | null) {
    return outcome?.completion ?? 'metadata-missing';
}
function cancelled(signal?: AbortSignal) {
    if (signal?.aborted) throw new CaptureStorageError('busy', 'Catalog request cancelled.');
}
export async function matchesCapture(
    store: CaptureRepository,
    capture: StoredCapture,
    scope: CaptureScope,
    signal?: AbortSignal,
    progress?: () => void | Promise<void>,
) {
    cancelled(signal);
    await progress?.();
    if (scope.runId && capture.header.runId !== scope.runId) return false;
    if (scope.ids && !scope.ids.includes(capture.id)) return false;
    const f = scope.filter;
    if (!f) return true;
    if (f.transport && capture.header.transport !== f.transport) return false;
    if (f.name !== undefined && capture.header.name !== f.name) return false;
    const outcome =
        f.completion && capture.state !== 'active' ? await readOutcome(store, capture.id) : null;
    if (f.completion && capture.state === 'active') return false;
    if (f.completion && captureCompletion(outcome) !== f.completion) return false;
    if (!f.query) return true;
    const query = f.query.toLowerCase();
    if (
        (
            capture.header.name +
            '\n' +
            capture.header.command +
            '\n' +
            (capture.header.target?.endpoint ?? '')
        )
            .toLowerCase()
            .includes(query)
    )
        return true;
    if (capture.state === 'active') return false;
    const streams = new Map<
        string,
        { decoder: TextDecoder; plain: PlainCaptureText; tail: string }
    >();
    for await (const event of store.read(capture.id)) {
        cancelled(signal);
        await progress?.();
        if (event.type !== 'frame') continue;
        let state = streams.get(event.frame.stream);
        if (!state) {
            state = { decoder: new TextDecoder(), plain: new PlainCaptureText(), tail: '' };
            streams.set(event.frame.stream, state);
        }
        const text =
            state.tail +
            state.plain
                .append(state.decoder.decode(event.frame.bytes, { stream: true }))
                .toLowerCase();
        if (text.includes(query)) return true;
        state.tail = query.length > 1 ? text.slice(-(query.length - 1)) : '';
    }
    for (const state of streams.values())
        if ((state.tail + state.plain.append(state.decoder.decode()).toLowerCase()).includes(query))
            return true;
    return false;
}
export interface CatalogRow {
    capture: StoredCapture;
    outcome: AutomationOutcome | null;
    stdout: string;
    stderr: string;
    previewClipped: boolean;
}
async function readOutcome(store: CaptureRepository, id: string) {
    try {
        return (await store.result?.(id)) ?? null;
    } catch (error) {
        if (error instanceof CaptureStorageError && error.code === 'busy') return null;
        throw error;
    }
}
export async function capturePreview(
    store: CaptureRepository,
    capture: StoredCapture,
    signal?: AbortSignal,
): Promise<Pick<CatalogRow, 'stdout' | 'stderr' | 'previewClipped'>> {
    let remaining: number = CAPTURE_STORAGE.previewBytes;
    const streams = new Map<
        string,
        { decoder: TextDecoder; plain: PlainCaptureText; text: string }
    >();
    if (capture.state !== 'active')
        for await (const event of store.read(capture.id)) {
            cancelled(signal);
            if (event.type !== 'frame') continue;
            let state = streams.get(event.frame.stream);
            if (!state) {
                state = { decoder: new TextDecoder(), plain: new PlainCaptureText(), text: '' };
                streams.set(event.frame.stream, state);
            }
            const kept = event.frame.bytes.subarray(0, remaining);
            remaining -= kept.length;
            state.text += state.plain.append(state.decoder.decode(kept, { stream: true }));
            if (!remaining) break;
        }
    let stdout = '',
        stderr = '';
    for (const [stream, state] of streams) {
        state.text += state.plain.append(state.decoder.decode());
        if (stream === 'stderr') stderr += state.text;
        else stdout += state.text;
    }
    return {
        stdout,
        stderr,
        previewClipped: capture.committedBytes > CAPTURE_STORAGE.previewBytes,
    };
}
export async function catalogPage(
    store: CaptureRepository,
    filter: CaptureFilter = {},
    after = 0,
    signal?: AbortSignal,
) {
    const scope = captureScope({ filter });
    integer(after);
    let cursor = after,
        bytes = 64;
    const records: CatalogRow[] = [];
    while (true) {
        cancelled(signal);
        const page = await store.page(cursor);
        for (const capture of page.records) {
            cancelled(signal);
            if (!(await matchesCapture(store, capture, scope, signal))) continue;
            const row = {
                    capture,
                    outcome:
                        capture.state === 'active' ? null : await readOutcome(store, capture.id),
                    ...(await capturePreview(store, capture, signal)),
                },
                size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
            if (records.length === CATALOG_WINDOW.rows || bytes + size > CAPTURE_STORAGE.pageBytes)
                return { records, next: records.at(-1)?.capture.sequence ?? null };
            records.push(row);
            bytes += size;
        }
        if (page.next === null) return { records, next: null };
        cursor = page.next;
    }
}
