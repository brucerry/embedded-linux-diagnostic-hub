import { demoSnapshot } from './snapshots';
import type { Snapshot, ProbeResult } from '../../shared/types';
import type { NetworkOperation } from '../../shared/diagnostics/network/evidence';
export function networkSnapshot(): Snapshot {
    const snapshot = demoSnapshot();
    const add = (
        id: string,
        operation: NetworkOperation,
        scope: string,
        command: string,
        stdout: string,
        stderr = '',
        exitCode = 0,
    ) => {
        const primary = snapshot.results.find((r) => r.id === id)!;
        const evidence = (primary.networkEvidence ??= { version: 1, sections: [], omissions: [] });
        evidence.sections.push({
            id: operation + ':' + scope,
            operation,
            scope,
            command,
            stdout,
            stderr,
            exitCode,
            status: exitCode === 0 ? 'collected' : exitCode === 127 ? 'unavailable' : 'error',
            source: 'live',
            collectedAt: snapshot.capturedAt,
            durationMs: 4,
            truncated: false,
        });
    };
    snapshot.results.find((r) => r.id === 'wireless')!.stdout =
        'phy#0\n\tInterface wlan0\n\t\tifindex 3\n\t\twdev 0x1\n\t\taddr 02:00:00:00:00:03\n\t\tssid Beach lab\n\t\ttype managed\n\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz\n\t\ttxpower 23.00 dBm\n';
    add(
        'wireless',
        'iw-link',
        'wlan0',
        'iw dev wlan0 link',
        'Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: Beach lab\n\tfreq: 5180\n\tsignal: -45 dBm\n\ttx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz VHT-NSS 2\n',
    );
    add(
        'wireless',
        'iw-stations',
        'wlan0',
        'iw dev wlan0 station dump',
        'Station 00:11:22:33:44:55 (on wlan0)\n\tsignal: -45 [-47, -48] dBm\n\tsignal avg: -46 dBm\n\trx bytes: 185240\n\ttx bytes: 162800\n\ttx retries: 3\n\ttx failed: 0\n\trx bitrate: 780.0 MBit/s VHT-MCS 8 80MHz VHT-NSS 2\n',
    );
    add(
        'wireless',
        'iw-survey',
        'wlan0',
        'iw dev wlan0 survey dump',
        'Survey data from wlan0\n\tfrequency: 5180 MHz [in use]\n\tnoise: -95 dBm\n\tchannel active time: 10000 ms\n\tchannel busy time: 1200 ms\n\tfrequency: 2412 MHz\n\tnoise: -90 dBm\n',
    );
    add(
        'wireless',
        'iw-phy',
        'phy0',
        'iw phy phy0 info',
        'Wiphy phy0\n\tSupported interface modes:\n\t\t* managed\n\t\t* AP\n\t\t* monitor\n\tBand 1:\n\t\tHT Capabilities: 0x19ff\n\t\tHT20/HT40\n\t\tVHT Capabilities: 0x338001b2\n\t\tHE Iftypes: managed, AP\n\t\tHE MCS/NSS: 2 streams\n\t\tFrequencies:\n\t\t\t* 5180 MHz [36] (23.0 dBm)\n\t\t\t* 5260 MHz [52] (23.0 dBm) (radar detection)\n\t\t\t* 5500 MHz [100] (disabled)\n',
    );
    add(
        'wireless',
        'iw-regulatory',
        'global',
        'iw reg get',
        'global\ncountry GB: DFS-ETSI\n\t(5150 - 5250 @ 80), (N/A, 23), (N/A), AUTO-BW\n',
    );
    add('wireless', 'iw-version', 'tool', 'iw --version', 'iw version 6.17\n');
    const links =
        '[{"ifindex":2,"ifname":"eth0","flags":["UP","LOWER_UP"],"operstate":"UP","mtu":1500,"link_type":"ether","address":"02:00:00:00:00:02","qdisc":"fq_codel","stats64":{"rx":{"bytes":10485760,"packets":18524,"errors":0,"dropped":0},"tx":{"bytes":5242880,"packets":16280,"errors":0,"dropped":0}}},{"ifindex":3,"ifname":"wlan0","flags":["UP","LOWER_UP"],"operstate":"UP","mtu":1500,"link_type":"ether","address":"02:00:00:00:00:03"}]';
    add('ethernet', 'ip-link-json', 'all', 'ip -j -d -s link show', links);
    add(
        'ethernet',
        'ip-neighbor-json',
        'all',
        'ip -j neigh show',
        '[{"dst":"192.0.2.1","dev":"eth0","lladdr":"00:11:22:33:44:55","state":["STALE"]}]',
    );
    add(
        'ethernet',
        'ethtool',
        'eth0',
        'ethtool eth0',
        'Settings for eth0:\n\tSupported link modes: 10baseT/Full 100baseT/Full 1000baseT/Full\n\tAdvertised link modes: 1000baseT/Full\n\tSpeed: 1000Mb/s\n\tDuplex: Full\n\tAuto-negotiation: on\n\tLink detected: yes\n',
    );
    add(
        'interfaces',
        'ip-address-json',
        'all',
        'ip -j address show',
        '[{"ifindex":2,"ifname":"eth0","addr_info":[{"family":"inet","local":"192.0.2.2","prefixlen":24,"scope":"global","valid_life_time":"forever","preferred_life_time":"forever"},{"family":"inet6","local":"2001:db8::2","prefixlen":64,"scope":"global"}]}]',
    );
    add(
        'routes',
        'ip-route4-json',
        'IPv4/all tables',
        'ip -j -4 route show table all',
        '[{"dst":"default","gateway":"192.0.2.1","dev":"eth0","protocol":"static","metric":100},{"dst":"192.0.2.0/24","dev":"eth0","scope":"link","prefsrc":"192.0.2.2"}]',
    );
    add(
        'routes',
        'ip-route6-json',
        'IPv6/all tables',
        'ip -j -6 route show table all',
        '[{"dst":"default","gateway":"2001:db8::1","dev":"eth0","metric":100}]',
    );
    return snapshot;
}
