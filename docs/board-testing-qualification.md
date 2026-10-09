# Board testing software qualification

The initial implementation is qualified as a software workflow. No physical embedded board, LED,
UART cable/loopback fixture or I2C identity component was available for this qualification. Do not
interpret simulated or loopback-server results as electrical/manufacturing validation.

## Reproducible checks

Use the project's documented Node.js 24 environment and installed dependencies:

```sh
npm run verify
npx playwright test --timeout=60000 --workers=1 --output=test-results/ui
npx playwright test tests/ui/testing.spec.ts tests/ui/device-clock.spec.ts
npm run test:board-desktop
npm run test:board-documents
npm run test:desktop
npm run build:web
npm run build:gateway
npm run test:portability -- --workers=1 --output=test-results/portability
```

`tests/testing*.test.ts` covers strict profiles, SHA-256 identity, binary DT data, aliases/provider
references, mux provenance, incomplete captures, topology resolution, malformed imports, forged
verdicts/readiness, unsupported gateway routes, response/output budgets, UTF-8 chunking, deadlines,
operator ownership, serial stop/continue policy, cancellation and unverified cleanup. SSH fixtures
exercise the actual desktop session and authenticated gateway routes with separate PTY, clock,
collection and typed execution channels. Test fixture responses do not claim hardware behavior.

Browser tests cover disconnected simulation, preparation, invalidated review, navigation during a
run, all report controls, historical import, cancellation, narrow layouts, operator review and
five-second collection/terminal coordination. Native smoke verifies trusted IPC rejection,
backend-owned JSON/HTML/PDF, malformed supplied reports, cancelled save dialogs and session reset.

Run suites sequentially on this Windows host. Separate output folders prevent one Playwright runner
from clearing another runner's traces; a single worker also keeps clipboard/animation checks stable
under load.

Document qualification generates pending-feedback and mixed-verdict documents with long metadata,
Unicode/markup and multipage raw evidence. Native and website print versions use identical canonical
content. Render all pages with Poppler, inspect pagination and text, and compare extracted content
to JSON. Native document smoke checks hidden renderer isolation, concurrent-export rejection,
failure/30-second-timeout cleanup and recovery. Generated samples live under ignored
`validation/board-tests/`; they are disposable qualification output.

## Optional real Linux SSH checks

`tests/testing-linux-qualification.ts` uses a pinned, dedicated local qualification server specified
by `HUB_TEST_LINUX_CONNECTION` (or existing private `.codex/linux-ssh/connection.json`). It performs
read-only discovery and an independent clock query. The LED script runs against a unique temporary
directory, with only the LED trigger's kernel read formatting emulated, to check normal, failed and
cancelled Linux shell restoration. The directory is removed afterward. This path never substitutes a
public filesystem-root option into production requests.

The available Alpine WSL2 server returned 14 runtime resources and no device-tree nodes, detected a
supported timeout tool, and correctly reported Python 3 and `i2cget` unavailable. No helpers were
installed. With `HUB_TEST_PYTHON` pointing to an existing local Python, the installed UART helper
logic can also run against software modules for exact bytes, mismatch, cancellation, busy access,
termios restoration and failed restoration. This does not qualify actual Linux UART drivers.

## Resource limits and delivery

Discovery is bounded to 2 MiB, selected DT properties to 8192 bytes each, 4096 property records and
1024 runtime resources. Profiles use at most 64 resources/tests and 16 sequences. Each adapter job
has a finite remote timeout, each case retains at most 64 KiB of output, a run has a ten-minute and
4 MiB evidence budget, and imported reports are capped at 16 MiB. Jobs execute serially on non-PTY
SSH channels. Unsupported bindings remain raw evidence rather than invented topology.

The workspace is additive: diagnostic report formats, terminal behavior outside active tests,
device-clock polling and shared connection security retain their existing meanings. No new package
dependency or production device installation is required. Clean newly generated test traces,
document images, temporary profiles and build caches after verification; retain dependencies, source
fixtures, private connection settings and useful builds.

## Validation recorded on Windows, 2026-10-09

Formatting, TypeScript, desktop/web/gateway builds, the native application regression smoke,
dedicated board-workspace smoke and PDF-renderer smoke passed. The full browser suite passed 90
tests with one POSIX Bash fixture skipped on Windows, using a 60-second test budget. An earlier
30-second run timed out in an existing process-graph test; that test also passed independently. The
additional lost-start-response case and the other three workspace cases passed after the final
recovery checks. Chromium, Firefox and WebKit passed the production nested-path checks, including
simulation, operator feedback and print preview.

The unit suite includes ten existing Linux-only checks skipped on this host. Dedicated Linux SSH
discovery and shell-restoration qualification passed, as did the five local Python helper fixtures.
Both pending and mixed reports produced 11-page native/website PDFs. All 44 pages were rendered and
visually inspected; text extraction verified matching document content, complete raw evidence and
the canonical profile digest. Native CJK glyph extraction has a different text ordering from the
browser PDF, so parity comparison accounts for that ordering as well as native page footers.

Late execution replies cannot modify sealed interrupted evidence. Reading run status while fresh
preparation is still pending reports that state instead of presenting an older completed run as
current work. Disconnect remains available to cancel preparation. Lost responses after execution
starts can recover either active or already-finished runs for operator review.

## Workspace refinement checks, 2026-10-09

The refined guided flow and direct JSON mode passed all nine dedicated browser cases. Coverage
includes complete/incomplete discovery gating, automatic fresh drafts, full-width section ordering,
JSON/form synchronization, correctable invalid fields, animated clipboard copy and Ctrl+C/Ctrl+V,
direct automatic discovery, all verdicts/cancellation, lost-response recovery, and preservation of a
previous report when a new start is rejected. Desktop/mobile screenshots were visually inspected.

The full isolated browser suite passed 96 tests with one existing Bash PTY check skipped on Windows.
The unit suite passed 102 tests with ten existing Linux-only skips (112 total), plus formatting and
TypeScript validation. Desktop/web builds and the native board-workspace IPC/export/reset smoke
passed. Production nested-path tests passed in Chromium, Firefox and WebKit, including direct JSON
execution, automatic unobserved LED completion and the copyable canonical report.

An earlier concurrent UI/portability run collided in the shared temporary output directory and timed
out in existing animation/connection checks under load. Both suites passed when rerun sequentially
with one worker and separate output folders. These software checks do not add physical board
qualification.

New screenshots, test traces and Vite caches were recycled after qualification. Dependencies,
private SSH connection settings, source fixtures and the runnable desktop/web builds were retained.

## Source isolation and navigation checks, 2026-10-10

The final workspace suite passed all 14 cases, including repeated Simulation toggles, separate JSON
and input modes, independent profiles/editor/readiness/selection/results, locking through execution
and operator review, rejected late discovery replies, reconnect isolation and reset of both sources.
An unconfirmed backend start retains the source lock until disconnection. Switching away from a
completed live run does not send a cancellation to its backend.

Across isolated browser suites, 102 cases passed with one existing POSIX Bash PTY case skipped on
Windows. Diagnostic report actions remain on Overview, Diagnostics and diagnostic categories and are
absent from Terminal and Tests; dedicated test-report controls remain available. The gateway
terminal test was updated to export diagnostics from Overview and return to the same shell. It
passed on the final code, along with the existing terminal, clock and session regressions.

Formatting and TypeScript passed. Unit tests passed 102 cases with ten existing Linux-only skips
(112 total). Desktop/web builds and both native regression and board-workspace smoke checks passed,
including source toggling, trusted IPC, canonical JSON/HTML/PDF exports and reset. Production nested
URL checks passed in Chromium, Firefox and WebKit. Desktop/mobile layouts were visually inspected.
These checks qualify software behavior; they do not add physical board qualification.

Generated screenshots, traces and Vite caches were sent to the Recycle Bin after verification.
Dependencies, private SSH connection settings, source fixtures and runnable builds were retained.
