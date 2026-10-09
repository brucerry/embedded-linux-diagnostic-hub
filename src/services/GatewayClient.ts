import { validateSnapshot } from '../../shared/report';
import {
    validateDeviceClock,
    type DeviceClockResponse,
} from '../../shared/diagnostics/device-clock';
import type { ConnectOptions, Snapshot } from '../../shared/types';
import { validateInventory } from '../../shared/testing/inventory';
import { preparePlan, validateProfile } from '../../shared/testing/profile';
import { validateRun } from '../../shared/testing/report';
import {
    REPORT_BYTES,
    type BoardProfile,
    type StartTests,
    type TestingTransport,
    type TestRun,
} from '../../shared/testing/types';
import {
    terminalEvent,
    terminalId,
    terminalSize,
    terminalData,
    type TerminalEvent,
    type TerminalOpen,
    type TerminalSize,
    type TerminalTransport,
} from '../../shared/terminal';

export interface GatewaySettings {
    url: string;
    token: string;
}

export class GatewayClient implements TerminalTransport, TestingTransport {
    readonly url: string;
    private sessionId = '';
    private listeners = new Set<() => void>();
    private readonly token: string;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private readonly onPageHide = () => this.releaseOnPageExit();
    private terminalAbort?: AbortController;
    private clockAbort?: AbortController;
    private terminalListeners = new Set<(event: TerminalEvent) => void | Promise<void>>();

    private stopLifecycle(): void {
        this.clockAbort?.abort();
        this.clockAbort = undefined;
        this.terminalAbort?.abort();
        this.terminalAbort = undefined;
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
        options?: { signal?: AbortSignal; clock?: boolean; testing?: boolean },
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
                signal: options?.signal ?? AbortSignal.timeout(180_000),
            });
        } catch {
            throw new Error(
                'Cannot reach the gateway. Check its HTTPS address, allowed website origin and network access.',
            );
        }
        let payload: Record<string, unknown>;
        try {
            if (options?.testing) {
                const reader = response.body?.getReader();
                if (!reader) throw Error('Missing testing response.');
                let bytes = 0,
                    content = '';
                const decoder = new TextDecoder();
                try {
                    while (true) {
                        const part = await reader.read();
                        if (part.done) break;
                        bytes += part.value.byteLength;
                        if (bytes > REPORT_BYTES) {
                            await reader.cancel();
                            throw Error('Testing response exceeds limits.');
                        }
                        content += decoder.decode(part.value, { stream: true });
                    }
                    content += decoder.decode();
                    payload = JSON.parse(content);
                } finally {
                    reader.releaseLock();
                }
            } else payload = await response.json();
        } catch {
            throw new Error('The gateway returned an invalid response.');
        }
        if (!response.ok) {
            if (
                this.sessionId &&
                this.sessionId === sessionAtStart &&
                [401, 404].includes(response.status) &&
                !route.includes('/terminal') &&
                !(options?.clock && response.status === 404) &&
                !(
                    options?.testing &&
                    response.status === 404 &&
                    payload.error === 'Unknown gateway route.'
                )
            ) {
                this.sessionId = '';
                this.stopLifecycle();
                for (const listener of this.listeners) listener();
            }
            if (options?.clock && response.status === 404)
                return { status: 'unavailable', reason: 'unsupported' };
            if (
                options?.testing &&
                response.status === 404 &&
                payload.error === 'Unknown gateway route.'
            )
                throw Error(
                    'This gateway does not support board testing. Update the gateway to use Tests.',
                );
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

    private async testRequest(route: string, method: string, data?: unknown) {
        const session = this.sessionId;
        if (!session) throw Error('Connect through a gateway first.');
        const result = await this.request(`/api/sessions/${session}/tests/${route}`, method, data, {
            testing: true,
            signal: AbortSignal.timeout(65000),
        });
        if (session !== this.sessionId) throw Error('Device connection changed.');
        return result;
    }
    async discoverTests() {
        return validateInventory(await this.testRequest('inventory', 'POST'));
    }
    async clearTests() {
        await this.testRequest('clear', 'POST', {});
    }
    async prepareTests(profile: BoardProfile) {
        const result = await this.testRequest('prepare', 'POST', {
            profile: validateProfile(profile),
        });
        return preparePlan(validateProfile(result.profile), validateInventory(result.inventory));
    }
    async startTests(request: StartTests) {
        return validateRun(await this.testRequest('start', 'POST', request));
    }
    async readTestRun(): Promise<TestRun | null> {
        const response = await this.testRequest('run', 'GET');
        return response.run === null ? null : validateRun(response.run);
    }
    async cancelTests(id: string) {
        return validateRun(await this.testRequest('cancel', 'POST', { id }));
    }
    async confirmTest(request: {
        runId: string;
        testId: string;
        value: 'yes' | 'no' | 'unobserved';
    }) {
        return validateRun(await this.testRequest('confirm', 'POST', request));
    }

    async readDeviceClock(): Promise<DeviceClockResponse> {
        if (!this.sessionId) throw Error('Connect through a gateway first.');
        if (this.clockAbort) throw Error('A device clock read is already running.');
        const session = this.sessionId;
        const controller = new AbortController();
        this.clockAbort = controller;
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
            const result = await this.request(`/api/sessions/${session}/clock`, 'POST', undefined, {
                clock: true,
                signal: controller.signal,
            });
            if (this.sessionId !== session) throw Error('The device connection changed.');
            return validateDeviceClock(result);
        } finally {
            clearTimeout(timer);
            if (this.clockAbort === controller) this.clockAbort = undefined;
        }
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

    onTerminalEvent(callback: (event: TerminalEvent) => void | Promise<void>): () => void {
        this.terminalListeners.add(callback);
        return () => {
            this.terminalListeners.delete(callback);
        };
    }

    async openTerminal(request: TerminalOpen): Promise<void> {
        terminalId(request.id);
        terminalSize(request);
        if (!this.sessionId) throw Error('Connect through a gateway first.');
        if (this.terminalAbort) throw Error('A terminal is already active.');
        const controller = new AbortController();
        this.terminalAbort = controller;
        const session = this.sessionId;
        let opened = false;
        let settle!: () => void;
        let fail!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
            settle = resolve;
            fail = reject;
        });
        const timeout = setTimeout(() => {
            controller.abort();
            fail(Error('Gateway terminal opening timed out.'));
        }, 30_000);
        void (async () => {
            try {
                const response = await fetch(`${this.url}/api/sessions/${session}/terminal`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(request),
                    credentials: 'omit',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                if (
                    !response.ok ||
                    !response.body ||
                    !response.headers.get('content-type')?.startsWith('application/x-ndjson')
                )
                    throw Error(
                        response.status === 404
                            ? 'This gateway does not support Terminal, or the session expired. Update the gateway or reconnect.'
                            : 'Gateway could not open the terminal. Check access and the gateway version.',
                    );
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                try {
                    while (!controller.signal.aborted) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        // Cap the frame parser even if a server sends an unterminated frame.
                        if (buffer.length > 256 * 1024)
                            throw Error('Gateway terminal output exceeded the frame limit.');
                        let newline: number;
                        while ((newline = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.slice(0, newline);
                            buffer = buffer.slice(newline + 1);
                            if (!line || line === '{}') continue;
                            const event = terminalEvent(JSON.parse(line));
                            if (event.id !== request.id || this.sessionId !== session)
                                throw Error('Gateway returned an event for an earlier terminal.');
                            // Release ownership before notifying consumers that may replace the shell.
                            // The old reader's finally block must not clear a replacement controller.
                            if (
                                event.type === 'state' &&
                                event.state === 'closed' &&
                                this.terminalAbort === controller
                            )
                                this.terminalAbort = undefined;
                            for (const listener of this.terminalListeners) await listener(event);
                            if (event.type === 'state') {
                                if (event.state === 'open') {
                                    opened = true;
                                    clearTimeout(timeout);
                                    settle();
                                }
                                if (event.state === 'error')
                                    throw Error(event.message ?? 'Remote terminal failed.');
                                if (event.state === 'closed') {
                                    if (!opened) fail(Error('Terminal closed before opening.'));
                                    return;
                                }
                            }
                        }
                    }
                    if (!controller.signal.aborted)
                        throw Error('Terminal stream ended. Reconnect the device to continue.');
                } finally {
                    await reader.cancel().catch(() => {});
                    reader.releaseLock();
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Terminal stream failed.';
                fail(Error(message));
                if (!controller.signal.aborted)
                    for (const listener of this.terminalListeners)
                        await listener({
                            id: request.id,
                            type: 'state',
                            state: 'error',
                            message: message.slice(0, 512),
                        });
            } finally {
                clearTimeout(timeout);
                controller.abort();
                if (this.terminalAbort === controller) this.terminalAbort = undefined;
                if (!opened) fail(Error('Terminal opening was cancelled.'));
            }
        })();
        return ready;
    }

    async writeTerminal(id: string, data: string): Promise<void> {
        terminalData(data);
        await this.request(
            `/api/sessions/${this.sessionId}/terminal/${terminalId(id)}/input`,
            'POST',
            { data },
        );
    }

    async resizeTerminal(id: string, size: TerminalSize): Promise<void> {
        await this.request(
            `/api/sessions/${this.sessionId}/terminal/${terminalId(id)}/resize`,
            'POST',
            terminalSize(size),
        );
    }

    async closeTerminal(id: string): Promise<void> {
        const controller = this.terminalAbort;
        try {
            await this.request(
                `/api/sessions/${this.sessionId}/terminal/${terminalId(id)}`,
                'DELETE',
            );
        } finally {
            controller?.abort();
            if (this.terminalAbort === controller) this.terminalAbort = undefined;
        }
    }

    async acknowledgeTerminal(): Promise<void> {
        // HTTP write backpressure controls server credit; listeners await xterm consumption.
    }
}
