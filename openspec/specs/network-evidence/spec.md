# network-evidence Specification

## Purpose

Collect and retain bounded, fixed read-only network evidence across desktop and gateway editions
with per-command provenance, honest failures and compatibility with existing reports.

## Requirements

### Requirement: Fixed observational commands and safe selectors

Network collection SHALL use a fixed allowlisted read-only catalogue for iw
discovery/info/link/station/survey/PHY/regulatory/power-save reads, ip link/address/route/neighbor
dumps, existing sysfs/procfs/legacy reads and optional default ethtool interface queries. Only
validated backend-discovered selectors SHALL become arguments. User/SSID strings SHALL NOT become
shell programs. No arbitrary exec endpoint, scan, setter, network traffic test, installation or
privilege escalation SHALL be introduced.

#### Scenario: Hostile selector or label

- **WHEN** discovery yields shell metacharacters, control characters or a device string resembling a
  command
- **THEN** supported names are passed as one safe argument or skipped with a reason, and display
  labels never execute

### Requirement: Independent command attribution and partial failure

Every executed additional command SHALL retain exact command, scope, stdout/stderr, exit/status,
duration, timestamp and truncation with a unique evidence identity. Valid primary evidence SHALL
remain available alongside optional errors; installed-tool runtime/permission failures SHALL remain
failures. Not-run operations SHALL record an omission reason without fabricated execution exits or
timestamps.

#### Scenario: Optional survey denied

- **WHEN** wireless discovery/link succeeds but survey access is denied
- **THEN** current connection fields remain readable and the survey shows its own denied result, raw
  stderr and provenance

#### Scenario: Primary command fails

- **WHEN** an installed selected primary command fails
- **THEN** its real failure remains recorded and is not relabeled successful because a fallback tool
  also exists

### Requirement: Capability negotiation and honest unavailable states

Collection SHALL detect supported commands/formats at runtime. JSON/text fallback SHALL be permitted
for verified unsupported options/format or absent tools, preserving failed negotiation evidence and
selected-source scope. Permission/runtime failures SHALL NOT trigger success-masking fallback.
Presentation SHALL distinguish unsupported, missing tool, denied, not reported/not collected/not
applicable, timed out, disconnected, cached, truncated/limited and parse warnings; unclassified
errors SHALL remain command failed.

#### Scenario: BusyBox lacks JSON

- **WHEN** an installed ip variant rejects JSON but its read-only text form works
- **THEN** both attempts are attributable and the readable result identifies its negotiated format
  and any reduced scope

#### Scenario: Missing versus zero

- **WHEN** a numeric field is absent or a valid zero is reported
- **THEN** absence remains a reasoned unknown and zero remains the actual value

### Requirement: Bounded and cancellable collection

Network probe groups SHALL complete or time out within twelve seconds, including follow-ups, and
share a global maximum of three concurrent SSH commands. Combined primary/additional/cached output
SHALL be at most 256 KiB per probe, with bounded section/discovery/parser counts and explicit
omissions. Collection SHALL NOT overlap live refresh. Disconnect/generation replacement SHALL cancel
owned work and prevent stale cache/results from reaching a replacement.

#### Scenario: Large topology or slow commands

- **WHEN** optional commands exceed time, output or discovery budgets
- **THEN** valid collected state remains available, excess work is cancelled/omitted visibly and no
  uncontrolled fan-out or next overlapping collection occurs

### Requirement: Capability caching with original provenance

Cached PHY capability evidence SHALL retain its original source time and be distinguishable from
live state/regulatory observations. Reconnect/reset/topology changes SHALL invalidate the applicable
cache; explicit Refresh capabilities SHALL use the same bounded fixed catalogue on desktop and
gateway.

#### Scenario: Live refresh after cached capabilities

- **WHEN** current interface state refreshes while the PHY evidence is cached
- **THEN** current observations receive new source times and capability age remains truthful rather
  than being retimestamped as live

### Requirement: Compatible and validated report evidence

Existing network probe IDs and schema-1 report imports SHALL remain supported. Additional command
evidence SHALL be optional, versioned, nonrecursive and validated for identity/known
operations/scope, exit/status agreement, timestamps, commands and aggregate bounds. Reports without
additional evidence SHALL display only supported legacy interpretation and mark new fields not
collected. Imported parsed objects SHALL NOT be trusted as command evidence. Serial transcripts
SHALL remain excluded.

#### Scenario: Old report

- **WHEN** a valid old schema-1 report without network sections is imported
- **THEN** legacy fields remain usable, no new command runs and new fields show not collected rather
  than fabricated values

#### Scenario: Malformed extension or round trip

- **WHEN** additional evidence is duplicated, inconsistent, oversized or validly exported/imported
- **THEN** malformed evidence is rejected and valid evidence preserves raw
  commands/output/failures/cache timestamps across the round trip
