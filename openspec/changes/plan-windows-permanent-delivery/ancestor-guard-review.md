# Setup ancestor boundary review

The latest P2 is addressed across analogous operations, not only the reported rmdir. A new shared
setup-paths module checks the full existing parent chain to the filesystem root, rejects
reparse/symbolic aliases, verifies the canonical parent and leaf kind/link count, and then performs
the single mutation. All transaction, metadata, channel and worker unlink/rmdir/rename operations
use it. Destructive calls occur after the fresh busy check, so the tested substitution during
process inspection is revalidated. No recursive directory removal is introduced.

The same audit covers related writes: source copy uses COPYFILE_EXCL after source/destination parent
validation; direct new metadata writes are exclusive; each created directory parent is checked and
the stage leaf is created exclusively; metadata replacement guards both paths and refuses
aliased/nonregular destinations; opened temporary metadata handles have a checked parent before
creation. Worker shortcut writes check parents directly before the shell call, and optional
unselected/unowned Desktop shortcuts are skipped. The existing channel inode/ownership checks remain
in addition to the shared mutation guard. AppData uses its known canonical OS path; no host
permission, execution policy or security exemption is changed.

Real owned NTFS fixtures now insert a nested junction between deletions, including the exact
intermediate-parent rmdir case, removal's separate payload unlink loop and a substitution during
busy inspection. They assert that outside empty directories and same-name files remain unchanged,
retain verifiable recovery journals/ledgers, undo only test-created aliases and resume cleanup.
Shared-helper tests cover all analogous mutation types and existing destination preservation. The
earlier 27 child-death cases remain passing.

Affected suite: 59 total, 58 passed, one pre-existing Mac-native skip, zero failures; typecheck
passed. Exact logs: ancestor-guard-typecheck.log and ancestor-guard-tests.log.
setup-mutation-boundary-audit.json confirms no direct unlink/rmdir/rename/copyFile/writeFile/mkdir
primitive calls remain in the four callers; only the shared boundary module performs those
primitives. Handle writes and the checked exclusive worker temp-directory creation are recorded
separately. This is operation-boundary validation, not a claim of an OS sandbox against arbitrary
same-account syscall races.

New private runtime source 869d7d7ae88e30162046af670b9591f0957b6961, actual version 0.5.2, ASAR
6260feab22daf630a1d260480801370d88d2d7f9afa474331a278bb2aa1a368c, includes the new shared guard. It
is unexecuted. Current-source NSIS compilation is pending; the earlier 5ddfa609 setup compiler
completed successfully, but that artifact predates this fix and must not be used for destructive
acceptance. Nothing here represents a public 0.6.0 build or native mutation qualification.

The latest exact-production read-only CIM benchmark uses this frozen source on synthetic owned
rollback paths: baseline 109.7 ms, inspected cleanup 11235.2 ms, 24 fresh queries and 12 individual
deletions. Median query 452.8 ms. Applying that median to the full inventory yields approximately
52.5 seconds of inspection only, an arithmetic projection rather than native setup timing. No cache,
check removal or race-opening optimization was added. Receipt: setup-inspection-timing.json; exact
AST extraction and synthetic harness: benchmark-setup-inspection.mts in the task root.

Review delta: ancestor-guard-review.patch, seven source/test hashes in ancestor-guard-review.json;
baseline verified against independently reviewed private 5ddfa609b5be2238082576cfd0c7b877404f32b7.
Main/release refs and separate user live test edit are preserved. Native destructive tests remain
blocked on independent review; non-mutating presentation/cancel/probe is permitted but not claimed
executed in this packet.

Compiler completion: current ancestor-fixed private source 869d7d7ae88e30162046af670b9591f0957b6961
compiled with /WX, exit 0, zero warnings. Setup SHA256
bb8ea8f734b239107402c2b4a9b7c686e9a597f11165d8c155ff305dfbf31193, 236661132 bytes; all 101
descriptor entries reverified. ASAR
6260feab22daf630a1d260480801370d88d2d7f9afa474331a278bb2aa1a368c. Actual version 0.5.2, release
scope 0.6.0; unexecuted, with no native installer acceptance or public release claim. Receipt:
current-setup-compiler-receipt.json (also in the runtime output directory).
