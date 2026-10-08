import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../fixtures/snapshots';

async function importFixture(page: import('@playwright/test').Page) {
    await page.getByLabel('Import diagnostic report').setInputFiles({
        name: 'motion.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(demoSnapshot())),
    });
    await expect(page.getByText('IMPORTED REPORT', { exact: true })).toBeVisible();
}

test('web always animates pages and hover under system reduced motion without a selector', async ({
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByLabel('Animations', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
        true,
    );
    await importFixture(page);
    const tile = page.locator('.hardware-tile').first();
    await tile.hover();
    await expect
        .poll(() =>
            tile.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42),
        )
        .toBeLessThan(-2);
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).animationName)).toBe(
        'page-enter',
    );
    await page.getByRole('button', { name: /^Diagnostics \d+$/ }).click();
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).animationName)).toBe(
        'page-enter',
    );
    await page.locator('.probe-card').first().hover();
    await expect
        .poll(() =>
            page
                .locator('.probe-card')
                .first()
                .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42),
        )
        .toBeLessThan(-2);
});

test('previous motion preferences do not disable animations after upgrading or reloading', async ({
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    for (const saved of ['reduced', 'system']) {
        await page.evaluate((value) => localStorage.setItem('diagnostic-hub.motion', value), saved);
        await page.reload();
        await expect(page.getByLabel('Animations', { exact: true })).toHaveCount(0);
        expect(
            await page.locator('main').evaluate((el) => getComputedStyle(el).animationName),
        ).toBe('page-enter');
        await page.getByRole('button', { name: 'Connect device', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
    }
});
