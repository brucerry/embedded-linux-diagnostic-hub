# Production qualification

The delivery formats are **one portable `.exe` for Windows 10/11 x64** and **a Linux x86_64
AppImage**, with a portable archive alternative. The repository's v0.1 artifacts remain engineering
previews until platform and hardware qualification is complete.

## Distribution contract

- Users copy/download `Diagnostic-Hub.exe` and double-click it.
- Launch requires no Node.js, Python, development SDK, separate SSH client, administrator rights or
  installer.
- The embedded runtime extracts to a temporary directory; per-user trusted host keys persist in
  application data. This is a single-file distribution, not a promise of zero filesystem writes.
- SSH use requires a reachable target SSH service, valid device credentials and tools supplied by
  the firmware.
- Linux users run the AppImage with `--appimage-extract-and-run` or an extracted archive's `AppRun`,
  without FUSE or an application installer. Missing system libraries trigger a prerequisite prompt;
  installing packages may require `sudo`. Download and normal launch remain unelevated.
- Windows/Linux 32-bit and ARM desktop binaries are not shipped. See [downloads.md](downloads.md).
- Release updates use manually checked, SHA-256-verified replacement executables with explicit
  restart; unattended updates are not enabled. Qualify update/relaunch on clean Windows/Linux
  machines alongside cold launch.
- Native Windows builds apply product metadata and release signing. Unsigned cross-builds are for
  engineering evaluation.

## Runtime matrix

Terminal qualification also requires PTY/shell permission checks, Unicode/ANSI output, multiline
paste, Ctrl+C, resize, tab retention, concurrent diagnostics, outer-shell recovery after
exit/logout/Ctrl+D, nested-shell exit, bounded recovery failures, and cleanup on
reconnect/import/update. Exercise OpenSSH and firmware-provided Dropbear on actual nominated
devices. Automated loopback SSH fixtures verify protocol and application behavior; they do not
establish real-board compatibility.

| Environment                        | Required checks                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Windows 10 22H2 x64, standard user | Cold launch on a clean PC, password/key authentication, native dialogs, export, restart, close while connected   |
| Windows 11 x64, standard user      | Same checks; 100/125/150/200% display scaling; high DPI and multi-monitor layouts                                |
| Offline Windows PC                 | Reports and LAN SSH without internet; no runtime downloads                                                       |
| Restricted corporate PC            | Temporary extraction and execution, endpoint protection, application data permissions, signed publisher identity |
| Non-ASCII Windows username/path    | Launch, private-key selection, report export and trusted key persistence                                         |
| Ubuntu 22.04 x86_64, standard user | Download/launch without FUSE or elevation, accepted/declined prerequisite prompts, SSH, reports and close        |
| Debian x86_64, standard user       | Same checks; desktop session and sandbox support; offline reuse after initial setup                              |
| Connection faults                  | Unreachable address, wrong credentials, unknown/rejected/changed host key, dropped link, timeout and reconnect   |
| Authentication                     | OpenSSH/Dropbear password, RSA and Ed25519 keys, encrypted key passphrases, unsupported key errors               |

Use actual Windows 10/11 and Linux desktop machines/VMs for this matrix. Windows runner CI and Linux
development tests alone do not establish both operating systems' compatibility.

## Target-device matrix

Validate at least one Ubuntu systemd target, one Debian systemd target, and one OpenWrt
BusyBox/Dropbear/procd target. Include an unprivileged user, a restricted root account, absent
tools, denied kernel logs, firmware without `/etc/os-release`, read-only filesystems and low
writable-overlay space. Add a vendor BSP before making any compatibility claim for it.

Compare raw outputs and parser results to a direct SSH session. Confirm unsupported capabilities
remain `Unavailable`, failures remain `Error`, and no writes, package installations, reboots or
privilege escalation are performed. Hardware-specific modules require their own real-device
acceptance criteria.

## Release preparation

1. Complete the Windows, Linux client and target-device matrices and save versioned evidence.
2. Resolve remaining product gaps for the selected release scope; evaluate font size/contrast and
   keyboard/screen-reader usability with engineers.
3. Use a release signing certificate and timestamp the executable. Check the final signature on
   Windows. Protect signing credentials in the build environment.
4. Record the exact Electron/dependency versions, include appropriate third-party notices, and
   review the software bill of materials.
5. Produce the SHA-256 checksum and verify a copied executable on a clean machine. Preserve the
   tested build rather than rebuilding it after qualification.
6. Publish operator instructions explaining host identity verification, snapshot timing, unavailable
   checks, logs/addresses in reports and data-directory locations.

Actions builds and uploads verified artifacts; a matching version tag invokes the release workflow
to publish them. Workflow checks do not establish full production qualification. Signing credentials
and physical/VM test devices are not supplied by this repository.

## Signing and Windows launch warnings

The current portable executable remains unsigned. No code-signing certificate was found in the
repository or Windows Personal certificate stores, and local `CSC_LINK`/`CSC_KEY_PASSWORD` are not
configured. Signing needs an authorized certificate with its private-key provider, or an approved
signing service; the application cannot create a publicly trusted publisher identity itself. The
existing Windows build workflow accepts `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` secrets
for supported certificate signing through electron-builder. Token/HSM/cloud signing needs the
appropriate provider integration rather than exporting or committing a private key. Sign both the
embedded application executable and portable wrapper, timestamp them, verify the signatures, and
calculate the final checksum after signing.

A trusted Authenticode signature identifies the publisher and protects integrity. It does not
guarantee that every Windows warning disappears: newly signed applications can still lack
SmartScreen reputation, and executable launch from a UNC share such as
`\\wsl.localhost\Ubuntu-24.04\...` may produce a security-zone warning. For local engineering use,
copying the EXE to a normal Windows directory may avoid the UNC-location prompt; this is not a
signing or public-distribution substitute. No security-zone policy, certificate trust store or
SmartScreen setting is changed by this project.

Self-signed certificates are useful only on explicitly managed/test PCs that trust them; they do not
establish public trust. For public single-EXE distribution, use a trusted CA code-signing
certificate or eligible signing service. Qualifying open-source projects can apply to SignPath
Foundation; approval is not assumed.

Official references:
[Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options),
[SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation),
[SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool),
[SignPath Foundation](https://signpath.org/).

Inspect a release on Windows:

```powershell
Get-AuthenticodeSignature .\release\Diagnostic-Hub.exe | Format-List Status, StatusMessage, SignerCertificate
```
