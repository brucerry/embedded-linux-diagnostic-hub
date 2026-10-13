import { SerialBeach } from './SerialBeach';
import { serialTerminalOptions } from './theme';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plug, Unplug, Eraser, ClipboardPaste } from 'lucide-react';
import {
    DEFAULT_SERIAL_SETTINGS,
    localSerial,
    SERIAL_QUEUE_BYTES,
    type LocalSerialPort,
    type SerialChooser,
    type SerialSettings,
} from '../../../shared/serial';
import { SerialSession, serialFailure } from './session';
import { terminalOutputGuards, terminalWheel } from '../terminal/primitives';
import { terminalCopyText } from '../terminal/display';
import { CopyButton } from '../../components/CopyButton';
import { Modal } from '../../components/Modal';
import '@xterm/xterm/css/xterm.css';
const BAUD_RATES = [
    300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200, 128000, 230400,
    256000, 460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000,
];
interface Props {
    session: SerialSession;
    visible: boolean;
    blocked: boolean;
    reset: number;
}
export default function SerialPage(props: Props) {
    const { session } = props,
        api = localSerial(),
        bridge = window.diagnosticHub;
    const [status, setStatus] = useState(session.current);
    const [settings, setSettings] = useState<SerialSettings>({ ...DEFAULT_SERIAL_SETTINGS });
    const [customBaud, setCustomBaud] = useState(false),
        [baudDraft, setBaudDraft] = useState(String(DEFAULT_SERIAL_SETTINGS.baudRate));
    const [echo, setEcho] = useState(false),
        [enter, setEnter] = useState('CR');
    const [ports, setPorts] = useState<LocalSerialPort[]>([]),
        [chooser, setChooser] = useState<SerialChooser | null>(null);
    const [error, setError] = useState('');
    const [documentVisible, setDocumentVisible] = useState(!document.hidden);
    useEffect(() => {
        const changed = () => setDocumentVisible(!document.hidden);
        document.addEventListener('visibilitychange', changed);
        return () => document.removeEventListener('visibilitychange', changed);
    }, []);
    const term = useRef<Terminal | null>(null),
        fit = useRef<FitAddon | null>(null);
    const container = useRef<HTMLDivElement>(null),
        frame = useRef<HTMLDivElement>(null);
    const clear = useRef<HTMLButtonElement>(null),
        copy = useRef<HTMLButtonElement>(null);
    const labels = useRef(new Map<LocalSerialPort, string>()),
        pendingLabel = useRef('');
    const latest = useRef({ ...props, echo, enter });
    latest.current = { ...props, echo, enter };
    const supported = Boolean(api && globalThis.isSecureContext);
    const locked =
        props.blocked ||
        session.isOwned ||
        ['opening', 'connected', 'closing', 'selecting'].includes(status.state);
    const label = (port: LocalSerialPort) => {
        if (!labels.current.has(port)) {
            const info = port.getInfo();
            labels.current.set(
                port,
                pendingLabel.current ||
                    'Authorized port ' +
                        (labels.current.size + 1) +
                        (info.usbVendorId !== undefined
                            ? ' · USB ' +
                              info.usbVendorId.toString(16).padStart(4, '0') +
                              ':' +
                              (info.usbProductId ?? 0).toString(16).padStart(4, '0')
                            : ''),
            );
        }
        return labels.current.get(port)!;
    };
    const refreshPorts = () => {
        if (api)
            void api
                .getPorts()
                .then(setPorts)
                .catch(() => {});
    };
    const action = (work: () => Promise<unknown>) => {
        setError('');
        void work().catch((error) => setError(serialFailure(error)));
    };
    async function paste() {
        const generation = session.current.generation,
            inputEpoch = session.inputEpoch;
        try {
            const text = bridge?.readClipboard
                ? await bridge.readClipboard()
                : await navigator.clipboard.readText();
            if (new TextEncoder().encode(text).length > SERIAL_QUEUE_BYTES)
                throw Error('Clipboard text exceeds the serial paste limit.');
            if (
                generation !== session.current.generation ||
                inputEpoch !== session.inputEpoch ||
                session.current.state !== 'connected' ||
                !latest.current.visible ||
                latest.current.blocked
            )
                return;
            term.current?.focus();
            term.current?.paste(text);
        } catch (error) {
            setError(serialFailure(error));
        }
    }
    useEffect(() => session.subscribe(setStatus), [session]);
    useEffect(() => {
        refreshPorts();
        const refresh = () => refreshPorts();
        api?.addEventListener('connect', refresh);
        api?.addEventListener('disconnect', refresh);
        const unsubscribe = bridge?.onSerialChooser?.(setChooser);
        return () => {
            unsubscribe?.();
            api?.removeEventListener('connect', refresh);
            api?.removeEventListener('disconnect', refresh);
        };
    }, [api, bridge]);
    useEffect(() => {
        const terminal = new Terminal(serialTerminalOptions()),
            addon = new FitAddon();
        terminal.loadAddon(addon);
        terminal.open(container.current!);
        term.current = terminal;
        fit.current = addon;
        terminal.textarea?.setAttribute('aria-label', 'Serial terminal input');
        const guards = terminalOutputGuards(terminal),
            wheel = terminalWheel(terminal, frame.current!, container.current!);
        session.setConsumer(
            (bytes, generation) =>
                new Promise<void>((resolve) => {
                    if (generation !== session.current.generation) return resolve();
                    terminal.write(bytes, resolve);
                }),
        );
        const forward = (bytes: Uint8Array) => {
            if (
                !latest.current.visible ||
                latest.current.blocked ||
                session.current.state !== 'connected' ||
                document.activeElement !== terminal.textarea
            )
                return;
            try {
                session.send(bytes);
                if (latest.current.echo) terminal.write(bytes);
            } catch (error) {
                setError(serialFailure(error));
            }
        };
        const data = terminal.onData((value) => {
            const entered =
                value === '\r'
                    ? latest.current.enter === 'CRLF'
                        ? '\r\n'
                        : latest.current.enter === 'LF'
                          ? '\n'
                          : '\r'
                    : value;
            forward(new TextEncoder().encode(entered));
        });
        const binary = terminal.onBinary((value) =>
            forward(Uint8Array.from(value, (c) => c.charCodeAt(0))),
        );
        terminal.attachCustomKeyEventHandler((event) => {
            if (latest.current.blocked || !latest.current.visible) return false;
            const key = event.key.toLowerCase(),
                modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
            if (event.key === 'Escape' && event.ctrlKey && event.shiftKey) {
                if (event.type === 'keydown') {
                    event.preventDefault();
                    clear.current?.focus();
                }
                return false;
            }
            if (
                modifier &&
                key === 'c' &&
                (terminal.hasSelection() || event.shiftKey || event.metaKey)
            ) {
                if (event.type === 'keydown') {
                    event.preventDefault();
                    copy.current?.click();
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
            return true;
        });
        const observer = new ResizeObserver(() => {
            if (latest.current.visible && container.current?.clientWidth) addon.fit();
        });
        observer.observe(container.current!);
        return () => {
            session.setConsumer(async () => {});
            observer.disconnect();
            data.dispose();
            binary.dispose();
            guards.forEach((g) => g.dispose());
            wheel();
            terminal.dispose();
            term.current = null;
            fit.current = null;
        };
    }, [session]);
    useEffect(() => {
        if (term.current)
            term.current.options.disableStdin =
                props.blocked || !props.visible || status.state !== 'connected';
        if (props.blocked || !props.visible) {
            session.clearInput();
            term.current?.blur();
        }
        if (props.visible && container.current?.clientWidth) fit.current?.fit();
    }, [props.visible, props.blocked, status.state, session]);
    useEffect(() => {
        session.clearInput();
        term.current?.reset();
    }, [props.reset, session]);
    return (
        <section hidden={!props.visible} className="serial-page" aria-label="Local serial terminal">
            <div className="panel serial-controls">
                <div className="panel-heading">
                    <h3>Ports on this computer</h3>
                    <span className="subtle-badge" role="status">
                        {status.state}
                    </span>
                </div>
                {!supported && (
                    <p role="status">
                        {!globalThis.isSecureContext
                            ? 'Serial needs a secure browser context.'
                            : 'Web Serial is unavailable in this runtime. Use a supported desktop browser or application.'}
                    </p>
                )}
                <div className="serial-port-row">
                    <label>
                        Local serial port
                        <select
                            aria-label="Local serial port"
                            disabled={!supported || locked}
                            value={ports.indexOf(session.selectedPort!)}
                            onChange={(event) => {
                                const port = ports[Number(event.target.value)];
                                if (port) {
                                    setError('');
                                    pendingLabel.current = '';
                                    session.select(port, label(port));
                                }
                            }}
                        >
                            <option value={-1}>
                                {status.label || 'Choose an authorized port'}
                            </option>
                            {ports.map((port, index) => (
                                <option key={index} value={index}>
                                    {label(port)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        className="button secondary"
                        disabled={!supported || locked}
                        onClick={() => {
                            pendingLabel.current = '';
                            action(async () => {
                                await session.choose(() => api!.requestPort(), label);
                                refreshPorts();
                            });
                        }}
                    >
                        Choose port…
                    </button>
                    <button
                        className="button primary"
                        disabled={
                            !supported ||
                            props.blocked ||
                            !session.selectedPort ||
                            !['selected', 'error'].includes(status.state)
                        }
                        onClick={() =>
                            action(async () => {
                                term.current?.reset();
                                await session.connect(settings);
                                if (latest.current.visible && !latest.current.blocked)
                                    term.current?.focus();
                            })
                        }
                    >
                        <Plug size={16} />
                        Connect
                    </button>
                    <button
                        className="button secondary"
                        disabled={
                            props.blocked ||
                            !['opening', 'connected', 'error'].includes(status.state)
                        }
                        onClick={() => action(() => session.close())}
                    >
                        <Unplug size={16} />
                        Disconnect
                    </button>
                    <button
                        className="button secondary"
                        disabled={
                            props.blocked || !session.selectedPort || status.state === 'closing'
                        }
                        onClick={() => action(() => session.close(true))}
                    >
                        Deselect
                    </button>
                </div>
                <fieldset className="serial-settings" disabled={locked}>
                    <legend>UART settings</legend>
                    <label>
                        Baud rate
                        <select
                            aria-label="Baud rate"
                            value={customBaud ? 'custom' : settings.baudRate}
                            onChange={(e) => {
                                if (e.target.value === 'custom') {
                                    setCustomBaud(true);
                                    setBaudDraft(String(settings.baudRate));
                                } else {
                                    setCustomBaud(false);
                                    setSettings({ ...settings, baudRate: Number(e.target.value) });
                                    setBaudDraft(e.target.value);
                                }
                            }}
                        >
                            {BAUD_RATES.map((v) => (
                                <option key={v} value={v}>
                                    {v.toLocaleString('en-US')}
                                </option>
                            ))}
                            <option value="custom">Custom…</option>
                        </select>
                        {customBaud && (
                            <input
                                aria-label="Custom baud rate"
                                type="number"
                                min={1}
                                max={4294967295}
                                value={baudDraft}
                                onChange={(e) => {
                                    setBaudDraft(e.target.value);
                                    setSettings({ ...settings, baudRate: Number(e.target.value) });
                                }}
                            />
                        )}
                    </label>
                    <label>
                        Data bits
                        <select
                            aria-label="Data bits"
                            value={settings.dataBits}
                            onChange={(e) =>
                                setSettings({
                                    ...settings,
                                    dataBits: Number(e.target.value) as 7 | 8,
                                })
                            }
                        >
                            {[7, 8].map((v) => (
                                <option key={v}>{v}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Parity
                        <select
                            aria-label="Parity"
                            value={settings.parity}
                            onChange={(e) =>
                                setSettings({
                                    ...settings,
                                    parity: e.target.value as SerialSettings['parity'],
                                })
                            }
                        >
                            {['none', 'even', 'odd'].map((v) => (
                                <option key={v}>{v}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Stop bits
                        <select
                            aria-label="Stop bits"
                            value={settings.stopBits}
                            onChange={(e) =>
                                setSettings({
                                    ...settings,
                                    stopBits: Number(e.target.value) as 1 | 2,
                                })
                            }
                        >
                            {[1, 2].map((v) => (
                                <option key={v}>{v}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Flow control
                        <select
                            aria-label="Flow control"
                            value={settings.flowControl}
                            onChange={(e) =>
                                setSettings({
                                    ...settings,
                                    flowControl: e.target.value as SerialSettings['flowControl'],
                                })
                            }
                        >
                            {['none', 'hardware'].map((v) => (
                                <option key={v}>{v}</option>
                            ))}
                        </select>
                    </label>
                </fieldset>
                <p className="presentation-note">
                    Enable and operate your target UART yourself. Opening an adapter can change
                    control lines or reset some boards. Serial sends only your terminal input; it
                    runs no setup or discovery commands.
                </p>
                {!bridge && (
                    <p className="presentation-note">
                        The browser lists authorized ports. Its chooser can grant another port;
                        COM/tty names may not be exposed.
                    </p>
                )}
                {session.selectedPort?.forget && (
                    <button
                        className="button text-button"
                        disabled={locked}
                        onClick={() => action(() => session.forget())}
                    >
                        Forget permission
                    </button>
                )}
                {(error || status.message) && (
                    <p role="alert" className="serial-error">
                        {error || status.message}
                    </p>
                )}
            </div>
            <div className="panel terminal-panel">
                <div className="terminal-toolbar">
                    <strong>{status.label || 'No local port selected'}</strong>
                    <span role="status">
                        {status.state === 'connected' ? 'Ready' : status.state}
                    </span>
                </div>
                <div className="terminal-actions">
                    <button
                        ref={clear}
                        className="button secondary"
                        disabled={props.blocked}
                        onClick={() => {
                            session.clearInput();
                            term.current?.reset();
                            if (status.state === 'connected') term.current?.focus();
                        }}
                    >
                        <Eraser size={16} />
                        Clear terminal
                    </button>
                    <button
                        className="button secondary"
                        disabled={props.blocked || status.state !== 'connected'}
                        onClick={() => void paste()}
                    >
                        <ClipboardPaste size={16} />
                        Paste
                    </button>
                    <label className="serial-echo">
                        <input
                            type="checkbox"
                            checked={echo}
                            onChange={(e) => setEcho(e.target.checked)}
                        />
                        Local echo
                    </label>
                    <label>
                        Enter
                        <select
                            aria-label="Serial Enter sequence"
                            value={enter}
                            onChange={(e) => setEnter(e.target.value)}
                        >
                            {['CR', 'LF', 'CRLF'].map((v) => (
                                <option key={v}>{v}</option>
                            ))}
                        </select>
                    </label>
                </div>
                <p className="terminal-description">
                    Ctrl+C copies a selection or sends interrupt input. Ctrl+V pastes.
                    Ctrl+Shift+Escape returns to controls. Reception continues across workspace
                    tabs.
                </p>
                <div className="terminal-frame" ref={frame}>
                    <SerialBeach active={props.visible && !props.blocked && documentVisible} />
                    <div className="terminal-copy-control">
                        <CopyButton
                            text={() => terminalCopyText(term.current)}
                            label="Copy serial output"
                            buttonRef={copy}
                            onCopy={(text) =>
                                bridge ? bridge.copyText(text) : navigator.clipboard.writeText(text)
                            }
                        />
                    </div>
                    <div ref={container} className="terminal-screen" />
                </div>
            </div>
            {chooser && (
                <Modal
                    title="Choose a local serial port"
                    onClose={() => {
                        action(() => bridge!.selectSerialPort!(chooser.id, ''));
                        session.cancelSelection();
                    }}
                >
                    <p>Choose one port on this computer. Selection does not open it.</p>
                    <div className="serial-chooser-list">
                        {chooser.ports.map((port) => (
                            <button
                                key={port.id}
                                className="button secondary"
                                onClick={() => {
                                    pendingLabel.current = port.name;
                                    action(() => bridge!.selectSerialPort!(chooser.id, port.id));
                                }}
                            >
                                {port.name}
                                {port.displayName ? ' · ' + port.displayName : ''}
                            </button>
                        ))}
                    </div>
                    {!chooser.ports.length && (
                        <p role="status">
                            No selectable local ports were offered. Attach your adapter or cancel.
                        </p>
                    )}
                </Modal>
            )}
        </section>
    );
}
