import { expect, test } from '@playwright/test';
import type { UpdateProgress } from '../../shared/types';
import { installDesktop } from './fixtures/desktop';

interface UpdateFailureState {
    checks: boolean[];
    starts: string[];
    pending: boolean;
    listenerCount: number;
    subscriptions: number;
    unsubscriptions: number;
    emittedStages: string[];
    emit(value: UpdateProgress): void;
    rejectRetiredFailure(message: string): void;
}
declare global {
    interface Window { updateFailureTest: UpdateFailureState; }
}

test('Update dialog keeps completed downloads unverified and preserves retired failures through explicit retry', async ({ page }, info) => {
    await installDesktop(page);
    await page.addInitScript(() => {
        const bridge = window.diagnosticHub!;
        const listeners = new Set<(value: UpdateProgress | string) => void>();
        let pending: { reject(error: Error): void } | undefined;
        const state: UpdateFailureState = {
            checks: [], starts: [], pending: false, listenerCount: 0,
            subscriptions: 0, unsubscriptions: 0, emittedStages: [],
            emit(value) {
                if (!pending) throw Error('No admitted synthetic update attempt.');
                if (state.emittedStages.length >= 12) throw Error('Synthetic progress bound exceeded.');
                state.emittedStages.push(value.stage);
                for (const callback of listeners) callback(value);
            },
            rejectRetiredFailure(message) {
                if (!pending || message.length > 512) throw Error('Invalid synthetic failure disposition.');
                // Model a fully acknowledged failure only, never unresolved native custody.
                state.emit({ stage: 'failed', message });
                const owned = pending;
                pending = undefined;
                state.pending = false;
                owned.reject(Error(message));
            },
        };
        window.updateFailureTest = state;
        bridge.onUpdateProgress = callback => {
            listeners.add(callback);
            state.subscriptions++;
            state.listenerCount = listeners.size;
            return () => {
                if (listeners.delete(callback)) state.unsubscriptions++;
                state.listenerCount = listeners.size;
            };
        };
        bridge.checkUpdates = async include => {
            state.checks.push(include);
            return {
                currentVersion: '0.6.0',
                installable: true,
                release: {
                    version: '0.6.1-rc.1', prerelease: true,
                    publishedAt: '2026-10-14T00:00:00.000Z',
                    notes: 'Synthetic UI fixture; no release lookup or payload.',
                },
            };
        };
        bridge.startUpdate = request => {
            if (pending) throw Error('Synthetic update already pending.');
            if (state.starts.length >= 2) throw Error('Synthetic attempt bound exceeded.');
            state.starts.push(request.mode);
            window.desktopTest.requests.push(request);
            state.pending = true;
            return new Promise<void>((_resolve, reject) => { pending = { reject }; });
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Application updates', exact: true });
    const start = modal.getByRole('button', { name: 'Start update', exact: true });
    const check = modal.getByRole('button', { name: 'Check again', exact: true });
    const cancel = modal.getByRole('button', { name: 'Cancel update', exact: true });
    await expect(start).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.updateFailureTest.listenerCount)).toBe(1);
    const emit = (value: UpdateProgress) => page.evaluate(progress => window.updateFailureTest.emit(progress), value);
    const reject = (message: string) => page.evaluate(text => window.updateFailureTest.rejectRetiredFailure(text), message);
    const firstFailure = 'Release checksum verification failed. No update was installed.';
    const secondFailure = 'The release is not a compatible portable executable.';
    const staging = '/synthetic-only/release.part';

    await start.click();
    await expect.poll(() => page.evaluate(() => window.updateFailureTest.pending)).toBe(true);
    for (const button of [start, check, cancel, modal.getByRole('button', { name: 'Close dialog', exact: true })])
        await expect(button).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await emit({ stage: 'download', message: 'Downloading release bytes…', receivedBytes: 4, totalBytes: 8, stagingPath: staging });
    const download = modal.getByRole('progressbar', { name: 'Release download progress', exact: true });
    await expect(download).toHaveAttribute('value', '4');
    await expect(download).toHaveAttribute('max', '8');
    await expect(modal).toContainText('50%');
    await emit({ stage: 'download', message: 'Downloading release bytes…', receivedBytes: 8, totalBytes: 8, stagingPath: staging });
    await expect(modal).toContainText('100%');
    await expect(modal).toContainText('Verification follows.');
    await expect(modal.getByText('Verified launchable app:')).toHaveCount(0);
    await emit({ stage: 'verify', message: 'Verifying size, SHA-256 and executable format…', stagingPath: staging });
    await expect(modal.getByRole('progressbar', { name: 'Current update stage progress', exact: true })).not.toHaveAttribute('value');
    await expect(modal).not.toContainText('100%');
    await expect(modal).toContainText('Temporary staging file:');
    await expect(start).toBeDisabled();

    await reject(firstFailure);
    await expect(modal.getByRole('alert')).toHaveText(firstFailure);
    await expect(modal.getByRole('region', { name: 'Update progress', exact: true })).toHaveCount(0);
    await expect(modal.getByText('Verified launchable app:')).toHaveCount(0);
    for (const button of [start, check, cancel]) await expect(button).toBeEnabled();
    expect(await page.evaluate(() => window.updateFailureTest.starts)).toEqual(['clean']);
    expect(await page.evaluate(() => window.updateFailureTest.pending)).toBe(false);

    // A new check and a second Start are explicit user actions after acknowledged failure.
    await check.click();
    await expect(start).toBeEnabled();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.updateFailureTest.checks)).toEqual([true, true]);
    await start.click();
    await expect.poll(() => page.evaluate(() => window.updateFailureTest.pending)).toBe(true);
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await expect(modal.getByRole('progressbar', { name: 'Current update stage progress', exact: true })).not.toHaveAttribute('value');
    await expect(modal).not.toContainText(staging);
    await expect(modal).not.toContainText('100%');
    await emit({ stage: 'download', message: 'Downloading release bytes…', receivedBytes: 0, totalBytes: 8, stagingPath: staging });
    await emit({ stage: 'download', message: 'Downloading release bytes…', receivedBytes: 8, totalBytes: 8, stagingPath: staging });
    await emit({ stage: 'verify', message: 'Verifying size, SHA-256 and executable format…', stagingPath: staging });
    await reject(secondFailure);
    await expect(modal.getByRole('alert')).toHaveText(secondFailure);
    await expect(modal).not.toContainText(firstFailure);
    await expect(modal.getByText('Verified launchable app:')).toHaveCount(0);
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.updateFailureTest.listenerCount)).toBe(0);
    const observed = await page.evaluate(() => ({
        checks: window.updateFailureTest.checks,
        starts: window.updateFailureTest.starts,
        pending: window.updateFailureTest.pending,
        listenerCount: window.updateFailureTest.listenerCount,
        subscriptions: window.updateFailureTest.subscriptions,
        unsubscriptions: window.updateFailureTest.unsubscriptions,
        emittedStages: window.updateFailureTest.emittedStages,
        requestModes: window.desktopTest.requests.map(request => request.mode),
        connects: window.desktopTest.connects,
        disconnects: window.desktopTest.disconnects,
        collects: window.desktopTest.collects,
        releasesOpened: window.desktopTest.releasesOpened,
    }));
    expect(observed.starts).toEqual(['clean', 'clean']);
    expect(observed.requestModes).toEqual(['clean', 'clean']);
    expect(observed.pending).toBe(false);
    expect(observed.listenerCount).toBe(0);
    expect(observed.subscriptions).toBe(observed.unsubscriptions);
    expect([observed.connects, observed.disconnects, observed.collects, observed.releasesOpened]).toEqual([0, 0, 0, 0]);
    expect(observed.emittedStages).toEqual(['download', 'download', 'verify', 'failed', 'download', 'download', 'verify', 'failed']);
    await info.attach('update-failure-ui-acceptance', {
        body: JSON.stringify({ observed, fixtureMode: 'in-memory bridge only', modeledFailures: 'fully acknowledged retirement only', nativeIOCovered: false, nativeUpdateDownloadsCovered: false, nativeInstallerCovered: false }),
        contentType: 'application/json',
    });
});
