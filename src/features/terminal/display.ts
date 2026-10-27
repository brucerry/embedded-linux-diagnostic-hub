import type { Terminal, IMarker, IDecoration } from '@xterm/xterm';

// An exited program may leave alternate-screen, mouse, paste or keyboard modes enabled.
// Soft-reset those modes without erasing the normal buffer and its bounded scrollback.
export async function restoreTerminalModes(term: Terminal, current: () => boolean) {
    term.clearSelection();
    await new Promise<void>((resolve) => {
        term.write('\x18', () => {
            if (!current()) return resolve();
            // Leaving an alternate screen restores its saved cursor. Doing that again on an
            // already-normal buffer would restore a stale position and overwrite history.
            const normalBuffer = term.buffer.active.type === 'alternate' ? '\x1b[?1049l' : '';
            term.write(
                normalBuffer + '\x1b[!p\x1b[?2004;1000;1002;1003;1004;1006;1l\x1b>\x1b[?25h',
                resolve,
            );
        });
    });
}

// Decorations color recognizable prompts without injecting commands or altering device output.
export function colorPrompts(term: Terminal) {
    type PromptMark = { marker: IMarker; decoration: IDecoration; width: number };
    const marks = new Set<PromptMark>();
    const remove = (mark: PromptMark) => {
        marks.delete(mark);
        mark.decoration.dispose();
        mark.marker.dispose();
    };
    const refresh = () => {
        for (const mark of marks) if (mark.marker.isDisposed) remove(mark);
        const buffer = term.buffer.active;
        if (buffer.type !== 'normal') {
            for (const mark of marks) remove(mark);
            return;
        }
        const cursor = buffer.baseY + buffer.cursorY;
        const rows = new Set<number>();
        for (let row = Math.max(0, cursor - 50); row <= cursor; row++) rows.add(row);
        for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row++) rows.add(row);
        const existing = new Map([...marks].map((mark) => [mark.marker.line, mark]));
        for (const row of rows) {
            const line = buffer.getLine(row);
            const prefix = !line?.isWrapped
                ? line?.translateToString(true).match(/^(.{0,160}?[#$>] )/)?.[1]
                : undefined;
            let width = 0,
                characters = 0,
                plain = true;
            while (line && prefix && width < term.cols && characters < prefix.length) {
                const cell = line.getCell(width++);
                characters += cell?.getChars().length ?? 0;
                if (!cell?.isFgDefault()) plain = false;
            }
            if (!prefix || !plain) width = 0;
            const old = existing.get(row);
            if (old?.width === width) continue;
            if (old) remove(old);
            if (!width) continue;
            const marker = term.registerMarker(row - cursor);
            if (!marker) continue;
            const decoration = term.registerDecoration({
                marker,
                width,
                foregroundColor: '#83d9b0',
                layer: 'bottom',
            });
            if (decoration) {
                decoration.onRender((element) => element.classList.add('terminal-prompt-color'));
                marks.add({ marker, decoration, width });
            } else marker.dispose();
        }
    };
    const listeners = [
        term.onWriteParsed(refresh),
        term.onScroll(refresh),
        term.onResize(refresh),
        term.buffer.onBufferChange(refresh),
    ];
    return {
        refresh,
        dispose() {
            listeners.forEach((listener) => listener.dispose());
            for (const mark of marks) remove(mark);
        },
    };
}

export function terminalCopyText(term: Terminal | null): string {
    if (!term) return '';
    const selected = term.getSelection();
    if (selected) return selected;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    const last = buffer.baseY + buffer.cursorY;
    for (let row = 0; row <= last; row++) {
        const line = buffer.getLine(row);
        const text = line?.translateToString(true) ?? '';
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
    }
    const text = lines.join('\n');
    if (text.length > 262144) throw Error('Select a smaller terminal region to copy.');
    return text;
}
