# Design

## Context

See proposal.md for motivation and scope. Baseline: main 0344878ad9b6d0fc54d53923b03771fea8d905f3,
package version 0.4.0. Only tests/ui/live.spec.ts has the user's four-line change; retain it
verbatim. OpenSpec has 11 canonical specs and initially no active changes; its tree is locally
excluded.

Verified code:

| Area             | Evidence                                                                 | Implication                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation       | src/app/App.tsx:40,157; src/app/view.ts                                  | Three primary pages; SSH Terminal stays mounted. Add Serial to the same navigation and title handling.                                                                             |
| SSH boundaries   | backend/ssh/session.ts:23,287; shared/diagnostics/probes.ts              | Fixed probes, C locale, 12-second timeout, 256 KiB output, at most three concurrent execs. No arbitrary renderer exec API.                                                         |
| WLAN             | shared/diagnostics/probes.ts:215; shared/diagnostics/evidence.ts:476,504 | Only iw dev, iwinfo or procfs. iw text uses an indentation tree; no connection/survey/PHY collector exists.                                                                        |
| LAN              | shared/diagnostics/probes.ts:140,149,197; tests/ethernet.test.ts         | ip address/IPv4 route text and sysfs attributes are separate. LAN graphs use cumulative packet/error counts. EINVAL preserves valid attributes; permission failures remain errors. |
| Terminal         | src/features/terminal/TerminalPage.tsx:105,155,239; shared/terminal.ts   | Existing xterm, clipboard, input batching, OSC guards and fit behavior are useful; automatic PTY start/restart and SSH generations are transport-specific.                         |
| Desktop security | electron/main.ts:48,51,147,163                                           | Secure app scheme and exact trusted-frame IPC; all device permissions currently denied. Serial needs a narrow exception, never blanket permission.                                 |
| Reports/reset    | shared/report.ts:22; src/hooks/useDeviceSession.ts:313,395               | Schema 1, known IDs, strict bounds; imports disconnect SSH and reset clears RAM while keeping SSH. Extend validation deliberately for optional evidence.                           |
| Update           | electron/main.ts:115,324; src/features/updates/UpdateModal.tsx           | Main owns update locking; Serial must quiesce before installation/relaunch.                                                                                                        |
| Website          | gateway/server.ts; src/services/GatewayClient.ts                         | Gateway executes target Linux probes; the browser's serial ports are on the browser computer, independent of the gateway.                                                          |

Repository guidance in CONTRIBUTING.md and docs/development.md requires shared desktop/web behavior,
bounded read-only capability detection, meaningful failure fixtures, raw evidence and four-space
formatting. No AGENTS.md was found in the repository root, relevant source/test/spec directories or
its parent. Repository OpenSpec skills were read; openspec-propose is applied. Relevant canonical
terminal, SSH lifecycle and platform-window specs were read; none needs a requirement change. The
historical architecture roadmap and three retired board-testing specs are not current product
authority.

The user accepted summary-first progressive WLAN/LAN detail and a Serial controls/terminal layout
through the parent thread. Do not reopen those choices.

## Goals / Non-Goals

**Goals:** Integrate local serial access without entangling SSH generations; provide readable
network observations with command provenance; preserve existing report IDs, raw views, bounded
graphs and security/terminal contracts.

**Non-Goals:** Automatic target UART setup or operation, network configuration, active RF scans,
reachability/throughput tests, privilege changes, serial file transfer or transcript persistence,
comprehensive nl80211 decoding, and a native serial library. Derived SNR, RF utilization and new
throughput graphs are deferred; current values and existing counter graphs are sufficient for this
release.

## Decisions

### 1. Serial is a separate local-host session

Create src/features/serial/SerialPage.tsx and a testable session controller/Web Serial adapter. Add
'serial' to View; lazy-load and keep the page/session mounted after first visit. Serial works before
SSH login and while browsing imported evidence. Its heading and status must say **Ports on this
computer** and display its own connection identity; SSH connection controls, report controls and
live polling controls belong to the SSH workspace, not Serial's controls.

Select one port at a time. Selecting grants/chooses a port but does not open it. Connect explicitly
opens the selected port; Disconnect closes while retaining selection; Deselect closes then clears
selection. Choosing a replacement cannot open it until prior ownership is released. Cancelling the
chooser is a normal idle outcome. Additional simultaneous serial terminals are deferred.

Editable defaults are 115200 baud, 8 data bits, no parity, 1 stop bit and no flow control. Provide
validated positive integer baud input plus common presets, 7/8 data bits, none/even/odd parity, 1/2
stop bits and none/hardware flow. Reject invalid settings locally; runtime/driver rejection reports
an actionable unsupported-settings state. Changing framing requires Disconnect/reopen. Local echo is
off by default; optional local echo is labeled. Enter sends CR by default with explicit CR/LF/CRLF
selection; preserve pasted bytes except xterm's deliberate paste behavior, with no silent global
newline rewriting. Do not claim software XON/XOFF support.

Use Web Serial in the shared renderer. Electron supplies only chooser metadata/selection/permission
coordination, not an API to open arbitrary OS paths or perform file I/O. Native serialport was
considered but introduces native packaging/dependency cost before evidence shows a gap in the pinned
runtime. Runtime qualification of Electron 44.5.1 under app:// is an early gate; failure must remain
explicit and cannot justify weakening security.

### 2. Narrow desktop chooser and grants

Handle session select-serial-port for the expected WebContents and active top-level trusted
document. The chooser is opened only by a user gesture; emit a bounded list of descriptors through a
trusted preload subscription and accept a selected offered ID plus unique chooser ID through
validated IPC. Call the callback exactly once, with an empty ID on
cancel/expiry/closure/replacement. Reject stale IDs, unrelated WebContents, untrusted/subframes and
selections not in the current offered list. Use port-added/removed only while this chooser is
pending; remove those temporary listeners when settled. A pending chooser expires after 60 seconds
with a harmless cancellation.

Display portName and optional displayName/USB identifiers as plain text; Electron 44.5.1's installed
electron.d.ts confirms those descriptor fields. Never select the first port automatically. Device
grants are limited to the user-selected device in the trusted WebContents session. Avoid a blanket
setDevicePermissionHandler allow; if custom handling is needed, match only the selected descriptor
and trusted origin. Keep all other permission requests denied and existing
sandbox/contextIsolation/webSecurity settings intact. Keep Chromium's serial blocklist.

Origin checks must use the actual pinned-runtime permission details and the expected document URL,
with packaged app:// and exact development loopback separated. Unexpected/opaque origins are denied
with an unsupported state; do not invent a broad fallback. The chooser IPC uses the existing exact
sender/frame validation. Test permission hooks using injected descriptors before physically
connecting anything.

The browser uses its native user-gesture chooser. getPorts returns authorized ports, not all system
ports; getInfo exposes USB IDs, not COM/tty names. Provide stable session labels and optional user
labels without pretending they are OS paths. App code stores no permission/device identity across
reload; browser-managed grants can survive according to browser policy. Deselect is not permission
revocation. Offer a separate Forget permission action when forget exists; otherwise give the
browser's permission-management guidance.

### 3. Serial ownership, cleanup and bounds

State model: idle -> selecting -> selected -> opening -> connected -> closing -> selected/idle, with
a separate actionable error state. One controller owns the port, reader, writer, subscriptions and
queues. Every selection/open/close has a generation; late opens are closed, and stale bytes, async
paste or completion cannot affect a replacement.

Pass Uint8Array chunks directly to xterm to preserve fragmented UTF-8 and ANSI. Reuse fitting,
selection/copy/paste, keyboard escape-to-controls and safe OSC behavior after extracting small
shared primitives. Do not reuse automatic SSH shell recovery, PTY resize messages or login identity.
Resize changes the local display only. Display has 5,000 lines of scrollback; application chunks are
at most 16 KiB and queued input/output at most 256 KiB. Ordered writes check generation before every
chunk. Await xterm's write callback before another read and use a bounded Web Serial buffer
(initially 16 KiB). Hardware/OS buffering is outside the app's queue limit; cannot promise lossless
unlimited boot logs without flow control.

Disconnect/deselect/unplug/read or write failure invalidate input first, discard queued writes,
cancel a pending reader, abort pending writer work, settle controller tasks, release locks and close
the port idempotently. Normal disconnect aborts queued output rather than waiting for a
hardware-flow write forever; never replay bytes on reconnect. Cleanup must also handle an open
resolving after cancellation. A five-second cleanup watchdog shows a closing error and keeps new
opens blocked until ownership is actually released; a timeout is not proof the OS resource closed.
Page unload/app exit releases through renderer teardown and Chromium process ownership, with no
serial auto-reconnect or grant replay.

Workspace tab changes and native minimize retain the open port and bounded receive display, suppress
input while hidden/modal-blocked, and preserve identity. SSH disconnect, target replacement and
report import do not change local Serial ownership; all status messages must qualify which transport
they describe. Reset session data clears both displays and queued input without commands or closing
either transport; a local Clear terminal control handles Serial without an SSH snapshot. App/page
exit closes Serial. These assumptions are reversible and align with the existing terminal tab
behavior.

Before update installation, the shared owner must close Serial and acknowledge cleanup. Integrate a
generation-bound main/renderer quiesce request into the existing update lock: cancel chooser, deny
new selection/input, await serial cleanup before starting update replacement/relaunch. Failure to
acknowledge within five seconds fails that update attempt with the existing install unchanged and no
reopen; do not silently continue. Main still owns SSH/update transaction authority. Checking release
availability alone does not disconnect Serial.

Opening a port can cause OS/adapter control-line behavior and reset some boards. Show concise
guidance adjacent to Connect; promise no automatic commands, Break or explicit DTR/RTS writes, not
reset-free electrical behavior. No diagnostic probing over Serial, no board enablement, no target
automatic setup/sentinel shell commands, no host permission modification and no automatic
transcript/report/storage logging. Explicit operator Automation commands and reviewed QA downloads
follow the approved separate lifecycle below.

### 4. Network evidence is additive and independently attributable

Keep existing interfaces, routes, ethernet and wireless IDs. Add an optional versioned
networkEvidence field to ProbeResult, validated/exported/imported with schema 1:

- version: 1; primary-source/format metadata; bounded sections for extra fixed commands.
- Each executed section: unique key, fixed operation ID, interface/PHY/address-family scope, exact
  command, status/exitCode, stdout/stderr, durationMs, collectedAt, truncated, source live/cached.
- Omissions are separate bounded records with operation/scope and reason (budget exhausted,
  unsupported selector, interface limit, absent imported evidence). Do not fabricate command exits
  or timestamps for commands never run.
- Parser warnings are derived, bounded and tied to section keys; parsed objects are computed from
  raw evidence rather than trusted from imported JSON.

Top-level stdout/stderr/status retain the primary command's contract; existing sysfs ethernet stdout
and graphs stay intact. Optional section failure does not turn a successful discovery into
fabricated success for that section. A failed primary remains failed. Summaries can show
independently collected sections even if another result errors. Command evidence records
unsuccessful JSON-option attempts as well as selected fallback output; presentation identifies the
selected source.

Extend shared/report.ts to validate nonrecursive optional sections, known operation IDs/scope,
unique keys, exit/status agreement, dates, commands and total bytes; bound combined primary plus all
section stdout/stderr at 256 KiB per probe (including cached evidence), at most 96 sections and 32
omission records. Retain MAX_REPORT_BYTES. Cap commands at the existing 8192 characters. Older
schema-1 reports without the extension import normally and display available legacy fields, with new
fields marked not collected. Older applications cannot interpret the extra details; document that
limitation instead of declaring universal forward compatibility.

Collection dispatch in backend/ssh/session.ts remains fixed, with a shared global three-exec
semaphore and a twelve-second end-to-end budget for each network probe group, including discovery
and follow-ups. Every exec has the remaining group deadline, 256 KiB aggregate group budget and
cancellation ownership. No nested fan-out escapes the semaphore. Cap discovery at eight
interfaces/four PHYs per wireless group and sixteen optional ethtool interfaces; report omissions.
Prioritize identity/current state, then peer/survey data, then capabilities/optional detail.
Deadline/byte exhaustion cancels current group work and records omitted detail; live refresh remains
nonoverlapping.

Use fixed command templates and backend-discovered selectors. Prefer validated numeric interface
index/iw wdev identifiers where accepted; otherwise shell-quote the discovered interface name as a
single argument, reject NUL/newline/control or option-like unsupported selectors, and report skipped
selectors. PHY names have a strict phy-number form. Never interpolate SSIDs/BSSIDs or user strings
into shell programs, eval output, glob interface names or accept arbitrary diagnostic commands
through IPC/HTTP.

### 5. Read-only command inventory and capability negotiation

All commands run on the SSH target in the existing C locale/utility PATH, with no sudo/root prompt.
Observe runtime support, not distribution guesses. JSON support is negotiated per command because
BusyBox/version feature subsets differ. Fall back only on verified option/format unsupported errors,
retaining the failed attempt; permission/timeouts/driver/runtime failures do not become successful
fallback evidence.

| Existing result / purpose       | Fixed read commands                                          | Collection policy / fallback                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wireless discovery/state        | iw dev; iw dev <iface> info                                  | Ordinary refresh; iw dev gives initial identity/state. Avoid redundant info when it adds no needed fields. If iw is absent only: existing iwinfo then /proc/net/wireless fallback. An installed failing iw is retained.        |
| wireless connection             | iw dev <iface> link                                          | Ordinary refresh for managed/client modes; AP/monitor/mesh uses mode-appropriate not-applicable state, not an association error.                                                                                               |
| wireless peers                  | iw dev <iface> station dump                                  | Ordinary refresh, bounded table; managed AP peer and AP/mesh peers distinguished.                                                                                                                                              |
| wireless noise                  | iw dev <iface> survey dump                                   | Ordinary read, no scan; preserve per-frequency/in-use values and failures.                                                                                                                                                     |
| wireless capabilities           | iw --version; iw phy <phy> info                              | Collected once per SSH generation/topology or explicit Refresh capabilities; included with original cached timestamp. No supported JSON assumption.                                                                            |
| regulatory                      | iw reg get                                                   | Ordinary refresh, global/per-PHY scopes retained. Channel legality remains a driver/regulatory observation.                                                                                                                    |
| power-save detail               | iw dev <iface> get power_save                                | Optional lower-priority read within ordinary budget; never a set command.                                                                                                                                                      |
| interfaces                      | ip -j address show                                           | JSON preferred; ip addr show / ifconfig -a only on detected format unsupported/tool absence, preserving old parser paths.                                                                                                      |
| ethernet link/topology/counters | Existing /sys/class/net reads; ip -j -d -s link show         | Shared with LAN/WLAN summary. Text ip -d -s link show, then supported simpler ip link show only for unsupported options. Sysfs EINVAL warning behavior retained.                                                               |
| routes                          | ip -j -4 route show table all; ip -j -6 route show table all | Preserve all tables; text with same family/table where supported, simpler family route dump with actual reduced scope labeled. route -n or /proc/net/route only when ip absent; IPv6 missing remains explicit.                 |
| neighbors (ethernet detail)     | ip -j neigh show                                             | Text ip neigh show if JSON unsupported; optional lower-priority read, no resolution/probes.                                                                                                                                    |
| optional LAN physical detail    | ethtool <iface>                                              | Only when installed and a suitable interface is discovered; bounded plain default query, no flags/setters/tests. Separate current speed/duplex/autoneg from supported/advertised modes. Missing/denied does not hide ip/sysfs. |

Capability cache is keyed by SSH generation, PHY identity and detected topology. Reset/reconnect
removes it; explicit Refresh capabilities recollects through the same fixed catalogue/bounds on
desktop and gateway. Every cached section shows its original age; it cannot be called live. An
optional validated forceNetworkCapabilities boolean on the existing collection operation requests
this refresh; reset invalidates backend capability cache through a fixed authenticated operation.
There is no arbitrary per-interface command endpoint.

Excluded from the execution inventory: iw scan/scan trigger (including passive requests), iw
connect/disconnect/set, ip link/addr/route/neigh mutations, ethtool self/cable tests or -s,
ping/iperf/tcpdump and package installation. Cached iw scan dump and policy rules are deferred
advanced scope, not hidden active work. If active scanning is considered in a later release, it
requires a separate explicit user action, permission/traffic explanation and lifecycle outside
ordinary diagnostics; never fold it into Refresh.

### 6. WLAN fields and semantics

Build typed parsers under shared/diagnostics/network/ and shared Summary components under
src/features/network/. The existing inspector gains a default Summary tab for WLAN/LAN; raw
stdout/stderr, command/time/exit/truncation, advanced tree/table and retained graphs remain
reachable. Other probes keep their current default. Select interface with stable identity and
preserve focus/detail expansion through live updates.

| Layer                    | Concrete fields when reported                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface/current state  | interface name, ifindex, wdev, PHY, MAC; mode/type; administrative UP, carrier/LOWER_UP, operstate; current SSID; association state/BSSID; frequency MHz, channel number, width MHz, center frequencies; current TX power dBm; power-save state.                  |
| Current link/peers       | per-peer MAC and interface; signal/signal average dBm, per-chain readings; TX/RX bitrate Mbps plus full MCS/NSS/width/GI/HT/VHT/HE/EHT descriptor; inactivity/connected time; RX/TX bytes/packets/retries/failures; authorized/authenticated flags when reported. |
| Survey                   | frequency, in-use flag, noise dBm, reported channel active/busy/RX/TX durations with original units. A current-noise card requires matching current/in-use frequency; otherwise show only survey detail and current noise not reported.                           |
| PHY specifications       | supported modes/combinations, band/channel frequencies, per-band HT/VHT/HE/EHT support, rates/widths/spatial-stream evidence and power restrictions where reported. Distinguish band/interface-type capability scopes.                                            |
| Regulatory/channel table | domain country/code and global/per-PHY source; channel/frequency, supported status, disabled/no-IR/radar/DFS/CAC and max power flags. Do not label all listed channels immediately usable.                                                                        |
| Modern multi-link        | retain link IDs and per-link frequency/signal/rate nesting; never merge separate MLO links into a guessed single link. Unknown or unimplemented detail remains raw with a parser warning.                                                                         |

Summary cards display mode/state, channel/width, association or peer count, signal, noise and
current transmit power as distinct observations with units/source time. An AP with zero clients is
not a failed association; monitor interfaces have no fabricated SSID/client state. PHY capability is
not current negotiation or Wi-Fi certification. Bitrates are reported PHY rates, not measured
throughput. Regulatory maximum power is not current TX power. No invented signal percent, default
noise zero or guessed Wi-Fi generation. iwinfo/procfs fallbacks have a reduced detail label;
Wireless Extensions units stay raw unless their ABI is verified.

iw explicitly warns its text is unstable. Parse independently recognized optional fields,
repeated/missing blocks and unknown lines; never require an exact complete layout. Preserve original
output and tool version. Use nullable tagged readings with evidence references; unknown is distinct
from valid zero. SSIDs/interface/peer labels are escaped text, never HTML.

### 7. LAN fields and semantics

LAN includes physical and virtual interfaces because current ethernet reads all /sys/class/net
entries. Label loopback, Wi-Fi, bridge, VLAN, veth, bond, tunnel and unclassified kinds; do not
infer physical Ethernet from a name or link/ether alone. Identify lower-link/master/index
relationships from reported topology and use a filter without hiding virtual devices from evidence.

| Section                 | Concrete fields when reported                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link summary            | name/ifindex, kind, MAC, admin UP, LOWER_UP/carrier, operstate, MTU, qdisc; current speed Mbps/duplex/autoneg only from optional ethtool; unknown physical fields explicit.                                                                               |
| Addresses               | all IPv4/IPv6 local/prefix, scope, label, peer/broadcast, flags, valid/preferred lifetime; tentative/dadfailed/deprecated states retained. dynamic is not automatically DHCP.                                                                             |
| Routes                  | family/table, destination, type, gateway/via, device, preferred source, metric, protocol, scope, nexthops/weights/multipath, blackhole/unreachable/prohibit when reported. Multiple default routes remain separate; no reachability verdict from a route. |
| Neighbors               | family/destination, device, lladdr, NUD states/flags. STALE is a cache state, not proof of outage; absence is not device failure.                                                                                                                         |
| Counters                | RX/TX bytes/packets/errors/drops and detailed missed/overrun/frame/carrier/collision counters when supplied; label cumulative and keep source names/units.                                                                                                |
| Physical specifications | optional supported/advertised/partner modes, current speed/duplex/autoneg and link-detected evidence. No LAN bandwidth guarantee or cable-health assertion.                                                                                               |

Administrative UP, kernel carrier and operstate are separate; UNKNOWN is not failure and DOWN is not
automatically a hardware fault. Join only evidence from the same snapshot/session and matching
interface identity, retaining per-command timestamps and conflicts; snapshots are sequential
observations, not atomic. Avoid overwriting newer raw sources with cached data.

Use decimal strings/BigInt for cumulative 64-bit counters. JSON decoding must retain integer token
precision before JSON.parse rounds it (a small bounded tokenizer outside quoted strings is
acceptable; no dependency required). Do not chart unsafe integer conversions; retain exact counters
in tables/raw. Keep legacy graph series keys/units for safely representable sysfs values. New
derived rates, signal graphs and counter delta calculations are deferred.

### 8. Explicit result states and platform matrix

Keep machine exit/status facts and add safe reason labels. Present collected, cached, not reported,
not collected in this report, not applicable to mode, missing tool, unsupported format/driver,
permission denied, timed out, disconnected, limited/truncated and parse warning distinctly. If
errors cannot be reliably classified, use command failed and expose stderr rather than guess.
Parsing failure never changes a command exit or deletes raw evidence. No unavailable metric becomes
a zero, FAIL or hardware absence assertion.

| Client / target                                                          | Planned behavior / qualification                                                                                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 x64 Electron                                               | Local selectable COM labels when Electron supplies them; explicit opens, user-installed adapter driver/access only. Qualify pinned packaged app and busy/unplug handling.                     |
| Linux x86_64 Electron, existing X11/Wayland matrix                       | Local tty descriptors supported by runtime, with clear permission/busy states. No chmod/groups/udev changes or elevated execution. Packaging/compositor tests stay intact.                    |
| macOS x64/arm64 Electron                                                 | Local serial descriptors subject to runtime/OS access. Qualify both existing native architectures; no new signing/notarization claim.                                                         |
| HTTPS website in supported desktop browsers                              | Native chooser and authorized devices on the browser computer; no gateway token/SSH required for Serial. Test Chrome/Edge and feature-detect other browsers rather than permanent brand bans. |
| Missing API, denied policy, insecure context, mobile unsupported runtime | Serial page remains readable with an actionable unsupported/denied reason; diagnostics and report import remain usable.                                                                       |
| file:// portable website / localhost developer UI                        | Feature-detect secure context and API, qualify actual launch mode; file delivery is not assumed supported or unsupported. Never relax security flags.                                         |
| Linux SSH targets: full iproute2+iw; OpenWrt/BusyBox/minimal firmware    | Same shared collectors/parsers via desktop or gateway, detected tool/driver capabilities and reduced fallbacks. Target CPU architecture is independent of client serial support.              |
| Non-Linux SSH shell or missing procfs/netlink                            | Honest unavailable network fields; no fabricated Linux evidence.                                                                                                                              |
| Imported reports / disconnected snapshots                                | Network summary is historical, no commands executed; Serial can still operate independently if explicitly selected/opened.                                                                    |

## Risks / Trade-offs

- [Pinned Electron custom-origin permission behavior] -> Early API/chooser-policy harness and
  packaged integration; do not change Electron or introduce native dependencies automatically. If
  unsupported, report a concrete gate for the next implementation decision.
- [Open/close can affect control lines] -> Explain beside Connect; omit automatic signals/commands.
  Physical driver/board behavior requires separately authorized tests.
- [Busy or stalled flow-controlled port] -> Bounded queues, abortable writes and reader
  cancellation, truthful close watchdog; no retry/replay.
- [iw text/version/driver variation] -> Optional field parsers, unknown-line warnings,
  upstream-derived fixture variants and raw provenance.
- [Network command fan-out] -> Twelve-second group budget, global three-exec limit, caps,
  prioritized state and visibly aged capability cache.
- [Capability/regulatory changes while cached] -> Separate cached data and live reg/state, topology
  invalidation, explicit Refresh capabilities; no regulatory safety guarantee.
- [JSON integer precision or interface reuse] -> Exact decimal counters, identity/source timestamps,
  no unsafe graph conversion.
- [Extension changes strict report validation] -> Old/new/malformed round-trip fixtures and
  aggregate byte checks; preserve primary IDs/output.
- [Refactor regresses SSH recovery or layout] -> Extract only common terminal primitives; existing
  SSH recovery, OSC, clipboard and native-window tests remain mandatory.

## Migration Plan

Implement after a separate apply request, in the tasks.md order. Additive report evidence needs no
disk migration; reports without it use legacy parsers. Keep package version unchanged until feature
verification/qualification is ready, then recommend v0.5.0-rc.1 and v0.5.0 according to existing
release rules. This stage makes no release/publication changes.

Implementation updates architecture/hardware/usage/development/website guidance and removes stale
serial/roadmap claims without reviving retired Tests/Genie features. Existing CI/build/platform
matrix stays unchanged; add focused tests, run relevant gates locally, and consolidate source
publication only when separately authorized. Rollback reverts source changes through normal Git
history; no host/device permissions/configuration or port grants require cleanup because the app
persists none.

## Remaining Evidence Gates

No product layout or scope decision is blocking this draft. The single active port, session-only app
grants, independent SSH lifecycle, tab retention, no transcript persistence and no active scanning
are explicit reversible design assumptions. Report a decision only if pinned-runtime app:// support
or an unavoidable permission/adapter limitation makes Web Serial incapable of the accepted behavior.

Fixture/mocked tests cannot qualify physical ports or RF/driver values. Before declaring release
support, obtain separately authorized Windows/Linux/macOS adapter evidence and read-only target
samples for full iw/ip, BusyBox/OpenWrt and at least a managed/AP case. No physical port opens or
target commands were performed during this proposal.

## Sources and Verification Basis

Local code and user/parent research provide the implementation baseline; primary sources were
checked on 2026-10-13. Upstream latest documentation is guidance, not proof of the pinned runtime or
any installed target utility.

- [Electron device access](https://www.electronjs.org/docs/latest/tutorial/devices): chooser versus
  browser behavior, temporary chooser hotplug events, session device grants.
- [Electron session API](https://www.electronjs.org/docs/latest/api/session#event-select-serial-port)
  and [SerialPort descriptors](https://www.electronjs.org/docs/latest/api/structures/serial-port):
  chooser callback and descriptor contracts; corroborated by installed electron.d.ts.
- [Web Serial Standard](https://serial.spec.whatwg.org/): API options, permission/security/lifecycle
  contract.
- [Chrome Serial guide](https://developer.chrome.com/docs/capabilities/serial): authorized-port
  discovery, stream lock/cancel/close patterns and signal effects.
- [xterm security guide](https://xtermjs.org/docs/guides/security/): terminal output is untrusted;
  existing OSC guards are retained.
- [iw command documentation](https://wireless.docs.kernel.org/en/latest/en/users/documentation/iw.html):
  link/station information and distinction between reads/scans/setters.
- [Upstream iw entry point](https://kernel.googlesource.com/pub/scm/linux/kernel/git/jberg/iw/+/refs/heads/master/iw.c):
  text instability and command/version interface.
- [Upstream survey output](https://kernel.googlesource.com/pub/scm/linux/kernel/git/jberg/iw/+/refs/heads/master/survey.c):
  optional per-frequency noise/in-use/time observations.
- Parent researcher inspected upstream iw
  [interface](https://kernel.googlesource.com/pub/scm/linux/kernel/git/jberg/iw/+/refs/heads/master/interface.c),
  [station](https://kernel.googlesource.com/pub/scm/linux/kernel/git/jberg/iw/+/refs/heads/master/station.c),
  [PHY](https://kernel.googlesource.com/pub/scm/linux/kernel/git/jberg/iw/+/refs/heads/master/info.c)
  and
  [regulatory](https://kernel.googlesource.com/pub/scm/linux/kernel/git/jberg/iw/+/refs/heads/master/reg.c)
  output. These guide fixtures and optional-field coverage; they do not establish every target
  exposes them.
- [Linux operational states](https://docs.kernel.org/networking/operstates.html): separate
  administrative/lower-layer/operational meanings and UNKNOWN.
- [ip manual](https://man7.org/linux/man-pages/man8/ip.8.html) and
  [ip link manual](https://man7.org/linux/man-pages/man8/ip-link.8.html): JSON/details/statistics
  options and link queries. These are iproute2 manual pages, not proof BusyBox implements the same
  options.
- [ethtool manual](https://man7.org/linux/man-pages/man8/ethtool.8.html): its single-interface
  default query prints settings, while setter/self-test/cable-test options are separate. Target
  availability and exact optional fields still require version-specific fixtures; no
  installed-target support is claimed by this documentation check.

## Serial Beach Visual Addition (user request, 2026-10-13)

Reuse the SSH terminal pig/duck pixel grids through shared sprite exports; retain the SSH scene and
its default palette. Serial gets a separate SVG/CSS beach scene with soft light colors, ocean/waves,
sand, side palms, a volleyball moving between the animals over a net, and a sun replacing the Earth
motif. Place it behind a dark legible terminal veil with pointer-events disabled and aria-hidden
decoration. CSS transforms provide bounded animation without timers/canvas loops; pause while
hidden, blocked or document-hidden and stop motion under prefers-reduced-motion. Verify screenshots,
responsive resizing, contrast, animation cleanup and unchanged SSH scenery. No new dependency or
generated raster asset is needed.

Visual inspection refinement: fit the entire scene with SVG meet scaling and reserve a 140-pixel
decorative frieze under the fitted terminal screen. This keeps both characters visible on mobile and
permits brighter soft colors below the text; the heavy veil covers all actual terminal rows.

User clarification: Serial contains only the rotating sun/rays motif and no Earth/globe. The
existing SSH Earth is only an implementation reference and remains unchanged. Add a DOM assertion
for absence of Earth in Serial and scoped sun rotation/reduced-motion checks.

# Automation additions (approved local implementation)

This change now includes an Automation primary tab for SSH and Serial. The numbered flow editor
preserves each named, enabled multiline command as one payload. Enter adds a newline; only explicit
Run once or Start arms a snapshot. Reorder/duplicate/delete are reversible edits; active runs retain
their immutable snapshot and new edits apply on the next arming. No import engine, command
rewriting, shell inference or graph canvas is included.

## Ordered execution and scheduling

Immediate execution is the default. Optional wall-clock start, delay before each enabled step and
repetition after a complete flow are independent controls. Repetition is off by default, sequential
and never overlaps or accumulates missed runs. Stop disarms repetition/waits and allows an already
sent command to finish; Cancel requests cancellation of the owned channel/capture, stops later steps
and never promises remote process rollback. Start preview includes the exact resolved instant, IANA
zone and UTC offset. Strict calendar validation rejects impossible days/leap dates, invalid
components, overflow/nonfinite numbers, DST gaps, unresolved folds or conflicting offsets. Arming
requires at least two seconds plus verified uncertainty in the future and repeats all validation.
Draft text remains intact on failure. Local timing uses the local wall clock for the start and
monotonic elapsed durations for delays. Device timing requires an identified current-connection
calibration with actual device epoch/zone, local receipt and RTT uncertainty; no clock fallback is
relabeled as device time. SSH exposes an explicit fixed read-only clock sampling action, with
disclosed bounded refresh while a device-clock schedule is armed. Serial prompt responses can supply
exact received ISO timestamps via a configured literal prefix for row provenance, but arbitrary
consoles cannot prove emission latency: device-clock arming remains unavailable without a verified
calibration provider. No automatic date/sentinel/setup payload is sent through Serial. Connection
replacement/disconnect, document hide/page exit, app sleep/timer stalls, clock jumps, sample
staleness or failed calibration pause the flow. Resume requires explicit re-arming and a fresh
future start. No background OS scheduled task is created.

## Capture and export

SSH uses isolated authenticated exec channels, real exit status and separately decoded
stdout/stderr. Scripts are deliberate operator actions, distinct from the fixed observational
diagnostic inventory. Serial requires a configured printable literal prompt suffix and bounded
timeout; streaming ANSI removal, split chunks, pre-send quiet input and exclusive ownership reduce
ambiguity. Echo, unsolicited bytes, stale driver buffers or prompt-like payloads can still be
included, so prompt observation is not command success or an exit code. Bounded completed results
(200 rows/8 MiB), 64 KiB per command output, 256 raw chunks and explicit truncation/eviction are
shared. Local start/completion and device observations have honest source/zone provenance.
Search/status/command filtering, row selection and paused autoscroll permit review. Retained
immutable rows export as JSON/CSV/Markdown/text in selected/filtered/all-retained scope without
querying or executing again. JSON preserves exact retained text/raw base64; CSV lists apostrophe
transformations for formula-like cells, robust quotation and newlines. Markdown uses dynamically
sized fences and escaped headings; human formats render nonprinting controls visibly. Credentials
are never copied from connection configuration, but commands/output themselves may contain secrets
and require user review. Exports are local user-triggered downloads.
