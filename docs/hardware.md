# Hardware diagnostic coverage

Diagnostics discover capabilities exposed by the target's kernel and installed tools, independently
of board model or CPU vendor. Exact hardware revision, pinmux, wiring, calibration and electrical
limits still require the target's own documentation and fixtures. See
[validation guidance](validation.md).

The current application collects **36 read-only checks**: 13 system/software checks and 23 hardware
discovery checks. An exposed kernel object or a completed command is evidence, rather than a
functional hardware PASS. Unexposed capabilities remain `Unavailable`; failed reads or permissions
remain `Error`.

| Module             | Implemented read-only evidence                                       | Later functional validation                                                                                 |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| LEDs               | Names, brightness and triggers                                       | Operator/optical observation of colors, patterns and brightness                                             |
| LAN                | Interfaces, routes, link/carrier and packet/error counters           | Port mapping, peer link/negotiation, throughput and PHY error counters                                      |
| WLAN               | `iw` / `iwinfo` / wireless procfs inventory                          | Association, bands, antenna mapping, RSSI, throughput and RF fixtures                                       |
| Buttons            | Linux input-device inventory or device-tree button labels on OpenWrt | Press/release, debounce, event mapping; protect reset/factory-erase behavior                                |
| UART               | Registered serial-driver evidence                                    | Pinout, logic levels, baud rate and fixture loopback                                                        |
| I²C                | Registered adapter/device names and modalias                         | Known-device transactions with approved register map; no blind bus scans                                    |
| I²S                | ALSA card/PCM inventory                                              | DAI format, clocks, channel routing, audio loopback and signal analysis                                     |
| SPI                | Registered SPI device identity                                       | Approved fixture transactions, mode/clock/CS timing                                                         |
| NAND/NOR           | MTD geometry and exposed ECC/bad-block counters                      | Boot-chain/ECC layout validation, programmer agreement; destructive tests need a dedicated fixture/workflow |
| Storage            | Mounted usage and block capacity/sector size/model                   | File-level performance and integrity on an approved scratch area                                            |
| eMMC/SD            | Card identity and exposed lifetime/pre-EOL values                    | Card-spec interpretation, bus mode and approved integrity tests                                             |
| USB                | Enumerated devices and reported speeds                               | Port mapping, power delivery and transfer/loopback fixtures                                                 |
| PCIe               | Device identities and negotiated/max link attributes                 | Endpoint behavior, traffic and signal integrity/margining                                                   |
| Power input/output | `power_supply` and regulator inventory/readings                      | DMM/scope/programmable supply/load; approved rail mapping and tolerances                                    |
| Current/voltage    | Exposed hwmon channels and labels                                    | Sensor scaling/calibration, shunts and external-meter comparison                                            |
| Temperature        | Thermal zones and hwmon readings                                     | Sensor identity/calibration, thermal limits and controlled loading                                          |
| DDR                | Memory availability and exposed EDAC counters                        | Bounded memtester/stress tests, allocation budgets, training and boot evidence                              |
| HDMI/DP            | DRM connector state and advertised modes                             | Image, audio, resolution/refresh and EDID validation with a sink/capture fixture                            |
| GPIO               | Chip labels and line counts                                          | Board-approved input/output fixture; no generic pin toggling                                                |
| RTC                | Identity and date/time                                               | Drift, backup power and alarm/wake behavior                                                                 |
| Watchdog           | Identity, state, timeout and bootstatus                              | Controlled reset/recovery; collector never opens `/dev/watchdog`                                            |
| Sensors/ADC        | IIO names, raw values and scale/offset attributes                    | Wiring, conversion, calibration and reference stimuli                                                       |
| Fans               | RPM and labels                                                       | Fan mapping, stall detection and approved PWM/thermal control tests                                         |

Additional useful modules include boot/reset-cause correlation, kernel/driver/module inventory,
device-tree capture, interrupts, clock/pinmux evidence, PoE/PD controller telemetry, battery/UPS
health, Bluetooth, GNSS, cellular modems/SIM, CAN, Ethernet switch/PHY diagnostics, and secure-boot
provenance. These are candidates, rather than implemented claims.

## Interpretation rules

- Current, temperature, IIO and fan measurements require actual measurement attributes. A hwmon
  device name alone does not establish a current sensor.
- Hardware inventory can be empty even when the software tool exists. For example, `iw dev` can
  successfully show no interfaces. Inspect the output before establishing device presence.
- `power_supply` voltage/current/power attributes use µV/µA/µW. hwmon values use their own ABI and
  may require board-specific scaling/labels; the GUI keeps raw paths and readings rather than
  inventing rail identities.
  [Power supply ABI](https://docs.kernel.org/power/power_supply_class.html),
  [hwmon ABI](https://docs.kernel.org/hwmon/sysfs-interface.html).
- MTD `oobsize` is driver-visible. It does not by itself establish physical spare geometry,
  programmer formatting or a valid boot-chain ECC layout. ECC counters are cumulative and require
  context. [MTD sysfs ABI](https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-class-mtd).
- Available RAM does not establish safe stress-test allocation, DDR type, training margin or
  data-bus correctness. `MemFree`, reserved memory, DMA/ION allocations and device-specific policies
  must be considered separately.
- I²C/SPI pinmux can share pins with other functions. Presence in an SoC feature list does not
  establish availability on the current board.
- OpenWrt identity comes from `ubus call system board`; other targets use device-tree, DMI or
  operating-system identity evidence. Report the observed fields without selecting a board profile
  or assuming supported hardware from a model name.

Generic discovery deliberately avoids writing sysfs controls, probing unknown bus registers, opening
watchdog devices, changing GPIO/power rails, erasing flash, modifying networking, or resetting the
device. Those actions belong to separately designed functional tests with explicit prerequisites and
recovery.

## Serial, network insights and Automation

v0.5.0 includes [Serial](serial.md), [WLAN/LAN insights](network-insights.md) and
[ordered Automation / QA exports](automation.md). Published v0.4.0 assets remain unchanged. Target
UART enablement/operation belongs to the user; physical ports and Linux/macOS drivers are separate
qualification gates. Automation operator scripts are distinct from the fixed observational
diagnostic catalogue.

## v0.5.0 work-environment acceptance checklist

**Physical qualification is deferred, not passed.** No DUT or UART adapter was available during
software qualification. The user plans to test Serial on Windows 11 at work. Automated fixtures and
hosted native CI establish the tested software paths; they do not establish adapter, wiring, board,
RF or managed-desktop acceptance. Record the application version/source/checksum, Windows build,
adapter VID/PID/driver, target identity, framing, timestamps and expected/observed result. Use Pass,
Fail, Unsupported or Blocked for each case.

- [ ] Verify the downloaded candidate checksum/source and retain the last known good app. Confirm
      site policy, pinout, voltage and DTR/RTS/open-close effects on an approved adapter/loopback
      before connecting a reset-sensitive target. Target UART enabling, pin mux, wiring, bootloader
      and target operation remain the user's responsibility. Do not disable security controls or
      change host permissions/driver configuration to force acceptance.
- [ ] On Windows 11, verify correct local COM identification, chooser cancellation, selection
      without opening, explicit Connect/Disconnect/Deselect, and the actual supported baud/data/
      parity/stop/flow settings. Check busy, denied and unsupported-setting states. Confirm received
      bytes, Unicode, CR/LF/CRLF, local echo and Ctrl+C using an approved target or loopback.
- [ ] Observe unplug/replug, target reset, blocked hardware flow and disconnect during a write.
      Confirm retained output, discarded queued input, truthful cleanup, no automatic reopening or
      replay, and blocked replacement while ownership is unresolved. Check update/close cleanup
      while connected; rearm deliberately after interruption.
- [ ] Use harmless user-approved commands to test ordered multiline Automation over both SSH and
      Serial. Verify the board's literal prompt and chosen line ending; prompt observation is not an
      exit status. Check one-shot/delay/repetition, Stop versus Cancel, manual-input exclusion,
      nonzero SSH exit, signal/timeout interruption and no later-step/backlog execution.
- [ ] Test scheduled work on the actual host across hiding, sleep/wake and disconnect/replacement.
      Verify local calendar/timezone/offset and explicit rearming. For SSH device-time starts,
      compare the sampled device clock and stated uncertainty with an independent observation.
      Arbitrary Serial consoles cannot provide verified device-time starts; received timestamp
      prefixes remain observations rather than measured emission latency.
- [ ] Review selected/filtered/all-retained JSON, CSV, Markdown and text exports against captured
      bytes, stream/exit metadata and local/device-time provenance. Exercise multiline/control/
      Unicode content, retention/truncation and the intended spreadsheet/QA reader. Review for
      secrets before sharing; exports do not execute commands.
- [ ] On the real Linux target, collect the fixed read-only `iw`, `ip` and optional `ethtool`
      evidence with normal permissions. Compare WLAN interface/mode/connection/signal/noise/power
      with raw output and keep PHY/channel/regulatory capabilities separate from current state.
      Compare LAN administrative/carrier/operational state, addresses/routes/neighbors, topology and
      exact counters. Missing tools, denied reads and driver omissions remain unavailable or failed
      observations; do not install tools, scan RF or reconfigure networking during this check.
- [ ] Qualify any additional intended client: physical Linux/macOS adapters and permissions, browser
      support, and native Mac Safari-download/quarantine first launch or managed-device policy.
      Hosted Mac CI does not establish these cases; ad-hoc integrity signatures are not Developer ID
      signing or notarization. Use the normal platform security path.

Record unperformed cases as Not run. A sample/mock SSH server is useful for practicing the UI and
exports, but its diagnostics, clocks and command results must never be counted as DUT qualification.
See [Serial controls](serial.md), [network evidence](network-insights.md) and
[Automation semantics](automation.md).
