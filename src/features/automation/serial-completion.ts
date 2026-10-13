import { strictIsoInstant } from '../../../shared/automation-time';
// Streaming finite-state escape removal; no user-supplied regex and bounded visible tail.
export class VisibleTail {
    value = '';
    private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
    append(text: string) {
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
                this.value = this.value.slice(0, -1);
                continue;
            }
            if (c === '\r') {
                this.value += '\n';
                continue;
            }
            if (c === '\n' || c === '\t' || (c >= ' ' && c !== '\x7f'))
                this.value = (this.value + c).slice(-4096);
        }
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
