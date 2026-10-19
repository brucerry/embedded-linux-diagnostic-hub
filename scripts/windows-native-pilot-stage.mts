import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    bindingDigest,
    validatePilotBinding,
    requirePilotRuntimeReady,
    pilotLimits,
    requirePilotStage,
    pilotBindingMode,
    ptyObservationMode,
} from './lib/hosted-pilot-contract.mjs';
import { parsePtyObservationScope } from './lib/pty-observation-scope.mjs';
import { createOwnershipHold } from './lib/product-entry-custody.mjs';
import { NativePilotStartup } from '../tests/fixtures/native-pilot-startup';
import { pilotPathMap } from '../tests/fixtures/native-pilot-paths';
import { stageChannel } from '../tests/fixtures/pilot-stage-channel';
import { terminalRuntimeDiagnostics } from './lib/pilot-terminal-diagnostics.mjs';
import { runtimeDiagnostics, preparePilotStageRuntime } from './lib/pilot-runtime-startup.mjs';
assert(process.connected && process.env.HUB_NATIVE_PILOT_STAGE === '1');
const envelope = JSON.parse(process.argv[2]),
    binding = envelope.binding,
    hash = bindingDigest(binding),
    controller = new AbortController();
requirePilotStage(binding, envelope.stage);
if (pilotBindingMode(binding) === ptyObservationMode) {
    assert.equal(envelope.coverageJSON, undefined, 'Native coverage excluded from PTY stage.');
    parsePtyObservationScope(
        Buffer.from(envelope.scopeJSON),
        binding.scopeSHA256,
        binding.sourceSHA256,
        binding.pilotPolicySHA256,
    );
}
let diagnostics:
        ReturnType<typeof runtimeDiagnostics> | ReturnType<typeof terminalRuntimeDiagnostics>,
    startup: NativePilotStartup;
let terminal:
    ReturnType<ReturnType<typeof terminalRuntimeDiagnostics>['reserveTerminal']> | undefined;
let terminalReportStarted = false;
const cancel = (reason: string) => controller.abort(Error(reason));
// Handlers and immutable deadline exist before runtime preparation or fixture imports.
for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) process.on(e, () => cancel(e));
process.on('message', (m: any) => {
    if (m?.kind === 'cancel-hosted-pilot-stage') {
        if (m.nonce !== binding.nonce || m.bindingSHA256 !== hash)
            cancel('Invalid stage cancellation');
        else {
            cancel(m.reason ?? 'Owner cancelled');
            (terminal ?? diagnostics)?.note('stage-cancel-ack', {
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
        if (terminal) {
            terminal.enterHold();
            terminal.note('stage-held', state);
            if (!terminalReportStarted) {
                terminalReportStarted = true;
                void startup
                    ?.terminalObservation('held-final-admitted-observations')
                    .catch((error) =>
                        terminal!.note('startup-terminal-observation-unavailable', {
                            error: String(error).slice(0, 1024),
                            releaseAuthorized: false,
                        }),
                    );
            }
        } else diagnostics?.note('stage-held', state);
    }
    controller.abort(e);
    startup?.cancel();
};
const ptyDiagnostics =
    envelope.stage === 'real-os-pty' ? terminalRuntimeDiagnostics(sendEvidence, hold) : undefined;
diagnostics = ptyDiagnostics ?? runtimeDiagnostics(sendEvidence, hold);
if (ptyDiagnostics)
    terminal = ptyDiagnostics.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 });
const emit = diagnostics.emit;
startup = new NativePilotStartup({
    signal: controller.signal,
    deadline: envelope.stageDeadline,
    cleanupDeadline: binding.deadline,
    emit,
    hold,
    diagnostics: true,
    ...(terminal ? { terminalEmit: terminal.emit } : {}),
});
let failure: unknown;
try {
    validatePilotBinding(binding, Number(process.hrtime.bigint() / 1000000n));
    requirePilotStage(binding, envelope.stage);
    const paths = pilotPathMap(
        binding.roots.privateRoot.path,
        binding.nonce,
        false,
        pilotBindingMode(binding),
    );
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
                ...(pilotBindingMode(binding) === ptyObservationMode
                    ? { maxOpenings: 1 as const }
                    : {}),
                check: paths.check,
                holdUnknown: hold,
                registerChild: (child, stop) => startup.adopt('bash-winpty-bridge', child, stop),
                terminalDiagnostic: (data) => terminal!.emit('pty-terminal', data),
                ownedChildIdentity: (child) =>
                    startup.children
                        .get(child)
                        ?.identity?.find((row: any) => row.pid === child.pid),
                diagnostic: (text) =>
                    diagnostics.note('pty-diagnostic', { text: text.slice(0, 8192) }),
            });
            await emit('pty-assertions-after', {});
        }
    } else {
        assert.notEqual(
            pilotBindingMode(binding),
            ptyObservationMode,
            'PTY mode cannot import native application stage.',
        );
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
    (terminal ?? diagnostics).note('stage-esbuild-stop-before', {});
    const { stop } = await import('esbuild');
    stop();
    (terminal ?? diagnostics).note('stage-esbuild-stop-after', {});
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
