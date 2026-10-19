# Combined regression and native platform qualification plan

Current production version remains 0.5.2; the selected combined release target is 0.6.0. This plan
does not authorize publication, workflow dispatch, runner charges, dependency installation on the
user host, physical ports, host-policy changes, or Windows native install retries.

## Local combined checkpoint

1. Preserve HEAD 2f84f429214633374e56159296b87c188d64c5f2, immutable historical tags/assets, and
   tests/ui/live.spec.ts SHA256 07dd490a4abff47fc24fcd86ceb63a3ff5fa0d7605b427420a08c1af2043376b.
2. Check source formatting using the Git tracked/nonignored file inventory and existing
   .prettierignore. Passing .git/info/exclude directly to Prettier does not give repository-relative
   ignore semantics. Ordinary npm run verify currently sees 27 private OpenSpec planning files and
   stops there. Retain that failure; do not present it as passed or edit formatter/CI configuration
   merely to hide it. Clean CI source excludes those private files.
3. Run typecheck and the full unit suite, retaining totals, skips, duration and exit status. Keep
   Linux-only old prerequisite tests separate from the new helper's no-sudo contract. Windows tests
   use Git Bash/GNU utilities, not native Linux qualification.
4. Run npm run build, build:web and build:gateway without packaging into release/. Preserve existing
   release assets. Do not launch a new user preview.
5. Validate all existing OpenSpec specs/changes in strict mode. Freeze hashes and exact incremental
   patches for independent review before any consolidated push. Separate accepted Mac/Windows
   increments from the Linux patch.

## Linux prototype scope and limits

The current adapter saves an explicitly reviewed portable AppImage or tar.gz package. It preserves
version, format, directory and download-only flags, adding no-launch and terminal review. GUI Save
is default; Open is an explicit choice. It verifies pinned release metadata, selected tag/source,
checksum and linux-build-info.json together. Metadata is bounded; malformed, duplicate, unsupported
escaped keys and mismatched identities refuse. Download-only alone can report an explicitly
checksum-only legacy download when source metadata is unavailable.

This is not permanent managed/folder installation: there is no installed record, new profile, XDG
integration, discovery, owned removal, offline-maintenance menu or automatic installed update.
Existing different bytes are preserved, not repaired/updated. A durable AppImage still extracts per
run; tar extraction is temporary and only requested after Open. The native startup managed-AppImage
refusal remains in place.

Corrected Mac path guards are reused with GNU stat. Before directory creation, copy/chmod, exclusive
activation and cleanup, check canonical reviewed ancestors and stage device/inode. A mismatch
preserves artifacts. Final-file creation requires a same-volume exclusive hard link; unsupported
filesystems refuse with a readable alternative. Fresh checks do not eliminate every same-user
check/use race or create an OS sandbox.

No actual application runs in mocked tests. Network, dialogs, uname and payload are fixture shims;
required shim paths are asserted. Exact payload bytes, absence of sudo/launch, foreign-file
preservation and Review parent substitution are checked. MSYS translates Windows-invalid angle
brackets to U+F03C/U+F03E, documented in linux-msys-path-translation.json. Windows fixture names use
legal characters; Linux names retain literal angle brackets and GUI module tests still check markup
escaping.

## Native Linux gates, after review

Use the existing public/free Linux workflow as the baseline; do not silently broaden runner scope or
dispatch. First run deterministic tests on native GNU tools as a normal user. Existing
linux-portable.yml already builds/validates AppImage and tar.gz, tests unpacked/AppImage startup and
distinct future AppImage handoff, and records linux-build-info.json. Later reviewed integration
should reuse that exact source/asset identity rather than publish unfinished work or test unrelated
public bytes.

Qualify real Zenity and Kdialog text/path readability, keyboard focus, default Save, Cancel/timeout,
no-launch and explicit Open. Independently qualify /dev/tty via util-linux script PTY, with piped
stdin never consent; no GUI/no TTY must terminate with pinned manual alternatives. Mocked dialog
return values are not native GUI evidence. Qualify actual source/hash preservation, normal-user
permissions, noexec and missing tools/libraries, unsupported archive/link/mode inventory, hard-link
refusal, literal paths and parent/stage substitution. Do not install dependencies or weaken policy
as a response to a product refusal.

Open actual AppImage/tar only from task-owned roots and isolated existing portable profiles, with
normal sandbox/policy intact. Observe PID, executable/AppImage path, version and responsive visible
window separately from launch request. A new session blocks the historical packaged launcher from
obtaining the caller's controlling TTY for prerequisite installation; qualify that behavior
natively. Do not claim permanent-folder delivery or installed identity. Those remain separate
implementation and native acceptance gates.

## Native Mac gates, after review

The Mac ancestor/stage source fix is independently accepted at the three hashes in
macos-ancestor-review-acceptance.json; 14 tests pass with zero skips. Native Bash 3.2, BSD stat,
x64/arm64 bundle/framework links, actual Standard Additions GUI, controlling TTY, existing bundle
replacement, running refusal, rollback/interruption and normal policy remain pending.

Existing macos-qualification.yml and .github/actions/macos-build already select public/free
Intel/Apple Silicon runners, build/ad-hoc verify complete bundles, run installer/native window and
manual-update checks. The prepared installer smoke supplies mocked consent; it must not be labeled
native GUI acceptance. Published-consumer changes for >=0.6.0 are prepared only; historical
consumers retain their protocol. No published 0.6.0 consumer can be qualified before a separately
approved immutable release. Native UI automation cannot assume Accessibility/TCC approval or add
security bypasses. Quarantine, notarization, older macOS and physical hardware remain explicit
limits.

## Windows gate

The automatic reviewer denied isolated Windows install/launch despite forwarded implementation
approval. Direct confirmation for that exact isolated action is requested and pending. No further
retry, alternate route, real install, registry/shortcut mutation, uninstall or deletion is
authorized by this plan. Accepted native presentation/probe/cancel evidence is separate from native
lifecycle qualification.
