import { StringDecoder } from 'node:string_decoder';
import type { Session, ServerChannel } from 'ssh2';

export interface ConsoleFixtureState {
    opens: number;
    closes: number;
    commands: string[];
    inputs: Buffer[];
    directories: string[];
    confirmations: number;
    enters: number;
    execs: string[];
    activeExecs: number;
    closedExecs: number;
}
export function consoleFixture(
    options: { refusePty?: boolean; ready?: Promise<void>; fragment?: number } = {},
) {
    const state: ConsoleFixtureState = {
        opens: 0,
        closes: 0,
        commands: [],
        inputs: [],
        directories: [],
        confirmations: 0,
        enters: 0,
        execs: [],
        activeExecs: 0,
        closedExecs: 0,
    };
    const checkedPush = <T>(items: T[], value: T) => {
        if (items.length >= 128) throw Error('Console fixture history exceeded its test bound.');
        items.push(value);
    };
    const write = (channel: ServerChannel, bytes: Buffer): Promise<boolean> => {
        if (channel.destroyed) return Promise.resolve(false);
        if (channel.write(bytes)) return Promise.resolve(true);
        return new Promise((resolve) => {
            const settle = (drained: boolean) => {
                channel.off('drain', drainedEvent);
                channel.off('close', closedEvent);
                channel.off('error', closedEvent);
                resolve(drained);
            };
            const drainedEvent = () => settle(true);
            const closedEvent = () => settle(false);
            channel.once('drain', drainedEvent);
            channel.once('close', closedEvent);
            channel.once('error', closedEvent);
            if (channel.destroyed) settle(false);
        });
    };
    const output = async (channel: ServerChannel, text: string) => {
        const bytes = Buffer.from(text),
            width = options.fragment ?? 16384;
        if (!Number.isInteger(width) || width < 1 || width > 16384)
            throw Error('Invalid fixture output fragment width.');
        for (let offset = 0; offset < bytes.length && !channel.destroyed; offset += width)
            if (!(await write(channel, bytes.subarray(offset, offset + width)))) break;
    };
    function attachShell(session: Session) {
        session.on('pty', (accept, reject) => (options.refusePty ? reject?.() : accept?.()));
        session.on('shell', (accept) => {
            const channel = accept(),
                ordinal = state.opens++;
            // Model ordinary interactive initialization, not target profile discovery or injection.
            const aliases = new Map([['ll', 'ls -l']]);
            const functions = new Map([['fixture_hi', 'hello from normal fixture initialization']]);
            const variables = new Map<string, string>();
            let cwd = '/root',
                line = '',
                waiting = false;
            const decoder = new StringDecoder('utf8');
            const prompt = async () => {
                state.directories[ordinal] = cwd;
                await output(channel, 'fixture:' + cwd + '# ');
            };
            let work = (async () => {
                await options.ready;
                await output(channel, 'Synthetic interactive initialization\r\n');
                await prompt();
            })();
            channel.on('error', () => {});
            channel.on('close', () => state.closes++);
            const execute = async (command: string) => {
                checkedPush(state.commands, command);
                if (waiting) {
                    waiting = false;
                    state.confirmations++;
                    await output(channel, 'CONFIRMED\r\n');
                } else if (!command) state.enters++;
                else if (command.startsWith('cd ')) cwd = command.slice(3);
                else if (command === 'pwd') await output(channel, cwd + '\r\n');
                else if (aliases.has(command))
                    await output(channel, 'fixture listing from ' + cwd + '\r\n');
                else if (functions.has(command))
                    await output(channel, functions.get(command)! + '\r\n');
                else if (command.startsWith('export FLAG='))
                    variables.set('FLAG', command.slice(12));
                else if (command === 'printenv FLAG')
                    await output(channel, (variables.get('FLAG') ?? '') + '\r\n');
                else if (command === 'confirm-fixture') {
                    waiting = true;
                    await output(channel, 'Proceed fixture [Enter]? ');
                    return;
                } else if (command === 'fixture-stall') return;
                else if (command === 'exit') {
                    channel.exit(0);
                    channel.end();
                    return;
                } else await output(channel, 'ash: ' + command + ': not found\r\n');
                await prompt();
            };
            channel.on('data', (bytes: Buffer) => {
                checkedPush(state.inputs, Buffer.from(bytes));
                for (const c of decoder.write(bytes)) {
                    if (c === '\r' || c === '\n') {
                        const command = line;
                        line = '';
                        work = work.then(() => execute(command));
                        void work.catch(() => channel.close());
                    } else {
                        if (Buffer.byteLength(line) + Buffer.byteLength(c) > 8192) {
                            channel.close();
                            return;
                        }
                        line += c;
                    }
                }
            });
            channel.on('end', () => channel.close());
            void work.catch(() => channel.close());
        });
    }
    function exec(command: string, channel: ServerChannel) {
        if (
            !['cd /', 'pwd', 'll', 'fixture_hi', 'fixture-large', 'fixture-stall'].includes(command)
        )
            return false;
        checkedPush(state.execs, command);
        state.activeExecs++;
        channel.once('close', () => {
            state.activeExecs--;
            state.closedExecs++;
        });
        channel.on('error', () => {});
        channel.on('end', () => channel.close());
        channel.resume(); // Exec never accepts input; consume EOF so cancellation joins close.
        if (command === 'fixture-stall') {
            return true;
        }
        void (async () => {
            if (command === 'fixture-large') {
                // Generate through channel backpressure; do not allocate the complete response.
                for (let index = 0; index < 129 && !channel.destroyed; index++) {
                    const bytes = Buffer.alloc(16384, index % 251);
                    if (!(await write(channel, bytes))) break;
                }
            } else if (command === 'pwd') await output(channel, '/root\r\n');
            else if (command === 'll' || command === 'fixture_hi')
                channel.stderr.write('ash: ' + command + ': not found\r\n');
            if (!channel.destroyed) {
                channel.exit(command === 'll' || command === 'fixture_hi' ? 127 : 0);
                channel.end();
            }
        })().catch(() => channel.close());
        return true;
    }
    return { state, attachShell, exec };
}
