# Local acceptance — 2026-10-12

- In-place terminal reference: v0.2.0-rc.2 / 3e96ba2 (PTY 17e3ac4 and workspace 08cf3f9). Targeted removal retains later clock, scrollbar and history fixes; no rollback occurred.
- Original three user-edited files match their recorded SHA256 values. Historical release source notes, saved reports and released assets are untouched.
- Unit suite: 108 total, 98 passed, 10 platform/optional skips, zero failures. An initial new fixture authentication-count assumption was corrected; final full run passes.
- Browser suite: 87 passed, one failure at obsolete Tests navigation, one optional Bash skip. All nine adapted clock cases pass; all eight final workspace cases pass. No other browser failure remained.
- Production website: Chromium, Firefox and WebKit each pass nested/mobile/navigation/remaining gateway behavior (3/3).
- Typecheck and desktop/web/gateway builds pass. Windows standard native window runner passes 100 resize/maximize/minimize/restore cycles, renderer responsiveness/crash checks, single window and unchanged SSH/PTY ownership. The isolated current unpacked package passes real bridge/SSH/clock/report/reset/update smoke; its ASAR matches built bundles and excludes Genie/Koffi/Tests IPC/DT parser. Icon/signature editing was deliberately skipped for this validation-only package; existing release CI retains those gates.
- Downloader, Linux launcher and GNOME harness bash syntax pass using retained qualification bash. No installs or board operations occurred.
- Exact OS workflow matrix is retained: windows-latest; ubuntu-22.04 packaging/Xvfb; GNOME 42 Ubuntu22.04 Wayland/X11, GNOME46 Ubuntu24.04 Wayland/X11, GNOME50 Ubuntu26.04 Wayland, GNOME48 Debian13 Wayland/X11. Linux compositor/packaging execution is awaiting hosted gates; no local acceptance is claimed.
- OpenWrt Invalid DT property was user-reported, not reproduced or fixed. Remaining runtime source and built app/gateway graphs do not import the retired parser. Pure offline historical schema tests remain. Report & Evidence navigation remains retired; no persisted view/deep-link restoration was added.
- Future release generator has exact-tag titles and only Description/Changes/Commits/Links, includes all commits since the prior published release (RC8 currently), and preserves qualification/signing caveats. Published pages are untouched.

Supporting logs and preservation receipts are in C:/Users/bruce/Desktop/Codex/2026-10-11/task/removal-*. Historical unique uncommitted experiments are in retired-uncommitted-diagnostics-2026-10-12.zip with a SHA256 manifest. The superseded custom-tests plan is archived at 1/36 without syncing specs.
