# Board profiles

A profile is declarative JSON, schema version 1. **Discover board** automatically creates a draft
for the connected device. You can also use the
[validated simulation example](examples/simulation-board-profile.json). The example deliberately
matches only the simulated engineering board; adapt identity, mappings, fixtures and acceptance
criteria for your actual design.

The guided editor exposes identity, mappings and adapter parameters. The advanced JSON editor also
supports ordered saved sequences and stop-on-failure policy. Editing invalidates the previous
review. Preparation resolves the profile against the discovered inventory, and starting refreshes
that inventory again. A board reboot, changed topology, permissions or tools requires fresh review.

## Fields

| Field                                     | Meaning                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`, `revision`, `name`, `boardRevision` | Project-owned identity and declared design revision.                                   |
| `match.model`, `match.compatible`         | Observed model and compatible identity constraints.                                    |
| `match.manual`                            | Explicitly allow manual mapping when automatic board identity is unavailable.          |
| `resources[]`                             | Stable logical IDs, domains and selectors.                                             |
| `tests[]`                                 | Adapter, logical resource, required status, fixture, expected behavior and parameters. |
| `sequences[]`                             | Ordered test IDs and `stopOnFailure`. Individual tests need no sequence.               |

Selectors can combine `ofNode`, `controller`, `name`, `identity`, `address` and `path`. Every
supplied field must match and exactly one runtime resource must resolve. Prefer device-tree identity
and topology over volatile bus numbering. A sensor at the same DT node/address can move from I2C bus
4 to bus 27 without changing its logical mapping. Runtime-path mappings are useful for non-DT
devices but need project-specific review. Disabled or unbound DT nodes are evidence, not usable
resources. Raw binary properties, aliases and phandle/provider-cell data are retained without
guessing unknown bindings. Inspect **Observed resources and device-tree evidence** for provenance.

## Initial adapter parameters

| Adapter         | Parameters                      | Bounds                                                                            |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `led.pattern`   | `cycles`, `level`, `intervalMs` | 1-20 cycles, 0-65535 brightness within observed maximum, 100-1000 ms.             |
| `uart.loopback` | `baud`, `payload`, `timeoutMs`  | Listed supported baud, nonempty UTF-8 payload up to 4096 characters, 100-5000 ms. |
| `i2c.identity`  | `register`, `expected`, `mask`  | Byte values; mask 1-255, approved 7-bit address 0x03-0x77.                        |

Supported UART baud rates: 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800,
921600 and 1000000. A listed rate still needs device support. The adapter uses raw 8N1, no flow
control, and compares received UTF-8 bytes exactly. I2C acceptance is
`(observed & mask) === (expected & mask)` after an approved byte-register read.

`null` parameters are valid draft placeholders but cannot run. Empty fixture/expected fields,
missing tools, inaccessible or conflicting resources, active console UARTs, ambiguous selectors,
board mismatches and incomplete discovery block the affected operation. Drafts never infer an I2C
identity register, safe brightness or physical fixture from the device tree.

Profiles are capped at 128 KiB, 64 logical resources, 64 tests and 16 sequences. Unknown fields,
arbitrary shell commands, credential fields, unsupported adapters, unsafe parameters and invalid
references are rejected. A canonical SHA-256 digest accompanies every run so saved evidence records
the exact profile used. Keep project profiles under version control; the application does not save
private project settings automatically.
