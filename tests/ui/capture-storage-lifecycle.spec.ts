import { test, expect, type Page } from '@playwright/test';
import type {} from '../fixtures/capture-lifecycle-browser';
async function install(page: Page) {
    await page.evaluate(async () => {
        const source = '/tests/fixtures/capture-lifecycle-browser.ts';
        await import(source);
    });
}
test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await install(page);
});

test('v1 upgrade preserves every raw block, final record and unknown store while recovering only abandoned acquisition', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            { ids, before } = await q.seedLegacy(name),
            store = await q.IndexedDbCaptureStore.open(name);
        try {
            const after = await q.inspect(name),
                rows = (await store.page()).records,
                raw = await Promise.all(ids.map((id) => q.bytes(store, id))),
                outcomes = await Promise.all(ids.map((id) => store.result(id))),
                pin = await store.pin();
            await pin.release();
            const next = await store.begin({
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'new',
                stepId: 'one',
                name: 'New',
                command: 'fixture',
                startedAt: q.stamp,
            });
            await store.seal(next.id, 0, 'empty fixture');
            return {
                before,
                after,
                rows,
                raw,
                outcomes,
                through: pin.through,
                next: next.sequence,
            };
        } finally {
            await store.close();
        }
    });
    expect(result.after.version).toBe(2);
    expect(result.after.stores).toContain('results');
    expect(result.after.extra).toEqual(result.before.extra);
    expect(result.after.frames).toEqual(result.before.frames);
    expect(result.after.captures.slice(0, 2)).toEqual(result.before.captures.slice(0, 2));
    expect(result.rows.map((row) => row.state)).toEqual(['complete', 'incomplete', 'incomplete']);
    expect(result.rows[2].observedBytes).toBeNull();
    expect(result.outcomes).toEqual([null, null, null]);
    expect(result.raw).toEqual([65, 66, 67].map((last) => [0, 255, 27, 91, 51, 49, 109, last]));
    expect(result.through).toBe(700);
    expect(result.next).toBe(701);
});
test('missing or stale counters recover from retained ordering; invalid counters preserve readable evidence and block new writes', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            results = [];
        for (const mode of ['missing', 'stale', 'invalid']) {
            const name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1';
            await q.seedLegacy(name, {
                omitCounter: mode === 'missing',
                counter: mode === 'invalid' ? 'corrupt' : 1,
            });
            const store = await q.IndexedDbCaptureStore.open(name);
            try {
                const pin = await store.pin();
                await pin.release();
                let next: number | null = null,
                    error = '';
                try {
                    const capture = await store.begin({
                        transport: 'serial',
                        receiveTimeSource: 'local-client',
                        runId: 'counter',
                        stepId: 'one',
                        name: 'Counter',
                        command: 'fixture',
                        startedAt: q.stamp,
                    });
                    next = capture.sequence;
                    await store.seal(capture.id, 0, 'empty');
                } catch (failure) {
                    error = (failure as Error).message;
                }
                const report = await q.report(store),
                    saved = await q.inspect(name);
                results.push({
                    mode,
                    through: pin.through,
                    next,
                    error,
                    rows: report.captures.length,
                    sequence: saved.sequence,
                    warning: store.recoveryFailure?.code,
                });
            } finally {
                await store.close();
            }
        }
        return results;
    });
    for (const row of results) {
        expect(row.through).toBe(42);
        if (row.mode === 'invalid') {
            expect(row.next).toBeNull();
            expect(row.warning).toBe('integrity');
            expect(row.error).toContain('new capture is blocked');
            expect(row.sequence).toBe('corrupt');
            expect(row.rows).toBe(3);
        } else {
            expect(row.next).toBe(43);
            expect(row.rows).toBe(4);
            expect(row.sequence).toBe(43);
        }
    }
});
test('stored-data recovery warnings remain visible after the catalog loads', async ({ page }) => {
    await page.evaluate(() =>
        window.lifecycleQA.seedLegacy('diagnostic-hub-captures-v1', { counter: 'corrupt' }),
    );
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = page.getByRole('region', { name: 'Automation', exact: true });
    await flow.getByLabel('Automation transport').selectOption('serial');
    await expect(flow.locator('tbody tr')).toHaveCount(3);
    await expect(flow.getByRole('alert').filter({ hasText: 'Storage recovery:' })).toContainText(
        'sequence counter is invalid',
    );
    await flow.getByRole('button', { name: 'Refresh stored results', exact: true }).click();
    await expect(flow.locator('tbody tr')).toHaveCount(3);
    await expect(flow.getByRole('alert').filter({ hasText: 'Storage recovery:' })).toBeVisible();
});

test('incompatible legacy ordering aborts the upgrade and malformed v2 is rejected without resetting either dataset', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            results = [];
        for (const mode of ['legacy', 'v2']) {
            const name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
                { before } = await q.seedLegacy(
                    name,
                    mode === 'legacy' ? { badIndex: true } : { version: 2, omitResults: true },
                );
            let code = '';
            try {
                const store = await q.IndexedDbCaptureStore.open(name);
                await store.close();
            } catch (error) {
                code = (error as { code: string }).code;
            }
            results.push({ mode, code, before, after: await q.inspect(name) });
        }
        return results;
    });
    for (const row of results) {
        expect(row.code).toBe('integrity');
        expect(row.after).toEqual(row.before);
    }
});
test('a blocked v1 upgrade leaves the old connection readable and succeeds after its owner closes', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            { before } = await q.seedLegacy(name, { keepOpen: true });
        let code = '';
        try {
            await q.IndexedDbCaptureStore.open(name);
        } catch (error) {
            code = (error as { code: string }).code;
        }
        const blocked = await q.snapshot(window.heldLegacy!);
        window.heldLegacy!.close();
        const store = await q.IndexedDbCaptureStore.open(name);
        try {
            return {
                code,
                before,
                blocked,
                after: await q.inspect(name),
                rows: (await store.page()).records.length,
            };
        } finally {
            await store.close();
        }
    });
    expect(result.code).toBe('busy');
    expect(result.blocked).toEqual(result.before);
    expect(result.after.version).toBe(2);
    expect(result.after.frames).toEqual(result.before.frames);
    expect(result.rows).toBe(3);
});
test('an actual versionchange transaction abort preserves v1 and all captures for a later retry', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            { before } = await q.seedLegacy(name),
            create = IDBDatabase.prototype.createObjectStore;
        let code = '';
        IDBDatabase.prototype.createObjectStore = function (...args: Parameters<typeof create>) {
            if (this.name === name && args[0] === 'results')
                throw new DOMException('Simulated migration quota failure', 'QuotaExceededError');
            return create.apply(this, args);
        };
        try {
            await q.IndexedDbCaptureStore.open(name);
        } catch (error) {
            code = (error as { code: string }).code;
        } finally {
            IDBDatabase.prototype.createObjectStore = create;
        }
        const aborted = await q.inspect(name),
            store = await q.IndexedDbCaptureStore.open(name);
        try {
            return { code, before, aborted, after: await q.inspect(name) };
        } finally {
            await store.close();
        }
    });
    expect(result.code).toBe('quota');
    expect(result.aborted).toEqual(result.before);
    expect(result.after.version).toBe(2);
    expect(result.after.frames).toEqual(result.before.frames);
});
test('future stored-data versions are reported explicitly and never recreated or downgraded', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            { before } = await q.seedLegacy(name, { version: 3 });
        let code = '',
            message = '';
        try {
            await q.IndexedDbCaptureStore.open(name);
        } catch (error) {
            code = (error as { code: string }).code;
            message = (error as Error).message;
        }
        return { code, message, before, after: await q.inspect(name) };
    });
    expect(result.code).toBe('unsupported');
    expect(result.message).toContain('newer database version');
    expect(result.after).toEqual(result.before);
});
test('aborted outcome writes preserve sealed raw data across reopen and allow an explicit immutable retry', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            store = await q.IndexedDbCaptureStore.open(name),
            writer = await q.CaptureWriter.begin(store, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'metadata',
                stepId: 'one',
                name: 'Metadata',
                command: 'fixture',
                startedAt: q.stamp,
            });
        await writer.append(new Uint8Array([0, 255, 1, 2]), q.stamp, 'serial');
        const capture = await writer.finish('prompt-observed'),
            outcome = q.outcome(),
            add = IDBObjectStore.prototype.add;
        let code = '';
        IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
            const request = add.apply(this, args);
            if (this.name === 'results' && this.transaction.db.name === name) {
                this.transaction.abort();
                throw new DOMException('Simulated metadata quota abort', 'QuotaExceededError');
            }
            return request;
        };
        try {
            await store.record(capture.id, outcome);
        } catch (error) {
            code = (error as { code: string }).code;
        } finally {
            IDBObjectStore.prototype.add = add;
        }
        const raw = await q.bytes(store, capture.id),
            missing = await store.result(capture.id);
        await store.close();
        const reopened = await q.IndexedDbCaptureStore.open(name);
        try {
            const recovered = await reopened.result(capture.id);
            await reopened.record(capture.id, outcome);
            await reopened.record(capture.id, outcome);
            let immutable = '';
            try {
                await reopened.record(capture.id, { ...outcome, durationMs: 2 });
            } catch (error) {
                immutable = (error as { code: string }).code;
            }
            return {
                code,
                raw,
                missing,
                recovered,
                outcome,
                saved: await reopened.result(capture.id),
                immutable,
                state: (await reopened.page()).records[0].state,
            };
        } finally {
            await reopened.close();
        }
    });
    expect(result.code).toBe('quota');
    expect(result.raw).toEqual([0, 255, 1, 2]);
    expect(result.missing).toBeNull();
    expect(result.recovered).toBeNull();
    expect(result.saved).toEqual(result.outcome);
    expect(result.immutable).toBe('integrity');
    expect(result.state).toBe('complete');
});
test('versionchange during an outcome transaction waits for its commit before releasing ownership', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            store = await q.IndexedDbCaptureStore.open(name),
            writer = await q.CaptureWriter.begin(store, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'versionchange',
                stepId: 'one',
                name: 'Versionchange',
                command: 'fixture',
                startedAt: q.stamp,
            });
        await writer.append(new Uint8Array([7, 8, 9]), q.stamp, 'serial');
        const capture = await writer.finish('prompt-observed'),
            outcome = q.outcome();
        const originalAdd = IDBObjectStore.prototype.add,
            originalClose = IDBDatabase.prototype.close;
        const manager = navigator.locks as unknown as {
                request: (
                    name: string,
                    options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => Promise<void>;
            },
            originalRequest = manager.request.bind(manager);
        let changing = false,
            committed = false,
            releasedBeforeCommit = false,
            sawPending = false,
            recordDone = false,
            upgrade: Promise<IDBDatabase> | undefined;
        manager.request = (lockName, options, callback) =>
            originalRequest(lockName, options, async (lock) => {
                try {
                    return await callback(lock);
                } finally {
                    if (
                        lockName.startsWith(name + ':') &&
                        /:catalog$|:outcome:/.test(lockName) &&
                        !committed
                    )
                        releasedBeforeCommit = true;
                }
            });
        IDBDatabase.prototype.close = function () {
            if (this.name === name && this.version === 2) {
                changing = true;
                sawPending = !recordDone;
            }
            return originalClose.call(this);
        };
        IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
            const request = originalAdd.apply(this, args);
            if (this.name === 'results' && this.transaction.db.name === name) {
                const tx = this.transaction;
                // Observe within the actual completion callback before it resolves the
                // transaction promise; engines checkpoint microtasks between listeners.
                const completed = tx.oncomplete;
                tx.oncomplete = function (event) {
                    committed = true;
                    return completed?.call(this, event);
                };
                const table = tx.objectStore('captures');
                const keepAlive = () => {
                    const pending = table.get(capture.id);
                    pending.onsuccess = () => {
                        if (!changing) keepAlive();
                    };
                };
                keepAlive();
                upgrade = q.openRaw(name, 3);
            }
            return request;
        };
        try {
            await store.record(capture.id, outcome);
            recordDone = true;
            const newer = await upgrade!;
            originalClose.call(newer);
            await store.close();
            const db = await q.openRaw(name);
            let saved: unknown,
                raw: number[] = [];
            try {
                const tx = db.transaction(['results', 'frames'], 'readonly'),
                    done = q.done(tx);
                saved = await q.request(tx.objectStore('results').get(capture.id));
                const frames = await q.request(tx.objectStore('frames').getAll());
                raw = frames.flatMap((frame) => Array.from(frame.bytes as Uint8Array));
                await done;
            } finally {
                originalClose.call(db);
            }
            const held = (await navigator.locks.query()).held?.filter((lock) =>
                lock.name?.startsWith(name + ':'),
            ).length;
            return {
                changing,
                committed,
                sawPending,
                releasedBeforeCommit,
                held,
                saved,
                outcome,
                raw,
            };
        } finally {
            IDBObjectStore.prototype.add = originalAdd;
            IDBDatabase.prototype.close = originalClose;
            manager.request = originalRequest;
        }
    });
    expect(result.changing).toBe(true);
    expect(result.sawPending).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.releasedBeforeCommit).toBe(false);
    expect(result.held).toBe(0);
    expect(result.saved).toEqual(result.outcome);
    expect(result.raw).toEqual([7, 8, 9]);
});

for (const ending of ['commit', 'abort'] as const)
    test(
        'versionchange during capture initialization retains ownership and never calls the producer: ' +
            ending,
        async ({ page }, info) => {
            const result = await page.evaluate(async (ending) => {
                const q = window.lifecycleQA;
                const modulePath = '/shared/automation-capture.ts';
                const { captureToRepository } = await import(modulePath);
                const name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1';
                const store = await q.IndexedDbCaptureStore.open(name);
                const originalAdd = IDBObjectStore.prototype.add;
                const originalClose = IDBDatabase.prototype.close;
                const manager = navigator.locks as unknown as {
                    request: (
                        name: string,
                        options: LockOptions,
                        callback: (lock: Lock | null) => Promise<void>,
                    ) => Promise<void>;
                };
                const originalRequest = manager.request.bind(manager);
                let changed!: () => void;
                const changing = new Promise<void>((resolve) => {
                    changed = resolve;
                });
                let allowCommit = false,
                    settled = false,
                    committed = false;
                let releasedBeforeSettlement = false,
                    produced = 0,
                    resolved = false;
                let errorCode: string | null = null,
                    keepAliveRequests = 0;
                let transaction: IDBTransaction | undefined,
                    upgrade: Promise<IDBDatabase> | undefined;
                let operation: Promise<void> | undefined;
                let changeTimer: ReturnType<typeof setTimeout> | undefined;
                manager.request = (lockName, options, callback) =>
                    originalRequest(lockName, options, async (lock) => {
                        try {
                            return await callback(lock);
                        } finally {
                            if (
                                lock &&
                                lockName.startsWith(name + ':') &&
                                /:writer$|:capture:/.test(lockName) &&
                                !settled
                            )
                                releasedBeforeSettlement = true;
                        }
                    });
                IDBDatabase.prototype.close = function () {
                    if (this.name === name && this.version === 2) changed();
                    return originalClose.call(this);
                };
                IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
                    const request = originalAdd.apply(this, args);
                    if (
                        this.name === 'captures' &&
                        this.transaction.db.name === name &&
                        !transaction
                    ) {
                        const tx = (transaction = this.transaction);
                        const completed = tx.oncomplete,
                            aborted = tx.onabort;
                        tx.oncomplete = function (event) {
                            settled = committed = true;
                            return completed?.call(this, event);
                        };
                        tx.onabort = function (event) {
                            settled = true;
                            return aborted?.call(this, event);
                        };
                        const table = tx.objectStore('settings');
                        const keepAlive = () => {
                            if (++keepAliveRequests > 4096) {
                                tx.abort();
                                return;
                            }
                            const pending = table.get('sequence');
                            pending.onsuccess = () => {
                                if (!allowCommit) keepAlive();
                            };
                        };
                        keepAlive();
                        upgrade = q.openRaw(name, 3);
                    }
                    return request;
                };
                try {
                    operation = captureToRepository(
                        store,
                        {
                            transport: 'serial',
                            receiveTimeSource: 'local-client',
                            runId: 'begin-versionchange',
                            stepId: 'one',
                            name: 'Never send',
                            command: 'synthetic only',
                            startedAt: q.stamp,
                        },
                        new AbortController().signal,
                        async () => {
                            produced++;
                            return {
                                stdout: '',
                                stderr: '',
                                exitCode: null,
                                completion: 'prompt-observed',
                                truncated: false,
                                chunks: [],
                                previewClipped: false,
                            };
                        },
                    ).then(
                        () => {
                            resolved = true;
                        },
                        (error: { code?: string }) => {
                            errorCode = error.code ?? 'unknown';
                        },
                    );
                    await Promise.race([
                        changing,
                        new Promise<void>((_, reject) => {
                            changeTimer = setTimeout(
                                () =>
                                    reject(Error('Initialization versionchange was not observed.')),
                                3000,
                            );
                        }),
                    ]);
                    clearTimeout(changeTimer);
                    // Keep the real transaction pending while the handler has time to release locks.
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    const heldBeforeSettlement = (await navigator.locks.query()).held?.filter(
                        (lock) =>
                            lock.name?.startsWith(name + ':') &&
                            /:writer$|:capture:/.test(lock.name),
                    ).length;
                    const pendingBeforeSettlement = !settled;
                    allowCommit = true;
                    if (ending === 'abort') transaction!.abort();
                    await operation;
                    const newer = await upgrade!;
                    originalClose.call(newer);
                    await store.close();
                    const db = await q.openRaw(name);
                    let captures: { state: string; committedBytes: number }[],
                        frameCount: number,
                        outcomeCount: number;
                    try {
                        const tx = db.transaction(['captures', 'frames', 'results'], 'readonly'),
                            done = q.done(tx);
                        [captures, frameCount, outcomeCount] = await Promise.all([
                            q.request(tx.objectStore('captures').getAll()),
                            q.request(tx.objectStore('frames').count()),
                            q.request(tx.objectStore('results').count()),
                        ]);
                        await done;
                    } finally {
                        originalClose.call(db);
                    }
                    const heldAfter = (await navigator.locks.query()).held?.filter((lock) =>
                        lock.name?.startsWith(name + ':'),
                    ).length;
                    return {
                        pendingBeforeSettlement,
                        heldBeforeSettlement,
                        releasedBeforeSettlement,
                        produced,
                        resolved,
                        errorCode,
                        committed,
                        settled,
                        heldAfter,
                        captures,
                        frameCount,
                        outcomeCount,
                        keepAliveRequests,
                    };
                } finally {
                    clearTimeout(changeTimer);
                    allowCommit = true;
                    if (transaction && !settled) {
                        try {
                            transaction.abort();
                        } catch {}
                    }
                    await operation;
                    await store.close();
                    IDBObjectStore.prototype.add = originalAdd;
                    IDBDatabase.prototype.close = originalClose;
                    manager.request = originalRequest;
                }
            }, ending);
            await info.attach('begin-versionchange-evidence', {
                body: JSON.stringify(result, null, 2),
                contentType: 'application/json',
            });
            expect(result.pendingBeforeSettlement).toBe(true);
            expect(result.heldBeforeSettlement).toBe(2);
            expect(result.releasedBeforeSettlement).toBe(false);
            expect(result.produced).toBe(0);
            expect(result.resolved).toBe(false);
            expect(result.errorCode).toBe('io');
            expect(result.settled).toBe(true);
            expect(result.committed).toBe(ending === 'commit');
            expect(result.heldAfter).toBe(0);
            expect(result.frameCount).toBe(0);
            expect(result.outcomeCount).toBe(0);
            expect(result.captures).toHaveLength(ending === 'commit' ? 1 : 0);
            if (ending === 'commit') {
                expect(result.captures[0].state).toBe('active');
                expect(result.captures[0].committedBytes).toBe(0);
            }
        },
    );

async function abandon(page: Page) {
    return page.evaluate(async () => {
        const q = window.lifecycleQA,
            name = 'diagnostic-hub-captures-test-' + crypto.randomUUID() + '-v1',
            store = await q.IndexedDbCaptureStore.open(name),
            writer = await q.CaptureWriter.begin(store, {
                transport: 'serial',
                receiveTimeSource: 'local-client',
                runId: 'abrupt',
                stepId: 'one',
                name: 'Abandoned',
                command: 'fixture',
                startedAt: q.stamp,
            });
        await writer.append(new Uint8Array([0, 255, 27, 65]), q.stamp, 'serial');
        await writer.flush();
        window.lifecycleStore = store;
        return { name, id: writer.id };
    });
}
async function recover(page: Page, name: string, id: string) {
    return page.evaluate(
        async ({ name, id }) => {
            const q = window.lifecycleQA,
                store = await q.IndexedDbCaptureStore.open(name);
            try {
                return {
                    row: (await store.page()).records[0],
                    raw: await q.bytes(store, id),
                    outcome: await store.result(id),
                };
            } finally {
                await store.close();
            }
        },
        { name, id },
    );
}
test('reload recovers the retained active prefix and never invents execution metadata', async ({
    page,
}) => {
    const { name, id } = await abandon(page);
    await page.reload();
    await install(page);
    const result = await recover(page, name, id);
    expect(result.row.state).toBe('incomplete');
    expect(result.row.observedBytes).toBeNull();
    expect(result.raw).toEqual([0, 255, 27, 65]);
    expect(result.outcome).toBeNull();
});
test('actual Chromium renderer crash preserves the committed prefix for a replacement page', async ({
    page,
    context,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'Actual crash uses Chromium CDP; reload recovery is qualified in every engine.',
    );
    const { name, id } = await abandon(page),
        session = await context.newCDPSession(page),
        crashed = page.waitForEvent('crash');
    void session.send('Page.crash').catch(() => {});
    await crashed;
    const replacement = await context.newPage();
    try {
        await replacement.goto('/');
        await install(replacement);
        const result = await recover(replacement, name, id);
        expect(result.row.state).toBe('incomplete');
        expect(result.row.observedBytes).toBeNull();
        expect(result.raw).toEqual([0, 255, 27, 65]);
        expect(result.outcome).toBeNull();
    } finally {
        await replacement.close();
    }
});
