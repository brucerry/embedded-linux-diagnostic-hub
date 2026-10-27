# Actual product Results UI qualification helper

`tests/fixtures/memory-product-results-ui.ts` adds Playwright actions for the actual
`StoredSerialResults` UI used by Serial and independent-script SSH. It creates no captures, seeds no
IndexedDB data, changes no production hooks and supplies no product-owner zero maps. Callers must
provide IDs and metadata from captures already produced by actual product scenarios, plus
independently known expected output bytes/hashes for the selected semantic fixtures.
Persistent-console journal Results is a different catalog/report schema and remains unsupported by
this helper/current private catalog API.

The source-only patch contains this new fixture, pure report-parser/identity controls and this
document. No browser, build, socket, performance, calibration or memory workload is qualified by its
local checks. Actual UI execution remains primary integration work.

## Interface

```ts
const receipt = await exerciseProductResults(page, {
    transport: 'serial', // 'ssh' selects the actual independent-script UI
    catalog: actualExpectedCatalog, // all current IDs, including other transports
    selection: actualSelectedExpectations,
    search: { query: uniqueKnownOutputToken, expectedIds: actualMatchingIds },
    evidenceDirectory: privateEvidenceDirectory,
    maxDownloadBytes: explicitSemanticFixtureByteBudget,
    requireCrossPage: true,
    clear: 'selected', // 'all-transport' or 'none'; only explicit UI deletion
    reopen: 'reload', // or 'none'; replaces the page realm
    evolution: {
        mode: 'bounded-growing', // or 'constant'
        previousIds: previousActualCatalogIds,
        expectedAddedIds: exactActualNewIds,
        bound: explicitCatalogProfileBound,
    },
    exportReadFault: optionalActualServiceWorkerAdapter,
});
```

`ResultsCapture` includes exact `id`, `sequence`, `transport`, `command`, raw capture `state`,
`committedBytes`, optional expected label, completion/exit semantics, per-stream `{bytes,sha256}`,
and required readable output tokens where applicable. Selection entries must identify actual
matching catalog records and provide per-stream hashes plus an explicit completion (`null` means
actual outcome metadata absent). Derive expected hashes from the known real producer's bytes;
copying a hash out of the file being tested would make that assertion circular. Other catalog
records may have metadata-only expectations; their JSON raw frames still pass the product
frame/CRC/high-water verifier, but that is not an independently expected full output hash. The
helper checks this distinction instead of inventing missing expectations.

Call only after actual producers are quiescent. Existing `memoryProduct.catalog()` reads the real
capture repository and has a500-record qualification bound. All supplied catalog membership is
checked against it before actions. More than20 actual captures, with selected IDs on different
rendered pages, are required for `requireCrossPage:true`; no fake seed or reduced threshold is
supplied. The helper traverses actual next-page controls, checks each visible ordered prefix/row
bound, selects real rows, and confirms the exported off-page membership. Search expectations must
fit one bounded page (at most20 known matching IDs); the supplied token should occur in actual
output beyond the preview when full-output-search coverage is required. The helper verifies the
resulting IDs/export, but cannot infer that a caller token was beyond8KiB unless its producer
evidence establishes that fact.

## Actual downloads and semantics

Every selected JSON/CSV/Markdown/text report is downloaded via the real UI/browser event, awaited to
actual completion, saved under a fresh private evidence directory, bounded without truncation,
parsed and hashed. Temporary Playwright event listeners are removed in `finally`, including failed
actions. No product timeout/watchdog or memory ceiling is changed; `maxDownloadBytes` is an explicit
caller-selected small semantic-fixture budget, not a new production output limit. An oversized
report fails and remains on disk; it is not counted as covered or silently clipped. Use
appropriately bounded actual fixtures outside observer-sensitive memory sampling.

JSON checks exact IDs, command/transport/sequence/state/counters/outcome, raw frame CRC/boundaries
and aggregate per-stream expected bytes/hashes when supplied. CSV uses a strict quoted/multiline
parser, exact header schema, formula-transformation metadata, actual membership, outcomes and raw
per-stream byte/hash checks. Markdown parses IDs and command/output/outcome blocks only
outside/inside their correct variable-length fences; fake metadata embedded in command/output cannot
substitute a capture. Text checks count/command/readable content, and explicitly returns
`identityAttested:false`: its current public schema omits capture IDs. Neither readable format is
described as an exact binary export.

Filtered JSON membership and all-transport JSON membership are checked independently of the current
rendered page. Actual empty-filter export refusal is exercised separately: any emitted download must
fail, the UI must report failure and catalog membership must remain intact. That is not a
storage-quota or cancellation substitute.

## Optional actual service-worker read faults

The bound page-private hooks cover only `begin/append/seal/record`. Browser report export constructs
its repository and broker in a separate service worker, so those hooks cannot hold/fail its `read`
generator. Unless the primary supplies a real adapter, cancellation/storage-read-failure coverage
remains explicitly unsupported.

`ResultsExportReadFault` requires:

- `realm:'service-worker'`, nonempty `quotaMessage` matching the actual injected failure;
- `arm('hold'|'quota')`, `status()` returning actual `{method:'read',action,entered,released}`;
- `release()` for the entered held read and `clear()` for the actual private fault;
- optional `snapshot()` returning raw real module/broker/store observations.

The cancellation scenario waits for an entered actual held read, clicks the actual Cancel export
control, verifies the UI still holds its busy operation before release, records the actual pending
snapshot if available, releases the fault, and checks cancelled UI/failed download settlement with
unchanged catalog. The quota scenario checks the actual error text/failed download and preserved
catalog. Cleanup releases only the injected test hold if needed and clears that fault; it does not
remove product registrations or fake closure. Neither scenario converts unknown snapshot fields
into0. Service-worker broker jobs/preparing/watchdogs/iterators/ending pins, finished cache, real
worker IndexedDB transactions/connections, native helper realms and process destruction require the
primary's independently verified owner adapter. This fixture returns `ownershipVerdict:'unassessed'`
even when raw optional snapshots exist.

## Clear, reopen and catalog modes

The helper exercises the actual Clear/Keep confirmation before any requested deletion.
`clear:'selected'` deletes only the selected actual IDs. `clear:'all-transport'` uses the real
confirmation for that transport and verifies other-transport IDs remain. No direct API deletion is
used. Expected catalog metadata is rechecked afterward.

`assertResultsCatalogEvolution` compares exact IDs for constant/bounded-growing profiles. Removed
items cannot offset new ones; growth requires the exact expected new IDs and an explicit caller
bound no larger than the existing500-record API bound. This is logical catalog behavior, not a
heap/slope/policy verdict.

The current module singleton keeps a resolved repository promise after `close()`, and the IndexedDB
store then stays closed. A same-realm `closeRepository()+mount()` therefore cannot honestly count as
reopening storage. `reopen:'reload'` explicitly unmounts the actual App, closes its repository,
reloads the real page, observes a new private API with no implicit synthetic Serial open/send, and
verifies the same surviving actual capture IDs in reopened storage/UI. It changes the realm and must
run before/after a same-realm memory/ledger qualification cohort, never inside it with a silently
replaced baseline. It is profile persistence evidence, not proof that old service-worker/native
owners exited.

## Integration boundaries

Apply only the three new files after checking `patch-manifest.json` and its integration preimages.
Existing product/API/runner/storage/page/global-style/memory-policy/workflow files are untouched.
New-file paths must be absent. Current component/export/API source differences require review before
claiming the selectors/protocol still apply. The provided local guard checks these preimages
read-only. Actual UI cases, their three-engine/native/platform applicability, SW ownership,
cancellation/read-failure adapter, calibration and full-product acceptance remain unrun until the
primary composes and executes them.
