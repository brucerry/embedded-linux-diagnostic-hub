import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalSquare, Plug, Eraser, Copy, ClipboardPaste } from 'lucide-react';
import {
    terminalEvent,
    type TerminalTransport,
    TERMINAL_QUEUE_BYTES,
} from '../../../shared/terminal';
import { CopyButton } from '../../components/CopyButton';
import { TerminalInputQueue } from './input';
import { colorPrompts, restoreTerminalModes, terminalCopyText } from './display';
import { TerminalPlayground } from './TerminalPlayground';
import '@xterm/xterm/css/xterm.css';

interface Props {
    transport: Partial<TerminalTransport> | null;
    connected: boolean;
    device: { username: string; endpoint: string; generation: number } | null;
    visible: boolean;
    blocked: boolean;
    reset: number;
    onConnect(): void;
}

export default function TerminalPage(props: Props) {
    const container = useRef<HTMLDivElement>(null);
    const frame = useRef<HTMLDivElement>(null);
    const clearButton = useRef<HTMLButtonElement>(null);
    const copyButton = useRef<HTMLButtonElement>(null);
    const terminal = useRef<Terminal | null>(null);
    const fit = useRef<FitAddon | null>(null);
    const promptColors = useRef<ReturnType<typeof colorPrompts> | null>(null);
    const id = useRef('');
    const input = useRef<TerminalInputQueue | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const [state, setState] = useState('idle');
    const [error, setError] = useState('');
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const ready = useRef(false);
    const restarting = useRef(false);
    const restartAttempts = useRef<number[]>([]);
    const supported = Boolean(
        props.transport?.openTerminal &&
        props.transport.onTerminalEvent &&
        props.transport.writeTerminal &&
        props.transport.resizeTerminal &&
        props.transport.closeTerminal &&
        props.transport.acknowledgeTerminal,
    );

    function clearDisplay(reset = false, focus = false) {
        const term = terminal.current;
        if (!term) return;
        term.write('', () => {
            if (terminal.current !== term) return;
            if (reset) term.reset();
            else term.clear();
            term.clearSelection();
            promptColors.current?.refresh();
            term.options.screenReaderMode = false;
            term.options.screenReaderMode = true;
            if (focus && ready.current && latest.current.visible && !latest.current.blocked)
                term.focus();
        });
        setMenu(null);
    }

    async function paste() {
        const current = id.current;
        setMenu(null);
        try {
            const text = window.diagnosticHub?.readClipboard
                ? await window.diagnosticHub.readClipboard()
                : await navigator.clipboard.readText();
            if (new TextEncoder().encode(text).length > TERMINAL_QUEUE_BYTES)
                throw Error('Clipboard text exceeds the terminal paste limit.');
            if (
                !current ||
                id.current !== current ||
                !ready.current ||
                latest.current.blocked ||
                !latest.current.visible
            )
                return;
            terminal.current?.focus();
            terminal.current?.paste(text);
        } catch (failure) {
            setError(
                failure instanceof Error ? failure.message : 'Clipboard paste is unavailable.',
            );
        }
    }

    useEffect(() => {
        const term = new Terminal({
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
        });
        const addon = new FitAddon();
        term.loadAddon(addon);
        term.open(container.current!);
        const boundary = frame.current!;
        const ownsWheel = () =>
            term.buffer.active.type === 'alternate' ||
            term.buffer.active.baseY > 0 ||
            term.modes.mouseTrackingMode !== 'none';
        // Bypass xterm's wheel listeners on a short normal screen, leaving the browser's
        // default page scroll intact without sending wheel-generated keys to the device.
        const releaseWheel = (event: WheelEvent) => {
            if (!ownsWheel() && !event.ctrlKey) event.stopPropagation();
        };
        const containWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && ownsWheel()) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        boundary.addEventListener('wheel', releaseWheel, { capture: true, passive: true });
        boundary.addEventListener('wheel', containWheel, { passive: false });
        term.textarea?.setAttribute('aria-label', 'Device terminal input');
        terminal.current = term;
        fit.current = addon;
        const prompts = colorPrompts(term);
        promptColors.current = prompts;
        const denied = [52, 8].map((code) => term.parser.registerOscHandler(code, () => true));
        const forward = (bytes: Uint8Array) => {
            const context = latest.current;
            if (
                ready.current &&
                context.connected &&
                context.visible &&
                !context.blocked &&
                document.activeElement === term.textarea
            )
                input.current?.push(bytes);
        };
        const data = term.onData((value) => forward(new TextEncoder().encode(value)));
        const binary = term.onBinary((value) =>
            forward(Uint8Array.from(value, (char) => char.charCodeAt(0))),
        );
        term.attachCustomKeyEventHandler((event) => {
            if (latest.current.blocked || !latest.current.visible) return false;
            if (event.key === 'Escape' && event.ctrlKey && event.shiftKey) {
                if (event.type === 'keydown') {
                    event.preventDefault();
                    clearButton.current?.focus();
                }
                return false;
            }
            const key = event.key.toLowerCase();
            const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
            if (
                modifier &&
                key === 'c' &&
                (term.hasSelection() || event.shiftKey || event.metaKey)
            ) {
                if (event.type === 'keydown') {
                    event.preventDefault();
                    copyButton.current?.click();
                }
                return false;
            }
            if (modifier && key === 'v') {
                if (event.type === 'keydown') {
                    event.preventDefault();
                    void paste();
                }
                return false;
            }
            // Ctrl+L belongs to the remote shell: clearing locally changes its cursor coordinates
            // before Readline's relative redraw arrives (especially with multiline input).
            // xterm translates the remaining official keys; the device owns shell key bindings.
            return true;
        });
        let resizeTimer: ReturnType<typeof setTimeout>;
        const resize = term.onResize((size) => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (ready.current && id.current)
                    void latest.current.transport
                        ?.resizeTerminal?.(id.current, size)
                        .catch(() =>
                            setError('Terminal resizing failed. Reconnect the device to retry.'),
                        );
            }, 100);
        });
        const observer = new ResizeObserver(() => {
            if (latest.current.visible && container.current?.clientWidth) addon.fit();
        });
        observer.observe(container.current!);
        return () => {
            clearTimeout(resizeTimer);
            observer.disconnect();
            boundary.removeEventListener('wheel', releaseWheel, true);
            boundary.removeEventListener('wheel', containWheel);
            data.dispose();
            binary.dispose();
            resize.dispose();
            prompts.dispose();
            promptColors.current = null;
            denied.forEach((handler) => handler.dispose());
            term.dispose();
            terminal.current = null;
            fit.current = null;
        };
    }, []);

    useEffect(() => {
        const transport = props.transport;
        clearDisplay(true);
        setState('idle');
        setError('');
        restarting.current = false;
        restartAttempts.current = [];
        if (!props.connected || !props.device) return;
        const unsubscribe = transport?.onTerminalEvent?.(async (value) => {
            const event = terminalEvent(value);
            if (event.id !== id.current) return;
            if (event.type === 'data') {
                const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
                await new Promise<void>((resolve) => {
                    if (!terminal.current) return resolve();
                    terminal.current.write(bytes, resolve);
                });
                if (event.id === id.current)
                    await transport.acknowledgeTerminal?.(event.id, event.sequence).catch(() => {});
            } else {
                const wasReady = ready.current;
                ready.current = event.state === 'open';
                setState(event.state);
                if (event.state === 'open' && restarting.current) {
                    restarting.current = false;
                    const term = terminal.current;
                    term?.write('\r\n\x1b[2KShell restarted.\r\n', () => {
                        if (
                            id.current === event.id &&
                            ready.current &&
                            latest.current.visible &&
                            !latest.current.blocked
                        ) {
                            term.options.disableStdin = false;
                            term.focus();
                        }
                    });
                }
                if (event.state === 'closed' || event.state === 'error') {
                    input.current?.close();
                    input.current = null;
                    id.current = '';
                    const now = Date.now();
                    restartAttempts.current = restartAttempts.current.filter(
                        (attempt) => now - attempt < 10_000,
                    );
                    if (
                        event.state === 'closed' &&
                        wasReady &&
                        latest.current.connected &&
                        latest.current.device?.generation === props.device?.generation &&
                        restartAttempts.current.length < 3
                    ) {
                        restartAttempts.current.push(now);
                        restarting.current = true;
                        setError('');
                        setState('restarting');
                        return;
                    }
                    restarting.current = false;
                    setState('error');
                    setError(
                        event.message ??
                            'The device shell keeps ending or could not start. Reconnect the device to retry.',
                    );
                }
            }
        });
        return () => {
            const previous = id.current;
            id.current = '';
            ready.current = false;
            restarting.current = false;
            input.current?.close();
            input.current = null;
            unsubscribe?.();
            if (previous) void transport?.closeTerminal?.(previous).catch(() => {});
        };
    }, [props.transport, props.device?.generation, props.connected]);

    useEffect(() => {
        if (
            props.connected &&
            props.device &&
            !props.blocked &&
            supported &&
            (state === 'idle' || state === 'restarting') &&
            !id.current
        ) {
            // React's development setup/teardown probe must not create a remote shell.
            const generation = props.device.generation;
            const scheduled = setTimeout(() => {
                if (
                    latest.current.connected &&
                    !latest.current.blocked &&
                    latest.current.device?.generation === generation &&
                    !id.current
                )
                    void start(state === 'restarting');
            }, 0);
            return () => clearTimeout(scheduled);
        }
    }, [props.connected, props.device?.generation, props.blocked, supported, state]);

    useEffect(() => {
        if (terminal.current)
            terminal.current.options.disableStdin =
                props.blocked || !ready.current || !props.visible;
        if (props.blocked || !props.visible) {
            input.current?.clear();
            terminal.current?.blur();
            setMenu(null);
        }
        if (props.visible && container.current?.clientWidth) fit.current?.fit();
    }, [props.blocked, props.visible, state]);

    useEffect(() => {
        clearDisplay(true);
        input.current?.clear();
    }, [props.reset]);
    useEffect(() => {
        if (!menu) return;
        menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        const dismiss = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [menu]);

    async function start(preserveHistory = false) {
        const transport = props.transport as TerminalTransport;
        const current = crypto.randomUUID();
        id.current = current;
        setState('opening');
        setError('');
        if (preserveHistory && terminal.current) {
            await restoreTerminalModes(terminal.current, () => id.current === current);
            if (id.current !== current || !latest.current.connected) return;
            if (latest.current.blocked) {
                id.current = '';
                setState('restarting');
                return;
            }
        } else clearDisplay(true);
        if (props.visible) fit.current?.fit();
        input.current = new TerminalInputQueue((data) => {
            if (id.current !== current || latest.current.blocked || !latest.current.connected)
                throw Error('Terminal no longer accepts input.');
            return transport.writeTerminal(current, data);
        }, setError);
        try {
            await transport.openTerminal({
                id: current,
                cols: terminal.current?.cols ?? 80,
                rows: terminal.current?.rows ?? 24,
            });
        } catch (failure) {
            if (id.current === current) {
                id.current = '';
                ready.current = false;
                restarting.current = false;
                input.current?.close();
                input.current = null;
                setState('error');
                setError(
                    failure instanceof Error
                        ? failure.message
                        : 'Terminal is unavailable. Reconnect the device to retry.',
                );
            }
        }
    }

    function showMenu(clientX: number, clientY: number) {
        if (props.blocked || !props.visible) return;
        const bounds = frame.current?.getBoundingClientRect();
        if (bounds)
            setMenu({
                x: Math.max(8, Math.min(clientX - bounds.left, bounds.width - 150)),
                y: Math.max(48, Math.min(clientY - bounds.top, bounds.height - 96)),
            });
    }

    return (
        <section
            className="panel terminal-panel"
            hidden={!props.visible}
            aria-label="Connected device terminal"
        >
            <div className="terminal-toolbar">
                <div>
                    <TerminalSquare size={22} />
                    <strong>
                        {props.connected && props.device
                            ? `${props.device.username}@${props.device.endpoint}`
                            : 'No device connected'}
                    </strong>
                </div>
                <span className={`terminal-state ${state}`} role="status">
                    {state === 'open'
                        ? 'Ready'
                        : state === 'opening' || state === 'restarting'
                          ? 'Preparing shell…'
                          : props.connected
                            ? 'Unavailable'
                            : 'Connect a device'}
                </span>
            </div>
            <p className="terminal-description">
                Commands use your SSH user's permissions. Ctrl+C copies a selection or interrupts;
                Ctrl+V pastes. Ctrl+Shift+Escape returns to controls.
            </p>
            <div className="terminal-actions">
                <button
                    ref={clearButton}
                    className="button secondary"
                    disabled={state !== 'open' || props.blocked}
                    onClick={() => clearDisplay(false, true)}
                >
                    <Eraser size={16} />
                    Clear terminal
                </button>
                {!props.connected && (
                    <button className="button secondary" onClick={props.onConnect}>
                        <Plug size={16} />
                        Connect device
                    </button>
                )}
            </div>
            {props.connected && !supported && (
                <p role="alert">Update this application to use Terminal.</p>
            )}
            {error && (
                <p className="terminal-error" role="alert">
                    {error}
                </p>
            )}
            <div ref={frame} className="terminal-frame">
                <TerminalPlayground active={props.visible && !props.blocked} />
                <div className="terminal-copy-control">
                    <CopyButton
                        text={() => terminalCopyText(terminal.current)}
                        label="Copy terminal text"
                        buttonRef={copyButton}
                        disabled={props.blocked}
                        onCopy={async (text) => {
                            if (window.diagnosticHub) await window.diagnosticHub.copyText(text);
                            else await navigator.clipboard.writeText(text);
                            setMenu(null);
                        }}
                    />
                </div>
                <div
                    ref={container}
                    className="terminal-screen"
                    aria-label="Remote shell display"
                    onContextMenu={(event) => {
                        event.preventDefault();
                        showMenu(event.clientX, event.clientY);
                    }}
                />
                {menu && (
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label="Terminal clipboard"
                        className="terminal-context-menu"
                        style={{ left: menu.x, top: menu.y }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                setMenu(null);
                                terminal.current?.focus();
                            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                event.preventDefault();
                                const buttons = [
                                    ...menuRef.current!.querySelectorAll<HTMLButtonElement>(
                                        'button',
                                    ),
                                ];
                                const index = buttons.indexOf(
                                    document.activeElement as HTMLButtonElement,
                                );
                                buttons[
                                    (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
                                        buttons.length
                                ]?.focus();
                            } else if (event.ctrlKey && event.key.toLowerCase() === 'c') {
                                event.preventDefault();
                                copyButton.current?.click();
                            } else if (event.ctrlKey && event.key.toLowerCase() === 'v') {
                                event.preventDefault();
                                void paste();
                            }
                        }}
                    >
                        <button role="menuitem" onClick={() => copyButton.current?.click()}>
                            <Copy size={16} />
                            Copy
                        </button>
                        <button
                            role="menuitem"
                            disabled={!ready.current}
                            onClick={() => void paste()}
                        >
                            <ClipboardPaste size={16} />
                            Paste
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}
