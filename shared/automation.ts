import { validateScheduleMetadata } from './automation-time';
export const AUTOMATION_LIMITS = {
    commands: 20,
    commandBytes: 8192,
    planBytes: 65536,
    outputBytes: 65536,
    chunks: 256,
    rows: 200,
    retainedBytes: 8 * 1024 * 1024,
    timeoutSeconds: 300,
    delaySeconds: 86400,
    clockAgeMs: 30000,
    clockUncertaintyMs: 2000,
    armLeadMs: 2000,
} as const;
export type AutomationTransportName = 'ssh' | 'serial';
export interface CommandStep {
    id: string;
    name: string;
    enabled: boolean;
    command: string;
    delaySeconds: number;
    enterOnly?: boolean;
}
export interface ClockCalibration {
    source: string;
    connection: string;
    deviceEpochMs: number;
    sampledLocalMs: number;
    sampledMonoMs: number;
    uncertaintyMs: number;
    zone: string;
}
export interface AutomationPlan {
    captureDeviceTime?: boolean;
    transport: AutomationTransportName;
    steps: CommandStep[];
    timeoutSeconds: number;
    repeatSeconds: number | null;
    start: null | {
        epochMs: number;
        clock: 'local' | 'device';
        zone: string;
        wallTime?: string;
        utcOffset?: string;
        calibration?: ClockCalibration;
    };
    serial: { lineEnding: 'none' | 'CR' | 'LF' | 'CRLF'; prompt: string; timestampPrefix: string };
}
export type Completion =
    | 'exit'
    | 'signalled'
    | 'uncertain-close'
    | 'prompt-observed'
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
    | 'output-limit';
export interface RawChunk {
    stream: 'stdout' | 'stderr' | 'serial';
    base64: string;
    receivedAt: string;
}
export interface TerminationEvidence {
    signal: string;
    coreDumped: boolean | null;
    message: string | null;
    truncated: boolean;
}
export interface CommandCapture {
    termination?: TerminationEvidence;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    completion: Completion;
    truncated: boolean;
    chunks: RawChunk[];
}
export interface AutomationRecord extends CommandCapture {
    id: string;
    runId: string;
    ordinal: number;
    name: string;
    command: string;
    transport: AutomationTransportName;
    target: { endpoint: string; username?: string; serialSettings?: string };
    startedAt: string;
    completedAt: string;
    localZone: string;
    durationMs: number;
    deviceTime: null | { value: string; source: string; zone: string; observedAt: string };
    execution?: {
        timeoutSeconds: number;
        repeatSeconds: number | null;
        stepDelaySeconds: number;
        scheduledStart?: {
            epochMs: number;
            clock: 'local' | 'device';
            zone: string;
            wallTime?: string;
            utcOffset?: string;
            source?: string;
            uncertaintyMs?: number;
        };
        serial?: { lineEnding: string; prompt: string; timestampPrefix: string };
    };
    requestBytes?: string;
}
export interface AutomationRequest {
    id: string;
    connection: string;
    command: string;
    timeoutMs: number;
}
export interface AutomationTransport {
    automationConnection(): string;
    runAutomation(request: AutomationRequest): Promise<CommandCapture>;
    cancelAutomation(id: string, connection: string): Promise<void>;
}
export function boundedNumber(value: unknown, min: number, max: number, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw Error(field + ': enter a finite value between ' + min + ' and ' + max + '.');
    return value;
}
export function automationRequest(input: unknown): AutomationRequest {
    const v = input as AutomationRequest;
    if (!v || Object.keys(v).some((k) => !['id', 'connection', 'command', 'timeoutMs'].includes(k)))
        throw Error('Invalid automation request.');
    if (
        !/^[A-Za-z0-9_-]{16,64}$/.test(v.id) ||
        typeof v.connection !== 'string' ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(v.connection)
    )
        throw Error('Automation connection is invalid or stale.');
    if (
        typeof v.command !== 'string' ||
        !v.command.trim() ||
        v.command.includes('\0') ||
        new TextEncoder().encode(v.command).length > AUTOMATION_LIMITS.commandBytes
    )
        throw Error('Command: enter 1–8192 UTF-8 bytes without NUL.');
    boundedNumber(v.timeoutMs, 1000, 300000, 'Timeout');
    return { ...v };
}
function knownFields(value: unknown, allowed: string[], field: string) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((k) => !allowed.includes(k))
    )
        throw Error(field + ': unknown or malformed plan metadata.');
}
export function validatePlan(input: AutomationPlan): AutomationPlan {
    const p = structuredClone(input);
    knownFields(
        p,
        [
            'captureDeviceTime',
            'transport',
            'steps',
            'timeoutSeconds',
            'repeatSeconds',
            'start',
            'serial',
        ],
        'Plan',
    );
    if (p?.captureDeviceTime !== undefined && typeof p.captureDeviceTime !== 'boolean')
        throw Error('Device timestamp setting is invalid.');
    if (
        !p ||
        !['ssh', 'serial'].includes(p.transport) ||
        !Array.isArray(p.steps) ||
        p.steps.length < 1 ||
        p.steps.length > AUTOMATION_LIMITS.commands
    )
        throw Error('Commands: add between 1 and 20 steps.');
    let total = 0;
    const ids = new Set<string>();
    for (const [i, s] of p.steps.entries()) {
        const field = 'Step ' + (i + 1);
        knownFields(s, ['id', 'name', 'enabled', 'command', 'delaySeconds', 'enterOnly'], field);
        if (
            !s ||
            typeof s.id !== 'string' ||
            !s.id ||
            s.id.length > 128 ||
            ids.has(s.id) ||
            typeof s.enabled !== 'boolean' ||
            typeof s.name !== 'string' ||
            s.name.length > 120
        )
            throw Error(field + ': invalid identity, name or enablement.');
        ids.add(s.id);
        if (typeof s.command !== 'string' || s.command.includes('\0'))
            throw Error(field + ': command must be text without NUL.');
        if (s.enterOnly !== undefined && typeof s.enterOnly !== 'boolean')
            throw Error(field + ': Enter-only setting must be a boolean.');
        if (
            s.enterOnly &&
            (p.transport !== 'serial' ||
                s.command !== '' ||
                !['CR', 'LF', 'CRLF'].includes(p.serial?.lineEnding))
        )
            throw Error(
                field + ': Enter-only requires Serial, an empty script and CR, LF or CRLF.',
            );
        const size = new TextEncoder().encode(s.command).length;
        total += size;
        if (size > AUTOMATION_LIMITS.commandBytes)
            throw Error(field + ': command exceeds 8192 UTF-8 bytes.');
        if (s.enabled && !s.command.trim() && !s.enterOnly)
            throw Error(
                field +
                    (s.name ? ' (' + s.name + ')' : '') +
                    (p.transport === 'serial'
                        ? ': enter a command or select Send Enter only.'
                        : ': enabled SSH command needs 1–8192 UTF-8 bytes.'),
            );
        boundedNumber(s.delaySeconds, 0, AUTOMATION_LIMITS.delaySeconds, field + ' delay');
    }
    if (total > AUTOMATION_LIMITS.planBytes || !p.steps.some((s) => s.enabled))
        throw Error('Commands: enable at least one step; total must not exceed 64 KiB.');
    boundedNumber(p.timeoutSeconds, 1, AUTOMATION_LIMITS.timeoutSeconds, 'Timeout');
    if (p.repeatSeconds !== null)
        boundedNumber(p.repeatSeconds, 1, AUTOMATION_LIMITS.delaySeconds, 'Repetition');
    if (p.start !== null && (typeof p.start !== 'object' || Array.isArray(p.start)))
        throw Error('Start: invalid schedule object.');
    if (p.start) {
        knownFields(
            p.start,
            ['epochMs', 'clock', 'zone', 'wallTime', 'utcOffset', 'calibration'],
            'Start',
        );
        if (
            !['local', 'device'].includes(p.start.clock) ||
            typeof p.start.zone !== 'string' ||
            !p.start.zone
        )
            throw Error('Start: select an identified clock and timezone.');
        boundedNumber(p.start.epochMs, 0, 253402300799999, 'Start instant');
        if (!Number.isSafeInteger(p.start.epochMs))
            throw Error('Start instant: require an integer millisecond instant.');
        validateScheduleMetadata(p.start);
        if (p.start.clock === 'device') validateCalibration(p.start.calibration);
        else if (p.start.calibration !== undefined)
            throw Error('Local start: device calibration is not applicable. Remove it.');
    }
    knownFields(p.serial, ['lineEnding', 'prompt', 'timestampPrefix'], 'Serial settings');
    if (
        !p.serial ||
        !['none', 'CR', 'LF', 'CRLF'].includes(p.serial.lineEnding) ||
        typeof p.serial.prompt !== 'string' ||
        typeof p.serial.timestampPrefix !== 'string' ||
        p.serial.timestampPrefix.length > 128 ||
        /[\x00-\x1f\x7f-\x9f]/.test(p.serial.timestampPrefix) ||
        p.serial.prompt.length > 256 ||
        /[\x00-\x1f\x7f-\x9f]/.test(p.serial.prompt)
    )
        throw Error('Serial: invalid line ending or timestamp prefix.');
    if (
        p.transport === 'serial' &&
        (!p.serial.prompt.trim() ||
            p.serial.prompt.length > 256 ||
            /[\x00-\x1f\x7f-\x9f]/.test(p.serial.prompt))
    )
        throw Error('Serial completion prompt: use 1–256 printable literal characters.');
    return p;
}
export function validateCalibration(
    c: ClockCalibration | undefined,
): asserts c is ClockCalibration {
    knownFields(
        c,
        [
            'source',
            'connection',
            'deviceEpochMs',
            'sampledLocalMs',
            'sampledMonoMs',
            'uncertaintyMs',
            'zone',
        ],
        'Device clock calibration',
    );
    if (
        !c ||
        typeof c.source !== 'string' ||
        !c.source ||
        c.source.length > 256 ||
        /[\x00-\x1f\x7f-\x9f]/.test(c.source) ||
        typeof c.connection !== 'string' ||
        !c.connection ||
        c.connection.length > 128 ||
        /[\x00-\x1f\x7f-\x9f]/.test(c.connection) ||
        typeof c.zone !== 'string' ||
        !c.zone ||
        c.zone.length > 128 ||
        /[\x00-\x1f\x7f-\x9f]/.test(c.zone)
    )
        throw Error('Device clock: a verified identified sample is required.');
    for (const key of [
        'deviceEpochMs',
        'sampledLocalMs',
        'sampledMonoMs',
        'uncertaintyMs',
    ] as const)
        boundedNumber(
            c[key],
            0,
            key === 'uncertaintyMs' ? AUTOMATION_LIMITS.clockUncertaintyMs : 253402300799999,
            'Device clock ' + key,
        );
}
export function calibratedNow(
    c: ClockCalibration,
    local: number,
    mono: number,
    connection: string,
): number {
    validateCalibration(c);
    boundedNumber(local, 0, 253402300799999, 'Local clock');
    boundedNumber(mono, 0, 253402300799999, 'Elapsed clock');
    const age = mono - c.sampledMonoMs;
    if (
        connection !== c.connection ||
        age < 0 ||
        age > AUTOMATION_LIMITS.clockAgeMs ||
        Math.abs(local - c.sampledLocalMs - age) > 1000
    )
        throw Error(
            'Device clock: sample is stale, connection changed or local clock jumped. Sample again.',
        );
    return c.deviceEpochMs + age;
}
export function armPlan(p: AutomationPlan, local: number, mono: number, connection: string) {
    validatePlan(p);
    boundedNumber(local, 0, 253402300799999, 'Local clock');
    boundedNumber(mono, 0, 253402300799999, 'Elapsed clock');
    const now =
        p.start?.clock === 'device'
            ? calibratedNow(p.start.calibration!, local, mono, connection)
            : local;
    if (
        p.start &&
        p.start.epochMs - now <
            AUTOMATION_LIMITS.armLeadMs +
                (p.start.clock === 'device' ? p.start.calibration!.uncertaintyMs : 0)
    )
        throw Error(
            'Start: choose a time at least two seconds plus clock uncertainty in the future.',
        );
}
export function serialPayload(command: string, ending: AutomationPlan['serial']['lineEnding']) {
    return new TextEncoder().encode(
        command + { none: '', CR: '\r', LF: '\n', CRLF: '\r\n' }[ending],
    );
}
export function bytesBase64(bytes: Uint8Array) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

export function validateCapture(input: unknown): CommandCapture {
    const r = input as CommandCapture;
    if (
        !r ||
        typeof r.stdout !== 'string' ||
        typeof r.stderr !== 'string' ||
        new TextEncoder().encode(r.stdout + r.stderr).length > AUTOMATION_LIMITS.outputBytes * 3 ||
        typeof r.truncated !== 'boolean' ||
        ![
            'exit',
            'signalled',
            'uncertain-close',
            'prompt-observed',
            'timeout',
            'cancelled',
            'transport-error',
            'output-limit',
        ].includes(r.completion) ||
        !(
            r.exitCode === null ||
            (Number.isInteger(r.exitCode) && r.exitCode >= 0 && r.exitCode <= 4294967295)
        ) ||
        !Array.isArray(r.chunks) ||
        r.chunks.length > AUTOMATION_LIMITS.chunks
    )
        throw Error('Invalid bounded Automation response.');
    if (r.completion === 'exit' && r.exitCode === null)
        throw Error('Automation completion has no genuine exit status.');
    let termination: TerminationEvidence | undefined;
    if (r.termination !== undefined) {
        const t = r.termination;
        if (
            !t ||
            typeof t.signal !== 'string' ||
            !t.signal ||
            t.signal.length > 128 ||
            !(t.coreDumped === null || typeof t.coreDumped === 'boolean') ||
            !(t.message === null || (typeof t.message === 'string' && t.message.length <= 4096)) ||
            typeof t.truncated !== 'boolean'
        )
            throw Error('Invalid Automation termination evidence.');
        termination = {
            signal: t.signal,
            coreDumped: t.coreDumped,
            message: t.message,
            truncated: t.truncated,
        };
    }
    if (r.completion === 'signalled' && !termination)
        throw Error('Signalled completion requires termination evidence.');
    let total = 0;
    const chunks = r.chunks.map((c) => {
        if (
            !c ||
            !['stdout', 'stderr', 'serial'].includes(c.stream) ||
            typeof c.base64 !== 'string' ||
            c.base64.length > 87384 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(c.base64) ||
            typeof c.receivedAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.receivedAt) ||
            !Number.isFinite(Date.parse(c.receivedAt)) ||
            new Date(c.receivedAt).toISOString() !== c.receivedAt
        )
            throw Error('Invalid Automation raw chunk.');
        total +=
            (c.base64.length * 3) / 4 -
            (c.base64.endsWith('==') ? 2 : c.base64.endsWith('=') ? 1 : 0);
        if (total > AUTOMATION_LIMITS.outputBytes)
            throw Error('Automation raw output exceeds its bound.');
        return { stream: c.stream, base64: c.base64, receivedAt: c.receivedAt };
    });
    return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        completion: r.completion,
        truncated: r.truncated,
        ...(termination ? { termination } : {}),
        chunks,
    };
}
