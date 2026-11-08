export {};
const nonce = location.pathname.split('/').at(-1) ?? '',
    origin = location.origin;
function notify(type: string, error?: string) {
    parent.postMessage({ type, nonce, ...(error ? { error } : {}) }, origin);
}
const request = (message: unknown) =>
    new Promise<{ url: string; id: string }>((resolve, reject) => {
        const channel = new MessageChannel(),
            timer = setTimeout(() => {
                channel.port1.close();
                reject(Error('Export worker stopped responding.'));
            }, 10000);
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            channel.port1.close();
            event.data.ok ? resolve(event.data.value) : reject(Error(event.data.error));
        };
        navigator.serviceWorker.controller?.postMessage(message, [channel.port2]);
    });
void (async () => {
    try {
        if (parent === window || !navigator.serviceWorker.controller)
            throw Error('The controlled export helper is unavailable.');
        const job = await request({ type: 'capture-export-claim', nonce });
        window.addEventListener('message', function start(event) {
            if (
                event.source !== parent ||
                event.origin !== origin ||
                event.data?.type !== 'capture-export-start' ||
                event.data?.nonce !== nonce
            )
                return;
            window.removeEventListener('message', start);
            location.assign(job.url);
        });
        notify('capture-export-helper-ready');
    } catch (error) {
        notify(
            'capture-export-helper-error',
            String(error instanceof Error ? error.message : error).slice(0, 512),
        );
    }
})();
