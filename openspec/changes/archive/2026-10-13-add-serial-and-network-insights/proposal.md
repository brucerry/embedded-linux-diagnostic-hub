# Proposal

## Why

Developers need a local UART console alongside SSH diagnostics, and readable network observations
rather than having to interpret the current WLAN tree and LAN sysfs paths. The qualified v0.4.0
baseline makes a focused v0.5.0 feature release a suitable next step.

## What Changes

- Add a primary workspace named **Serial**, independent of SSH and report connections, with explicit
  local port selection, deselection, Connect/Disconnect, configurable UART framing and a bounded
  xterm terminal. The target UART setup, wiring, electrical compatibility and target operation
  remain the user's responsibility.
- Use renderer Web Serial with a narrow, user-operated Electron chooser and permission policy.
  Support desktop COM/tty labels where supplied, browser chooser/authorized-port semantics where
  supported, and clear unsupported states. Do not add a native serial dependency by default.
- Add a readable WLAN Summary to the existing WLAN / Wi-Fi evidence inspector, with interface
  mode/state, connection, signal, noise, transmit power, peer/rate observations and separate radio
  capabilities/channels/regulatory sections. Retain raw output and advanced trees.
- Add a readable LAN Summary to the existing LAN / Ethernet inspector, joining link state/counters
  with addresses, IPv4/IPv6 routes and neighbor evidence. Label virtual/stacked interfaces
  explicitly, add optional read-only ethtool physical detail when installed, and expose unavailable
  fields honestly.
- Extend existing fixed network probes with bounded, individually attributed command evidence and
  version-tolerant parsers. Preserve probe IDs, old report imports, sysfs counter graphs and
  existing SSH terminal behavior.
- Keep ordinary diagnostics read-only. Do not add active scans, network setters, throughput/ping
  tests, target tool installation, UART enablement, unattended target setup, serial transcript
  export or persistent serial grants in this release.

- Add **Automation** for deliberate ordered SSH/Serial scripts with immutable multiline snapshots,
  optional validated starts/delays/repetition and bounded provenance-aware results/QA exports. These
  operator actions are separate from ordinary observational diagnostics.

## Capabilities

### New Capabilities

- `local-serial-terminal`: Explicit local-host UART selection, independent terminal ownership,
  limited permissions, safe cleanup and platform limits.
- `wireless-diagnostics`: Readable current interface/peer observations, separate PHY/channel
  capabilities, regulatory context and optional-field parsing.
- `lan-diagnostics`: Readable administrative/carrier/operational state, interface topology,
  addresses/routes/neighbors and counters.
- `network-evidence`: Fixed read-only command inventory, per-command provenance, bounds, partial
  failure handling and backward-compatible report evidence.

- `command-automation`: Ordered operator commands over SSH/Serial, strict optional timing and owned
  lifecycle.
- `automation-exports`: Bounded results, honest time/exit provenance, filtered/selected/all-retained
  local QA formats.

### Modified Capabilities

None. The existing `connected-device-terminal`, `ssh-connection-lifecycle` and platform-window
requirements remain in force. Shared terminal refactoring must preserve their behavior; Serial has
its own explicit lifecycle.

## Impact

Affected areas are `src/app/App.tsx`, `src/app/view.ts`, new Serial/network feature modules, shared
terminal display/input primitives, `electron/main.ts` and `electron/preload.ts`, `shared/types.ts`,
`shared/report.ts`, `shared/diagnostics/`, and the fixed SSH collection path in
`backend/ssh/session.ts`. Gateway collection inherits the same diagnostic changes but receives no
local-port API. Tests cover parser fixtures, loopback SSH, mocked serial streams/chooser, browser
layouts and native boundaries; separately authorized physical qualification is required before
claiming real adapter support.

Recommend **v0.5.0**, optionally qualified through v0.5.0-rc.1. This proposal changes no version,
branch, dependency, release asset, tag or workflow. The historical roadmap in `docs/architecture.md`
must be updated during implementation because its v0.5 row describes a retired testing direction; it
does not override the requested feature scope. The proposal remains local under the existing
`.git/info/exclude` rule.

## Approved scope additions

Automation now supports both SSH and Serial ordered command flows, strict optional wall-clock
start/local or verified device clock, elapsed step delays, optional repetition, bounded
provenance-aware results and selected/filtered/all-retained JSON/CSV/Markdown/text exports. See
command-automation and automation-exports delta specs. No real device execution or publication is
authorized by this product design.
