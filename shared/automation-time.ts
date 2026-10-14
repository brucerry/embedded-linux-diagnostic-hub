import { boundedNumber } from './automation';
interface Calendar {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}
function calendar(text: string): Calendar {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (!m) throw Error('Start date/time: use YYYY-MM-DD and HH:mm[:ss].');
    const [year, month, day, hour, minute, second] = m.slice(1).map((x) => Number(x ?? 0));
    if (
        year < 1970 ||
        year > 9999 ||
        month < 1 ||
        month > 12 ||
        hour > 23 ||
        minute > 59 ||
        second > 59
    )
        throw Error('Start date/time: component is out of range.');
    const days = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if (day < 1 || day > days[month - 1])
        throw Error('Start date: that calendar day does not exist.');
    return { year, month, day, hour, minute, second };
}
const stamp = (c: Calendar) => Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
function formatter(zone: string) {
    if (typeof zone !== 'string' || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(zone))
        throw Error('Start timezone: choose a valid IANA timezone; enter UTC offsets separately.');
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
    } catch {
        throw Error('Start timezone: choose a valid IANA timezone.');
    }
}
function parts(f: Intl.DateTimeFormat, epoch: number) {
    const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map((x) => [x.type, x.value]));
    return {
        year: Number(p.year),
        month: Number(p.month),
        day: Number(p.day),
        hour: Number(p.hour),
        minute: Number(p.minute),
        second: Number(p.second),
    };
}
export function offsetLabel(minutes: number) {
    return (
        (minutes < 0 ? '-' : '+') +
        String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0') +
        ':' +
        String(Math.abs(minutes) % 60).padStart(2, '0')
    );
}
export function wallTimeOptions(text: string, zone: string): { epochMs: number; offset: string }[] {
    const c = calendar(text),
        naive = stamp(c),
        f = formatter(zone),
        offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 3) {
        const t = naive + h * 3600000;
        offsets.add((stamp(parts(f, t)) - t) / 60000);
    }
    const matches = [...offsets]
        .map((o) => ({ epochMs: naive - o * 60000, offset: offsetLabel(o) }))
        .filter((x) => stamp(parts(f, x.epochMs)) === naive);
    if (!matches.length)
        throw Error('Start time: this local time does not exist because of a timezone/DST change.');
    return matches.sort((a, b) => a.epochMs - b.epochMs);
}
export function resolveWallTime(
    text: string,
    zone: string,
    chosenOffset?: string,
): { epochMs: number; zone: string; offset: string; alternatives: string[] } {
    const matches = wallTimeOptions(text, zone);
    if (matches.length > 1 && !chosenOffset)
        throw Error('Start time: this local time repeats. Choose the earlier or later occurrence.');
    const selected = chosenOffset ? matches.find((x) => x.offset === chosenOffset) : matches[0];
    if (!selected) throw Error('Start UTC offset: it does not match this date, time and timezone.');
    return { ...selected, zone, alternatives: matches.map((x) => x.offset) };
}
export function strictIsoInstant(text: string): number {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
        text,
    );
    if (!m) throw Error('Device timestamp: require a complete ISO timestamp with UTC offset.');
    const c = calendar(m[1]);
    let offset = 0;
    if (m[3] !== 'Z') {
        const h = Number(m[3].slice(1, 3)),
            n = Number(m[3].slice(4));
        if (h > 14 || n > 59 || (h === 14 && n !== 0))
            throw Error('Device timestamp: invalid UTC offset.');
        offset = (h * 60 + n) * (m[3][0] === '-' ? -1 : 1);
    }
    return boundedNumber(
        stamp(c) + Number((m[2] ?? '').padEnd(3, '0')) - offset * 60000,
        0,
        253402300799999,
        'Device timestamp',
    );
}

export function validateScheduleMetadata(input: {
    epochMs: number;
    zone: string;
    wallTime?: string;
    utcOffset?: string;
}) {
    if (typeof input.zone !== 'string' || !input.zone || input.zone.length > 128)
        throw Error('Start timezone: choose a valid IANA timezone.');
    const f = formatter(input.zone);
    if (input.wallTime !== undefined && typeof input.wallTime !== 'string')
        throw Error('Start date/time: invalid metadata.');
    if (
        input.utcOffset !== undefined &&
        (typeof input.utcOffset !== 'string' ||
            !/^[-+](?:0\d|1[0-4]):[0-5]\d$/.test(input.utcOffset) ||
            (input.utcOffset.slice(1, 3) === '14' && input.utcOffset.slice(4) !== '00'))
    )
        throw Error('Start UTC offset: use a valid ±HH:mm offset.');
    if (input.wallTime !== undefined) {
        const resolved = resolveWallTime(input.wallTime, input.zone, input.utcOffset);
        if (resolved.epochMs !== input.epochMs)
            throw Error(
                'Start instant: it conflicts with the designated date, time, timezone or UTC offset.',
            );
    } else if (input.utcOffset !== undefined) {
        const second = Math.floor(input.epochMs / 1000) * 1000,
            actual = (stamp(parts(f, second)) - second) / 60000;
        if (offsetLabel(actual) !== input.utcOffset)
            throw Error('Start UTC offset: it conflicts with the resolved instant and timezone.');
    }
}
