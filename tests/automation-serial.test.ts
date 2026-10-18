import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialSession } from '../src/features/serial/session';
import { DEFAULT_SERIAL_SETTINGS, type LocalSerialPort } from '../shared/serial';
import {
    AUTOMATION_LIMITS,
    serialPayload,
    bytesBase64,
    type AutomationPlan,
    type AutomationRecord,
} from '../shared/automation';
import { FlowRunner } from '../src/features/automation/runner';
function fixture() {
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const writes: Uint8Array[] = [],
        port: LocalSerialPort = {
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
                        writes.push(bytes);
                    },
                });
            },
            async close() {
                this.readable = null;
                this.writable = null;
            },
            getInfo: () => ({}),
        };
    return {
        port,
        writes,
        push(text: string) {
            input.enqueue(new TextEncoder().encode(text));
        },
        pushBytes(bytes: Uint8Array) {
            input.enqueue(bytes);
        },
    };
}
const tick = () => new Promise((r) => setImmediate(r));
async function waitForWrite(f: ReturnType<typeof fixture>, count: number) {
    for (let attempt = 0; attempt < 200 && f.writes.length < count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.writes.length, count);
    await tick();
}

for (const widths of [[100000], [1], [3], [1, 17, 2, 5, 31, 3]]) {
    test(`Serial prompt and exact UTF-8/ANSI output are independent of read widths ${widths}`, async () => {
        const f = fixture(),
            session = new SerialSession(async () => {});
        session.select(f.port, 'synthetic');
        await session.connect(DEFAULT_SERIAL_SETTINGS);
        const release = session.acquireAutomation();
        try {
            const pending = session.runAutomation(
                serialPayload('ls', 'CR'),
                'board# ',
                2000,
                new AbortController().signal,
            );
            await waitForWrite(f, 1);
            const text =
                    'x'.repeat(1023) +
                    '€ 設備\r\n\x1b[32m' +
                    'file\r\n'.repeat(30) +
                    '\x1b[0mboard# ',
                bytes = new TextEncoder().encode(text);
            for (let offset = 0, index = 0; offset < bytes.length; index++) {
                const end = Math.min(bytes.length, offset + widths[index % widths.length]);
                f.pushBytes(bytes.slice(offset, end));
                offset = end;
            }
            const result = await pending;
            assert.equal(result.completion, 'prompt-observed');
            assert.equal(result.stdout, text);
            assert.equal(result.exitCode, null);
            assert.equal(result.truncated, false);
            assert.deepEqual(
                Buffer.concat(result.chunks.map((c) => Buffer.from(c.base64, 'base64'))),
                Buffer.from(bytes),
            );
            assert.equal(result.chunks.length, Math.ceil(bytes.length / 1024));
            assert.equal(session.current.state, 'connected');
            assert.ok(result.chunks.every((c) => c.aggregation?.kind === 'serial-byte-block-v1'));
        } finally {
            release();
            await session.close();
        }
    });
}
const serialPlan = (steps: AutomationPlan['steps']): AutomationPlan => ({
    transport: 'serial',
    steps,
    timeoutSeconds: 1,
    repeatSeconds: null,
    start: null,
    serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
});
const steps = [
    { id: 'first', name: 'ls', enabled: true, command: 'ls', delaySeconds: 0 },
    { id: 'enter', name: 'Enter', enabled: true, command: '', enterOnly: true, delaySeconds: 0 },
    {
        id: 'enter2',
        name: 'Enter again',
        enabled: true,
        command: '',
        enterOnly: true,
        delaySeconds: 0,
    },
    { id: 'last', name: 'pwd', enabled: true, command: 'pwd', delaySeconds: 0 },
];
test('one connected Serial session supports repeated successful flows and further arms with fresh captures', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {}),
        records: AutomationRecord[] = [];
    let opens = 0,
        closes = 0;
    const open = f.port.open.bind(f.port),
        close = f.port.close.bind(f.port);
    f.port.open = async (settings) => {
        opens++;
        await open(settings);
    };
    f.port.close = async () => {
        closes++;
        await close();
    };
    session.select(f.port, 'synthetic repeated UART');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const generation = session.current.generation;
    const runner = new FlowRunner(
        () => {},
        (row) => records.push(row),
    );
    const prompt = 'root@Sunstreaker:/# ',
        coloredPrompt = '\x1b[1;32mroot@Sunstreaker\x1b[0m:/# ';
    try {
        for (let run = 0; run < 9; run++) {
            const plan = serialPlan([
                { id: 'pwd', name: 'pwd', enabled: true, command: 'pwd', delaySeconds: 0 },
                { id: 'ls', name: 'ls', enabled: true, command: 'ls', delaySeconds: 0 },
            ]);
            plan.serial.prompt = prompt;
            const expected: string[] = [];
            await runner.start(plan, {
                connection: () => 'same-connected-generation',
                available: () => session.current.state === 'connected',
                acquire: () => session.acquireAutomation(),
                target: { endpoint: 'synthetic' },
                execute: async (step, _plan, signal) => {
                    const ordinal = f.writes.length + 1;
                    const pending = session.runAutomation(
                        serialPayload(step.command, 'CR'),
                        prompt,
                        2000,
                        signal,
                    );
                    await waitForWrite(f, ordinal);
                    const response =
                        (step.command === 'pwd'
                            ? '/\r\n'
                            : '\x1b[34m' + `file-run-${run}\r\n`.repeat(24) + '\x1b[0m') +
                        coloredPrompt;
                    expected.push(response);
                    for (const byte of new TextEncoder().encode(response))
                        f.pushBytes(new Uint8Array([byte]));
                    return pending;
                },
            });
            const current = records.slice(-2);
            assert.deepEqual(
                current.map((row) => row.stdout),
                expected,
            );
            current.forEach((row) => {
                assert.equal(row.completion, 'prompt-observed');
                assert.equal(row.truncated, false);
                assert.equal(row.chunks.length, 1);
                assert.equal(
                    row.chunks[0].aggregation!.contributingReads,
                    new TextEncoder().encode(row.stdout).length,
                );
                assert.deepEqual(
                    Buffer.concat(row.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64'))),
                    Buffer.from(row.stdout),
                );
            });
            assert.equal(session.automationActive, false);
            assert.equal(runner.busy, false);
            assert.equal(session.current.state, 'connected');
            assert.equal(session.current.generation, generation);
            assert.equal(opens, 1);
            assert.equal(closes, 0);
        }
        assert.equal(records.length, 18);
        assert.equal(new Set(records.map((row) => row.runId)).size, 9);
        assert.equal(f.writes.length, 18);
    } finally {
        await session.close();
        assert.equal(closes, 1);
    }
});
test('one owned Serial flow sends script/Enter/Enter/script with fresh captures and no stale-prompt advancement', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {}),
        records: AutomationRecord[] = [];
    session.select(f.port, 'synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    f.push('old board# ');
    await tick();
    const runner = new FlowRunner(
        () => {},
        (r) => records.push(r),
    );
    try {
        await runner.start(serialPlan(steps), {
            connection: () => 'synthetic-generation',
            available: () => session.current.state === 'connected',
            acquire: () => session.acquireAutomation(),
            target: { endpoint: 'synthetic' },
            receiveTimeSource: 'local-client',
            execute: async (step, plan, signal) => {
                const ordinal = f.writes.length + 1,
                    bytes = serialPayload(step.command, plan.serial.lineEnding),
                    pending = session.runAutomation(bytes, plan.serial.prompt, 1000, signal);
                await waitForWrite(f, ordinal);
                assert.throws(() => session.send(new Uint8Array([1])), /owned/);
                if (step.enterOnly) {
                    let done = false;
                    void pending.then(() => {
                        done = true;
                    });
                    await new Promise((resolve) => setTimeout(resolve, 220));
                    assert.equal(
                        done,
                        false,
                        'Prior prompt must never complete a fresh Enter capture',
                    );
                }
                const response = step.name + '\r\nboard# ';
                for (const byte of new TextEncoder().encode(response))
                    f.pushBytes(new Uint8Array([byte]));
                return { ...(await pending), requestBytes: bytesBase64(bytes) };
            },
        });
        assert.deepEqual(
            f.writes.map((b) => new TextDecoder().decode(b)),
            ['ls\r', '\r', '\r', 'pwd\r'],
        );
        assert.equal(records.length, 4);
        records.forEach((r, index) => {
            assert.equal(r.completion, 'prompt-observed');
            assert.equal(r.stdout, steps[index].name + '\r\nboard# ');
            assert.equal(r.chunks.length, 1);
            assert.equal(
                r.chunks[0].aggregation!.contributingReads,
                new TextEncoder().encode(r.stdout).length,
            );
        });
    } finally {
        await session.close();
    }
});
for (const stop of [
    'overflow',
    'wrong-prompt',
    'missing-prompt',
    'incomplete-escape',
    'incomplete-utf8',
    'cancel',
] as const) {
    test(`Serial ${stop} stops the flow before any subsequent Enter or script`, async () => {
        const f = fixture(),
            session = new SerialSession(async () => {}),
            records: AutomationRecord[] = [];
        session.select(f.port, 'synthetic');
        await session.connect(DEFAULT_SERIAL_SETTINGS);
        const runner = new FlowRunner(
            () => {},
            (r) => records.push(r),
        );
        try {
            await runner.start(serialPlan(steps), {
                connection: () => 'synthetic-generation',
                available: () => session.current.state === 'connected',
                acquire: () => session.acquireAutomation(),
                target: { endpoint: 'synthetic' },
                execute: async (step, plan, signal) => {
                    const pending = session.runAutomation(
                        serialPayload(step.command, 'CR'),
                        plan.serial.prompt,
                        1000,
                        signal,
                    );
                    await waitForWrite(f, 1);
                    if (stop === 'overflow')
                        f.push('x'.repeat(AUTOMATION_LIMITS.outputBytes - 7) + 'board# !');
                    else if (stop === 'wrong-prompt') f.push('different# ');
                    else if (stop === 'incomplete-escape') f.push('board# \x1b[');
                    else if (stop === 'incomplete-utf8')
                        f.pushBytes(
                            new Uint8Array([...new TextEncoder().encode('board# '), 0xe2, 0x82]),
                        );
                    else if (stop === 'cancel') {
                        f.push('partial\x1b[');
                        await tick();
                        runner.cancel();
                    }
                    return pending;
                },
            });
            assert.equal(f.writes.length, 1);
            assert.equal(records.length, 1);
            assert.equal(
                records[0].completion,
                stop === 'overflow' ? 'output-limit' : stop === 'cancel' ? 'cancelled' : 'timeout',
            );
            assert.equal(records[0].exitCode, null);
            assert.equal(records[0].truncated, stop === 'overflow');
            if (stop === 'cancel') assert.equal(records[0].stdout, 'partial\x1b[');
            if (stop === 'overflow') {
                assert.equal(records[0].chunks.length, 64);
                assert.equal(
                    Buffer.concat(records[0].chunks.map((c) => Buffer.from(c.base64, 'base64')))
                        .length,
                    65536,
                );
            }
        } finally {
            await session.close();
        }
    });
}
test('a non-ASCII literal prompt completes only after all fragmented UTF-8 bytes arrive', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const release = session.acquireAutomation();
    try {
        const prompt = '設備# 🟢';
        const pending = session.runAutomation(
            serialPayload('ls', 'CR'),
            prompt,
            1500,
            new AbortController().signal,
        );
        await waitForWrite(f, 1);
        for (const byte of new TextEncoder().encode(prompt)) f.pushBytes(new Uint8Array([byte]));
        assert.equal((await pending).completion, 'prompt-observed');
    } finally {
        release();
        await session.close();
    }
});
test('exact 64-KiB response with a complete prompt succeeds without truncation', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const release = session.acquireAutomation();
    try {
        const pending = session.runAutomation(
            serialPayload('ls', 'CR'),
            'board# ',
            2000,
            new AbortController().signal,
        );
        await waitForWrite(f, 1);
        f.push('x'.repeat(65536 - 7) + 'board# ');
        const result = await pending;
        assert.equal(result.completion, 'prompt-observed');
        assert.equal(result.truncated, false);
        assert.equal(result.chunks.length, 64);
        assert.equal(
            Buffer.concat(result.chunks.map((c) => Buffer.from(c.base64, 'base64'))).length,
            65536,
        );
    } finally {
        release();
        await session.close();
    }
});

test('one-byte read fragmentation retains the complete small ANSI listing and observes its prompt', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'synthetic fragmented UART');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const release = session.acquireAutomation();
    try {
        const pending = session.runAutomation(
            new TextEncoder().encode('ls\r'),
            'board# ',
            1500,
            new AbortController().signal,
        );
        for (let count = 0; count < 100 && !f.writes.length; count++)
            await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(f.writes.length, 1);
        const bytes = new TextEncoder().encode(
            '\x1b[32m' + 'file entry\r\n'.repeat(31) + '\x1b[0mboard# ',
        );
        for (const value of bytes) f.pushBytes(new Uint8Array([value]));
        const result = await pending;
        assert.equal(result.completion, 'prompt-observed');
        assert.deepEqual(
            Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64'))),
            Buffer.from(bytes),
        );
    } finally {
        release();
        await session.close();
    }
});
test('Serial automation owns input, ignores prior app buffer and captures split ANSI prompt/raw payload', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'COM synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    f.push('old-console# ');
    await tick();
    const release = session.acquireAutomation();
    assert.throws(() => session.send(new Uint8Array([1])), /owned/);
    const pending = session.runAutomation(
        new TextEncoder().encode('two\nlines\r'),
        'console# ',
        1000,
        new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 130));
    assert.equal(Buffer.concat(f.writes).toString(), 'two\nlines\r');
    f.push('reply €\n\x1b[');
    f.push('32mcon');
    f.push('sole# ');
    const result = await pending;
    assert.equal(result.completion, 'prompt-observed');
    assert.equal(result.exitCode, null);
    assert.doesNotMatch(result.stdout, /old-console/);
    assert.ok(result.stdout.includes('reply €'));
    assert.equal(
        Buffer.concat(result.chunks.map((c) => Buffer.from(c.base64, 'base64'))).toString(),
        result.stdout,
    );
    release();
    session.send(new TextEncoder().encode('interactive'));
    await tick();
    assert.ok(Buffer.concat(f.writes).toString().endsWith('interactive'));
    await session.close();
});
test('Serial timeout/cancel and disconnect never claim exit or send helper payloads', async () => {
    const f = fixture(),
        session = new SerialSession(async () => {});
    session.select(f.port, 'synthetic');
    await session.connect(DEFAULT_SERIAL_SETTINGS);
    const release = session.acquireAutomation();
    const result = await session.runAutomation(
        new TextEncoder().encode('one'),
        '# ',
        40,
        new AbortController().signal,
    );
    assert.equal(result.completion, 'timeout');
    assert.equal(result.exitCode, null);
    const abort = new AbortController(),
        pending = session.runAutomation(new TextEncoder().encode('two'), '# ', 1000, abort.signal);
    await tick();
    abort.abort();
    assert.equal((await pending).completion, 'cancelled');
    assert.equal(Buffer.concat(f.writes).toString(), 'onetwo');
    release();
    await session.close();
});
