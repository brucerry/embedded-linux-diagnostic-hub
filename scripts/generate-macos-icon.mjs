import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const svg = await readFile('public/app-icon.svg', 'utf8');
const browser = await chromium.launch();
try {
    const page = await browser.newPage({
        deviceScaleFactor: 1,
        viewport: { width: 1024, height: 1024 },
    });
    await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true });
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    await mkdir('release', { recursive: true });
    await writeFile('release/macos-icon.png', png);
    console.log('Generated 1024x1024 Mac build icon from the shared SVG brand.');
} finally {
    await browser.close();
}
