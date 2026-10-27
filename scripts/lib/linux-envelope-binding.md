# Archive → prepared tree → descriptor binding gate (source only)

The existing linux-build-info.json is unsigned release integrity/source metadata:
version, commit and asset hashes. It does not record verified archive members,
stable prepared-tree identities or a descriptor commitment. Current contracts and
retained evidence provide no qualified producer/admission for that association.
No archive, extracted tree or native artifact was acquired, read or prepared here.

The existing packager's explicit reviewEnvelopeHandoff(input, observation) therefore
refuses provenance-unavailable. Extra payload trust booleans, signatures or verifier
arguments cannot enable it. It never forwards a caller-supplied admission port.
Ordinary afterPack/prepare APIs, portable formats/defaults/version/cache/download
behavior and public/helper mutation gates are unchanged. No new trust store,
signing requirement, key, credential, security policy or service is introduced.

inspectLinuxArchiveTreeBinding is a data-only source contract. It reuses the
accepted envelope planner; checks exact archive path/hash/length; checks a closed
regular-file/directory member census against the selected inventory and observed
prepared ROOT/app tree; refuses links/special modes/path aliases/duplicates/extras;
and binds the exact ROOT payload descriptor text, hash, bytes, version and commit.
Stable, ordinary-UID, safe-integer dev/ino before/after identities bind archive,
prepared-tree root and private descriptor. Original owner request id and a single
<=120sec same-owner clock interval bind the observation; expiry/future/backwards
samples refuse. File hashes/membership/stat receipts are observations supplied by
a future qualified observer, not independently established by this pure function.
No per-file atomicity/kernel/FS/heap/physical-time promise follows.

A separately injected inert source-model admission must echo the exact complete
binding fingerprint, request id, source commit and deadline in a closed record.
Malformed/boolean/selfqualified/mismatched/stale records refuse. Model admission
is NOT trusted provenance. Even matching model output is source-model-bound,
provenance:injected-model-only, qualification:unqualified and handoffAllowed:false.
No code path returns a qualified artifact or launch permission. This deliberately
leaves real provenance unavailable instead of treating checksums or caller fields
as a bypass. Input JSON can never manufacture a qualified admission.

Future work needs an independently reviewed archive-membership/tree observation
producer and exact provenance/admission facts under the existing release/input
trust policy before real helper dispatch can be designed/admitted. It does not
require inventing independent signing as a new release prerequisite. Builds,
actual source/package provenance, archive/tree association, native packaging and
binding/runtime/fuse/FS/kernel/menu/successor/lifecycle qualification stay open.

Twelve new exact tests are definitions only: pure metadata/synthetic stat/clock
objects, strings, buffers, hashing and inert admission callbacks. The existing
packager export is exercised only to verify its default refusal. The concrete
disk module is imported for existing pure stat comparators, but its factory/FS
methods and nested ASAR parser never run. No timers/listeners/subprocesses/fixture
cleanup are defined. Prior18 tests are not rerun or inherited; their LE14 exact
export-list assertion is updated solely for the additive refusing export.
Independent review of the exact loader-free command/import graph precedes tests.
