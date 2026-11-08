import { CAPTURE_INPUT } from './capture-store';

export type SshExecutionMode = 'independent-script' | 'console';
export type SshInputIntent = 'script' | 'send-enter';
export interface SshConsoleCapabilities {
    protocol: 1;
    independentStream: 1;
    persistentConsole: 1;
}
export interface SshInput {
    readonly intent: SshInputIntent;
    readonly command: string;
}
export interface ConsoleCompletion {
    readonly role: 'shell-prompt' | 'intermediate-input-prompt';
    readonly literals: readonly string[];
}
export interface ConsoleStep extends SshInput {
    readonly completion: ConsoleCompletion;
}
function object(input: unknown, fields: readonly string[], label: string) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some(
            (key) =>
                typeof key !== 'string' ||
                !fields.includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
        )
    )
        throw Error(label + ': unknown or malformed metadata.');
    return input as Record<string, unknown>;
}
export function sshExecutionMode(input: unknown): SshExecutionMode {
    if (input === undefined) return 'independent-script';
    if (input !== 'independent-script' && input !== 'console')
        throw Error('SSH execution mode is unsupported.');
    return input;
}
/** Validate an advertisement; this module does not advertise runtime support itself. */
export function requireConsoleCapabilities(input: unknown): Readonly<SshConsoleCapabilities> {
    const v = object(
        input,
        ['protocol', 'independentStream', 'persistentConsole'],
        'SSH capability',
    );
    if (
        !['protocol', 'independentStream', 'persistentConsole'].every(
            (key) => Object.hasOwn(v, key) && v[key] === 1,
        )
    )
        throw Error(
            'Persistent SSH console requires supported streaming and console capabilities; no fallback was selected.',
        );
    return Object.freeze({ protocol: 1, independentStream: 1, persistentConsole: 1 });
}
export function sshInput(modeInput: unknown, input: unknown): Readonly<SshInput> {
    const mode = sshExecutionMode(modeInput);
    const v = object(input, ['intent', 'command'], 'SSH input');
    if (
        !Object.hasOwn(v, 'intent') ||
        !['script', 'send-enter'].includes(v.intent as string) ||
        !Object.hasOwn(v, 'command') ||
        typeof v.command !== 'string'
    )
        throw Error('Choose an explicit Script or Send Enter intent.');
    if (v.intent === 'send-enter') {
        if (mode !== 'console' || v.command !== '')
            throw Error('Send Enter requires console mode and no script text.');
    } else if (
        v.command.length > CAPTURE_INPUT.scriptBytes ||
        !v.command.trim() ||
        v.command.includes('\0') ||
        new TextEncoder().encode(v.command).length > CAPTURE_INPUT.scriptBytes
    )
        throw Error('SSH Script requires 1–8192 UTF-8 bytes of nonblank text without NUL.');
    return Object.freeze({ intent: v.intent as SshInputIntent, command: v.command });
}
/** Revalidate at the execution boundary; every call returns newly owned exact bytes. */
export function sshInputBytes(modeInput: unknown, input: unknown): Uint8Array {
    const mode = sshExecutionMode(modeInput),
        action = sshInput(mode, input);
    return new TextEncoder().encode(
        action.intent === 'send-enter' ? '\r' : action.command + (mode === 'console' ? '\r' : ''),
    );
}
export function consoleCompletion(input: unknown): ConsoleCompletion {
    const v = object(input, ['role', 'literals'], 'Console completion');
    if (
        !Object.hasOwn(v, 'role') ||
        !['shell-prompt', 'intermediate-input-prompt'].includes(v.role as string) ||
        !Object.hasOwn(v, 'literals') ||
        !Array.isArray(v.literals) ||
        v.literals.length < 1 ||
        v.literals.length > 8
    )
        throw Error('Console completion requires a role and 1–8 explicit literals.');
    const literals = Array.from(v.literals, (literal: unknown) => {
        if (
            typeof literal !== 'string' ||
            literal.length < 1 ||
            literal.length > 256 ||
            !literal.trim() ||
            /[\x00-\x1f\x7f-\x9f]/.test(literal)
        )
            throw Error('Each completion literal must contain 1–256 visible characters.');
        return literal;
    });
    if (new Set(literals).size !== literals.length)
        throw Error('Completion alternatives must be distinct.');
    return Object.freeze({
        role: v.role as ConsoleCompletion['role'],
        literals: Object.freeze(literals),
    });
}
export function consoleReady(input: unknown): ConsoleCompletion {
    const ready = consoleCompletion(input);
    if (ready.role !== 'shell-prompt')
        throw Error('Initial console readiness requires a shell-prompt criterion.');
    return ready;
}
export function consoleStep(input: unknown, defaultCompletion: unknown): Readonly<ConsoleStep> {
    const v = object(input, ['intent', 'command', 'completion'], 'Console step');
    const action = sshInput('console', { intent: v.intent, command: v.command });
    const completion = consoleCompletion(
        v.completion === undefined ? defaultCompletion : v.completion,
    );
    return Object.freeze({ ...action, completion });
}
