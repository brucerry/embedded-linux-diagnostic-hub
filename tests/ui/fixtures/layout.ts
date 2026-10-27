import { expect, type Page } from '@playwright/test';

// Scroll continuity starts after navigation's finite entry transitions, not while
// their transforms are still changing the document's maximum scroll extent.
export async function settlePageEntry(page: Page) {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const main = document.querySelector('main');
                if (!main) return -1;
                main.getBoundingClientRect();
                return main.getAnimations().filter((animation) => {
                    const iterations = animation.effect?.getTiming().iterations ?? 1;
                    return (
                        Number.isFinite(iterations) &&
                        (animation.pending ||
                            animation.playState === 'running' ||
                            animation.playState === 'paused')
                    );
                }).length;
            }),
        )
        .toBe(0);
}

export async function scrollGeometry(page: Page) {
    return page.evaluate(() => {
        const main = document.querySelector('main');
        const box = main?.getBoundingClientRect();
        return {
            scrollY: window.scrollY,
            maximum: document.documentElement.scrollHeight - innerHeight,
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: innerHeight,
            main: box && { y: box.y, height: box.height, bottom: box.bottom },
            animations: main?.getAnimations().map((animation) => ({
                state: animation.playState,
                pending: animation.pending,
                time: animation.currentTime,
            })),
            fonts: document.fonts.status,
            bodyOverflow: getComputedStyle(document.body).overflow,
        };
    });
}
