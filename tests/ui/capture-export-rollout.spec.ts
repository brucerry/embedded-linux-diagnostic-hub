import { test, expect, type Worker, type Download } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

const optedIn = process.env.HUB_EXPORT_ROLLOUT_EXECUTE === 'reviewed-new-runtime-only';
test.skip(!optedIn, 'Private attach-only rollout; browser holds are unchanged.');
type Scenario = 'control-held' | 'new-on-old' | 'old-on-new' | 'prepare-takeover' | 'release-rejected';
type Asset = { path: string; bytes: number; sha256: string };
type WorkerState = {
    rollout: { generation: string; events: { type: string; detail: any }[]; pins: { calls: number; delegated: number; released: boolean }[]; gates: { name: string; entered: boolean; released: boolean }[] };
    product: { jobs: { id: string; retirement: string | null; cleanupFailed: boolean }[]; owners: Record<string, number> };
};
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function boundedJson(file: string, expectedHash: string) {
    if (!path.isAbsolute(file)) throw Error('Absolute reviewed input required.');
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Reviewed metadata hash required.');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('Invalid bounded metadata.');
    const bytes = await fs.readFile(file);
    if (bytes.length > 256 * 1024 || sha(bytes) !== expectedHash) throw Error('Reviewed metadata changed.');
    return JSON.parse(bytes.toString('utf8'));
}
interface RetainedDownload {
    number: number;
    state: 'observing' | 'failed-no-supported-copy' | 'copy-unavailable-or-failed' | 'retained-success';
    sourceFailure: string | null;
    path?: string;
    bytesAcknowledged: number;
    sourceEOF: boolean;
    sourceClientClose: boolean;
    fileSync: boolean;
    fileClose: boolean;
    readbackClose: boolean;
    sha256?: string;
    errors: string[];
}
/** Copies only a successful SDK artifact. Failed/partial browser files are never scraped. */
async function retainSuccessfulDownload(download: Download, number: number, retained: string,
    held: unknown[]): Promise<RetainedDownload> {
    const result: RetainedDownload = {
        number, state: 'observing', sourceFailure: 'unobserved', bytesAcknowledged: 0,
        sourceEOF: false, sourceClientClose: false, fileSync: false, fileClose: false,
        readbackClose: false, errors: [],
    };
    const note = (error: unknown) => { result.errors.push(String(error).slice(0, 512)); };
    let file: FileHandle | undefined, reader: FileHandle | undefined;
    let source: Awaited<ReturnType<Download['createReadStream']>> | undefined;
    let syncAttempted = false, fileCloseAttempted = false, readerCloseAttempted = false;
    try {
        const failure = await download.failure();
        result.sourceFailure = failure === null ? null : String(failure).slice(0, 512);
        if (result.sourceFailure !== null) {
            result.state = 'failed-no-supported-copy'; return result;
        }
        source = await download.createReadStream();
        if (!source) throw Error('Successful download has no supported readable artifact.');
        source.once('error', note);
        const closed = new Promise<void>((resolve) => source!.once('close', () => {
            result.sourceClientClose = true; resolve();
        }));
        result.path = path.join(retained, 'download-' + number + '.bin');
        file = await fs.open(result.path, 'wx', 0o600);
        const identity = await file.stat();
        const hash = createHash('sha256'), iterator = source[Symbol.asyncIterator]();
        // Manual iteration does not call return()/destroy() to conceal an unobserved failure.
        while (true) {
            const next = await iterator.next();
            if (next.done) { result.sourceEOF = true; break; }
            if (!(next.value instanceof Uint8Array) || result.bytesAcknowledged + next.value.byteLength > 256 * 1024)
                throw Error('Retained download exceeded its bound; prefix retained without truncation claim.');
            let offset = 0;
            while (offset < next.value.byteLength) {
                const wrote = await file.write(next.value, offset, next.value.byteLength - offset);
                if (wrote.bytesWritten <= 0) throw Error('Download write made no progress.');
                hash.update(next.value.subarray(offset, offset + wrote.bytesWritten));
                offset += wrote.bytesWritten; result.bytesAcknowledged += wrote.bytesWritten;
            }
        }
        await closed; // SDK-client stream close is not physical browser/IDB closure proof.
        syncAttempted = true; await file.sync(); result.fileSync = true;
        const completed = await file.stat();
        if (completed.ino !== identity.ino || completed.dev !== identity.dev || completed.size !== result.bytesAcknowledged)
            throw Error('Retained download identity/length changed.');
        fileCloseAttempted = true; await file.close(); result.fileClose = true; file = undefined;
        result.sha256 = hash.digest('hex');
        reader = await fs.open(result.path, 'r');
        const before = await reader.stat();
        if (!before.isFile() || before.ino !== identity.ino || before.dev !== identity.dev || before.size !== result.bytesAcknowledged)
            throw Error('Retained download readback identity changed.');
        const readback = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let bytesRead = 0;
        while (true) {
            const next = await reader.read(buffer);
            if (!next.bytesRead) break;
            bytesRead += next.bytesRead;
            if (bytesRead > 256 * 1024) throw Error('Retained readback exceeded its bound.');
            readback.update(buffer.subarray(0, next.bytesRead));
        }
        const after = await reader.stat();
        if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size ||
            bytesRead !== result.bytesAcknowledged || readback.digest('hex') !== result.sha256)
            throw Error('Retained download readback mismatch.');
        readerCloseAttempted = true; await reader.close(); result.readbackClose = true; reader = undefined;
        if (result.errors.length) throw Error('Download source emitted an error during copying.');
        result.state = 'retained-success';
    } catch (error) {
        result.state = 'copy-unavailable-or-failed'; note(error);
        if (source && !result.sourceClientClose) held.push({ source, error, number });
        if (fileCloseAttempted && file) held.push({ file, error, number });
        if (readerCloseAttempted && reader) held.push({ reader, error, number });
    } finally {
        // Close only owned evidence handles, retaining every file and every close error.
        if (reader && !readerCloseAttempted) try { readerCloseAttempted = true; await reader.close(); result.readbackClose = true; }
        catch (error) { note(error); held.push({ reader, error, number }); }
        if (file) {
            if (!syncAttempted) try { syncAttempted = true; await file.sync(); result.fileSync = true; } catch (error) { note(error); }
            if (!fileCloseAttempted) try { fileCloseAttempted = true; await file.close(); result.fileClose = true; }
            catch (error) { note(error); held.push({ file, error, number }); }
        }
    }
    return result;
}
async function asset(record: Asset) {
    if (!path.isAbsolute(record.path) || record.bytes > 2 * 1024 * 1024 || record.bytes < 1)
        throw Error('Invalid bounded private asset.');
    const stat = await fs.lstat(record.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) throw Error('Private asset identity changed.');
    const bytes = await fs.readFile(record.path);
    if (sha(bytes) !== record.sha256) throw Error('Private asset hash changed.');
    return bytes;
}
/** No launch/profile creation: one scenario attaches to a separately admitted fresh browser. */
test('private real-worker rollout preserves captured ownership or honest uncertainty', async ({ playwright }, info) => {
    expect(info.project.name).toBe('private-export-rollout');
    const scenario = process.env.HUB_ROLLOUT_SCENARIO as Scenario;
    expect(['control-held', 'new-on-old', 'old-on-new', 'prepare-takeover', 'release-rejected']).toContain(scenario);
    const endpoint = new URL(process.env.HUB_ROLLOUT_CDP_ENDPOINT!);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
        endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password)
        throw Error('Only an explicit reviewed loopback CDP owner is supported.');
    const owner = await boundedJson(process.env.HUB_ROLLOUT_OWNER_RECEIPT!, process.env.HUB_ROLLOUT_OWNER_RECEIPT_SHA256!);
    expect(owner.kind).toBe('reviewed-isolated-browser');
    expect(owner.endpointSHA256).toBe(sha(endpoint.href));
    expect(owner.freshProfile).toBe(true);
    expect(owner.sandboxEnabled).toBe(true);
    expect(typeof owner.reviewId).toBe('string');
    expect(owner.reviewId.length).toBeGreaterThan(0);
    expect(owner.runtimeAdmission).toBe('reviewed-for-this-scenario');
    expect(owner.scenario).toBe(scenario);
    expect(owner.sdkCoreBundleSHA256).toBe('549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171');
    expect(owner.retainedRoot).toBe(path.resolve(process.env.HUB_ROLLOUT_RETAINED_ROOT!));
    expect(Number.isSafeInteger(owner.nativeOwner?.pid) && owner.nativeOwner.pid > 0).toBe(true);
    expect(typeof owner.nativeOwner?.creationIdentity).toBe('string');
    expect(owner.nativeOwner.creationIdentity.length).toBeGreaterThan(0);
    expect(path.isAbsolute(owner.nativeOwner?.executable ?? '')).toBe(true);
    expect(owner.nativeOwner?.executableSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(owner.nativeOwner?.observerReceiptSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(owner.reviews).toEqual({ endpointAndBrowserIdentity: true, sdkTeardownEffects: true, failureDisposition: true });
    expect(owner.ownership).toEqual({
        browser: 'external-retained', context: 'existing-default-only', profile: 'external-retained',
        client: 'retain-until-explicit-owner-action', failure: 'retain-job-and-observer-owners',
        sdkArtifacts: 'fresh-retained-no-removal', failedPartials: 'unavailable-is-unknown',
    });
    // These pinned external admission facts do not independently measure native identity/sandbox.
    const manifest = await boundedJson(process.env.HUB_ROLLOUT_ASSETS!, process.env.HUB_ROLLOUT_ASSETS_SHA256!);
    expect(manifest.kind).toBe('private-export-rollout-assets');
    expect(manifest.shipping).toBe(false);
    expect(manifest.legacyProvenance).toBe('pre-fix-candidate-characterization');
    if (['new-on-old', 'old-on-new'].includes(scenario) && manifest.legacyCases !== 'admitted-with-complete-provenance')
        throw Error('Legacy dependency/deployed provenance is blocked; no connection was made.');
    const names = ['currentPage', 'worker1', 'worker2', 'frame'];
    if (['new-on-old', 'old-on-new'].includes(scenario)) names.push('legacyPage', 'legacyWorker');
    const assets = new Map<string, Uint8Array>();
    let total = 0;
    for (const name of names) { const bytes = await asset(manifest.assets[name]); total += bytes.length; assets.set(name, bytes); }
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(sha(assets.get('worker1')!)).not.toBe(sha(assets.get('worker2')!));
    const retained = path.join(process.env.HUB_ROLLOUT_RETAINED_ROOT!, scenario);
    await fs.mkdir(retained, { recursive: false });
    const artifactsDir = path.join(retained, 'sdk-artifacts');
    await fs.mkdir(artifactsDir, { recursive: false });
    const evidence: Record<string, unknown> = {
        scenario, owner: { kind: owner.kind, reviewId: owner.reviewId, browserVersion: owner.browserVersion,
            endpointSHA256: owner.endpointSHA256, freshProfile: owner.freshProfile, sandboxEnabled: owner.sandboxEnabled },
        admission: { scenario, ownerReceiptSHA256: process.env.HUB_ROLLOUT_OWNER_RECEIPT_SHA256,
            assetManifestSHA256: process.env.HUB_ROLLOUT_ASSETS_SHA256, reviews: owner.reviews,
            ownership: owner.ownership, nativeOwner: { pid: owner.nativeOwner.pid,
                creationIdentity: owner.nativeOwner.creationIdentity, executable: owner.nativeOwner.executable,
                executableSHA256: owner.nativeOwner.executableSHA256, observerReceiptSHA256: owner.nativeOwner.observerReceiptSHA256 } },
        inputs: { kind: manifest.kind, shipping: false, legacyProvenance: manifest.legacyProvenance,
            assets: Object.fromEntries(names.map((name) => [name, manifest.assets[name]])) },
        browserDisposition: 'retained-for-external-owner', jobRetirementAcknowledged: false,
        sdkArtifacts: { path: artifactsDir, state: 'fresh-retained-no-removal' },
        downloadPolicy: scenario === 'prepare-takeover' ? 'zero-managed-downloads-required' : 'actual-downloads-observed-separately-from-retirement',
    };
    const save = async (name: string) => {
        const body = JSON.stringify(evidence, null, 2);
        if (Buffer.byteLength(body) > 256 * 1024) throw Error('Rollout receipt bound exceeded.');
        await fs.writeFile(path.join(retained, name), body, { flag: 'wx', mode: 0o600 });
    };
    let revision = scenario === 'new-on-old' ? 'legacyWorker' : 'worker1';
    let server: Server | undefined;
    let failed = false, primary: unknown;
    await save('request.json');
    try {
        // No product/dev server, proxy, file router or external page. Test code does not launch a browser.
        server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            let key = '';
            if (url.pathname === '/rollout/capture-download-sw.js') key = revision;
            if (url.pathname === '/rollout/capture-download-frame.js') key = 'frame';
            if (url.pathname === '/rollout/current.js') key = 'currentPage';
            if (url.pathname === '/rollout/legacy.js') key = 'legacyPage';
            if (key && assets.has(key)) {
                response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
                response.end(assets.get(key)); return;
            }
            if (url.pathname !== '/rollout/') { response.writeHead(404); response.end(); return; }
            response.writeHead(200, {
                'Content-Type': 'text/html', 'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'",
            });
            response.end('<!doctype html><title>Private worker rollout</title><button id="rollout-start">Export synthetic data</button><button id="rollout-cancel">Cancel export</button><script src="./' +
                (scenario === 'old-on-new' ? 'legacy' : 'current') + '.js"></script>');
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
        const browser = await playwright.chromium.connectOverCDP(endpoint.href, { artifactsDir });
        expect(browser.version()).toBe(owner.browserVersion);
        expect(browser.contexts()).toHaveLength(1);
        const context = browser.contexts()[0];
        expect(context.serviceWorkers()).toHaveLength(0);
        expect(context.pages().every((p) => p.url() === 'about:blank')).toBe(true);
        const row = new Map<Worker, { id: number; closed: boolean }>();
        const seen = (worker: Worker) => {
            if (row.has(worker)) return;
            if (row.size >= 2) throw Error('More than two rollout worker generations.');
            const state = { id: row.size + 1, closed: false }; row.set(worker, state);
            worker.once('close', () => { state.closed = true; });
        };
        context.on('serviceworker', seen);
        // SDK routing is an additional guard, not an OS/service-worker egress sandbox.
        await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = context.pages()[0] ?? await context.newPage();
        const downloads: Promise<RetainedDownload>[] = [], heldCopyOwners: unknown[] = [];
        const downloadFaults: string[] = [];
        let downloadEvents = 0;
        evidence.downloadCopies = [];
        page.on('download', (download) => {
            const number = ++downloadEvents;
            if (scenario === 'prepare-takeover' || scenario === 'new-on-old') downloadFaults.push('Unexpected managed download in a pre-frame ownership scenario.');
            if (number > 2) { downloadFaults.push('Rollout download bound exceeded; external owner retained.'); return; }
            downloads.push(retainSuccessfulDownload(download, number, retained, heldCopyOwners).then((copy) => {
                (evidence.downloadCopies as RetainedDownload[]).push(copy); return copy;
            }));
            // Retain failure until the final receipt; do not create an unhandled rejection.
            void downloads.at(-1)!.catch(() => {});
        });
        await page.goto(origin + '/rollout/');
        await page.waitForFunction(() => Boolean(window.exportRollout));
        await page.evaluate(() => window.exportRollout.boot());
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        await page.evaluate(() => window.exportRollout.seed());
        const snapshot = () => page.evaluate(() => window.exportRollout.snapshot());
        const observe = async (worker: Worker): Promise<WorkerState | undefined> => {
            if (row.get(worker)?.closed) return undefined;
            try { return await worker.evaluate(async () => ({ rollout: (globalThis as any).__exportRolloutWorker.snapshot(), product: await (globalThis as any).__memoryProductWorker.snapshot() })); }
            catch (error) { evidence.workerObservationUncertain = String(error).slice(0, 512); return undefined; }
        };
        await expect.poll(() => context.serviceWorkers().length).toBe(1);
        const original = context.serviceWorkers()[0]; seen(original);
        await expect.poll(async () => Boolean(await observe(original))).toBe(true);
        expect((await snapshot()).generation).toBe(scenario === 'old-on-new' ? 'pre-fix-candidate' : 'candidate91-r1');
        expect((await observe(original))!.rollout.generation).toBe(scenario === 'new-on-old' ? 'pre-fix-candidate' : 'candidate91-r1');
        const arm = (name: 'prepare' | 'release', mode = 'hold') => original.evaluate(({ name, mode }) => (globalThis as any).__exportRolloutWorker.arm(name, mode), { name, mode });
        const entered = (name: string) => expect.poll(async () => (await observe(original))?.rollout.gates.some((g) => g.name === name && g.entered)).toBe(true);
        const release = (name: string) => original.evaluate((name) => (globalThis as any).__exportRolloutWorker.release(name), name);
        if (scenario === 'control-held') {
            await page.locator('#rollout-start').click();
            await expect.poll(async () => (await snapshot()).attempts[0]?.completed.state).toBe('resolved');
            expect((await snapshot()).helper?.activeExports).toBe(0);
            await arm('release');
            await page.locator('#rollout-start').click();
            await entered('release');
            await page.locator('#rollout-cancel').click(); await page.locator('#rollout-cancel').click();
            const held = await snapshot(); evidence.held = { page: held, worker: await observe(original) };
            expect(held.attempts[1].completed.state).toBe('pending');
            expect(held.attempts[1].cancel.state).toBe('pending'); expect(held.helper?.activeExports).toBe(1);
            await release('release');
            await expect.poll(async () => (await snapshot()).attempts[1].cancel.state).toBe('resolved');
            await expect.poll(async () => (await snapshot()).helper?.activeExports).toBe(0);
            // Success can legitimately win before Cancel. Either final result needs true retirement.
            expect((await observe(original))?.rollout.pins.every((p) => p.calls === 1 && p.delegated === 1 && p.released)).toBe(true);
            const proof = (await observe(original))?.rollout.events.find((e) => e.type === 'reply' &&
                e.detail.type === 'capture-export-cancel' && e.detail.value?.id === held.attempts[1].id && e.detail.value.retirement === 'acknowledged');
            expect(proof).toBeTruthy(); evidence.receipt = proof!.detail.value;
            evidence.jobRetirementAcknowledged = true;
        } else if (scenario === 'new-on-old') {
            await page.locator('#rollout-start').click();
            await expect.poll(async () => (await snapshot()).attempts[0]?.diagnostics.length).toBeGreaterThan(0);
            expect((await snapshot()).attempts[0].start.state).toBe('pending');
            expect((await snapshot()).helper?.activeExports).toBe(1);
            expect((await snapshot()).frames).toBe(0);
            evidence.classification = 'legacy-capability-blocked-not-deployed-acceptance';
        } else if (scenario === 'release-rejected') {
            await arm('release', 'reject'); await page.locator('#rollout-start').click(); await entered('release');
            await expect.poll(async () => (await observe(original))?.product.jobs[0]?.retirement).toBe('blocked');
            await page.locator('#rollout-cancel').click(); await page.locator('#rollout-cancel').click();
            const blocked = await snapshot(), worker = await observe(original);
            expect(blocked.attempts[0].completed.state).toBe('pending'); expect(blocked.attempts[0].cancel.state).toBe('pending');
            expect(blocked.helper?.activeExports).toBe(1); expect(worker?.rollout.pins[0].calls).toBe(1); expect(worker?.rollout.pins[0].delegated).toBe(0);
            evidence.blocked = { page: blocked, worker }; evidence.classification = 'observed-blocked-owner-retained';
        } else {
            await arm('prepare'); await page.locator('#rollout-start').click(); await entered('prepare');
            const before = await snapshot(); evidence.beforeTakeover = { page: before, worker: await observe(original) };
            expect((await observe(original))!.rollout.events.filter((e) => e.type === 'request' && e.detail.type === 'capture-export-prepare')).toHaveLength(1);
            revision = 'worker2';
            await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(new URL('./', document.baseURI)); if (!registration) throw Error('Missing rollout registration.'); await registration.update(); });
            await expect.poll(async () => (await snapshot()).controls.length).toBeGreaterThan(0);
            await expect.poll(() => context.serviceWorkers().some((worker) => worker !== original)).toBe(true);
            for (const worker of context.serviceWorkers()) if (worker !== original) {
                const replacement = await observe(worker);
                if (replacement) expect(replacement.rollout.generation).toBe('candidate91-r2');
                else evidence.replacementGenerationUnobserved = true;
            }
            const alive = await observe(original);
            if (alive) { try { await release('prepare'); } catch (error) { evidence.oldOwnerReleaseUncertain = String(error).slice(0, 512); } }
            else evidence.oldOwnerLossObserved = row.get(original)?.closed ?? false;
            if (scenario === 'prepare-takeover') {
                await expect.poll(async () => (await snapshot()).attempts[0]?.diagnostics.length).toBeGreaterThan(0);
                expect((await snapshot()).frames).toBe(0);
                const old = await observe(original);
                if (old) expect(old.rollout.events.filter((e) => e.type === 'request' && e.detail.type === 'capture-export-prepare')).toHaveLength(1);
                else evidence.finalOriginalPrepareCount = null;
                for (const worker of context.serviceWorkers()) if (worker !== original) {
                    const replacement = await observe(worker);
                    if (replacement) expect(replacement.rollout.events.filter((e) => e.type === 'request' && e.detail.type === 'capture-export-prepare')).toHaveLength(0);
                    else evidence.replacementRequestsUnobserved = true;
                }
                // An unavailable original is not a matching positive receipt or a forced late reply.
                evidence.classification = old ? 'takeover-old-owner-observed' : 'takeover-owner-uncertain';
            } else evidence.classification = 'pre-fix-page-characterization-not-safety-acceptance';
        }
        evidence.page = await snapshot();
        evidence.workers = await Promise.all([...row].map(async ([worker, state]) => ({ ...state, url: worker.url(), observation: await observe(worker) ?? null })));
        evidence.downloads = await Promise.allSettled(downloads);
        evidence.downloadEvents = downloadEvents;
        evidence.downloadFaults = downloadFaults;
        evidence.unsettledCopyOwnerCount = heldCopyOwners.length;
        expect(downloadFaults).toEqual([]);
        if (scenario === 'prepare-takeover' || scenario === 'new-on-old') expect(downloadEvents).toBe(0);
        if (scenario === 'control-held') {
            expect(downloadEvents).toBeGreaterThanOrEqual(1);
            expect((evidence.downloadCopies as RetainedDownload[]).find((copy) => copy.number === 1)?.state).toBe('retained-success');
        }
        expect(heldCopyOwners).toHaveLength(0);
        expect((evidence.downloadCopies as RetainedDownload[]).some((copy) => copy.state === 'copy-unavailable-or-failed')).toBe(false);
        evidence.status = 'protocol-observations-only-native-shutdown-unqualified';
    } catch (error) {
        failed = true; primary = error;
        evidence.status = 'failed-or-inconclusive'; evidence.error = String(error).slice(0, 2048);
    } finally {
        // The separately admitted browser owner retains all contexts/profiles/jobs. No browser.close,
        // unregister, record deletion, signal or forced disposal is hidden in this test's teardown.
        // A retained pre-close receipt remains available if ordinary server close never acknowledges.
        try { await save('preclose-observations.json'); }
        catch (error) {
            evidence.checkpointFailure = String(error).slice(0, 512);
            primary = failed ? new AggregateError([primary, error], 'Rollout and checkpoint failed.', { cause: primary }) : error;
            failed = true;
        }
        try {
            if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
            evidence.serverCloseAcknowledged = true;
        } catch (error) {
            evidence.status = 'failed-or-inconclusive';
            evidence.serverCloseFailure = String(error).slice(0, 512);
            primary = failed ? new AggregateError([primary, error], 'Rollout and server closure failed.', { cause: primary }) : error;
            failed = true;
        }
        if (failed) evidence.status = 'failed-or-inconclusive';
        try { await save('observations.json'); }
        catch (error) {
            primary = failed ? new AggregateError([primary, error], 'Rollout and final evidence failed.', { cause: primary }) : error;
            failed = true;
        }
    }
    if (failed) throw primary;
});
