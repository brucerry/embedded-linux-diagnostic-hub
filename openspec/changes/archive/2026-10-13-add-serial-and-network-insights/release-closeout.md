# v0.5.0 release closeout

Current status verified 2026-10-14: release run 38454272424 attempt 2 passed at
01:11:43 UTC on unchanged source 9af3ae3364513f25f1ca2e2ac2ea69da8ad2d263.
Both actual public Mac commands and installed smoke checks are qualified. The earlier failure and
access-blocker narrative below is retained as history. Physical acceptance remains NOT RUN / NOT PASSED.

Public stable release: https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/tag/v0.5.0

Windows download:
https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v0.5.0/Diagnostic-Hub.exe

Source/tag commit: `9af3ae3364513f25f1ca2e2ac2ea69da8ad2d263`. Annotated tag object:
`68b9cfe06ba17978f454591c220391e452b2ba5f`. Public release ID: `412027760`. Published at 2026-10-13
19:48:50 UTC. Version: 0.5.0; draft=false; prerelease=false.

All 24 public assets were anonymously downloaded and passed the existing read-only audit: digests,
same-tag checksum sidecars, Windows/Linux/Mac source manifests, immutable source helpers, complete
inventory and source-generated four-section release notes. The public Windows executable is
102610800 bytes, version 0.5.0, unsigned (NotSigned), SHA-256:
`0d35c76e89cf02ca6864a36fb49d78f39bcb15a3ec8176b4b58aea25ce2a4f4c`. It was downloaded and inspected,
not executed. All nine older public release inventories retain the same asset IDs, names, sizes and
digests; the v0.4.0 tag/source remain unchanged.

## Software qualification and outstanding public Mac check

Required main CI passed on the exact app source. Release run `38454272424` passed version, guarded
draft privacy, website, Windows package/native checks, Linux package/runtime/seven GNOME cases, both
native Mac builds/installed checks/100-cycle stress, asset/source validation and publication. The
post-publication Intel public command and installed SSH checks passed. The post-publication Apple
Silicon job `115504993456` failed before successful installation with curl exit 56 / HTTP 403 at
`tests/macos-published-smoke.ts:50`; the original log does not identify the request or retain
response headers. The overall tagged release run therefore retains a failure result.

The existing read-only HTTP preflight passed locally after publication: the known control release,
latest stable metadata and actual latest Mac helper all returned HTTP 200. API headers showed
remaining quota 55/54 on this executor, and helper bytes matched the immutable source SHA-256
`4a5682867671d4adc65f1398a6888176a3e4f8e410139011727c7f39cb49012e`. These observations do not
establish the original Apple Silicon runner's 403 cause or substitute for running its actual public
command. No blind rerun or authentication/security bypass occurred.

The existing Mac audit cannot be dispatched by this executor: the connected GitHub tool inventory
exposes workflow reads/reruns but no dispatch action, no local REST token is configured, and the
computer-use browser kernel failed initialization with missing required Windows platform directory
(HRESULT 0x80070003). A dispatch-capable environment should run the existing read-only published Mac
audit with latest-stable selection, retain its HTTP headers, honor only confirmed server reset times
and verify both actual commands. Published assets/tags must remain immutable.

## OpenSpec and physical follow-up

All six feature delta requirement bodies match their canonical specs. Before archive, strict
validation passed 18 items (17 canonical specs plus the active change), and all planning artifacts
were complete. The software change is archived with one explicitly incomplete task, 7.4, retained
unchecked: physical serial/target/platform evidence. Archive is authorized under the user's stated
hardware deferral; it does not claim all tasks or hardware acceptance passed.

`hardware-qualification.md` and the public work-environment acceptance checklist retain every
physical case as not run / not passed. The user will test Windows 11 at work, including adapter
labels/framing, busy/denied/unplug behavior, open-close/control-line effects, terminal bytes,
Automation timing/cancel/rearm and exports. Actual Linux iw/ip/driver observations and physical
Mac/browser-quarantine acceptance remain separate. UART enablement, wiring and target operation
remain the user's responsibility. No physical port was opened and no host permission or network
configuration was changed during this work.

Evidence directory: `C:/Users/bruce/Desktop/Codex/2026-10-13/task/v050-publication`. The separate
four-line `tests/ui/live.spec.ts` edit remains byte-identical and unstaged. OpenSpec, skills,
screenshots, local receipts and profiles remain local-only.

## Confirmed connector Actions-write blocker

The parent reviewed the public endpoint checks and Intel success, then attempted exactly one
bounded rerun of leaf Apple Silicon job 115504993456. The GitHub connector returned HTTP 403,
`Resource not accessible by integration`; no retry was initiated. This is an authenticated
Actions-write integration access denial, distinct from the original anonymous downloader's
curl56/HTTP403. The original download response remains unclassified because its headers and exact
request were not recorded. No other route, credential/permission change or release/tag/asset
mutation was attempted after this denial.

Morning pending action (not queued): with supported authorized Actions access, run the existing
read-only `macos-published-verification.yml` on main with `published_tag` empty to select latest
stable v0.5.0. Retain the existing HTTP preflight's headers and honor only confirmed bounded server
reset times; verify both actual public commands. A reviewed alternative is a single rerun of only
leaf job 115504993456, which has no mutating dependent jobs. The Windows download and all 24 public
assets remain verified; the tag workflow retains its ARM post-publication failure status.

## Public Mac qualification resolved — 2026-10-14

The user manually reran only the failed Apple Silicon leaf job. Read-only connector verification
confirms release run 38454272424 attempt 2 completed successfully at 2026-10-14 01:11:43 UTC.
Job 115626258786 newly executed the actual latest-stable public download, normal visible launch,
renderer bridge/source/version checks, running-update refusal and installed SSH/trust/clock/reset/
unsupported-update checks on unchanged source 9af3ae3364513f25f1ca2e2ac2ea69da8ad2d263.
Other successful job results were carried from the preceding attempt; publication was not repeated.
The original HTTP403 did not recur. Its cause remains unproven, and no application/helper code fix
is indicated. Original failure, connector Actions-write denial and failed badge evidence remain
preserved. The diagnostic/retry action is resolved and no further automation was initiated.

Evidence: task/v050-publication/manual-rerun-resolution.json and updated final-status.json.
No commit, push, release/tag/asset mutation, credential/permission change or physical-device action
was performed for this closeout update. The archived task7.4 and full hardware checklist remain
unchecked: Windows11 UART/driver/framing/control-line acceptance at work, actual Linux iw/ip driver
evidence, and physical/managed Mac/browser-quarantine acceptance still require separate observation.
