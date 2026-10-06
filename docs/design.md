# Visual direction

The shared desktop and website layout takes direction from
[Google I/O 2026](https://io.google/2026/): rounded navigation, a multicolor brand accent, rounded
actions, and spacious cards. The comfortable working theme uses a soft charcoal canvas, lighter
layered surfaces, blue, green, gold and coral card accents, and clear off-white text. A compact
heading places device actions nearby and brings the snapshot metrics into view sooner. It retains a
diagnostic workspace hierarchy: device identity, snapshot metrics, hardware interfaces, collection
coverage, findings, and recorded evidence.

The hardware explorer provides shortcuts into the same evidence dialogs as the diagnostic catalogue.
It does not perform extra device operations. Collection status stays visible beside each interface;
unavailable hardware remains inspectable. Desktop and browser editions share the complete visual
implementation.

`src/components/RoundedIcon.tsx` contains original SVG artwork for the hardware and system
categories: rounded geometry, generous curves, and translucent secondary fills. The user's
[Font Awesome Jelly reference](https://fontawesome.com/icons/packs/jelly) informs the desired soft
visual character. These are original project icons, not Jelly assets. Font Awesome identifies Jelly
as Pro+; the user selected original SVG icons for this version. Existing Lucide icons provide
familiar action indicators and retain their upstream license.

All icons and CSS are bundled. Fonts use the operating system's Segoe UI Variable/Segoe UI/system
stack. Body copy is 15 px, supporting descriptions are 14 px, and small labels have a 13 px minimum,
including on mobile. Headings have a restrained 34–48 px scale. Controls have visible keyboard focus
and primary actions have a 44 px minimum height. No icon CDN, remote font, Google artwork, or Font
Awesome account is required at runtime. A licensed Jelly integration can replace the icon component
later if desired; proprietary source assets must not be placed in the public repository.

The layout reflows for compact windows and mobile browsers, with a scrollable category row and
stacked cards. Thin rounded scrollbars cover the workspace and nested evidence areas. Dialogs lock
background scrolling, focus their first control only on opening, and restore focus without scrolling
on exit. Live snapshots preserve focused controls and scroll positions. Keyboard focus containment
and reduced-motion preferences remain supported. Test screenshots are generated under ignored test
output directories; real Windows scaling and accessibility qualification remain part of the
production checklist.

Startup displays a connection guide without any device readings, presets, collection counts, or
findings. Diagnostics remain a browseable catalogue with “Not collected” labels until evidence is
available. Export is disabled without a snapshot. Saved reports require explicit import and retain
their historical source labels; a disconnected session retains its last collected snapshot.

Live updates default on with a 30-second interval measured after the preceding collection completes.
The switch pauses scheduled updates while keeping SSH connected; Disconnect closes SSH and clears
the target. The connection button changes to Disconnect device with a plugged icon when connected;
disconnected states use an unplugged icon. Disconnect is disabled during collection, and manual
collection is disabled while live updates are enabled. Report actions use import/export document
icons and the Import report label. Evidence dialogs have bordered, collapsed command details and
animated icon-only copy actions at the top right of the command, stdout and stderr snippets, raw
output/error tabs, suitable table/tree views and numeric history graphs available only during live
updates. History is bounded to 120 numeric samples per target/window, without retaining past raw
outputs. Unsupported or unavailable readings have no graph tab. Tables and trees are offered for
recognized structures; unstructured output stays in Standard output. Parsed memory/filesystem, log
and sysfs data have meaningful fields. Hover effects use small icon enlargement/rotation and subtle
card lifts; page and evidence transitions respect reduced-motion preferences.

Sensor graph scaling follows the Linux
[hwmon ABI](https://github.com/torvalds/linux/blob/master/Documentation/hwmon/sysfs-interface.rst)
and [power supply ABI](https://cdn.kernel.org/doc/html/latest/power/power_supply_class.html).
Temperature type 4 thermistor inputs retain millivolt units. Supply/regulator values stay in raw
micro-units; board wiring and calibration are not inferred. Network graphs show cumulative
packet/error counters, not bandwidth or calculated rates.

## Evidence view selection

Detail dialogs always open on Standard output, including when reopening a different diagnostic or
switching pages. A selected table/tree/graph stays selected during live updates. A structured view
is offered only when its parser recognizes the collected output; unavailable/error results and
unsupported formats remain raw text. No generic line-number/sentence table is generated. Live graphs
remain available only for supported numeric readings while live updates are enabled. Raw evidence
and recorded commands remain available in reports.

| Diagnostic                | Preferred structured presentation | Recognized format or fallback                                                                                                                          |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kernel & architecture     | Key/value table                   | Four `uname` fields                                                                                                                                    |
| Linux distribution        | Key/value table                   | Metadata assignments; never evaluated as shell                                                                                                         |
| Board identity            | Key/value table                   | JSON leaf paths such as `release.version`, or a device-tree model                                                                                      |
| CPU information           | Tree                              | Processor blocks with their original attributes; other layouts stay raw                                                                                |
| Device uptime             | Table                             | Uptime and aggregate CPU idle seconds                                                                                                                  |
| System load               | Table                             | Three load averages, runnable/total tasks and last PID                                                                                                 |
| Memory overview           | Table                             | Field, value and reported unit                                                                                                                         |
| Mounted filesystems       | Table                             | Filesystem, total/used/available KiB, percent and mount                                                                                                |
| Network interfaces        | Tree                              | JSON, `ip addr` interface groups, or recognized `ifconfig` groups                                                                                      |
| Routing table             | Table                             | Named `ip route` attributes, legacy route headers or procfs columns; hex fields remain explicitly labeled                                              |
| Process inventory         | Table                             | Procfs resource records with resident/virtual/swap MiB, memory share, threads and sampled CPU share; legacy procps/BusyBox headers retain command text |
| Service inventory         | Tree or table                     | JSON service/instance trees; systemd unit columns; one-name-per-line init inventory                                                                    |
| Recent system logs        | Table                             | Date, time, host, facility/level, program, PID, kernel time and message                                                                                |
| LEDs                      | Path/value table                  | Kernel attributes                                                                                                                                      |
| LAN / Ethernet            | Path/value table                  | Link attributes and counters                                                                                                                           |
| WLAN / Wi-Fi              | Tree or table                     | `iw` hierarchy, `iwinfo` interface groups, or Wireless Extensions procfs columns                                                                       |
| Buttons / input devices   | Tree or table                     | Linux input-device blocks, or OpenWrt device-tree path/value labels                                                                                    |
| UART / serial ports       | Table                             | Serial driver port, address, IRQ, transmit/receive and remaining attributes; other driver formats stay raw                                             |
| I²C adapters & devices    | Path/value table                  | Registered device attributes                                                                                                                           |
| I²S / audio               | Tree                              | Recognized ALSA card groups; other formats stay raw                                                                                                    |
| SPI devices               | Path/value table                  | Multiline `uevent` data stays together under its originating path                                                                                      |
| NAND / NOR flash          | Path/value table                  | MTD geometry and counters                                                                                                                              |
| Storage devices           | Path/value table                  | Block-device attributes                                                                                                                                |
| eMMC / SD health          | Path/value table                  | Card attributes                                                                                                                                        |
| USB devices               | Path/value table                  | Enumerated device attributes                                                                                                                           |
| PCIe devices & links      | Path/value table                  | Link and identity attributes                                                                                                                           |
| Power input / output      | Path/value table                  | Supply/regulator attributes                                                                                                                            |
| Current & voltage sensors | Path/value table                  | Sensor attributes with raw kernel units                                                                                                                |
| Temperature               | Path/value table                  | Thermal/hwmon attributes                                                                                                                               |
| DDR / memory ECC          | Path/value table                  | EDAC attributes                                                                                                                                        |
| HDMI / DisplayPort        | Path/value table                  | Connector attributes, including multiline modes                                                                                                        |
| GPIO controllers          | Path/value table                  | Controller attributes                                                                                                                                  |
| RTC / clock               | Path/value table                  | Clock attributes                                                                                                                                       |
| Watchdog status           | Path/value table                  | Exposed status attributes                                                                                                                              |
| Sensors / ADC             | Path/value table                  | IIO attributes                                                                                                                                         |
| Fans / tachometers        | Path/value table                  | Tachometer attributes                                                                                                                                  |

Trees use native expandable disclosure controls, with Expand all/Collapse all. Stable branch keys
preserve disclosure state during updates. JSON scalar values retain distinctions between strings,
booleans, numbers, null, and empty containers. Structured JSON is bounded to 4,000 fields and 32
levels; raw output remains available beyond these display limits. Tables retain multiline attribute
values in their own cells rather than creating unrelated rows.

Log parsing supports OpenWrt timestamps with an explicit year, short syslog/journal dates, ISO
timestamps and kernel uptime timestamps. Missing years, hostnames, PIDs and wall-clock dates are not
invented. Unrecognized lines remain in the Message column when other log records are recognized,
with a parsing note; wholly unrecognized log output has no table. Continuation lines stay with their
preceding message. Metadata columns keep their values on one line; messages wrap in a wider column,
with horizontal scrolling on narrow windows. `/proc/net/wireless` column mapping and update-dot
handling follow the
[Linux Wireless Extensions proc implementation](https://github.com/torvalds/linux/blob/master/net/wireless/wext-proc.c);
quality units are retained as raw rather than inferred.

Each snippet copy icon displays a green upward “Copied!” animation for one second without changing
layout height. Reduced motion shows the same timed feedback without movement. Copy failures show
brief actionable feedback. The command frame has a contrasting border. The header retains its
platform icon and version, removes the desktop/offline wording, and includes a GitHub link that uses
one fixed repository destination through the native bridge. The artwork caption has a separate area
below the orbit icons.

## Resource graphs and navigation

RAM and swap graphs pair used and free values on the same MiB axis. RAM used means total minus
MemFree and includes cache; if only MemAvailable is exposed, the pair is explicitly Used/Available.
Available RAM remains independently selectable when both fields exist. Filesystem graphs pair
reported Used and Available values; available space may exclude reserved blocks, so these are not
forced to sum to capacity. Flash graphs use collected `/dev/ubiN_M` or `/dev/mtdblockN` filesystem
records from Mounted filesystems. Block-device graphs require a filesystem source matching a
collected block device or its partition. Raw MTD/block geometry alone never supplies invented
used/free values.

The process collector reads only `/proc/stat`, `/proc/meminfo`, and readable process `status`/`stat`
files, with ps fallback when procfs/awk is unavailable. Memory and swap values follow the
[Linux procfs fields](https://docs.kernel.org/filesystems/proc.html); they are kernel estimates and
shared pages can occur in multiple processes. CPU % (system) is the delta of process user+system
ticks divided by the delta of total system CPU ticks, excluding already-counted guest ticks. It is a
share of the whole machine, with 100% representing all CPUs. It requires two snapshots and matching
PID/start time; first observations, reused PIDs, unavailable counters and counter resets remain
blank. History retains numeric counters for up to 2,000 processes per frame and 120 frames, with
process labels on available numeric graph readings, without retaining previous raw status output.
Process names and resource fields stay on one line, with horizontal scrolling for narrow windows.

Search normalizes case, accents, punctuation and compatibility characters (including I²C/I2C), then
ranks exact title/ID matches, partial matches, related category/alias matches, and approximate
spelling matches. Multiword queries must match every term; edit/transposition distance is bounded.
Equal relevance keeps catalogue order. Match labels explain the ranking, and empty search restores
the category's original catalogue.

The header stays visible while scrolling, above page content and below dialogs. Fixed bottom-right
arrows place top above bottom, support keyboard focus, use smooth scrolling except under reduced
motion, and disable while a dialog is open. Footer padding keeps its content clear of those
controls.

`public/app-icon.svg` is the common brand source for the header and website favicon.
`npm run generate:icons` rasterizes it into a PNG for the desktop window and a seven-resolution ICO
for Windows executable resources. Those assets are bundled; production packaging preserves optional
code signing while local preview packaging uses `-c.win.signExecutable=false` to retain resource
editing without a certificate.

## Graph inspection and file editing

Graphs reserve horizontal space as history grows and preserve the viewport rather than jumping to
the newest sample. Hovering anywhere across the x-axis chooses the nearest timestamp, draws a
crosshair, highlights the points and shows values for every plotted series. Keyboard arrows/Home/End
also select samples. Process graph identities include PID and start time; resident/virtual/swap
memory use MiB, and interval CPU uses a separate percent series. Missing CPU intervals do not become
zero readings.

The overview artwork occupies a reserved grid column; changing collection status or button wording
does not move its container. A computer sits on the left and a chip on the right with a 236px gap,
four times the original 59px gap, while keeping both icons at their original sizes. During
collection, binary digits launch at the chip with nonnegative staggered delays and travel right to
left continuously at varied constant speeds. The fastest digit crosses the entire gap in 280ms;
after collection, pending launches are cancelled and in-flight digits finish their current trip at
the same speed before disappearing. A new collection starts a fresh stream at the chip, even if the
previous stream was still draining; both endpoints remain static. There are no visible status
captions. Reduced-motion settings replace movement with static binary digits only during collection.

The sticky header uses an 82% opaque soft-dark background, 20px backdrop blur and gentle saturation
to reveal scrolled content without fading its text or controls. A subtle border/shadow separates it
from the page. Unsupported blur and reduced-transparency preferences use an opaque header.

LAN collection handles per-attribute `Invalid argument` reads as warnings rather than failing the
entire probe when other readable attributes exist. Failed values are omitted from standard output,
preventing an empty failed field from consuming the next successful field. Valid interface
states/counters remain available in parsed tables and live graphs; Standard error retains the
affected path and warning. Zero valid readings remain unavailable, while unexpected
permission/runtime failures remain errors. A down interface alone is not a hardware health verdict.

The overview load card displays task-count averages over 1/5/15-minute windows, not elapsed times or
CPU percentages. Its caption and tooltip explain runnable tasks and uninterruptible waits (often
I/O).
