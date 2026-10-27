import type { ITerminalOptions, Terminal } from '@xterm/xterm';
export function terminalOptions(): ITerminalOptions {
    return {
        allowProposedApi: true,
        allowTransparency: true,
        cursorBlink: true,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        disableStdin: true,
        scrollback: 5000,
        screenReaderMode: true,
        fontFamily: 'Cascadia Mono, Consolas, monospace',
        fontSize: 14,
        theme: {
            background: '#00000000',
            foreground: '#e7edf4',
            cursor: '#83d9b0',
            cursorAccent: '#151c24',
            selectionBackground: '#52759999',
            selectionInactiveBackground: '#52759988',
        },
        linkHandler: { activate: () => {}, allowNonHttpProtocols: false },
        windowOptions: {},
    };
}
export function terminalOutputGuards(term: Terminal) {
    return [52, 8].map((code) => term.parser.registerOscHandler(code, () => true));
}
export function terminalWheel(term: Terminal, boundary: HTMLElement, container: HTMLElement) {
    const update = () =>
        container.classList.toggle('terminal-has-scrollback', term.buffer.active.baseY > 0);
    const owns = () =>
        term.buffer.active.type === 'alternate' ||
        term.buffer.active.baseY > 0 ||
        term.modes.mouseTrackingMode !== 'none';
    const release = (event: WheelEvent) => {
        if (!owns() && !event.ctrlKey) event.stopPropagation();
    };
    const contain = (event: WheelEvent) => {
        if (owns() && !event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    boundary.addEventListener('wheel', release, { capture: true, passive: true });
    boundary.addEventListener('wheel', contain, { passive: false });
    const rendered = term.onRender(update);
    update();
    return () => {
        rendered.dispose();
        boundary.removeEventListener('wheel', release, true);
        boundary.removeEventListener('wheel', contain);
    };
}
