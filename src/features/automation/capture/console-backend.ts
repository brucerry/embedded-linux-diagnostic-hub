import type { AutomationTransport } from '../../../../shared/automation';
import { bytesBase64 } from '../../../../shared/capture-store';
import { consoleCompletion, sshInputBytes } from '../../../../shared/ssh-console';
import type { ConsoleRepository } from '../../../../shared/console-journal';
import type { FlowBackend } from '../runner';
import { SshConsoleClient } from './ssh-console-client';
/** The runner prepares once and joins finishFlow once, spanning all steps, delays and repeats. */
export function sshConsoleBackend(
    transport: Partial<AutomationTransport>,
    source: 'local-client' | 'gateway',
    target: FlowBackend['target'],
    available: () => boolean,
    browserStore?: () => Promise<ConsoleRepository>,
    sampleClock?: FlowBackend['sampleClock'],
    beforePrepare?: () => Promise<void>,
    onPrepared?: () => void,
): FlowBackend {
    if (!transport.automationConsole || !transport.automationConnection)
        throw Error('Update the desktop app or gateway to use persistent console capture.');
    const connection = transport.automationConnection(),
        flowId = crypto.randomUUID().replaceAll('-', '');
    let client: SshConsoleClient | undefined,
        signal: AbortSignal | undefined,
        abort: (() => void) | undefined;
    return {
        receiveTimeSource: source,
        target,
        sampleClock,
        connection: () => transport.automationConnection!(),
        available: () =>
            !client?.failed && available() && connection === transport.automationConnection!(),
        acquire: () => () => {},
        async prepare(plan, owned, assertFresh) {
            if (plan.ssh?.mode !== 'console' || !plan.ssh.ready || !plan.ssh.completion)
                throw Error('Console plan criteria are missing.');
            assertFresh();
            await beforePrepare?.();
            assertFresh();
            const journal = source === 'gateway' ? await browserStore?.() : undefined;
            client = new SshConsoleClient(
                (request, options) => transport.automationConsole!(request, options),
                source,
                journal,
            );
            signal = owned;
            abort = () => {
                void client!.close('cancelled').catch(() => {});
            };
            owned.addEventListener('abort', abort, { once: true });
            assertFresh();
            await client.open(
                connection,
                flowId,
                plan.ssh.ready,
                plan.timeoutSeconds * 1000,
                assertFresh,
            );
            assertFresh();
            onPrepared?.();
        },
        async execute(step, plan, owned, _id, context) {
            if (!client || !context?.assertFresh || !step.ssh)
                throw Error('Console execution lacks its frozen runner context.');
            const check = () => {
                context.assertFresh!();
                if (
                    owned.aborted ||
                    !available() ||
                    connection !== transport.automationConnection!()
                )
                    throw Error('Console connection changed or was cancelled.');
            };
            check();
            const criterion = consoleCompletion(step.ssh.completion ?? plan.ssh?.completion),
                input = { intent: step.ssh.intent, command: step.command },
                requestBytes = bytesBase64(sshInputBytes('console', input));
            const result = await client.step(
                {
                    kind: 'command',
                    runId: context.runId,
                    stepId: step.id,
                    ordinal: context.ordinal,
                    name: step.name || 'Step ' + context.ordinal,
                    input,
                    requestBase64: requestBytes,
                    criterion,
                },
                plan.timeoutSeconds * 1000,
                check,
            );
            return {
                completion: 'prompt-observed',
                exitCode: null,
                stdout: '',
                stderr: '',
                chunks: [],
                truncated: false,
                requestBytes,
                consoleCapture: {
                    schema: 2,
                    id: result.console.header.id,
                    flowId,
                    runId: context.runId,
                    stepId: step.id,
                    ordinal: context.ordinal,
                    intent: input.intent,
                    criterion,
                    match: result.match,
                },
            };
        },
        async finishFlow(reason) {
            try {
                const snapshot = await client?.close(reason);
                if (reason === 'complete' && snapshot?.state !== 'complete')
                    return {
                        failure:
                            'Console capture incomplete' +
                            (snapshot?.failure
                                ? ' (' + snapshot.failure.code + '): ' + snapshot.failure.message
                                : '.'),
                    };
            } catch (error) {
                if (!client?.resourceSnapshot.localCleanupClosed) throw error;
                return {
                    failure:
                        'Console stopped with incomplete or unacknowledged evidence: ' +
                        (error instanceof Error ? error.message : String(error)),
                };
            } finally {
                if (abort) signal?.removeEventListener('abort', abort);
            }
        },
    };
}
