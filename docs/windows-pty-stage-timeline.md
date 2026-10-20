# Windows PTY stage timeline and late-completion guard

Run `39382944852`, attempt 1, used commit `7539832daa91ad117d01fbe6af97ddb94dfb8e28`. It failed the
original 25-second whole-stage deadline. Owned observation preparation, live approval and both raw
observation jobs were skipped. The retained artifact digest is
`e01d58b976136c66ae8f53f91479d0c453b627181a9e5b67dfd617f6b5720741`.

## What the retained records establish

The WinPS prerequisite contract passed 30/30. Compiler PID 4000 produced a durable, closed,
13,824-byte DLL. Fresh consumer PID 6656 loaded its exact bytes and type/ABI on PowerShell 7.6.6 and
.NET 10.0.12, then executed the original winpty/Bash startup and closure contract.

| Interval in child `performance` clock     | Elapsed ms | Scope                                              |
| ----------------------------------------- | ---------: | -------------------------------------------------- |
| Fixture preparation complete → actor open |   197.6576 | Gateway, journal and connection setup              |
| Actor open → readiness armed              |    40.4572 | Actor preparation and arming                       |
| Readiness armed → shell callback          |    23.2465 | Guard, spawn and callback                          |
| Shell callback → first stdout             |  1163.1032 | Fresh runtime/native startup                       |
| First stdout → ready match                |   983.8498 | Remaining output, journal processing and polling   |
| Ready match → actor open return           |    21.0052 | Ready outcome persistence                          |
| Actor open return → shell stop/drain      | 11342.1629 | Eight interactions, assertions and finish          |
| Shell stop/drain → cleanup entry          |   450.8925 | Helper closure and readback/assertions             |
| Cleanup entry → known fixture closure     |    15.6617 | Fixture/server/journal closure and journal removal |

Readiness took 2170.1995 ms of its unchanged 7000 ms window. The retained suffix, UTF-8, ANSI,
pending-byte and quiet conditions passed. The compiler call took 4777.4043 ms in its own stopwatch
clock. Its self-process CPU sampling interval was 1515.625 ms and includes other work; neither
number isolates compiler CPU cost. There are 36 joined process-query receipts from the stage and 37
from its parent. Their execution, queue and CPU durations were not retained.

Parent stage admission was 659516 ms with deadline 684516 ms in the parent hrtime clock. The
terminal startup-join snapshot at 685813 ms is 1297 ms after that deadline. No retained clock-pair
anchor converts child performance timestamps into remaining parent budget. Child cleanup at
23698.6868 ms therefore does not establish closure within the whole-stage cutoff.

Recorded sequences include parent cancellation request 158, watchdog 159, fixture cleanup 164/167,
assertions return 168, cancellation ACK 169, failed stage final 176, positive stage closure 183 and
failed pilot result 186. Persistence order does not identify which process timer fired first.
`primary:null` in fixture cleanup does not erase cancellation. Stage code checks its aborted signal
after the fixture returns and preserves failure. The terminal trace reports 33 omitted fine events;
raw streams, the parseable summary and explicit closure records remain available.

## Separate deterministic ordering defect

A controlled probe of the exact production `waitPilotStage` advanced its injected monotonic clock to
one millisecond after the original cutoff, withheld timer delivery, then resolved the owned
pipe-close promise. The original helper returned success. This reproduces a timer-delivery race; it
does not explain the retained Windows run, which correctly failed.

The parent wait now checks its original monotonic cutoff on entry and after the close race resolves.
Equality is expired. It latches the first cancellation before cancellation transport or watchdog
reporting, so competing or reentrant causes cannot replace it. Reporting/transport faults enter the
existing hold path as secondary errors. Already-owned pipe closure and identity/query/log joins
remain required after failure; a missing close still reaches the original bounded cleanup wait.

The change does not move compilation, restart clocks, weaken assertions, change fresh runtime or
readiness behavior, or extend any deadline. It establishes deadline-verdict ordering, not a latency
repair. It does not add phase-level hard-clock guards throughout the child fixture or qualify its
work as complete within 25 seconds.

## Remaining diagnostic need

The 11.34-second command interval lacks per-command, journal flush, evidence queue/ACK and query
start/end timing. There is no supported exclusive bottleneck or demonstrated redundant wait to
remove. A future instrumentation candidate should retain bounded paired clocks, phase entry/exit,
first cancellation origin and aggregate owned-wait costs. It must reserve complete wire, pending,
ordinary and terminal evidence costs inside the existing limits, without per-poll logging or new
process queries. Local accounting and independent review must precede any separately authorized
fresh hosted diagnostic. No rerun or replacement is authorized by this report.

Helper, descendant, pipe, query and log closure are retained. Final marker/private-root release is
not independently proved: the pilot result precedes `owner.release`. All five historical outcomes
remain release-unproved. No live challenge approval, memory qualification or product release is
established.
