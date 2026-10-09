import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderTestPdf } from '../electron/test-documents';
import { validateTestReport } from '../shared/testing/report';
import type { TestReport } from '../shared/testing/types';
app.on('window-all-closed', () => {});

async function main() {
    await app.whenReady();
    const root = process.argv[2];
    await assert.rejects(renderTestPdf({} as TestReport));
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    for (const label of ['pending', 'mixed']) {
        const report = await validateTestReport(
            JSON.parse(await readFile(path.join(root, label + '.json'), 'utf8')),
        );
        const generated = renderTestPdf(report),
            view = BrowserWindow.getAllWindows()[0],
            prefs = (
                view.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }
            ).getLastWebPreferences();
        assert.equal(prefs.sandbox, true);
        assert.equal(prefs.nodeIntegration, false);
        assert.equal(prefs.contextIsolation, true);
        assert.equal(prefs.javascript, false);
        assert.ok(!prefs.preload);
        assert.equal(view.isVisible(), false);
        await assert.rejects(renderTestPdf(report), /already/);
        const data = await generated;
        assert.equal(data.subarray(0, 5).toString(), '%PDF-');
        await writeFile(path.join(root, label + '-native.pdf'), data);
        assert.equal(BrowserWindow.getAllWindows().length, 0);
    }
    const report = await validateTestReport(
        JSON.parse(await readFile(path.join(root, 'mixed.json'), 'utf8')),
    );
    const load = BrowserWindow.prototype.loadURL;
    try {
        BrowserWindow.prototype.loadURL = () => new Promise<void>(() => {});
        await assert.rejects(renderTestPdf(report), /30-second/);
        assert.equal(BrowserWindow.getAllWindows().length, 0);
    } finally {
        BrowserWindow.prototype.loadURL = load;
    }
    assert.equal((await renderTestPdf(report)).subarray(0, 5).toString(), '%PDF-');
    console.log(
        'Native PDF generation, failure/timeout cleanup, exclusivity and renderer sandbox verified.',
    );
    app.exit(0);
}
main().catch((error) => {
    console.error(error);
    app.exit(1);
});
