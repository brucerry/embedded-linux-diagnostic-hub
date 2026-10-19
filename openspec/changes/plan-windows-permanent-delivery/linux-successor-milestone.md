# Linux successor/Finalize increment and remaining delivery scope

Implementation stays in
`C:/Users/bruce/Desktop/Codex/2026-10-13/task/linux-successor-draft/workspace`. Its baseline is the
frozen 24-file AppDir packet already under independent review, not a qualified commit. The original
repository, the earlier mirror, Windows fix packet, main-only history, v0.5.2 assets/tags and the
user's four-line live test are preserved. Target remains one combined v0.6.0; no public adoption or
publication occurs here.

## Serialization blocker addressed in source

The reviewed stale-lock race was real: the on-disk read/dead-owner/unlink/create sequence alone
cannot serialize two workers. Linux now requires a separate atomic kernel reservation keyed by
canonical root/current UID before stale inspection or any transaction mutation. The reservation
remains held through lock release and is automatically released when its owning process exits. It
exposes no request protocol or TCP service. Cooperating new workers cannot reach stale-file
inspection together. Owner metadata/inode changes during inspection and owner identity changes
during release refuse instead of unlinking a replacement. Native identity is resolved before
exposing the fresh file. An interrupted takeover before fresh creation can retry; unidentifiable
partial metadata is preserved and explicitly refused rather than guessed or deleted. That
fail-closed state remains a recovery limitation to qualify, not proof of complete power-loss
recovery.

Regression evidence includes two actual SetupTransaction instances contending for one stale owner,
unchanged winner bytes while the loser is refused, changed owner identity, interruption, and a
separate synthetic Node child's death releasing the real local IPC reservation. On this Windows
executor the transport is a task-owned named pipe; actual Linux abstract-socket/UID acceptance is
separate. No speculative timeout adjustment is used.

## Successor observation and Finalize

The normal installed Linux Electron main process offers only a pending-transaction observation
endpoint. It reports its own native PID/executable/creation/start ticks,
installation/digest/version, canonical default profile, native window handle,
visible/non-minimized/responsive state and trusted main-frame load state. It accepts one bounded
authenticated read-only request; no commands, path setters, renderer readiness claims or
acknowledgement writes are exposed. Frames are bounded to 16 KiB, concurrent clients to eight,
request processing to bounded timeouts. A fresh random nonce and HMAC bind each reply. The endpoint
closes on pending identity change/removal, app/window exit or a ten-minute maximum lifetime; it is
not a persistent debugger/service.

The external worker checks current UID, `/proc` executable/start identity, and that the reported
process actually owns the exact listening socket inode via `/proc/net/unix` and `/proc/PID/fd`.
Normal invocation checks reject Electron Node mode, nonempty NODE_OPTIONS,
script/debug/sandbox-override arguments and foreign-profile options. Environment contents are not
reported or logged. Missing inspection access fails closed without host-policy changes.
Authentication protects the local capability/endpoint relationship; it is not publisher signing or
security isolation from a user who controls their own app and environment.

Linux Finalize acquires the per-root reservation before preparing its acknowledgement. The
acknowledgement uses the observed app PID, never the worker PID. The shared engine requires fresh
matching observation, rechecks candidate ownership/bytes and native state under the guard, then
persists the confirmed cleanup decision/ledger before deleting only declared previous payload.
Missing, stale, hidden/minimized, unresponsive, custom-profile, wrong-process or corrupt-candidate
evidence keeps previous bytes. Interrupted confirmed cleanup resumes its declared ledger.
First-install confirmation is offered as well as update confirmation. The normal reviewed
maintenance action list now includes Remove for an owned installation; removal retains
profiles/reports and uses the same guarded engine. No silent CLI apply mode was added.

Source/protocol models and actual synthetic Node child IPC are separate from native Electron
acceptance. A read-only native checker is prepared at `scripts/linux-native-successor-smoke.mts`; it
emits no capability key and writes no acknowledgement or cleanup. On a separately prepared native
candidate:
`tsx scripts/linux-native-successor-smoke.mts --root ABSOLUTE --app-data ABSOLUTE --version PRIVATE_VERSION`.
It must be run as the ordinary Linux x64 user while the candidate's normal default-profile window is
visible.

## Two agreed Linux layouts, using existing assets

| Layout           | Existing asset and durable entry                                                        | Purpose and remaining work                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permanent AppDir | Existing tar.gz extracted once into owned ROOT/app; fixed app/diagnostic-hub and AppRun | Recommended for repeated launch without extraction/FUSE. Current isolated implementation, successor/cleanup and review still need actual native packaging, GUI/TTY, desktop identity, profile and interruption qualification.                                                                                                                                                                           |
| Managed AppImage | Existing AppImage retained as a verified durable file in an owned registered root       | Optional registration/maintenance of that exact image with a dedicated installation/profile identity and owned menu entry. This remains unimplemented. It needs its own mounted/extracted runtime-to-durable-image identity, checksum/version/process/shortcut/manual-update/rollback contract before startup refusal can be removed. It does not inherently avoid extraction when FUSE is unavailable. |

Existing portable AppImage/tar downloads remain the compatibility routes, not another new installer.
Managed AppImage must not silently become a third extracted-cache/AppDir variant. If normal
AppImage/FUSE behavior is unavailable, show its actual limitation and the explicit supported
portable extraction or AppDir choice; do not install FUSE, change permissions, spoof APPIMAGE, or
disable sandboxing. No .deb/.rpm/Flatpak/Snap or extra release asset format is proposed. AppDir
automatic installed updates remain unqualified; verified manual maintenance is the current contract.

## Native qualification path and actual blockers

1. Independent review must accept the serialization fix and observer trust boundary before source
   adoption or native packaging. Use only the bounded incremental patch, never copy either entire
   mirror.
2. On the approved existing Linux x64/free environment, inspect a fresh pinned ordinary package for
   links/special modes/runtime capability before enabling the private folder capability. Keep
   package SHA/descriptor/source/version evidence together. Do not rewrite host or security modes to
   force a pass.
3. Use one fresh task-owned root and isolated XDG data/config locations. Test GUI and /dev/tty
   review/cancel/headless/piped-input/timeouts with literal Unicode/quotes/percent paths and no
   mutation before consent. Recheck original directory/format/download-only intent.
4. Run real install -> normal default-profile launch -> read-only native checker -> reviewed
   Finalize. Independently observe native X11 and Wayland presentation/responsiveness;
   protocol/model fields are insufficient to qualify actual windows. Verify endpoint closure after
   confirmation and no persistent service.
5. Run private distinct-version update and same-version Repair, current-profile/report content
   hashes and UUID preservation, native owner/hidden/minimized/custom-profile/Node-mode/socket-owner
   refusals, candidate corruption, busy retained slots and concurrent workers. Verify old bytes
   remain until genuine confirmation, and exercise real interrupted
   takeover/cleanup/rollback/removal without terminating unrelated processes.
6. Normal Remove source is now offered; offline installed launch remains durable. Bounded offline
   maintenance/discovery and multi-install selection are still unfinished, as is managed AppImage
   registration. Offline Repair needs separately verified local setup material; do not trust partial
   cache metadata or infer installed ownership from a pathname.

This executor is Windows: actual Linux `/proc` listener ownership, pinned Electron windows, GUI/TTY,
packaging/runtime/sandbox and lifecycle acceptance cannot be completed here. A Linux-only kernel
primitive test is explicitly platform-skipped. Native application performance, power-loss recovery
and public v0.6.0 qualification are not claimed.

The tar fixture now records child status/signal/error details and refuses process errors/signals
before evaluating archive acceptance. Its 15-second deadline and all archive-validity assertions
remain unchanged. The prior concurrent-run deadline attribution remains plausible, not proven; both
the original failure and unchanged successful isolated/ordinary rerun evidence remain retained.

Fresh direct confirmation for the bounded Windows install/launch test was accepted. The source guard
was reconciled to the exact independently reviewed d0cbd47/setup SHA
6d1c96c660c732eca52e2556658429b0b62526a1899ffd1196710b2421557526 with unchanged
target/integration/profile effects and retained receipts. A first harness run stopped before Apply
because of an old UI Automation path-value check. After that guarded correction, one actual Apply
failed before activation: Electron treated resources/app.asar as a virtual directory, so the
physical-file guard refused it. Actual read-only application-mode and Electron Node-mode probes
confirmed the view mismatch against the exact compiler ASAR checksum. No installed
target/UUID/Diagnostic Hub profile/launch occurred. Only the attested setup process was terminated
after its error-modal cancellation failed; existing profile inventory was unchanged, contents not
inspected. No uninstall/permanent cleanup/device access occurred. The actual blocker is a reviewed
physical-filesystem adapter and sealed payload refresh, not missing approval. Exact receipts:
native-install-approved-current-outcome.json/.md, native-electron-asar-fs-proof.json and
native-electron-node-mode-asar-proof.json. The current Linux worker design also needs the
physical-filesystem fix before native adoption; its Electron Node mode still exposes the virtual
ASAR view.

Primary references: Node v24 IPC/abstract socket behavior
https://raw.githubusercontent.com/nodejs/node/v24.0.0/doc/api/net.md ; Linux kernel userspace socket
table format https://man7.org/linux/man-pages/man5/proc_pid_net.5.html ; Electron native process
creation API https://www.electronjs.org/docs/latest/api/process#processgetcreationtime . These
establish API contracts, not native acceptance of this draft.

Checkpoint verification: 59 scoped tests, 57 passed, zero failed, two explicit Linux-native skips;
tar diagnostics test passed alone with its unchanged deadline; typecheck/format and
desktop/preload/worker source compilation pass. No native Linux application acceptance is claimed.
The 17-file incremental patch applies cleanly to the frozen prior AppDir mirror; both
mirrors/original source remain separate.
