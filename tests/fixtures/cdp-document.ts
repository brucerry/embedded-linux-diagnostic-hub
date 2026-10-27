import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class FixtureCdp {
    private id = 0;
    private pending = new Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    readonly events: string[] = [];
    private constructor(private socket: WebSocket) {
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String((event as MessageEvent).data));
            if (message.id) {
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id);
                clearTimeout(request.timer);
                if (message.error) request.reject(Error(JSON.stringify(message.error)));
                else request.resolve(message.result);
            } else if (/executionContext|frameNavigated/.test(message.method ?? '')) {
                this.events.push(message.method);
            }
        });
        socket.addEventListener('close', () => {
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(Error('Fixture inspector closed.'));
            }
            this.pending.clear();
        });
    }
    static async connect(url: string) {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve(), { once: true });
            socket.addEventListener(
                'error',
                () => reject(Error('Fixture inspector connection failed')),
                { once: true },
            );
        });
        return new FixtureCdp(socket);
    }
    send(method: string, params: unknown = {}) {
        const id = ++this.id;
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(Error('Fixture CDP deadline: ' + method));
            }, 5000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression: string) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    }
    close() {
        this.socket.close();
    }
}

async function inspectors() {
    const servers = [createServer(), createServer()];
    await Promise.all(
        servers.map(
            (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
        ),
    );
    const ports = servers.map((server) => (server.address() as { port: number }).port);
    await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    return ports;
}
async function target(port: number, renderer: boolean) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch('http://127.0.0.1:' + port + '/json/list');
            const targets = (await response.json()) as {
                type: string;
                url: string;
                webSocketDebuggerUrl: string;
            }[];
            const result = targets.find((item) => !renderer || item.type === 'page');
            if (result) return result;
        } catch {}
        await delay(25);
    }
    throw Error('Fixture inspector did not open.');
}
export async function cdpDocumentFixture() {
    const profile = await mkdtemp(path.join(tmpdir(), 'diagnostic-cdp-document-'));
    const [mainPort, rendererPort] = await inspectors();
    const executable = createRequire(path.resolve('package.json'))('electron') as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
        executable,
        [
            '--inspect=127.0.0.1:' + mainPort,
            '--remote-debugging-port=' + rendererPort,
            path.resolve('tests/fixtures/cdp-document.cjs'),
            '--user-data-dir=' + profile,
        ],
        { windowsHide: true, stdio: 'ignore', env },
    );
    let main: FixtureCdp | undefined, renderer: FixtureCdp | undefined;
    const close = async () => {
        try {
            await main?.evaluate(
                "setImmediate(()=>process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit());true",
            );
        } catch {}
        renderer?.close();
        main?.close();
        await delay(200);
        if (child.exitCode === null) child.kill();
        if (
            path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) ||
            !path.basename(profile).startsWith('diagnostic-cdp-document-')
        )
            throw Error('Unexpected fixture cleanup path.');
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    };
    try {
        const page = await target(rendererPort, true);
        main = await FixtureCdp.connect((await target(mainPort, false)).webSocketDebuggerUrl);
        renderer = await FixtureCdp.connect(page.webSocketDebuggerUrl);
        await renderer.send('Runtime.enable');
        await renderer.send('Page.enable');
        const deadline = Date.now() + 5000;
        while (!(await main.evaluate('globalThis.documentGateHit'))) {
            if (Date.now() >= deadline) throw Error('Fixture document request did not start.');
            await delay(20);
        }
        return {
            target: page,
            main,
            renderer,
            close,
            release: () => main!.evaluate('releaseDocument();true'),
            ready: async () => {
                const deadline = Date.now() + 5000;
                while (
                    !(await renderer!.evaluate(
                        'document.URL === "app://bundle/index.html" && typeof window.diagnosticHub?.connect === "function"',
                    ))
                ) {
                    if (Date.now() >= deadline) throw Error('Fixture document did not commit.');
                    await delay(20);
                }
            },
        };
    } catch (error) {
        await close();
        throw error;
    }
}

export function powershellRendererProbe(url: string, timeout: number) {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$script:requestId = 0
. ${quote(path.resolve('tests/windows-cdp.ps1'))}
$socket = New-Object Net.WebSockets.ClientWebSocket
try {
    $socket.ConnectAsync([Uri]${quote(url)}, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    Write-Output 'WAITING'
    $ready = Wait-RendererReady $socket ${timeout}
    $value = Evaluate $socket '((fixtureSettings)=>fixtureSettings.port)({port:2468})'
    Write-Output ('RESULT ' + (@{ready=$ready;port=$value} | ConvertTo-Json -Depth 5 -Compress))
} finally { $socket.Dispose() }
`;
    const executable = path.join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const child: ChildProcess = spawn(
        executable,
        [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true },
    );
    let output = '';
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
        started = resolve;
    });
    child.stdout!.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('WAITING')) started();
    });
    child.stderr!.on('data', (chunk) => {
        output += chunk.toString();
    });
    const completion = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, output }));
    });
    return { waiting, completion };
}
