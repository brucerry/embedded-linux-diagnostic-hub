# Deferred hardware qualification — v0.5.0

Status: **not run / not passed**. The user will perform these checks at work. Software fixtures and
CI receipts do not establish physical acceptance. Record client OS/runtime, candidate
version/source/digest, adapter VID/PID and driver, target identity, wiring/framing, command/output
timestamps, expected versus observed behavior, and Pass/Fail/Unsupported/Blocked for each case.

## Before opening a physical port

- [ ] Use an approved unconnected adapter/loopback first; verify pinout and logic levels before
      wiring a board. Target UART enabling, pin mux, bootloader/console setup and target operation
      remain the user's responsibility.
- [ ] Verify the candidate bytes/source, retain the last known good app and identify a recovery
      path. Do not disable sandbox, Gatekeeper, SIP or OS access controls to make a test pass.
- [ ] Identify DTR/RTS/open-close effects with the safe fixture before connecting a reset-sensitive
      target. Confirm what the user's site permits; no package/group/driver/permission change is
      part of this checklist.

## Serial adapter, framing and data

- [ ] On Windows, Linux and macOS where available, confirm actual COM/tty labels, native chooser
      add/remove/cancel, authorized-port selection and feature-detected Forget behavior.
      Selecting/deselecting alone must not open the device.
- [ ] Connect explicitly using known framing (start with 115200 8N1/no flow control when appropriate
      to the fixture). Check supported baud/data/parity/stop/flow variants and truthful unsupported
      errors.
- [ ] Verify exact binary/UTF-8 input/output patterns, fragmented multibyte/ANSI data and
      CR/LF/CRLF/none expectations; compare generated sequence counters to detect hardware/driver
      drops. Local echo must be deliberate.
- [ ] Repeat connect/disconnect/deselect; verify idle reads and blocked hardware-flow writes can
      close, locks release and unresolved cleanup blocks new opens. Record adapter
      reset/control-line behavior on every open/close.
- [ ] Unplug during idle/read/write and while choosing a port; verify no automatic reconnect or
      replay. Test busy/permission-denied ports without changing permissions.
- [ ] Switch tabs/minimize/restore, clear/reset/import diagnostics and check updates; preserve
      appropriate reception/identity, disable hidden input, and confirm installation stops if
      cleanup cannot be acknowledged.
- [ ] Inspect pixel beach/readability/resize/reduced motion: pig/duck volleyball, waves/sand/side
      trees and rotating sun remain; no Earth/globe decoration or pointer interception.

## Automation on SSH and Serial

- [ ] Use approved harmless queries or fixture echo payloads. Each named/enabled multiline entry
      must remain one deliberate payload; Enter inserts a newline, bytes/ending preview agrees with
      transmission, disabled steps do not execute, active edits apply only after rearming.
- [ ] Verify ordered steps and elapsed delays; Run once honors a scheduled start and never repeats.
      Start flow repeats only after the full flow and configured delay, without overlap/backlog.
- [ ] Reject invalid calendars, DST gaps/unresolved folds, incompatible offsets, past/near-past
      times and nonfinite/out-of-range durations. Record exact zone/offset/resolved instant. Local
      timing must use the client clock.
- [ ] On SSH, explicitly sample the actual device clock and compare source/zone/uncertainty. Check
      stale/replaced samples and app sleep/disconnect/clock correction pause behavior using approved
      procedures; do not alter production time configuration merely for testing.
- [ ] Serial device scheduling remains unavailable without a verified timing provider. Optional
      received ISO timestamp prefix is only an observation; no automatic date/setup/sentinel command
      should be transmitted.
- [ ] On Serial, verify a configured literal prompt across chunks/ANSI, echo, unsolicited traffic,
      stale buffers and timeout. Prompt-observed is not a successful exit. Interactive input remains
      exclusively owned while the flow is active.
- [ ] Stop prevents later/repeated work; Cancel requests owned capture/channel cancellation. Already
      sent commands may continue: do not interpret cancellation as remote rollback or kill unrelated
      processes.
- [ ] SSH real exit status stays genuine; ordinary nonzero exits follow the documented continue
      policy. Signal/unknown-close cases must pause subsequent steps and repetition with available
      termination evidence. Use approved lab procedures only; never interrupt a production service
      for this check.

## Actual WLAN/LAN evidence

- [ ] Record kernel, iw, ip/iproute2 or BusyBox and relevant driver/tool versions. Compare UI fields
      with the exact retained read-only command sections.
- [ ] Managed/AP/monitor/mesh/MLO where available: verify interface/association/peer status
      separately from PHY bands/modes/channels/restrictions. Current signal/power and
      frequency-matched in-use survey noise must remain observational; unsupported/denied noise
      stays unknown.
- [ ] Check regulatory/DFS/no-IR/disabled/CAC detail and cached capability source time/refresh. Do
      not trigger active/passive scans, association, radio setters or network configuration changes.
- [ ] Compare LAN admin/carrier/operstate, physical/virtual topology, addresses/lifetimes/DAD,
      IPv4/IPv6 tables/multipath and neighbors. UNKNOWN/STale semantics and exact large counters
      must be preserved; optional ethtool getter failure stays explicit.
- [ ] Verify missing tools, BusyBox JSON option rejection, permission denial, disappearing
      interfaces, timeouts and truncation/omissions are distinct. Do not install tools or elevate
      permissions to conceal an unsupported state.

## Results, exports and real Mac first launch

- [ ] Review row command/transport/target/timing/framing provenance, genuine exits versus completion
      reasons, selection/filter/autoscroll, truncation and retention.
- [ ] Download selected/filtered/all-retained JSON/CSV/Markdown/text. Confirm export does not
      rerun/query; JSON/raw bytes remain exact, CSV formula-like cells have documented transforms,
      human formats safely render C0/C1 controls. Review commands/output for secrets before sharing.
- [ ] Where a physical Mac is available, test the documented downloaded candidate first launch with
      actual quarantine/normal OS security handling and site approval. Record Intel/Apple silicon,
      OS version, signature/architecture checks, launch/rollback and port access. A CI or synthetic
      launch does not replace this check.
- [ ] Attach observations and evidence to the candidate qualification record. Leave unavailable
      environments and unsupported capabilities clearly classified; do not mark them passed.
