# Planned capability fixtures

These are reviewable input/expected-outcome cases, not implemented tests or executed qualification. review-fixtures.json is the machine-readable catalog. Positive shell/group support needs controlled real installed-tool process tests as well as protocol fixtures; synthetic architecture metadata does not qualify physical ARM/MIPS boards. No target operation or runtime installation is authorized by this document.

| ID | Runtime / target | Capability case | Expected outcome |
| --- | --- | --- | --- |
| R01 | none; ARM32 / BusyBox ash | qualified driver-read primitives; no ip | driver available; ip recipe Blocked; zero Python invocations |
| R02 | Python 2 only; MIPS32 / BusyBox ash | same qualified primitives | new driver path available; Python 2 not invoked/upgraded |
| R03 | Python 3.8; x86-64 / dash | qualified driver and ip recipe primitives | same new paths; no target Python invocation |
| R04 | Python 3.11 without optional modules; ARM64 / ash | qualified driver primitives | driver available regardless of Python module set |
| R05 | Python 3.14 or unexpected python alias; ARM64 / POSIX sh | qualified new measurement primitives | no interpreter selection by name/version; same results |
| T01 | none; BusyBox tool variant A | timeout lacks GNU -k; qualified anchored shell watchdog available | use qualified watchdog syntax; never send guessed GNU flags |
| T02 | Python 2 only; BusyBox minimal variant B | no qualified remote deadline/group ownership primitive | affected new operation Blocked even though shell exists |
| T03 | none; BusyBox head/readlink/stat variant C | byte limit or descriptor-follow semantics fail probe; no qualified equivalent | driver read Blocked with exact missing capability |
| T04 | none; BusyBox / restricted proc | fd metadata or current owned-process visibility unavailable | Block affected read/lifecycle; retain unresolved recovery |
| T05 | none; read-only root; noexec /tmp | installed shell/read/group tools qualified; no staging directory | driver path available; zero target file upload/write/remount |
| C01 | none; BusyBox ip variant | driver primitives qualified; ip -j or required JSON field unsupported | driver available; ip recipe Blocked; no text-parser fallback |
| C02 | Python 2 only; native ip / missing sha256sum or fd execution | driver primitives qualified; executable pin/fingerprint unavailable | driver available; command recipe Blocked |
| C03 | none; native utility path replacement | pinned executable object verified then pathname replaced | invoke only opened object; record/reject observed identity changes |
| L01 | none; SSH server ignores signal request | qualified independent deadline/control profile present or absent | qualified profile records bounded cancellation; absent profile Blocked |
| L02 | none; slow/uninterruptible sysfs read | ownership acknowledged; read deadline or completion proof lost | Inconclusive; durable quarantine; SSH close never proves stop |
| L03 | none; crash after intent / before GO | ownership handshake incomplete or durable commit fails | no GO; zero hardware acquisition; startup recovery explicit |
| L04 | Python 2 only; crash after GO / PID reused | durable old boot/start/group nonce; current PID identity differs | no stale-PID kill; affected tests Blocked until verified recovery |
| L05 | none; ledger missing/corrupt; proc restricted | incomplete reconciliation | no reset/restart bypass; Blocked with recovery reason |
| S01 | none; hostile positional resource data | quote/dollar/substitution/newline/NUL/option-shaped strings | reject invalid grammar; accepted literals never enter wrapper source |
| S02 | none; framed byte evidence | overlong data, duplicate frame, malformed hex, nonce mismatch | reject/inconclusive; no successful number extracted from truncation |
| D01 | all runtime variants; 32-bit and big-endian metadata profiles | large integer > 2^53; signed/raw/processed conversions; boolean carrier | backend exact comparisons; no target-width arithmetic or cross-type coercion |
| D02 | none; SPI/I2C hwmon, thermal, network, block, USB | same typed resource/read protocol with explicit registered descriptors | interface-neutral criteria/provenance; no raw bus/media/control operations |
| G01 | Python 2 only / none; legacy UART resource | new read primitives qualified but python3 absent | new measurements available; legacy UART separately Blocked by its existing prerequisite |
