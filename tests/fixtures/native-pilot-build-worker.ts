import assert from 'node:assert/strict';
import { prepareProductNativeBuild } from './memory-product-native-host';
import { pilotPathMap } from './native-pilot-paths';
assert(process.connected && process.env.HUB_NATIVE_PILOT_STAGE === '1');
const controller = new AbortController();
for (const e of ['SIGTERM', 'SIGINT', 'disconnect'])
    process.on(e, () => controller.abort(Error('Build owner cancelled')));
process.on('message', (m: any) => {
    if (m?.kind === 'cancel-native-pilot-build') controller.abort(Error('Build IPC cancellation'));
});
const raw = JSON.parse(process.argv[2]);
try {
    const result = await prepareProductNativeBuild({
        ...raw,
        pilot: pilotPathMap(raw.root, raw.nonce),
        signal: controller.signal,
        emit: async (stage, data) => {
            assert(process.connected);
            await new Promise<void>((resolve, reject) => {
                const ack = (m: any) => {
                    if (m?.kind === 'native-build-event-ack') {
                        clearTimeout(timer);
                        process.off('message', ack);
                        resolve();
                    }
                };
                const timer = setTimeout(() => {
                    process.off('message', ack);
                    reject(Error('Build durable ACK missing'));
                }, 10000);
                process.on('message', ack);
                void new Promise<void>((resolve, reject) =>
                    process.send!({ kind: 'native-build-event', stage, data }, (e) =>
                        e ? reject(e) : resolve(),
                    ),
                ).catch(reject);
            });
        },
    });
    controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) =>
        process.send!({ kind: 'native-build-result', result }, (e) => (e ? reject(e) : resolve())),
    );
} catch (e) {
    console.error(String(e));
    process.exitCode = 1;
} finally {
    const { stop } = await import('esbuild');
    stop();
    if (process.connected) process.disconnect();
}
