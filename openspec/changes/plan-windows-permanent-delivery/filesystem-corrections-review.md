# Filesystem corrections — bounded source review

Status: two separate, unadopted source increments are ready for independent review. No private
installer has been rebuilt or retried. The last real Apply failed before target activation; its
payload, logs, compiler receipt and native outcome remain retained. Fresh approval covers the same
disposable Windows install/launch scope after correction; approval is not the blocker. Uninstall,
permanent deletion, device access and release publication remain outside this run.

## A. Physical filesystem in Electron

Baseline: the original working tree at
`C:/Users/bruce/Desktop/github/embedded-linux-diagnostic-hub`, main HEAD
`2f84f429214633374e56159296b87c188d64c5f2`, with its previously accepted uncommitted source.
Candidate: `C:/Users/bruce/Desktop/Codex/2026-10-13/task/physical-fs-draft/workspace`.

Packet: `physical-fs-review.json` and `physical-fs-review.patch`: **10 files, 17,182 patch bytes**,
SHA-256 **639d9445743c070ad2b24aec2c60b510045327876257878efdffc529ec41bd7b**. `git apply --check`
passed against the stated baseline; nothing was applied there.

`electron/physical-fs.ts` selects ordinary Node's native filesystem outside Electron and Electron's
built-in `original-fs` inside Electron, including its Node mode. Loading failure propagates; there
is no fallback to the virtual archive view in Electron. `createRequire(process.execPath)` keeps the
runtime built-in out of the application bundle without changing esbuild flags or adding a package.
No global `process.noAsar` setting is changed.

Seven existing modules change only their filesystem import/binding source:

| Module                   | Physical operations covered                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| setup-transaction        | Payload inventory, regular-file checks, byte hashing, lock/journal handles, free-space checks and transaction identity |
| setup-paths              | Ancestor/leaf identity, exclusive copy/write, rename, unlink and bounded directory removal                             |
| installation-maintenance | Sync startup ownership checks, bounded metadata and atomic acknowledgement/journal writes                              |
| installation-startup     | Installed root, executable, metadata and dedicated-profile identity                                                    |
| installation             | Declared payload verification, including stream hashing of the actual ASAR bytes                                       |
| setup-channel            | Bounded channel file handles and parent/leaf identity                                                                  |
| setup-worker             | Extracted source and integration metadata identity/digests and worker-owned staging                                    |

The regular-file, single-link, alias, ownership, hash, inventory, exclusivity and review-token
guards are unchanged. Normal Electron archive reads remain virtual. The frozen Linux candidates are
not merged into this baseline: when adopting their separate increments, preserve these physical
bindings in shared modules. Linux-only native adapters still require their own Linux qualification;
this packet does not claim such qualification or rewrite unrelated application/SSH/report filesystem
I/O.

Evidence:

- `native-electron-asar-fs-proof.json` and `native-electron-node-mode-asar-proof.json`: the
  unchanged failed payload's actual ASAR is a virtual directory through both patched APIs, but a
  physical, single-link regular file with the exact compiler checksum through `original-fs`.
- `physical-fs-electron-tests.log`: **3/3 passed**, including actual pinned Electron **44.5.1** in
  application and Node modes. Both modes passed 12 checks: virtual member reads retained; physical
  sync/promises; synthetic transaction install/copy/hash; owned inventory; stream-hash installed
  verification; startup identity; unknown-content refusal; exclusive-copy refusal; hardlink refusal;
  ancestor-alias refusal; physical unlink; corrupted-payload refusal. No native registration,
  Diagnostic Hub execution or BrowserWindow was used. Only disposable synthetic fixture bytes and
  dedicated temporary Electron profiles were created.
- `physical-fs-focused-tests.log`: **50 total, 49 passed, 0 failed, 1 platform skip** across
  existing setup path/channel/transaction, installed identity/startup and successor tests.
- `physical-fs-typecheck.log`: `tsc --noEmit` exit 0; `physical-fs-format.log`: all ten files
  passed.

Platform qualification: ordinary Node fallback and actual Windows x64 Electron modes are verified.
Linux/macOS Electron installer lifecycle and packaged application behavior remain
native-unqualified. The test's Windows-layout transaction and integration callbacks are synthetic;
they are not a native installer, OS shortcut/registry test, real launch or performance measurement.

The selected API is documented by
[Electron's ASAR filesystem guidance](https://www.electronjs.org/docs/latest/tutorial/asar-archives).
The
[pinned 44.5.1 wrapper](https://github.com/electron/electron/blob/v44.5.1/lib/node/asar-fs-wrapper.ts)
also shows the `lstat` and promises virtualization. The retained runtime proofs, rather than the
documentation alone, establish the failure on this exact installed runtime.

## B. Linux metadata FIFO refusal

Baseline: the frozen 17-file successor candidate at
`C:/Users/bruce/Desktop/Codex/2026-10-13/task/linux-successor-draft/workspace`; its original review
patch remains **f801d7e37f41cae1cfc66106b15c6056dd168065fe1ba10b40f8053dd62f5bf3**. Candidate:
`C:/Users/bruce/Desktop/Codex/2026-10-13/task/linux-fifo-fix/workspace`.

Packet: `linux-fifo-review.json` and `linux-fifo-review.patch`: **2 files, 4,257 patch bytes**,
SHA-256 **c62a10fc1f96930df054f9abf9b2842ec6167c86fe514b78885d58872c8bff83**. `git apply --check`
passed against the frozen successor candidate; nothing was applied there.

`privateLinuxMetadata` adds `O_NONBLOCK` to the existing `O_RDONLY | O_NOFOLLOW` open. A FIFO opened
for reading can therefore reach the existing `fstat` rejection without waiting for a writer. The
nonregular handle is rejected before any read, and `finally` still closes it. UID, permissions,
single-link, bound, before/after inode/device/timestamp/size and parent-identity checks remain
intact. The observer protocol and its existing two-second deadline are unchanged.

The added Linux-only regression replaces a private journal path with a real mode-0600 FIFO and runs
the production reader in an isolated child with **the same two-second timeout**. No FIFO writer is
opened. The child must reject the nonregular handle itself and leave the FIFO present. An old
blocking open causes a bounded failure and child termination, rather than hanging the test runner.

`linux-fifo-focused-tests.log`: **15 total, 12 passed, 0 failed, 3 Linux-only skips** on Windows.
The FIFO, private Linux metadata and `/proc` listener-ownership tests are explicitly skipped; none
is presented as native acceptance. `linux-fifo-typecheck.log`: exit 0. On the next ordinary-user
native Linux host, run the focused tests before packaging/GUI qualification and retain the actual
FIFO result. Native GUI/TTY, abstract sockets, process visibility and complete lifecycle remain
pending.

## Preservation and next steps

`filesystem-corrections-preservation.json` records original source hashes, the user's unchanged
`tests/ui/live.spec.ts` hash, unchanged prior 24/17-file review candidates, the retained failed ASAR
and compiler receipt. The user test was not copied into either new mirror. Main, release history,
published assets, helper contracts, normal user profiles and source adoption remain unchanged.

1. Independently review A and B against their different stated baselines. A supersedes the physical
   view in the shared setup modules; B follows the reviewed Linux successor increment.
2. Adopt only reviewed changes and preserve both sets of guards when combining the Linux source.
3. Rebuild a fresh private Windows payload and installer, seal exact source/runtime/manifest/ASAR
   and installer hashes, and review the refreshed receipt. Do not reuse d0cbd47 or infer runtime
   equivalence for this actual application-code change.
4. Correct the harness's owned-error-modal detection and cancellation without broad process control
   or deadline increases. Then perform only the still-approved isolated install and launch, verify
   its own registration/shortcut/profile and executable bytes, and preserve the earlier failure.
5. Execute the native Linux FIFO regression and remaining Linux package/window/profile/successor
   gates on a suitable host. Offline discovery and managed AppImage scope remain unfinished.

No v0.6.0 publication is qualified by these source/model results.
