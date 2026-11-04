# Non-qualifying committed-source inventory bridge

The bridge maps observed checkout bytes to **independently supplied** frozen commit/tree IDs. It
never supplies a release pass: every observation, verification and supervisor comparison has
`qualification:false` and `releaseAcceptance:false`. The existing release consumer is unchanged and
still blocks missing authoritative producer evidence. An observation of an isolated preparation
branch does not freeze or qualify the final combined release candidate.

`scripts/lib/committed-source-bridge.mjs` verifies raw SHA1 Git commit, tree and blob object IDs
from their exact type/length/body, the unique commit tree link, supported regular-file modes,
canonical tree ordering and the complete recursively expanded file inventory. It rejects
malformed/duplicate entries, symlinks, gitlinks, sparse/unmerged index entries, unsupported
paths/modes and ambiguous case aliases. The provider independently reads checkout HEAD/tree and the
complete stage-zero index three times, bracketing two complete worktree checks. All tracked bytes
and canonical Git modes must match the immutable closure, including tracked paths excluded from the
fingerprint. Native mode classification uses Git's **owner execute bit**; other permission bits are
not claimed.

The fingerprint preserves `tests/fixtures/memory-resource-identity.ts` exactly for supported paths:
per-directory recursive traversal with JavaScript UTF-16 `<`/`>` name ordering, then relative path,
NUL, file SHA256 and newline. A global path sort, Git byte order or Unicode codepoint order would
change it. Basename exclusions apply at every depth, before file-kind handling, and also exclude
files with those exact names: `.git`, `node_modules`, `validation`, `dist`, `dist-web`, `dist-site`,
`dist-gateway`, `dist-electron`, `release` and `test-results`. Only untracked excluded subtrees are
outside the observation. `.gitignore` adds no fingerprint exclusions; extra nonexcluded files or
directories fail. Backslashes, traversal, malformed UTF-8, control characters and case aliases are
refused rather than normalized. Raw worktree bytes must match blobs; no EOL/attribute transforms are
applied. The stored inventory is globally sorted for deterministic serialization, but that order is
never substituted for recursive fingerprint traversal.

The inventory retains path, canonical Git mode, blob ID, bytes, SHA256 and fingerprint selection.
Its own SHA256 and the derived fingerprint are rechecked by `validateSourceBridge`, which checks
schema/self-consistency only. **Semantic verification requires** `verifySourceBridge` to re-read the
independent Git/worktree provider. A self-consistent forged JSON record is insufficient.
`verifyAndBindDiagnosticSource` also compares a supplied supervisor binding's source hash with that
verified bridge. It does not verify the binding's timeline/observer/run itself; that requires the
separate supervisor verifier and independent expected context. No source label is a trust anchor.

The real provider uses local read-only Git, disables replacements, lazy fetch, pager, hooks,
fsmonitor, optional index locks and prompts, refuses effective partial/promisor configuration and
ambient Git overrides, and checks object sizes before bounded body reads. Commands have 30-second
timeouts. It applies stable descriptor/path/stat checks to single-link regular files and refuses
aliases or observed changes. Native executable-mode evidence on Windows is unsupported and fails
explicitly; offline schema checks do not waive that limit. Dependency injection is a direct
source-code test seam; the CLI exposes no mock/executor/filesystem/environment switch.

Bounds are 10,000 tracked files, 20,000 tree/worktree entries, depth 32, name 255 UTF-8 bytes, path
4096 bytes, commit 1 MiB, tree 4 MiB, blob 16 MiB, total Git/tracked bytes 128 MiB, and bridge JSON
4 MiB. Metadata and raw-body batches are bounded before collection. Oversize or partial reads fail
without truncating or deleting retained evidence. JSON must match canonical producer bytes, with
strict UTF-8, no BOM/duplicate members and a final newline.

From the repository root, after the coordinator freezes and supplies the exact identities:

```sh
node scripts/source-inventory-bridge.mjs observe --commit="<frozen-commit>" --tree="<frozen-tree>" --output=validation/source-bridge.json
node scripts/source-inventory-bridge.mjs verify --commit="<same-frozen-commit>" --tree="<same-frozen-tree>" --input=validation/source-bridge.json
```

There is no HEAD fallback or pin derived from input evidence. Output is exclusive, synced/closed
under canonical excluded `validation/`; existing or partial evidence is retained. Verification does
not write a replacement. These commands read source only: no checkout, build, package, product,
soak, runtime profile, network or CI operation follows.

Two consistent passes establish observed consistency, not an atomic filesystem snapshot, future
immutability, producer authentication, executed-source/loader proof or final artifact provenance.
Final composition must be frozen and rechecked before later runs; any source change invalidates the
bridge. Actual package/runtime/loader identities, reviewed per-GC policies and calibration,
full-product metrics/coverage, 30 minutes and 100 measured cycles per mode, and real cleanup remain
separate held obligations. Neither synthetic fixtures nor an isolated source bridge closes them.
