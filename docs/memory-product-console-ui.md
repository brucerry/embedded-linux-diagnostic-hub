# Actual persistent SSH console UI helper

The new helper exercises actual Automation `SSH execution mode=console`. It does not use the
independent-script capture catalog, seed a journal, fabricate PTY/ACK owners, connect a target or
send direct transport input. Parent integration supplies an actual already connected native/browser
fixture target and real read-only hooks. All browser/native/runtime cases remain unrun until that
integration; pure modeled records are never product qualification.

## Actual schema and source boundaries

Persistent console uses `ConsoleSnapshot`/`ConsoleRecord` schema2, one `flowId` across the flow,
startup/idle/shutdown context segments and explicit command segments. Each command has its own
run/step/ordinal/name, Script or Send Enter intent, exact request base64 and frozen completion
criterion. A durable preparation is distinct from an actual `inputSent` boundary with
`disposition:'write-dispatched'`. Preparation alone does not establish dispatch or target delivery.
Raw observations are one ordered `stream:'pty'` with channel/extended origin, not stdout/stderr
streams. Prompt outcomes have `exitCode:null`; a prompt is not process exit status.

`ConsoleArchive.list(after,25)` uses UUID catalog cursors, not command sequence or wall-clock order.
Native `openConsoleArchive` creates `NativeConsoleArchive(window.diagnosticHub.consoleStorage)`;
browser mode opens the separate `IndexedDbConsoleJournal` v2 namespace. Missing native support fails
instead of silently selecting browser storage. Each separately opened archive view owns its
reader/pin/request/connection handles and must be disposed without closing or replacing a producer.
The existing authenticated console UI test demonstrates actual Script/Enter/Enter/Script, navigation
and live flow. Its other catalog test seeds rows and cannot satisfy this helper's actual producer
contract.

## Read-only primary hook contract

`ConsoleProductHooks` requires:

- `consoleCatalog():Promise<ConsoleCatalogSummary>` with actual
  `{schema:2,mode:'console',captures, pages}`. Use the new browser-safe
  `catalogConsoleArchive(archive,maxCatalogRows)` over the actual console archive. It validates each
  schema2 snapshot,25-row protocol/UUID order, exact advancing cursors and the explicit caller
  catalog bound; it never clips.
- `readConsoleSummary(id,{maxMetadataRows}):Promise<ConsoleJournalSummary>`. Use the new
  browser-safe `summarizeConsoleRead(id,archive.read(id),limits)` over one actual incremental read.
- `runnerState():Promise<{busy:boolean,cleanupPending:boolean}>` from the actual mounted runner.
- Optional `targetSnapshot()` returning the actual native-main or gateway-control source, connection
  identity and supported values or explicit unsupported reasons for automation console owner/PTY
  IDs, shell open/close counters, ordered PTY input events and data ACK trace.

Minimal private-entry integration (parent-owned, not implemented by this patch):

```ts
async function consoleCatalog() {
    const view = await openConsoleArchive();
    try {
        return await catalogConsoleArchive(view.archive, explicitCatalogFixtureBound);
    } finally {
        await view.dispose();
    }
}
async function readConsoleSummary(id, limits) {
    const view = await openConsoleArchive();
    try {
        return await summarizeConsoleRead(id, view.archive.read(id), limits);
    } finally {
        await view.dispose();
    }
}
```

These calls are for quiescent catalog/post-run inspection. Do not open a competing view during a
held producer if the actual storage lock denies it, bypass the lock or reuse its writer. Every
return/error path must join the real iterator/view disposal. Actual owner snapshots before/after
inspection remain primary-owned; this helper generates no resource counts.

The reducer uses actual shared `consoleSnapshot`, `applyConsoleRecord` and `completeConsoleCursor`
validators. It checks every frame CRC/sequence/range/origin, actual frozen command metadata/outcome
boundaries, final byte/record/observation/segment counters and exact UTF8 JSONL offset. It updates
aggregate, origin and segment raw CRC32 incrementally, retaining one frame plus explicitly bounded
metadata rather than raw output arrays or decoded full strings. CRC32 is not a cryptographic hash.
Independently known expected target bytes/CRC must come from the genuine fixture emitter, not be
copied out of the journal being tested. An explicit metadata bound refuses oversized fixtures
without silently truncating the journal. Incomplete/active snapshots are not promoted to complete;
the success assertion requires complete/shellClosed/null failure and exact observed bytes. Generic
schema1 capture objects are rejected.

## Actual UI sequence

1. `startProductConsoleUi(page,plan,hooks,limits)` first checks actual runner idle/cleanup and
   stores the real console catalog/optional target baseline. It selects SSH/console, sets validated
   shell prompts and actual enabled Script/Send Enter steps with names and optional completion
   overrides, captures the actual UI step UUIDs and clicks real Run once. Send Enter's disabled
   empty textarea is checked; exact CR comes from the actual console input contract. Existing
   command timeout, deadlines, repeat minima and runner guards are not changed. The caller must
   authorize replacement of this isolated profile's draft; this helper touches no original
   repository/profile.
2. The caller establishes a genuine held target operation, then can call
   `exerciseLiveProductConsole(page,hooks,limits)`. It opens/closes the real frozen active viewer,
   checks console-specific PTY/no-exit semantics, navigates Overview→Automation and verifies the
   actual runner remained busy in console mode. Supplied actual target evidence must preserve exact
   owner/PTY/request/ACK identities. Equal counts/replacement IDs cannot pass. The helper never
   releases the target; caller owns release and the real run join.
3. After joining the actual run, call `finishProductConsoleUi(page,started,hooks,limits,expected)`.
   It requires real Flow finished and idle/cleanup state, preserves old console metadata and finds
   exactly one new schema2 journal. It reads that actual ID and verifies ordered Script/Enter
   inputs, prepared→inputSent provenance, exact actual UI step IDs, unique run IDs, frozen criteria,
   prompt/match/null-exit outcomes and independent aggregate/per-command raw byte/CRC expectations.

Optional target snapshots compare the real connection and return-to-baseline owner identities, one
actual automation-shell open/close delta and ordered raw input bytes on one actual console owner.
Input chunk boundaries are not command boundaries: coalesced/split CR or Script writes are checked
incrementally against the complete expected byte order. Exclude the application's separate Terminal
shell from automation owner IDs, while preserving its real baseline. Do not expose owner capability
secrets. ACK data must be an actual data trace with ordered digest/count/pending IDs; unknown fields
return unsupported, never empty arrays/0. Final ACK completeness, PTY/channel close events and
renderer/native/OS ownership still require primary probes even when journal validation succeeds.

## Scope and integration guards

Only four new test/docs paths are added. The packet binds full source preimages for actual UI,
journal/storage/console-input validators, archive/backend/client and results controller. Check
`patch-manifest.json` and the included read-only integration guard before adoption. Primary source
differences require explicit selector/protocol review; no production/main/plugin/runner/storage/API
file is edited here.

No actual helper UI/native/browser run, target connection, network socket, build, installation,
calibration, performance/memory measurement or release qualification is performed by local pure
checks. Cancel/failure/incomplete console scenarios, journal downloads/catalog search/clear,
service-worker helpers and full-product resource/ACK closure remain unassessed by this packet.
Independent-script captures must stay a separate feature/profile and cannot be retagged as console.
