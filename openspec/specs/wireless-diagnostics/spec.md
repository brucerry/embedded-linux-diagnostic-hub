# wireless-diagnostics Specification

## Purpose

Present readable wireless interface observations and independently sourced radio capabilities so
users can understand current state without guessing from raw iw trees.

## Requirements

### Requirement: Summary-first interface observations

WLAN / Wi-Fi SHALL offer a default Summary with stable interface selection, mode/type, identity/PHY,
administrative/carrier/operational state, association or mode-appropriate peer state, SSID/BSSID,
channel/frequency/width/centers, current transmit power and reported signal/noise. Details SHALL be
progressively available and raw/advanced evidence SHALL remain accessible. Values SHALL include
units and source timestamps; missing fields SHALL remain explicit.

#### Scenario: Managed connection

- **WHEN** collected evidence reports a managed interface and active link
- **THEN** its connection identity, current channel, signal and power are readable separately from
  capability data

#### Scenario: AP or nonclient mode

- **WHEN** an AP has no peers or an interface is monitor/mesh
- **THEN** the summary uses appropriate mode/peer semantics without inventing failed client
  association or SSID

### Requirement: Peer and survey measurement semantics

Per-peer signal/average/per-chain observations, rate descriptors, counters and reported timing/flags
SHALL stay attached to their interface/peer. Reported PHY rates SHALL NOT be represented as measured
throughput. Survey frequency/in-use/noise/time observations SHALL remain distinct. Current noise
SHALL require matching current frequency/in-use evidence; missing or ambiguous noise SHALL NOT be
zero. No signal-quality percentage or derived SNR/utilization SHALL be invented.

#### Scenario: Multiple survey frequencies

- **WHEN** survey noise exists on several frequencies or none matches the current channel
- **THEN** survey detail preserves each frequency and the current-noise card shows only a valid
  match or a not-reported state

#### Scenario: Peer bitrate descriptors

- **WHEN** peers report differing MCS/NSS/width/GI/HE/EHT descriptors
- **THEN** numeric rates and full descriptors stay separate by peer/link and are labeled as PHY
  rates

### Requirement: Separate PHY capabilities and regulatory channels

Supported modes/combinations, bands/channels, HT/VHT/HE/EHT capabilities and restrictions SHALL be
presented separately from current negotiation/state. Global/per-PHY regulatory scope,
disabled/no-IR/radar/DFS/CAC restrictions and maximum power SHALL be preserved where supplied.
Listed channels SHALL NOT be declared immediately usable. Cached capabilities SHALL show their
original time and offer explicit refresh.

#### Scenario: Capability exceeds current link

- **WHEN** a PHY supports a wider band/width or newer generation than the active interface uses
- **THEN** capability detail retains that support without relabeling the active link or claiming
  certification

#### Scenario: Restricted channel or cached PHY

- **WHEN** a channel has regulatory restrictions or capabilities were cached earlier
- **THEN** restrictions and cache age remain visible without treating maximum regulatory power as
  current transmit power

### Requirement: Version-tolerant and partial wireless interpretation

Interpretation SHALL accept independently recognized optional fields, repeated blocks, multiple
PHYs/interfaces and multi-link IDs without requiring a complete fixed iw text layout.
Unknown/unimplemented content SHALL remain raw with bounded parser warnings. Installed command
failures SHALL not be hidden by absent-tool fallbacks. iwinfo/procfs evidence SHALL be labeled with
reduced coverage and unverified units SHALL stay raw.

#### Scenario: Changed or partial iw output

- **WHEN** fields are reordered, absent or unknown, including multiple MLO link blocks
- **THEN** independently recognized fields remain readable, separate links stay separate and raw
  evidence/warnings remain available

#### Scenario: Fallback evidence

- **WHEN** iw is absent and procfs or iwinfo evidence is available
- **THEN** reduced fields are displayed without invented dBm values, capabilities or
  hardware-absence conclusions

### Requirement: Observational refresh only

Ordinary/manual/live refresh and capability refresh SHALL execute bounded observational queries
only. They SHALL NOT trigger RF scans, associate/disconnect, set power/channel/mode or install
tools. Active scanning and traffic-generating operations SHALL remain outside this release. All
displayed device strings SHALL be rendered as text.

#### Scenario: Refresh a WLAN summary

- **WHEN** the user refreshes current or capability evidence
- **THEN** no scan or setter executes, permission/unsupported fields remain explicit and SSID markup
  cannot execute
