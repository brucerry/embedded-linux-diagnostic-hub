import { probes } from '../../shared/diagnostics/probes';
import type { Snapshot } from '../../shared/types';

export const demoDevices = [
    {
        id: 'openwrt',
        name: 'OpenWrt gateway',
        host: '192.168.1.1',
        platform: 'Linux gateway · arm64',
        distro: 'OpenWrt',
    },
    {
        id: 'ubuntu',
        name: 'Ubuntu edge node',
        host: '192.168.1.42',
        platform: 'Linux edge node · arm64',
        distro: 'Ubuntu',
    },
    {
        id: 'debian',
        name: 'Debian controller',
        host: '192.168.1.64',
        platform: 'Linux controller · arm64',
        distro: 'Debian',
    },
];

export function demoSnapshot(id = 'openwrt'): Snapshot {
    const device = demoDevices.find((item) => item.id === id) ?? demoDevices[0];
    const openwrt = device.id === 'openwrt';
    const outputs: Record<string, string> = {
        identity: `Linux\n${openwrt ? 'lab-gateway-01' : device.id === 'ubuntu' ? 'edge-node-02' : 'controller-03'}\n${openwrt ? '6.12.0-demo' : '6.8.0-52-generic'}\naarch64\n`,
        release: `NAME="${device.distro}"\nPRETTY_NAME="${openwrt ? 'OpenWrt 25.12 (sample)' : device.id === 'ubuntu' ? 'Ubuntu 24.04 LTS' : 'Debian GNU/Linux 12 (bookworm)'}"\nID=${device.id}\n`,
        board: JSON.stringify(
            {
                model: `${device.platform} (sample)`,
                board_name: 'sample-board',
                release: {
                    distribution: device.distro,
                    version: openwrt ? '25.12' : device.id === 'ubuntu' ? '24.04' : '12',
                    target: openwrt ? 'generic/arm64' : 'arm64',
                },
            },
            null,
            2,
        ),
        cpu: `processor\t: 0\nBogoMIPS\t: 26.00\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32\nCPU implementer\t: 0x41\nCPU architecture: 8\n\nprocessor\t: 1\nBogoMIPS\t: 26.00\n\nHardware\t: ${device.platform}\n`,
        uptime: '285480.52 471285.21\n',
        load: '0.24 0.18 0.12 1/94 1842\n',
        memory: `MemTotal:       ${openwrt ? 524288 : 4194304} kB\nMemFree:        ${openwrt ? 186368 : 2211840} kB\nMemAvailable:   ${openwrt ? 335544 : 2936013} kB\nBuffers:           12288 kB\nCached:           151552 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n`,
        storage: openwrt
            ? 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/root            12288    12288         0     100% /rom\ntmpfs               262144     8192    253952       3% /tmp\n/dev/ubi0_1          90112    81101      9011      90% /overlay\noverlayfs:/overlay   90112    81101      9011      90% /\n'
            : 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/mmcblk0p2    30408704  6127616  24281088      20% /\ntmpfs             2097152     4096   2093056       1% /run\n',
        interfaces:
            '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    link/ether 02:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff\n3: br-lan: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet 192.168.1.1/24 brd 192.168.1.255 scope global br-lan\n',
        routes: 'default via 192.168.1.254 dev br-lan\n192.168.1.0/24 dev br-lan proto kernel scope link src 192.168.1.1\n',
        processes:
            '  PID USER       VSZ STAT COMMAND\n    1 root      1632 S    /sbin/procd\n  521 root      2240 S    /sbin/ubusd\n  642 root      3480 S    /usr/sbin/dropbear -F\n  891 nobody    2520 S    /usr/sbin/dnsmasq -k\n 1054 root      1832 S    /sbin/netifd\n 1206 root      4064 S    /usr/sbin/uhttpd -f\n',
        services: openwrt
            ? '{\n  "dnsmasq": {"instances": {"dnsmasq": {"running": true, "pid": 891}}},\n  "dropbear": {"instances": {"instance1": {"running": true, "pid": 642}}},\n  "network": {"instances": {"netifd": {"running": true, "pid": 1054}}}\n}\n'
            : 'UNIT                       LOAD   ACTIVE SUB     DESCRIPTION\nssh.service                loaded active running OpenBSD Secure Shell server\nsystemd-networkd.service   loaded active running Network Configuration\nsystemd-journald.service   loaded active running Journal Service\n',
        logs: 'Mon Oct  5 09:12:01 2026 kern.info kernel: [285361.082] eth0: link up (1000Mbps/Full duplex)\nMon Oct  5 09:12:02 2026 daemon.notice netifd: Interface lan is now up\nMon Oct  5 09:12:02 2026 daemon.info dnsmasq: reading /etc/resolv.conf\nMon Oct  5 09:13:16 2026 auth.info dropbear: Password auth succeeded for root\nMon Oct  5 09:13:20 2026 user.notice diagnostic: sample collection complete\n',
        leds: '/sys/class/leds/green:status/brightness=1\n/sys/class/leds/green:status/max_brightness=1\n/sys/class/leds/green:status/trigger=none [default-on] timer heartbeat\n',
        ethernet:
            '/sys/class/net/eth0/operstate=up\n/sys/class/net/eth0/carrier=1\n/sys/class/net/eth0/statistics/rx_packets=18524\n/sys/class/net/eth0/statistics/tx_packets=16280\n/sys/class/net/eth0/statistics/rx_errors=0\n/sys/class/net/eth0/statistics/tx_errors=0\n',
        wireless:
            'phy#1\n  Interface phy1-ap0\n    type AP\n    channel 36 (5180 MHz), width: 80 MHz\nphy#0\n  Interface phy0-ap0\n    type AP\n    channel 6 (2437 MHz), width: 20 MHz\n',
        buttons:
            'I: Bus=0019 Vendor=0001 Product=0001 Version=0100\nN: Name="gpio-keys"\nH: Handlers=event0\nB: EV=3\nB: KEY=100000 0 0 0\n',
        uart: 'serinfo:1.0 driver revision:\n0: uart:16550A mmio:0x11002000 irq:20 tx:2542 rx:1258\n',
        spi: '/sys/bus/spi/devices/spi0.0/modalias=spi:spi-nand\n',
        flash: '/sys/class/mtd/mtd0/name=boot\n/sys/class/mtd/mtd0/type=nand\n/sys/class/mtd/mtd0/size=1048576\n/sys/class/mtd/mtd0/erasesize=131072\n/sys/class/mtd/mtd0/writesize=2048\n/sys/class/mtd/mtd0/oobsize=128\n/sys/class/mtd/mtd0/corrected_bits=12\n/sys/class/mtd/mtd0/ecc_failures=0\n/sys/class/mtd/mtd0/bad_blocks=0\n',
        blockdevices:
            '/sys/block/ubiblock0_0/size=24576\n/sys/block/ubiblock0_0/removable=0\n/sys/block/ubiblock0_0/queue/logical_block_size=512\n',
        usb: '/sys/bus/usb/devices/usb1/idVendor=1d6b\n/sys/bus/usb/devices/usb1/idProduct=0002\n/sys/bus/usb/devices/usb1/product=xHCI Host Controller\n/sys/bus/usb/devices/usb1/speed=480\n',
        pcie: '/sys/bus/pci/devices/0000:01:00.0/vendor=0x1234\n/sys/bus/pci/devices/0000:01:00.0/device=0x0001\n/sys/bus/pci/devices/0000:01:00.0/current_link_speed=5.0 GT/s PCIe\n/sys/bus/pci/devices/0000:01:00.0/current_link_width=1\n',
        temperature:
            '/sys/class/thermal/thermal_zone0/type=cpu-thermal\n/sys/class/thermal/thermal_zone0/temp=48500\n',
        gpio: '/sys/bus/gpio/devices/gpiochip0/label=1001f000.pinctrl\n/sys/bus/gpio/devices/gpiochip0/ngpio=101\n',
        watchdog:
            '/sys/class/watchdog/watchdog0/identity=Example Watchdog\n/sys/class/watchdog/watchdog0/state=active\n/sys/class/watchdog/watchdog0/timeout=30\n/sys/class/watchdog/watchdog0/nowayout=0\n',
    };
    if (!openwrt) {
        outputs.interfaces = outputs.interfaces.replaceAll('192.168.1.1/24', `${device.host}/24`);
        outputs.routes = outputs.routes.replace('src 192.168.1.1', `src ${device.host}`);
        outputs.processes =
            'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT COMMAND\nroot           1  0.0  0.1  22120  8192 ?        Ss   /sbin/init\nroot         642  0.0  0.1  15420  5820 ?        Ss   sshd: /usr/sbin/sshd -D\nsystemd+     851  0.0  0.1  17644  6312 ?        Ss   /usr/lib/systemd/systemd-networkd\n';
        outputs.logs =
            'Oct 05 09:12:01 edge-node kernel: eth0: link up\nOct 05 09:12:02 edge-node systemd[1]: Started Network Configuration.\nOct 05 09:13:16 edge-node sshd[642]: Accepted publickey for developer\n';
    }
    const capturedAt = new Date().toISOString();
    return {
        schemaVersion: 1,
        mode: 'demo',
        endpoint: `${device.host}:22`,
        username: openwrt ? 'root' : 'developer',
        capturedAt,
        results: probes.map((probe, index) => ({
            id: probe.id,
            command: probe.command,
            stdout: outputs[probe.id] || '',
            stderr:
                probe.id in outputs ? '' : 'This capability is not exposed in the simulated board.',
            status: probe.id in outputs ? 'collected' : 'unavailable',
            exitCode: probe.id in outputs ? 0 : 127,
            durationMs: 35 + index * 11,
            collectedAt: capturedAt,
            truncated: false,
        })),
    };
}
