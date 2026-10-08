import { useId } from 'react';

const duck = [
    '......oooooo........',
    '.....oyyyyyyo.......',
    '....oywyyyyyyo......',
    '....oyyyybyyyorrr...',
    '....oyyyyyyyyorrro..',
    '.....oyyyyyyo.......',
    '..ooooyyyyyyoooo....',
    '.oyyyyyyyyyyyyyyo...',
    'oyywyyyyyyyyyyyyyo..',
    'oyyyyyoqqqqoyyyyyo..',
    '.oyyyyyqqqqyyyyyo...',
    '..oyyyyyyyyyyyyo....',
    '...oooooooooooo.....',
    '.....orr..orr.......',
    '....orrr.orrr.......',
];
const pig = [
    '....ooo......ooo....',
    '...opspo....opspo...',
    '...opppoooooopppo...',
    '...oppppppppppppo...',
    '..opwppppppppppppo..',
    '..opppbpppppbppppo..',
    '.oppppppppppppppppo.',
    '.opppppsssssspppppo.',
    '.oppppspssspspppppo.',
    'ooppppspssspspppppo.',
    '.opppppsssssspppppo.',
    '..oppppppppppppppo..',
    '...oppsppppppsppo...',
    '....oooooooooooo....',
    '.....obb....obb.....',
];
const colors: Record<string, string> = {
    o: '#273645',
    y: '#f8d574',
    q: '#ce9b4d',
    w: '#fff5d0',
    b: '#17212d',
    r: '#f69b58',
    p: '#efa3b0',
    s: '#cc788e',
};

function Sprite({ pixels }: { pixels: string[] }) {
    return (
        <>
            {pixels.flatMap((row, y) =>
                [...row].flatMap((color, x) =>
                    color === '.' ? (
                        []
                    ) : (
                        <rect
                            key={`${x}-${y}`}
                            x={x * 2}
                            y={y * 2}
                            width="2"
                            height="2"
                            fill={colors[color]}
                        />
                    ),
                ),
            )}
        </>
    );
}

export function TerminalPlayground({ active }: { active: boolean }) {
    const globe = useId();
    return (
        <div className={`terminal-playground ${active ? 'playing' : 'paused'}`} aria-hidden="true">
            <svg
                className="terminal-landscape"
                viewBox="0 0 320 140"
                shapeRendering="crispEdges"
                focusable="false"
            >
                <path d="M0 124h320v16H0z" fill="#314a3c" />
                <path
                    d="M0 124h320v3H0zM24 118h2v6h-2zM26 120h4v2h-4zM284 118h2v6h-2zM286 120h4v2h-4z"
                    fill="#6ca17b"
                />
                <g fill="#85aaba" opacity=".35">
                    <rect x="30" y="33" width="3" height="3" />
                    <rect x="280" y="55" width="3" height="3" />
                    <rect x="240" y="20" width="2" height="2" />
                </g>
                <g className="terminal-trees">
                    {[
                        { x: 34, y: 62 },
                        { x: 264, y: 49 },
                        { x: 292, y: 75 },
                    ].map(({ x, y }) => (
                        <g key={x} transform={`translate(${x} ${y})`}>
                            <rect x="12" y="34" width="6" height={90 - y} fill="#86694e" />
                            <path
                                d="M12 0h6v6h6v6h6v6h-6v6h8v6h6v8H-8v-8h6v-6h8v-6H0v-6h6V6h6z"
                                fill="#426952"
                            />
                            <path d="M12 6h6v6h-6zM6 18h12v6H6zM0 30h18v6H0z" fill="#6d9670" />
                        </g>
                    ))}
                </g>
                <g transform="translate(82 91)">
                    <g className="terminal-duck">
                        <Sprite pixels={duck} />
                    </g>
                </g>
                <g transform="translate(202 91)">
                    <g className="terminal-pig">
                        <Sprite pixels={pig} />
                    </g>
                </g>
                <g className="terminal-play-ball">
                    <path d="M155 112h10v2h2v8h-2v2h-10v-2h-2v-8h2z" fill="#80b7db" />
                    <path d="M155 114h4v4h-4zM161 119h4v3h-4z" fill="#f9d980" />
                </g>
                <g className="terminal-play-heart" fill="#e7a3b6">
                    <path d="M155 62h4v2h2v-2h4v6h-2v2h-2v2h-2v-2h-2v-2h-2z" />
                </g>
            </svg>
            <svg
                className="terminal-earth"
                viewBox="0 0 64 64"
                shapeRendering="crispEdges"
                focusable="false"
            >
                <defs>
                    <clipPath id={globe}>
                        <path d="M24 6h16v2h8v4h6v8h4v24h-4v8h-6v4h-8v2H24v-2h-8v-4h-6v-8H6V20h4v-8h6V8h8z" />
                    </clipPath>
                </defs>
                <g transform="rotate(-23 32 32)">
                    <g clipPath={`url(#${globe})`}>
                        <path d="M0 0h64v64H0z" fill="#518cc6" />
                        <g className="terminal-earth-continents" fill="#89b97d">
                            {[0, 64].map((x) => (
                                <g key={x} transform={`translate(${x} 0)`}>
                                    <path d="M0 16h10v-4h10v4h8v6h-6v6h-8v6H8v-8H0zM18 34h10v6h6v8h-6v8h-6V46h-4zM38 14h18v4h8v12h-8v-4h-8v6h-6v-8h-4zM40 32h12v8h-4v8h-6v-8h-2zM54 46h10v8H54z" />
                                    <path
                                        d="M2 10h16v2H2zM34 6h18v4H34zM30 28h14v2H30zM4 42h10v2H4zM48 54h12v2H48z"
                                        fill="#d7e7df"
                                    />
                                </g>
                            ))}
                        </g>
                        <path d="M0 0h64v10H0zM0 54h64v10H0z" fill="#d7e7df" opacity=".8" />
                        <path d="M46 0h18v64H46zM40 0h6v64h-6z" fill="#1e3557" opacity=".3" />
                        <path d="M12 14h4v24h-4zM16 10h8v4h-8z" fill="#afdaf2" opacity=".5" />
                    </g>
                </g>
            </svg>
        </div>
    );
}
