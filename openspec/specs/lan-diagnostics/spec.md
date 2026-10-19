# lan-diagnostics Specification

## Purpose

Present readable Linux link, address, routing, neighbor and counter evidence with honest
distinctions between physical interfaces, virtual topology and observed operating state.

## Requirements

### Requirement: Summary-first links and topology

LAN / Ethernet SHALL offer a default Summary with stable interface selection,
interface/index/kind/MAC, administrative UP, carrier/LOWER_UP, operstate and MTU. Physical,
loopback, wireless, virtual and stacked interfaces SHALL be labeled using reported evidence and
retain lower-link/master relationships. UNKNOWN or DOWN SHALL NOT automatically become a
hardware-fault verdict. Existing raw/table/tree and safely representable counter graphs SHALL remain
accessible.

#### Scenario: Admin up without carrier

- **WHEN** an interface is administratively enabled but has no carrier
- **THEN** admin state, carrier and operstate remain separate and no successful connectivity or
  failed hardware assertion is invented

#### Scenario: Virtual or unknown link

- **WHEN** a bridge/VLAN/veth/tunnel or UNKNOWN-state interface is collected
- **THEN** reported kind/topology stays visible without inferring physical Ethernet or an outage
  from its name/state

### Requirement: Complete reported addresses and routing

Address detail SHALL retain all reported IPv4/IPv6 addresses, prefixes, scope, labels,
peer/broadcast, lifetime and DAD/deprecated flags. Route detail SHALL retain
family/table/type/destination/gateway/device/source/metric/protocol/scope and multipath
nexthops/weights where reported. Multiple defaults SHALL remain distinct. Dynamic address flags
SHALL NOT establish DHCP, and routes SHALL NOT establish reachability.

#### Scenario: Multiple address and default-route records

- **WHEN** interfaces have multiple addresses, routing tables or weighted/default nexthops
- **THEN** records remain distinct by family/table/interface rather than being collapsed to one
  address or gateway

#### Scenario: Reduced legacy route collection

- **WHEN** only a simpler IPv4/main-table fallback is available
- **THEN** the actual reduced scope is labeled and missing IPv6/other-table detail remains explicit

### Requirement: Neighbor and cumulative counter semantics

Neighbors SHALL retain destination/family/device/link-layer address and reported NUD states/flags.
STALE or absent entries SHALL NOT be interpreted as an outage. RX/TX bytes/packets/errors/drops and
detailed supplied counters SHALL be labeled cumulative, with exact integer values retained. Unsafe
numeric conversions SHALL NOT create graph samples.

#### Scenario: Stale neighbor and large counters

- **WHEN** a STALE neighbor or a counter above safe floating-point integer precision is reported
- **THEN** the cache state and exact counter are readable without an outage verdict or rounded
  plotted sample

### Requirement: Optional physical observations

Current Ethernet speed, duplex, autonegotiation and link-detected data SHALL be displayed only when
reported by an appropriate read-only source; supported/advertised/partner modes SHALL stay separate
from current negotiation. Missing/unsupported/denied physical details SHALL NOT erase usable
ip/sysfs evidence. No cable/self-test or setting change SHALL run.

#### Scenario: ethtool unavailable or restricted

- **WHEN** the optional physical-detail tool is absent, unsupported or denied
- **THEN** those fields show the reason and collected link/address/counter evidence remains usable

### Requirement: Honest snapshots and progressive details

Address/route/neighbor/counter details SHALL be progressively accessible from the link summary,
preserve focus through refresh, and keep command-level raw evidence/time/exit/truncation visible.
Only matching interface identities within the same snapshot/session SHALL be joined; conflicting
observations SHALL preserve source context. Historical/imported summaries SHALL remain labeled
historical and SHALL NOT execute queries.

#### Scenario: Interface changes during collection

- **WHEN** an interface disappears, changes identity or yields conflicting observations during a
  collection
- **THEN** the summary preserves partial/source-specific evidence without mixing it into another
  interface or claiming an atomic measurement
