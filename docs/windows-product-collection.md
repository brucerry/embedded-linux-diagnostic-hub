# Windows raw observation preparation

This source is disabled by `scripts/lib/observation-execution.json`. The manual workflow checks that
fence before installing dependencies or running its PTY prerequisite. The collector and observation
entry also refuse disabled source. Do not dispatch the review candidate as a test. Independent exact
source/host-scope review, a separately reviewed activation successor, and direct human authorization
for its push and first dispatch are still required. Old finite-pilot approvals do not authorize it.

The proposed route extends the existing registered `windows-portable.yml` manual workflow. It has no
push/PR trigger for observation and skips the standing build and finite modes. Its outer job allows
130 minutes for setup, at most 20 minutes of owned preparation/approval waiting, the existing
80-minute collection cohort, and artifact retention. Each of the two serialized normal-GC jobs has
at most 40 minutes including a 60-second cleanup reserve. Cohort time starts once after approval;
collector, parent and outer observer all use that same nonce/start/deadline. There is no restart,
rerun, third parent, forced-GC run or automatic replacement.

A completed raw job requires five representative warmup minutes, 25 measured minutes and at least
100 completed cycles with the full product adapter, viewer and 33-MiB body in 16-KiB fragments.
Diagnostics target roughly 250 ms and retain actual timing/coalescing and all observed identities.
The 12,000-sample and 256-identity ceilings remain safety limits, not manufactured targets.

## Exact proposed manual procedure

1. Review the sealed source, activation diff, bounds and applicability contract. Keep the request
   JSON outside the source tree. `sourceSHA256` is the actual recursive runtime `sourceFingerprint`
   of the exact successor, not the flat packet inventory digest; both identities are recorded
   separately. Its fields are `schema:1`, independently reviewed `sourceSHA256`, `policySHA256`,
   exact `coverageJSON`/`coverageSHA256`, and `pty` containing exact `policySHA256`, `scopeSHA256`,
   and `scopeJSON`. The normal-pair policy digest is SHA-256 of `JSON.stringify(observationPolicy)`;
   neither computing that digest nor setting `reviewed:true` supplies human approval. Both coverage
   and PTY scope must bind the activated exact source.
2. After direct execution authorization, manually dispatch the activated commit on the dedicated
   validation branch with `windows_observation_pair=true` and `observation_request_json` equal to
   those exact reviewed bytes. Leave every finite selector and `observation_approve_json` empty.
   Only the first attempt and owner `brucerry` are accepted. No secrets belong in the request.
3. On that same disposable Windows allocation, the existing guarded PTY-only entry runs its fresh
   WinPS prerequisite and one real PTY stage, positively closes its owners/evidence and returns its
   marker. Failure or unknown closure stops the workflow before collection. The new custodian then
   owns the canonical marker, pinned Electron/Node/loader/tools, JS-only SSH runtime preparation,
   root identities and security descriptors. It prints one nonsecret live host challenge.
4. Review that challenge and its actual runtime/dependency/root/marker/free-space/PTY identities.
   While this owner remains alive, manually dispatch the same activated commit again with only
   `observation_approve_json` set to the exact displayed approval JSON. Leave the pair selector,
   request and finite selectors empty. This approval-only job restores no dependencies, imports no
   collector and launches no payload. Its artifact binds parent run, commit, source and challenge
   digest. The pair owner uses read-only authenticated GitHub API calls, requires the exact reviewed
   workflow/actor/first attempt and rejects foreign, stale or replayed artifacts. It never writes
   GitHub messages or changes repository settings.
5. Approval cannot migrate to another host or process. Immediately after waiting, and before each
   payload admission, the owner rereads the durable PTY journal, actual binding, closure, source,
   policy and scope, full evidence hashes, ancestry and descriptor identity. The separate collector
   independently checks the approval artifact and actual parent PID/root/marker identity, then
   completes a bounded single-use inherited-IPC handshake. A JSON manifest alone cannot admit it.
6. The independent `runOuter`/`observeCollector` watches actual collector spawn, exit,
   inherited-pipe close and stream durability. The collector owns actual harnesses and their
   app/gateway leaves. Its positive release request is an intent: the outer retains the real marker
   until actual collector closure, outer evidence closure, unchanged inputs and all controller
   proofs agree. Nonzero known workload failure may close honestly; missing/late close or sync/close
   uncertainty retains the marker and referenced owner. Cancellation uses nonce-bound IPC and never
   kills a middle owner. Approval expiry or cancellation cannot mint a new deadline or new attempt.
7. Preserve the 14-day evidence artifact and review the exact outcome before any next action. No
   memory thresholds are selected by this route. A forced run, another lane or shipping
   qualification requires separate reviewed work and authorization.

## Native cases

Native storage uses physical capture files and a disposable SQLite membership index. The exact
source-bound contract records IndexedDB `versionchange` as inapplicable and requires the actual
native renderer generation reset/reopen case instead. It never credits an IndexedDB event. The case
holds actual reader/pin handles, reloads the renderer, proves old reader rejection, accepts
idempotent stale-unpin cleanup, observes zero old leases and reopens the retained catalog.

The private instrumented native build controls only trusted Save destination selection. Actual UI,
IPC, NativeCaptureHost pin ownership, report streaming and atomic destination writer remain in use.
Cancellation occurs while Save is genuinely held and returns a cancelled destination. Failure holds
Save, arms a real store-read failure, releases Save, verifies the existing destination survives,
proves no export temporary remains and joins the real owners. These boundaries require independent
contract review; they do not claim an unsupported native mid-write cancel button.

Native command-capture export validates the pinned report's first bounded chunk before opening Save.
An empty selected, filtered or retained scope therefore reports its error without opening a dialog
or allocating a destination. The same iterator continues after Save confirmation; cancellation
closes that iterator and both snapshot pins before the owned export settles. This ordering preserves
the existing stream verification, atomic replacement and shutdown joins. Local browser/native-host
regressions do not establish an actual Windows quit-barrier or complete native-cycle result.
Expected-empty native UI cases own a private no-destination guard: an unexpected chooser is recorded
and rejected without opening a dialog, and the callback is restored only after its actual export
joins. A successful empty refusal requires zero chooser calls. Failure and shutdown-request receipts
retain bounded native owner counts and Save-entry/return state; missing receipts remain unknown.

Installed Git/MSYS winpty and PowerShell discovery uses the actual host PATH and Git installation,
with explicit unavailable results. It has no user cache path and installs nothing. The ordinary
real-OS-PTY test must run on Windows; a skipped result is not native PTY coverage. Aggregate SSH
manual-channel separation uses its actual private SSH target's PTY request/channel; it does not
prove an external Linux/ash/DUT shell or replace the ordinary installed-PTY prerequisite.

## Shared accounting, custody and outcomes

The unchanged physical envelope is 416 MiB per job (406 MiB work) and 840 MiB per pair including 8
MiB shared. The shared allowance has disjoint 4-MiB writer credits: parent preparation/runtime,
coverage/approval, retained PTY evidence and outer records/logs; and collector records/journal/
security evidence. These are allocations inside 8 MiB, not additional allowances. One measured
inventory includes both complete persistent roots, excludes job trees and their attributed parent
streams from shared bytes, and counts each file once. Metadata/journal/outer-stream writes check the
appropriate credit before writing; independent local maxima need not fit simultaneously.

Owned preparation transients remain under the existing Electron/runtime helper bounds and must
join/close and be removed before collection admission. Settled dependencies are pinned inputs, not
newly created pair data. Retained preparation and PTY files remain charged to shared storage. A
missing tree, alias, changed identity or actual excess refuses; no guessed 2-MiB charge remains.

Canonical TEMP is inventoried before collection. Each new or grown external file identity is
assigned once to the job that first observed its growth, at current bytes above baseline, within
that job's existing auxiliary allowance. The owner monitors private/shared/job trees and available
space every second, requires 2 GiB free at admission and stops work below 128 MiB available.
Apparent and supported allocated-byte observations, actual phase transport charges, artifact sizes,
retirement, sample timings and complete process histories remain evidence. Periodic peaks are lower
bounds, not filesystem quotas or a universal bound on Chromium or other host writes.

The canonical marker remains `realpath(os.tmpdir())/diagnostic-hub-v060-check.lock`. TEMP/TMP,
credentials, owners, ACLs and security policy are unchanged. Temporal path/descriptor readback uses
the existing strict trusted-three-ACE hosted policy; it does not claim an atomic NTFS capability.
Windows metadata is fsynced through writable descriptors and actual closure is checked
independently.

Security readback retains the production provider's one-to-three-plan limit. Both logical many-path
adapters submit ordered batches of at most three, validate each response against the same principal
and descriptor history, and publish history only after the entire call succeeds. Failure admits no
later batch or native work. The raw provider and its over-limit negative controls are unchanged.

A security input refusal may use ordinary preparation-refusal cleanup only with positive process
closure, durable raw query records and zero filesystem/ACL queries. Cleanup additionally requires
unchanged source and roots, complete preparation evidence, and each attempted preparation resource
positively closed. Marker release still performs its strict ownership/ACL/byte recheck. Missing
proof retains custody. Unknown ownership latches its referenced hold before bounded reason
persistence; a failed reason write cannot release or detach that hold. A genuine hold can remain
until the existing outer workflow timeout and is not evidence of lease release.

Outcomes are distinct:

- `COMPLETE_RAW_OBSERVATION`: required workload, coverage and durable closure completed; no memory
  pass.
- `PRODUCT_OWNERSHIP_INTEGRITY_FAILURE`: observed product/integrity failure, with exact evidence.
- `INCOMPLETE_UNQUALIFIED_OBSERVATION`: budget, duration, cycles or supported-measurement shortfall;
  it earns no qualification credit and admits no second parent after first-job failure.
- `INVALID_UNKNOWN_CLOSURE_OR_DURABILITY`: missing ownership, binding or durability proof; hold
  custody.

A work refusal can coexist with a valid incomplete footer and actual closed descriptor. Producer and
inspector preserve that distinction without absorbing footer/write/sync/close failures. Unknown
ownership cannot be replaced by a successful exit code or a collector-authored completion claim.

Full calibration/policy/enforcement, supported normal/forced separation, other platform/lane gates
and shipping artifact qualification remain open. The historical finite 64-KiB pilot established only
its own finite source/host result.
