import type { AutomationRecord, RawChunk } from '../../../shared/automation';

export function receiveTimeLabel(source: AutomationRecord['receiveTimeSource']) {
    return source === 'local-client'
        ? 'Local client receive time (UTC)'
        : source === 'gateway'
          ? 'Gateway receive time (UTC)'
          : 'Capture host receive time (UTC; source not recorded)';
}
export function visibleReceivedText(text: string) {
    return text.replace(
        /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
        (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
    );
}
export interface ReceivedFragment extends RawChunk {
    index: number;
    byteLength: number;
    text: string;
    continuesFromPreviousChunk: boolean;
    pendingUtf8Bytes: number;
    incompleteAtEnd: boolean;
}
// Legacy chunks are receive observations. Serial blocks explicitly retain only
// first/last contributing receive observations; interior read times are not retained.
// Neither representation records device emission times or line timestamps.
// Keep array order and separate decoders for interleaved streams. A character
// spanning chunks is shown where its final bytes arrive; raw bytes stay intact.
export function receivedOutput(record: Pick<AutomationRecord, 'chunks'>): ReceivedFragment[] {
    const streams = new Map<
        RawChunk['stream'],
        { decoder: TextDecoder; pending: Uint8Array; last: number }
    >();
    const result = record.chunks.map((chunk, index) => {
        let state = streams.get(chunk.stream);
        if (!state) {
            state = {
                decoder: new TextDecoder('utf-8', { ignoreBOM: true }),
                pending: new Uint8Array(),
                last: index,
            };
            streams.set(chunk.stream, state);
        }
        const bytes = Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0));
        const combined = new Uint8Array(state.pending.length + bytes.length);
        combined.set(state.pending);
        combined.set(bytes, state.pending.length);
        const continuesFromPreviousChunk = state.pending.length > 0 && bytes.length > 0;
        let start = combined.length - 1;
        while (start >= 0 && (combined[start] & 0xc0) === 0x80) start--;
        const lead = combined[start],
            needed =
                lead >= 0xc2 && lead <= 0xdf
                    ? 2
                    : lead >= 0xe0 && lead <= 0xef
                      ? 3
                      : lead >= 0xf0 && lead <= 0xf4
                        ? 4
                        : 0;
        const second = combined[start + 1];
        const validPrefix =
            second === undefined ||
            (second >= 0x80 &&
                second <= 0xbf &&
                (lead !== 0xe0 || second >= 0xa0) &&
                (lead !== 0xed || second <= 0x9f) &&
                (lead !== 0xf0 || second >= 0x90) &&
                (lead !== 0xf4 || second <= 0x8f));
        state.pending =
            needed && validPrefix && combined.length - start < needed
                ? combined.slice(start)
                : new Uint8Array();
        state.last = index;
        return {
            ...chunk,
            index: index + 1,
            byteLength: bytes.length,
            text: state.decoder.decode(bytes, { stream: true }),
            continuesFromPreviousChunk,
            pendingUtf8Bytes: state.pending.length,
            incompleteAtEnd: false,
        };
    });
    for (const state of streams.values()) {
        const tail = state.decoder.decode();
        if (tail) {
            result[state.last].text += tail;
            result[state.last].incompleteAtEnd = true;
        }
    }
    return result;
}
export function formatReceivedOutput(
    record: Pick<AutomationRecord, 'chunks' | 'receiveTimeSource' | 'truncated'>,
) {
    const fragments = receivedOutput(record);
    return (
        receiveTimeLabel(record.receiveTimeSource) +
        '\nObserved chunk order; host receive time is not device emission time. UTF-8 characters spanning chunks appear with their completing chunk.\n' +
        (fragments.some((c) => c.aggregation)
            ? 'Serial byte blocks aggregate reads in capture order. First/last are contributing host receive observations, not per-byte or line times; interior read boundaries/times are not retained. A read may contribute to multiple blocks.\n'
            : '') +
        (fragments.length
            ? fragments
                  .map(
                      (c) =>
                          '[' +
                          c.index +
                          ' | ' +
                          c.receivedAt +
                          (c.aggregation
                              ? ' to ' +
                                c.aggregation.lastReceivedAt +
                                ' | serial byte block | ' +
                                c.aggregation.contributingReads +
                                ' contributing reads (first/last observations)'
                              : '') +
                          ' | ' +
                          c.stream +
                          ' | ' +
                          c.byteLength +
                          ' bytes]' +
                          (c.continuesFromPreviousChunk
                              ? ' [continues UTF-8 from previous chunk]'
                              : '') +
                          (c.incompleteAtEnd
                              ? ' [incomplete UTF-8 at capture end; replacement shown]'
                              : c.pendingUtf8Bytes
                                ? ' [UTF-8 bytes pending]'
                                : '') +
                          '\n' +
                          visibleReceivedText(c.text),
                  )
                  .join('\n')
            : 'No retained receive chunks; aggregate output may still contain local status text.') +
        (record.truncated ? '\nCapture truncated; only retained chunks are shown.' : '')
    );
}
