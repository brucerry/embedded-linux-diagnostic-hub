import { deviceZoneLabel } from '../../shared/diagnostics/device-clock';
import type { DeviceClockState } from '../hooks/useDeviceClock';

const digitSegments = [
    'abcdef',
    'bc',
    'abdeg',
    'abcdg',
    'bcfg',
    'acdfg',
    'acdefg',
    'abc',
    'abcdefg',
    'abcdfg',
];
const segments = {
    a: 'M3 1h10l-2 2H5z',
    b: 'M14 2v10l-2-2V4z',
    c: 'M14 14v10l-2-2v-6z',
    d: 'M3 25h10l-2-2H5z',
    e: 'M2 14v10l2-2v-6z',
    f: 'M2 2v10l2-2V4z',
    g: 'M3 13l2-1h6l2 1-2 1H5z',
};

function SevenSegmentTime({ time }: { time: string }) {
    return (
        <strong className="device-clock-time">
            <span className="visually-hidden">{time}</span>
            <svg viewBox="0 0 80 26" aria-hidden="true" focusable="false">
                {[...time].map((character, index) => (
                    <g key={index} transform={`translate(${[0, 18, 36, 46, 64][index]} 0)`}>
                        {character === ':' ? (
                            <path fill="currentColor" d="M2 7h3v3H2zM2 17h3v3H2z" />
                        ) : (
                            Object.entries(segments).map(([segment, path]) => (
                                <path
                                    key={segment}
                                    d={path}
                                    fill="currentColor"
                                    opacity={
                                        digitSegments[Number(character)].includes(segment)
                                            ? 1
                                            : 0.04
                                    }
                                />
                            ))
                        )}
                    </g>
                ))}
            </svg>
        </strong>
    );
}

function pixelHand(angle: number, length: number) {
    const radians = (angle * Math.PI) / 180;
    return Array.from({ length }, (_, index) => {
        const x = 11 + Math.round(Math.sin(radians) * index);
        const y = 11 - Math.round(Math.cos(radians) * index);
        return `M${x} ${y}h2v2h-2z`;
    }).join('');
}

export function DeviceClock({ status, sample }: DeviceClockState) {
    const label =
        status === 'disconnected'
            ? 'No device connected'
            : status === 'loading'
              ? 'Reading device time…'
              : status === 'unavailable'
                ? 'Device time unavailable'
                : null;
    const hour = sample && !label ? Number(sample.time.slice(0, 2)) : null;
    const minute = sample && !label ? Number(sample.time.slice(3, 5)) : null;
    return (
        <section className={`device-clock device-clock-${status}`} aria-label="Device time">
            <svg
                className="device-clock-art"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
                shapeRendering="crispEdges"
            >
                <path fill="currentColor" d="M6 1h12v2h4v4h2v12h-2v3h-4v2H6v-2H2v-3H0V7h2V3h4z" />
                <path className="device-clock-face" d="M6 4h12v2h3v12h-3v3H6v-3H3V6h3z" />
                <path fill="#5e8c7c" d="M11 4h2v2h-2zM4 11h2v2H4zM11 18h2v2h-2zM18 11h2v2h-2z" />
                {hour !== null && minute !== null && (
                    <>
                        <path
                            className="device-clock-minute-hand"
                            fill="currentColor"
                            d={pixelHand(minute * 6, 7)}
                        />
                        <path
                            className="device-clock-hour-hand"
                            fill="#b8e6d2"
                            d={pixelHand((hour % 12) * 30 + minute * 0.5, 4)}
                        />
                    </>
                )}
                <path fill="#5e8c7c" d="M2 20h4v2H2zM18 20h4v2h-4z" />
            </svg>
            <div className="device-clock-content">
                {sample && !label ? (
                    <>
                        <span className="device-clock-date">
                            <span>{sample.date}</span>
                            {status === 'stale' && (
                                <span className="device-clock-stale">Stale</span>
                            )}
                        </span>
                        <span className="device-clock-zone">{deviceZoneLabel(sample)}</span>
                        <SevenSegmentTime time={sample.time.slice(0, 5)} />
                    </>
                ) : (
                    <>
                        <span className="device-clock-label">Device time</span>
                        <span className="device-clock-status">{label}</span>
                    </>
                )}
            </div>
        </section>
    );
}
