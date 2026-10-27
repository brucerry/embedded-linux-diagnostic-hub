import type { AutomationRequest } from '../../../../shared/automation';
import type { CommandOutputSink } from '../../../../shared/automation-stream';
import { CaptureStorageError } from '../../../../shared/capture-store';
import {
    streamCapabilities,
    streamData,
    streamObject,
    streamResult,
    streamRejected,
    type SshStreamRequest,
    type SshStreamRpc,
} from '../../../../shared/ssh-stream-rpc';

/** One consumer; persistence flush precedes ACK, raw seal/outcome precedes explicit finalize. */
export class SshStreamClient {
    private executing?: Promise<
        import('../../../../shared/automation-stream').StreamedCommandCapture
    >;
    private owner?: { id: string; connection: string; capability: string };
    constructor(
        private rpc: SshStreamRpc,
        private source: 'local-client' | 'gateway',
    ) {}
    async supported() {
        return streamCapabilities(
            await this.rpc({ protocol: 1, action: 'capabilities' }),
            this.source,
        );
    }
    private call(action: 'read' | 'cancel' | 'finalize' | 'ack', sequence?: number) {
        if (!this.owner) throw Error('SSH capture owner is unavailable.');
        return this.rpc({
            protocol: 1,
            action,
            ...this.owner,
            ...(action === 'ack' ? { sequence } : {}),
        } as SshStreamRequest);
    }
    execute(
        request: AutomationRequest,
        sink: CommandOutputSink,
        signal: AbortSignal,
        assertFresh?: () => void,
    ) {
        if (this.executing) return Promise.reject(Error('An SSH capture is already executing.'));
        const task = this.runExecution(request, sink, signal, assertFresh);
        this.executing = task;
        void task
            .finally(() => {
                if (this.executing === task) this.executing = undefined;
            })
            .catch(() => {});
        return task;
    }
    private async runExecution(
        request: AutomationRequest,
        sink: CommandOutputSink,
        signal: AbortSignal,
        assertFresh?: () => void,
    ) {
        if (this.owner) throw Error('Finalize the previous SSH capture first.');
        if (!sink.flush) throw Error('Full SSH capture requires durable storage acknowledgements.');
        // Storage initialization has already awaited; retain the runner's original arm baseline.
        assertFresh?.();
        const epoch = await this.supported();
        if (signal.aborted) throw Error('Cancelled before SSH stream start.');
        // Promise continuations can resume before the queued watchdog after app suspension.
        assertFresh?.();
        const started = streamObject(
            await this.rpc({ protocol: 1, action: 'start', epoch, request }),
            ['protocol', 'capability'],
        );
        if (
            started.protocol !== 1 ||
            typeof started.capability !== 'string' ||
            !/^[a-f0-9]{64}$/.test(started.capability)
        )
            throw Error('Invalid SSH stream capability.');
        this.owner = {
            id: request.id,
            connection: request.connection,
            capability: started.capability,
        };
        let cancelTask: Promise<unknown> | undefined;
        const cancel = () => {
            cancelTask ??= this.call('cancel').catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        let sequence = 0;
        try {
            while (true) {
                const event = await this.call('read');
                if ((event as { type?: unknown })?.type === 'end') {
                    const result = streamResult(event, request.id),
                        rejected = streamRejected(event);
                    if (rejected) sink.rejectObservation(rejected.bytes, rejected.failure);
                    return result;
                }
                const observation = streamData(event, request.id, sequence++, this.source);
                await sink.append(observation.bytes, observation.receivedAt, observation.stream);
                await sink.flush();
                if (!signal.aborted) await this.call('ack', sequence - 1);
            }
        } catch (error) {
            // A failed read/ACK can hide received bytes. Never seal this as complete raw data.
            // A failed writer keeps its original (for example quota) cause.
            try {
                sink.rejectObservation(
                    0,
                    new CaptureStorageError('io', 'SSH observation delivery was interrupted.'),
                );
            } catch {}
            cancel();
            await cancelTask;
            throw error;
        } finally {
            signal.removeEventListener('abort', cancel);
            await cancelTask;
        }
    }
    async finalize() {
        // Even a concurrent caller cannot release server ownership ahead of pending local IO.
        await this.executing?.catch(() => {});
        if (!this.owner) return;
        const owner = this.owner;
        const reply = streamObject(await this.call('finalize'), ['ok']);
        if (reply.ok !== true) throw Error('SSH capture cleanup was not acknowledged.');
        if (this.owner === owner) this.owner = undefined;
    }
}
