import type { Client, ClientChannel } from 'ssh2';
import { StringDecoder } from 'node:string_decoder';
import { AUTOMATION_LIMITS, type CommandCapture, type Completion } from '../../shared/automation';
export function captureCommand(
    client: Client,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<CommandCapture> {
    return new Promise((resolve) => {
        let channel: ClientChannel | undefined,
            settled = false,
            bytes = 0,
            stdout = '',
            stderr = '',
            exitCode: number | null = null,
            truncated = false,
            termination: CommandCapture['termination'];
        const chunks: CommandCapture['chunks'] = [],
            out = new StringDecoder('utf8'),
            err = new StringDecoder('utf8');
        const finish = (completion: Completion) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            stdout += out.end();
            stderr += err.end();
            if (completion !== 'exit') channel?.close();
            resolve({
                stdout,
                stderr,
                exitCode,
                completion,
                truncated,
                chunks,
                ...(termination ? { termination } : {}),
            });
        };
        const cancel = () => finish('cancelled'),
            timer = setTimeout(() => finish('timeout'), timeoutMs);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) return cancel();
        const append = (stream: 'stdout' | 'stderr', buffer: Buffer) => {
            if (settled) return;
            const retained = buffer.subarray(0, Math.max(0, AUTOMATION_LIMITS.outputBytes - bytes));
            if (chunks.length >= AUTOMATION_LIMITS.chunks) {
                truncated = true;
                return finish('output-limit');
            }
            bytes += retained.length;
            if (retained.length) {
                chunks.push({
                    stream,
                    base64: retained.toString('base64'),
                    receivedAt: new Date().toISOString(),
                });
                if (stream === 'stdout') stdout += out.write(retained);
                else stderr += err.write(retained);
            }
            if (retained.length < buffer.length) {
                truncated = true;
                finish('output-limit');
            }
        };
        try {
            client.exec(command, (error, stream) => {
                if (error) return finish('transport-error');
                channel = stream;
                if (settled) return stream.close();
                stream.on('data', (b: Buffer) => append('stdout', b));
                stream.stderr.on('data', (b: Buffer) => append('stderr', b));
                const observeExit = (
                    code: number | null,
                    exitSignal?: string,
                    coreDumped?: boolean,
                    message?: string,
                ) => {
                    if (settled) return;
                    if (
                        typeof code === 'number' &&
                        Number.isInteger(code) &&
                        code >= 0 &&
                        code <= 4294967295
                    )
                        exitCode = code;
                    if (typeof exitSignal === 'string' && exitSignal) {
                        termination = {
                            signal: exitSignal.slice(0, 128),
                            coreDumped:
                                typeof coreDumped === 'boolean'
                                    ? coreDumped
                                    : (termination?.coreDumped ?? null),
                            message:
                                typeof message === 'string'
                                    ? message.slice(0, 4096)
                                    : (termination?.message ?? null),
                            truncated:
                                (termination?.truncated ?? false) ||
                                exitSignal.length > 128 ||
                                (typeof message === 'string' && message.length > 4096),
                        };
                    }
                };
                stream.on('exit', observeExit);
                stream.on('error', () => finish('transport-error'));
                stream.on(
                    'close',
                    (
                        code: number | null,
                        exitSignal?: string,
                        coreDumped?: boolean,
                        message?: string,
                    ) => {
                        observeExit(code, exitSignal, coreDumped, message);
                        finish(
                            termination
                                ? 'signalled'
                                : exitCode !== null
                                  ? 'exit'
                                  : 'uncertain-close',
                        );
                    },
                );
            });
        } catch {
            finish('transport-error');
        }
    });
}
