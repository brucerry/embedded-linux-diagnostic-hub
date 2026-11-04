import { test, expect, type Page, type Locator, type Download } from '@playwright/test';
import { openSync, readSync, closeSync, fstatSync, lstatSync, realpathSync, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { consoleFixture } from '../fixtures/ssh-console';
import { allocateLoopbackGateway } from './fixtures/loopback-console-gateway';
import { installLoopbackPassiveObserver } from './fixtures/loopback-passive-observer';
let currentOwner: ReturnType<typeof allocateLoopbackGateway> | undefined;
test.afterEach(async () => { await currentOwner?.close(); });
async function readOwnedDownload(download: Download, owner: ReturnType<typeof allocateLoopbackGateway>, budget: { remaining: number }) {
    const file = await download.path();
    const temporary = realpathSync(path.join(process.env.HUB_LOOPBACK_CONSOLE_SCOPE!, 'tmp'));
    if (!file || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(temporary + path.sep))
        throw Error('Download is not a regular owned CI temporary file.');
    const cap = Math.min(4 * 1024 * 1024, budget.remaining);
    if (cap < 1) throw Error('Combined download read bound exceeded.');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    owner.fileOpened();
    let primary: unknown, text = '', bytes = 0, sha256 = '';
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > cap) throw Error('Download read bound exceeded.');
        const buffer = Buffer.alloc(cap + 1);
        while (bytes < buffer.length) {
            const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (!count) break;
            bytes += count;
        }
        if (bytes > cap || bytes !== stat.size) throw Error('Download size changed or exceeded read bound.');
        const exact = buffer.subarray(0, bytes);
        text = exact.toString('utf8'); sha256 = createHash('sha256').update(exact).digest('hex');
        budget.remaining -= bytes;
    } catch (error) { primary = error; }
    try { closeSync(fd); owner.fileClosed(); }
    catch (error) {
        owner.fileCloseFailed();
        if (primary) throw new AggregateError([primary, error], 'Download read and file close failed.');
        throw error;
    }
    if (primary) throw primary;
    return { text, bytes, sha256 };
}
const flowRegion = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const stage = (flow: Locator, label: string) =>
    flow
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(label) })
        .click();
async function showConsole(page: Page) {
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    const flow = flowRegion(page);
    await stage(flow, 'Connection');
    await flow.getByLabel('SSH execution mode', { exact: true }).selectOption('console');
    await expect(
        flow.getByRole('heading', { name: 'Stored SSH console results', exact: true }),
    ).toBeVisible();
    await stage(flow, 'Timing');
    await expect(flow.getByLabel('Capture device time', { exact: true })).toHaveCount(0);
    await expect(
        flow.getByText(
            'Device time capture is unavailable in console mode. Console records use local receive time.',
            { exact: true },
        ),
    ).toBeVisible();
    await stage(flow, 'Connection');
    return flow;
}
async function connect(page: Page, gateway: Awaited<ReturnType<ReturnType<typeof allocateLoopbackGateway>['start']>>, owner: ReturnType<typeof allocateLoopbackGateway>) {
    await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
    const modal = page.getByRole('dialog', { name: 'Connect a Linux device' });
    await modal.getByLabel('Gateway HTTPS address').fill(gateway.url);
    await modal.getByLabel('Gateway access token').fill(gateway.token);
    await modal.getByLabel('Hostname or IP address').fill(gateway.options.host);
    await modal.getByLabel('Port', { exact: true }).fill(String(gateway.options.port));
    await modal.getByLabel('SSH username').fill(gateway.options.username);
    await modal.getByLabel('Password', { exact: true }).fill(gateway.options.password);
    await modal.getByRole('button', { name: 'Read fingerprint' }).click();
    await expect(modal.locator('.fingerprint-panel code')).toHaveText(gateway.pinned);
    owner.stage('fingerprint-verified');
    await modal.getByLabel('I verified this fingerprint with a trusted source.').check();
    owner.stage('connect-requested');
    await modal.getByRole('button', { name: 'Connect via SSH' }).click();
    await expect(modal).not.toBeVisible();
    owner.stage('dialog-closed');
}
test('actual authenticated gateway and browser journal keep Script/Enter/Enter/Script in one owned console', async ({
    page,
}, info) => {
    const model = consoleFixture({ fragment: 4 });
    const owner = allocateLoopbackGateway();
    currentOwner = owner;
    const failures: unknown[] = [], exports: { format: string; bytes: number; sha256: string }[] = [];
    const budget = { remaining: 8 * 1024 * 1024 };
    const allowed = new Set([new URL(test.info().project.use.baseURL as string).origin]);
    let blockedRequests = 0;
    let passive: ReturnType<typeof installLoopbackPassiveObserver> | undefined;
    await page.context().route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && allowed.has(url.origin)) return route.continue();
        blockedRequests++; return route.abort('blockedbyclient');
    });
    try {
        await page.goto('/');
        owner.stage('page-ready');
        const gateway = await owner.start(undefined, { ...model, origin: new URL(page.url()).origin });
        expect(gateway.options.host).toBe('127.0.0.1');
        expect(new URL(gateway.url).hostname).toBe('127.0.0.1');
        allowed.add(new URL(gateway.url).origin);
        passive = installLoopbackPassiveObserver(page, new URL(page.url()).origin, new URL(gateway.url).origin, owner);
        await connect(page, gateway, owner);
        // The application keeps its separate Terminal shell open across navigation.
        await expect.poll(() => model.state.opens).toBe(1);
        owner.stage('terminal-opened');
        const terminalShells = model.state.opens;
        const flow = await showConsole(page);
        await flow
            .getByLabel('SSH shell prompt alternatives', { exact: true })
            .fill('fixture:/root# \nfixture:/# ');
        await stage(flow, 'Commands');
        await flow.getByLabel('Command 1 script', { exact: true }).fill('cd /');
        for (let ordinal = 2; ordinal <= 4; ordinal++) {
            await flow.getByRole('button', { name: 'Add command', exact: true }).click();
            if (ordinal < 4)
                await flow
                    .getByLabel('Command ' + ordinal + ' SSH input', { exact: true })
                    .selectOption('send-enter');
            else await flow.getByLabel('Command 4 script', { exact: true }).fill('pwd');
        }
        await stage(flow, 'Timing');
        await flow.getByLabel('Command 3 delay', { exact: true }).fill('2');
        await stage(flow, 'Review');
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        owner.stage('flow-started');
        await expect.poll(() => model.state.inputs.length).toBeGreaterThan(0);
        await flow.getByRole('button', { name: 'Show flow', exact: true }).click();
        const viewer = page.getByRole('dialog', { name: 'Automation flow', exact: true });
        await expect(viewer).toContainText('combined PTY');
        await expect(viewer).toContainText('process exit status is unavailable');
        const graphEvent = page.waitForEvent('download');
        await viewer.getByRole('button', { name: 'Export SVG', exact: true }).click();
        const graphDownload = await graphEvent;
        expect(await graphDownload.failure()).toBeNull();
        const graphFile = await readOwnedDownload(graphDownload, owner, budget);
        exports.push({ format: 'svg', bytes: graphFile.bytes, sha256: graphFile.sha256 });
        const graphText = graphFile.text;
        const graph = await page.evaluate((xml) => {
            const document = new DOMParser().parseFromString(xml, 'image/svg+xml');
            return {
                parseErrors: document.querySelectorAll('parsererror').length,
                text: document.documentElement.textContent,
            };
        }, graphText);
        expect(graph.parseErrors).toBe(0);
        expect(graph.text).toContain('combined PTY');
        expect(graph.text).toContain('Completion criterion:');
        expect(graph.text).toContain('Send Enter (exact CR)');
        await viewer.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await expect(viewer).toHaveCount(0);
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        await expect(flow.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled({
            timeout: 20000,
        });
        await expect(flow.locator('.automation-state')).toContainText('Flow finished');
        await expect.poll(() => model.state.closes).toBe(1);
        expect(model.state.opens - terminalShells).toBe(1);
        expect(Buffer.concat(model.state.inputs).toString()).toBe('cd /\r\r\rpwd\r');
        expect(model.state.directories).toEqual(['/root', '/']);
        const results = flow.getByRole('region', {
            name: 'Stored SSH console results',
            exact: true,
        });
        await expect(results.locator('.console-result-card')).toHaveCount(1);
        await expect(results.locator('.console-result-card')).toContainText('Capture complete');
        await results.getByRole('button', { name: 'Preview flow', exact: true }).click();
        await expect(results.getByRole('region', { name: 'Console flow preview' })).toContainText(
            'Input write dispatched.',
        );
        await expect(results.getByRole('region', { name: 'Console flow preview' })).toContainText(
            'Send Enter',
        );
        const event = page.waitForEvent('download');
        await results.getByRole('button', { name: 'Export console evidence', exact: true }).click();
        const download = await event;
        expect(await download.failure()).toBeNull();
        const reportFile = await readOwnedDownload(download, owner, budget);
        exports.push({ format: 'json', bytes: reportFile.bytes, sha256: reportFile.sha256 });
        const report = JSON.parse(reportFile.text);
        const records = report.captures[0].records;
        expect(report.captures[0].capture.header.receiveTimeSource).toBe('gateway');
        expect(
            records.filter((r: any) => r.kind === 'outcome').map((r: any) => r.exitCode),
        ).toEqual([null, null, null, null]);
        expect(
            records
                .filter((r: any) => r.kind === 'segment-start' && r.segment.kind === 'command')
                .map((r: any) => Buffer.from(r.segment.requestBase64, 'base64').toString()),
        ).toEqual(['cd /\r', '\r', '\r', 'pwd\r']);
        expect(blockedRequests).toBe(0);
        owner.stage('exports-reached');
    } catch (error) {
        failures.push(error);
        owner.stage('case-failure');
        owner.caseFailure();
        try {
            const modal = page.getByRole('dialog', { name: 'Connect a Linux device' });
            owner.modalState(await modal.isVisible(), await modal.getByRole('button', { name: 'Connecting & collecting…', exact: true }).isVisible());
        } catch (diagnosticError) { failures.push(diagnosticError); }
    }
    finally {
        owner.stage('finally');
        owner.sampleProbeCommands();
        try { await owner.close(); } catch (error) { failures.push(error); }
        passive?.stop();
        if (owner.snapshot().listenerError) failures.push(Error('Unexpected loopback listener error was recorded.'));
        try {
            await info.attach('loopback-owned-summary', { contentType: 'application/json', body: JSON.stringify({
                ownership: owner.snapshot(), exports, blockedRequests,
                shellModel: 'synthetic', realOsShell: false, actualSshProtocol: true,
            }) });
        } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Loopback case and owned retirement failed.');
});
