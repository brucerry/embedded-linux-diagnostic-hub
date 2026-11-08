import { consoleReportScope, streamConsoleReport } from '../../../../shared/console-report';
import type { ConsoleArchive } from '../../../../shared/console-storage';
import type { ExportReportSource } from './export-broker';

export function consoleExportSource(open: () => Promise<ConsoleArchive>): ExportReportSource {
    return {
        filename: 'console-results',
        validateScope: consoleReportScope,
        pin: async () => {
            const pin = await (await open()).pin();
            return { through: 0, release: () => pin.release() };
        },
        async *streamReport(format, scope, _through, progress) {
            yield* streamConsoleReport(await open(), format, consoleReportScope(scope), progress);
        },
    };
}
