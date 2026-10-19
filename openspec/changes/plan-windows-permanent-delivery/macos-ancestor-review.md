# Mac ancestor/stage follow-up

Three-file incremental patch/hash packet: macos-ancestor-review.patch/json, against the preceding
Mac review prototype. The reviewer reproduced writes before ancestry refusal and pattern-only
cleanup. Both reproduced paths now refuse before any mutation in zero-write source-phase tests.

Canonical existing/missing components are bound before Review. Missing destination directories are
created one component at a time only after the entire snapshot matches. Every exclusively created
stage and top-level bundle root is bound to device/inode. Output creation, extraction/copy,
activation and recovery use fresh canonical ancestry checks. Same-volume directory moves require
exact source identity and an absent destination, then update the bound paths. Cleanup checks all
known stage roots and ancestors plus the original stage device/inode; any mismatch preserves
artifacts and refuses cleanup/recovery moves. Initial legitimate Mac ancestor aliases are
canonicalized before binding; verified internal bundle framework links remain supported.

Fourteen tests pass with zero skips: seven guard/filesystem regressions (including actual
post-Review and cleanup source snippets), plus existing mocked consent and update-refusal tests.
Outside sentinel bytes and original artifacts survive replacement/junction cases; the positive
guarded activation/rollback removes only its own created stage. Typecheck, syntax and formatting
pass. Windows tests use GNU stat as the explicit test adapter; native Mac tests retain BSD stat and
canonical temporary roots. This is source/fixture evidence, not native Mac installation, native
dialog or complete power-loss recovery qualification. Fresh boundary checks are not an OS sandbox or
a guarantee against every concurrent same-user check/use race.

Windows real install/launch remains blocked pending direct user approval; no new attempt or
alternate route occurred. Linux will reuse the corrected guards with its GNU stat adapter. No
dependencies, host permissions, publication, tags or user profiles changed.
