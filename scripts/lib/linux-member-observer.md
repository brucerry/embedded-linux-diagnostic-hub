# Actual archive-member observation source (not executed or qualified)

The existing explicit packager now exposes observeReviewEnvelope(input, records,
window). No ordinary afterPack/download/prepare/helper path calls it. Source uses
existing plan/identity/readback helpers and the original owner request/clock window;
it introduces no trust issuer, signing requirement, external service or installer.

The exact already-selected tar.gz is opened as an owned single-link regular file,
nonfollow/nonblocking. Before/descriptor/path-after identities and declared length
are checked. Its exact compressed stream is hashed while Node Gunzip derives tar
bytes. rejectGarbageAfterEnd:true and full bytesWritten accounting enforce the
single gzip/no trailing-data policy; Node validates gzip framing/deflate/CRC/size.
Those pinned Node/zlib semantics are UNEXECUTED here and deliberately covered by
synthetic cases before future real use. No private Node API, shell/tar command,
archive filesystem extraction, acquisition, writes, launches or bindings are used.

A small strict POSIX ustar parser reads512-byte headers and64KiB body chunks.
Portable writer all-NUL UID/GID and directory mtime are accepted only as omitted,
non-identity metadata; nonblank forms remain strict octal. Mode/size/checksum and
file mtime always require numeric digits, without a broad blank-number fallback. It
checks unsigned header checksum, magic/version, octal numeric fields, reserved/link/
device fields, UTF8 paths, NFC duplicates, traversal, file-directory collisions,
explicit parent directories and regular/directory types. GNU/PAX/sparse/extensions,
links/special/shared-write modes, unsupported layouts, directory bodies, missing
ends, nonzero padding/trailing data refuse. File content SHA256 is computed as body
bytes arrive, never from a declared manifest. The established electron-builder tar namespace has exactly the selected asset stem
Diagnostic-Hub-linux-x64 as an outer directory. Raw canonical names are validated
BEFORE mapping, that exact root directory is required, and exactly one prefix is
removed for the flat ROOT/app payload. Wrong/mixed/sibling/flat roots, traversal,
NFC duplicates and file/directory collisions refuse before/after mapping. Actual
raw census/root/mode/hash/count facts remain explicit in archiveMapping; only the
payload census is compared with the flat plan/tree. The wrapper consumes one
existing directory/entry quota and its real header/expanded/control bytes; no bound
is increased. This is producer-source compatibility, not real artifact acceptance.

Existing limits stay: compressed/archive and regular payload each<=2GiB,<=20000files
and20000directories/40000entries,64KiB chunks,<=4MiB census/control/descriptor,<=8KiB
summary. Expanded overhead is derived from those header/member-padding counts plus
<=10240byte tar end padding. Raw bodies are never retained or returned. Codec heap,
syscall stalls, full physical memory and termination are not hard-bounded.

Actual member census is mapped through the exact validated wrapper and every
mapped hash/length/mode/directory must match the flat inventory before tree IO.
PreparedROOT/app file hashes/modes/directory census, actual ELF/product/version/
capability and private exact descriptor reads are checked. Every captured leaf,
directory, archive, descriptor and record identity is rechecked at completion.
Original same-owner <=120sec request/window is never reset; each IO submission and
returned value is gated. Newly returned handles/allocated paths and completed-close
facts are registered before post-return gating. Unknown/failure stops/freezes the
adapter and retains buffers/handles, without retry/kill/delete/destroy fallback.
Native codec/Readable internals may perform normal in-memory resource transitions;
no explicit stream.destroy or filesystem cleanup is called. Late error handlers
remain nonthrowing. An unref memory timer stops stream flow on logical expiry; a
stalled IO can still remain held beyond it. Normal read-handle closes are allowed
only while the owner remains admitted; no physical closure proof is inferred.

Both actual selected-release and linux-build-info bytes are bounded<=64KiB and
hashed against independently selected expected record digests. Repository/tag,
resolved40hexcommit, version, Linuxx64 identity, exact archive asset URL/hash/length
are compared with the existing plan. Build metadata remains unsigned publisher
integrity; matching sourceCommit is not compiled-source provenance or independent
signing. No record is fetched here, no trust Boolean is accepted, and absent/stale/
mismatched facts fail. Record paths are explicit home-owned nonoverlapping inputs.

Output is an unqualified observed-members receipt and a separate bounded summary.
Full combined evidence must fit4MiB. No automatic evidence-file publication is
implemented; future outer capture/publication needs reviewed admission. The real
handoff still refuses provenance-unavailable and native/mutation dispatch remains
disabled pending independent producer, actual cohort/observation and native review.

Proposed21 tests use synthetic ustar/gzip buffers, native in-memory Node zlib/streams,
fixed/mocked owner clocks and fake async iterators plus pure selected-record/member/
descriptor validation. There is no real archive/record/tree read, disk factory,
ASAR parser, process/UID query, artifact preparation or app execution. Standard codec
threadpool/memory contexts and unref timers/ordinary runner worker IPC are part of
the proposed reviewed effects; paused failure contexts remain privately retained.
The file/count boundary definitions parse finite synthetic headers, not a soak.
No tests/typecheck/build or source parser invocation occurred in this preparation.
Historical incident OPEN and old failures/seals are unchanged. Existing test export
expectation gains only the new opt-in read-only API; prior counts are not inherited.

R1/R2 correction source: app-builder-lib26.15.3 tar() uses portable:true and the
selected output asset basename as prefix; node-tar7.5.22 omits UID/GID and directory
mtime in zero-filled header fields. The synthetic additions manually encode these
reviewed writer forms, never invoking the packager/tar writer. AO16 verifies body
hashes/records/raw-to-flat preservation through a synthetic gzip stream; AO17 keeps
required fields and malformed optional forms refused; AO18 exercises exact-root,
mixed/extra/traversal/alias/count negatives. The R1/R2 predecessor preserved the original fifteen callback bodies. This
count-classification successor splits AO7 into independent payload/file-count/
directory-count/control cases, retaining every original threshold and assertion. Unsupported GNU/PAX/link forms remain explicit limitations. Real codec,
input-cohort/FS/archive compatibility and native qualification remain unproved.

Count-reason correction: file-count overflow now reports TAR_COUNT in its own
branch; payload single/aggregate byte overflow stays TAR_PAYLOAD_CAP. The same
increment and all quotas/refusals are preserved. AO7 payload, AO19 regular count,
AO20 directory count and AO21 control are separate node:test registrations, so a
failed assertion cannot hide the later cap cases. Predecessor17/18 failure is
retained unchanged; this successor/21-title selection has NOT been executed.
