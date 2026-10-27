export const TERMINAL_CHUNK_BYTES = 16 * 1024;
export const TERMINAL_QUEUE_BYTES = 256 * 1024;
export const TERMINAL_WINDOW_BYTES = 64 * 1024;
export const TERMINAL_STALL_MS = 30_000;

export interface TerminalSize {
    cols: number;
    rows: number;
}
export interface TerminalOpen extends TerminalSize {
    id: string;
}
export type TerminalEvent =
    | { id: string; type: 'data'; sequence: number; data: string }
    | {
          id: string;
          type: 'state';
          state: 'opening' | 'open' | 'closed' | 'error';
          message?: string;
      };

export interface TerminalTransport {
    openTerminal(request: TerminalOpen): Promise<void>;
    writeTerminal(id: string, data: string): Promise<void>;
    resizeTerminal(id: string, size: TerminalSize): Promise<void>;
    closeTerminal(id: string): Promise<void>;
    acknowledgeTerminal(id: string, sequence: number): Promise<void>;
    onTerminalEvent(callback: (event: TerminalEvent) => void | Promise<void>): () => void;
}

export function terminalId(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value))
        throw Error('Invalid terminal identifier.');
    return value;
}

export function terminalSize(value: unknown): TerminalSize {
    const size = value as TerminalSize | null;
    if (
        !size ||
        !Number.isInteger(size.cols) ||
        !Number.isInteger(size.rows) ||
        size.cols < 2 ||
        size.cols > 500 ||
        size.rows < 1 ||
        size.rows > 300
    )
        throw Error('Terminal dimensions must be 2–500 columns and 1–300 rows.');
    return { cols: size.cols, rows: size.rows };
}

// Base64 carries bytes unchanged through IPC and newline-delimited HTTP frames.
export function terminalData(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > Math.ceil(TERMINAL_CHUNK_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
        throw Error('Invalid or oversized terminal data.');
    const bytes = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
    if (bytes > TERMINAL_CHUNK_BYTES) throw Error('Terminal input exceeds 16 KiB.');
    return value;
}

export function terminalSequence(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1)
        throw Error('Invalid terminal output acknowledgment.');
    return value as number;
}

export function terminalEvent(value: unknown): TerminalEvent {
    const event = value as TerminalEvent | null;
    if (!event) throw Error('Invalid terminal event.');
    terminalId(event.id);
    if (event.type === 'data') {
        terminalSequence(event.sequence);
        terminalData(event.data);
    } else if (
        event.type !== 'state' ||
        !['opening', 'open', 'closed', 'error'].includes(event.state) ||
        (event.message !== undefined &&
            (typeof event.message !== 'string' || event.message.length > 512))
    )
        throw Error('Invalid terminal event.');
    return event;
}
