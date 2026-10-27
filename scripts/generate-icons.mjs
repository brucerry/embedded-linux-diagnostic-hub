import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const svg = await readFile('public/app-icon.svg', 'utf8');
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    const sizes = [16, 24, 32, 48, 64, 128, 256],
        images = [];
    for (const size of sizes) {
        await page.setViewportSize({ width: size, height: size });
        images.push(await page.screenshot({ omitBackground: true }));
    }
    await writeFile('public/app-icon.png', images.at(-1));
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach((png, index) => {
        const at = 6 + index * 16;
        header[at] = header[at + 1] = sizes[index] === 256 ? 0 : sizes[index];
        header.writeUInt16LE(1, at + 4);
        header.writeUInt16LE(32, at + 6);
        header.writeUInt32LE(png.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    await writeFile('public/app-icon.ico', Buffer.concat([header, ...images]));
    console.log('Generated PNG and seven-resolution ICO from the shared SVG brand icon.');
} finally {
    await browser.close();
}
