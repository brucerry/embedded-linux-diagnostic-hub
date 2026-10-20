import { ptyStageTimeline, validateStageClock } from './lib/pty-stage-timeline.mjs';
import { boundedCleanupDiagnostic, cleanupErrorReason } from './lib/pilot-cleanup-diagnostics.mjs';
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
let timelinePort: any;
let stageFinalAcknowledged = false;
const trace =
    envelope.stage === 'real-os-pty' && pilotBindingMode(binding) === ptyObservationMode
        ? ptyStageTimeline({
              deadline: envelope.stageDeadline,
              emit: (stage: string, data: unknown) => timelinePort.emit(stage, data),
              hold: (e: unknown) => hold(e),
          })
        : undefined;
const abortCause = (reason: unknown, origin = 'work-failure') => {
    if (!stageFinalAcknowledged) trace?.cancel(origin, reason, controller.signal.aborted);
    controller.abort(reason);
    if (!stageFinalAcknowledged) trace?.publishCancellation();
};
const cancel = (reason: string, origin: string) => abortCause(Error(reason), origin);
// Handlers and immutable deadline exist before runtime preparation or fixture imports.
for (const e of ['SIGTERM', 'SIGINT', 'disconnect'])
    process.on(e, () => cancel(e, e === 'disconnect' ? 'disconnect' : 'signal'));
process.on('message', (m: any) => {
    if (m?.kind === 'cancel-hosted-pilot-stage') {
        if (m.nonce !== binding.nonce || m.bindingSHA256 !== hash)
            cancel('Invalid stage cancellation', 'parent-ipc');
        else {
            cancel(m.reason ?? 'Owner cancelled', 'parent-ipc');
            let parentRequestClock = null;
            try {
                if (m.diagnosticClock) parentRequestClock = validateStageClock(m.diagnosticClock);
            } catch (e) {
                hold(e);
            }
            (terminal ?? diagnostics)?.note('stage-cancel-ack', {
                reason: m.reason ?? 'Owner cancelled',
                parentRequestClock,
                diagnosticClock: trace?.anchor() ?? null,
                stage: envelope.stage,
            });
        }
    }
});
const timer = setTimeout(
    () => cancel('Immutable stage work deadline', 'stage-timer'),
    Math.max(0, envelope.stageDeadline - Number(process.hrtime.bigint() / 1000000n)),
);
const sendEvidence = stageChannel(binding.nonce, hash, controller.signal, {
    deadline: binding.deadline,
    observer: trace,
});
let held: ReturnType<typeof createOwnershipHold> | undefined;
const hold = (e: unknown) => {
    startup?.stopQueryAdmission();
    if (!held) {
        const state = {
            kind: 'native-pilot-stage-unknown',
            bindingSHA256: hash,
            reason: 'Failure retained; bounded diagnostic follows.',
            error: undefined as unknown,
            firstCancellation: undefined as unknown,
            startup: undefined as unknown,
        };
        held = createOwnershipHold(state, () => {});
        trace?.cancel('ownership-hold', e, controller.signal.aborted);
        state.firstCancellation = trace?.first() ?? null;
        state.error = boundedCleanupDiagnostic(e);
        state.reason = cleanupErrorReason(e);
        try {
            state.startup = startup?.snapshot();
        } catch (error) {
            state.startup = { unavailable: boundedCleanupDiagnostic(error) };
        }
        try {
            if (terminal) {
                terminal.enterHold();
                terminal.note('stage-held', state);
                if (!terminalReportStarted) {
                    terminalReportStarted = true;
                    void startup
                        ?.terminalObservation('held-final-admitted-observations')
                        .catch((error) =>
                            terminal!.note('startup-terminal-observation-unavailable', {
                                error: cleanupErrorReason(error),
                                errorDetails: boundedCleanupDiagnostic(error),
                                releaseAuthorized: false,
                            }),
                        );
                }
            } else diagnostics?.note('stage-held', state);
        } catch {
            /* The referenced hold already exists; diagnostic transport has no authority. */
        }
    }
    abortCause(e, 'ownership-hold');
    startup?.cancel();
    void trace?.finish().catch(() => {});
};
const ptyDiagnostics =
    envelope.stage === 'real-os-pty' ? terminalRuntimeDiagnostics(sendEvidence, hold) : undefined;
diagnostics = ptyDiagnostics ?? runtimeDiagnostics(sendEvidence, hold);
if (ptyDiagnostics) {
    terminal = ptyDiagnostics.reserveTerminal({ rows: 16, bytes: 131072, pendingBytes: 65536 });
    if (trace) {
        timelinePort = terminal.reserveTimeline();
        ptyDiagnostics.setObserver(trace);
    }
}
controller.signal.addEventListener(
    'abort',
    () => {
        if (!stageFinalAcknowledged && trace && !trace.first()) {
            trace.cancel('abort-observed', controller.signal.reason, true);
            trace.publishCancellation();
        }
    },
    { once: true },
);
const emit = diagnostics.emit;
startup = new NativePilotStartup({
    signal: controller.signal,
    deadline: envelope.stageDeadline,
    cleanupDeadline: binding.deadline,
    emit,
    hold,
    diagnostics: true,
    timeline: trace,
    ...(terminal ? { terminalEmit: terminal.emit } : {}),
});
let failure: unknown;
try {
    const entryPhase = trace?.begin('entry');
    trace?.end(entryPhase);
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
        diagnosticClock: trace?.anchor() ?? null,
    });
    const require = createRequire(import.meta.url);
    const runtimePhase = trace?.begin('runtime');
    const runtime = await preparePilotStageRuntime({
        binding,
        bindingSHA256: hash,
        paths,
        startup,
        signal: controller.signal,
        deadline: envelope.runtimeDeadline,
        emit,
        cancel: (e: unknown) => abortCause(e, 'runtime'),
        hold,
    });
    trace?.end(runtimePhase);
    process.env.HUB_MEMORY_SSH_PROFILE = runtime.manifestPath;
    require(runtime.preloadPath);
    process.execArgv.push('--require', runtime.preloadPath);
    paths.check();
    if (envelope.stage === 'real-os-pty') {
        const importPhase = trace?.begin('import');
        await emit('pty-import-before', { diagnosticClock: trace?.anchor() ?? null });
        {
            const { exerciseRealPtyAssertions } =
                await import('../tests/fixtures/console-real-pty-assertions');
            trace?.end(importPhase);
            controller.signal.throwIfAborted();
            try {
                assert(Number(process.hrtime.bigint() / 1000000n) < envelope.stageDeadline);
            } catch (error) {
                trace?.cancel('child-admission-cutoff', error, controller.signal.aborted);
                throw error;
            }
            await emit('pty-assertions-before', { diagnosticClock: trace?.anchor() ?? null });
            const assertionsPhase = trace?.begin('assertions');
            await exerciseRealPtyAssertions({
                expectedRuntime: binding.runtime,
                timeline: trace,
                bridgePreparation: {
                    deadline: envelope.stageDeadline,
                    cleanupDeadline: binding.deadline,
                    startup,
                    context: {
                        sourceSHA256: binding.sourceSHA256,
                        bindingSHA256: hash,
                        nonce: binding.nonce,
                        root: paths.root,
                    },
                    cancel: (e: unknown) => abortCause(e, 'compiler'),
                    emit,
                },
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
            trace?.end(assertionsPhase);
            await emit('pty-assertions-after', { diagnosticClock: trace?.anchor() ?? null });
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
    abortCause(e, 'work-failure');
    startup.cancel();
} finally {
    clearTimeout(timer);
    (terminal ?? diagnostics).note('stage-esbuild-stop-before', {});
    const { stop } = await import('esbuild');
    stop();
    (terminal ?? diagnostics).note('stage-esbuild-stop-after', {});
}
try {
    const joinPhase = trace?.begin('startup-join');
    const proof = await startup.join();
    trace?.end(joinPhase);
    if (held) throw Error('Unknown startup retained');
    const drainPhase = trace?.begin('diagnostic-drain');
    await diagnostics.drain();
    trace?.end(drainPhase);
    const verdictPhase = trace?.begin('verdict');
    if (trace) await trace.finish();
    await emit('stage-final', {
        stage: envelope.stage,
        diagnosticClock: trace?.anchor() ?? null,
        passed: !failure,
        reason: failure ? cleanupErrorReason(failure) : null,
        error: failure ? boundedCleanupDiagnostic(failure) : null,
        startup: proof,
        descendantsClosed: true,
        leafReceiptsClosed: true,
    });
    stageFinalAcknowledged = true;
    trace?.end(verdictPhase);
    process.exitCode = failure ? 1 : 0;
    if (process.connected) process.disconnect();
} catch (e) {
    hold(e);
    await held!.outcome;
}
