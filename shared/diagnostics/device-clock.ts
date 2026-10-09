export interface DeviceClockSample {
    date: string;
    time: string;
    epochSeconds: number | null;
    utcOffsetMinutes: number | null;
    zone: string | null;
    bootId: string | null;
    uptimeSeconds: number | null;
}

export type DeviceClockResponse =
    | { status: 'available'; sample: DeviceClockSample }
    | { status: 'unavailable'; reason: 'unsupported' | 'failed' };

export const CLOCK_TIMEOUT_MS = 5000;
export const CLOCK_MAX_BYTES = 8192;
const BEGIN = '__DIAGNOSTIC_HUB_CLOCK_V1__';
const END = '__END_DIAGNOSTIC_HUB_CLOCK_V1__';

// Fixed read-only operation; shell-local TZ overrides in the PTY never enter this channel.
export const DEVICE_CLOCK_COMMAND = `printf '${BEGIN}\\n'; LC_ALL=C date '+%s|%Y-%m-%d|%H:%M:%S|%z|%Z' || exit 127; printf 'boot='; if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; else printf '\\n'; fi; printf 'uptime='; if [ -r /proc/uptime ]; then cat /proc/uptime; else printf '\\n'; fi; printf '${END}\\n'`;

function calendar(date: unknown, time: unknown): boolean {
    if (typeof date !== 'string' || typeof time !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return false;
    const parsed = new Date(`${date}T${time}Z`);
    return (
        Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === `${date}T${time}`
    );
}

function optionalNumber(value: string, integer = false): number | null {
    if (!(integer ? /^-?\d{1,15}$/ : /^\d{1,15}(?:\.\d+)?$/).test(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) && (!integer || Number.isSafeInteger(number)) ? number : null;
}

export function parseDeviceClock(output: string): DeviceClockSample {
    if (output.length > CLOCK_MAX_BYTES) throw Error('Invalid device clock output.');
    const lines = output.replace(/\r\n/g, '\n').split('\n');
    const start = lines.indexOf(BEGIN);
    if (
        start < 0 ||
        lines.lastIndexOf(BEGIN) !== start ||
        lines[start + 4] !== END ||
        lines.lastIndexOf(END) !== start + 4
    )
        throw Error('Invalid device clock markers.');
    const fields = lines[start + 1].split('|');
    if (fields.length !== 5 || !calendar(fields[1], fields[2]))
        throw Error('Invalid device clock calendar.');
    const offset = /^([+-])(\d{2})(\d{2})$/.exec(fields[3]);
    const minutes =
        offset && Number(offset[2]) <= 23 && Number(offset[3]) < 60
            ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1)
            : null;
    if (!lines[start + 2].startsWith('boot=') || !lines[start + 3].startsWith('uptime='))
        throw Error('Invalid device clock metadata.');
    const bootId = lines[start + 2].slice(5);
    return {
        date: fields[1],
        time: fields[2],
        epochSeconds: optionalNumber(fields[0], true),
        utcOffsetMinutes: minutes,
        zone: /^[A-Za-z0-9_+./:-]{1,64}$/.test(fields[4]) ? fields[4] : null,
        bootId: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(bootId)
            ? bootId
            : null,
        uptimeSeconds: optionalNumber(lines[start + 3].slice(7).trim().split(/\s+/)[0]),
    };
}

// Only known fields cross the renderer boundary; raw command output never does.
export function validateDeviceClock(input: unknown): DeviceClockResponse {
    const data = input as Partial<DeviceClockResponse> | null;
    if (
        data?.status === 'unavailable' &&
        (data.reason === 'unsupported' || data.reason === 'failed')
    )
        return { status: 'unavailable', reason: data.reason };
    if (data?.status !== 'available' || !data.sample) throw Error('Invalid device clock response.');
    const sample = data.sample;
    if (
        !calendar(sample.date, sample.time) ||
        !(
            sample.epochSeconds === null ||
            (Number.isSafeInteger(sample.epochSeconds) &&
                Math.abs(sample.epochSeconds) <= 8640000000000)
        ) ||
        !(
            sample.utcOffsetMinutes === null ||
            (Number.isInteger(sample.utcOffsetMinutes) && Math.abs(sample.utcOffsetMinutes) < 1440)
        ) ||
        !(
            sample.zone === null ||
            (typeof sample.zone === 'string' && /^[A-Za-z0-9_+./:-]{1,64}$/.test(sample.zone))
        ) ||
        !(
            sample.bootId === null ||
            (typeof sample.bootId === 'string' &&
                /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(sample.bootId))
        ) ||
        !(
            sample.uptimeSeconds === null ||
            (typeof sample.uptimeSeconds === 'number' &&
                Number.isFinite(sample.uptimeSeconds) &&
                sample.uptimeSeconds >= 0 &&
                sample.uptimeSeconds <= Number.MAX_SAFE_INTEGER)
        )
    )
        throw Error('Invalid device clock response.');
    return {
        status: 'available',
        sample: {
            date: sample.date,
            time: sample.time,
            epochSeconds: sample.epochSeconds,
            utcOffsetMinutes: sample.utcOffsetMinutes,
            zone: sample.zone,
            bootId: sample.bootId,
            uptimeSeconds: sample.uptimeSeconds,
        },
    };
}

export function deviceZoneLabel(sample: DeviceClockSample): string {
    const offset = sample.utcOffsetMinutes;
    if (offset === null)
        return sample.zone ? `${sample.zone} · UTC offset unknown` : 'Timezone unknown';
    const absolute = Math.abs(offset);
    const numeric = `UTC${offset < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
    return sample.zone ? `${sample.zone} · ${numeric}` : numeric;
}

export function deviceRebooted(
    previous: Pick<DeviceClockSample, 'bootId' | 'uptimeSeconds'>,
    next: Pick<DeviceClockSample, 'bootId' | 'uptimeSeconds'>,
): boolean {
    return (
        Boolean(previous.bootId && next.bootId && previous.bootId !== next.bootId) ||
        (previous.uptimeSeconds !== null &&
            next.uptimeSeconds !== null &&
            next.uptimeSeconds < previous.uptimeSeconds)
    );
}
