import type { SVGProps } from 'react';

// Original 24px SVG artwork. No Font Awesome assets or network fonts are required.
// Shared by both editions so every icon remains available offline.
const drawings: Record<string, React.ReactNode> = {
    system: (
        <>
            <rect x="5" y="5" width="14" height="14" rx="5" fill="currentColor" fillOpacity=".15" />
            <rect x="9" y="9" width="6" height="6" rx="2" />
            <path d="M8 2v3m8-3v3M8 19v3m8-3v3M2 8h3m-3 8h3M19 8h3m-3 8h3" />
        </>
    ),
    memory: (
        <>
            <rect x="3" y="6" width="18" height="12" rx="4" fill="currentColor" fillOpacity=".15" />
            <path d="M7 10v4m5-4v4m5-4v4M7 18v3m5-3v3m5-3v3" />
        </>
    ),
    storage: (
        <>
            <rect x="4" y="3" width="16" height="18" rx="5" fill="currentColor" fillOpacity=".15" />
            <path d="M4 15h16m-11 3h.01M8 7h8" />
        </>
    ),
    network: (
        <>
            <rect x="8" y="2" width="8" height="6" rx="2.5" fill="currentColor" fillOpacity=".15" />
            <rect x="2" y="16" width="8" height="6" rx="2.5" />
            <rect x="14" y="16" width="8" height="6" rx="2.5" />
            <path d="M12 8v4m-6 4v-4h12v4" />
        </>
    ),
    processes: (
        <>
            <rect x="3" y="3" width="18" height="18" rx="6" fill="currentColor" fillOpacity=".15" />
            <path d="M6 12h3l2-5 3 10 2-5h2" />
        </>
    ),
    services: (
        <>
            <path d="m12 3 9 5-9 5-9-5 9-5Z" fill="currentColor" fillOpacity=".15" />
            <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
    ),
    logs: (
        <>
            <rect x="3" y="4" width="18" height="16" rx="5" fill="currentColor" fillOpacity=".15" />
            <path d="m7 9 3 3-3 3m6 0h4" />
        </>
    ),
    hardware: (
        <>
            <path
                d="M8 3v4m8-4v4M5 7h14v3a7 7 0 0 1-14 0V7Z"
                fill="currentColor"
                fillOpacity=".15"
            />
            <path d="M12 17v4" />
        </>
    ),
    leds: (
        <>
            <path
                d="M7 11a5 5 0 1 1 10 0c0 2-2 3-2 5H9c0-2-2-3-2-5Z"
                fill="currentColor"
                fillOpacity=".2"
            />
            <path d="M9 20h6M12 2v1M3 10H2m20 0h-1M4 3l2 2m14-2-2 2" />
        </>
    ),
    ethernet: (
        <>
            <rect x="4" y="5" width="16" height="14" rx="4" fill="currentColor" fillOpacity=".15" />
            <path d="M8 5V3m4 2V3m4 2V3M8 10h8v5H8zM12 19v3" />
        </>
    ),
    wireless: (
        <>
            <path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0" />
            <circle cx="12" cy="20" r="1" fill="currentColor" />
        </>
    ),
    buttons: (
        <>
            <rect x="3" y="5" width="18" height="14" rx="6" fill="currentColor" fillOpacity=".15" />
            <circle cx="12" cy="12" r="3" />
            <path d="M7 2v1m10-1v1" />
        </>
    ),
    uart: (
        <>
            <rect x="3" y="6" width="18" height="12" rx="4" fill="currentColor" fillOpacity=".15" />
            <path d="M7 10h.01M12 10h.01M17 10h.01M9 14h.01M15 14h.01M1 12h2m18 0h2" />
        </>
    ),
    i2c: (
        <>
            <rect x="2" y="7" width="7" height="10" rx="3" fill="currentColor" fillOpacity=".15" />
            <rect x="15" y="7" width="7" height="10" rx="3" />
            <path d="M9 10h6m-6 4h6M5 4v3m14-3v3M5 17v3m14-3v3" />
        </>
    ),
    i2s: (
        <>
            <rect x="4" y="8" width="5" height="9" rx="2" fill="currentColor" fillOpacity=".15" />
            <path d="m9 8 6-5v18l-6-4m9-9a6 6 0 0 1 0 8m2-11a10 10 0 0 1 0 14" />
        </>
    ),
    spi: (
        <>
            <rect x="7" y="5" width="10" height="14" rx="4" fill="currentColor" fillOpacity=".15" />
            <path d="M3 8h4m-4 4h4m-4 4h4m10-8h4m-4 4h4m-4 4h4M12 9v6" />
        </>
    ),
    flash: (
        <>
            <path
                d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"
                fill="currentColor"
                fillOpacity=".15"
            />
            <path d="m13 6-5 7h4l-1 5 5-7h-4l1-5Z" />
        </>
    ),
    mmc: (
        <>
            <path
                d="M9 3h8a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8l5-5Z"
                fill="currentColor"
                fillOpacity=".15"
            />
            <path d="M10 6v4m4-4v4m3-4v4M8 16h8" />
        </>
    ),
    usb: (
        <>
            <path d="M12 20V3m-3 3 3-3 3 3M12 15l6-4V8m-6 9-6-5V9" />
            <circle cx="6" cy="7" r="2" fill="currentColor" fillOpacity=".2" />
            <rect x="16" y="4" width="4" height="4" rx="1.2" fill="currentColor" fillOpacity=".2" />
            <circle cx="12" cy="20" r="2" fill="currentColor" />
        </>
    ),
    pcie: (
        <>
            <rect x="3" y="4" width="18" height="14" rx="4" fill="currentColor" fillOpacity=".15" />
            <circle cx="14" cy="11" r="3" />
            <path d="M6 8h2m-2 4h2m-2 8v-2m4 2v-2m4 2v-2m4 2v-2" />
        </>
    ),
    power: (
        <>
            <path d="M12 3v8M6 6a9 9 0 1 0 12 0" />
            <path d="M7 14a5 5 0 0 0 10 0" opacity=".35" />
        </>
    ),
    current: (
        <>
            <rect x="3" y="3" width="18" height="18" rx="6" fill="currentColor" fillOpacity=".15" />
            <path d="m13 6-5 7h4l-1 5 5-7h-4l1-5Z" />
        </>
    ),
    temperature: (
        <>
            <path
                d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"
                fill="currentColor"
                fillOpacity=".15"
            />
            <path d="M12 7v10m6-10h2m-2 4h2" />
            <circle cx="12" cy="18" r="1.5" fill="currentColor" />
        </>
    ),
    display: (
        <>
            <rect x="2" y="3" width="20" height="14" rx="5" fill="currentColor" fillOpacity=".15" />
            <path d="M8 21h8m-4-4v4M7 8l3 3 6-4" />
        </>
    ),
    gpio: (
        <>
            <rect x="5" y="5" width="14" height="14" rx="5" fill="currentColor" fillOpacity=".15" />
            <path d="M8 8h.01m4 0h.01m4 0h.01M8 12h.01m4 0h.01m4 0h.01M8 16h.01m4 0h.01m4 0h.01M8 2v3m8-3v3M8 19v3m8-3v3" />
        </>
    ),
    rtc: (
        <>
            <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity=".15" />
            <path d="M12 7v5l3 2M3 3l2 2m16-2-2 2" />
        </>
    ),
    watchdog: (
        <>
            <path
                d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"
                fill="currentColor"
                fillOpacity=".15"
            />
            <path d="M12 7v5l3 2" />
        </>
    ),
    iio: (
        <>
            <rect x="5" y="5" width="14" height="14" rx="6" fill="currentColor" fillOpacity=".15" />
            <circle cx="12" cy="12" r="3" />
            <path d="M2 8v8m20-8v8M8 2h8M8 22h8" />
        </>
    ),
    fans: (
        <>
            <circle cx="12" cy="12" r="2" />
            <path
                d="M10 10C4 7 7 1 11 3c3 1 3 4 2 7m1 1c6-3 9 3 5 6-2 2-5 1-7-3m-1 0c0 7-7 7-8 2-1-3 2-5 6-5"
                fill="currentColor"
                fillOpacity=".15"
            />
        </>
    ),
};
const aliases: Record<string, string> = {
    identity: 'system',
    release: 'system',
    board: 'system',
    cpu: 'system',
    uptime: 'rtc',
    load: 'processes',
    interfaces: 'network',
    routes: 'network',
    ddr: 'memory',
    blockdevices: 'storage',
};

export function RoundedIcon({
    name,
    size = 24,
    ...props
}: SVGProps<SVGSVGElement> & { name: string; size?: number }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            {...props}
        >
            {drawings[aliases[name] ?? name] ?? drawings.system}
        </svg>
    );
}
