import type { Page } from '@playwright/test';

declare global {
    interface Window {
        sshStreamTest: { commands: string[]; finalized: number; legacyCalls: number };
    }
}
/** Small synthetic transport; the real renderer client/store still validate and persist its frames. */
export async function installSshStream(
    page: Page,
    output: {
        connection: string;
        stdout: string;
        stderr: string;
        exitCode: number;
        delayMs?: number;
        tracking?: 'flowTest' | 'armingTest';
        allowCancel?: boolean;
    },
) {
    await page.addInitScript((output) => {
        const api = window.diagnosticHub!,
            epoch = 'a'.repeat(32),
            capability = 'b'.repeat(64);
        const state = { commands: [] as string[], finalized: 0, legacyCalls: 0 };
        window.sshStreamTest = state;
        let active:
            | {
                  id: string;
                  connection: string;
                  next: number;
                  waiting: number | null;
                  ended: boolean;
                  delayed: boolean;
                  cancelled: boolean;
                  observed: { stdout: string; stderr: string };
              }
            | undefined;
        api.automationConnection = () => output.connection;
        api.runAutomation = async () => {
            state.legacyCalls++;
            throw Error('This fixture requires the independent streaming API.');
        };
        api.automationStream = async (input) => {
            const { CAPTURE_STORAGE, frameCrc } = await import(
                new URL('/shared/capture-store.ts', location.href).href
            );
            const { streamRequest } = await import(
                new URL('/shared/ssh-stream-rpc.ts', location.href).href
            );
            const request = streamRequest(input);
            if (request.action === 'capabilities')
                return {
                    protocol: 1,
                    independentStream: 1,
                    receiveTimeSource: 'local-client',
                    frameBytes: CAPTURE_STORAGE.frameBytes,
                    backlogBytes: CAPTURE_STORAGE.backlogBytes,
                    epoch,
                };
            if (request.action === 'start') {
                if (
                    active ||
                    request.epoch !== epoch ||
                    request.request.connection !== output.connection
                )
                    throw Error('Synthetic SSH start owner mismatch.');
                state.commands.push(request.request.command);
                const tracked = output.tracking ? (window as any)[output.tracking] : undefined;
                if (output.tracking === 'armingTest') tracked.executions++;
                if (output.tracking === 'flowTest') {
                    tracked.commands.push(request.request.command);
                    tracked.active++;
                    tracked.maxActive = Math.max(tracked.maxActive, tracked.active);
                }
                active = {
                    id: request.request.id,
                    connection: request.request.connection,
                    next: 0,
                    waiting: null,
                    ended: false,
                    delayed: false,
                    cancelled: false,
                    observed: { stdout: '', stderr: '' },
                };
                return { protocol: 1, capability };
            }
            if (
                !active ||
                request.id !== active.id ||
                request.connection !== active.connection ||
                request.capability !== capability
            )
                throw Error('Synthetic SSH owner mismatch.');
            if (request.action === 'ack') {
                if (active.waiting !== request.sequence)
                    throw Error('Synthetic SSH credit mismatch.');
                active.waiting = null;
                return { ok: true };
            }
            if (request.action === 'finalize') {
                if (!active.ended || active.waiting !== null)
                    throw Error('Synthetic SSH finalized before drain.');
                active = undefined;
                state.finalized++;
                return { ok: true };
            }
            if (request.action === 'cancel') {
                if (!output.allowCancel)
                    throw Error('Unexpected cancellation in completed-output fixture.');
                if (!active.cancelled && !active.ended && output.tracking === 'flowTest')
                    (window as any).flowTest.cancelled++;
                active.cancelled = true;
                active.waiting = null;
                return { ok: true };
            }
            if (!active.delayed) {
                active.delayed = true;
                if (output.delayMs)
                    await new Promise((resolve) => setTimeout(resolve, output.delayMs));
            }
            if (active.waiting !== null)
                throw Error('Synthetic SSH read preceded persistence ACK.');
            const streams = active.cancelled
                ? []
                : (['stdout', 'stderr'] as const).filter((key) => output[key]);
            const stream = streams[active.next];
            if (stream) {
                const bytes = new TextEncoder().encode(output[stream]);
                if (bytes.length > 1024) throw Error('Synthetic SSH fixture bound exceeded.');
                const sequence = active.next++;
                active.waiting = sequence;
                active.observed[stream] = output[stream];
                return {
                    protocol: 1,
                    type: 'data',
                    id: active.id,
                    sequence,
                    receivedAt: new Date().toISOString(),
                    receiveTimeSource: 'local-client',
                    stream,
                    totalBytes: bytes.length,
                    frames: [
                        {
                            offset: 0,
                            base64: btoa(String.fromCharCode(...bytes)),
                            crc32: frameCrc(bytes),
                        },
                    ],
                };
            }
            if (!active.ended && output.tracking === 'flowTest') {
                const tracked = (window as any).flowTest;
                tracked.active--;
                if (!active.cancelled) tracked.completed++;
            }
            active.ended = true;
            return {
                protocol: 1,
                type: 'end',
                id: active.id,
                capture: {
                    stdout: active.observed.stdout,
                    stderr: active.observed.stderr,
                    exitCode: active.cancelled ? null : output.exitCode,
                    completion: active.cancelled ? 'cancelled' : 'exit',
                    truncated: false,
                    chunks: [],
                    previewClipped: false,
                },
            };
        };
    }, output);
}
