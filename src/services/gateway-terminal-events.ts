import { TERMINAL_CHUNK_BYTES, type TerminalEvent } from '../../shared/terminal';

// Only combine adjacent, validated frames from the same HTTP read. Awaiting one xterm
// parse per echoed byte needlessly schedules a browser timer for every SSH packet.
// Preserve state barriers, byte order, ownership and the existing 16 KiB event bound.
export function* coalesceTerminalEvents(events: Iterable<TerminalEvent>): Generator<TerminalEvent> {
    let pending: Extract<TerminalEvent, { type: 'data' }> | undefined;
    let bytes = '';
    for (const event of events) {
        const next = event.type === 'data' ? atob(event.data) : '';
        if (
            pending &&
            (event.type !== 'data' ||
                event.id !== pending.id ||
                bytes.length + next.length > TERMINAL_CHUNK_BYTES)
        ) {
            yield { ...pending, data: btoa(bytes) };
            pending = undefined;
            bytes = '';
        }
        if (event.type === 'data') {
            pending = event;
            bytes += next;
        } else yield event;
    }
    if (pending) yield { ...pending, data: btoa(bytes) };
}
