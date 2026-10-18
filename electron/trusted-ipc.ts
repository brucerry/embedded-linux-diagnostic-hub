interface Frame {
    url: string;
}
interface WindowLike {
    isDestroyed(): boolean;
    webContents: { mainFrame: Frame };
}
interface EventLike {
    sender: unknown;
    senderFrame?: Frame | null;
}
/** Pin every privileged call to this window's exact current main frame and application URL. */
export function trustedFrameHandler(
    window: () => WindowLike,
    appUrl: string,
    handler: (...args: unknown[]) => unknown,
) {
    return (event: EventLike, ...args: unknown[]) => {
        const current = window();
        if (
            current.isDestroyed() ||
            event.sender !== current.webContents ||
            event.senderFrame !== current.webContents.mainFrame ||
            event.senderFrame?.url !== appUrl
        )
            throw Error('Untrusted application frame.');
        return handler(...args);
    };
}

/** Recheck document identity after initialization before allowing a privileged operation. */
export function trustedFrameReadyHandler<T>(
    window: () => WindowLike,
    appUrl: string,
    generation: () => number,
    ready: () => Promise<T>,
    handler: (value: T, ...args: unknown[]) => unknown,
) {
    const authorize = trustedFrameHandler(window, appUrl, () => {});
    return async (event: EventLike, ...args: unknown[]) => {
        authorize(event);
        const epoch = generation(),
            value = await ready();
        authorize(event);
        if (epoch !== generation()) throw Error('Renderer changed during capture initialization.');
        return handler(value, ...args);
    };
}
