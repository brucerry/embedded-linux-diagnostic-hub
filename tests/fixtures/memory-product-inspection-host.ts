import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import {
    chromium,
    type Browser,
    type BrowserContext,
    type CDPSession,
    type Page,
} from '@playwright/test';
import { BrowserDownloadEvents, createBrowserDownloads } from './memory-product-browser-downloads';
import { readProcessTable } from './memory-resource-processes';
import type {
    InspectionObserver,
    InspectionRebind,
    InspectionNativeStop,
} from './memory-product-inspection';
const { PassiveLifetimeCDP } = createRequire(import.meta.url)('./inspection/passive-cdp.cjs');
const { observeInspectorRelease } = createRequire(import.meta.url)(
    './inspection/release-window.cjs',
);
type Monitor = Awaited<ReturnType<typeof createBrowserDownloads>>;
export interface BrowserInspectionBinding {
    page: Page;
    browser: Browser;
    context: BrowserContext;
    pageProtocol: CDPSession;
    rootProtocol: CDPSession;
}
export interface BrowserInspectionCleanup {
    closeProtocols(): Promise<void>;
    closeMetadata(): Promise<void>;
    closeConnections(): Promise<void>;
    releaseAfterRootExit(): Promise<void>;
}
/** Only private fixture wrappers are replaced; the native browser and page survive. */
export async function createBrowserInspectionHost(input: {
    assertAdmissible?(): void;
    initial: BrowserInspectionBinding;
    endpoint: string;
    origin: string;
    directory: string;
    journal: BrowserDownloadEvents;
    signal?: AbortSignal;
    monitor: Monitor;
    rootChild: ChildProcess;
    emit(stage: string, value: unknown): Promise<void>;
    record(stage: string, value: unknown): void;
    retainParent(page: Page, browser: Browser): void;
    detachEvents(page: Page, context: BrowserContext): void;
    bindEvents(page: Page, context: BrowserContext): void;
    workers(): number;
    errors(): string[];
    install(value: BrowserInspectionBinding): void;
    clearProtocols(): void;
    installMonitor(monitor: Monitor): void;
    pruneParents(page: Page): void;
    retainCleanup(owner: BrowserInspectionCleanup): void;
}) {
    assert.ok(input.rootChild.pid);
    const root = (await readProcessTable()).find((row) => row.pid === input.rootChild.pid);
    assert.ok(root?.created);
    const rootIdentity = Object.freeze({ pid: root.pid, created: root.created });
    const metadata = new PassiveLifetimeCDP(input.endpoint, input.origin, input.record);
    const browsers = new Set<Browser>([input.initial.browser]);
    const sessions = new Map<CDPSession, { closed: boolean; listener(): void }>();
    const candidates = new Map<Page, { browser: Browser; context: BrowserContext }>();
    const monitors = new Set<Monitor>([input.monitor]);
    let current = input.initial,
        monitor = input.monitor,
        generation = 1;
    let hostReleased = false,
        downloadsReleased = false;
    const retain = (session: CDPSession) => {
        const owner = {
            closed: false,
            listener: () => {
                owner.closed = true;
            },
        };
        sessions.set(session, owner);
        session.once('close', owner.listener);
        return session;
    };
    const detach = async (session: CDPSession) => {
        const owner = sessions.get(session);
        assert.ok(owner, 'Unowned host CDP session.');
        if (!owner.closed) await session.detach();
        session.off('close', owner.listener);
        sessions.delete(session);
    };
    retain(current.pageProtocol);
    retain(current.rootProtocol);
    const attemptAll = async (work: (() => Promise<unknown>)[]) => {
        const results = await Promise.allSettled(work.map((run) => Promise.resolve().then(run)));
        const failures = results
            .filter((row): row is PromiseRejectedResult => row.status === 'rejected')
            .map((row) => row.reason);
        if (failures.length)
            throw new AggregateError(failures, 'Actual inspection cleanup remains unverified.');
    };
    const cleanup: BrowserInspectionCleanup = {
        closeProtocols: () =>
            attemptAll([...sessions.keys()].map((session) => () => detach(session))),
        async closeMetadata() {
            assert.equal(metadata.pending.size, 0, 'Passive calls remain owned.');
            assert.equal(
                metadata.listenerCount('change'),
                0,
                'Passive condition wait remains owned.',
            );
            await metadata.close();
            await input.emit('inspection-passive-transport-closed-before-native-exit', {
                root: rootIdentity,
                rootStillLive:
                    input.rootChild.exitCode === null && input.rootChild.signalCode === null,
                passiveClosed: metadata.closed,
                passiveFailure: metadata.failure ? String(metadata.failure) : null,
            });
        },
        closeConnections: () =>
            attemptAll(
                [...browsers].map((browser) => async () => {
                    if (browser.isConnected()) await browser.close();
                }),
            ),
        async releaseAfterRootExit() {
            assert.notEqual(input.rootChild.exitCode, null, 'Native root has not exited.');
            await attemptAll([
                ...[...monitors].map((value) => async () => value.releaseAfterBrowserExit()),
                () => metadata.close(),
            ]);
            assert.equal(sessions.size, 0);
        },
    };
    input.retainCleanup(cleanup);
    input.assertAdmissible?.();
    await metadata.open();
    input.assertAdmissible?.();
    await metadata.bindPage();
    input.assertAdmissible?.();
    const product = (await metadata.send('Browser.getVersion')).product as string;
    const target = (await metadata.send('Target.getTargets')).targetInfos.find(
        (row: { targetId: string }) => row.targetId === metadata.pageTarget,
    );
    assert.ok(target && typeof target.browserContextId === 'string' && target.browserContextId);
    const identity = Object.freeze({
        nativePageId: target.targetId as string,
        nativeContextId: target.browserContextId as string,
        browserProduct: product,
        root: rootIdentity,
    });
    const nativeIdentity = async () => {
        assert.equal(metadata.closed, false);
        assert.equal(metadata.failure, undefined);
        assert.equal(input.rootChild.exitCode, null);
        assert.equal(input.rootChild.signalCode, null);
        const live = (await readProcessTable()).find((row) => row.pid === rootIdentity.pid);
        assert.ok(live);
        assert.equal(live.created, rootIdentity.created);
        const targets = (await metadata.send('Target.getTargets')).targetInfos;
        const page = targets.find(
            (row: { targetId: string }) => row.targetId === identity.nativePageId,
        );
        assert.ok(page && page.type === 'page');
        assert.equal(page.browserContextId, identity.nativeContextId);
        assert.equal(page.url, input.origin + '/');
        assert.equal((await metadata.send('Browser.getVersion')).product, identity.browserProduct);
    };
    const hostObserver: InspectionObserver<Page> = {
        async release() {
            assert.equal(hostReleased, false);
            assert.equal(input.workers(), 0);
            assert.deepEqual(input.errors(), []);
            input.detachEvents(current.page, current.context);
            await detach(current.pageProtocol);
            await detach(current.rootProtocol);
            input.clearProtocols();
            hostReleased = true;
        },
        assertReleased() {
            assert.equal(hostReleased, true);
            assert.equal(input.workers(), 0);
        },
        async bind(page, nextGeneration) {
            assert.equal(hostReleased, true);
            assert.equal(nextGeneration, generation + 1);
            const candidate = candidates.get(page);
            assert.ok(candidate);
            input.assertAdmissible?.();
            const pageProtocol = retain(await page.context().newCDPSession(page));
            input.assertAdmissible?.();
            const rootProtocol = retain(await candidate.browser.newBrowserCDPSession());
            input.assertAdmissible?.();
            const next = { ...candidate, page, pageProtocol, rootProtocol };
            current = next;
            input.install(next);
            input.bindEvents(page, next.context);
            assert.equal(input.workers(), 0, 'Unexpected dedicated workers on reconnect.');
            generation = nextGeneration;
            hostReleased = false;
        },
        assertBound(page, value) {
            assert.equal(hostReleased, false);
            assert.equal(current.page, page);
            assert.equal(generation, value);
            assert.equal(current.browser.isConnected(), true);
            assert.equal(page.isClosed(), false);
            assert.equal(page.context(), current.context);
            assert.equal(sessions.get(current.pageProtocol)?.closed, false);
            assert.equal(sessions.get(current.rootProtocol)?.closed, false);
        },
    };
    const downloadObserver: InspectionObserver<Page> = {
        async release() {
            monitor.releaseForInspection();
            downloadsReleased = true;
        },
        assertReleased() {
            assert.equal(downloadsReleased, true);
            monitor.assertInspectionReleased();
        },
        async bind(page, value) {
            assert.equal(downloadsReleased, true);
            hostObserver.assertBound(page, value);
            // Assignment stays inside the actual hook even if its caller's deadline expires.
            monitor = await createBrowserDownloads({
                root: current.rootProtocol,
                page: current.pageProtocol,
                directory: input.directory,
                journal: input.journal,
                signal: input.signal,
                emit: input.emit,
            });
            monitors.add(monitor);
            input.installMonitor(monitor);
            downloadsReleased = false;
        },
        assertBound(page, value) {
            assert.equal(downloadsReleased, false);
            hostObserver.assertBound(page, value);
            assert.deepEqual(monitor.snapshot().errors, []);
        },
    };
    return {
        identity,
        metadata,
        hostObserver,
        downloadObserver,
        currentPage: () => current.page,
        async disconnect() {
            hostObserver.assertReleased();
            downloadObserver.assertReleased();
            await nativeIdentity();
            await current.browser.close();
            assert.equal(current.browser.isConnected(), false);
            await nativeIdentity();
        },
        async reconnect(): Promise<InspectionRebind<Page>> {
            hostObserver.assertReleased();
            downloadObserver.assertReleased();
            await nativeIdentity();
            input.assertAdmissible?.();
            const browser = await chromium.connectOverCDP(input.endpoint, {
                noDefaults: true,
                timeout: 10000,
                artifactsDir: input.directory,
            });
            browsers.add(browser);
            input.assertAdmissible?.();
            const contexts = browser.contexts();
            assert.equal(contexts.length, 1);
            const pages = contexts[0].pages();
            assert.ok(pages.length > 0 && pages.length <= 16);
            const found: Page[] = [];
            for (const page of pages) {
                input.retainParent(page, browser);
                candidates.set(page, { browser, context: page.context() });
                input.assertAdmissible?.();
                const session = retain(await page.context().newCDPSession(page));
                try {
                    input.assertAdmissible?.();
                    const info = (await session.send('Target.getTargetInfo')).targetInfo;
                    if (info.targetId === identity.nativePageId) {
                        assert.equal(info.browserContextId, identity.nativeContextId);
                        assert.equal(info.url, input.origin + '/');
                        found.push(page);
                    }
                } finally {
                    await detach(session);
                }
            }
            assert.equal(
                found.length,
                1,
                'Original native page wrapper was not found exactly once.',
            );
            await nativeIdentity();
            return Object.freeze({ ...identity, page: found[0] });
        },
        async verify(binding: InspectionRebind<Page>) {
            await nativeIdentity();
            assert.equal(binding.page.isClosed(), false);
            assert.ok(candidates.has(binding.page), 'Unowned replacement page.');
            assert.equal(candidates.get(binding.page)!.browser.isConnected(), true);
        },
        async commit(binding: InspectionRebind<Page>, _stopped: InspectionNativeStop) {
            hostObserver.assertBound(binding.page, generation);
            downloadObserver.assertBound(binding.page, generation);
        },
        finishReady(page: Page) {
            assert.equal(current.page, page);
            for (const browser of browsers)
                if (browser !== current.browser) {
                    assert.equal(browser.isConnected(), false);
                    browsers.delete(browser);
                }
            for (const candidate of candidates.keys())
                if (candidate !== page) candidates.delete(candidate);
            input.pruneParents(page);
        },
        async observeRelease(
            binding: unknown,
            controlOffset: number,
            workerClosed: () => boolean,
            disconnect: () => Promise<void>,
            joinWorkerClose: () => Promise<void>,
        ) {
            return observeInspectorRelease({
                metadata,
                binding,
                controlOffset,
                playwrightClosed: workerClosed,
                disconnect,
                joinWorkerClose,
                record: input.record,
            }) as Promise<InspectionNativeStop>;
        },
        ...cleanup,
        snapshotOwners: () => ({
            browsers: browsers.size,
            sessions: sessions.size,
            candidates: candidates.size,
            generation,
            hostReleased,
            downloadsReleased,
            downloads: input.journal.snapshot(),
            passivePending: metadata.pending.size,
        }),
    };
}
