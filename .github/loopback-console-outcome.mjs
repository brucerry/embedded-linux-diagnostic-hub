// Pure receipt decision only. No SDK, filesystem, process or fixture effects.
export function assessLoopbackOutcome({ result, globalErrors, command, stepOutcome, issues = [] }) {
    const problems = [...issues];
    const testErrors = result?.errors === undefined ? [] : result.errors;
    const reportErrors = globalErrors === undefined ? [] : globalErrors;
    if (!Array.isArray(testErrors)) problems.push('invalid-test-errors');
    if (!Array.isArray(reportErrors)) problems.push('invalid-global-errors');
    const local = Array.isArray(testErrors) ? testErrors : [];
    const global = Array.isArray(reportErrors) ? reportErrors : [];
    if (local.length) problems.push('test-errors');
    if (global.length) problems.push('global-report-errors');
    const validCommand = command?.schema === 1 && Number.isInteger(command.exitCode)
        && command.exitCode >= 0 && command.exitCode <= 255;
    if (!validCommand) problems.push('sdk-command-outcome-unproved');
    else if (command.exitCode !== 0) problems.push('sdk-command-failed');
    if (stepOutcome !== 'success') problems.push('sdk-step-not-successful');
    return {
        passed: result?.status === 'passed' && problems.length === 0,
        issues: problems,
        errors: [...local, ...global],
        testErrorCount: local.length,
        globalErrorCount: global.length,
        command: { stepOutcome: ['success', 'failure', 'cancelled', 'skipped'].includes(stepOutcome)
            ? stepOutcome : 'missing-or-invalid', exitCode: validCommand ? command.exitCode : null },
    };
}
