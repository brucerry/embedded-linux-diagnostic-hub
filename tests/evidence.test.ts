import assert from 'node:assert/strict';
import test from 'node:test';
import {
    evidencePresentation,
    LOG_COLUMNS,
    type EvidenceNode,
} from '../shared/diagnostics/evidence';
import type { ProbeResult } from '../shared/types';
const result = (stdout: string): ProbeResult => ({
    id: 'test',
    status: 'collected',
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    collectedAt: '2026-10-06T00:00:00Z',
    truncated: false,
});
const leaves = (nodes: EvidenceNode[]): string[] =>
    nodes.flatMap((n) => (n.children ? leaves(n.children) : [n.value ?? n.label]));

test('board JSON becomes meaningful field paths; service JSON retains hierarchy and scalar types', () => {
    const board = evidencePresentation(
        'board',
        result('{"model":"Board","release":{"target":"generic/arm64","version":"25.12"}}'),
    );
    assert.deepEqual(board.table?.rows, [
        ['model', 'Board'],
        ['release.target', 'generic/arm64'],
        ['release.version', '25.12'],
    ]);
    assert.equal(board.tree, undefined);
    const services = evidencePresentation(
        'services',
        result(
            '{"dnsmasq":{"instances":{"cfg":{"running":false,"pid":0,"command":["/usr/sbin/dnsmasq",""],"other":null,"string":"false"}}},"cron":{}}',
        ),
    );
    assert.equal(services.table, undefined);
    assert.deepEqual(leaves(services.tree!), [
        'false',
        '0',
        '"/usr/sbin/dnsmasq"',
        '""',
        'null',
        '"false"',
        '{}',
    ]);
    assert.equal(services.tree![0].children![0].label, 'instances');
    assert.deepEqual(evidencePresentation('board', result('Example Linux device')).table?.rows, [
        ['Model', 'Example Linux device'],
    ]);
});

test('dynamic interfaces group all evidence under stable device keys for ip, ifconfig and JSON', () => {
    const first = evidencePresentation(
        'interfaces',
        result(
            '1: lo: <UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <UP> mtu 1500\n    inet 192.168.1.1/24 scope global eth0',
        ),
    );
    const next = evidencePresentation(
        'interfaces',
        result(
            '1: lo: <UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n    inet6 ::1/128\n2: eth0: <UP> mtu 1500\n    inet 192.168.1.1/24 scope global eth0',
        ),
    );
    assert.equal(first.tree![1].key, next.tree![1].key);
    assert.equal(first.tree![1].label, 'eth0');
    assert.equal(first.tree![1].children![0].label, 'inet 192.168.1.1/24 scope global eth0');
    assert.equal(
        evidencePresentation(
            'interfaces',
            result(
                'eth0      Link encap:Ethernet  HWaddr 00:11:22:33:44:55\n          inet addr:192.168.1.1',
            ),
        ).tree?.[0].label,
        'eth0',
    );
    assert.equal(
        evidencePresentation(
            'interfaces',
            result('[{"ifname":"eth0","addr_info":[{"family":"inet","local":"192.168.1.1"}]}]'),
        ).tree?.[0].children?.[1].label,
        'addr_info',
    );
});

test('multiline sysfs attributes stay inside their path; memory, CPU, wireless, uptime and UART have appropriate views', () => {
    assert.deepEqual(
        evidencePresentation(
            'spi',
            result(
                '/sys/bus/spi/devices/spi0.0/uevent=DRIVER=spi-nand\nOF_NAME=flash\nMODALIAS=spi:spi-nand\n/sys/bus/spi/devices/spi0.0/modalias=spi:spi-nand',
            ),
        ).table?.rows,
        [
            [
                '/sys/bus/spi/devices/spi0.0/uevent',
                'DRIVER=spi-nand\nOF_NAME=flash\nMODALIAS=spi:spi-nand',
            ],
            ['/sys/bus/spi/devices/spi0.0/modalias', 'spi:spi-nand'],
        ],
    );
    assert.equal(
        evidencePresentation('memory', result('MemTotal: 123 kB')).table?.columns[2],
        'Unit',
    );
    assert.equal(
        evidencePresentation(
            'cpu',
            result('processor : 0\nFeatures : fp aes\n\nprocessor : 1\nFeatures : fp aes'),
        ).tree?.length,
        2,
    );
    const wifi = evidencePresentation(
        'wireless',
        result('phy#0\n\tInterface wlan0\n\t\tssid Lab\n\t\ttype AP'),
    );
    assert.equal(wifi.tree?.[0].children?.[0].children?.length, 2);
    assert.deepEqual(evidencePresentation('uptime', result('12.34 40.56')).table?.rows, [
        ['Uptime', '12.34', 's'],
        ['Aggregate CPU idle time', '40.56', 's'],
    ]);
    assert.deepEqual(
        evidencePresentation(
            'uart',
            result(
                'serinfo:1.0 driver revision:\n0: uart:ST16650V2 mmio:0x11000000 irq:65 tx:2268 rx:22 brk:2 RTS',
            ),
        ).table?.rows,
        [['0', 'ST16650V2', '0x11000000', '65', '2268', '22', 'brk:2 RTS']],
    );
});

test('process/service header tables preserve command and description spaces; routes retain explicit fields', () => {
    const process = evidencePresentation(
        'processes',
        result(' PID USER VSZ STAT COMMAND\n 123 root 1680 S python -c "a  b"'),
    );
    assert.deepEqual(process.table?.rows, [['123', 'root', '1680', 'S', 'python -c "a  b"']]);
    assert.deepEqual(
        evidencePresentation(
            'services',
            result(
                ' UNIT LOAD ACTIVE SUB DESCRIPTION\n ssh.service loaded active running Secure  Shell\n\nLOAD = unit definition\n1 loaded units listed.',
            ),
        ).table?.rows,
        [['ssh.service', 'loaded', 'active', 'running', 'Secure  Shell']],
    );
    assert.deepEqual(
        evidencePresentation('services', result('cron\ndnsmasq\nnetwork')).table?.rows,
        [['cron'], ['dnsmasq'], ['network']],
    );
    assert.deepEqual(
        evidencePresentation(
            'routes',
            result(
                'default via 192.168.1.1 dev eth0 proto dhcp metric 100\n192.168.1.0/24 dev br-lan scope link src 192.168.1.1',
            ),
        ).table?.rows,
        [
            ['default', '192.168.1.1', 'eth0', 'dhcp', '', '', '100', ''],
            ['192.168.1.0/24', '', 'br-lan', '', 'link', '192.168.1.1', '', ''],
        ],
    );
    assert.equal(
        evidencePresentation(
            'routes',
            result(
                'Kernel IP routing table\nDestination Gateway Genmask Flags Metric Ref Use Iface\n0.0.0.0 192.168.1.1 0.0.0.0 UG 0 0 0 eth0',
            ),
        ).table?.rows[0][7],
        'eth0',
    );
});

test('OpenWrt, journal/syslog, ISO and dmesg logs become truthful columns without invented dates or PIDs', () => {
    const logs =
        'Wed Sep 16 22:50:11 2026 authpriv.info dropbear[13420]: Child connection from 192.168.1.10:1767\nOct 06 12:34:56 board systemd[1]: Starting  network...\n2026-10-06T12:34:56.123+08:00 board app[42]: value=x=y\n[ 123.456789] pci 0000:00:00.0: link up\n-- Boot marker --\n  continuation text';
    const table = evidencePresentation('logs', result(logs)).table!;
    assert.deepEqual(table.columns, LOG_COLUMNS);
    assert.deepEqual(table.rows[0], [
        '2026-09-16',
        '22:50:11',
        '',
        'authpriv.info',
        'dropbear',
        '13420',
        '',
        'Child connection from 192.168.1.10:1767',
    ]);
    assert.deepEqual(table.rows[1], [
        'Oct 06',
        '12:34:56',
        'board',
        '',
        'systemd',
        '1',
        '',
        'Starting  network...',
    ]);
    assert.deepEqual(table.rows[2], [
        '2026-10-06',
        '12:34:56.123+08:00',
        'board',
        '',
        'app',
        '42',
        '',
        'value=x=y',
    ]);
    assert.deepEqual(table.rows[3], [
        '',
        '',
        '',
        '',
        'kernel',
        '',
        '123.456789',
        'pci 0000:00:00.0: link up',
    ]);
    assert.equal(table.rows[4][7], '-- Boot marker --\n  continuation text');
    assert.match(evidencePresentation('logs', result(logs)).note!, /1 unrecognized/);
});

test('malformed and unstructured evidence never gets a sentence table; deep/large JSON is bounded and raw evidence is unchanged', () => {
    for (const id of [
        'board',
        'cpu',
        'interfaces',
        'services',
        'routes',
        'processes',
        'logs',
        'wireless',
        'i2s',
        'uart',
    ])
        assert.deepEqual(
            evidencePresentation(
                id,
                result('A sentence with no structured fields.\nAnother sentence.'),
            ),
            {},
        );
    assert.deepEqual(evidencePresentation('services', result('{"invalid":')), {});
    const source = result('{"__proto__":{"polluted":true},"empty":[]}');
    assert.deepEqual(leaves(evidencePresentation('services', source).tree!), ['true', '[]']);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    const deep = result('{"a":'.repeat(100) + '0' + '}'.repeat(100));
    assert.match(evidencePresentation('services', deep).note!, /32 levels/);
    const large = result(
        JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`key${i}`, i]))),
    );
    assert.equal(evidencePresentation('services', large).tree!.length, 4000);
    assert.match(evidencePresentation('services', large).note!, /4,000 fields/);
    assert.equal(source.stdout, '{"__proto__":{"polluted":true},"empty":[]}');
});

test('proc wireless columns follow the kernel format and retain quality update markers without invented units', () => {
    const parsed = evidencePresentation(
        'wireless',
        result(
            'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n wlan0: 0000   70.  -40.  -256.       1      2      3      4      5        6',
        ),
    );
    assert.deepEqual(parsed.table?.rows, [
        ['wlan0', '0000', '70.', '-40.', '-256.', '1', '2', '3', '4', '5', '6'],
    ]);
    assert.match(parsed.note!, /units are not inferred/);
    const kernel = evidencePresentation(
        'logs',
        result('Mon Oct  5 09:12:01 2026 kern.info kernel: [285361.082] eth0: link up'),
    );
    assert.deepEqual(kernel.table?.rows[0], [
        '2026-10-05',
        '09:12:01',
        '',
        'kern.info',
        'kernel',
        '',
        '285361.082',
        'eth0: link up',
    ]);
});

test('interface address lifetimes and ALSA PCM records stay attached to their actual parent', () => {
    const network = evidencePresentation(
        'interfaces',
        result(
            '1: eth0: <UP> mtu 1500\n    inet 192.168.1.1/24 scope global eth0\n       valid_lft forever preferred_lft forever\n    inet6 ::1/128\n       valid_lft forever preferred_lft forever',
        ),
    );
    assert.equal(
        network.tree![0].children![0].children![0].label,
        'valid_lft forever preferred_lft forever',
    );
    assert.equal(
        network.tree![0].children![1].children![0].label,
        'valid_lft forever preferred_lft forever',
    );
    const audio = evidencePresentation(
        'i2s',
        result(
            ' 0 [First ]: Driver - First card\n    platform card zero\n 1 [Second ]: Driver - Second card\n    platform card one\n00-00: PCM zero : playback 1\n01-00: PCM one : capture 1',
        ),
    );
    assert.equal(audio.tree![0].children![1].label, 'PCM 00-00');
    assert.equal(audio.tree![1].children![1].label, 'PCM 01-00');
    assert.deepEqual(
        evidencePresentation(
            'i2s',
            result(' 0 [First ]: Driver - First card\n01-00: unknown card PCM'),
        ),
        {},
    );
});
