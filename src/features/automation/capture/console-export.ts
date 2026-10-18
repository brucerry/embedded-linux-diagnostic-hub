import { CaptureStorageError } from '../../../../shared/capture-store';
import {
    consoleArchiveReply,
    consoleArchiveRequest,
    type ConsoleArchiveRequest,
} from '../../../../shared/console-archive-rpc';
import { consoleReportScope, type ConsoleReportScope } from '../../../../shared/console-report';
import type { CaptureReportFormat } from '../../../../shared/capture-report';
import { streamObject } from '../../../../shared/ssh-stream-rpc';
import { startBrowserCaptureExport } from './browser-export';

export interface ConsoleExportJob {
    completed: Promise<{ state: 'saved' | 'stream-sent' | 'cancelled'; bytes?: number }>;
    cancel(): Promise<void>;
}
export async function startConsoleExport(
    format: CaptureReportFormat,
    input: ConsoleReportScope,
): Promise<ConsoleExportJob> {
    const scope = consoleReportScope(input);
    if (!window.diagnosticHub) return startBrowserCaptureExport(format, scope, 'console');
    const rpc = window.diagnosticHub.consoleStorage;
    if (!rpc)
        throw new CaptureStorageError(
            'unsupported',
            'Update the desktop app to export console captures.',
        );
    const call = async (request: ConsoleArchiveRequest) => {
        return consoleArchiveReply(await rpc(consoleArchiveRequest(request)));
    };
    const owner = crypto.randomUUID();
    const completed = call({ op: 'export', owner, format, scope }).then((input) => {
        const result = streamObject(input, ['saved']);
        if (typeof result.saved !== 'boolean')
            throw new CaptureStorageError('integrity', 'Console file commit was not acknowledged.');
        return { state: result.saved ? ('saved' as const) : ('cancelled' as const) };
    });
    void completed.catch(() => {});
    return {
        completed,
        async cancel() {
            const reply = streamObject(await call({ op: 'cancel-export', owner }), ['ok']);
            if (reply.ok !== true)
                throw new CaptureStorageError(
                    'integrity',
                    'Console export cleanup was not acknowledged.',
                );
            await completed.catch(() => {});
        },
    };
}
