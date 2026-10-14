import { randomUUID } from 'node:crypto';
import type { SerialChoice, SerialChooser } from '../shared/serial';

export function serialOrigin(documentUrl: string): string {
    const url = new URL(documentUrl);
    return url.protocol + '//' + url.host;
}
function matchesSerialOrigin(value: string | undefined, documentUrl: string): boolean {
    const expected = serialOrigin(documentUrl);
    // Chromium serializes custom secure origins with a trailing root slash.
    // Accept only that equivalent root, never discard paths, queries or credentials.
    return value === expected || value === expected + '/';
}
export function allowsSerial(
    documentUrl: string,
    trustedContents: unknown,
    contents: unknown,
    permission: string,
    origin: string,
    details: { isMainFrame?: boolean; securityOrigin?: string; requestingUrl?: string },
): boolean {
    return (
        permission === 'serial' &&
        contents === trustedContents &&
        details.isMainFrame === true &&
        matchesSerialOrigin(origin, documentUrl) &&
        matchesSerialOrigin(details.securityOrigin, documentUrl) &&
        details.requestingUrl === documentUrl
    );
}
export class SerialSelection {
    private pending?: {
        id: string;
        ports: SerialChoice[];
        reply: (id: string) => void;
        timer: ReturnType<typeof setTimeout>;
    };
    constructor(private emit: (value: SerialChooser | null) => void) {}
    get active() {
        return Boolean(this.pending);
    }
    start(ports: SerialChoice[], reply: (id: string) => void): void {
        this.cancel();
        const id = randomUUID();
        const timer = setTimeout(() => this.cancel(), 60000);
        this.pending = { id, ports: this.clean(ports), reply, timer };
        this.publish();
    }
    update(ports: SerialChoice[]) {
        if (!this.pending) return;
        this.pending.ports = this.clean(ports);
        this.publish();
    }
    private clean(ports: SerialChoice[]) {
        const seen = new Set<string>();
        return ports
            .filter((p) => {
                if (typeof p.id !== 'string' || !p.id || p.id.length > 512 || seen.has(p.id))
                    return false;
                seen.add(p.id);
                return true;
            })
            .map((p) => ({
                id: p.id,
                name: String(p.name).slice(0, 512),
                ...(p.displayName ? { displayName: String(p.displayName).slice(0, 512) } : {}),
            }));
    }
    private publish() {
        if (this.pending) this.emit({ id: this.pending.id, ports: this.pending.ports });
    }
    select(id: unknown, portId: unknown): void {
        const pending = this.pending;
        if (
            !pending ||
            id !== pending.id ||
            typeof portId !== 'string' ||
            (portId !== '' && !pending.ports.some((p) => p.id === portId))
        )
            throw Error('This serial choice is stale or not offered.');
        this.pending = undefined;
        clearTimeout(pending.timer);
        this.emit(null);
        pending.reply(portId);
    }
    cancel() {
        if (this.pending) this.select(this.pending.id, '');
    }
}
