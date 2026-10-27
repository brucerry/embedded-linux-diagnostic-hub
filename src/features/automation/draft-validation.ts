import {
    AUTOMATION_LIMITS,
    calibratedNow,
    type AutomationPlan,
    type ClockCalibration,
    type CommandStep,
} from '../../../shared/automation';
import { resolveWallTime } from '../../../shared/automation-time';
import { consoleCompletion, type SshExecutionMode } from '../../../shared/ssh-console';
export interface DraftFields {
    sshMode?: SshExecutionMode;
    consolePrompts?: string;
    transport: AutomationPlan['transport'];
    steps: CommandStep[];
    timeout: string;
    repeat: boolean;
    repeatSeconds: string;
    scheduled: boolean;
    date: string;
    zone: string;
    offset: string;
    clockKind: 'local' | 'device';
    ending: AutomationPlan['serial']['lineEnding'];
    prompt: string;
    prefix: string;
    calibration?: ClockCalibration;
    local: number;
    mono: number;
    connection: string;
}
export interface FieldIssue {
    key: string;
    stage: number;
    message: string;
}
// Presentation guidance only. validatePlan/armPlan remain authoritative at execution.
export function draftIssues(d: DraftFields): FieldIssue[] {
    const issues: FieldIssue[] = [];
    const add = (key: string, stage: number, message: string) => {
        if (!issues.some((i) => i.key === key)) issues.push({ key, stage, message });
    };
    const number = (text: string, min: number, max: number, key: string, label: string) => {
        if (
            !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ||
            !Number.isFinite(Number(text)) ||
            Number(text) < min ||
            Number(text) > max
        )
            add(key, 2, label + ': enter ' + min + '–' + max + ' seconds.');
    };
    if (d.transport === 'serial') {
        if (!d.prompt.trim() || d.prompt.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(d.prompt))
            add('prompt', 0, 'Enter 1–256 printable prompt characters.');
        if (d.prefix.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(d.prefix))
            add('prefix', 0, 'Use up to 128 printable characters, or leave blank.');
        if (
            !['none', 'CR', 'LF', 'CRLF'].includes(d.ending) ||
            (d.steps.some((s) => s.enterOnly) && d.ending === 'none')
        )
            add('ending', 0, 'Enter-only needs CR, LF or CRLF.');
    }
    if (d.transport === 'ssh' && d.sshMode === 'console') {
        try {
            consoleCompletion({
                role: 'shell-prompt',
                literals: (d.consolePrompts ?? '').split(/\r?\n/),
            });
        } catch (error) {
            add('console-prompts', 0, error instanceof Error ? error.message : String(error));
        }
    }
    let total = 0;
    for (const s of d.steps) {
        if (s.name.length > 120)
            add(s.id + '.name', 1, 'Use up to 120 characters, or leave blank.');
        const size = new TextEncoder().encode(s.command).length;
        total += size;
        if (s.command.includes('\0'))
            add(s.id + '.command', 1, 'Remove NUL characters from the command.');
        else if (size > AUTOMATION_LIMITS.commandBytes)
            add(s.id + '.command', 1, 'Use no more than 8192 UTF-8 bytes.');
        else if (s.enterOnly && d.transport !== 'serial')
            add(s.id + '.command', 1, 'Enter a script; Enter-only requires Serial.');
        else if (
            s.enabled &&
            !s.enterOnly &&
            !s.command.trim() &&
            !(d.transport === 'ssh' && d.sshMode === 'console' && s.ssh?.intent === 'send-enter')
        )
            add(
                s.id + '.command',
                1,
                d.transport === 'serial'
                    ? 'Enter a command or choose Send Enter only.'
                    : 'Enter a command for this enabled step.',
            );
        if (d.transport === 'ssh' && d.sshMode === 'console') {
            if (s.ssh?.intent === 'send-enter' && s.command !== '')
                add(s.id + '.command', 1, 'Send Enter requires an empty script.');
            if (s.ssh?.completion)
                try {
                    consoleCompletion(s.ssh.completion);
                } catch (error) {
                    add(
                        s.id + '.completion',
                        1,
                        error instanceof Error ? error.message : String(error),
                    );
                }
        }
        if (
            !Number.isFinite(s.delaySeconds) ||
            s.delaySeconds < 0 ||
            s.delaySeconds > AUTOMATION_LIMITS.delaySeconds
        )
            add(s.id + '.delay', 2, 'Step delay: enter 0–86400 seconds.');
    }
    if (!d.steps.some((s) => s.enabled) && d.steps[0])
        add(d.steps[0].id + '.enabled', 1, 'Enable at least one command.');
    if (total > AUTOMATION_LIMITS.planBytes && d.steps[0])
        add(d.steps[0].id + '.command', 1, 'Keep all commands within 64 KiB total.');
    number(d.timeout, 1, AUTOMATION_LIMITS.timeoutSeconds, 'timeout', 'Timeout');
    if (d.repeat)
        number(d.repeatSeconds, 1, AUTOMATION_LIMITS.delaySeconds, 'repeat', 'Repeat delay');
    if (d.scheduled) {
        const [date, time] = d.date.split('T');
        if (!date) add('date', 2, 'Choose a start date.');
        if (!time) add('time', 2, 'Choose a start time.');
        let zoneValid = true;
        try {
            new Intl.DateTimeFormat('en', { timeZone: d.zone });
            if (!d.zone) throw Error();
        } catch {
            zoneValid = false;
            add('zone', 2, 'Choose a valid timezone.');
        }
        let now = d.local,
            clockValid = true;
        if (d.clockKind === 'device') {
            if (d.transport !== 'ssh') {
                clockValid = false;
                add('clock', 2, 'Choose local time for Serial scheduling.');
            } else
                try {
                    now = calibratedNow(d.calibration!, d.local, d.mono, d.connection);
                } catch {
                    clockValid = false;
                    add('clock', 2, 'Sample a verified, current SSH device clock.');
                }
        } else if (d.clockKind !== 'local') {
            clockValid = false;
            add('clock', 2, 'Choose a start clock.');
        }
        if (date && time && zoneValid)
            try {
                const start = resolveWallTime(d.date, d.zone, d.offset || undefined);
                if (
                    clockValid &&
                    start.epochMs - now <
                        AUTOMATION_LIMITS.armLeadMs +
                            (d.clockKind === 'device' ? (d.calibration?.uncertaintyMs ?? 0) : 0)
                ) {
                    add('date', 2, 'Choose a future date/time (2s + clock uncertainty).');
                    add('time', 2, 'Choose a future date/time (2s + clock uncertainty).');
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                if (/repeat|occurrence|offset/i.test(message)) add('offset', 2, message);
                else if (/calendar day/i.test(message))
                    add('date', 2, 'Choose a valid calendar date.');
                else if (/does not exist/i.test(message)) {
                    add('date', 2, 'This local time does not exist; choose another time.');
                    add('time', 2, 'This local time does not exist; choose another time.');
                } else {
                    add('date', 2, 'Choose a valid calendar date and time.');
                    add('time', 2, 'Choose a valid calendar date and time.');
                }
            }
    }
    const displayedKeys = [
        'ending',
        'prompt',
        'prefix',
        ...d.steps.flatMap((s) => [s.id + '.enabled', s.id + '.name', s.id + '.command']),
        'timeout',
        'repeat',
        'date',
        'time',
        'zone',
        'clock',
        'offset',
        ...d.steps.map((s) => s.id + '.delay'),
    ];
    const order = new Map(displayedKeys.map((key, index) => [key, index]));
    return issues.sort(
        (a, b) =>
            a.stage - b.stage || (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity),
    );
}
