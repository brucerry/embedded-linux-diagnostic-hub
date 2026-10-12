# macOS qualification

The macOS workflow qualifies x64 on the standard macos-15-intel runner and arm64 on standard
macos-15. It runs only for a public repository, uses read-only workflow permissions, disables
setup-node caching, uploads no binary artifacts and performs no publishing.

Each architecture builds an ad-hoc signed app directory, verifies native executable/framework
architecture, signature integrity and packaged-source bytes, then runs controlled
SSH/PTY/clock/reset/trust/security and native-window/terminal checks including 100 cycles. Existing
Windows and Linux workflows, including all seven GNOME cases, remain unchanged.

Automatic installation through the existing Windows/Linux updater is explicitly unavailable on
macOS. The release link remains available; this increment creates no public Mac download, Mac
release, notarization or Developer ID enrollment. The bundle's ad-hoc signature verifies integrity
and is not a trusted-publisher or notarization claim.

Hosted runner-local launch does not qualify browser-download quarantine/Gatekeeper behavior,
managed-Mac policies, older macOS versions or physical embedded-device operation. Actual runner
OS/architectures and source SHA are recorded in logs. Both macOS 15.7.9 jobs passed at
`e769b7b2c3dbb315d46916aa329b3ff5153161cc`, including 100 native cycles on each architecture. Any
later release commit must pass its own qualification before publication.

Release v0.2.0's first attempt encountered Windows ERR_NO_BUFFER_SPACE during navigation, a GNOME 50
renderer restore-notification count mismatch after successful native state cycles, and website
dependency-download cancellation near its timeout. Its unchanged second attempt passed, but did not
establish or cure these root causes. The separate restore-notification candidate is not included in
this work.

## Prerequisites for a separate Mac distribution

Before public Mac assets are added, provide separate Intel x64 and Apple silicon arm64 download
links and explain how to select the architecture. Document installing the complete app bundle,
quarantine/Gatekeeper behavior and any unsigned or unnotarized warnings using the actual downloaded
build. An ad-hoc CI signature does not establish trusted distribution.

Document manual replacement updates and the unsupported automatic-install path, tested macOS
versions and architecture limits, and troubleshooting for launch, quarantine and managed-device
policies. Confirm those instructions against browser-downloaded builds on the intended Macs. This
release provides CI evidence only; those downloads and acceptance checks require separate work.
