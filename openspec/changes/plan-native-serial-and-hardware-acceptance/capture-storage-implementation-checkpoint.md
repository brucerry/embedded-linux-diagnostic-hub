# Storage/export foundation checkpoint for v0.6.0

This is an isolated, unadopted implementation increment for independent review. It does not yet
replace the Automation page's capped capture path. No installation, physical port, DUT, SSH server,
release, dependency or publication operation occurred.

Candidate: `../capture-storage-implementation/workspace`.
Exact source delta and hashes: `capture-storage-core-review.patch` and
`capture-storage-core-review.json`. Apply after the accepted Serial/UI packet and cancellation
correction; both remain byte-for-byte frozen.

## Implemented in this increment

- Physical-file native repository and secure-origin IndexedDB repository, with one active writer,
  one outstanding commit, bounded accepted input/backlog, 16 KiB raw frames, 64 KiB write batches,
  8 KiB preview and byte/row-bounded metadata pages. There is no small total-output or retained-row
  cap in these new repositories and no automatic eviction/deletion.
- Exact raw bytes, observation sequence/boundaries/offsets, original host receive timestamps and
  stream/source provenance. Storage frames never masquerade as individual reads. CRC and pinned
  sequence/length/count verification detect missing or corrupted committed blocks.
- Native journal write/sync/close precedes counter publication; seal verifies/syncs the committed
  journal before publishing completeness. Failure stops writer completion; callers must await
  begin/append/finish or abort cleanup before any later command. Accepted bytes and committed bytes
  are separate facts; preview clipping is separate from capture completeness.
- Interrupted recovery preserves the verified committed prefix and keeps native uncommitted journal
  bytes. If quota/permissions also reject failure metadata, bounded read-only projections remain
  exportable/deletable, with unknown observed-tail/finalization fields left unknown.
- Streaming raw JSON v3, CSV, Markdown and text. CSV retains the existing whitespace/control-aware
  formula guard and identifies transformed fields. Native export preserves an existing destination
  if encoding or storage fails; only verified complete export streams can replace it.
- Browser download jobs use expiring one-use tokens, owner and reserved helper-client identities,
  strict scope/origin checks and cross-tab read/write/delete leases. Firefox/WebKit's omitted
  navigation client ID is handled through the reserved unique helper/referrer, never an anonymous
  token-only fallback. At most eight worker jobs/four reusable sandboxed helper frames exist.
- Browser exports validate the entire pinned prefix before opening an attachment and validate again
  while streaming. Missing blocks are failures, never EOF. Worker restart, cancellation and expiry
  cannot turn into a successful completion receipt or delete stored results.
- Rich Markdown has a concise run summary, bold metadata/status, timestamp table, dividers and useful
  icons; commands and detailed output are in separate safely sized fences. Pipes, newlines,
  backticks/tilde runs and HTML-like content are covered. Raw JSON remains the exact-byte evidence.
- Added SSH/Serial delayed-old-release/third-arming regressions without changing the accepted
  cancellation implementation.

The web build emits the worker/helper at the deployment base. Web/development CSP permits only
same-origin frames for this transport; packaged desktop CSP and custom-scheme privileges are
unchanged. Browser persistence is still quota/eviction limited; persistence grants are not requested
silently. These APIs promise no arbitrary small application output cap, not infinite storage.

## Verified evidence and Firefox outcome

The sealed native/broker suite passes 20 tests. Three-engine storage/recovery/ownership/export and
Markdown checks pass 27 cases. Fourteen actual-component cancellation cases passed, including the
two new delayed-release cases. Large capture/authenticated-download fixtures above 32 MiB passed in
Chromium, Firefox and Windows Playwright WebKit; logs identify each run and intermediate failures.

The injected missing-block Firefox problem is resolved by detecting corruption before attachment:
the page receives the explicit error and no native download starts. All client/token/ownership
checks remain enforced. Earlier midstream-error/headless-page stalls and traces are retained;
general unexpected midstream native-browser error UI is not claimed qualified. Forced worker
interruption with failed download/receipt and released ownership was tested in Chromium.

Measured Windows WebKit capture of 34,619,392 bytes took about 54 seconds. Replacing repeated tiny
read transactions with a counted/key-bounded read-ahead window reduced verification/encoding to
about 4.4/4.6 seconds and completed the fixture in about 71 seconds, within the unchanged 120-second
deadline. The window is at most 15 frames (<256 KiB including serialized provenance), never an
unbounded `getAll`. Write batches, processing frames and exported chunks remain bounded.

An earlier native Node probe captured 64 MiB and streamed about 90 MiB of JSON with retained heap
growth of 305,288 bytes after forced GC. It is supporting evidence; final whole-product/browser and
native Electron heap/lifecycle qualification remains pending.

Markdown fixtures, parsed AST and rendered screenshots are under
`../capture-storage-implementation/evidence-sealed/`. This is a local GFM-compatible parsed-AST
preview using the pinned formatter, not a claim of live GitHub rendering or physical-device output.

## Remaining before full feature acceptance

1. Wire repository selection, storage usage/failure/cleanup controls, paged results and
   selected/filtered export scope into Automation. The current visible UI still uses the old cap.
2. Add trusted native IPC and bounded independent-SSH desktop/gateway streaming, then connect the
   real SerialSession path. Verify producer overrun, slow storage, cleanup, generation fencing and
   next-command suppression through those actual adapters. Current fault tests exercise the
   repository/writer completion fence, not physical UART overrun.
3. Index the native catalog and qualify very large histories. Current native paging bounds memory
   but scans directory metadata; its large-history throughput is not accepted for the final UI.
4. Complete aggregate source/platform/memory qualification and review/adoption. Native new-file
   publication currently requires filesystem hard-link support; unsupported/denied destinations
   fail explicitly. Linux/macOS, native Electron capture integration and unexpected Firefox/WebKit
   midstream failures remain outside this checkpoint.
5. Keep persistent SSH console, clean ANSI result projection and the queued Serial scene/palette
   work separate. Nothing in this increment rewrites aliases, shell initialization or device state.

There is no blocker to reviewing this foundation. Integration and the listed acceptance work remain
pending; v0.6.0 is not ready for publication from this checkpoint.
