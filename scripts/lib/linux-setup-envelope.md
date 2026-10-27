# Explicit read-only Linux review envelope preparation

This is NEW reconstruction source. No envelope has been produced or qualified by
this patch; no historical aggregate is recovered. `prepareReviewEnvelope` is an
explicit API on the existing review packager. Ordinary afterPack, public helper,
portable artifacts, catalogue and packaging scripts never call it automatically.

Inputs must name an already extracted flat portable tree, an existing tar.gz,
a distinct absent task-owned output root, current ordinary Linux x64 identity,
version, source commit and exact regular-file inventory/modes/hash. The expected
archive and inventory tuple must come from independent trusted verification.
This API verifies both against those expected facts; it does not parse/extract
the archive or derive/prove the inventory-to-archive association, publisher
identity or compiled-source provenance. A caller-provided commit is a binding
claim, not proof that the binary was compiled from it. No input may be silently
inferred from a filename or self-declared authentication boolean.

The existing shared installation validator supplies version/commit/path/duplicate/
file/total bounds. Preparation rejects non-Linux/root/foreign layouts, overlapping
or aliased roots, unexpected/reserved ownership content, links, special/shared-
write modes and missing runtime/AppRun/ASAR/review-entry/capability members.
The concrete adapter additionally checks actual ordinary-user filesystem identity,
exact bounded tree names, streamed hashes, ELF64 little-endian x86_64 header,
ASAR product/version, and closed review capability/entry identity. Directory and
file identities are rechecked. No Electron/ASAR virtual-filesystem mode is used.

Only after input checks does it create an exclusive new0700 ROOT/app tree, then
exclusive new files with the input's admitted modes, sync and exact readback.
It writes only the existing ROOT/diagnostic-hub-setup-payload.json grammar,
0600/exclusive, binding all app/... file lengths/hashes and declared source/version.
Output and original input identities are rechecked. Inputs are never changed;
partial/new roots/files are never deleted/restored/retried on refusal/uncertainty.
Allocated paths and uncertain handles remain privately retained by the adapter.
No application, shell, compiler, native binding, listener, extraction or downloader
is invoked. There are no timers, scans outside exact input ancestors/tree, signals,
permission/security-setting changes, ownership metadata, menu writes or cleanup.
New-file chmod only reproduces admitted modes on its own newly created output.

The result remains qualification:unqualified and installer mutation/nativeBinding
false. These flags do not mean preparation creates no files. The copied AppRun
stays exactly the portable preimage; installed launcher/maintenance/successor
qualification is a separate gated contract. A prepared review envelope may be
reviewed through its explicit app/diagnostic-hub Node-mode entry, after independent
runtime/fuse/architecture and input provenance acceptance; this patch does not
execute that entry or enable public dispatch.

Finite source limits: <=20,000 regular files, <=20,000 derived directories,
<=2GiB payload and archive each, <=4MiB descriptor, 64KiB streaming chunks,
<=4KiB capability and <=64KiB extracted package JSON. Core input strings are
bounded by existing path/version contracts. ASAR parser heap/header reads and
physical IO stalls are not hard-bounded. No live observation deadline is asserted;
a future authorized operation needs a reviewed outer owner/deadline/storage scope.
Maximum nominal byte reading is about14GiB (archive twice; source three times,
including copy; destination twice including copy readback/output verification),
plus bounded metadata/parser overhead; output <=2GiB plus descriptor. Independent
inventory/path loops add bounded metadata operations, not qualification timing.

The first fifteen definitions use fake host/IO/Map/Buffer facts only. Three E1
identity definitions add pure comparison/cache functions from the concrete adapter
module; its factory/IO and @electron/asar remain uninvoked (see E1 note below).
No tests/typecheck/build have been run during preparation. Default disk behavior,
crash durability, kernel races and runtime compatibility require separate review
and native qualification. Failure categories contain only fixed stage/status codes;
there is no raw exception output or automatic recovery.

E1 exact-identity correction: every cached or compared numeric lstat/fstat identity
must have safe-integer dev>=0 and ino>0. Unsafe64-bit-rounded, fractional, missing,
negative or coerced identities fail closed before cache writes or other identity
field comparisons. Later samples and both operands are checked too; all prior
file/mode/owner/inventory guards remain. The extended exact18-title plan imports
the concrete adapter module only for these pure identity functions. No adapter is
constructed and no filesystem method or ASAR parser is invoked. This changes the
reviewed import graph, so the earlier15-title admission does not authorize this
new command; independent review remains required before any execution.
