export function clockOutput(
    date = '2026-10-09',
    time = '16:35:42',
    offset = '+0800',
    zone = 'CST',
    boot = '11111111-1111-4111-8111-111111111111',
    uptime = '100.50 90.25',
    epoch = '1791534942',
) {
    return `__DIAGNOSTIC_HUB_CLOCK_V1__\n${epoch}|${date}|${time}|${offset}|${zone}\nboot=${boot}\nuptime=${uptime}\n__END_DIAGNOSTIC_HUB_CLOCK_V1__\n`;
}
