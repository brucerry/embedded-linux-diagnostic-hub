import assert from 'node:assert/strict';
assert(process.connected && process.env.HUB_NATIVE_PILOT_STAGE === '1');
let cancelled = false;
for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) process.on(e, () => (cancelled = true));
process.on('message', (m: any) => {
    if (m?.kind === 'cancel-native-pilot-build') cancelled = true;
});
try {
    const { prepareMemoryRuntime } = await import('../../scripts/memory-runtime.mjs');
    const raw = JSON.parse(process.argv[2]);
    assert(!cancelled);
    const result = await prepareMemoryRuntime(raw.root, raw.outputParent);
    assert(!cancelled);
    await new Promise<void>((resolve, reject) =>
        process.send!({ kind: 'native-runtime-result', result }, (e) =>
            e ? reject(e) : resolve(),
        ),
    );
} catch (e) {
    console.error(String(e));
    process.exitCode = 1;
} finally {
    const { stop } = await import('esbuild');
    stop();
    if (process.connected) process.disconnect();
}
