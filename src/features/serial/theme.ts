import { terminalOptions } from '../terminal/primitives';
export function serialTerminalOptions() {
    const options = terminalOptions();
    return {
        ...options,
        minimumContrastRatio: 4.5,
        theme: {
            ...options.theme,
            // Transparent; calculations use the darkest remaining scene detail (crab eyes).
            background: '#8d9c9700',
            foreground: '#192f3e',
            cursor: '#174556',
            cursorAccent: '#fff9e9',
            selectionBackground: '#274d60',
            selectionInactiveBackground: '#4b6573',
            selectionForeground: '#ffffff',
            black: '#16252e',
            red: '#581121',
            green: '#00341f',
            yellow: '#462400',
            blue: '#002d59',
            magenta: '#491948',
            cyan: '#003335',
            white: '#182f3c',
            brightBlack: '#1b2f3b',
            brightRed: '#5c0b21',
            brightGreen: '#00351d',
            brightYellow: '#482400',
            brightBlue: '#002d5a',
            brightMagenta: '#4c164b',
            brightCyan: '#003238',
            brightWhite: '#192f3e',
        },
    };
}
