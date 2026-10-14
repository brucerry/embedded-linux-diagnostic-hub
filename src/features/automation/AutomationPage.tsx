import { useEffect, useMemo, useRef, useState } from 'react';
import {
    AUTOMATION_LIMITS,
    armPlan,
    calibratedNow,
    bytesBase64,
    serialPayload,
    validatePlan,
    type AutomationPlan,
    type AutomationRecord,
    type AutomationTransport,
    type ClockCalibration,
    type CommandStep,
} from '../../../shared/automation';
import { resolveWallTime, wallTimeOptions } from '../../../shared/automation-time';
import type { DesktopBridge } from '../../../shared/types';
import type { DeviceClockResponse } from '../../../shared/diagnostics/device-clock';
import { SerialSession } from '../serial/session';
import { FlowRunner, ResultStore, type FlowBackend, type FlowState } from './runner';
import { downloadResults, exportResults, type ExportFormat } from './exports';
import { observedDeviceTime } from './serial-completion';
interface Props {
    visible: boolean;
    serial: SerialSession;
    transport:
        | (Partial<AutomationTransport> & {
              readDeviceClock?(connection?: string): Promise<DeviceClockResponse>;
          })
        | null;
    connected: boolean;
    busy: boolean;
    blocked: boolean;
    target: { endpoint: string; username?: string } | null;
    onBusy(value: boolean): void;
    onConnect(): void;
    onSerial(): void;
}
const GUIDE_STEPS = ['Connection', 'Commands', 'Timing', 'Review & Run'];
const step = (): CommandStep => ({
    id: crypto.randomUUID(),
    name: '',
    enabled: true,
    command: '',
    delaySeconds: 0,
});
export default function AutomationPage(props: Props) {
    const [guideStep, setGuideStep] = useState(0);
    const [headerOffset, setHeaderOffset] = useState(84);
    useEffect(() => {
        const header = document.querySelector('.site-header');
        if (!header) return;
        const measure = () => setHeaderOffset(header.getBoundingClientRect().height + 12);
        const observer = new ResizeObserver(measure);
        observer.observe(header);
        measure();
        return () => observer.disconnect();
    }, []);
    const guideHeading = useRef<HTMLHeadingElement>(null),
        resultsHeading = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        if (props.visible) {
            guideHeading.current?.focus({ preventScroll: true });
            guideHeading.current?.scrollIntoView({ block: 'nearest' });
        }
    }, [guideStep]);
    const [steps, setSteps] = useState<CommandStep[]>([step()]),
        [transport, setTransport] = useState<'ssh' | 'serial'>('ssh');
    const [timeout, setTimeoutValue] = useState('60'),
        [repeat, setRepeat] = useState(false),
        [repeatSeconds, setRepeatSeconds] = useState('10'),
        [scheduled, setScheduled] = useState(false),
        [date, setDate] = useState(''),
        [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
        [offset, setOffset] = useState(''),
        [clockKind, setClockKind] = useState<'local' | 'device'>('local');
    const [referenceTick, setReferenceTick] = useState(Date.now());
    const [reorderNotice, setReorderNotice] = useState('');
    const [draggedId, setDraggedId] = useState<string | null>(null);
    const dragOriginal = useRef<CommandStep[] | null>(null);
    const dragTarget = useRef<string | null>(null);
    const dragScroll = useRef({ y: 0, timer: 0 as ReturnType<typeof setInterval> | 0 });
    const dragged = useRef<string | null>(null),
        activityEpoch = useRef(0),
        arming = useRef(false);
    const zones = useMemo(
        () => [...new Set(['UTC', zone, ...Intl.supportedValuesOf('timeZone')])].sort(),
        [],
    );
    const scheduleOptions = useMemo(() => {
        try {
            return { matches: wallTimeOptions(date, zone), error: '' };
        } catch (e) {
            return { matches: [], error: e instanceof Error ? e.message : String(e) };
        }
    }, [date, zone]);
    useEffect(() => {
        const timer = window.setInterval(() => setReferenceTick(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const [captureClock, setCaptureClock] = useState(false),
        [delayDraft, setDelayDraft] = useState<Record<string, string>>({});
    const [ending, setEnding] = useState<AutomationPlan['serial']['lineEnding']>('CR'),
        [prompt, setPrompt] = useState(''),
        [prefix, setPrefix] = useState('');
    const [calibration, setCalibration] = useState<ClockCalibration>(),
        [sampling, setSampling] = useState(false),
        [state, setState] = useState<FlowState>({
            state: 'idle',
            message: 'Ready to build.',
        }),
        [error, setError] = useState(''),
        [running, setRunning] = useState(false);
    const [serialStatus, setSerialStatus] = useState(props.serial.current),
        [rows, setRows] = useState<AutomationRecord[]>([]),
        [selected, setSelected] = useState(new Set<string>()),
        [search, setSearch] = useState(''),
        [status, setStatus] = useState('all'),
        [commandFilter, setCommandFilter] = useState('all'),
        [displayClock, setDisplayClock] = useState('local'),
        [format, setFormat] = useState<ExportFormat>('json'),
        [scope, setScope] = useState('filtered'),
        [newRows, setNewRows] = useState(0);
    const store = useRef(new ResultStore()),
        viewport = useRef<HTMLDivElement>(null),
        follow = useRef(true),
        latest = useRef(props),
        runner = useRef<FlowRunner | null>(null);
    latest.current = props;
    if (!runner.current)
        runner.current = new FlowRunner(
            (next) => {
                setState(next);
                const active = ['waiting', 'running', 'delaying'].includes(next.state);
                setRunning(active);
                latest.current.onBusy(active);
            },
            (r) => {
                store.current.add(r);
                const retained = new Set(store.current.records.map((row) => row.id));
                setSelected((previous) => new Set([...previous].filter((id) => retained.has(id))));
                setRows([...store.current.records]);
                if (follow.current)
                    requestAnimationFrame(() => {
                        if (viewport.current)
                            viewport.current.scrollTop = viewport.current.scrollHeight;
                    });
                else setNewRows((n) => Math.min(AUTOMATION_LIMITS.rows, n + 1));
            },
        );
    useEffect(() => props.serial.subscribe(setSerialStatus), [props.serial]);
    useEffect(() => {
        const interrupt = (reason: string) => {
            activityEpoch.current++;
            runner.current?.interrupt(reason);
        };
        const exit = () => interrupt('Page exited. Arm explicitly to resume.');
        const unsubscribe = window.diagnosticHub?.onAutomationInterrupted?.(interrupt);
        window.addEventListener('pagehide', exit);
        return () => {
            unsubscribe?.();
            window.removeEventListener('pagehide', exit);
            exit();
        };
    }, []);
    useEffect(() => {
        if (props.blocked && runner.current?.busy) runner.current.cancel();
    }, [props.blocked]);
    const connected =
        transport === 'serial'
            ? serialStatus.state === 'connected'
            : props.connected &&
              Boolean(props.transport?.runAutomation && props.transport.automationConnection);
    const value = (s: string, field: string) => {
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s))
            throw Error(field + ': enter a finite nonnegative number.');
        return Number(s);
    };
    const build = () => {
        let start: AutomationPlan['start'] = null;
        if (scheduled) {
            const resolved = resolveWallTime(date, zone, offset || undefined);
            start = {
                epochMs: resolved.epochMs,
                clock: clockKind,
                zone,
                wallTime: date,
                utcOffset: resolved.offset,
                ...(clockKind === 'device' ? { calibration } : {}),
            };
        }
        return validatePlan({
            captureDeviceTime: captureClock,
            transport,
            steps: steps.map((s, i) => ({ ...s, name: s.name.trim() || 'Step ' + (i + 1) })),
            timeoutSeconds: value(timeout, 'Timeout'),
            repeatSeconds: repeat ? value(repeatSeconds, 'Repetition') : null,
            start,
            serial: { lineEnding: ending, prompt, timestampPrefix: prefix },
        });
    };
    let plan: AutomationPlan | undefined,
        validation = '';
    try {
        plan = build();
        if (plan.start)
            armPlan(
                plan,
                Date.now(),
                performance.now(),
                transport === 'ssh'
                    ? (props.transport?.automationConnection?.() ?? '')
                    : String(props.serial.current.generation),
            );
    } catch (e) {
        validation = e instanceof Error ? e.message : String(e);
    }
    const sample = async (active = props.transport): Promise<ClockCalibration> => {
        if (transport !== 'ssh' || !active?.readDeviceClock || !active.automationConnection)
            throw Error(
                'Device clock: arbitrary Serial timestamp latency cannot establish a verified schedule. Use local time.',
            );
        const connection = active.automationConnection(),
            local = Date.now(),
            mono = performance.now(),
            response = await active.readDeviceClock(connection),
            elapsed = performance.now() - mono;
        if (
            response.status !== 'available' ||
            response.sample.epochSeconds === null ||
            response.sample.utcOffsetMinutes === null
        )
            throw Error('Device clock: target epoch/offset are unavailable.');
        if (connection !== active.automationConnection())
            throw Error('Device clock: connection changed.');
        if (elapsed > 2000 || Math.abs(Date.now() - local - elapsed) > 1000)
            throw Error('Device clock: sample uncertainty or clock drift is too large.');
        return {
            source: 'SSH fixed read-only clock sample (date)',
            connection,
            deviceEpochMs: response.sample.epochSeconds * 1000,
            sampledLocalMs: local + elapsed / 2,
            sampledMonoMs: mono + elapsed / 2,
            uncertaintyMs: 1000 + elapsed / 2,
            zone:
                (response.sample.zone ?? 'offset') +
                ' UTC' +
                response.sample.utcOffsetMinutes +
                ' minutes',
        };
    };
    const sampleClicked = () => {
        setSampling(true);
        setError('');
        void sample()
            .then(setCalibration)
            .catch((e) => setError(e.message))
            .finally(() => setSampling(false));
    };
    const start = async (once = false) => {
        if (arming.current || runner.current?.busy) return;
        arming.current = true;
        let lease: string | undefined;
        const desktop = window.diagnosticHub;
        const epoch = activityEpoch.current;
        setError('');
        try {
            const snapshot = build();
            if (once) {
                snapshot.repeatSeconds = null;
            }
            if (document.hidden || !connected || props.busy || props.blocked)
                throw Error('Wait for the selected transport and current collection.');
            const active = props.transport,
                serial = props.serial,
                connection =
                    snapshot.transport === 'ssh'
                        ? active!.automationConnection!()
                        : String(serial.current.generation),
                target =
                    snapshot.transport === 'ssh'
                        ? { ...(props.target ?? { endpoint: 'SSH target' }) }
                        : { endpoint: serial.current.label, serialSettings: serial.framing };
            const backend: FlowBackend = {
                connection: () =>
                    snapshot.transport === 'ssh'
                        ? active!.automationConnection!()
                        : String(serial.current.generation),
                available: () =>
                    snapshot.transport === 'ssh'
                        ? !latest.current.blocked &&
                          latest.current.connected &&
                          latest.current.transport === active
                        : serial.current.state === 'connected',
                acquire: () =>
                    snapshot.transport === 'serial' ? serial.acquireAutomation() : () => {},
                target,
                sampleClock: snapshot.transport === 'ssh' ? () => sample(active) : undefined,
                execute: async (s, p, signal, id) => {
                    if (p.transport === 'serial') {
                        const bytes = serialPayload(s.command, p.serial.lineEnding),
                            capture = await serial.runAutomation(
                                bytes,
                                p.serial.prompt,
                                p.timeoutSeconds * 1000,
                                signal,
                            );
                        return {
                            ...capture,
                            requestBytes: bytesBase64(bytes),
                            deviceTime: observedDeviceTime(
                                capture.stdout,
                                p.serial.timestampPrefix,
                                capture.chunks.at(-1)?.receivedAt ?? new Date().toISOString(),
                            ),
                        };
                    }
                    let deviceTime: AutomationRecord['deviceTime'] = null;
                    if (p.captureDeviceTime) {
                        try {
                            const c = await sample(active);
                            deviceTime = {
                                value: new Date(c.deviceEpochMs).toISOString(),
                                source:
                                    c.source +
                                    ' before command · ±' +
                                    Math.ceil(c.uncertaintyMs) +
                                    ' ms',
                                zone: c.zone,
                                observedAt: new Date(c.sampledLocalMs).toISOString(),
                            };
                        } catch {}
                    }
                    if (signal.aborted)
                        return {
                            stdout: '',
                            stderr: 'Cancelled before command.',
                            exitCode: null,
                            completion: 'cancelled',
                            truncated: false,
                            chunks: [],
                            deviceTime,
                        };
                    const cancel = () => {
                        void active!.cancelAutomation!(id, connection).catch(() => {});
                    };
                    signal.addEventListener('abort', cancel, { once: true });
                    try {
                        if (signal.aborted) cancel();
                        return {
                            ...(await active!.runAutomation!({
                                id,
                                connection,
                                command: s.command,
                                timeoutMs: p.timeoutSeconds * 1000,
                            })),
                            deviceTime,
                        };
                    } finally {
                        signal.removeEventListener('abort', cancel);
                    }
                },
            };
            latest.current.onBusy(true);
            setRunning(true);
            lease = await desktop?.acquireAutomationActivity?.();
            if (
                activityEpoch.current !== epoch ||
                latest.current.blocked ||
                !backend.available() ||
                backend.connection() !== connection
            )
                throw Error(
                    'Automation eligibility changed while arming. Arm explicitly to resume.',
                );
            await runner.current!.start(snapshot, backend);
        } catch (e) {
            setRunning(false);
            latest.current.onBusy(false);
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (lease) await desktop?.releaseAutomationActivity?.(lease).catch(() => {});
            arming.current = false;
            setRunning(false);
            latest.current.onBusy(false);
        }
    };
    const edit = (id: string, patch: Partial<CommandStep>) =>
        setSteps((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const move = (index: number, delta: number) => {
        if (
            running ||
            arming.current ||
            props.blocked ||
            index + delta < 0 ||
            index + delta >= steps.length
        )
            return;
        setReorderNotice('Step moved to position ' + (index + delta + 1));
        setSteps((list) => {
            const next = [...list];
            [next[index], next[index + delta]] = [next[index + delta], next[index]];
            return next;
        });
    };
    const finishDrag = (commit: boolean) => {
        if (!dragged.current) return;
        if (!commit && dragOriginal.current) setSteps(dragOriginal.current);
        setReorderNotice(commit ? 'Step order updated.' : 'Reordering cancelled.');
        dragged.current = null;
        dragOriginal.current = null;
        dragTarget.current = null;
        setDraggedId(null);
        clearInterval(dragScroll.current.timer);
        dragScroll.current.timer = 0;
    };
    const previewDrag = (targetId: string) => {
        const sourceId = dragged.current;
        if (running || arming.current || props.blocked || !sourceId) return;
        if (sourceId === targetId) {
            dragTarget.current = null;
            return;
        }
        if (dragTarget.current === targetId) return;
        dragTarget.current = targetId;
        setSteps((list) => {
            const from = list.findIndex((s) => s.id === sourceId),
                to = list.findIndex((s) => s.id === targetId);
            if (from < 0 || to < 0) return list;
            const next = [...list];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return next;
        });
    };
    useEffect(() => {
        if (running || props.blocked || !props.visible) finishDrag(false);
    }, [running, props.blocked, props.visible]);
    useEffect(() => {
        const cancel = (event: KeyboardEvent) => {
            if (event.key === 'Escape') finishDrag(false);
        };
        const trackPointer = (event: DragEvent) => {
            if (dragged.current) dragScroll.current.y = event.clientY;
        };
        window.addEventListener('keydown', cancel);
        window.addEventListener('dragover', trackPointer, true);
        return () => {
            window.removeEventListener('keydown', cancel);
            window.removeEventListener('dragover', trackPointer, true);
            clearInterval(dragScroll.current.timer);
        };
    }, []);
    let reference = 'Unavailable';
    try {
        const now =
            clockKind === 'device'
                ? calibratedNow(
                      calibration!,
                      referenceTick,
                      performance.now(),
                      props.transport?.automationConnection?.() ?? '',
                  )
                : referenceTick;
        reference = new Intl.DateTimeFormat(undefined, {
            timeZone: zone,
            dateStyle: 'medium',
            timeStyle: 'long',
            hourCycle: 'h23',
        }).format(now);
    } catch {
        reference =
            clockKind === 'device'
                ? 'Verified device time unavailable or stale. Sample again.'
                : 'Choose a valid timezone.';
    }
    const filtered = rows.filter(
        (r) =>
            (status === 'all' || r.completion === status) &&
            (commandFilter === 'all' || r.name === commandFilter) &&
            (!search ||
                (r.name + ' ' + r.command + ' ' + r.stdout + ' ' + r.stderr)
                    .toLowerCase()
                    .includes(search.toLowerCase())),
    );
    const chosen =
        scope === 'selected'
            ? rows.filter((r) => selected.has(r.id))
            : scope === 'all'
              ? rows
              : filtered;
    const exportClicked = () => {
        try {
            downloadResults(
                exportResults(
                    chosen,
                    format,
                    scope === 'all' ? 'all-retained' : scope,
                    store.current.evicted,
                ),
                format,
            );
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    return (
        <section className="automation-page" hidden={!props.visible} aria-label="Automation">
            <div className="automation-intro automation-guide-heading">
                <h2>Ordered command flow</h2>
                <button
                    className="button secondary"
                    onClick={() => {
                        resultsHeading.current?.scrollIntoView({ block: 'start' });
                        resultsHeading.current?.focus({ preventScroll: true });
                    }}
                >
                    Results · {rows.length}
                </button>
            </div>
            <nav className="automation-guide-nav" aria-label="Automation setup steps">
                {GUIDE_STEPS.map((name, index) => (
                    <button
                        key={name}
                        className={'automation-guide-tab ' + (guideStep === index ? 'active' : '')}
                        aria-current={guideStep === index ? 'step' : undefined}
                        onClick={() => setGuideStep(index)}
                        disabled={props.blocked}
                    >
                        <span>{index + 1}</span>
                        {name}
                    </button>
                ))}
            </nav>
            {(running || state.state !== 'idle') && (
                <div
                    className={'automation-live-controls ' + (running ? 'is-running' : '')}
                    style={{ top: running ? headerOffset : undefined }}
                >
                    <p className="automation-state" role="status">
                        {state.message}
                        {running ? ' · Draft frozen' : ''}
                    </p>
                    {running && (
                        <div className="automation-run-actions">
                            {' '}
                            <button
                                className="button"
                                disabled={!running}
                                onClick={() => runner.current!.stop()}
                            >
                                Stop
                            </button>
                            <button
                                className="button danger"
                                disabled={!running}
                                onClick={() => runner.current!.cancel()}
                            >
                                Cancel run
                            </button>
                        </div>
                    )}
                </div>
            )}
            <div className="automation-guide-card">
                <h3
                    id="automation-guide-title"
                    style={{ scrollMarginTop: headerOffset }}
                    ref={guideHeading}
                    tabIndex={-1}
                >
                    {GUIDE_STEPS[guideStep]}
                </h3>
                <div
                    className="automation-stage"
                    hidden={guideStep !== 0}
                    role="group"
                    aria-label="Connection"
                >
                    {' '}
                    <div className="automation-toolbar">
                        {!connected && (
                            <button
                                className="button secondary"
                                onClick={transport === 'ssh' ? props.onConnect : props.onSerial}
                            >
                                {transport === 'ssh' ? 'Connect SSH' : 'Serial controls'}
                            </button>
                        )}
                        <label>
                            Transport
                            <select
                                aria-label="Automation transport"
                                value={transport}
                                onChange={(e) => {
                                    setTransport(e.target.value as 'ssh' | 'serial');
                                    setCalibration(undefined);
                                }}
                            >
                                <option value="ssh">SSH</option>
                                <option value="serial">Serial</option>
                            </select>
                        </label>
                        <span className="automation-session" id="automation-connection-state">
                            {connected
                                ? 'Connected · ' +
                                  (transport === 'ssh'
                                      ? props.target?.endpoint
                                      : serialStatus.label)
                                : 'Disconnected'}
                        </span>
                    </div>
                    <div className="automation-fields automation-serial-fields">
                        {' '}
                        {transport === 'serial' && (
                            <>
                                <label>
                                    Append line ending
                                    <select
                                        aria-label="Serial automation line ending"
                                        value={ending}
                                        onChange={(e) => setEnding(e.target.value as typeof ending)}
                                    >
                                        {['none', 'CR', 'LF', 'CRLF'].map((x) => (
                                            <option key={x}>{x}</option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    Completion prompt
                                    <input
                                        aria-label="Serial completion prompt"
                                        value={prompt}
                                        onChange={(e) => setPrompt(e.target.value)}
                                    />
                                </label>
                                <details className="automation-more">
                                    <summary>Timestamp capture</summary>{' '}
                                    <label>
                                        Received timestamp prefix
                                        <input
                                            aria-label="Serial timestamp prefix"
                                            value={prefix}
                                            onChange={(e) => setPrefix(e.target.value)}
                                        />
                                    </label>
                                </details>
                                <small className="automation-note">
                                    Prompt match is not an exit code.
                                </small>
                            </>
                        )}
                    </div>
                </div>
                <div
                    className="automation-stage"
                    hidden={guideStep !== 1}
                    role="group"
                    aria-label="Commands"
                >
                    {' '}
                    <p className="automation-note">
                        Step names label results. Enter executable text in each command editor
                        below.
                    </p>
                    <p aria-live="polite" className="automation-reorder-notice">
                        {reorderNotice}
                    </p>
                    <ol className="automation-steps">
                        {steps.map((s, i) => (
                            <li
                                key={s.id}
                                data-step-id={s.id}
                                draggable={!running && !props.blocked}
                                onPointerDownCapture={(e) => {
                                    const interactive = (e.target as Element).closest(
                                        'input, textarea, select, button, a, label, [contenteditable], [role="button"], [role="textbox"], [role="checkbox"], [role="slider"], [data-no-drag]',
                                    );
                                    e.currentTarget.draggable =
                                        !interactive && !running && !props.blocked;
                                }}
                                onDragStart={(e) => {
                                    if (
                                        running ||
                                        arming.current ||
                                        props.blocked ||
                                        !e.currentTarget.draggable
                                    ) {
                                        e.preventDefault();
                                        return;
                                    }
                                    dragged.current = s.id;
                                    dragOriginal.current = [...steps];
                                    setDraggedId(s.id);
                                    dragScroll.current.y = e.clientY;
                                    dragScroll.current.timer = setInterval(() => {
                                        const { y } = dragScroll.current;
                                        if (y < 72) window.scrollBy(0, -16);
                                        else if (y > innerHeight - 72) window.scrollBy(0, 16);
                                    }, 50);
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setData('text/plain', s.id);
                                }}
                                onDragEnd={() => finishDrag(false)}
                                className={draggedId === s.id ? 'automation-drag-placeholder' : ''}
                                onDragOver={(e) => {
                                    if (!dragged.current || running || props.blocked) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    dragScroll.current.y = e.clientY;
                                    previewDrag(s.id);
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    finishDrag(true);
                                }}
                            >
                                <span
                                    className="automation-drag-handle"
                                    role="img"
                                    aria-label={
                                        'Drag step ' +
                                        (i + 1) +
                                        ' to reorder; use move buttons with keyboard'
                                    }
                                >
                                    ⠿
                                </span>
                                <div className="automation-step-heading">
                                    <strong>{i + 1}</strong>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={s.enabled}
                                            onChange={(e) =>
                                                edit(s.id, { enabled: e.target.checked })
                                            }
                                        />
                                        Enabled
                                    </label>
                                    <input
                                        aria-label={'Step ' + (i + 1) + ' name (optional)'}
                                        placeholder="Step name (optional)"
                                        value={s.name}
                                        maxLength={120}
                                        onChange={(e) => edit(s.id, { name: e.target.value })}
                                    />
                                    <div className="automation-step-actions">
                                        <button
                                            className="button secondary"
                                            aria-label={'Move command ' + (i + 1) + ' up'}
                                            disabled={running || props.blocked || i === 0}
                                            onClick={() => move(i, -1)}
                                        >
                                            ↑
                                        </button>
                                        <button
                                            className="button"
                                            aria-label={'Move command ' + (i + 1) + ' down'}
                                            disabled={
                                                running || props.blocked || i === steps.length - 1
                                            }
                                            onClick={() => move(i, 1)}
                                        >
                                            ↓
                                        </button>
                                        <button
                                            className="button"
                                            disabled={steps.length >= 20}
                                            onClick={() =>
                                                setSteps((list) => {
                                                    const next = [...list];
                                                    next.splice(i + 1, 0, {
                                                        ...s,
                                                        id: crypto.randomUUID(),
                                                        name: s.name + ' copy',
                                                    });
                                                    return next;
                                                })
                                            }
                                        >
                                            Duplicate
                                        </button>
                                        <button
                                            className="button"
                                            disabled={steps.length === 1}
                                            onClick={() =>
                                                setSteps((list) =>
                                                    list.filter((x) => x.id !== s.id),
                                                )
                                            }
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                                <textarea
                                    aria-label={'Command ' + (i + 1) + ' script'}
                                    value={s.command}
                                    rows={3}
                                    spellCheck={false}
                                    placeholder={
                                        transport === 'ssh'
                                            ? 'Type your script'
                                            : 'Type the console payload'
                                    }
                                    disabled={transport === 'serial' && Boolean(s.enterOnly)}
                                    onChange={(e) =>
                                        edit(s.id, { command: e.target.value, enterOnly: false })
                                    }
                                />
                                {transport === 'serial' && (
                                    <label className="automation-enter-only">
                                        <input
                                            type="checkbox"
                                            aria-label={'Command ' + (i + 1) + ' send Enter only'}
                                            checked={Boolean(s.enterOnly)}
                                            onChange={(e) =>
                                                edit(s.id, {
                                                    enterOnly: e.target.checked,
                                                    ...(e.target.checked ? { command: '' } : {}),
                                                })
                                            }
                                        />
                                        Send Enter only
                                    </label>
                                )}
                            </li>
                        ))}
                    </ol>
                    <button
                        className="button"
                        disabled={steps.length >= 20}
                        onClick={() => setSteps((list) => [...list, step()])}
                    >
                        Add command
                    </button>
                </div>
                <div
                    className="automation-stage"
                    hidden={guideStep !== 2}
                    role="group"
                    aria-label="Timing"
                >
                    {' '}
                    <div className="automation-settings">
                        <div className="automation-fields">
                            <label>
                                Timeout (s)
                                <input
                                    aria-label="Command timeout"
                                    value={timeout}
                                    onChange={(e) => setTimeoutValue(e.target.value)}
                                />
                            </label>
                            <label>
                                Run mode
                                <select
                                    aria-label="Run mode"
                                    value={scheduled ? 'scheduled' : 'immediate'}
                                    disabled={running}
                                    onChange={(e) => setScheduled(e.target.value === 'scheduled')}
                                >
                                    <option value="immediate">Start immediately</option>
                                    <option value="scheduled">Start at chosen date and time</option>
                                </select>
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={repeat}
                                    disabled={running}
                                    onChange={(e) => setRepeat(e.target.checked)}
                                />
                                Repeat completed flow
                            </label>
                            <label>
                                Repeat delay (s)
                                <input
                                    aria-label="Repetition delay"
                                    disabled={!repeat || running}
                                    value={repeatSeconds}
                                    onChange={(e) => setRepeatSeconds(e.target.value)}
                                />
                            </label>
                            <fieldset
                                className="automation-schedule-fields"
                                disabled={!scheduled || running}
                            >
                                <legend>Chosen start</legend>
                                <label>
                                    Start date
                                    <input
                                        type="date"
                                        aria-label="Scheduled start date"
                                        value={date.split('T')[0]}
                                        onChange={(e) => {
                                            setDate(
                                                e.target.value +
                                                    'T' +
                                                    (date.split('T')[1] || '00:00:00'),
                                            );
                                            setOffset('');
                                        }}
                                    />
                                </label>
                                <label>
                                    Start time
                                    <input
                                        type="time"
                                        step="1"
                                        aria-label="Scheduled start time"
                                        value={date.split('T')[1] || ''}
                                        onChange={(e) => {
                                            setDate(
                                                (date.split('T')[0] || '') + 'T' + e.target.value,
                                            );
                                            setOffset('');
                                        }}
                                    />
                                </label>
                                <label>
                                    Timezone
                                    <select
                                        aria-label="Start timezone"
                                        value={zone}
                                        onChange={(e) => {
                                            setZone(e.target.value);
                                            setOffset('');
                                        }}
                                    >
                                        {zones.map((z) => (
                                            <option key={z} value={z}>
                                                {z}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    Start clock
                                    <select
                                        aria-label="Start clock"
                                        value={clockKind}
                                        onChange={(e) =>
                                            setClockKind(e.target.value as 'local' | 'device')
                                        }
                                    >
                                        <option value="local">Local host clock</option>
                                        <option value="device">Verified device clock</option>
                                    </select>
                                </label>
                                <p className="automation-offset">
                                    {scheduleOptions.matches.length === 1
                                        ? 'Automatic UTC offset: ' +
                                          scheduleOptions.matches[0].offset
                                        : scheduleOptions.matches.length > 1
                                          ? 'This local time occurs twice. Choose an occurrence.'
                                          : date
                                            ? scheduleOptions.error
                                            : 'Choose a future calendar date and time.'}
                                </p>
                                <label>
                                    Repeated time occurrence
                                    <select
                                        aria-label="Repeated time occurrence"
                                        disabled={scheduleOptions.matches.length < 2}
                                        value={offset}
                                        onChange={(e) => setOffset(e.target.value)}
                                    >
                                        <option value="">Choose if this time repeats</option>
                                        {scheduleOptions.matches.map((m, i) => (
                                            <option key={m.offset} value={m.offset}>
                                                {i === 0 ? 'Earlier' : 'Later'} · UTC{m.offset}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <button
                                    className="button"
                                    disabled={
                                        clockKind !== 'device' ||
                                        transport !== 'ssh' ||
                                        !connected ||
                                        running ||
                                        sampling
                                    }
                                    onClick={sampleClicked}
                                >
                                    {sampling ? 'Sampling…' : 'Sample device clock'}
                                </button>
                                <p className="automation-note">
                                    {calibration
                                        ? calibration.source +
                                          ' · ' +
                                          calibration.zone +
                                          ' · uncertainty ±' +
                                          Math.ceil(calibration.uncertaintyMs) +
                                          ' ms'
                                        : 'Device scheduling requires a verified SSH clock sample. Serial uses local time.'}{' '}
                                    Samples refresh while armed.
                                </p>
                            </fieldset>
                            <p className="automation-current-time">
                                Current {clockKind === 'device' ? 'verified device' : 'local host'}{' '}
                                time in {zone}:{' '}
                                <time aria-label="Current time reference">{reference}</time>.
                            </p>
                            {transport === 'ssh' && (
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={captureClock}
                                        onChange={(e) => setCaptureClock(e.target.checked)}
                                    />
                                    Capture device time
                                </label>
                            )}
                        </div>
                    </div>
                    <div className="automation-delay-list">
                        <h4>Step delays</h4>
                        {steps.map((s, i) => (
                            <label key={s.id} className="automation-delay">
                                {s.name || 'Command ' + (i + 1)} · delay (s)
                                <input
                                    aria-label={'Command ' + (i + 1) + ' delay'}
                                    type="text"
                                    inputMode="decimal"
                                    value={delayDraft[s.id] ?? String(s.delaySeconds)}
                                    onChange={(e) => {
                                        const text = e.target.value;
                                        setDelayDraft((v) => ({ ...v, [s.id]: text }));
                                        edit(s.id, {
                                            delaySeconds: /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)
                                                ? Number(text)
                                                : NaN,
                                        });
                                    }}
                                />
                            </label>
                        ))}
                    </div>
                </div>
                <div
                    className="automation-stage"
                    hidden={guideStep !== 3}
                    role="group"
                    aria-label="Review and run"
                >
                    {' '}
                    <details className="automation-preview" open>
                        <summary>Exact flow preview</summary>
                        <p>
                            {plan?.start
                                ? 'Start ' +
                                  new Date(plan.start.epochMs).toISOString() +
                                  ' · ' +
                                  plan.start.zone +
                                  (plan.start.utcOffset ? ' UTC' + plan.start.utcOffset : '') +
                                  ' · ' +
                                  plan.start.clock +
                                  ' clock'
                                : scheduled
                                  ? 'Scheduled start draft: ' + date + ' in ' + zone
                                  : 'Immediate start'}{' '}
                            ·{' '}
                            {repeat
                                ? 'Start flow repeats after ' +
                                  repeatSeconds +
                                  ' seconds; Run once executes one flow'
                                : 'one flow'}{' '}
                            · timeout {timeout}s
                        </p>
                        {steps
                            .filter((s) => s.enabled)
                            .map((s) => (
                                <div key={s.id}>
                                    <strong>
                                        {s.name || 'Step ' + (steps.indexOf(s) + 1)} · delay{' '}
                                        {s.delaySeconds}s
                                    </strong>
                                    <pre>
                                        {JSON.stringify(
                                            s.command +
                                                (transport === 'serial'
                                                    ? {
                                                          none: '',
                                                          CR: '\r',
                                                          LF: '\n',
                                                          CRLF: '\r\n',
                                                      }[ending]
                                                    : ''),
                                        )}
                                    </pre>
                                </div>
                            ))}
                        <small className="automation-note">
                            Escapes shown above. Original text and the selected Serial ending are
                            sent.
                        </small>
                    </details>
                    <div className="automation-run-actions">
                        {' '}
                        <button
                            className="button"
                            disabled={
                                Boolean(validation) ||
                                running ||
                                !connected ||
                                props.busy ||
                                props.blocked
                            }
                            onClick={() => start(true)}
                        >
                            {scheduled ? 'Run once at scheduled time' : 'Run once'}
                        </button>
                        <button
                            className="button primary"
                            disabled={
                                Boolean(validation) ||
                                running ||
                                !connected ||
                                props.busy ||
                                props.blocked
                            }
                            onClick={() => start()}
                        >
                            Start flow
                        </button>
                    </div>
                    <small className="automation-note">
                        Stop finishes the active command. Cancel cannot undo sent commands.
                    </small>
                    {!connected && (
                        <button
                            className="button secondary"
                            onClick={transport === 'ssh' ? props.onConnect : props.onSerial}
                        >
                            {transport === 'ssh' ? 'SSH connection' : 'Serial controls'}
                        </button>
                    )}
                </div>
                {(error || (guideStep > 0 && validation)) && (
                    <p className="error-banner" role="alert">
                        {error || validation}
                    </p>
                )}
                <div className="automation-guide-footer">
                    <button
                        className="button secondary"
                        disabled={guideStep === 0 || props.blocked}
                        onClick={() => setGuideStep((s) => Math.max(0, s - 1))}
                    >
                        Back
                    </button>
                    {guideStep < 3 && (
                        <button
                            className="button primary"
                            disabled={props.blocked}
                            onClick={() => setGuideStep((s) => Math.min(3, s + 1))}
                        >
                            Next: {GUIDE_STEPS[guideStep + 1]}
                        </button>
                    )}
                </div>
            </div>
            <div className="automation-results-heading">
                <h2
                    id="automation-results-title"
                    style={{ scrollMarginTop: headerOffset }}
                    ref={resultsHeading}
                    tabIndex={-1}
                >
                    Results
                </h2>
                <span>
                    {rows.length} retained · {store.current.evicted} evicted · max{' '}
                    {AUTOMATION_LIMITS.rows} rows / 8 MiB
                </span>
                <button
                    className="button"
                    disabled={running || !rows.length}
                    onClick={() => {
                        store.current.clear();
                        setRows([]);
                        setSelected(new Set());
                    }}
                >
                    Clear retained results
                </button>
            </div>
            <div className="automation-fields">
                <label>
                    Search
                    <input
                        aria-label="Search automation results"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </label>
                <label>
                    Status
                    <select
                        aria-label="Result completion filter"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                    >
                        <option value="all">All</option>
                        {[
                            'exit',
                            'signalled',
                            'uncertain-close',
                            'prompt-observed',
                            'timeout',
                            'cancelled',
                            'transport-error',
                            'output-limit',
                        ].map((x) => (
                            <option key={x}>{x}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Command
                    <select
                        aria-label="Result command filter"
                        value={commandFilter}
                        onChange={(e) => setCommandFilter(e.target.value)}
                    >
                        <option value="all">All</option>
                        {[...new Set(rows.map((r) => r.name))].map((x) => (
                            <option key={x}>{x}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Display timestamps
                    <select
                        aria-label="Result timestamp clock"
                        value={displayClock}
                        onChange={(e) => setDisplayClock(e.target.value)}
                    >
                        <option value="local">Local host</option>
                        <option value="device">Device observation</option>
                    </select>
                </label>
            </div>
            <div
                className="automation-results"
                ref={viewport}
                onScroll={() => {
                    const el = viewport.current!;
                    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
                    if (follow.current) setNewRows(0);
                }}
            >
                <table>
                    <thead>
                        <tr>
                            <th>Select</th>
                            <th>Time</th>
                            <th>Command</th>
                            <th>Completion</th>
                            <th>Duration</th>
                            <th>Exit</th>
                            <th>Output</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((r) => (
                            <tr key={r.id}>
                                <td>
                                    <input
                                        aria-label={'Select result ' + r.name + ' ' + r.id}
                                        type="checkbox"
                                        checked={selected.has(r.id)}
                                        onChange={(e) =>
                                            setSelected((list) => {
                                                const next = new Set(list);
                                                if (e.target.checked) next.add(r.id);
                                                else next.delete(r.id);
                                                return next;
                                            })
                                        }
                                    />
                                </td>
                                <td>
                                    <time
                                        dateTime={
                                            displayClock === 'local'
                                                ? r.startedAt
                                                : r.deviceTime?.value
                                        }
                                        title={displayClock === 'local' ? r.startedAt : undefined}
                                    >
                                        {displayClock === 'local'
                                            ? new Date(r.startedAt).toLocaleString(undefined, {
                                                  timeZone: r.localZone,
                                              })
                                            : (r.deviceTime?.value ?? 'Unavailable')}
                                    </time>
                                    <small>
                                        {displayClock === 'local'
                                            ? r.localZone
                                            : (r.deviceTime?.source ??
                                              'No verified device observation')}
                                    </small>
                                </td>
                                <td>
                                    {r.name}
                                    <small>
                                        {r.transport} · flow step {r.ordinal}
                                    </small>
                                </td>
                                <td>
                                    {r.completion}
                                    {r.termination ? ' · ' + r.termination.signal : ''}
                                    {r.truncated ? ' · truncated' : ''}
                                </td>
                                <td>{Math.round(r.durationMs)} ms</td>
                                <td>{r.exitCode ?? 'Unavailable'}</td>
                                <td>
                                    <details>
                                        <summary>
                                            {(r.stdout || r.stderr || 'No output').slice(0, 100)}
                                        </summary>
                                        {r.termination && (
                                            <p>
                                                Signal: {r.termination.signal} · core dump:{' '}
                                                {r.termination.coreDumped === null
                                                    ? 'unavailable'
                                                    : String(r.termination.coreDumped)}{' '}
                                                ·{' '}
                                                {r.termination.message ??
                                                    'No termination message reported'}
                                                {r.termination.truncated
                                                    ? ' (termination evidence truncated)'
                                                    : ''}
                                            </p>
                                        )}
                                        <strong>Command</strong>
                                        <pre>{r.command}</pre>
                                        <strong>Output</strong>
                                        <pre>{r.stdout}</pre>
                                        <strong>Error output</strong>
                                        <pre>{r.stderr}</pre>
                                        <button
                                            className="button"
                                            onClick={() => {
                                                void (
                                                    window.diagnosticHub?.copyText
                                                        ? window.diagnosticHub.copyText(r.stdout)
                                                        : navigator.clipboard.writeText(r.stdout)
                                                ).catch((e) => setError(String(e)));
                                            }}
                                        >
                                            Copy output
                                        </button>
                                    </details>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!filtered.length && <p>No retained matching results.</p>}
            </div>
            {newRows > 0 && (
                <button
                    className="button"
                    onClick={() => {
                        follow.current = true;
                        setNewRows(0);
                        if (viewport.current)
                            viewport.current.scrollTop = viewport.current.scrollHeight;
                    }}
                >
                    {newRows} new results · jump to latest
                </button>
            )}
            <div className="automation-fields">
                <label>
                    Export scope
                    <select
                        aria-label="Automation export scope"
                        value={scope}
                        onChange={(e) => setScope(e.target.value)}
                    >
                        <option value="filtered">Filtered ({filtered.length})</option>
                        <option value="selected">
                            Selected ({rows.filter((r) => selected.has(r.id)).length})
                        </option>
                        <option value="all">All retained ({rows.length})</option>
                    </select>
                </label>
                <label>
                    Format
                    <select
                        aria-label="Automation export format"
                        value={format}
                        onChange={(e) => setFormat(e.target.value as ExportFormat)}
                    >
                        <option value="json">JSON · exact retained text/raw bytes</option>
                        <option value="csv">CSV · formula-safe cells</option>
                        <option value="markdown">Markdown</option>
                        <option value="text">Plain text</option>
                    </select>
                </label>
                <button className="button" disabled={!chosen.length} onClick={exportClicked}>
                    Download QA results
                </button>
            </div>
            <p className="automation-warning">
                Review for secrets. Exports cover retained rows only; evicted rows cannot be
                recovered.
            </p>
        </section>
    );
}
