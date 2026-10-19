# Linux portable guided adapter review

Four-file incremental patch and exact source hashes: linux-guided-review.patch/json. The adapter
preserves version/format/directory/download-only, adds no-launch/terminal review, pins the same
release's tag/source/checksum/build metadata, and requires explicit GUI or controlling-terminal
consent before saving. Save is default; Open is explicit. Piped stdin never supplies approval. No
GUI/TTY produces pinned manual alternatives.

This increment is portable delivery only. The saved AppImage remains durable but extracts on each
run; tar extraction is temporary. There is no permanent managed/folder installation, installed
identity, profile migration, XDG shortcut, discovery, owned removal or automatic installed update.
Existing different bytes are retained and refused. Managed AppImage startup remains explicitly gated
in Electron. Full guided permanent Linux delivery is still outstanding.

The corrected, independently accepted Mac ancestor/stage guard module is reused with GNU stat. Every
reviewed ancestor and owned stage device/inode is checked at mutation boundaries. Missing
directories are created one component at a time; activation exclusively links a new verified package
into an absent final filename on the same filesystem. Identity failures preserve all scratch/stage
artifacts. Tar Open requires bounded plain-file/directory inventory, safe unique paths and no
links/devices/special modes. Both listing streams stop at their output bounds. No dependencies, host
permission policies, FUSE or sandbox settings change. Fresh shell checks do not constitute an OS
sandbox or eliminate every concurrent same-user check/use race.

Bounded mocked proof: the initial eight-test helper suite passed with zero skips, plus the
full-helper Review substitution regression and seven-case tar inventory regression, each passed with
zero skips. The subsequent escaped-Unicode metadata-key regression passed. Exact bytes, selected
source commit, no unsolicited launch/sudo, cancellation/no UI, foreign-file preservation and
pre-creation parent replacement are asserted. These Windows Git Bash tests use fake network,
dialogs, platform and executable payload; actual Linux GUI/AppImage readiness is not claimed.

The earlier ENOENT was reproduced independently: MSYS converted literal < and > into U+F03C/U+F03E
on Windows, while native Node could not find the literal filename. linux-msys-path-translation.json
records requested/native names and byte proof. Windows fixture names now use valid characters while
preserving Unicode, quotes, ampersands and literal $(); Linux names retain angle brackets, and GUI
module tests separately assert markup escaping. Security/byte assertions were retained.

Combined source formatting passed for all 315 supported files in Git's tracked/nonignored inventory.
Ordinary npm run verify stopped on 27 existing local-only OpenSpec planning files; passing
.git/info/exclude directly to Prettier also did not produce repository-relative ignores. Both
outcomes are retained, no configuration changed, and the exact Git inventory check is recorded
separately. TypeScript, Git Bash syntax and strict OpenSpec 20/20 passed. Desktop, web and gateway
builds passed without packaging over release/. Full unit totals are recorded in
combined-guided-regression-result.json after completion.

The separate combined-guided-regression-plan.md prepares native Linux and Intel/Apple Silicon Mac
acceptance using existing public/free workflows, without dispatching or publishing. Actual GUI/TTY,
native Bash 3.2/BSD stat, bundle replacement/interruption/policy, Linux package/policy and permanent
layout gates remain pending.

Windows: automatic review denied the isolated native install/launch despite forwarded implementation
approval. Direct confirmation for that exact isolated action is requested and pending; no retry or
alternate route occurred. This is separate from accepted source and native presentation/probe/cancel
evidence.

The combined run exposed one stale global profile-path prohibition in
tests/retired-features.test.ts. A separate one-file follow-up now checks the actual retired
window-identity module while retaining endpoint prohibitions; no product runtime changed. Focused
retirement/startup checks pass 13/13. Exact patch/hashes: retired-profile-regression.patch/json. The
full unit suite was repeated after the correction. GUI unit wrappers are mocked as well as dialogs,
so Mac unit hosts need not have GNU timeout; the outer spawn remains bounded. See
linux-portable-gui-unit.log.

Final combined result: 331 passed, 0 failed, 12 platform skips (343 total). Source formatting
315/315, TypeScript, Git Bash syntax, strict OpenSpec 20/20 and all three builds passed. Exact
result and skipped test names: combined-guided-regression-result.json. No command remains running,
source hashes still match, main/user live-test hash preserved.
