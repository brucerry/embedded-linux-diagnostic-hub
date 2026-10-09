# Initial test fixtures

These checks act with the connected SSH user's existing permissions. The application never installs
helpers, uses sudo, unbinds drivers or forces busy I2C access. Confirm board-specific limits and
exclusive use before running. Tool presence and a successful command do not prove a physical pass.

## LED pattern

Use a Linux LED class resource with readable brightness/trigger/maximum and writable brightness and
trigger. Declare the desired pattern and brightness for this board. An observer must see the LED.
The adapter captures original brightness and active trigger, temporarily selects `none`, executes
the finite pattern, restores settings and checks restoration. A restored active trigger owns later
brightness changes under its driver; the adapter checks that trigger rather than demanding a frozen
brightness value. A triggerless/nonconforming class resource is blocked by capture failure.

After verified execution/restoration, **Yes, expected pattern** produces Pass, **No, different
behavior** produces Fail, and **Not observed** produces Inconclusive. Execution alone remains
Inconclusive. Failed restoration prevents a pass and blocks further tests until reconnection and
device-state review.

## UART loopback

Use an approved external TX/RX fixture on a dedicated non-console UART. Confirm voltage levels,
pinout, baud support and board isolation from the design documents. Record the fixture identifier
when available. The connected device must already have Python 3 with `termios`, `fcntl`, `select`
and `TIOCEXCL`; a supported timeout supervisor is also required. Missing helpers are reported and
are not installed.

The helper opens the exact resolved device with exclusive access, captures serial settings, sets raw
8N1 without flow control, flushes pending data, performs bounded transmit/receive and compares exact
bytes. It restores captured termios settings, releases exclusive access and closes its handle on
completion or interruption. Active kernel console ports, detected users and access failures are
blocked. Exclusive opening cannot evict an already-open process; operator preparation remains
required. A mismatch or timeout is Fail only with verified cleanup; uncertain execution/restoration
is Inconclusive.

## I2C identity

Approve the exact board resource, 7-bit address and byte identity register from the component/board
documentation. A register that changes state when read is unsuitable without explicit design
approval. The device must already have `i2cget` and a supported timeout supervisor, with accessible
`/dev/i2c-N`. Runtime sysfs enumeration resolves the address and topology; no blind scan occurs.

The adapter executes `i2cget -y BUS ADDRESS REGISTER b`, compares the byte under the profile mask
and records the observation. This byte-register transaction includes selecting the approved register
address; it is not a general-purpose write adapter. Driver-owned/busy resources remain blocked.
There is no `-f`, `i2cset`, bus probing or driver rebinding. A matching observation passes; a
successful command returning the wrong identity fails.

## Qualification boundary

Software fixtures verify command construction, UART byte comparison, restoration, cancellation and
evidence rules. They do not verify optical output, pin routing, electrical behavior or physical I2C
components. A board owner must qualify actual boards and fixtures before treating a profile as a
manufacturing test. The initial workspace has no fixture orchestration, station database or batch
production records.
