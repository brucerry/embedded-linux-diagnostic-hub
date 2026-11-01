/** Report evidence describes recorded instants, not future schedule eligibility. */
export function isReportInstant(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 40) return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return false;
    const offset = match[7];
    if (offset !== 'Z') {
        const hours = Number(offset.slice(1, 3)), minutes = Number(offset.slice(4));
        if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
    }
    // Validate the literal calendar independently of its offset. Date.parse alone
    // normalizes February30 and24:00. String construction also avoids Date.UTC's
    // special interpretation of years00–99 as1900–1999.
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
    return Number.isFinite(Date.parse(value)) &&
        calendar.getUTCFullYear() === Number(match[1]) &&
        calendar.getUTCMonth() + 1 === Number(match[2]) &&
        calendar.getUTCDate() === Number(match[3]) &&
        calendar.getUTCHours() === Number(match[4]) &&
        calendar.getUTCMinutes() === Number(match[5]) &&
        calendar.getUTCSeconds() === Number(match[6]);
}
