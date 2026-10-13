import { expect, type ElectronApplication, type Page } from '@playwright/test';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function captureNativeScreenshot(
    desktop: ElectronApplication,
    page: Page,
    filename: string,
) {
    // Playwright's installed library defaults to 30 seconds. Share that budget across
    // both captures and readiness; never grant a fresh deadline to the second attempt.
    const deadline = Date.now() + 30_000;
    const remaining = () => {
        const timeout = deadline - Date.now();
        if (timeout <= 0) throw Error('Native screenshot exhausted its original 30000-ms budget');
        return timeout;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
        const capture = async () => {
            const image = await page.screenshot({
                path: filename,
                fullPage: true,
                timeout: remaining(),
            });
            expect(image.length).toBeGreaterThan(33);
            expect(image.subarray(0, 8)).toEqual(PNG_SIGNATURE);
            expect(image.readUInt32BE(16)).toBeGreaterThan(0);
            expect(image.readUInt32BE(20)).toBeGreaterThan(0);
        };
        try {
            await capture();
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !error.message.startsWith(
                    'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot',
                )
            )
                throw error;
            remaining();
            const native = await desktop.evaluate(({ BrowserWindow, screen }) => {
                const windows = BrowserWindow.getAllWindows();
                const window = windows[0];
                return {
                    count: windows.length,
                    visible: window.isVisible(),
                    minimized: window.isMinimized(),
                    loading: window.webContents.isLoading(),
                    crashed: window.webContents.isCrashed(),
                    bounds: window.getBounds(),
                    workArea: screen.getDisplayMatching(window.getBounds()).workArea,
                };
            });
            console.warn('Native screenshot capture recovery:', JSON.stringify(native));
            expect(native).toMatchObject({
                count: 1,
                visible: true,
                minimized: false,
                loading: false,
                crashed: false,
            });
            // DOM visibility alone does not establish that the native capture surface exists.
            // Wait for two rendered frames with stable geometry, then require the same full-page
            // capture once more. A second protocol failure or any other error still fails the job.
            await page.waitForFunction(
                async () => {
                    if (
                        document.visibilityState !== 'visible' ||
                        document.readyState !== 'complete'
                    )
                        return false;
                    const before = [
                        innerWidth,
                        innerHeight,
                        document.documentElement.scrollWidth,
                        document.documentElement.scrollHeight,
                    ].join(',');
                    await new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    );
                    return (
                        document.visibilityState === 'visible' &&
                        [
                            innerWidth,
                            innerHeight,
                            document.documentElement.scrollWidth,
                            document.documentElement.scrollHeight,
                        ].join(',') === before
                    );
                },
                undefined,
                { polling: 'raf', timeout: remaining() },
            );
            await capture();
            console.log('Native screenshot capture recovered within its original budget.');
        }
    };
    try {
        await Promise.race([
            run(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(Error('Native screenshot exhausted its original 30000-ms budget')),
                    remaining(),
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
