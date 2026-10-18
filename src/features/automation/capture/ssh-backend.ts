import { bytesBase64, type AutomationTransport } from '../../../../shared/automation';
import { captureToRepository } from '../../../../shared/automation-capture';
import type { CaptureRepository } from '../../../../shared/capture-store';
import type { FlowBackend } from '../runner';
import { SshStreamClient } from './ssh-stream-client';

/** Raw seal happens in execute; the runner joins outcome persistence before releasing the host. */
export function sshCaptureBackend(
    transport: Partial<AutomationTransport>,
    store: CaptureRepository,
    source: 'local-client' | 'gateway',
    target: FlowBackend['target'],
    available: () => boolean,
    sampleClock?: FlowBackend['sampleClock'],
): FlowBackend {
    if (!transport.automationStream || !transport.automationConnection)
        throw Error('Update the desktop app or gateway to enable full SSH capture.');
    const connection = transport.automationConnection(),
        client = new SshStreamClient((input) => transport.automationStream!(input), source);
    return {
        receiveTimeSource: source,
        connection: () => transport.automationConnection!(),
        available: () => available() && transport.automationConnection!() === connection,
        acquire: () => () => {},
        target,
        sampleClock,
        finalize: () => client.finalize(),
        async execute(step, plan, signal, id, context) {
            if (!context?.assertFresh)
                throw Error('Stored SSH capture requires the runner freshness context.');
            const check = () => {
                context.assertFresh!();
                if (
                    signal.aborted ||
                    !available() ||
                    transport.automationConnection!() !== connection
                )
                    throw Error('SSH capture connection changed or was cancelled.');
            };
            check();
            await client.supported();
            check();
            let deviceTime: import('../../../../shared/automation').AutomationRecord['deviceTime'] =
                null;
            if (plan.captureDeviceTime && sampleClock) {
                try {
                    const c = await sampleClock();
                    deviceTime = {
                        value: new Date(c.deviceEpochMs).toISOString(),
                        source:
                            c.source +
                            ' before command; uncertainty ' +
                            Math.ceil(c.uncertaintyMs) +
                            ' ms',
                        zone: c.zone,
                        observedAt: new Date(c.sampledLocalMs).toISOString(),
                    };
                } catch {}
            }
            // Sampling is optional; a stale arm is never swallowed with a sampling failure.
            check();
            const requestBytes = bytesBase64(new TextEncoder().encode(step.command));
            const capture = await captureToRepository(
                store,
                {
                    transport: 'ssh',
                    receiveTimeSource: source,
                    runId: context.runId,
                    stepId: step.id,
                    command: step.command,
                    name: step.name,
                    startedAt: context.startedAt,
                    target,
                    requestBase64: requestBytes,
                    execution: {
                        mode: 'independent-script',
                        intent: 'script',
                        timeoutMs: plan.timeoutSeconds * 1000,
                    },
                },
                signal,
                (sink, owned) =>
                    client.execute(
                        {
                            id,
                            connection,
                            command: step.command,
                            timeoutMs: plan.timeoutSeconds * 1000,
                        },
                        sink,
                        owned,
                        check,
                    ),
            );
            return { ...capture, requestBytes, deviceTime };
        },
    };
}
