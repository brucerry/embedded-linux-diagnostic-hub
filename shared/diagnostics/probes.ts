import type { Probe } from '../types';
import { PROCESS_COMMAND } from './processes';

function sysfs(
    roots: string,
    attributes: string[],
    requiredAttributes = attributes,
    warnInvalidArgument = false,
) {
    const fields = attributes.map((attribute) => `"$item"/${attribute}`).join(' ');
    const required = requiredAttributes.map((attribute) => `"$item"/${attribute}`).join('|');
    if (warnInvalidArgument)
        return (
            `found=0; ` +
            `failed=0; ` +
            `for item in ${roots}; ` +
            `do [ -d "$item" ] || continue; ` +
            `for field in ${fields}; ` +
            `do [ -f "$field" ] || continue; ` +
            `if value=$(LC_ALL=C cat "$field" 2>&1); ` +
            `then printf "%s=%s\\n" "$field" "$value"; ` +
            `case "$field" in ${required}) found=1;; ` +
            `esac; ` +
            `else case "$value" in *"Invalid argument"*) ` +
            `printf "Warning: %s could not be read (Invalid argument). ` +
            `Link attributes may be unavailable when an interface is down; ` +
            `other valid readings are retained.\\n" "$field" >&2;; ` +
            `*) printf "%s\\n" "$value" >&2; ` +
            `failed=1;; ` +
            `esac; ` +
            `fi; ` +
            `done; ` +
            `done; ` +
            `[ "$failed" -eq 0 ] || exit 1; ` +
            `[ "$found" -eq 1 ] || { ` +
            `printf "No readable network attributes are exposed by the running kernel.\\n" >&2; ` +
            `exit 127; ` +
            `}`
        );
    return (
        `found=0; ` +
        `failed=0; ` +
        `for item in ${roots}; ` +
        `do [ -d "$item" ] || continue; ` +
        `for field in ${fields}; ` +
        `do [ -f "$field" ] || continue; ` +
        `case "$field" in ${required}) found=1;; ` +
        `esac; ` +
        `printf "%s=" "$field"; ` +
        `if [ -r "$field" ]; ` +
        `then cat "$field" || failed=1; ` +
        `else printf "Permission denied: %s\\n" "$field" >&2; ` +
        `failed=1; ` +
        `fi; ` +
        `done; ` +
        `done; ` +
        `[ "$failed" -eq 0 ] || exit 1; ` +
        `[ "$found" -eq 1 ] || { ` +
        `printf "No matching data attributes are exposed by the running kernel.\\n" >&2; ` +
        `exit 127; ` +
        `}`
    );
}

const hardware = (id: string, title: string, description: string, command: string): Probe => ({
    id,
    title,
    description,
    command,
    category: 'hardware',
});

// Only these fixed, read-only commands can cross the SSH boundary.
// Exit 127 is reserved for an unavailable capability. Permission and runtime failures stay errors.
export const probes: Probe[] = [
    {
        id: 'identity',
        title: 'Kernel & architecture',
        category: 'system',
        description: 'Kernel release, node name and CPU architecture.',
        command: 'uname -s; uname -n; uname -r; uname -m',
    },
    {
        id: 'release',
        title: 'Linux distribution',
        category: 'system',
        description: 'Distribution metadata without sourcing a remote shell file.',
        command:
            'if [ -r /etc/os-release ]; then cat /etc/os-release; elif [ -r /etc/openwrt_release ]; ' +
            'then cat /etc/openwrt_release; else exit 127; fi',
    },
    {
        id: 'board',
        title: 'Board identity',
        category: 'system',
        description:
            'OpenWrt board/target metadata or the live device-tree model. Board identity is required for a specific hardware test plan.',
        command:
            'if command -v ubus >/dev/null 2>&1; then ubus call system board; elif [ -r ' +
            '/sys/firmware/devicetree/base/model ]; then tr "\\000" "\\n" < ' +
            '/sys/firmware/devicetree/base/model; elif [ -r /proc/device-tree/model ]; then tr "\\000" ' +
            '"\\n" < /proc/device-tree/model; else exit 127; fi',
    },
    {
        id: 'cpu',
        title: 'CPU information',
        category: 'system',
        description: 'Processor topology and platform information from procfs.',
        command: 'if [ -r /proc/cpuinfo ]; then cat /proc/cpuinfo; else exit 127; fi',
    },
    {
        id: 'uptime',
        title: 'Device uptime',
        category: 'system',
        description: 'Seconds since boot from procfs.',
        command: 'if [ -r /proc/uptime ]; then cat /proc/uptime; else exit 127; fi',
    },
    {
        id: 'load',
        title: 'System load',
        category: 'system',
        description: 'One, five and fifteen minute load averages; these are not CPU percentages.',
        command: 'if [ -r /proc/loadavg ]; then cat /proc/loadavg; else exit 127; fi',
    },
    {
        id: 'memory',
        title: 'Memory overview',
        category: 'memory',
        description: 'Physical memory, available memory, caches and swap.',
        command: 'if [ -r /proc/meminfo ]; then cat /proc/meminfo; else exit 127; fi',
    },
    {
        id: 'storage',
        title: 'Mounted filesystems',
        category: 'storage',
        description: 'Filesystem usage in portable POSIX format. No writes or flash operations.',
        command: 'if command -v df >/dev/null 2>&1; then df -Pk; else exit 127; fi',
    },
    {
        id: 'interfaces',
        title: 'Network interfaces',
        category: 'network',
        description: 'Addresses and link state with an ifconfig fallback.',
        command:
            'if command -v ip >/dev/null 2>&1; then ip addr show; elif command -v ifconfig >/dev/null ' +
            '2>&1; then ifconfig -a; else exit 127; fi',
    },
    {
        id: 'routes',
        title: 'Routing table',
        category: 'network',
        description: 'IPv4 routes with a BusyBox-compatible fallback.',
        command:
            'if command -v ip >/dev/null 2>&1; then ip route show; elif command -v route >/dev/null ' +
            '2>&1; then route -n; elif [ -r /proc/net/route ]; then cat /proc/net/route; else exit ' +
            '127; fi',
    },
    {
        id: 'processes',
        title: 'Process inventory',
        category: 'processes',
        description:
            'Readable process memory, swap and threads from procfs. CPU share is sampled between live snapshots; ps is the fallback.',
        command: PROCESS_COMMAND,
    },
    {
        id: 'services',
        title: 'Service inventory',
        category: 'services',
        description:
            'systemd units, OpenWrt procd services, or init script names. An inventory is not a health verdict.',
        command:
            'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl ' +
            'list-units --type=service --all --no-pager --plain; elif command -v ubus >/dev/null 2>&1; ' +
            'then ubus call service list; elif [ -d /etc/init.d ]; then ls /etc/init.d; else exit 127; ' +
            'fi',
    },
    {
        id: 'logs',
        title: 'Recent system logs',
        category: 'logs',
        description:
            'Latest 100 lines from logread, journalctl or the kernel ring buffer. May require elevated permissions.',
        command:
            'if command -v logread >/dev/null 2>&1; then logread -l 100; elif command -v journalctl ' +
            '>/dev/null 2>&1 && [ -d /run/systemd/system ]; then journalctl -n 100 --no-pager; elif ' +
            'command -v dmesg >/dev/null 2>&1; then output=$(dmesg 2>&1); code=$?; printf "%s\\n" ' +
            '"$output" | tail -n 100; exit "$code"; else exit 127; fi',
    },
    hardware(
        'leds',
        'LEDs',
        'LED names, brightness limits and active triggers. Optical color and brightness require observation.',
        sysfs('/sys/class/leds/*', ['brightness', 'max_brightness', 'trigger']),
    ),
    hardware(
        'ethernet',
        'LAN / Ethernet',
        'Link state and kernel packet/error counters. Includes virtual interfaces; no traffic is generated.',
        sysfs(
            '/sys/class/net/*',
            [
                'operstate',
                'carrier',
                'statistics/rx_packets',
                'statistics/tx_packets',
                'statistics/rx_errors',
                'statistics/tx_errors',
            ],
            undefined,
            true,
        ),
    ),
    hardware(
        'wireless',
        'WLAN / Wi-Fi',
        'Wireless interface capabilities from iw/iwinfo, with procfs fallback. No association or RF transmission tests.',
        'if command -v iw >/dev/null 2>&1; then iw dev; elif command -v iwinfo >/dev/null 2>&1; ' +
            'then iwinfo; elif [ -r /proc/net/wireless ]; then cat /proc/net/wireless; else exit 127; ' +
            'fi',
    ),
    hardware(
        'buttons',
        'Buttons / input devices',
        'Linux input inventory, with device-tree button labels for OpenWrt gpio-button-hotplug. Inventory does not validate presses or reset behavior.',
        'if [ -r /proc/bus/input/devices ]; then cat /proc/bus/input/devices; else found=0; ' +
            'failed=0; for key in /sys/firmware/devicetree/base/gpio-keys/* ' +
            '/sys/firmware/devicetree/base/keys/* /sys/firmware/devicetree/base/buttons/*; do [ -d ' +
            '"$key" ] || continue; for field in "$key"/label "$key"/name; do [ -f "$field" ] || ' +
            'continue; found=1; printf "%s=" "$field"; if [ -r "$field" ]; then tr "\\000" "\\n" < ' +
            '"$field" || failed=1; else printf "Permission denied: %s\\n" "$field" >&2; failed=1; fi; ' +
            'done; done; [ "$failed" -eq 0 ] || exit 1; [ "$found" -eq 1 ] || exit 127; fi',
    ),
    hardware(
        'uart',
        'UART / serial ports',
        'Registered UART driver details. No serial device is opened; loopback and electrical levels require a fixture.',
        'if [ -r /proc/tty/driver/serial ]; then cat /proc/tty/driver/serial; elif [ -r ' +
            '/proc/tty/drivers ]; then cat /proc/tty/drivers; else exit 127; fi',
    ),
    hardware(
        'i2c',
        'I²C adapters & devices',
        'Registered adapters and bound device names. Avoids bus scans and register reads.',
        sysfs('/sys/class/i2c-adapter/* /sys/bus/i2c/devices/*', ['name', 'modalias']),
    ),
    hardware(
        'i2s',
        'I²S / audio',
        'ALSA card and PCM inventory. I²S signal integrity and audio loopback need board-specific tests.',
        'if [ -r /proc/asound/cards ]; then cat /proc/asound/cards; if [ -r /proc/asound/pcm ]; ' +
            'then cat /proc/asound/pcm; fi; else exit 127; fi',
    ),
    hardware(
        'spi',
        'SPI devices',
        'Registered SPI devices and modalias. Does not transfer data or alter chip-select state.',
        sysfs('/sys/bus/spi/devices/*', ['modalias', 'uevent']),
    ),
    hardware(
        'flash',
        'NAND / NOR flash',
        'MTD geometry and exposed ECC/bad-block counters. OOB is driver-visible; no erase/program or raw flash reads.',
        sysfs('/sys/class/mtd/mtd*', [
            'name',
            'type',
            'size',
            'erasesize',
            'writesize',
            'oobsize',
            'ecc_strength',
            'ecc_step_size',
            'corrected_bits',
            'ecc_failures',
            'bad_blocks',
            'bbt_blocks',
        ]),
    ),
    hardware(
        'blockdevices',
        'Storage devices',
        'Block-device capacity in 512-byte sectors, logical block size, removable flag and model. No write tests.',
        sysfs('/sys/block/*', ['size', 'removable', 'queue/logical_block_size', 'device/model']),
    ),
    hardware(
        'mmc',
        'eMMC / SD health',
        'MMC card identity and exposed lifetime/pre-EOL values. Interpretation follows the card specification.',
        sysfs('/sys/bus/mmc/devices/*', [
            'name',
            'type',
            'cid',
            'csd',
            'date',
            'life_time',
            'pre_eol_info',
        ]),
    ),
    hardware(
        'usb',
        'USB devices',
        'Enumerated USB identities, products and reported link speeds. Does not validate every USB transfer mode.',
        sysfs('/sys/bus/usb/devices/*', [
            'idVendor',
            'idProduct',
            'manufacturer',
            'product',
            'speed',
        ]),
    ),
    hardware(
        'pcie',
        'PCIe devices & links',
        'PCI identities and exposed negotiated/max link width and speed. Electrical margining is a separate test.',
        sysfs('/sys/bus/pci/devices/*', [
            'vendor',
            'device',
            'class',
            'current_link_speed',
            'current_link_width',
            'max_link_speed',
            'max_link_width',
        ]),
    ),
    hardware(
        'power',
        'Power input / output',
        'Exposed supplies and regulator rails. Supply voltage/current/power use µV/µA/µW; external rails need instrumentation.',
        sysfs('/sys/class/power_supply/* /sys/class/regulator/*', [
            'name',
            'type',
            'status',
            'state',
            'online',
            'voltage_now',
            'current_now',
            'power_now',
            'microvolts',
            'num_users',
        ]),
    ),
    hardware(
        'current',
        'Current & voltage sensors',
        'Raw hwmon channels with labels. Units and resistor scaling follow the sensor ABI and board mapping.',
        sysfs(
            '/sys/class/hwmon/hwmon* /sys/class/hwmon/hwmon*/device',
            [
                'name',
                'in*_label',
                'in*_input',
                'curr*_label',
                'curr*_input',
                'power*_label',
                'power*_input',
                'power*_average',
            ],
            ['in*_input', 'curr*_input', 'power*_input', 'power*_average'],
        ),
    ),
    hardware(
        'temperature',
        'Temperature',
        'Thermal zones and hwmon temperature readings. No universal board temperature threshold is assumed.',
        sysfs(
            '/sys/class/thermal/thermal_zone* /sys/class/hwmon/hwmon* /sys/class/hwmon/hwmon*/device',
            [
                'name',
                'type',
                'temp',
                'temp*_label',
                'temp*_type',
                'temp*_input',
                'temp*_crit',
                'trip_point*_temp',
            ],
            ['temp', 'temp*_input'],
        ),
    ),
    hardware(
        'ddr',
        'DDR / memory ECC',
        'EDAC controller identity and corrected/uncorrected counters when exposed. DDR stress and training validation are separate.',
        sysfs('/sys/devices/system/edac/mc/mc*', ['mc_name', 'size_mb', 'ce_count', 'ue_count']),
    ),
    hardware(
        'display',
        'HDMI / DisplayPort',
        'DRM connector status, enabled state and advertised modes. Image/audio correctness requires a display test.',
        sysfs('/sys/class/drm/card*-*', ['status', 'enabled', 'modes', 'dpms']),
    ),
    hardware(
        'gpio',
        'GPIO controllers',
        'GPIO chip labels and line counts. Does not export, request or toggle a GPIO.',
        sysfs('/sys/bus/gpio/devices/gpiochip* /sys/class/gpio/gpiochip*', [
            'label',
            'ngpio',
            'base',
        ]),
    ),
    hardware(
        'rtc',
        'RTC / clock',
        'RTC identity, date/time and epoch seconds. No time or alarm settings are changed.',
        sysfs('/sys/class/rtc/rtc*', ['name', 'date', 'time', 'since_epoch']),
    ),
    hardware(
        'watchdog',
        'Watchdog status',
        'Watchdog identity, state, timeout and boot-status attributes. Never opens /dev/watchdog or triggers a reset.',
        sysfs('/sys/class/watchdog/watchdog*', [
            'identity',
            'state',
            'timeout',
            'nowayout',
            'bootstatus',
        ]),
    ),
    hardware(
        'iio',
        'Sensors / ADC',
        'IIO device names, raw channels and scale/offset metadata. Channel wiring and calibration are board-specific.',
        sysfs(
            '/sys/bus/iio/devices/iio:device*',
            ['name', 'in*_raw', 'in*_scale', 'in*_offset'],
            ['in*_raw'],
        ),
    ),
    hardware(
        'fans',
        'Fans / tachometers',
        'Exposed RPM readings and labels. No fan/PWM controls are written.',
        sysfs(
            '/sys/class/hwmon/hwmon* /sys/class/hwmon/hwmon*/device',
            ['fan*_label', 'fan*_input'],
            ['fan*_input'],
        ),
    ),
];

export const categoryLabels = {
    system: 'System overview',
    memory: 'Memory',
    storage: 'Storage',
    network: 'Networking',
    processes: 'Processes',
    services: 'Services',
    logs: 'System logs',
    hardware: 'Hardware diagnostics',
} as const;
