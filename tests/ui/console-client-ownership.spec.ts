import { test, expect } from '@playwright/test';
import type {} from '../fixtures/console-browser';

test('a retired receipt automatically closes actual IndexedDB ownership and preserves the incomplete prefix', async ({
    page,
}) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const fixtureSource = '/tests/fixtures/console-browser.ts';
        await import(fixtureSource);
        const clientSource = '/src/features/automation/capture/ssh-console-client.ts';
        const { SshConsoleClient } = (await import(
            clientSource
        )) as typeof import('../../src/features/automation/capture/ssh-console-client');
        const q = window.consoleQA,
            name = q.name(),
            journal = await q.IndexedDbConsoleJournal.open(name);
        const owner = {
            id: 'browser-retired-flow-001',
            connection: 'browser-connection-001',
            capability: 'a'.repeat(64),
        };
        const ready = { role: 'shell-prompt' as const, literals: ['fixture# '] };
        const capture = await journal.begin({
            ...q.header,
            flowId: owner.id,
            receiveTimeSource: 'gateway',
            ready,
        });
        await journal.start({ kind: 'context', phase: 'startup' }, q.stamp);
        await journal.observe(new TextEncoder().encode('fixture# '), q.stamp, 'channel');
        await journal.end('ready', { role: 'shell-prompt', literal: 'fixture# ' }, q.stamp);
        let reads = 0,
            release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const client = new SshConsoleClient(
            async (request) => {
                if (request.action === 'capabilities')
                    return {
                        protocol: 1,
                        persistentConsole: 1,
                        independentStream: 1,
                        epoch: 'b'.repeat(32),
                        receiveTimeSource: 'gateway',
                        journal: 'browser-v2',
                        heartbeat: { intervalMs: 500, stallMs: 2500 },
                    };
                if (request.action === 'open') return { protocol: 1, ...owner };
                if (request.action === 'read') {
                    if (++reads === 1)
                        return {
                            protocol: 1,
                            type: 'state',
                            id: owner.id,
                            revision: 1,
                            phase: 'ready',
                            error: null,
                            snapshot: journal.snapshot,
                            ownerHeld: true,
                            cleanup: { storageAdapterClosed: false, journalClosure: 'pending' },
                        };
                    await gate;
                    return {
                        protocol: 1,
                        type: 'state',
                        id: owner.id,
                        revision: 2,
                        phase: 'closed',
                        error: 'Retired owner; remote journal closure is unacknowledged.',
                        snapshot: journal.snapshot,
                        ownerHeld: false,
                        cleanup: { storageAdapterClosed: true, journalClosure: 'unacknowledged' },
                    };
                }
                if (request.action === 'heartbeat') return { ok: true };
                throw Error('Automatic failure cleanup must not need finish/release.');
            },
            'gateway',
            journal,
        );
        let archive: typeof journal | undefined;
        try {
            await client.open(owner.connection, owner.id, ready, 1000, () => {});
            release();
            const end = performance.now() + 2500;
            while (client.resourceSnapshot.pump) {
                if (performance.now() >= end)
                    throw Error('Automatic browser cleanup did not settle.');
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            const withoutExplicitClose = {
                client: client.resourceSnapshot,
                closed: journal.resourceClosed,
                snapshot: journal.snapshot,
            };
            archive = await q.IndexedDbConsoleJournal.open(name);
            const events = await q.read(archive, capture.header.id);
            const metadata = events.find((event) => event.kind === 'metadata');
            const bytes = events.flatMap((event) =>
                event.kind === 'record' && event.record.kind === 'observation'
                    ? [...q.base64Bytes(event.record.base64)]
                    : [],
            );
            await archive.close();
            archive = undefined;
            const locks = await navigator.locks.query();
            const ownedLocks = [...(locks.held ?? []), ...(locks.pending ?? [])].filter((lock) =>
                lock.name?.startsWith(name),
            );
            // Successful deletion also proves no retained DB connection blocks the close.
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
                request.onblocked = () =>
                    reject(Error('Closed browser journal retained an IndexedDB connection.'));
            });
            return {
                withoutExplicitClose,
                metadata,
                text: new TextDecoder().decode(Uint8Array.from(bytes)),
                ownedLocks,
            };
        } finally {
            release();
            await client.close().catch(() => {});
            await archive?.close();
            await journal.close();
        }
    });
    expect(result.withoutExplicitClose.closed).toBe(true);
    expect(result.withoutExplicitClose.client.localCleanupClosed).toBe(true);
    expect(result.withoutExplicitClose.client.journalClosure).toBe('unacknowledged');
    expect(result.withoutExplicitClose.snapshot?.state).toBe('incomplete');
    expect(result.withoutExplicitClose.snapshot?.observedBytes).toBe(null);
    expect(result.withoutExplicitClose.snapshot?.bytes).toBe(9);
    expect(result.metadata?.kind).toBe('metadata');
    if (result.metadata?.kind === 'metadata')
        expect(result.metadata.capture.state).toBe('incomplete');
    expect(result.text).toBe('fixture# ');
    expect(result.ownedLocks).toEqual([]);
});
