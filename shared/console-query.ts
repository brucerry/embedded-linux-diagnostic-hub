import { CaptureStorageError, base64Bytes } from './capture-store';
import { PlainCaptureText } from './capture-query';
import type { ConsoleSnapshot } from './console-journal';
import { consoleArchiveBounds, consoleSnapshot, type ConsoleArchive } from './console-storage';
import { streamObject } from './ssh-stream-rpc';

export interface ConsoleFilter {
    completion?: string;
    name?: string;
    query?: string;
}
export function consoleFilter(input: unknown = {}): ConsoleFilter {
    const value = streamObject(input, ['completion', 'name', 'query']);
    if (
        Object.values(value).some(
            (v) => v !== undefined && (typeof v !== 'string' || v.length > 256),
        ) ||
        (value.completion !== undefined &&
            ![
                'active',
                'complete',
                'incomplete',
                'prompt-observed',
                'cancelled',
                'timeout',
                'transport-error',
                'storage-error',
            ].includes(value.completion as string))
    )
        throw new CaptureStorageError('invalid', 'Invalid console result filter.');
    return Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined && v !== ''),
    ) as ConsoleFilter;
}
/** A full retained-prefix scan; the bounded visual preview never determines membership. */
export async function matchesConsoleCapture(
    store: ConsoleArchive,
    meta: ConsoleSnapshot,
    input: ConsoleFilter,
    progress?: () => void | Promise<void>,
) {
    const filter = consoleFilter(input);
    if (!Object.values(filter).some(Boolean)) return true;
    const query = filter.query?.toLowerCase() ?? '',
        name = filter.name?.toLowerCase() ?? '';
    let queryFound = !query || JSON.stringify(meta.header).toLowerCase().includes(query);
    let nameFound = !name;
    let completionFound =
        !filter.completion ||
        filter.completion === meta.state ||
        (filter.completion === 'storage-error' && meta.failure !== null) ||
        filter.completion === meta.reason;
    const decoder = new TextDecoder(),
        plain = new PlainCaptureText();
    let carry = '';
    const search = (part: string) => {
        if (queryFound || !query) return;
        const joined = carry + part.toLowerCase();
        if (joined.includes(query)) queryFound = true;
        carry = query.length > 1 ? joined.slice(1 - query.length) : '';
    };
    for await (const item of store.read(meta.header.id)) {
        await progress?.();
        if (item.kind !== 'record') continue;
        const record = item.record;
        if (
            (record.kind === 'segment-start' || record.kind === 'preparation') &&
            record.segment.kind === 'command'
        ) {
            const command = (
                record.segment.name +
                '\n' +
                record.segment.input.command
            ).toLowerCase();
            if (name && command.includes(name)) nameFound = true;
            if (query && command.includes(query)) queryFound = true;
        }
        if (record.kind === 'outcome' && record.completion === filter.completion)
            completionFound = true;
        if (record.kind === 'observation' && query && !queryFound) {
            // No full-output string: retain only the bounded overlap needed across frames.
            search(plain.append(decoder.decode(base64Bytes(record.base64), { stream: true })));
        }
    }
    search(plain.append(decoder.decode()));
    return queryFound && nameFound && completionFound;
}
export async function consoleCatalogPage(
    store: ConsoleArchive,
    input: ConsoleFilter,
    after?: string,
    signal?: AbortSignal,
) {
    consoleArchiveBounds(after, 25);
    const filter = consoleFilter(input),
        rows: ConsoleSnapshot[] = [];
    const check = () => {
        if (signal?.aborted)
            throw new CaptureStorageError('busy', 'Console catalog request cancelled.');
    };
    let cursor = after,
        mode: 'scan' | 'indexed' = 'scan';
    while (true) {
        check();
        const page = await store.list(cursor, 25);
        mode = page.mode;
        let previous = cursor;
        if (page.captures.length > 25)
            throw new CaptureStorageError('integrity', 'Console page exceeded its bound.');
        for (const [index, raw] of page.captures.entries()) {
            check();
            const meta = consoleSnapshot(raw),
                id = meta.header.id;
            if (previous && id <= previous)
                throw new CaptureStorageError('integrity', 'Console page did not advance.');
            previous = id;
            if (await matchesConsoleCapture(store, meta, filter, check)) rows.push(meta);
            if (rows.length === 25)
                return {
                    captures: rows,
                    next: index < page.captures.length - 1 || page.next !== null ? id : null,
                    mode,
                };
        }
        if (page.next === null) return { captures: rows, next: null, mode };
        if (!page.captures.length || page.next !== previous)
            throw new CaptureStorageError('integrity', 'Console catalog cursor differs.');
        cursor = page.next;
    }
}
