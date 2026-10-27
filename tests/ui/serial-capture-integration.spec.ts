import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import type {} from '../fixtures/serial-capture-browser';
import type { AutomationPlan, AutomationRecord } from '../../shared/automation';
import type { RunClock } from '../../src/features/automation/runner';
import type { LocalSerialPort } from '../../shared/serial';
import type { CaptureRepository } from '../../shared/capture-store';

let server: Server, url: string;
test.beforeAll(async () => {
    const result = await build({
        entryPoints: ['tests/fixtures/serial-capture-browser.ts'],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false,
        target: 'es2022',
    });
    server = createServer((request, response) => {
        response.writeHead(200, {
            'Content-Type': request.url === '/client.js' ? 'application/javascript' : 'text/html',
            'Content-Security-Policy':
                "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'",
        });
        response.end(
            request.url === '/client.js'
                ? result.outputFiles[0].contents
                : '<!doctype html><title>Integrated synthetic Serial capture</title><script src="/client.js"></script>',
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
test.beforeEach(async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.serialCaptureQA));
});

for (const fault of ['none', 'append', 'seal'] as const)
    test(
        'actual Serial runner + IndexedDB ' +
            fault +
            ' retains full raw evidence and gates later commands',
        async ({ page }) => {
            const result = await page.evaluate(async (fault) => {
                const {
                    serialCaptureFixture,
                    IndexedDbCaptureStore,
                    serialCaptureBackend,
                    SerialSession,
                    FlowRunner,
                    DEFAULT_SERIAL_SETTINGS,
                    CaptureStorageError,
                    streamCaptureReport,
                } = window.serialCaptureQA;
                const encode = (text: string) => new TextEncoder().encode(text),
                    expected: number[] = [],
                    fixture = serialCaptureFixture(async function* (_request, ordinal) {
                        let hash = 2166136261;
                        for (let index = 0; index < (ordinal === 1 ? 40 : 1); index++) {
                            const bytes = new Uint8Array(16384).fill(65 + (index % 26));
                            for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
                            yield bytes;
                        }
                        const tail = encode('\r\nboard# ');
                        for (const byte of tail) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
                        yield tail;
                        expected.push(hash);
                    }),
                    store = await IndexedDbCaptureStore.open(),
                    session = new SerialSession(async () => {});
                session.select(fixture.port, 'synthetic browser UART');
                await session.connect(DEFAULT_SERIAL_SETTINGS);
                let commits = 0;
                const wrapped = new Proxy(store, {
                        get(target, key) {
                            if (key === 'append' && fault === 'append')
                                return async (...args: Parameters<CaptureRepository['append']>) => {
                                    if (++commits === 2)
                                        throw new DOMException(
                                            'Synthetic storage quota exhausted.',
                                            'QuotaExceededError',
                                        );
                                    return store.append(...args);
                                };
                            if (key === 'seal' && fault === 'seal')
                                return async () => {
                                    throw new CaptureStorageError('io', 'Synthetic seal failure.');
                                };
                            const value = Reflect.get(target, key);
                            return typeof value === 'function' ? value.bind(target) : value;
                        },
                    }),
                    rows: AutomationRecord[] = [],
                    states: string[] = [],
                    runner = new FlowRunner(
                        (state) => states.push(state.state),
                        (row) => {
                            rows.push(row);
                        },
                    );
                const plan: AutomationPlan = {
                    transport: 'serial',
                    start: null,
                    timeoutSeconds: 20,
                    repeatSeconds: null,
                    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
                    steps: ['ls', '', '', 'pwd'].map((command, index) => ({
                        id: 'step-' + index,
                        name: command || 'Enter ' + index,
                        command,
                        enterOnly: !command,
                        enabled: true,
                        delaySeconds: 0,
                    })),
                };
                await runner.start(plan, serialCaptureBackend(session, wrapped));
                const captures = (await store.page()).records,
                    hashes: number[] = [];
                for (const capture of captures) {
                    let hash = 2166136261;
                    for await (const event of store.read(capture.id))
                        if (event.type === 'frame')
                            for (const byte of event.frame.bytes)
                                hash = Math.imul(hash ^ byte, 16777619) >>> 0;
                    hashes.push(hash);
                }
                let exported = 0;
                for await (const bytes of streamCaptureReport(store, 'json'))
                    exported += bytes.length;
                const saved = captures.map((capture) => ({
                    state: capture.state,
                    bytes: capture.committedBytes,
                    observed: capture.observedBytes,
                    failure: capture.failure?.code,
                }));
                await session.close();
                await store.close();
                const reopened = await IndexedDbCaptureStore.open(),
                    retained = (await reopened.page()).records.length;
                await reopened.close();
                return {
                    writes: fixture.writes.map((bytes) => new TextDecoder().decode(bytes)),
                    states,
                    saved,
                    hashes,
                    expected,
                    previewClipped: rows[0]?.previewClipped,
                    previewBytes: encode(rows[0]?.stdout ?? '').length,
                    completion: rows[0]?.completion,
                    exported,
                    retained,
                    opens: fixture.opens,
                };
            }, fault);
            expect(result.opens).toBe(1);
            if (fault === 'none') {
                expect(result.writes).toEqual(['ls\r', '\r', '\r', 'pwd\r']);
                expect(result.states.at(-1)).toBe('finished');
                expect(result.hashes).toEqual(result.expected);
                expect(result.saved.every((row) => row.state === 'complete')).toBe(true);
                expect(result.saved[0].bytes).toBeGreaterThan(65536);
                expect(result.previewClipped).toBe(true);
                expect(result.previewBytes).toBeLessThanOrEqual(8192);
                expect(result.retained).toBe(4);
            } else {
                expect(result.writes).toEqual(['ls\r']);
                expect(result.states.at(-1)).toBe('paused');
                expect(result.completion).toBe('storage-error');
                expect(result.saved[0].state).toBe('incomplete');
                expect(result.retained).toBe(1);
                if (fault === 'append') {
                    expect(result.saved[0].failure).toBe('quota');
                    expect(result.saved[0].observed).toBeGreaterThan(result.saved[0].bytes);
                }
            }
            expect(result.exported).toBeGreaterThan(
                result.saved.reduce((bytes, row) => bytes + row.bytes, 0),
            );
        },
    );

for (const mode of ['healthy ticks', 'resume gap'] as const)
    test('persistence watchdog remains live in browser: ' + mode, async ({ page }) => {
        const result = await page.evaluate(async (mode) => {
            const { FlowRunner, deferred } = window.serialCaptureQA,
                gate = deferred(),
                entered = deferred();
            let local = Date.UTC(2026, 9, 15),
                mono = 0,
                watch: (() => void) | undefined,
                calls = 0,
                releases = 0;
            const states: string[] = [],
                clock: RunClock = {
                    local: () => local,
                    mono: () => mono,
                    sleep: async () => {},
                    watch(callback) {
                        watch = callback;
                        return () => {
                            watch = undefined;
                        };
                    },
                },
                runner = new FlowRunner(
                    (state) => states.push(state.state),
                    async () => {
                        if (calls === 1) {
                            entered.resolve();
                            await gate.promise;
                        }
                    },
                    clock,
                ),
                plan: AutomationPlan = {
                    transport: 'serial',
                    start: null,
                    timeoutSeconds: 10,
                    repeatSeconds: null,
                    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
                    steps: ['first', 'second'].map((command) => ({
                        id: command,
                        name: command,
                        command,
                        enabled: true,
                        delaySeconds: 0,
                    })),
                };
            const pending = runner.start(plan, {
                connection: () => 'same',
                available: () => true,
                acquire: () => () => {
                    releases++;
                },
                target: { endpoint: 'synthetic' },
                execute: async () => {
                    calls++;
                    return {
                        stdout: '',
                        stderr: '',
                        exitCode: null,
                        completion: 'prompt-observed',
                        truncated: false,
                        chunks: [],
                    };
                },
            });
            await entered.promise;
            if (mode === 'healthy ticks')
                for (let tick = 0; tick < 40; tick++) {
                    local += 250;
                    mono += 250;
                    watch?.();
                }
            else {
                local += 10000;
                mono += 10000;
            }
            const held = releases === 0 && runner.busy;
            gate.resolve();
            await pending;
            return {
                calls,
                state: states.at(-1),
                held,
                releases,
                watchCleared: watch === undefined,
            };
        }, mode);
        expect(result.held).toBe(true);
        expect(result.calls).toBe(mode === 'healthy ticks' ? 2 : 1);
        expect(result.state).toBe(mode === 'healthy ticks' ? 'finished' : 'paused');
        expect(result.releases).toBe(1);
        expect(result.watchCleared).toBe(true);
    });

test('browser prompt fence drains terminal delivery and old continuation before the next command', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const {
                FlowRunner,
                SerialSession,
                IndexedDbCaptureStore,
                serialCaptureBackend,
                DEFAULT_SERIAL_SETTINGS,
                deferred,
            } = window.serialCaptureQA,
            display = deferred(),
            store = await IndexedDbCaptureStore.open(),
            encode = (value: string) => new TextEncoder().encode(value);
        let input!: ReadableStreamDefaultController<Uint8Array>,
            deliveries = 0;
        const writes: Uint8Array[] = [],
            rows: AutomationRecord[] = [];
        const port: LocalSerialPort = {
                readable: null,
                writable: null,
                async open() {
                    this.readable = new ReadableStream({
                        start(c) {
                            input = c;
                        },
                    });
                    this.writable = new WritableStream({
                        write(bytes) {
                            writes.push(Uint8Array.from(bytes));
                        },
                    });
                },
                async close() {
                    this.readable = null;
                    this.writable = null;
                },
                getInfo: () => ({}),
            },
            session = new SerialSession(async () => {
                if (++deliveries === 1) await display.promise;
            });
        session.select(port, 'synthetic browser drain');
        await session.connect(DEFAULT_SERIAL_SETTINGS);
        const plan: AutomationPlan = {
                transport: 'serial',
                start: null,
                timeoutSeconds: 5,
                repeatSeconds: null,
                serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
                steps: ['first', 'second'].map((command) => ({
                    id: command,
                    name: command,
                    command,
                    enabled: true,
                    delaySeconds: 0,
                })),
            },
            runner = new FlowRunner(
                () => {},
                (row) => {
                    rows.push(row);
                },
            ),
            pending = runner.start(plan, serialCaptureBackend(session, store)),
            until = async (check: () => boolean) => {
                const end = performance.now() + 5000;
                while (!check()) {
                    if (performance.now() > end) throw Error('Browser drain test timed out.');
                    await new Promise((r) => setTimeout(r, 5));
                }
            };
        try {
            await until(() => writes.length === 1);
            input.enqueue(encode('FIRST\r\nboard# '));
            input.enqueue(encode('OLD-CONTINUATION\r\nboard# '));
            await until(() => deliveries === 1);
            await new Promise((r) => setTimeout(r, 350));
            const earlyWrites = writes.length,
                earlyRows = rows.length;
            display.resolve();
            await until(() => writes.length === 2);
            input.enqueue(encode('NEW-RESPONSE\r\nboard# '));
            await pending;
            return {
                earlyWrites,
                earlyRows,
                outputs: rows.map((row) => row.stdout),
                completions: rows.map((row) => row.completion),
            };
        } finally {
            display.resolve();
            runner.cancel();
            await pending;
            await session.close();
            await store.close();
        }
    });
    expect(result.earlyWrites).toBe(1);
    expect(result.earlyRows).toBe(0);
    expect(result.outputs[0]).toContain('OLD-CONTINUATION');
    expect(result.outputs[1]).toBe('NEW-RESPONSE\r\nboard# ');
    expect(result.completions).toEqual(['prompt-observed', 'prompt-observed']);
});

test('browser device-clock provenance ignores unterminated tails on timeout/cancel and preserves a prior complete line', async ({
    page,
}) => {
    const values = await page.evaluate(async () => {
        const {
                FlowRunner,
                SerialSession,
                IndexedDbCaptureStore,
                serialCaptureBackend,
                DEFAULT_SERIAL_SETTINGS,
            } = window.serialCaptureQA,
            store = await IndexedDbCaptureStore.open(),
            values: (string | null)[] = [],
            encode = (value: string) => new TextEncoder().encode(value);
        for (const mode of ['timeout', 'cancel', 'prior', 'split-complete']) {
            let input!: ReadableStreamDefaultController<Uint8Array>,
                sent = false,
                received = false;
            const rows: AutomationRecord[] = [];
            const port: LocalSerialPort = {
                    readable: null,
                    writable: null,
                    async open() {
                        this.readable = new ReadableStream({
                            start(c) {
                                input = c;
                            },
                        });
                        this.writable = new WritableStream({
                            write() {
                                sent = true;
                            },
                        });
                    },
                    async close() {
                        this.readable = null;
                        this.writable = null;
                    },
                    getInfo: () => ({}),
                },
                session = new SerialSession(async () => {
                    received = true;
                });
            session.select(port, 'synthetic clock lines');
            await session.connect(DEFAULT_SERIAL_SETTINGS);
            const prefix = mode === 'split-complete' ? '\u23f1=' : 'CLOCK=',
                plan: AutomationPlan = {
                    transport: 'serial',
                    start: null,
                    timeoutSeconds: 1,
                    repeatSeconds: null,
                    captureDeviceTime: true,
                    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: prefix },
                    steps: [
                        {
                            id: 'clock',
                            name: 'clock',
                            command: 'clock',
                            enabled: true,
                            delaySeconds: 0,
                        },
                    ],
                },
                runner = new FlowRunner(
                    () => {},
                    (row) => {
                        rows.push(row);
                    },
                ),
                pending = runner.start(plan, serialCaptureBackend(session, store));
            while (!sent) await new Promise((r) => setTimeout(r, 5));
            if (mode === 'prior') input.enqueue(encode('CLOCK=2026-10-15T05:00:00.000Z\r\n'));
            const tail = encode(prefix + '2026-10-15T05:00:01.000Z');
            input.enqueue(tail.subarray(0, 1));
            input.enqueue(tail.subarray(1));
            if (mode === 'split-complete') input.enqueue(encode('\nboard# '));
            if (mode === 'cancel') {
                while (!received) await new Promise((r) => setTimeout(r, 5));
                runner.cancel();
            }
            await pending;
            values.push(rows[0].deviceTime?.value ?? null);
            await session.close();
        }
        await store.close();
        return values;
    });
    expect(values).toEqual([null, null, '2026-10-15T05:00:00.000Z', '2026-10-15T05:00:01.000Z']);
});
