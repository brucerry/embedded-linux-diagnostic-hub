import { useEffect, useId, useRef, useState } from 'react';
import { Sprite, duck, pig } from '../terminal/TerminalPlayground';
const palette: Record<string, string> = {
    o: '#95a7ac',
    y: '#ffe6a3',
    q: '#e5bf75',
    w: '#fff9e4',
    b: '#91a3a8',
    r: '#efb187',
    p: '#f8c2cc',
    s: '#da9bac',
};
export function SerialBeach({ active }: { active: boolean }) {
    const sun = useId(),
        scene = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState(240);
    useEffect(() => {
        const measure = () => {
            const bounds = scene.current?.getBoundingClientRect();
            if (bounds && bounds.width > 0 && bounds.height > 0)
                setHeight(Math.max(180, (bounds.height * 640) / bounds.width));
        };
        const observer = new ResizeObserver(measure);
        if (scene.current) observer.observe(scene.current);
        measure();
        return () => observer.disconnect();
    }, []);
    const horizon = (height * 116) / 240,
        shore = (height * 174) / 240,
        sandOffset = shore - 174,
        treeTop = horizon - 22,
        trunkHeight = shore + 16 - treeTop;
    return (
        <div
            ref={scene}
            className={'serial-beach ' + (active ? 'playing' : 'paused')}
            aria-hidden="true"
        >
            <svg
                className="serial-landscape"
                viewBox={'0 0 640 ' + height}
                preserveAspectRatio="none"
                shapeRendering="crispEdges"
                focusable="false"
            >
                <rect width="640" height={height} fill="#d5e9ee" />
                <rect y={horizon} width="640" height={shore - horizon + 8} fill="#a9ced7" />
                <g className="serial-waves" fill="#d4edf0">
                    <g transform={'translate(0 ' + (horizon - 116) + ')'}>
                        <path d="M-32 128h80v3H-32zM80 132h94v3H80zM210 127h118v3H210zM374 134h82v3H374zM510 129h140v3H510z" />
                        <path d="M-26 155h140v3H-26zM180 160h100v3H180zM320 152h136v3H320zM504 158h158v3H504z" />
                    </g>
                </g>
                <path
                    d={'M0 ' + shore + 'h70v-4h80v4h82v-3h92v5h90v-3h88v4h138V' + height + 'H0z'}
                    fill="#ecd9b7"
                />
                <g transform={'translate(0 ' + sandOffset + ')'}>
                    <path
                        d="M0 176h110v3H0zM158 176h154v3H158zM350 178h100v3H350zM480 178h160v3H480z"
                        fill="#fff0d5"
                    />
                    <g fill="#e0c59c">
                        <rect x="124" y="217" width="36" height="3" />
                        <rect x="492" y="222" width="40" height="3" />
                        <rect x="306" y="231" width="20" height="2" />
                    </g>
                </g>
                {[52, 570].map((x) => (
                    <g key={x} transform={'translate(' + x + ' ' + treeTop + ')'}>
                        <path
                            d={
                                'M0 ' +
                                trunkHeight +
                                'h8V' +
                                (trunkHeight - 20) +
                                'h4V52h4V20h-8v28H4V' +
                                (trunkHeight - 24) +
                                'H0z'
                            }
                            fill="#b99b7d"
                        />
                        <g className="serial-palm-leaves">
                            <path
                                d="M12 18h-24v-4h-16v-8h24v4h16V4h-12V-4h20v12h16V4h24v8H44v6H24v6h12v8H20V20z"
                                fill="#95bba0"
                            />
                            <path
                                d="M-26 8h22v4h16v4H0v-2h-18zM24 12h20v4H28v4h-8z"
                                fill="#b6d1b2"
                            />
                        </g>
                    </g>
                ))}
                <g transform={'translate(0 ' + sandOffset + ')'}>
                    <g fill="#9eabb0">
                        <path d="M320 147h4v70h-4zM318 146h8v3h-8z" />
                        <path
                            d="M302 163h42v2h-42zM302 185h42v2h-42zM302 163h2v24h-2zM342 163h2v24h-2z"
                            fill="#fff4df"
                        />
                        {[310, 318, 326, 334].map((x) => (
                            <rect key={x} x={x} y={164} width={1} height={23} />
                        ))}
                        <path d="M304 170h38v1h-38zM304 178h38v1h-38z" />
                    </g>
                    <g transform="translate(216 187)">
                        <g className="serial-volley-duck">
                            <g transform="scale(1.35)">
                                <Sprite pixels={duck} palette={palette} />
                            </g>
                            <path d="M43 15h8v3h5v3h-8v-3h-5z" fill="#ffe6a3" />
                        </g>
                    </g>
                    <g transform="translate(396 186)">
                        <g className="serial-volley-pig">
                            <g transform="scale(1.35)">
                                <Sprite pixels={pig} palette={palette} />
                            </g>
                            <path d="M-7 16h10v5H-7zM-11 12h6v5h-6z" fill="#f8c2cc" />
                        </g>
                    </g>
                    <g className="serial-volleyball">
                        <path
                            d="M-5-10h10v2h3v3h2v10H8v3H5v2H-5V8h-3V5h-2V-5h2v-3h3z"
                            fill="#fff9e8"
                        />
                        <path d="M-4-8h5v4h4v5H1v-2h-5z" fill="#b6cddc" />
                        <path d="M-8 0h5v5h7v3H-4V5h-4z" fill="#f3d4a0" />
                        <path d="M4 0h4v5H4z" fill="#9eb8cb" />
                    </g>
                </g>
            </svg>
            <svg
                className="serial-sun"
                viewBox="0 0 64 64"
                shapeRendering="crispEdges"
                focusable="false"
            >
                <defs>
                    <clipPath id={sun}>
                        <path d="M24 6h16v2h8v4h6v8h4v24h-4v8h-6v4h-8v2H24v-2h-8v-4h-6v-8H6V20h4v-8h6V8h8z" />
                    </clipPath>
                </defs>
                <g transform="rotate(-18 32 32)">
                    <g clipPath={'url(#' + sun + ')'}>
                        <path d="M0 0h64v64H0z" fill="#f7d392" />
                        <g className="serial-sun-surface">
                            {[0, 64].map((x) => (
                                <g key={x} transform={'translate(' + x + ' 0)'}>
                                    <path
                                        d="M0 12h18v3H0zM12 24h23v4H12zM36 16h22v3H36zM40 38h24v4H40zM4 46h25v3H4zM22 56h32v3H22z"
                                        fill="#edbc78"
                                    />
                                    <path
                                        d="M4 18h5v4H4zM28 32h7v5h-7zM48 26h5v4h-5zM14 52h6v3h-6z"
                                        fill="#dda862"
                                    />
                                    <path
                                        d="M20 9h20v2H20zM0 35h16v2H0zM35 48h20v2H35z"
                                        fill="#ffe8b0"
                                    />
                                </g>
                            ))}
                        </g>
                        <path d="M46 0h18v64H46zM40 0h6v64h-6z" fill="#bb844f" opacity=".16" />
                        <path d="M12 14h4v24h-4zM16 10h8v4h-8z" fill="#fff5d6" opacity=".7" />
                    </g>
                </g>
            </svg>
        </div>
    );
}
