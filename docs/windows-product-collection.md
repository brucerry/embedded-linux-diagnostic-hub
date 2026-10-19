# Windows product collection preparation

Collection remains blocked by the independent Windows preparation review. The current workflow adds
only the separate metadata preflight described in `windows-preflight-only.md`; it exposes no
collection option. Earlier collection-enabled proposals are superseded and remain historical review
artifacts. Observations from a completed hosted job cannot approve a later host.

This candidate prepares the mandatory Windows-first Electron 44.5.1 source lane. It has no native
Windows result and grants no permission to dispatch CI. Source review, independent native
coverage-contract review, actual Windows preflight and a separately reviewed execution manifest must
precede collection. Historical Mac finite calibration does not transfer.

The existing hosted route is `.github/workflows/windows-portable.yml` on `windows-latest`. Its
standing 30-minute build and all other standing workflows remain unchanged. A proposed separate
manual producer is supplied with the review packet; do not fold an 80-minute pair into the build. No
tag, release producer, protection setting, signing configuration or publication is changed.

## Reviewed inputs and admission

Use pinned Node 24.22.0 and the existing installed dependencies. The collector refuses an unexpected
platform, architecture, runtime version/flags, ambient Hub/Node/TSX/esbuild/Electron override,
changed source, complete dependency inventory, loader, Electron executable, PowerShell executable,
derived SSH bundle/preload, native applicability contract or independently supplied manifest digest.
Windows `--import` receives a file URL. Each job gets a fresh private profile. No dependency or
driver install is performed by the collector.

`memory-product-preflight.mts` is preparation: it reads the actual hosted principal, ACLs, runtime,
source and dependencies and creates only the existing derived JS-only SSH qualification bundle under
validation. It does not launch Electron or a soak. Supply an already-created canonical empty owned
output directory outside the source tree:

```powershell
node --import <absolute-tsx-loader-file-URL> scripts/memory-product-preflight.mts --out=<absolute-empty-owned-root>
```

The resulting manifest and native contract are drafts (`reviewed: false`), never automatically
approved. Review the actual source/runtime/dependency hashes, root/temp owner SID and SDDL hashes,
PATH, metadata and case contract externally. Provide the exact approved bytes and their independent
SHA-256 digests outside the source tree. The collector requires the first hosted run attempt and
records actual repository, source commit, run ID and attempt. These are source collection receipts;
the instrumented build is not a shipping archive/ASAR qualification.

After separate execution approval, the proposed entry is:

```powershell
node --import <same-absolute-tsx-loader-file-URL> scripts/memory-product-collect.mts --manifest=<approved-absolute-path> --manifest-sha256=<independently-approved-digest>
```

The manifest admits exactly two serialized normal-GC jobs: sampled, then matched no-sampler. There
are no retries or replacement samples. Each preserves five warm-up minutes, 25 measured minutes, at
least 100 completed cycles and the existing 30-minute measured coverage deadline. Each shared
40-minute budget includes startup and a 60-second cleanup reserve. The pair shares an immutable
80-minute cohort deadline, including preflight; the second deadline is capped by that cohort. Fewer
than 31 minutes remaining prevents admission. Forced GC is a separate future full outcome.

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

## Ownership, evidence and bounds

The collector adapts the reviewed finite controller and actual outer observer, using ProductRunOwner
cancellation. It bypasses the old exit-only `memory-runtime.mjs` soak launcher. The hierarchy is
outer observer -> collector -> actual harness -> app/gateway descendants. Every middle cancellation
uses nonce-bound IPC. No middle watchdog is killed. Unknown close, descendant history, evidence
closure or path binding retains the canonical exclusive marker and attached owner. A deadline never
fabricates an exit. The outer records actual spawn, exit and inherited-pipe close; the collector
cannot self-attest its outer completion.

The marker is `realpath(os.tmpdir())/diagnostic-hub-v060-check.lock`; no relocated temporary
directory or stale-marker replacement is allowed. Marker proof binds complete bytes, nonce,
dev/inode, nlink, ancestry and actual owner. Windows uses read-only current-principal/owner-SID
checks and reviewed root/temp SDDL hashes. Unix UID checks apply only where available. These are
temporal path/ACL checks, not a claim of an atomic NTFS handle capability or Windows association
qualification.

Timeline writes refuse a row above 1 MiB, more than 50,000 rows or 64 MiB total before writing. The
native exit receipt refuses above 128 KiB before writing and syncs/closes its descriptor. Native
report streaming refuses above 128 MiB before yielding to the actual writer. Each parent/outer
stdout/stderr retains at most 1 MiB while continuing to drain/hash all attempted bytes; overflow
invalidates collection. Collector journals have 1,024 rows/1 MiB; record streams have 4 MiB. Each
private job tree is capped at 246 MiB with 8,192 files by admission/periodic/postflight observation,
reserving the rest of the 256 MiB/job and 512 MiB/cohort envelope for logs/metadata. Native
browser-cache/download writes are not an atomic disk quota: an oversized observation cancels and
invalidates; its possible observation overshoot must be assessed on actual Windows before a run.
Successful native reports are unlinked only after semantic acknowledgement; hashes/byte receipts
remain in the bounded timeline. Failed semantic files remain in the bounded private tree for review.

After actual harness close, every private file is bounded-read through a regular single-link
identity-checked descriptor, synced using a writable handle for Windows and independently closed.
Required timeline/native journals are revalidated; every observed PID/creation identity must appear
in final shutdown history, descendants terminated with null memory values, and actual native exit
and close must agree. Numerical failure and ownership closure are separate. Complete ownership and
durable evidence may release a marker after a known failed workload; incomplete ownership cannot.
Outer completion is retained separately and must also pass review.

The first pair collects unreviewed calibration data. It chooses no memory thresholds, transfers no
Mac policy, qualifies no installer and certifies no leak freedom. Enforcement still requires at
least ten distinct matched calibration hashes per declared role/metric, reviewed delta/slope policy,
separate normal/forced outcomes and final shipping artifact qualification.
