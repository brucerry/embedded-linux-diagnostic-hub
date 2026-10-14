# Local Serial terminal

Serial owns ports on the client computer independently of SSH/gateway. Choose an authorized port or
use Choose port, set framing, then explicitly Connect. Selection never opens a port. Defaults are
115200 baud / 8N1 / no flow control. Hardware framing depends on the adapter and driver. Disconnect
closes streams and releases locks; Deselect also clears selection. Unplug and fatal read errors
never reconnect or replay input. Recognized recoverable read errors (including UART break) resume
only through a fresh readable stream on the same open port, with generation and cancellation guards.
A five-second cleanup watchdog retains unresolved ownership and blocks new opens. Byte queues,
terminal scrollback and receive consumption are bounded. Local echo defaults off; Enter explicitly
sends CR/LF/CRLF. Tabs preserve reception while hiding interactive input. Updates require confirmed
Serial cleanup. The pastel pixel beach reuses the SSH pig/duck grids with volleyball, waves, sand,
taller palms, coconuts, occasionally perching birds and a stationary sun with gentle animated pixel
flames. No Earth/globe is present. Decoration cannot intercept input, pauses while hidden/blocked
and respects reduced motion. SSH retains its Earth position above a lower playground and slowly
varying stars; both terminals share the same responsive height, cursor, selection and
keyboard-accessible clipboard menu.

| Client                                | Serial support                                        | Qualification                                                                                               |
| ------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Packaged Electron Windows/Linux/macOS | Chromium Web Serial, exact trusted top-level document | Synthetic Windows permission/lifecycle proof; physical ports and Linux/macOS behavior remain separate gates |
| Secure Chromium browser               | Feature-detected native chooser                       | Often USB IDs rather than COM/tty names; HTTPS or supported localhost required                              |
| Unsupported/insecure browser          | Explicit unavailable state                            | SSH gateway and imported reports remain usable                                                              |
| SSH gateway                           | No Serial endpoint                                    | Ports remain on the user's client computer                                                                  |

UART enabling, pin mux, wiring, voltage, bootloader and target operation are the user's
responsibility. The app changes no OS groups/permissions, drivers or control lines. Opening an
adapter itself can affect DTR/RTS; physical qualification must record this before sensitive use.

## Automation and read recovery

Automation uses the selected open connection, writer and single receive reader. Received bytes
continue to both the terminal and the command capture across tab changes. Manual typing/paste is
blocked while Automation owns input. A distinct `[Automation input, local]` annotation shows the
requested bytes; it is not device echo and is excluded from captured device output and exports.
Writing bytes does not establish remote completion.

A recoverable read error interrupts an active capture without replaying commands. If an Automation
write is still outstanding, cleanup closes the port within the existing ownership/watchdog rules;
reconnect explicitly after checking the target. Fatal removal, a missing replacement stream, or an
unrecognized error still closes ownership. No recovery path opens another port or resends input.

Default COM11 connection and send/receive on Windows 11 were reported working by the user.
Power-cycle recovery and the revised Automation behavior require a separate physical retest; the
agent's lifecycle and capture evidence uses synthetic streams.

## Port discovery and runtime coverage

Choose port asks the runtime for currently offered ports. The dropdown contains previously
authorized handles, so an empty dropdown is not an OS inventory. Selection alone never opens a port;
Connect is explicit. Names such as COM11 are displayed as supplied by Electron. All valid unique
runtime-offered IDs remain reachable using paging/search; no COM-number or adapter-brand whitelist
is applied. USB IDs and friendly-name text are optional to the app, and built-in, USB and
virtual-driver offers are accepted without them. No automatic control-line setter is used. Opening
itself may have driver-defined electrical effects, which remain a physical acceptance case.

The packaged runtime is Electron44.5.1 / Chromium152.0.7977.130. Runtime coverage is not identical
to every serial-capable OS device node:

| Platform | Enumerator coverage and limits                                                                                                                                                                                                                                                                          | App acceptance                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Windows  | COM interfaces plus present Ports/Modems device classes; OS instance ID and port-name properties required. Chromium handles multi-digit COM paths. Its fallback requires a friendly-name property if bus description is absent. Registry-only/driver-incomplete virtual ports can therefore be missing. | Every valid offered ID/name; USB IDs/display text optional to the app. Physical drivers unverified here. |
| Linux    | udev tty nodes matched to serial-type drivers in /proc/tty/drivers; arbitrary pseudoterminals are excluded.                                                                                                                                                                                             | Offered built-in/USB/virtual serial drivers; no promise for arbitrary /dev/pts nodes.                    |
| macOS    | IOSerialBSD services, preferring callout paths; USB properties are optional.                                                                                                                                                                                                                            | Offered built-in/USB/virtual serial services; arbitrary filesystem nodes are not an inventory.           |
| Browser  | Browser chooser and authorized handles only; API/secure-context/OS permissions vary.                                                                                                                                                                                                                    | Feature detected; unsupported remains explicit.                                                          |

These limits come from the pinned Chromium source, not physical driver qualification:
[Windows enumerator](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/services/device/serial/serial_device_enumerator_win.cc),
[Linux enumerator](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/services/device/serial/serial_device_enumerator_linux.cc),
[Mac enumerator](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/services/device/serial/serial_device_enumerator_mac.cc).

Literal support for valid OS ports outside that catalog requires a separate native transport design:
OS-attested identities, trusted main-process selection, explicit open/configuration, exclusive
ownership, bounded byte queues/cancellation and honest permission/busy/error states. It must honor
OS/device policies and avoid arbitrary renderer paths, implicit opens or control-line setters. No
such fallback or new native dependency is added by this focused correction; that compatibility
requirement remains a follow-up decision.
