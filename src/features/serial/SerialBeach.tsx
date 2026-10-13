import { Sprite, duck, pig } from '../terminal/TerminalPlayground';
const palette: Record<string, string> = {
    o: '#5a6473',
    y: '#ffe6a3',
    q: '#e5bf75',
    w: '#fff9e4',
    b: '#354558',
    r: '#efb187',
    p: '#f8c2cc',
    s: '#da9bac',
};
export function SerialBeach({ active }: { active: boolean }) {
    return (
        <div className={'serial-beach ' + (active ? 'playing' : 'paused')} aria-hidden="true">
            <svg
                viewBox="0 0 640 240"
                preserveAspectRatio="xMidYMax meet"
                shapeRendering="crispEdges"
                focusable="false"
            >
                <path d="M0 0h640v240H0z" fill="#d5e9ee" />
                <path d="M0 116h640v64H0z" fill="#94c5d1" />
                <g className="serial-waves" fill="#d4edf0">
                    <path d="M-32 128h80v3H-32zM80 132h94v3H80zM210 127h118v3H210zM374 134h82v3H374zM510 129h140v3H510z" />
                    <path d="M-26 155h140v3H-26zM180 160h100v3H180zM320 152h136v3H320zM504 158h158v3H504z" />
                </g>
                <path d="M0 174h70v-4h80v4h82v-3h92v5h90v-3h88v4h138v63H0z" fill="#ecd9b7" />
                <path
                    d="M0 176h110v3H0zM158 176h154v3H158zM350 178h100v3H350zM480 178h160v3H480z"
                    fill="#fff0d5"
                />
                <g fill="#e0c59c">
                    <rect x="124" y="217" width="36" height="3" />
                    <rect x="492" y="222" width="40" height="3" />
                    <rect x="306" y="231" width="20" height="2" />
                </g>
                {[52, 570].map((x) => (
                    <g key={x} transform={'translate(' + x + ' 94)'}>
                        <path d="M0 96h8V76h4V52h4V20h-8v28H4v24H0z" fill="#b99b7d" />
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
                    <path d="M-5-10h10v2h3v3h2v10H8v3H5v2H-5V8h-3V5h-2V-5h2v-3h3z" fill="#fff9e8" />
                    <path d="M-4-8h5v4h4v5H1v-2h-5z" fill="#b6cddc" />
                    <path d="M-8 0h5v5h7v3H-4V5h-4z" fill="#f3d4a0" />
                    <path d="M4 0h4v5H4z" fill="#9eb8cb" />
                </g>
            </svg>
            <div className="serial-beach-veil" />
            <svg
                className="serial-sun"
                viewBox="-36 -36 72 72"
                shapeRendering="crispEdges"
                focusable="false"
            >
                <g className="serial-sun-rays" fill="#f8ddb0">
                    <path d="M-3-34h6v10h-6zM-3 24h6v10h-6zM-34-3h10v6h-10zM24-3h10v6H24zM-24-24h6v6h-6zM18 18h6v6h-6zM18-24h6v6h-6zM-24 18h6v6h-6z" />
                </g>
                <path
                    d="M-10-21h20v3h8v8h3v20h-3v8h-8v3h-20v-3h-8v-8h-3v-20h3v-8h8z"
                    fill="#ffe8ab"
                />
                <path d="M-8-6h3v3h-3zM5-6h3v3H5zM-6 6h12v3H-6z" fill="#b6936d" />
            </svg>
        </div>
    );
}
