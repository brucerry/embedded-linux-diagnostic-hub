const { app, protocol, BrowserWindow } = require('electron');

protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
globalThis.documentGateHit = false;
globalThis.documentGate = new Promise((resolve) => {
    globalThis.releaseDocument = resolve;
});
app.whenReady().then(() => {
    protocol.handle('app', async () => {
        globalThis.documentGateHit = true;
        await globalThis.documentGate;
        return new Response(
            '<!doctype html><html><body><button>Connect device</button><script>window.diagnosticHub={connect(){}};</script></body></html>',
            { headers: { 'content-type': 'text/html' } },
        );
    });
    const window = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.loadURL('app://bundle/index.html');
});
