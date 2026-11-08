import { captureHeader } from '../../../shared/capture-store';
import { automationOutcome } from '../../../shared/automation-result';

export const RETAINED_EXPORT_ROWS = 21;
export const RETAINED_EXPORT_TIME = '2026-10-15T00:00:00.000Z';
export const RETAINED_EXPORT_MARKER = 'EXPORT-BEYOND-PREVIEW';
export function retainedExportRow(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= RETAINED_EXPORT_ROWS)
        throw Error('Invalid retained-export fixture row.');
    const header = captureHeader({
        transport: 'serial',
        receiveTimeSource: 'local-client',
        runId: 'retained-export-run-' + index,
        stepId: 'repeated-step',
        name: 'Repeated [capture] | <raw> α',
        command: 'printf "same | <raw> ~~~"',
        startedAt: RETAINED_EXPORT_TIME,
    });
    const outcome = automationOutcome({
        id: (index + 1).toString(16).padStart(32, '0'),
        ordinal: 1,
        completedAt: RETAINED_EXPORT_TIME,
        localZone: 'UTC',
        durationMs: 0,
        deviceTime: null,
        completion: 'prompt-observed',
        exitCode: null,
        truncated: false,
    });
    const text =
        index === 0 || index === RETAINED_EXPORT_ROWS - 1
            ? 'X'.repeat(9000) + '\r\n~~~\r\n' + RETAINED_EXPORT_MARKER + ' | <raw> α\r\n'
            : 'ordinary retained row ' + index;
    return { header, outcome, text };
}
