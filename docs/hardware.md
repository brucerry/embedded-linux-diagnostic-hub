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
