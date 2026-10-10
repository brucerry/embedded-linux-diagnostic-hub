import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import path from 'node:path';
import { app, screen } from 'electron';
import { inferTaskbar, selectTaskbar, type Rect, type TaskbarGeometry } from './genie-geometry';

function rect(value: unknown): value is Rect {
    const r = value as Rect | undefined;
    return Boolean(
        r &&
        [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n) && Math.abs(n) < 1_000_000) &&
        r.width > 0 &&
        r.height > 0,
    );
}
export function parseTaskbars(line: string): TaskbarGeometry[] {
    try {
        const data = line.length < 16384 ? JSON.parse(line) : null;
        if (!Array.isArray(data?.bars) || data.bars.length > 32) return [];
        return data.bars
            .filter(
                (bar: TaskbarGeometry) =>
                    bar &&
                    ['left', 'top', 'right', 'bottom'].includes(bar.edge) &&
                    rect(bar.bounds) &&
                    rect(bar.monitor),
            )
            .map((bar: TaskbarGeometry) => ({
                edge: bar.edge,
                bounds: bar.bounds,
                monitor: bar.monitor,
                ...(rect(bar.button) ? { button: bar.button } : {}),
            }));
    } catch {
        return [];
    }
}

/** Fixed, read-only shell metadata helper. No renderer commands or periodic queries. */
export class TaskbarReader {
    private child: ChildProcessWithoutNullStreams | null = null;
    private lines: Interface | null = null;
    private pending: { resolve: (bars: TaskbarGeometry[]) => void; timer: NodeJS.Timeout } | null =
        null;
    private disposed = false;
    private flight: Promise<TaskbarGeometry[]> | null = null;
    private readonly warm: Promise<TaskbarGeometry[]>;
    constructor(
        private readonly appId: string,
        private readonly title: () => string,
    ) {
        // Load native types first. Querying UI Automation before the main document is ready
        // can stall shell providers while they resolve the newly created app button.
        this.warm = this.query(5000, false);
    }
    ready() {
        return this.warm;
    }
    async prime() {
        await this.warm;
        return this.query(5000);
    }
    private stop() {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.resolve([]);
            this.pending = null;
        }
        this.lines?.close();
        this.child?.kill();
        this.lines = null;
        this.child = null;
        this.flight = null;
    }
    private query(timeout: number, identity = true): Promise<TaskbarGeometry[]> {
        if (this.disposed) return Promise.resolve([]);
        if (this.pending) return this.flight!.then(() => this.query(timeout, identity));
        if (!this.child) {
            const child = spawn(
                path.join(
                    process.env.SystemRoot ?? 'C:\\Windows',
                    'System32/WindowsPowerShell/v1.0/powershell.exe',
                ),
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    app?.isPackaged
                        ? path.join(
                              process.resourcesPath,
                              'app.asar.unpacked',
                              'dist-electron',
                              'taskbar-query.ps1',
                          )
                        : path.join(__dirname, 'taskbar-query.ps1'),
                ],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
            );
            this.child = child;
            const fail = () => {
                if (this.child === child) this.stop();
            };
            child.on('error', fail);
            child.on('exit', fail);
            child.stdin.on('error', fail);
            child.stderr.resume();
            this.lines = createInterface({ input: child.stdout });
            this.lines.on('line', (line) => {
                const pending = this.pending;
                if (!pending) return;
                this.pending = null;
                clearTimeout(pending.timer);
                pending.resolve(parseTaskbars(line));
            });
        }
        this.flight = new Promise((resolve) => {
            this.pending = { resolve, timer: setTimeout(() => this.stop(), timeout) };
            this.child!.stdin.write(
                JSON.stringify({
                    command: 'query',
                    ...(identity ? { appId: this.appId, title: this.title() } : {}),
                }) + '\n',
            );
        });
        return this.flight;
    }
    async forWindow(source: Rect): Promise<TaskbarGeometry | null> {
        await this.warm;
        if (this.disposed) return null;
        const display = screen.getDisplayMatching(source);
        const bars = (await this.query(1000)).map((bar) => ({
            ...bar,
            bounds: screen.screenToDipRect(null, bar.bounds),
            monitor: screen.screenToDipRect(null, bar.monitor),
            ...(bar.button ? { button: screen.screenToDipRect(null, bar.button) } : {}),
        }));
        return (
            selectTaskbar(display.bounds, bars) ?? inferTaskbar(display.bounds, display.workArea)
        );
    }
    close() {
        this.disposed = true;
        this.stop();
    }
}
