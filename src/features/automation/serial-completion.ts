import { strictIsoInstant } from '../../../shared/automation-time';
/** Track only unfinished UTF-8; TextDecoder remains authoritative for output text. */
export class Utf8Boundary {
    private remaining = 0;
    private minimum = 0x80;
    private maximum = 0xbf;
    get complete() {
        return this.remaining === 0;
    }
    append(bytes: Uint8Array) {
        for (const byte of bytes) {
            if (this.remaining) {
                if (byte >= this.minimum && byte <= this.maximum) {
                    this.remaining--;
                    this.minimum = 0x80;
                    this.maximum = 0xbf;
                    continue;
                }
                // Invalid continuation is reprocessed as a possible new leading byte.
                this.remaining = 0;
            }
            this.minimum = byte === 0xe0 ? 0xa0 : byte === 0xf0 ? 0x90 : 0x80;
            this.maximum = byte === 0xed ? 0x9f : byte === 0xf4 ? 0x8f : 0xbf;
            this.remaining =
                byte >= 0xc2 && byte <= 0xdf
                    ? 1
                    : byte >= 0xe0 && byte <= 0xef
                      ? 2
                      : byte >= 0xf0 && byte <= 0xf4
                        ? 3
                        : 0;
        }
    }
}
// Streaming finite-state escape removal; no user-supplied regex and bounded visible tail.
export class VisibleTail {
    value = '';
    private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
    get complete() {
        return this.state === 'text';
    }
    append(text: string) {
        let pending = '';
        const flush = () => {
            if (!pending) return;
            this.value = (this.value + pending).slice(-4096);
            pending = '';
        };
        for (const c of text) {
            if (this.state === 'string') {
                if (c === '\x07') this.state = 'text';
                else if (c === '\x1b') this.state = 'string-escape';
                continue;
            }
            if (this.state === 'string-escape') {
                this.state = c === '\\' ? 'text' : 'string';
                continue;
            }
            if (this.state === 'escape') {
                this.state =
                    c === '['
                        ? 'csi'
                        : c === ']' || c === 'P' || c === '_' || c === '^'
                          ? 'string'
                          : 'text';
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
            if (c === '\b') {
                // Apply truncation before destructive edits, preserving tail semantics.
                flush();
                this.value = this.value.slice(0, -1);
                continue;
            }
            if (c === '\r' || c === '\n' || c === '\t' || (c >= ' ' && c !== '\x7f')) {
                pending += c === '\r' ? '\n' : c;
                // Copy a bounded run instead of copying the 4-KiB tail for every character.
                // CR-only output is bounded by the same rule as ordinary visible text.
                if (pending.length >= 4096) flush();
            }
        }
        flush();
    }
}
export function observedDeviceTime(text: string, prefix: string, observedAt: string) {
    if (!prefix) return null;
    for (const line of text.split(/\r?\n/).reverse()) {
        if (!line.startsWith(prefix)) continue;
        const value = line.slice(prefix.length).trim();
        try {
            strictIsoInstant(value);
            return {
                value,
                source: 'Serial received literal prefix ' + prefix,
                zone: value.endsWith('Z') ? 'UTC' : value.slice(-6),
                observedAt,
            };
        } catch {}
    }
    return null;
}
