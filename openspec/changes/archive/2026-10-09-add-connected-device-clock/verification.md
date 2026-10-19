# Verification

## Implemented behavior

The shared header renders green pixel clock artwork and device-reported `YYYY-MM-DD`, `HH:mm`,
timezone abbreviation and UTC offset across pages. One clock schedule runs independently of live
diagnostics. Connection/reconnection, completed reset, visibility/focus restoration, and observed
reboot evidence refresh it. App/page reload clears the old session and reads fresh time after
authentication. Availability, unknown zone, and stale values remain explicit.

The native bridge and authenticated gateway use a separate non-PTY SSH exec channel, bounded to five
seconds and 8 KiB with one query in flight. Query failure/cancellation preserves healthy SSH; clock
output remains outside terminal history and reports. Generation/reset ownership rejects late
results. No device packages, timezone settings, clock configuration, report schema, diagnostic probe
inventory, README, or dependencies were changed.

## Checks on this PC

- `npm run verify`: formatting and type checking passed; **77 unit tests passed**, zero failed, **10
  platform-specific tests skipped** on Windows.
- `npm run build`, `npm run build:web`, `npm run build:gateway`: passed under Node 24.
- Native desktop smoke: passed with clock IPC access, trusted-frame rejection, connection/update
  guards, header display, and terminal/report behavior.
- Full browser regression: 81 passed and one opt-in Bash PTY case skipped on the initial run. Three
  cases failed during trace cleanup because concurrent Playwright suites shared the results
  directory; all three passed on rerun with separate output paths. No remaining functional failure.
- Clock UI suite: **8 passed**, including minute polling with diagnostics paused or collecting every
  five seconds, coalesced requests, unavailable/stale recovery, visibility resume, both reload
  cases, reset races, device replacement, boot/uptime changes, unknown zone and older gateways. A
  final focused run passed both strengthened resume/reset/reboot tests.
- Browser timezone was explicitly set to America/Los_Angeles while the device fixture reported
  UTC+08:00. Desktop/tablet/mobile layouts down to 320 px passed overflow checks. Header screenshots
  were reviewed on desktop and mobile, including long timezone labels.
- Production nested-path portability: **3 passed**, Chromium, Firefox and WebKit, including mobile
  header and unavailable optional routes on older gateways. The test bridges a mocked HTTPS origin
  to the real loopback SSH fixture so production CSP remains unchanged; it does not qualify real
  HTTPS certificates/proxy deployment.
- `git diff --check` and strict OpenSpec validation passed. Planning and private qualification
  evidence remain excluded locally through `.git/info/exclude`.

## Actual Linux SSH qualification

The existing isolated WSL Linux environment was reused without adding packages. Actual clock reads
passed through **OpenSSH + Bash, OpenSSH + BusyBox ash, Dropbear + Bash, and Dropbear + BusyBox
ash**. Every combination matched an independent read-only SSH reference, returned the actual UTC
zone and offset, added zero bytes to an idle PTY, and coexisted with all 36 diagnostics and explicit
user shell commands. A shell-local timezone override remained isolated from the clock query.

The Linux VM supplies BusyBox `date`. Actual GNU coreutils 8.32 `date` output was also parsed using
the already installed Git tools on Windows. GNU `date` is not installed in the Linux VM, so a GNU
Linux SSH qualification is not claimed. Fixture coverage exercises GNU-formatted responses. Physical
embedded hardware, app packaging/publication, and production gateway deployment were outside this
implementation run.

## Display refinements

- Seven-segment device time retains accessible HH:mm text; pixel hour/minute hands use the same
  authoritative sample and retain the last reading when stale.
- Disconnect device uses an orange background and lighter hover color; Connect device retains its
  existing blue styling.
- Clock UI suite: **9 passed**. The strengthened digit test then passed separately, covering every
  digit, hand updates, stale preservation, disconnection, and button/hover colors.
- Desktop and web builds, type checking, formatting, strict OpenSpec validation, and
  `git diff --check` passed. Desktop/mobile screenshots reviewed; responsive coverage includes
  widths from 320 to 1440 pixels. No additional polling or animation timer was introduced.

## Compact layout sketch

Implemented the user-provided layout with pixel artwork left, date/zone stacked in the middle, and
small seven-segment time on the right. Standard readings produce a 48-pixel card in a 76-pixel
desktop header; the accessible region label remains while the extra visible heading is omitted for
available/stale samples.

Eight clock behavior tests passed. The initial layout test caught inherited line spacing making the
card 52.5 pixels high; correcting the clock's line height made the focused layout test pass,
including actual card/header dimensions, placement, and widths 320 through 1440 with long zone
labels. Desktop/mobile screenshots were reviewed. Desktop/web builds, type checking, formatting, and
diff checks passed; final renderer assets were rebuilt after the spacing fix.

## Header palette refinement

Updated the clock to the app's slate surface with a faint green tint, subtle gray-green border,
regular date typography, muted timezone text, mint clock/time accents, and dimmer inactive segments.
The compact size is preserved. Both focused responsive/digit tests passed, including stale and
disconnect behavior, normal header dimensions, and long-label mobile layouts. Desktop/mobile
screenshots were reviewed. Desktop/web builds and type checking passed; formatting was corrected and
checked after implementation.

The seven-segment display was subsequently thickened with a 0.6-unit matching SVG stroke. The
responsive layout test passed, renderer builds passed for desktop and web, and the updated mobile
screenshot was reviewed. Display and header dimensions remain unchanged.

## Final sync and terminal scrollbar qualification

All 25 clock tasks are complete. The clock's seven requirements and every scenario were synced to
the new main spec, with the Purpose retained, and compared against the delta. Strict main-spec and
change validation passed. Planning and private test details remain locally excluded.

The separate startup scrollbar fix removes xterm's forced native duplicate and gates its custom
scrollbar on actual buffer history after rendering. Packaged Electron exposed an empty custom
scrollbar even after the native override; the buffer-based guard resolved it. The regression covers
initial launch, a short prompt, 400 output lines, and clearing history. Existing wheel-boundary,
prompt, clipboard, recovery, and gateway terminal behavior remained intact.

Final checks: `npm run verify` passed with 77 tests and 10 platform skips; clock/terminal UI passed
21 tests with one opt-in Bash skip. After the buffer guard, the complete terminal suite passed 12
tests with the same skip. Native desktop smoke, desktop/web builds, type checking, formatting, and
diff checks passed. No commit, push, or new application package was performed in this step.
