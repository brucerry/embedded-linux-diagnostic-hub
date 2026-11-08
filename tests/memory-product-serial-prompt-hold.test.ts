import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import type { installProductSerial } from './fixtures/memory-product-serial';

function isolatedFixture(): ReturnType<typeof installProductSerial> {
    const source = fs.readFileSync(
        new URL('./fixtures/memory-product-serial.ts', import.meta.url),
        'utf8',
    );
    const module = { exports: {} as { installProductSerial: typeof installProductSerial } };
    vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
        module,
        exports: module.exports,
        navigator: {},
        ReadableStream,
        WritableStream,
        EventTarget,
        Event,
        TextEncoder,
        setTimeout,
        clearTimeout,
    });
    return module.exports.installProductSerial();
}

async function connectedFixture(
    config: Parameters<ReturnType<typeof installProductSerial>['configure']>[0],
) {
    const fixture = isolatedFixture();
    fixture.configure(config);
    await fixture.port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 65536,
    });
    const reader = fixture.port.readable!.getReader();
    const writer = fixture.port.writable!.getWriter();
    return {
        fixture,
        reader,
        writer,
        async close() {
            fixture.releaseOutput();
            await reader.cancel();
            reader.releaseLock();
            await writer.close();
            writer.releaseLock();
            await fixture.port.close();
            const snapshot = fixture.snapshot();
            assert.equal(snapshot.readerActive, false);
            assert.equal(snapshot.writerActive, false);
            assert.equal(snapshot.pumping, false);
            assert.equal(snapshot.closes, 1);
        },
    };
}

test(
    'prompt-only hold emits every payload byte and withholds only the prompt until release',
    { timeout: 5000 },
    async () => {
        const connected = await connectedFixture({
            bytes: 64,
            chunkBytes: 17,
            stall: false,
            holdPrompt: true,
        });
        const { fixture, reader, writer } = connected;
        try {
            await writer.write(new TextEncoder().encode('probe\r'));
            let bytes = 0;
            while (bytes < 64) {
                const block = await reader.read();
                assert.equal(block.done, false);
                assert.ok(block.value!.every((value) => value === 120));
                bytes += block.value!.length;
            }
            assert.equal(bytes, 64);
            const held = fixture.snapshot();
            assert.equal(held.produced, 64);
            assert.equal(held.remaining, 0);
            assert.equal(held.promptPending, true);
            assert.equal(held.promptHeld, true);
            assert.equal(held.stalled, false);
            let settled = false;
            const promptRead = reader.read().then((value) => {
                settled = true;
                return value;
            });
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(
                settled,
                false,
                'Prompt must stay pending without a timer or extra dispatch.',
            );
            assert.equal(fixture.snapshot().writes, 1);
            fixture.releaseOutput();
            const prompt = await promptRead;
            assert.equal(new TextDecoder().decode(prompt.value), '\r\nqualification# ');
            assert.equal(fixture.snapshot().promptPending, false);
            assert.equal(fixture.snapshot().promptHeld, false);
        } finally {
            await connected.close();
        }
    },
);

test(
    'the existing whole-response stall still withholds payload and prompt',
    { timeout: 5000 },
    async () => {
        const connected = await connectedFixture({
            bytes: 64,
            chunkBytes: 64,
            stall: true,
            holdPrompt: false,
        });
        const { fixture, reader, writer } = connected;
        try {
            await writer.write(new Uint8Array([13]));
            let settled = false;
            const payloadRead = reader.read().then((value) => {
                settled = true;
                return value;
            });
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(settled, false);
            assert.equal(fixture.snapshot().produced, 0);
            assert.equal(fixture.snapshot().remaining, 64);
            assert.equal(fixture.snapshot().stalled, true);
            assert.equal(fixture.snapshot().promptHeld, false);
            fixture.releaseOutput();
            const payload = await payloadRead;
            assert.equal(payload.value!.length, 64);
            assert.ok(payload.value!.every((value) => value === 120));
            const prompt = await reader.read();
            assert.equal(new TextDecoder().decode(prompt.value), '\r\nqualification# ');
            assert.equal(fixture.snapshot().writes, 1);
        } finally {
            await connected.close();
        }
    },
);

test(
    'cancel while only the prompt is held joins streams without emitting the held prompt',
    { timeout: 5000 },
    async () => {
        const connected = await connectedFixture({
            bytes: 64,
            chunkBytes: 64,
            stall: false,
            holdPrompt: true,
        });
        const { fixture, reader, writer } = connected;
        try {
            await writer.write(new Uint8Array([13]));
            assert.equal((await reader.read()).value!.length, 64);
            await reader.cancel();
            assert.equal(fixture.snapshot().promptPending, false);
            assert.equal(fixture.snapshot().produced, 64);
            fixture.releaseOutput();
            await Promise.resolve();
            assert.equal(fixture.snapshot().produced, 64);
        } finally {
            await connected.close();
        }
    },
);
