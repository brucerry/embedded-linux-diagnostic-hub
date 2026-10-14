import { terminalOptions } from '../terminal/primitives';
export function serialTerminalOptions() {
    const options = terminalOptions();
    return {
        ...options,
        minimumContrastRatio: 4.5,
        theme: {
            ...options.theme,
            // Transparent; contrast calculations use the darkest pastel in the scene.
            background: '#91a3a800',
            foreground: '#1e3443',
            black: '#16252e',
            red: '#722b3b',
            green: '#174b36',
            yellow: '#63410b',
            blue: '#1b4a76',
            magenta: '#60305f',
            cyan: '#134a4c',
            white: '#283f4c',
            brightBlack: '#374b57',
            brightRed: '#813046',
            brightGreen: '#1d533b',
            brightYellow: '#69450d',
            brightBlue: '#204f7c',
            brightMagenta: '#6c366b',
            brightCyan: '#1c5056',
            brightWhite: '#1e3443',
        },
    };
}
