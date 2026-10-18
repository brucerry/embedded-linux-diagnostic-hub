import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
assert(process.connected && process.env.HUB_NATIVE_PILOT_STAGE === '1');
const raw = JSON.parse(process.argv[2]);
assert(
    raw.gated === true && typeof raw.nonce === 'string' && /^[a-f0-9]{64}$/.test(raw.bindingSHA256),
);
const controller = new AbortController();
let esbuild: any,
    stopped = false,
    sequence = 0,
    credit: any,
    cancellation = false;
const send = (value: any) =>
    new Promise<void>((resolve, reject) =>
        process.send!(value, (e) => (e ? reject(e) : resolve())),
    );
let queue = Promise.resolve();
const emit = (stage: string, data: any = {}) => {
    const task = queue.then(async () => {
        assert(process.connected);
        const current = sequence++;
        const message = {
            kind: 'native-runtime-event',
            nonce: raw.nonce,
            bindingSHA256: raw.bindingSHA256,
            sequence: current,
            stage,
            data,
        };
        assert(Buffer.byteLength(JSON.stringify(message)) <= 8192 && current < 128);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(Error('Runtime phase ACK missing')),
                Math.max(
                    0,
                    Math.min(
                        10000,
                        raw.cleanupDeadline - Number(process.hrtime.bigint() / 1000000n),
                    ),
                ),
            );
            credit = {
                sequence: current,
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
                reject: (e: unknown) => {
                    clearTimeout(timer);
                    reject(e);
                },
            };
            void send(message).catch(credit.reject);
        });
    });
    queue = task.catch(() => {});
    return task;
};
const note = (stage: string, data: any = {}) => {
    void emit(stage, data).catch((e) => console.error(String(e)));
};
const stop = () => {
    if (stopped) return;
    stopped = true;
    note('esbuild-stop-before', { started: Boolean(esbuild) });
    try {
        esbuild?.stop();
        note('esbuild-stop-after', { returned: true });
    } catch (e) {
        note('esbuild-stop-after', { returned: false, error: String(e).slice(0, 1024) });
        throw e;
    }
};
const cancel = (reason: string) => {
    if (cancellation) return;
    cancellation = true;
    // Acknowledgement and transport are distinct from actual stop/exit/pipe closure.
    if (process.connected)
        void send({
            kind: 'native-runtime-cancel-ack',
            nonce: raw.nonce,
            bindingSHA256: raw.bindingSHA256,
            reason,
        }).catch(() => {});
    controller.abort(Error(reason));
    stop();
};
for (const e of ['SIGTERM', 'SIGINT', 'disconnect'])
    process.on(e, () => cancel('Runtime worker ' + e));
let admit!: () => void;
const admitted = new Promise<void>((resolve) => {
    admit = resolve;
});
process.on('message', (m: any) => {
    if (m?.kind === 'native-runtime-event-ack') {
        if (
            m.nonce === raw.nonce &&
            m.bindingSHA256 === raw.bindingSHA256 &&
            m.sequence === credit?.sequence
        ) {
            credit.resolve();
            credit = undefined;
        } else credit?.reject(Error('Unbound runtime phase ACK'));
    } else if (m?.kind === 'admit-native-runtime') {
        if (
            m.nonce !== raw.nonce ||
            m.bindingSHA256 !== raw.bindingSHA256 ||
            m.deadline !== raw.deadline
        )
            cancel('Invalid runtime admission');
        else admit();
    } else if (m?.kind === 'cancel-native-pilot-build')
        cancel(m.reason ?? 'Runtime owner cancelled');
});
const timer = setTimeout(
    () => cancel('Runtime worker absolute deadline'),
    Math.max(0, raw.deadline - Number(process.hrtime.bigint() / 1000000n)),
);
try {
    await send({
        kind: 'native-runtime-ready',
        nonce: raw.nonce,
        bindingSHA256: raw.bindingSHA256,
        pid: process.pid,
    });
    await Promise.race([
        admitted,
        new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
                once: true,
            });
            if (controller.signal.aborted) reject(controller.signal.reason);
        }),
    ]);
    controller.signal.throwIfAborted();
    await emit('runtime-worker-admitted', { pid: process.pid });
    const { prepareMemoryRuntime } = await import('../../scripts/memory-runtime.mjs');
    controller.signal.throwIfAborted();
    esbuild = createRequire(import.meta.url)('esbuild');
    const result = await prepareMemoryRuntime(raw.root, raw.outputParent, {
        signal: controller.signal,
        deadline: raw.deadline,
        emit,
        cancelBuild: stop,
    });
    controller.signal.throwIfAborted();
    await send({
        kind: 'native-runtime-result',
        nonce: raw.nonce,
        bindingSHA256: raw.bindingSHA256,
        result,
    });
} catch (e) {
    console.error(String(e));
    note('runtime-worker-failed', {
        error: String(e).slice(0, 1024),
        cancelled: controller.signal.aborted,
    });
    process.exitCode = 1;
} finally {
    clearTimeout(timer);
    stop();
    await queue;
    if (process.connected) process.disconnect();
}
