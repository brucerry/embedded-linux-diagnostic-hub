import { useEffect, useId, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { Modal } from '../../../components/Modal';
import {
    CARD,
    bounds,
    clamp,
    coordinate,
    displayText,
    edge,
    edgePath,
    initialPositions,
    preview,
    scene,
    snapshot,
} from './model';
import type { FlowExportFormat, FlowInput, Point, Positions } from './types';
import './flow.css';

export default function FlowViewer({ input, onClose }: { input: FlowInput; onClose(): void }) {
    const [active, setActive] = useState(Boolean(input.active && input.busy));
    // A new run switches to its authoritative frozen plan, even if the dialog was already open.
    useEffect(() => {
        if (input.busy && input.active) setActive(true);
    }, [input.busy, input.active?.id]);
    const data = snapshot(input, Boolean(input.busy && input.active) || active);
    const identity = `${data.identity}:${data.nodes.map((n) => n.id).join('|')}`;
    const [positions, setPositions] = useState<Positions>(() => initialPositions(data.nodes));
    const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
    const [pinned, setPinned] = useState(data.nodes[0].id),
        [hovered, setHovered] = useState<string | null>(null);
    const [notice, setNotice] = useState(''),
        [exporting, setExporting] = useState(false);
    const [downscale, setDownscale] = useState(false);
    const viewport = useRef<HTMLDivElement>(null),
        id = useId().replaceAll(':', '');
    const gesture = useRef<{
        id: number;
        node: string | null;
        start: Point;
        position: Point;
        zoom: number;
    } | null>(null);
    const frame = useRef(0),
        queued = useRef<(() => void) | null>(null);
    const job = useRef<AbortController | null>(null);
    const worker = useRef<Worker | null>(null),
        deadline = useRef(0);
    const urls = useRef(new Map<string, number>());
    const latest = useRef({ data, positions });
    latest.current = { data, positions };
    const selected = data.nodes.find((n) => n.id === (hovered ?? pinned)) ?? data.nodes[0];
    const fit = (layout = latest.current.positions) => {
        const element = viewport.current;
        if (!element) return;
        const box = bounds(latest.current.data.nodes, layout);
        const zoom = clamp(
            Math.min(
                (element.clientWidth - 72) / box.width,
                (element.clientHeight - 72) / box.height,
            ),
            0.01,
            1.5,
        );
        setView({
            zoom,
            x: element.clientWidth / 2 - (box.x + box.width / 2) * zoom,
            y: element.clientHeight / 2 - (box.y + box.height / 2) * zoom,
        });
    };
    useEffect(() => {
        const layout = initialPositions(latest.current.data.nodes);
        setPositions(layout);
        setPinned(latest.current.data.nodes[0].id);
        setHovered(null);
        fit(layout);
    }, [identity]);
    useEffect(() => {
        const observer = new ResizeObserver(() => fit());
        if (viewport.current) observer.observe(viewport.current);
        return () => observer.disconnect();
    }, []);
    const endGesture = (cancel = false) => {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        if (!cancel) queued.current?.();
        queued.current = null;
        const current = gesture.current;
        gesture.current = null;
        if (current && viewport.current?.hasPointerCapture(current.id))
            viewport.current.releasePointerCapture(current.id);
    };
    useEffect(
        () => () => {
            endGesture(true);
            job.current?.abort();
            if (worker.current) {
                worker.current.onmessage = null;
                worker.current.onerror = null;
                worker.current.onmessageerror = null;
                worker.current.terminate();
            }
            clearTimeout(deadline.current);
            for (const [url, timer] of urls.current) {
                clearTimeout(timer);
                URL.revokeObjectURL(url);
            }
            urls.current.clear();
        },
        [],
    );
    const zoom = (factor: number, anchor?: Point) => {
        const element = viewport.current;
        if (!element) return;
        const p = anchor ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
        setView((v) => {
            const next = clamp(v.zoom * factor, 0.01, 2.5),
                ratio = next / v.zoom;
            return {
                zoom: next,
                x: clamp(p.x - (p.x - v.x) * ratio, -12000, 12000),
                y: clamp(p.y - (p.y - v.y) * ratio, -12000, 12000),
            };
        });
    };
    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const wheel = (event: WheelEvent) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            const r = element.getBoundingClientRect();
            zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, {
                x: event.clientX - r.left,
                y: event.clientY - r.top,
            });
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
    }, []);
    const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || gesture.current) return;
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-flow-node]');
        const node = button?.dataset.flowNode ?? null;
        if (node) {
            setPinned(node);
            button?.focus({ preventScroll: true });
        } else viewport.current?.focus({ preventScroll: true });
        gesture.current = {
            id: event.pointerId,
            node,
            start: { x: event.clientX, y: event.clientY },
            position: node ? (positions[node] ?? { x: 0, y: 0 }) : view,
            zoom: view.zoom,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
    };
    const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g || g.id !== event.pointerId) return;
        const dx = event.clientX - g.start.x,
            dy = event.clientY - g.start.y;
        queued.current = () => {
            if (g.node)
                setPositions((p) => ({
                    ...p,
                    [g.node!]: {
                        x: coordinate(g.position.x + dx / g.zoom),
                        y: coordinate(g.position.y + dy / g.zoom),
                    },
                }));
            else
                setView((v) => ({
                    ...v,
                    x: clamp(g.position.x + dx, -12000, 12000),
                    y: clamp(g.position.y + dy, -12000, 12000),
                }));
        };
        if (!frame.current)
            frame.current = requestAnimationFrame(() => {
                frame.current = 0;
                queued.current?.();
                queued.current = null;
            });
    };
    const key = (event: KeyboardEvent, node?: string) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const arrows: Record<string, Point> = {
            ArrowLeft: { x: -1, y: 0 },
            ArrowRight: { x: 1, y: 0 },
            ArrowUp: { x: 0, y: -1 },
            ArrowDown: { x: 0, y: 1 },
        };
        const direction = arrows[event.key];
        if (direction) {
            const amount = node ? (event.shiftKey ? 40 : 8) : 40;
            if (node)
                setPositions((p) => ({
                    ...p,
                    [node]: {
                        x: coordinate((p[node]?.x ?? 0) + direction.x * amount),
                        y: coordinate((p[node]?.y ?? 0) + direction.y * amount),
                    },
                }));
            else
                setView((v) => ({
                    ...v,
                    x: clamp(v.x + direction.x * amount, -12000, 12000),
                    y: clamp(v.y + direction.y * amount, -12000, 12000),
                }));
            if (node) {
                const position = positions[node] ?? { x: 0, y: 0 },
                    element = viewport.current;
                if (element)
                    setView((v) => ({
                        ...v,
                        x: element.clientWidth / 2 - (position.x + CARD.width / 2) * v.zoom,
                        y: element.clientHeight / 2 - (position.y + CARD.height / 2) * v.zoom,
                    }));
            }
        } else if (event.key === '+' || event.key === '=') zoom(1.2);
        else if (event.key === '-') zoom(1 / 1.2);
        else if (event.key.toLowerCase() === 'f') fit();
        else if (event.key.toLowerCase() === 'r') {
            const layout = initialPositions(data.nodes);
            setPositions(layout);
            fit(layout);
        } else return;
        event.preventDefault();
        event.stopPropagation();
    };
    const exportGraph = (format: FlowExportFormat) => {
        if (exporting) return;
        let graph;
        try {
            graph = scene({ ...data, capturedAt: new Date().toISOString() }, positions);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error));
            return;
        }
        setExporting(true);
        let foregroundCanvas = false;
        setNotice(`Preparing full ${format.toUpperCase()} snapshot…`);
        const finish = () => {
            job.current?.abort();
            job.current = null;
            if (worker.current) {
                worker.current.onmessage = null;
                worker.current.onerror = null;
                worker.current.onmessageerror = null;
                worker.current.terminate();
            }
            worker.current = null;
            clearTimeout(deadline.current);
            setExporting(false);
        };
        try {
            const task = new Worker(new URL('./export.worker.ts', import.meta.url), {
                type: 'module',
            });
            worker.current = task;
            deadline.current = window.setTimeout(() => {
                finish();
                setNotice('Export exceeded 30 seconds. Use SVG or reset the graph layout.');
            }, 30000);
            task.onerror = () => {
                finish();
                setNotice('The local export worker is unavailable. No file was exported.');
            };
            task.onmessageerror = () => {
                finish();
                setNotice('The local export response could not be read. No file was exported.');
            };
            const completed = (
                event: MessageEvent<{
                    blob?: Blob;
                    width?: number;
                    height?: number;
                    error?: string;
                    progress?: string;
                }>,
            ) => {
                if (event.data.progress) {
                    setNotice(event.data.progress);
                    return;
                }
                finish();
                if (
                    event.data.error ||
                    !event.data.blob ||
                    !event.data.width ||
                    !event.data.height
                ) {
                    setNotice(event.data.error ?? 'Export failed.');
                    return;
                }
                const url = URL.createObjectURL(event.data.blob),
                    anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `automation-flow-${data.kind === 'Draft' ? 'draft' : 'active'}.${format}`;
                anchor.click();
                urls.current.set(
                    url,
                    window.setTimeout(() => {
                        URL.revokeObjectURL(url);
                        urls.current.delete(url);
                    }, 1000),
                );
                setNotice(
                    `${format.toUpperCase()} exported · full graph and command appendix · ${event.data.width} × ${event.data.height} scene units${format === 'png' && downscale ? ' · PNG downscale allowed' : ''}${format === 'png' && foregroundCanvas ? ' · 8 megapixel budget on this engine' : ''}.`,
                );
            };
            task.onmessage = (
                event: MessageEvent<{
                    needsCanvas?: boolean;
                    blob?: Blob;
                    width?: number;
                    height?: number;
                    error?: string;
                    progress?: string;
                }>,
            ) => {
                if (!event.data.needsCanvas) {
                    completed(event);
                    return;
                }
                task.onmessage = null;
                task.onerror = null;
                task.onmessageerror = null;
                task.terminate();
                worker.current = null;
                const controller = new AbortController();
                foregroundCanvas = true;
                job.current = controller;
                setNotice('Preparing local canvas export in short batches…');
                void import('./raster')
                    .then((module) =>
                        module.exportRaster(graph, format, downscale, {
                            signal: controller.signal,
                            pngPixelBudget: 8_000_000,
                            progress: (message) => {
                                if (!controller.signal.aborted) setNotice(message);
                            },
                        }),
                    )
                    .then(
                        (result) => {
                            if (!controller.signal.aborted)
                                completed({ data: result } as MessageEvent);
                        },
                        (error) => {
                            if (!controller.signal.aborted)
                                completed({
                                    data: {
                                        error:
                                            error instanceof Error ? error.message : String(error),
                                    },
                                } as MessageEvent);
                        },
                    );
            };
            task.postMessage({ scene: graph, format, downscale });
        } catch (error) {
            finish();
            setNotice(error instanceof Error ? error.message : String(error));
        }
    };
    return (
        <Modal title="Automation flow" onClose={onClose} wide>
            <div className="flow-viewer">
                <div className="flow-context">
                    <span className="flow-kind">{data.kind}</span>
                    <span className="flow-identity">{data.identity}</span>
                    {input.active && !input.busy && (
                        <label>
                            View{' '}
                            <select
                                aria-label="Flow snapshot"
                                value={active ? 'active' : 'draft'}
                                onChange={(e) => setActive(e.target.value === 'active')}
                            >
                                <option value="draft">Next-run draft</option>
                                <option value="active">Latest frozen plan</option>
                            </select>
                        </label>
                    )}
                </div>
                <p className="flow-summary">{data.summary}</p>
                <p className="flow-timing">{data.timing}</p>
                <div className="flow-toolbar" aria-label="Flow view controls">
                    <button
                        className="button secondary"
                        onClick={() => zoom(1.2)}
                        aria-label="Zoom in"
                    >
                        +
                    </button>
                    <output aria-label="Flow zoom">{Math.round(view.zoom * 100)}%</output>
                    <button
                        className="button secondary"
                        onClick={() => zoom(1 / 1.2)}
                        aria-label="Zoom out"
                    >
                        −
                    </button>
                    <button className="button secondary" onClick={() => fit()}>
                        Fit graph
                    </button>
                    <button
                        className="button secondary"
                        onClick={() => {
                            const layout = initialPositions(data.nodes);
                            setPositions(layout);
                            fit(layout);
                        }}
                    >
                        Reset layout
                    </button>
                    <span>Drag changes the view only. Arrows retain command order.</span>
                </div>
                <div className="flow-body">
                    <div
                        ref={viewport}
                        className="flow-viewport"
                        tabIndex={0}
                        role="group"
                        aria-label="Flow canvas"
                        aria-describedby={`${id}-help`}
                        onKeyDown={(event) => {
                            if (event.target === event.currentTarget) key(event);
                        }}
                        onPointerDown={pointerDown}
                        onPointerMove={pointerMove}
                        onPointerUp={() => endGesture()}
                        onPointerCancel={() => endGesture(true)}
                        onLostPointerCapture={() => {
                            if (gesture.current) endGesture(true);
                        }}
                    >
                        <div
                            className="flow-world"
                            style={{
                                transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                            }}
                        >
                            <svg className="flow-edges" aria-hidden="true">
                                <defs>
                                    <marker
                                        id={`${id}-arrow`}
                                        viewBox="0 0 10 10"
                                        refX="9"
                                        refY="5"
                                        markerWidth="7"
                                        markerHeight="7"
                                        orient="auto"
                                    >
                                        <path d="M0 0 L10 5 L0 10 Z" />
                                    </marker>
                                </defs>
                                {data.nodes.slice(1).map((n, i) => (
                                    <path
                                        key={`${data.nodes[i].id}:${n.id}`}
                                        data-flow-edge={`${i + 1}-${i + 2}`}
                                        d={edgePath(
                                            edge(
                                                positions[data.nodes[i].id] ?? { x: 0, y: 0 },
                                                positions[n.id] ?? { x: 0, y: 0 },
                                            ),
                                        )}
                                        markerEnd={`url(#${id}-arrow)`}
                                    />
                                ))}
                            </svg>
                            {data.nodes.map((n) => (
                                <button
                                    key={n.id}
                                    type="button"
                                    className={`flow-node ${n.enabled ? '' : 'is-disabled'} ${n.status === '▶ Running' ? 'is-running' : ''}`}
                                    data-flow-node={n.id}
                                    data-ordinal={n.ordinal}
                                    style={{
                                        left: positions[n.id]?.x ?? 0,
                                        top: positions[n.id]?.y ?? 0,
                                        width: CARD.width,
                                        height: CARD.height,
                                    }}
                                    aria-label={`Command ${n.ordinal}: ${n.name}. ${n.status}`}
                                    aria-pressed={pinned === n.id}
                                    onClick={() => setPinned(n.id)}
                                    onFocus={() => {
                                        setHovered(n.id);
                                        const p = positions[n.id];
                                        const el = viewport.current;
                                        if (p && el)
                                            setView((v) => {
                                                const x = p.x * v.zoom + v.x,
                                                    y = p.y * v.zoom + v.y;
                                                return x < 0 ||
                                                    y < 0 ||
                                                    x + CARD.width * v.zoom > el.clientWidth ||
                                                    y + CARD.height * v.zoom > el.clientHeight
                                                    ? {
                                                          ...v,
                                                          x:
                                                              el.clientWidth / 2 -
                                                              (p.x + CARD.width / 2) * v.zoom,
                                                          y:
                                                              el.clientHeight / 2 -
                                                              (p.y + CARD.height / 2) * v.zoom,
                                                      }
                                                    : v;
                                            });
                                    }}
                                    onBlur={() => setHovered(null)}
                                    onMouseEnter={() => setHovered(n.id)}
                                    onMouseLeave={() => setHovered(null)}
                                    onKeyDown={(e) => key(e, n.id)}
                                >
                                    <strong>
                                        <span className="flow-ordinal">
                                            {n.ordinal.toString().padStart(2, '0')}
                                        </span>
                                        {preview(n.name, 48)}
                                    </strong>
                                    <span className="flow-intent">
                                        {n.enabled ? 'Enabled' : 'Disabled'} · {n.intent}
                                    </span>
                                    <code>{preview(n.command || '(empty payload)', 64)}</code>
                                    <span className="flow-delay">{n.delay}</span>
                                    <span className="flow-node-status">{n.status}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                    <aside className="flow-details" aria-label="Command details">
                        <span className="flow-eyebrow">
                            {hovered ? 'Inspecting' : 'Pinned details'} · command {selected.ordinal}
                        </span>
                        <h3>{selected.name}</h3>
                        <p>{selected.status}</p>
                        <p>
                            {selected.intent} · {selected.enabled ? 'Enabled' : 'Disabled'}
                            <br />
                            {selected.delay}
                        </p>
                        <pre tabIndex={0} aria-label={`Full command ${selected.ordinal}`}>
                            {displayText(selected.command) || '(empty payload)'}
                        </pre>
                        <p>{data.completion}</p>
                        {selected.criterion && <p>{selected.criterion}</p>}
                        <p className="flow-evidence-note">
                            Recorded results identify the latest recorded run. Pending and paused
                            labels do not imply successful execution. No raw output is copied into
                            this view.
                        </p>
                    </aside>
                </div>
                <details className="flow-help" id={`${id}-help`}>
                    <summary>Keyboard and view controls</summary>
                    <p>
                        Tab to a command; Enter or Space pins its details. Arrow keys nudge a
                        focused command (Shift for larger steps); on the canvas they pan. + / −
                        zoom, F fits, R resets, Escape closes. Ctrl + wheel zooms. Details remain
                        selectable. Layout is kept only while this viewer is open.
                    </p>
                </details>
                <div className="flow-export">
                    <span>Local exports include full commands and may contain secrets.</span>
                    {(['svg', 'png', 'pdf'] as const).map((format) => (
                        <button
                            className="button secondary"
                            disabled={exporting}
                            key={format}
                            onClick={() => exportGraph(format)}
                        >
                            Export {format.toUpperCase()}
                        </button>
                    ))}
                    <label>
                        <input
                            type="checkbox"
                            checked={downscale}
                            onChange={(e) => setDownscale(e.target.checked)}
                        />{' '}
                        Allow PNG downscale
                    </label>
                </div>
                <p
                    className="flow-export-notice"
                    role="status"
                    aria-label="Flow export status"
                    aria-live="polite"
                >
                    {notice}
                </p>
            </div>
        </Modal>
    );
}
