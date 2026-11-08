// Synthetic historical data only. Commands are retained evidence, never executed.
export const REPORT_IMPORT_A = {
    schemaVersion: 1,
    mode: 'ssh',
    endpoint: 'archive-a.invalid:2222',
    username: 'historian',
    capturedAt: '1969-12-31T23:59:59.000Z',
    results: [
        {
            id: 'identity',
            status: 'collected',
            exitCode: 0,
            command: 'uname -a # archival evidence; never execute',
            stdout: 'Linux\r\narchive-a\r\n6.1.0\r\naarch64\r\n<retained & partial> α\r\n',
            stderr: 'Retained archival warning | Ω\r\n',
            durationMs: 1,
            collectedAt: '1969-12-31T23:59:59.000Z',
            truncated: true,
        },
    ],
};
export const REPORT_IMPORT_B = {
    ...REPORT_IMPORT_A,
    endpoint: 'archive-b.invalid:2222',
    capturedAt: '2028-02-29T12:34:56.123456+05:30',
    results: [
        {
            ...REPORT_IMPORT_A.results[0],
            command: 'uname -s # replacement evidence; never execute',
            stdout: 'Linux\narchive-b\n6.6.0\nx86_64\nReplacement evidence β\n',
            stderr: '',
            collectedAt: '2028-02-29T12:34:56.123456+05:30',
            truncated: false,
        },
    ],
};
export function invalidReportImports() {
    return [
        { kind: 'JSON syntax', content: '{broken', reason: 'The selected file is not valid JSON.' },
        {
            kind: 'duplicate diagnostic identity',
            content: JSON.stringify({
                ...REPORT_IMPORT_A,
                results: [REPORT_IMPORT_A.results[0], REPORT_IMPORT_A.results[0]],
            }),
            reason: 'Unsupported report.',
        },
        {
            kind: 'invalid historical calendar date',
            content: JSON.stringify({ ...REPORT_IMPORT_A, capturedAt: '2026-02-30T12:00:00Z' }),
            reason: 'Unsupported report.',
        },
    ];
}
