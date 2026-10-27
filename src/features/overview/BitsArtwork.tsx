import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const bitTiming = [
    [0.28, 0],
    [0.43, 0.07],
    [0.61, 0.16],
    [0.79, 0.23],
    [0.97, 0.34],
    [1.13, 0.46],
];

export function BitsArtwork({ collecting }: { collecting: boolean }) {
    const stream = useRef<SVGGElement>(null);
    const [visible, setVisible] = useState(false);
    const [generation, setGeneration] = useState(0);

    useLayoutEffect(() => {
        if (collecting) {
            setGeneration((value) => value + 1);
            setVisible(true);
        }
    }, [collecting]);

    useLayoutEffect(() => {
        if (collecting || !visible) return;
        let cancelled = false;
        const arrivals: Promise<unknown>[] = [];
        const animations = [...(stream.current?.children ?? [])].flatMap((bit) =>
            bit.getAnimations(),
        );
        const launched = animations.some((animation) => {
            const timing = animation.effect!.getTiming();
            return Number(animation.currentTime ?? 0) > Number(timing.delay ?? 0);
        });
        for (const animation of animations) {
            const timing = animation.effect!.getTiming();
            const elapsed = Number(animation.currentTime ?? 0) - Number(timing.delay ?? 0);
            if (launched && elapsed <= 0) {
                animation.cancel();
                continue;
            }
            // Finish the current trip without changing its position or speed.
            // Very short collections can finish before the first animation frame. Allow one
            // finite trip in the draining state instead of flashing and immediately removing it.
            const iterations = Math.max(1, Math.floor(elapsed / Number(timing.duration)) + 1);
            animation.effect!.updateTiming({ iterations });
            arrivals.push(animation.finished.catch(() => {}));
        }
        Promise.all(arrivals).then(() => {
            if (!cancelled) setVisible(false);
        });
        return () => {
            cancelled = true;
        };
    }, [collecting, visible, generation]);
    return (
        <div
            className="device-art bits-art"
            data-transfer={collecting ? 'active' : visible ? 'draining' : 'idle'}
            role="img"
            aria-label={collecting ? 'Collecting data from the device' : 'Computer and device chip'}
        >
            <svg viewBox="0 0 397 150" aria-hidden="true">
                <g className="transfer-computer">
                    <rect
                        x="10"
                        y="47"
                        width="69"
                        height="48"
                        rx="9"
                        fill="#8eb9ee"
                        stroke="#d0e2ff"
                        strokeWidth="2.5"
                    />
                    <rect x="17" y="54" width="55" height="33" rx="4" fill="#233b4e" />
                    <path
                        d="M27 65 L33 70 L27 75 M39 76 H49"
                        fill="none"
                        stroke="#a6d6f5"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    <path
                        d="M39 96 V106 H50 V96 M29 109 H60"
                        fill="none"
                        stroke="#d0e2ff"
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    <circle cx="65" cy="91" r="1.5" fill="#28483c" />
                </g>
                <path
                    className="transfer-link"
                    d="M84 74 H311"
                    fill="none"
                    stroke="#89b6a0"
                    strokeWidth="1.5"
                    strokeDasharray="2 6"
                    strokeLinecap="round"
                />
                <g className="transfer-chip" transform="translate(177 0)">
                    <path
                        d="M138 62 H147 M138 73 H147 M138 84 H147 M197 62 H207 M197 73 H207 M197 84 H207 M160 39 V49 M171 39 V49 M182 39 V49 M160 98 V108 M171 98 V108 M182 98 V108"
                        fill="none"
                        stroke="#afd9c3"
                        strokeWidth="4"
                        strokeLinecap="round"
                    />
                    <rect
                        x="146"
                        y="48"
                        width="52"
                        height="51"
                        rx="13"
                        fill="#8fc5a9"
                        stroke="#c3ebd5"
                        strokeWidth="2.5"
                    />
                    <rect x="158" y="60" width="28" height="27" rx="8" fill="#325d49" />
                    <rect x="165" y="67" width="14" height="13" rx="4" fill="#a5d4ba" />
                </g>
                {visible && (
                    <g key={generation} ref={stream} className="transfer-stream">
                        {bitTiming.map(([duration, delay], i) => (
                            <text
                                key={i}
                                className="transfer-bit"
                                x="308"
                                y={i % 2 ? 85 : 66}
                                style={
                                    {
                                        '--bit-duration': `${duration}s`,
                                        '--bit-delay': `${delay}s`,
                                    } as CSSProperties
                                }
                            >
                                {i % 2}
                            </text>
                        ))}
                    </g>
                )}
            </svg>
        </div>
    );
}
