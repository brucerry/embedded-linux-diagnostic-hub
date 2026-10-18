import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gatewayFixture } from '../fixtures/gateway';
import { SshSession } from '../../backend/ssh/session';
import { NativeCaptureStore } from '../../electron/capture-store';
import { captureToRepository } from '../../shared/automation-capture';
import { SshStreamClient } from '../../src/features/automation/capture/ssh-stream-client';
import type { CaptureHeader } from '../../shared/capture-store';
const header = (command: string): CaptureHeader => ({
    transport: 'ssh',
    receiveTimeSource: 'local-client',
    runId: 'long-production-test',
    stepId: 'one',
    command,
    name: 'Duplex full-output fixture',
    startedAt: new Date().toISOString(),
    execution: { mode: 'independent-script', intent: 'script', timeoutMs: 90000 },
});

test(
    'production independent stdout/stderr stream retains more than 32 MiB exactly with bounded credit',
    { timeout: 120000 },
    async (t) => {
        let active = 0,
            serverWrites = 0,
            serverBytes = 0,
            clientBytes = 0,
            observations = 0;
        const server = await gatewayFixture(undefined, {
            exec: (command, channel) => {
                if (command !== 'fixture-duplex') return false;
                active++;
                channel.on('close', () => active--);
                channel.on('error', () => {});
                channel.on('end', () => channel.close());
                channel.resume();
                const write = async (stream: NodeJS.WritableStream, bytes: Buffer) => {
                    if (channel.destroyed) return false;
                    return new Promise<boolean>((resolve) => {
                        let settled = false;
                        const done = (ok: boolean) => {
                            if (settled) return;
                            settled = true;
                            channel.off('close', close);
                            if (ok) {
                                serverWrites++;
                                serverBytes += bytes.length;
                            }
                            resolve(ok);
                        };
                        const close = () => done(false);
                        channel.once('close', close);
                        // stdout and stderr have separate Writable queues but share one SSH
                        // window. Join every write callback before exit/EOF, including stderr.
                        stream.write(bytes, (error?: Error | null) =>
                            done(!error && !channel.destroyed),
                        );
                        if (channel.destroyed) close();
                    });
                };
                void (async () => {
                    for (let i = 0; i < 1025 && !channel.destroyed; i++) {
                        if (!(await write(channel, Buffer.alloc(16384, i % 251)))) break;
                        if (!(await write(channel.stderr, Buffer.alloc(16384, (i + 73) % 251))))
                            break;
                    }
                    if (!channel.destroyed) {
                        channel.exit(0);
                        channel.end();
                    }
                })().catch(() => channel.close());
                return true;
            },
        });
        const ssh = new SshSession(),
            temp = path.resolve(os.tmpdir()),
            profile = await fs.mkdtemp(path.join(temp, 'hub-production-duplex-'));
        const store = await NativeCaptureStore.open(profile, { profileOwned: true });
        try {
            await ssh.connect(server.options, async () => true);
            const client = new SshStreamClient(async (input) => {
                const event = await ssh.automationStream(input);
                if ((event as { type?: unknown }).type === 'data') {
                    clientBytes += Number((event as { totalBytes: number }).totalBytes);
                    observations++;
                }
                return event;
            }, 'local-client');
            const result = await captureToRepository(
                store,
                header('fixture-duplex'),
                new AbortController().signal,
                (sink, signal) =>
                    client.execute(
                        {
                            id: 'production-duplex-01',
                            connection: ssh.automationConnection,
                            command: 'fixture-duplex',
                            timeoutMs: 90000,
                        },
                        sink,
                        signal,
                    ),
            );
            t.diagnostic(
                JSON.stringify({
                    serverWrites,
                    serverBytes,
                    clientBytes,
                    observations,
                    stored: result.stored.committedBytes,
                    completion: result.completion,
                }),
            );
            assert.equal(result.completion, 'exit');
            assert.equal(result.stored.committedBytes, 33587200);
            assert.equal(result.stored.state, 'complete');
            const actual = {
                    stdout: crypto.createHash('sha256'),
                    stderr: crypto.createHash('sha256'),
                },
                expected = {
                    stdout: crypto.createHash('sha256'),
                    stderr: crypto.createHash('sha256'),
                };
            for (let i = 0; i < 1025; i++) {
                expected.stdout.update(Buffer.alloc(16384, i % 251));
                expected.stderr.update(Buffer.alloc(16384, (i + 73) % 251));
            }
            for await (const item of store.read(result.stored.id))
                if (item.type === 'frame') {
                    assert.ok(item.frame.bytes.length <= 16384);
                    assert.ok(item.frame.stream === 'stdout' || item.frame.stream === 'stderr');
                    actual[item.frame.stream as 'stdout' | 'stderr'].update(item.frame.bytes);
                }
            assert.equal(actual.stdout.digest('hex'), expected.stdout.digest('hex'));
            assert.equal(actual.stderr.digest('hex'), expected.stderr.digest('hex'));
            await client.finalize();
            assert.equal(active, 0);
            assert.equal(ssh.isConnected, true);
        } finally {
            ssh.disconnect();
            await store.close();
            await server.close();
            assert.ok(
                path.resolve(profile).startsWith(temp + path.sep) &&
                    path.basename(profile).startsWith('hub-production-duplex-'),
            );
            await fs.rm(profile, { recursive: true, force: true });
        }
    },
);
