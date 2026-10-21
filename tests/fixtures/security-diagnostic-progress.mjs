// Data-only fixtures. No process, filesystem, native environment or timer effects.
export const stdoutPhaseNames = [
    'stderr-write-returned',
    'stderr-flush-returned',
    'after-process-acquisition',
    'after-process-path',
];
export const mainPhaseNames = [
    'entry',
    'before-interpreter',
    'after-interpreter',
    'before-plan-parse',
    'after-plan-parse',
    'before-get-item',
    'after-get-item',
    'before-get-acl',
    'after-get-acl',
];
export const metadataReport = () => ({
    schema: 1,
    complete: true,
    principal: 'S-1-5-21-1-2-3-500',
    interpreter: {
        path: 'fixture-winps.exe',
        version: '5.1.1.1',
        edition: 'Desktop',
        x64: true,
        script: 'fixture.ps1',
    },
    trace: {},
    rows: [],
    error: null,
});
export function progressReply({
    pid = 2468,
    eol = '\r\n',
    report = metadataReport(),
    prefix = 9,
} = {}) {
    const stderrNames = [
        ...mainPhaseNames.slice(0, report.complete ? 9 : prefix),
        ...(report.complete ? [] : ['refused']),
        'before-serialize',
        'after-serialize',
    ];
    const order = [...stderrNames.slice(0, 2), ...stdoutPhaseNames, ...stderrNames.slice(2)];
    const records = new Map(
        order.map((phase, i) => [
            phase,
            {
                schema: 1,
                kind: 'security-phase',
                phase,
                pid,
                ticks: String(100 + i),
                frequency: '10000000',
            },
        ]),
    );
    const lines = (names) => names.map((name) => JSON.stringify(records.get(name)) + eol).join('');
    return {
        pid,
        status: report.complete ? 0 : 1,
        signal: null,
        stdout: lines(stdoutPhaseNames) + JSON.stringify(report) + eol,
        stderr: lines(stderrNames),
        records,
        reportText: JSON.stringify(report) + eol,
    };
}
