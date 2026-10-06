import { validateSnapshot } from '../../shared/report';
import type { ConnectOptions, Snapshot } from '../../shared/types';

export interface GatewaySettings {
    url: string;
    token: string;
}

export class GatewayClient {
    readonly url: string;
    private sessionId = '';
    private listeners = new Set<() => void>();
    private readonly token: string;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private readonly onPageHide = () => this.releaseOnPageExit();

    private stopLifecycle(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        window.removeEventListener('pagehide', this.onPageHide);
    }

    private releaseOnPageExit(): void {
        const id = this.sessionId;
        this.sessionId = '';
        this.stopLifecycle();
        if (!id) return;
        // Page exit delivery is best-effort; gateway idle expiry handles crashes/offline exits.
        void fetch(`${this.url}/api/sessions/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${this.token}` },
            credentials: 'omit',
            cache: 'no-store',
            keepalive: true,
        }).catch(() => {});
        for (const listener of this.listeners) listener();
    }

    constructor(settings: GatewaySettings) {
        const url = new URL(settings.url);
        const localDevelopment =
            location.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(url.hostname) &&
            url.protocol === 'http:';
        if (url.protocol !== 'https:' && !localDevelopment)
            throw new Error(
                'Use an HTTPS gateway address. HTTP loopback is allowed only in local development.',
            );
        if (url.username || url.password || url.search || url.hash)
            throw new Error(
                'Enter the gateway URL without embedded credentials, query strings or fragments.',
            );
        this.url = url.toString().replace(/\/$/, '');
        if (settings.token.length < 32)
            throw new Error('Enter the gateway access token supplied by your administrator.');
        this.token = settings.token;
    }

    private async request(
        route: string,
        method = 'GET',
        data?: unknown,
    ): Promise<Record<string, unknown>> {
        const sessionAtStart = this.sessionId;
        let response: Response;
        try {
            response = await fetch(`${this.url}${route}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: data === undefined ? undefined : JSON.stringify(data),
                credentials: 'omit',
                cache: 'no-store',
                signal: AbortSignal.timeout(180_000),
            });
        } catch {
            throw new Error(
                'Cannot reach the gateway. Check its HTTPS address, allowed website origin and network access.',
            );
        }
        let payload: Record<string, unknown>;
        try {
            payload = await response.json();
        } catch {
            throw new Error('The gateway returned an invalid response.');
        }
        if (!response.ok) {
            if (
                this.sessionId &&
                this.sessionId === sessionAtStart &&
                [401, 404].includes(response.status)
            ) {
                this.sessionId = '';
                this.stopLifecycle();
                for (const listener of this.listeners) listener();
            }
            throw new Error(
                typeof payload.error === 'string'
                    ? payload.error
                    : `Gateway request failed (${response.status}).`,
            );
        }
        return payload;
    }

    async discover(options: ConnectOptions): Promise<string> {
        const data = await this.request('/api/fingerprint', 'POST', {
            host: options.host,
            port: options.port,
            username: options.username,
            auth: 'password',
        });
        if (typeof data.fingerprint !== 'string')
            throw new Error('Gateway did not return a host fingerprint.');
        return data.fingerprint;
    }

    async connect(options: ConnectOptions): Promise<void> {
        if (this.sessionId) await this.disconnect();
        const data = await this.request('/api/sessions', 'POST', options);
        if (typeof data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(data.sessionId))
            throw new Error('Gateway did not return a valid session.');
        this.sessionId = data.sessionId;
        window.addEventListener('pagehide', this.onPageHide);
        this.heartbeat = setInterval(() => {
            if (this.sessionId)
                void this.request(`/api/sessions/${this.sessionId}/heartbeat`, 'POST').catch(
                    () => {},
                );
        }, 60_000);
    }

    async collect(): Promise<Snapshot> {
        if (!this.sessionId) throw new Error('Connect through a gateway first.');
        return validateSnapshot(
            await this.request(`/api/sessions/${this.sessionId}/snapshot`, 'POST'),
            true,
        );
    }

    async disconnect(): Promise<void> {
        const id = this.sessionId;
        this.sessionId = '';
        this.stopLifecycle();
        if (!id) return;
        await this.request(`/api/sessions/${id}`, 'DELETE');
    }

    onDisconnected(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }
}
