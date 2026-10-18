import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
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
import { runtimeDiagnostics, preparePilotStageRuntime } from './lib/pilot-runtime-startup.mjs';
requirePilotRuntimeReady();
assert(process.connected && process.env.HUB_NATIVE_PILOT_STAGE === '1');
const envelope = JSON.parse(process.argv[2]),
    binding = envelope.binding,
    hash = bindingDigest(binding),
    controller = new AbortController();
let diagnostics: ReturnType<typeof runtimeDiagnostics>, startup: NativePilotStartup;
const cancel = (reason: string) => controller.abort(Error(reason));
// Handlers and immutable deadline exist before runtime preparation or fixture imports.
for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) process.on(e, () => cancel(e));
process.on('message', (m: any) => {
    if (m?.kind === 'cancel-hosted-pilot-stage') {
        if (m.nonce !== binding.nonce || m.bindingSHA256 !== hash)
            cancel('Invalid stage cancellation');
        else {
            cancel(m.reason ?? 'Owner cancelled');
            diagnostics?.note('stage-cancel-ack', {
                reason: m.reason ?? 'Owner cancelled',
                stage: envelope.stage,
            });
        }
    }
});
const timer = setTimeout(
    () => cancel('Immutable stage work deadline'),
    Math.max(0, envelope.stageDeadline - Number(process.hrtime.bigint() / 1000000n)),
);
const sendEvidence = stageChannel(binding.nonce, hash, controller.signal, {
    deadline: binding.deadline,
});
let held: ReturnType<typeof createOwnershipHold> | undefined;
const hold = (e: unknown) => {
    startup?.stopQueryAdmission();
    if (!held) {
        const state = {
            kind: 'native-pilot-stage-unknown',
            bindingSHA256: hash,
            reason: String(e).slice(0, 1024),
            startup: startup?.snapshot(),
        };
        held = createOwnershipHold(state, () => {});
        diagnostics?.note('stage-held', state);
    }
    controller.abort(e);
    startup?.cancel();
};
diagnostics = runtimeDiagnostics(sendEvidence, hold);
const emit = diagnostics.emit;
startup = new NativePilotStartup({
    signal: controller.signal,
    deadline: envelope.stageDeadline,
    cleanupDeadline: binding.deadline,
    emit,
    hold,
    diagnostics: true,
});
let failure: unknown;
try {
    validatePilotBinding(binding, Number(process.hrtime.bigint() / 1000000n));
    assert(['real-os-pty', 'native-electron-store'].includes(envelope.stage));
    const paths = pilotPathMap(binding.roots.privateRoot.path, binding.nonce);
    assert(
        Number.isSafeInteger(envelope.stageDeadline) &&
            envelope.stageDeadline <= binding.deadline - pilotLimits.reserveMs,
    );
    assert(
        Number.isSafeInteger(envelope.runtimeDeadline) &&
            envelope.runtimeDeadline <= envelope.stageDeadline,
    );
    await emit('stage-entry', {
        stage: envelope.stage,
        pid: process.pid,
        stageDeadline: envelope.stageDeadline,
        runtimeDeadline: envelope.runtimeDeadline,
    });
    const require = createRequire(import.meta.url);
    const runtime = await preparePilotStageRuntime({
        binding,
        bindingSHA256: hash,
        paths,
        startup,
        signal: controller.signal,
        deadline: envelope.runtimeDeadline,
        emit,
        cancel: (e: unknown) => controller.abort(e),
        hold,
    });
    process.env.HUB_MEMORY_SSH_PROFILE = runtime.manifestPath;
    require(runtime.preloadPath);
    process.execArgv.push('--require', runtime.preloadPath);
    paths.check();
    if (envelope.stage === 'real-os-pty') {
        await emit('pty-import-before', {});
        {
            const { exerciseRealPtyAssertions } =
                await import('../tests/fixtures/console-real-pty-assertions');
            controller.signal.throwIfAborted();
            assert(Number(process.hrtime.bigint() / 1000000n) < envelope.stageDeadline);
            await emit('pty-assertions-before', {});
            await exerciseRealPtyAssertions({
                expectedRuntime: binding.runtime,
                homeParent: paths.ptyHomeParent,
                journalParent: paths.ptyJournalParent,
                signal: controller.signal,
                requireNative: true,
                check: paths.check,
                holdUnknown: hold,
                registerChild: (child, stop) => startup.adopt('bash-winpty-bridge', child, stop),
                diagnostic: (text) =>
                    diagnostics.note('pty-diagnostic', { text: text.slice(0, 8192) }),
            });
            await emit('pty-assertions-after', {});
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
    diagnostics.note('stage-esbuild-stop-before', {});
    const { stop } = await import('esbuild');
    stop();
    diagnostics.note('stage-esbuild-stop-after', {});
}
try {
    const proof = await startup.join();
    if (held) throw Error('Unknown startup retained');
    await diagnostics.drain();
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
