import { bytesBase64, serialPayload, type AutomationRecord } from '../../../../shared/automation';
import type { CaptureRepository } from '../../../../shared/capture-store';
import { captureToRepository } from '../../../../shared/automation-capture';
import type { SerialSession } from '../../serial/session';
import type { FlowBackend } from '../runner';
import { observedDeviceTime } from '../serial-completion';

/** Exact prefixed receive lines, independently bounded from the result preview. */
class SerialTimeObserver {
    private decoder = new TextDecoder();
    private line = '';
    private discarded = false;
    value: AutomationRecord['deviceTime'] = null;
    constructor(private prefix: string) {}
    append(bytes: Uint8Array, receivedAt: string) {
        if (!this.prefix) return;
        for (const char of this.decoder.decode(bytes, { stream: true })) {
            if (char === '\n') {
                if (!this.discarded)
                    this.value =
                        observedDeviceTime(this.line, this.prefix, receivedAt) ?? this.value;
                this.line = '';
                this.discarded = false;
            } else if (!this.discarded) {
                if (this.line.length >= 512) {
                    this.line = '';
                    this.discarded = true;
                } else this.line += char;
            }
        }
    }
    finish() {
        // Timeout/cancellation/EOF does not terminate a logical receive line.
        return this.value;
    }
}

/** Owned SerialSession + durable raw repository; independent of presentation and export windows. */
export function serialCaptureBackend(
    session: SerialSession,
    store: CaptureRepository,
): FlowBackend {
    const generation = session.current.generation;
    return {
        receiveTimeSource: 'local-client',
        connection: () => String(session.current.generation),
        available: () =>
            session.current.state === 'connected' && session.current.generation === generation,
        acquire: () => session.acquireAutomation(),
        target: { endpoint: session.current.label, serialSettings: session.framing },
        async execute(step, plan, signal, _id, context) {
            if (!context)
                throw Error('Storage-backed Serial capture requires the runner execution context.');
            if (session.current.generation !== generation || session.current.state !== 'connected')
                throw Error('Selected Serial connection changed before capture.');
            const payload = serialPayload(step.command, plan.serial.lineEnding),
                clock = new SerialTimeObserver(
                    plan.captureDeviceTime ? plan.serial.timestampPrefix : '',
                );
            const capture = await captureToRepository(
                store,
                {
                    transport: 'serial',
                    receiveTimeSource: 'local-client',
                    runId: context.runId,
                    stepId: step.id,
                    command: step.command,
                    name: step.name,
                    startedAt: context.startedAt,
                    target: { endpoint: session.current.label, serialSettings: session.framing },
                    requestBase64: bytesBase64(payload),
                    execution: {
                        mode: 'serial-command',
                        intent: step.enterOnly ? 'send-enter' : 'script',
                        timeoutMs: plan.timeoutSeconds * 1000,
                    },
                },
                signal,
                (sink, ownedSignal) =>
                    session.runAutomation(
                        payload,
                        plan.serial.prompt,
                        plan.timeoutSeconds * 1000,
                        ownedSignal,
                        {
                            ...sink,
                            async append(bytes, receivedAt, stream) {
                                await sink.append(bytes, receivedAt, stream);
                                clock.append(bytes, receivedAt);
                            },
                        },
                    ),
            );
            return { ...capture, requestBytes: bytesBase64(payload), deviceTime: clock.finish() };
        },
    };
}
