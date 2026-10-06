import { useState } from 'react';
import type { HistoryFrame, Reading } from '../../../shared/diagnostics/presentation';

export function LiveGraph({
    id,
    history,
    readings,
}: {
    id: string;
    history: HistoryFrame[];
    readings: Reading[];
}) {
    const [selection, setSelection] = useState('');
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const choices = readings.filter((r) => !r.group || r.series === 'used');
    const selected = choices.find((r) => r.key === selection) ?? choices[0];
    if (!selected)
        return <p className="graph-note">No numeric readings available for this check.</p>;
    const series = selected.group
        ? readings.filter((r) => r.group === selected.group && r.unit === selected.unit)
        : [selected];
    const lines = series.map((reading, index) => ({
        reading,
        color: index ? 'var(--green)' : 'var(--blue)',
        points: history.flatMap((frame) => {
            const r = frame.readings[id]?.find(
                (r) => r.key === reading.key && r.unit === reading.unit,
            );
            return r ? [{ time: Date.parse(frame.capturedAt), value: r.value }] : [];
        }),
    }));
    const points = lines.flatMap((line) => line.points);
    const times = [...new Set(points.map((p) => p.time))].sort((a, b) => a - b);
    const values = points.map((p) => p.value);
    const low = values.length ? Math.min(...values) : 0,
        high = values.length ? Math.max(...values) : 1;
    const padding = high === low ? Math.max(Math.abs(high) * 0.05, 1) : (high - low) * 0.1;
    const bottom = selected.group
            ? 0
            : ['MiB', '%', 'count', 'RPM'].includes(selected.unit)
              ? Math.max(0, low - padding)
              : low - padding,
        top = Math.max(high + padding, bottom + 1);
    const start = times[0] ?? 0,
        end = times.at(-1) ?? start;
    // Reserve enough horizontal space per sample instead of squeezing a growing history.
    const width = Math.max(760, 105 + Math.max(1, times.length - 1) * 28);
    const plotWidth = width - 105;
    const x = (time: number) =>
        65 + (end === start ? 0.5 : (time - start) / (end - start)) * plotWidth;
    const y = (value: number) => 230 - ((value - bottom) / (top - bottom)) * 200;
    const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const activeTime =
        hoverTime !== null && times.length
            ? times.reduce((a, b) => (Math.abs(b - hoverTime) < Math.abs(a - hoverTime) ? b : a))
            : null;
    return (
        <section className="live-graph">
            <label className="graph-series">
                Reading
                <select
                    aria-label="Graph reading"
                    value={selected.key}
                    onChange={(e) => {
                        setSelection(e.target.value);
                        setHoverTime(null);
                    }}
                >
                    {choices.map((r) => (
                        <option key={r.key} value={r.key}>
                            {r.group ? r.label.replace(/ · Used$/, '') : r.label} ({r.unit})
                        </option>
                    ))}
                </select>
            </label>
            <div className={`graph-summary ${selected.group ? 'paired-summary' : ''}`}>
                {lines.map(({ reading, color }) => (
                    <strong key={reading.key} style={{ color }}>
                        <span className="graph-legend-dot" style={{ background: color }} />
                        {reading.series
                            ? `${reading.series === 'used' ? 'Used' : reading.label.endsWith('Available') ? 'Available' : 'Free'} `
                            : ''}
                        {format(reading.value)} {reading.unit}
                    </strong>
                ))}
                <span>
                    {lines[0].points.length} samples ·{' '}
                    {selected.unit === 'count'
                        ? 'Cumulative kernel counter; decreases may indicate a reset.'
                        : 'Measured snapshot values'}
                </span>
            </div>
            <div className="graph-hover-values" aria-live="polite">
                {activeTime === null ? (
                    <span>
                        Hover across the plot to inspect values · Arrow keys also select samples
                    </span>
                ) : (
                    <>
                        <time>{new Date(activeTime).toLocaleTimeString()}</time>
                        {lines.map((line) => {
                            const point = line.points.find((p) => p.time === activeTime);
                            return (
                                <span key={line.reading.key} style={{ color: line.color }}>
                                    {line.reading.label}:{' '}
                                    <strong>
                                        {point
                                            ? `${format(point.value)} ${selected.unit}`
                                            : 'No sample'}
                                    </strong>
                                </span>
                            );
                        })}
                    </>
                )}
            </div>
            {points.length ? (
                <div className="graph-viewport" tabIndex={0} aria-label="Scrollable graph history">
                    <svg
                        style={{ width }}
                        viewBox={`0 0 ${width} 285`}
                        role="img"
                        tabIndex={0}
                        aria-label={`${series.map((r) => r.label).join(' and ')} over time in ${selected.unit}`}
                        onPointerMove={(event) => {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const at = ((event.clientX - bounds.left) / bounds.width) * width;
                            setHoverTime(
                                start +
                                    Math.max(0, Math.min(1, (at - 65) / plotWidth)) * (end - start),
                            );
                        }}
                        onPointerLeave={() => setHoverTime(null)}
                        onKeyDown={(event) => {
                            if (
                                !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(
                                    event.key,
                                )
                            )
                                return;
                            event.preventDefault();
                            if (event.key === 'Escape') {
                                setHoverTime(null);
                                return;
                            }
                            const index = activeTime === null ? -1 : times.indexOf(activeTime);
                            const next =
                                event.key === 'Home'
                                    ? 0
                                    : event.key === 'End'
                                      ? times.length - 1
                                      : Math.max(
                                            0,
                                            Math.min(
                                                times.length - 1,
                                                index + (event.key === 'ArrowRight' ? 1 : -1),
                                            ),
                                        );
                            setHoverTime(times[next]);
                        }}
                    >
                        {[0, 0.5, 1].map((f) => (
                            <g key={f}>
                                <line
                                    x1="65"
                                    x2={width - 40}
                                    y1={30 + 200 * f}
                                    y2={30 + 200 * f}
                                    stroke="#435063"
                                />
                                <text x="55" y={35 + 200 * f} textAnchor="end">
                                    {format(top - (top - bottom) * f)}
                                </text>
                            </g>
                        ))}
                        {activeTime !== null && (
                            <line
                                className="graph-crosshair"
                                x1={x(activeTime)}
                                x2={x(activeTime)}
                                y1="25"
                                y2="237"
                            />
                        )}
                        {lines.map(({ reading, points, color }) => (
                            <g key={reading.key} data-series={reading.series ?? 'measurement'}>
                                <polyline
                                    points={points
                                        .map((p) => `${x(p.time)},${y(p.value)}`)
                                        .join(' ')}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth="3"
                                />
                                {points.map((p, i) => (
                                    <circle
                                        key={`${p.time}-${i}`}
                                        className={
                                            p.time === activeTime
                                                ? 'graph-point active'
                                                : 'graph-point'
                                        }
                                        cx={x(p.time)}
                                        cy={y(p.value)}
                                        r={p.time === activeTime ? 7 : 4}
                                        fill={color}
                                    >
                                        <title>
                                            {reading.label} ·{' '}
                                            {new Date(p.time).toLocaleTimeString()} ·{' '}
                                            {format(p.value)} {selected.unit}
                                        </title>
                                    </circle>
                                ))}
                            </g>
                        ))}
                        <text x="65" y="266">
                            {new Date(start).toLocaleTimeString()}
                        </text>
                        <text x={width - 40} y="266" textAnchor="end">
                            {new Date(end).toLocaleTimeString()}
                        </text>
                    </svg>
                </div>
            ) : (
                <p className="graph-note">Waiting for a live sample.</p>
            )}
            <p className="graph-note">
                A trend requires at least two live samples. History keeps the latest 120 samples in
                this window.{' '}
                {id === 'processes'
                    ? 'CPU is the interval share of all system CPUs and requires two samples of the same process. Missing readings are not zero; PID reuse starts a new series.'
                    : id === 'memory'
                      ? 'RAM pairs total minus reported free/available with that counterpart. Used includes caches when paired with free.'
                      : ['storage', 'flash', 'blockdevices'].includes(id)
                        ? 'Free is filesystem-available space; reserved blocks may make used plus free smaller than total. Raw device capacity does not establish allocation.'
                        : 'Sensor values follow kernel units; board calibration still applies.'}
            </p>
        </section>
    );
}
