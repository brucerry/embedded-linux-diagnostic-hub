import type { Session, PseudoTtyInfo, WindowChangeInfo } from 'ssh2';

export interface TerminalFixtureState {
    opens: number;
    closes: number;
    inputs: Buffer[];
    sizes: { cols: number; rows: number }[];
    refuse?: boolean;
}
export function terminalFixtureState(): TerminalFixtureState {
    return { opens: 0, closes: 0, inputs: [], sizes: [] };
}

// A protocol-level PTY fixture exercises real SSH channels without touching a device.
export function attachTerminalFixture(session: Session, state: TerminalFixtureState): void {
    session.on('pty', (accept, reject, info: PseudoTtyInfo) => {
        if (state.refuse) {
            reject?.();
            return;
        }
        state.sizes.push({ cols: info.cols, rows: info.rows });
        accept?.();
    });
    session.on('window-change', (accept, _reject, info: WindowChangeInfo) => {
        state.sizes.push({ cols: info.cols, rows: info.rows });
        accept?.();
    });
    session.on('shell', (accept) => {
        state.opens++;
        const channel = accept();
        let cwd = '/home/engineer';
        let line = '';
        let running = false;
        const prompt = () => channel.write(`${cwd} $ `);
        prompt();
        channel.on('close', () => state.closes++);
        channel.on('data', (bytes: Buffer) => {
            state.inputs.push(Buffer.from(bytes));
            for (const character of bytes.toString('utf8')) {
                if (character === '\x0c') {
                    channel.write('\x1b[2J\x1b[H');
                    prompt();
                    channel.write(line);
                    continue;
                }
                if (character === '\x03') {
                    running = false;
                    line = '';
                    channel.write('^C\r\n');
                    prompt();
                    continue;
                }
                if (character === '\x1b') continue;
                if (running) continue;
                if (character === '\x04' && !line) {
                    channel.exit(0);
                    channel.end();
                    return;
                }
                if (character === '\r' || character === '\n') {
                    channel.write('\r\n');
                    if (line === 'exit' || line === 'logout') {
                        channel.exit(0);
                        channel.end();
                        return;
                    }
                    if (line.startsWith('cd ')) cwd = line.slice(3);
                    else if (line === 'pwd') channel.write(cwd + '\r\n');
                    else if (line === 'watch') {
                        running = true;
                        channel.write('watching\r\n');
                    } else if (line === 'unicode') {
                        const text = Buffer.from('裝置✓\r\n');
                        channel.write(text.subarray(0, 2));
                        channel.write(text.subarray(2));
                    } else if (line === 'sequences')
                        channel.write(
                            '\x1b[31mred\x1b[0m\r\n\x1b]52;c;ZXZpbA==\x07\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07\r\n<script>window.terminalInjected=true</script>\r\n',
                        );
                    else if (line.startsWith('echo ')) channel.write(line.slice(5) + '\r\n');
                    line = '';
                    if (!running) prompt();
                } else {
                    line += character;
                    channel.write(character);
                }
            }
        });
    });
}
