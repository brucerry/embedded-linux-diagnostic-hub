export const readWindow = async ({ app, BrowserWindow }, marker) => {
    const current = BrowserWindow.getAllWindows();
    if (current.length !== 1 || current[0].webContents.getURL() !== 'app://bundle/index.html')
        throw Error('Native visible window does not identify one packaged BrowserWindow.');
    const contents = current[0].webContents;
    function frame() {
        if (BrowserWindow.getAllWindows().length !== 1 || !current[0].isVisible() ||
            contents.getURL() !== 'app://bundle/index.html')
            throw Error('Packaged main window changed.');
        const primary=contents.mainFrame;
        const kernelPID=contents.getOSProcessId();
        if (!primary || primary.isDestroyed() || primary.detached || primary.osProcessId!==kernelPID ||
            primary.processId!==contents.getProcessId())
            throw Error('Native primary frame does not match its renderer.');
        return {windowId:current[0].id,contentsId:contents.id,treeId:primary.frameTreeNodeId,
                chromiumPid:primary.processId,routingId:primary.routingId,frameToken:primary.frameToken,
                pid:kernelPID,url:contents.getURL()};
    }
    const frameIdentity=frame();
    if (marker===null) return {frameIdentity};
    function requireSame() {
        if (JSON.stringify(frame())!==JSON.stringify(frameIdentity))
            throw Error('Native primary frame changed while sampling its contexts.');
    }
    // Public APIs observe separate worlds and the actual OS renderer. Preload process
    // globals need not remain globally exposed after its sandbox wrapper returns.
    const key = JSON.stringify(marker);
    await contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `globalThis[${key}]=true` },
    ]);
    requireSame();
    let isolated;
    try {
        isolated = await contents.executeJavaScript(
            `typeof globalThis[${key}] === 'undefined'`,
        );
        requireSame();
    } finally {
        requireSame();
        await contents.executeJavaScriptInIsolatedWorld(999, [
            { code: `delete globalThis[${key}]` },
        ]);
    }
    const noPageNode = await contents.executeJavaScript(
        'typeof process === "undefined" && typeof require === "undefined"',
    );
    requireSame();
    return {
        asset: process.env.HUB_STAGED_ASSET,
        mainPID: process.pid,
        original: process.env.APPIMAGE,
        extractionRoot:process.env.APPDIR,
        runtimeTmp:process.env.TMPDIR,
        extractAndRun:process.env.APPIMAGE_EXTRACT_AND_RUN,
        profile:app.getPath('userData'),
        packaged: app.isPackaged,
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        executable: process.execPath,
        asar: app.getAppPath(),
        rendererPID: frameIdentity.pid,
        frameIdentity,
        contextsSeparated: isolated === true,
        pageNodeAbsent: noPageNode === true,
        versions: {
            node: process.versions.node,
            electron: process.versions.electron,
            chrome: process.versions.chrome,
        },
        sandbox:
            isolated === true &&
            noPageNode === true &&
            !process.argv.includes('--no-sandbox'),
    };
};
