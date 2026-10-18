import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
    bindingDigest,
    validatePilotBinding,
    requirePilotRuntimeReady,
    pilotLimits,
} from './lib/hosted-pilot-contract.mjs';
import { createOwnershipHold } from './lib/product-entry-custody.mjs';
import { NativePilotStartup } from '../tests/fixtures/native-pilot-startup';
import { pilotPathMap } from '../tests/fixtures/native-pilot-paths';
import { stageChannel } from '../tests/fixtures/pilot-stage-channel';
requirePilotRuntimeReady();
assert(process.connected && process.env.HUB_NATIVE_PILOT_STAGE === '1');
const envelope = JSON.parse(process.argv[2]),
    binding = envelope.binding,
    hash = bindingDigest(binding),
    controller = new AbortController();
const cancel = (reason: string) => controller.abort(Error(reason));
// Handlers and immutable deadline exist before runtime preparation or fixture imports.
for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) process.on(e, () => cancel(e));
process.on('message', (m: any) => {
    if (m?.kind === 'cancel-hosted-pilot-stage') {
        if (m.nonce !== binding.nonce || m.bindingSHA256 !== hash)
            cancel('Invalid stage cancellation');
        else cancel(m.reason ?? 'Owner cancelled');
    }
});
const timer = setTimeout(
    () => cancel('Immutable stage work deadline'),
    Math.max(
        0,
        binding.deadline - pilotLimits.reserveMs - Number(process.hrtime.bigint() / 1000000n),
    ),
);
const emit = stageChannel(binding.nonce, hash, controller.signal);
let held: ReturnType<typeof createOwnershipHold> | undefined;
const hold = (e: unknown) => {
    cancel(String(e));
    held ??= createOwnershipHold(
        {
            kind: 'native-pilot-stage-unknown',
            bindingSHA256: hash,
            reason: String(e).slice(0, 1024),
        },
        () => {},
    );
};
const startup = new NativePilotStartup({
    signal: controller.signal,
    deadline: binding.deadline - pilotLimits.reserveMs,
    cleanupDeadline: binding.deadline,
    emit,
    hold,
});
let failure: unknown;
try {
    validatePilotBinding(binding, Number(process.hrtime.bigint() / 1000000n));
    assert(['real-os-pty', 'native-electron-store'].includes(envelope.stage));
    const paths = pilotPathMap(binding.roots.privateRoot.path, binding.nonce);
    const require = createRequire(import.meta.url),
        loader = pathToFileURL(require.resolve('tsx')).href;
    const prep = startup.spawn(
        'ssh-runtime-build',
        () =>
            spawn(
                process.execPath,
                [
                    '--import',
                    loader,
                    path.resolve('tests/fixtures/native-pilot-runtime-worker.ts'),
                    JSON.stringify({ root: process.cwd(), outputParent: paths.runtimeParent }),
                ],
                {
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                    windowsHide: true,
                    env: { ...process.env, HUB_NATIVE_PILOT_STAGE: '1' },
                },
            ),
        (child) => {
            if (child.connected) child.send({ kind: 'cancel-native-pilot-build' });
            else hold('Runtime build cancellation unavailable');
        },
    );
    let runtime: any;
    prep.on('message', (m: any) => {
        if (m?.kind === 'native-runtime-result') runtime = m.result;
    });
    await startup.children.get(prep)!.closed;
    controller.signal.throwIfAborted();
    assert.equal(startup.children.get(prep)!.code, 0);
    assert(runtime);
    process.env.HUB_MEMORY_SSH_PROFILE = runtime.manifestPath;
    require(runtime.preloadPath);
    process.execArgv.push('--require', runtime.preloadPath);
    paths.check();
    if (envelope.stage === 'real-os-pty') {
        const ptyTimer = setTimeout(
            () => cancel('Existing 25-second PTY limit'),
            pilotLimits.ptyTestMs,
        );
        try {
            const { exerciseRealPtyAssertions } =
                await import('../tests/fixtures/console-real-pty-assertions');
            await exerciseRealPtyAssertions({
                expectedRuntime: binding.runtime,
                homeParent: paths.ptyHomeParent,
                journalParent: paths.ptyJournalParent,
                signal: controller.signal,
                requireNative: true,
                check: paths.check,
                holdUnknown: hold,
                registerChild: (child, stop) => startup.adopt('bash-winpty-bridge', child, stop),
                diagnostic: (text) => console.log(text),
            });
        } finally {
            clearTimeout(ptyTimer);
        }
    } else {
        const { parseNativeCoverage } =
            await import('../tests/fixtures/memory-product-native-contract');
        const nativeCoverage = parseNativeCoverage(
            Buffer.from(envelope.coverageJSON),
            binding.coveragePolicySHA256,
            binding.sourceSHA256,
        );
        const { finiteNativeReadiness } =
            await import('../tests/fixtures/windows-native-readiness-pilot');
        await finiteNativeReadiness({
            privateRoot: paths.root,
            pilot: paths,
            startup,
            nativeCoverage,
            signal: controller.signal,
            workDeadlineMs: binding.deadline - pilotLimits.reserveMs,
            emit,
            holdUnknown: hold,
        });
    }
    controller.signal.throwIfAborted();
} catch (e) {
    failure = e;
    controller.abort(e);
    startup.cancel();
} finally {
    clearTimeout(timer);
    const { stop } = await import('esbuild');
    stop();
}
try {
    const proof = await startup.join();
    if (held) throw Error('Unknown startup retained');
    await emit('stage-final', {
        stage: envelope.stage,
        passed: !failure,
        reason: failure ? String(failure).slice(0, 1024) : null,
        startup: proof,
        descendantsClosed: true,
        leafReceiptsClosed: true,
    });
    process.exitCode = failure ? 1 : 0;
    if (process.connected) process.disconnect();
} catch (e) {
    hold(e);
    await held!.outcome;
}
