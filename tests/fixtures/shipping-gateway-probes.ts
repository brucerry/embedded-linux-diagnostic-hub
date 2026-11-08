import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { probes } from '../../shared/diagnostics/probes.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const prefix = 'export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; ';
const unavailable = (id: string) => ({
    id,
    stdout: '',
    stderr: 'Fixture capability unavailable: ' + id + '.\n',
    exitCode: 127,
});
// Authored closed inventory: new/reordered product probes must refuse, never auto-fill a result.
// These are synthetic transport bytes, not simulated hardware acceptance or host command execution.
const authored = [
    {
        id: 'identity',
        stdout: 'Linux\nshipping-gateway-fixture\n6.12.0-fixture\nx86_64\n',
        stderr: '',
        exitCode: 0,
    },
    { id: 'release', stdout: 'NAME="Synthetic fixture"\nID=fixture\n', stderr: '', exitCode: 0 },
    unavailable('board'),
    unavailable('cpu'),
    { id: 'uptime', stdout: '100.25 90.00\n', stderr: '', exitCode: 0 },
    unavailable('load'),
    {
        id: 'memory',
        stdout: 'MemTotal: 1048576 kB\nMemFree: 524288 kB\nMemAvailable: 786432 kB\n',
        stderr: '',
        exitCode: 0,
    },
    unavailable('storage'),
    unavailable('interfaces'),
    unavailable('routes'),
    unavailable('processes'),
    unavailable('services'),
    unavailable('logs'),
    unavailable('leds'),
    unavailable('ethernet'),
    unavailable('wireless'),
    unavailable('buttons'),
    unavailable('uart'),
    unavailable('i2c'),
    unavailable('i2s'),
    unavailable('spi'),
    unavailable('flash'),
    unavailable('blockdevices'),
    unavailable('mmc'),
    unavailable('usb'),
    unavailable('pcie'),
    unavailable('power'),
    unavailable('current'),
    unavailable('temperature'),
    unavailable('ddr'),
    unavailable('display'),
    unavailable('gpio'),
    unavailable('rtc'),
    unavailable('watchdog'),
    unavailable('iio'),
    unavailable('fans'),
];
const supplementary = [
    {
        id: 'ip-address-json:all',
        command: `if command -v ip >/dev/null 2>&1; then ip -j address show; else printf "ip is not installed.\\n" >&2; exit 127; fi`,
    },
    {
        id: 'ip-route4-json:IPv4/all tables',
        command: `if command -v ip >/dev/null 2>&1; then ip -j -4 route show table all; else printf "ip is not installed.\\n" >&2; exit 127; fi`,
    },
    {
        id: 'ip-route6-json:IPv6/all tables',
        command: `if command -v ip >/dev/null 2>&1; then ip -j -6 route show table all; else printf "ip is not installed.\\n" >&2; exit 127; fi`,
    },
    {
        id: 'ip-link-json:all',
        command: `if command -v ip >/dev/null 2>&1; then ip -j -d -s link show; else printf "ip is not installed.\\n" >&2; exit 127; fi`,
    },
    {
        id: 'ip-neighbor-json:all',
        command: `if command -v ip >/dev/null 2>&1; then ip -j neigh show; else printf "ip is not installed.\\n" >&2; exit 127; fi`,
    },
];
export function shippingGatewayProbePlan() {
    assert.deepEqual(
        probes.map((p) => p.id),
        authored.map((p) => p.id),
        'Reviewed fixture catalog is stale.',
    );
    const rows = authored.map((row, i) => ({ ...row, command: prefix + probes[i].command }));
    const commands = [
        ...rows,
        ...supplementary.map((r) => ({
            ...r,
            command: prefix + r.command,
            stdout: '',
            stderr: 'ip is not installed.\n',
            exitCode: 127,
        })),
    ];
    assert.equal(commands.length, 41);
    assert.equal(new Set(commands.map((r) => r.command)).size, commands.length);
    assert.ok(
        commands.every(
            (r) =>
                Buffer.byteLength(r.command) <= 16384 &&
                Buffer.byteLength(r.stdout + r.stderr) <= 4096,
        ),
    );
    const expectedProbes = authored.map(({ id, stdout, stderr, exitCode }) =>
        Object.freeze({
            id,
            status: exitCode === 0 ? 'collected' : 'unavailable',
            exitCode,
            stdoutSHA256: digest(stdout),
            stderrSHA256: digest(stderr),
        }),
    );
    const identity = digest(JSON.stringify({ commands, expectedProbes }) + '\n');
    return Object.freeze({
        identity,
        expectedProbes: Object.freeze(expectedProbes),
        commands: Object.freeze(commands.map((r) => Object.freeze(r))),
        reply(command: string) {
            return commands.find((r) => r.command === command) ?? null;
        },
    });
}
