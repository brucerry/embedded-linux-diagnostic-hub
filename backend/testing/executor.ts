import type { Client, ClientChannel } from 'ssh2';
import { StringDecoder } from 'node:string_decoder';
import type { Evidence } from '../../shared/testing/types';

export interface Execution {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    truncated: boolean;
    interrupted: boolean;
}
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function executeBounded(
    client: Client,
    command: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    maxBytes: number,
): Promise<Execution> {
    return new Promise((resolve) => {
        let channel: ClientChannel | undefined,
            stdout = '',
            stderr = '',
            bytes = 0,
            truncated = false,
            interrupted = false,
            settled = false;
        const started = Date.now();
        const outDecoder = new StringDecoder('utf8'),
            errDecoder = new StringDecoder('utf8');
        let grace: ReturnType<typeof setTimeout> | undefined;
        const finish = (exitCode: number | null, error = '') => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            signal?.removeEventListener('abort', terminate);
            stdout += outDecoder.end();
            stderr += errDecoder.end();
            if (error) stderr += `${stderr ? '\n' : ''}${error}`;
            resolve({
                stdout,
                stderr,
                exitCode,
                durationMs: Date.now() - started,
                truncated,
                interrupted,
            });
        };
        const terminate = () => {
            if (settled || interrupted) return;
            interrupted = true;
            try {
                channel?.signal('TERM');
            } catch {
                /* Remote deadline remains independently enforced. */
            }
            grace = setTimeout(() => {
                finish(null, 'Remote termination/cleanup could not be confirmed.');
                channel?.close();
            }, timeoutMs + 4000);
        };
        const timer = setTimeout(() => {
            interrupted = true;
            finish(null, 'Execution deadline exceeded; cleanup is unverified.');
            channel?.close();
        }, timeoutMs + 5000);
        signal?.addEventListener('abort', terminate, { once: true });
        if (signal?.aborted) {
            interrupted = true;
            finish(null, 'Cancelled before execution.');
            return;
        }
        try {
            client.exec(
                `export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; ${command}`,
                (error, stream) => {
                    if (error) {
                        finish(null, error.message);
                        return;
                    }
                    channel = stream;
                    if (settled) {
                        stream.close();
                        return;
                    }
                    if (interrupted) {
                        try {
                            stream.signal('TERM');
                        } catch {}
                    }
                    const append = (data: Buffer, isError: boolean) => {
                        const remaining = Math.max(0, maxBytes - bytes);
                        const part = (isError ? errDecoder : outDecoder).write(
                            data.subarray(0, remaining),
                        );
                        bytes += Math.min(data.length, remaining);
                        if (isError) stderr += part;
                        else stdout += part;
                        if (data.length > remaining) {
                            truncated = true;
                            terminate();
                        }
                    };
                    stream.on('data', (data: Buffer) => append(data, false));
                    stream.stderr.on('data', (data: Buffer) => append(data, true));
                    stream.on('error', (error: Error) => finish(null, error.message));
                    stream.on('close', (code: number | null) =>
                        finish(typeof code === 'number' ? code : null),
                    );
                },
            );
        } catch (error) {
            finish(null, error instanceof Error ? error.message : 'SSH execution failed.');
        }
    });
}
export function executionEvidence(output: Execution): Evidence {
    return {
        ...output,
        execution: output.interrupted
            ? 'interrupted'
            : output.exitCode === 0
              ? 'ok'
              : output.exitCode === 126 || output.exitCode === 127
                ? 'blocked'
                : 'error',
        reason: output.interrupted
            ? 'Execution interrupted.'
            : output.exitCode === 0
              ? 'Execution completed.'
              : 'Device command did not complete successfully.',
        measured: null,
        cleanup: 'unverified',
        cleanupDetail: 'No verified restoration evidence.',
    };
}
