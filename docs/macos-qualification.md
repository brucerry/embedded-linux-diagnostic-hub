# macOS installation and qualification

Download the complete
[Intel x64 app](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/Diagnostic-Hub-macos-x64.zip)
or
[Apple Silicon arm64 app](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/Diagnostic-Hub-macos-arm64.zip).
Each release includes a ZIP checksum and architecture-specific source/version manifest. Keep the
entire extracted **Diagnostic Hub.app** together; a bare executable cannot run without its
frameworks and resources. No Node.js, Rosetta installation or administrator installation is
required.

## Install and launch

From Terminal as your ordinary user:

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/download-run-macos.sh | /bin/bash'
```

The helper selects the latest published stable release and native Intel or Apple Silicon
architecture, including an Apple Silicon Mac running a translated terminal. It uses macOS Bash 3.2
and built-in tools, checks the bundle's minimum OS against your Mac, verifies its ZIP, manifest,
ASAR, native binaries and ad-hoc signature, and installs into `~/Applications/Diagnostic Hub.app`.
It requests a normal macOS launch. Internet is needed for downloads; subsequent local SSH use works
offline.

Download the helper from the same release to choose options:

```sh
/bin/bash download-run-macos.sh --version v0.4.0 --no-launch
/bin/bash download-run-macos.sh --version v0.4.0 --directory "$HOME/My Applications"
```

## Manual updates and failures

Quit the app, then rerun the helper. Mac in-app automatic installation remains unsupported. The
helper refuses to replace a running app. Download/verification failures preserve the current app;
failed or interrupted replacement restores it. Settings, trusted fingerprints and saved reports live
outside the bundle and are not removed. Use `--no-launch` to install for manual launch. If a new
installation's launch is refused, the verified app remains available; an update restores its prior
bundle. Do not run with sudo or replace an installation directory/app that is a symlink.

## Gatekeeper and managed Macs

These apps have **ad-hoc integrity signatures**. They are **not Developer ID signed or notarized**;
the signature verifies bundle integrity and does not establish Apple trusted-publisher status. The
helper preserves quarantine and Gatekeeper settings. A browser-downloaded ZIP may receive quarantine
and be blocked even when command-line CI launches successfully.

If macOS reports an unidentified/unverified developer, review the source and checksum first. For a
trusted, intact app, Apple's supported explicit approval is **System Settings > Privacy & Security >
Open Anyway**, when available after attempting to open it. Follow the confirmation prompts yourself.
If macOS reports malware or a damaged/modified app, stop and obtain a verified download; do not
bypass the warning. Managed-device policy may prevent approval: ask your administrator or use the
website. See [Apple's opening-app guidance](https://support.apple.com/en-us/102445).

For a checksum, architecture or source mismatch, leave the existing app intact and obtain the ZIP,
sidecar and manifest from one release tag. A too-old macOS fails before installation; the minimum
version in the manifest is runtime metadata, not evidence that every older supported Mac was tested.
Electron 44 requires
[macOS Ventura 13 or newer](https://github.com/electron/electron/blob/v44.5.1/README.md); the bundle
explicitly records 13.0.0. Launch failures also require a graphical desktop session. The helper
never changes Gatekeeper, removes quarantine, installs system software or changes device policy.

## Hosted qualification and limits

Read-only main/PR CI uses standard public `macos-15-intel` x64 and `macos-15` arm64 runners, without
Mac Actions binary artifacts or caches. A shared action builds complete ad-hoc bundles, verifies
source bytes and ZIP extraction, exercises real native installer failures/rollback, and runs the
full browser, SSH/PTY/clock/reset/trust/security checks and 100 native-window/terminal cycles.
Windows/Linux coverage and deadlines, including seven GNOME cases, remain intact.

New-tag release jobs use only the existing job token to stage their verified ZIPs privately. They
check anonymous API/download denial and source ownership. Publication depends on all platform gates
and complete asset/hash/source verification. Dependent native jobs then download the actual
published helper and verify its installed, normally launched app through CDP and packaged SSH smoke.
They add no Mac Actions artifact/cache storage or paid service. Release staging is not an account
billing audit.

Logs record actual OS, architecture and source SHA. Hosted command-line evidence does not qualify
Safari quarantine/Gatekeeper, managed-device acceptance, older macOS, physical Macs or physical
embedded devices. Those acceptance checks remain separate. Earlier qualification at
`e769b7b2c3dbb315d46916aa329b3ff5153161cc` passed macOS 15.7.9 x64/arm64 and 100 cycles; that
historical increment produced no public Mac package. Every later source/tag must pass its own gates.
