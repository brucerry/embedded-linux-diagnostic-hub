# Proposal

## Why

The Tests workspace can reuse LED, UART and approved I2C identity tests, but engineers cannot yet define comparable measurements from driver-owned sensors or reviewed installed utilities. Extend that workspace so board-specific diagnostic intent can reuse trusted access methods, resource selection, units, acceptance ranges and evidence without rewriting shell commands or claiming universal hardware support.

## Prerequisite order

Bruce has authorized implementation with a strict gate: audit and remove every application-owned connected-device Python invocation, including existing UART loopback, before implementing custom diagnostics. The audit found one Python-dependent feature and two remote call sites. Preserve functionality, kernel exclusivity, nonblocking/no-controlling-terminal I/O, exact byte comparison, settings restoration and console protection; removing a gate or hiding UART is not completion. Historical version 1 metadata remains readable but never selects a live Python path. Host development, optional local GNOME Genie management and test harness runtimes are outside target removal.

## What Changes

- Add read-only scalar measurements through reviewed hwmon, IIO, thermal and explicitly declared driver ABI descriptors. Resolve physical parent and channel identity before reading; preserve driver ownership and block conflicting raw access.
- Add application-owned, versioned installed-command recipes with typed arguments, supported executable versions, deterministic parsers, documented effects, bounded execution and confirmed cancellation. Profiles reference reviewed recipe IDs; they cannot install recipes or supply executable code.
- Share connected-device/resource selection, preparation, sequences, verdicts and simulation with existing adapters. Show missing capabilities, identity ambiguity, unknown conversion and freshness limitations before execution.
- Introduce version 2 profile, inventory and report contracts for typed measurements, criteria and reproducible provenance. Continue reading and running supported version 1 profiles and reading version 1 reports without silently rewriting their meaning. Older peers reject version 2 with an actionable compatibility message.
- Include raw and converted observations, units, explicit range boundaries, source/observation timing, conversion provenance, parser/recipe identity and process completion evidence in structured and readable reports. Validate imported conversion semantics against an application-owned current/historical contract catalog.
- Persist a minimal local recovery ledger before live test dispatch so restart cannot clear uncertain work. Store no credentials, profile contents, sensor values or transcripts; report persistence remains explicit-export only.
- Make target Python optional: new driver readings and command recipes use reviewed fixed POSIX-shell execution over the existing SSH transport, selected by independently verified capabilities. No Python, Python-2-only and differing Python-3 targets are first-delivery cases. Missing actual read/supervision/recipe capabilities block only affected methods, without runtime installation or helper upload.
- Keep parsers, exact arithmetic and JSON handling in the application backend; do not require target JSON tooling, Bash, GNU utilities, a particular CPU ABI or a writable executable staging directory. Add explicit BusyBox/tool-variant and missing-capability fixtures. Existing UART loopback is included in prerequisite removal and must receive a verified Python-free native-utility access method; missing genuine serial capabilities remain explicit without hiding the feature.
- Defer arbitrary scripts, user-installed executable plugins, raw sensor protocols, writes/control, setup/restoration recipes, calibration writes, IIO buffer/trigger configuration, station batches and unattended long-duration testing. Existing LED/UART write behavior remains governed by its existing contracts.

## Interface coverage and extension boundary

Driver access and command recipes SHALL share interface-neutral resource, typed observation, criteria and evidence contracts. Physical bus/domain classification SHALL NOT select an arbitrary protocol or establish adapter support. The broad goal is reusable diagnostics across interfaces; the first delivery implements the explicit observations below, while other rows retain honest unsupported states.

| Interface/domain | Existing test support | Initial new read-only support | Reviewed developer extension | Deferred control or stimulus |
| --- | --- | --- | --- | --- |
| I2C sensors | Approved unbound byte identity read; bound/busy raw access blocked | Supported hwmon/IIO sensor channels through their driver | Driver ABI descriptor or constrained recipe for a documented device | Raw sensor protocols, register writes, scans, force/rebind |
| SPI | Runtime/DT inventory; no functional adapter | Supported SPI-attached sensors exposed through reviewed hwmon/IIO ABIs | Driver descriptor or known utility recipe; domain alone creates no test | spidev transfers, chip-select/mode changes, actuator commands |
| GPIO | Inventory only; LED-class pattern is a separate existing adapter | No generic GPIO line sampling in this increment | A reviewed non-invasive driver line/state query after ownership/side-effect qualification | Line requests that change direction/configuration, output toggles, pinmux |
| UART | Fixture loopback with settings restoration and console protection | Existing loopback retained; no new generic passive UART test | Reviewed driver statistics or installed status recipe where available | New protocols, transmissions, settings/control recipes |
| Network | Interface inventory; no functional adapter | Driver carrier boolean and reviewed ip receive-packet counter snapshot | Registered driver counter/status descriptor or version-qualified command recipe | Traffic generation, throughput tests, link/route/radio configuration |
| Storage | No board-test adapter | Reviewed block.capacity numeric snapshot; exact declared sectors-to-bytes conversion | Registered block/driver statistics or documented read-only utility recipe | Mount/format/discard, benchmarks, writes, SMART/NVMe self-test/control |
| USB | No generic USB adapter; supported tty resources can use existing UART adapter | Reviewed usb.link-speed snapshot with topology/device identity | Registered USB/class-driver descriptor or constrained known utility recipe | Reset, authorization, rebind, raw control transfers, traffic/loopback |
| Other: thermal, platform, PCIe, HDMI, watchdog | Classification varies; LED functional support already exists | Thermal scalar temperatures; other initial support only through explicit registered ABI descriptors | Same typed registry for either driver-backed or command-backed diagnostics | Watchdog arming, display modes, PCI config writes, calibration and actuator control |

Snapshots assess only their declared property: storage capacity is not media integrity; USB connection speed is not measured throughput; carrier/counters are not traffic tests. Neither an extensible registry nor discovery claims that every interface has been implemented or physically qualified.

## Capabilities

### New Capabilities

- `custom-diagnostic-definitions`: Reviewed read-only access definitions and installed-command recipe registry with typed inputs, declared semantics and bounded deterministic outputs.

### Modified Capabilities

- `board-test-profiles`: Versioned typed measurement intent, shared resource/channel mapping, units, ranges, freshness and visible prerequisites.
- `board-test-execution`: Driver-backed and recipe-backed observations, conflict handling, bounded sampling/cancellation and measurement-based verdicts.
- `board-test-reports`: Version 2 measurement provenance and compatibility with validated historical version 1 evidence.

## Impact

Target shared/testing contracts, inventory/profile validation, runner, simulation and reports; backend/testing discovery, adapters and executor; backend/ssh/session coordination; desktop/gateway testing APIs; and the guided/direct JSON Tests UI. Extend nearby testing, SSH, report and UI fixtures and documentation. No mandatory package installation, privilege escalation or persistent target helper is introduced; unsupported target prerequisites remain Blocked.

This is a planning-only change based on local source ba1bf5168b9aaf229bb620b6f625c75dd730b0ab. Preserve the ongoing edits in tests/ui/live.spec.ts, tests/ui/resources.spec.ts and tests/ui/fixtures/history-worker.ts. No new environment installation or physical-device operation is authorized by this proposal.
