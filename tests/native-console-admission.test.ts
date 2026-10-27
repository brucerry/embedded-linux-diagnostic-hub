import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeConsoleService } from '../electron/console-service';
import { NativeConsoleJournal } from '../electron/console-journal';
import { SshSession } from '../backend/ssh/session';
import { SshConsoleClient } from '../src/features/automation/capture/ssh-console-client';
import { gatewayFixture } from './fixtures/gateway';
import { consoleFixture } from './fixtures/ssh-console';
import { bytesBase64 } from '../shared/capture-store';
import type { ConsoleRpc } from '../shared/console-rpc';
import type { ConsoleSegment } from '../shared/console-journal';
import { randomUUID } from 'node:crypto';

test(
    'native writer refuses an unsettled catalog, then admits only after that exact reference returns',
    { timeout: 10000 },
    async (t) => {
        const profile = await fs.mkdtemp(
            path.join(await fs.realpath(os.tmpdir()), 'hub-native-admission-'),
        );
        const service = new NativeConsoleService(profile);
        const original = NativeConsoleJournal.prototype.list;
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const reached = new Promise<void>((resolve) => (entered = resolve));
        const rows: unknown[] = [];
        NativeConsoleJournal.prototype.list = async function (after, limit) {
            const result = await original.call(this, after, limit);
            entered();
            await gate;
            return result;
        };
        const request = service.dispatch({ op: 'list', limit: 25 });
        void request.catch(() => {});
        try {
            await reached;
            rows.push({
                event: 'catalog-return-pending',
                at: performance.now(),
                ...service.snapshot,
            });

            assert.equal(service.snapshot.references, 1);
            assert.equal(service.snapshot.requests, 1);
            assert.equal(service.snapshot.writer, false);
            assert.equal(service.snapshot.transition, false);
            await assert.rejects(service.createWriter(), { code: 'busy' });
            rows.push({ event: 'writer-refused', at: performance.now(), ...service.snapshot });
            release();
            await request;
            rows.push({ event: 'catalog-settled', at: performance.now(), ...service.snapshot });
            assert.equal(service.snapshot.references, 0);
            assert.equal(service.snapshot.requests, 0);
            const pin = (await service.dispatch({ op: 'pin' })) as { handle: string };
            rows.push({ event: 'export-pin-owned', at: performance.now(), ...service.snapshot });
            await assert.rejects(service.createWriter(), { code: 'busy' });
            assert.equal(service.snapshot.pins, 1);
            await service.dispatch({ op: 'unpin', handle: pin.handle });
            rows.push({ event: 'export-pin-returned', at: performance.now(), ...service.snapshot });
            const writer = await service.createWriter();
            rows.push({ event: 'writer-admitted', at: performance.now(), ...service.snapshot });
            assert.equal(service.snapshot.writer, true);
            await writer.close();
            t.diagnostic(JSON.stringify(rows));
        } finally {
            release();
            await request.catch(() => {});
            NativeConsoleJournal.prototype.list = original;
            await service.shutdown();
            assert.equal(service.hasResources, false);
            t.diagnostic(
                JSON.stringify({
                    retainedTestProfile: profile,
                    hasResources: service.hasResources,
                }),
            );
        }
    },
);

test(
    'native timeout retirement precedes catalog settlement and a distinct corrected writer',
    { timeout: 15000 },
    async (t) => {
        const profile = await fs.mkdtemp(
            path.join(await fs.realpath(os.tmpdir()), 'hub-native-rearm-'),
        );
        const service = new NativeConsoleService(profile),
            session = new SshSession(),
            model = consoleFixture({ fragment: 4 });
        let server: Awaited<ReturnType<typeof gatewayFixture>> | undefined;
        const clients: SshConsoleClient[] = [],
            rows: unknown[] = [];
        const record = (event: string, extra: object = {}) =>
            rows.push({ event, at: performance.now(), ...service.snapshot, ...extra });
        const ready = { role: 'shell-prompt' as const, literals: ['fixture:/root# '] };
        const oldId = randomUUID().replaceAll('-', ''),
            newId = randomUUID().replaceAll('-', '');
        let openingId = oldId;
        const rpc: ConsoleRpc = async (request) => {
            if (request.action === 'open') openingId = request.id;
            const result = await session.automationConsole(request, 'local-client', async () => {
                record('writer-request', { flowId: openingId });
                const writer = await service.createWriter();
                record('writer-admitted', { flowId: openingId });
                return writer;
            });
            if (request.action === 'finish') {
                const status = result as {
                    phase: string;
                    ownerHeld: boolean;
                    cleanup: unknown;
                };
                record('finish-return', {
                    flowId: request.id,
                    phase: status.phase,
                    ownerHeld: status.ownerHeld,
                    cleanup: status.cleanup,
                });
            } else if (request.action === 'release') {
                assert.deepEqual(result, { ok: true });
                record('release-return', { flowId: request.id });
            }
            return result;
        };
        const segment = (
            input: 'script' | 'send-enter',
            corrected = false,
        ): Extract<ConsoleSegment, { kind: 'command' }> => ({
            kind: 'command',
            runId: 'native-admission-regression',
            stepId: input,
            ordinal: input === 'script' ? 1 : 2,
            name: input,
            input: {
                intent: input,
                command: input === 'script' ? 'confirm-fixture' : '',
            },
            requestBase64: bytesBase64(
                Buffer.from(input === 'script' ? 'confirm-fixture\r' : '\r'),
            ),
            criterion: corrected
                ? {
                      role: 'intermediate-input-prompt',
                      literals: ['Proceed fixture [Enter]? '],
                  }
                : ready,
        });
        try {
            server = await gatewayFixture(undefined, model);
            await session.connect(server.options, async (key) => key === server!.pinned);
            const connection = session.automationConnection;
            const first = new SshConsoleClient(rpc, 'local-client');
            clients.push(first);
            await first.open(connection, oldId, ready, 2500, () => {});
            await assert.rejects(
                first.step(segment('script'), 1000, () => {}),
                /timeout/,
            );
            await assert.rejects(first.close(), /timeout/);
            assert.equal(first.resourceSnapshot.journalClosure, 'acknowledged');
            assert.equal(first.resourceSnapshot.localCleanupClosed, true);
            assert.equal(service.snapshot.closed, true);
            assert.equal(session.consoleProtocolSnapshot, null);
            record('first-retired', { flowId: oldId, capture: first.snapshot });
            const catalog = (await service.dispatch({ op: 'list', limit: 25 })) as {
                captures: unknown[];
            };
            assert.equal(catalog.captures.length, 1);
            record('catalog-return');
            const second = new SshConsoleClient(rpc, 'local-client');
            clients.push(second);
            await second.open(connection, newId, ready, 2500, () => {});
            const prompt = await second.step(segment('script', true), 2000, () => {});
            const enter = await second.step(segment('send-enter'), 2000, () => {});
            assert.equal(prompt.exitCode, null);
            assert.equal(enter.exitCode, null);
            await second.close('complete');
            assert.equal(second.resourceSnapshot.journalClosure, 'acknowledged');
            assert.equal(second.resourceSnapshot.localCleanupClosed, true);
            assert.equal(session.consoleProtocolSnapshot, null);
            assert.deepEqual(
                Buffer.concat(model.state.inputs),
                Buffer.from('confirm-fixture\rconfirm-fixture\r\r'),
            );
            assert.equal(model.state.confirmations, 1);
            const retired = (rows as any[]).findIndex(
                (r) => r.event === 'release-return' && r.flowId === oldId,
            );
            const admitted = (rows as any[]).findIndex(
                (r) => r.event === 'writer-admitted' && r.flowId === newId,
            );
            assert.ok(retired >= 0 && admitted > retired);
            t.diagnostic(JSON.stringify({ retainedTestProfile: profile, rows }));
        } finally {
            for (const client of clients) await client.close().catch(() => {});
            session.disconnect();
            await session.joinAutomationCleanup();
            await server?.close();
            await service.shutdown();
            assert.equal(service.hasResources, false);
        }
    },
);
