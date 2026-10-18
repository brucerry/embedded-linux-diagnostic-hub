import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeCaptureStore } from '../../electron/capture-store';
import { CaptureWriter } from '../../shared/capture-writer';
import { streamCaptureReport } from '../../shared/capture-report';

async function main() {
    if (!global.gc) throw Error('Run this qualification with node --expose-gc --import tsx.');
    const temp = path.resolve(os.tmpdir()),
        profile = await fs.mkdtemp(path.join(temp, 'hub-capture-memory-'));
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    const samples: {
        stage: string;
        logicalBytes: number;
        heapUsed: number;
        arrayBuffers: number;
        external: number;
    }[] = [];
    const sample = async (stage: string, logicalBytes: number) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        global.gc!();
        global.gc!();
        const { heapUsed, arrayBuffers, external } = process.memoryUsage();
        samples.push({ stage, logicalBytes, heapUsed, arrayBuffers, external });
    };
    try {
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'heap',
            stepId: 'one',
            command: 'generated fixture',
            name: 'Memory qualification',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        const block = new Uint8Array(16384);
        for (let i = 0; i < block.length; i++) block[i] = i % 251;
        let maxBacklog = 0;
        for (let index = 0; index < 4096; index++) {
            await writer.append(block, '2026-10-15T00:00:00.000Z', 'serial');
            maxBacklog = Math.max(maxBacklog, writer.backlogBytes);
            if (index === 511 || index === 2047) {
                await writer.flush();
                await sample('capture', (index + 1) * block.length);
            }
        }
        const capture = await writer.finish('prompt-observed');
        await sample('capture', capture.committedBytes);
        let exported = 0,
            nextSample = 16 * 1024 * 1024,
            maxChunk = 0;
        for await (const chunk of streamCaptureReport(store, 'json')) {
            exported += chunk.length;
            maxChunk = Math.max(maxChunk, chunk.length);
            if (exported >= nextSample) {
                await sample('export', exported);
                nextSample += 16 * 1024 * 1024;
            }
        }
        await sample('export-finished', exported);
        const baseline = samples[0].heapUsed,
            maxRetained = Math.max(...samples.map((s) => s.heapUsed));
        assert.ok(
            maxRetained - baseline < 8 * 1024 * 1024,
            'Retained JS heap grew with total captured/exported output.',
        );
        assert.ok(
            Math.max(...samples.map((s) => s.arrayBuffers)) - samples[0].arrayBuffers <
                2 * 1024 * 1024,
            'Retained byte buffers grew with total output.',
        );
        assert.ok(maxBacklog <= 256 * 1024);
        assert.ok(maxChunk <= 65536);
        assert.equal(capture.committedBytes, 64 * 1024 * 1024);
        console.log(
            JSON.stringify({
                platform: process.platform,
                node: process.version,
                capturedBytes: capture.committedBytes,
                exportedBytes: exported,
                maxBacklog,
                maxChunk,
                heapGrowthBytes: maxRetained - baseline,
                samples,
                qualification:
                    'Retained JS heap after forced GC, native Node fixture; not OS page cache or native Electron/browser heap qualification',
            }),
        );
    } finally {
        await store.close();
        const resolved = path.resolve(profile);
        assert.ok(
            resolved.startsWith(temp + path.sep) &&
                path.basename(resolved).startsWith('hub-capture-memory-'),
        );
        await fs.rm(resolved, { recursive: true, force: true });
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
