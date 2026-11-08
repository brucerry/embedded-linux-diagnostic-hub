// Fixed synthetic browser-case inputs and independently specified UTC expectations.
export const SCHEDULE_FIELDS = {
    anchor: '2028-01-01T00:00:00.000Z',
    zone: 'America/New_York',
    gap: { date: '2028-03-12', time: '02:30:00' },
    fold: { date: '2028-11-05', time: '01:30:00' },
    earlier: { offset: '-04:00', utc: '2028-11-05T05:30:00.000Z' },
    later: { offset: '-05:00', utc: '2028-11-05T06:30:00.000Z' },
    command: 'never execute this schedule preview',
};
