# Download and run

Choose a package for the computer running Diagnostic Hub. The SSH target may use a different CPU
architecture or Linux distribution. Desktop packages include Electron and the application runtime;
Node.js is needed only for development. Use your ordinary desktop account.

Windows and Linux helpers select the newest published release with a compatible asset, including
prereleases. The Mac helper selects latest stable by default. All helpers verify the app's SHA-256
checksum from the same release tag before replacement or launch. Downloading needs internet;
subsequent direct SSH sessions can work offline.

## Platform coverage

| Client                                            | Delivery                                | Qualification                                                                                       |
| ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Windows 10/11 x64                                 | `Diagnostic-Hub.exe`                    | Existing Windows 11 launch checks; Windows 10 acceptance remains separate                           |
| Ubuntu 22.04 / compatible Debian x86_64 desktops  | AppImage or `.tar.gz`                   | Hosted build/runtime and seven GNOME compositor cases pass; real-PC acceptance pending              |
| Other glibc Linux x86_64 desktops                 | Same Linux packages                     | Requires compatible libraries and desktop sandbox support; distribution testing pending             |
| Windows 10 x86 / Linux i686                       | Website                                 | Current Electron runtime has no 32-bit build                                                        |
| Windows 11 x86                                    | Website                                 | Windows 11 has no 32-bit OS edition                                                                 |
| Windows/Linux ARM PCs, musl Linux, headless hosts | Website in a supported browser          | No native package shipped for these clients                                                         |
| macOS Intel / Apple Silicon                       | Complete native x64 / arm64 `.app` ZIPs | Native macOS 15 CI; runtime minimum in manifest; browser-quarantine/physical-Mac acceptance pending |

One glibc binary cannot be assumed to work on every Linux distribution or version.

References:
[Electron 44 supported platforms](https://github.com/electron/electron/blob/v44.5.1/README.md),
[Windows 11 requirements](https://www.microsoft.com/en-us/windows/windows-11-specifications),
[AppImage extraction without FUSE](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

## One-line commands

These commands download, verify and launch the appropriate package. For a browser download, choose
the same package and checksum from
[the latest release](https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest).

### Windows installation and launch

Windows 10/11 x64, in ordinary Windows PowerShell 5.1 or newer:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/brucerry/embedded-linux-diagnostic-hub/main/public/download-run.ps1).Content))
```

Windows packages include Electron and the application dependencies. Windows 10/11 supplies the
PowerShell, TLS and system facilities used by the helper; a separate JavaScript runtime is not
required.

The portable app is one `Diagnostic-Hub.exe`; no application installer or administrator launch is
required. Unsigned builds may show an unknown-publisher warning. The helper retains the verified
download under the current user's application data directory.

### Linux installation and launch

Linux x86_64, from a terminal in a graphical desktop session:

```sh
bash -c 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/brucerry/embedded-linux-diagnostic-hub/main/public/download-run.sh | bash'
```

The Linux helper extracts the AppImage for execution, avoiding FUSE installation and mount
permissions. It removes that temporary extraction after the application closes. The verified
AppImage remains available for later offline use.

Linux packages include Electron but still need a compatible glibc graphical desktop and its system
libraries. The packaged `AppRun` checks missing shared libraries before starting. On Ubuntu/Debian
it lists known prerequisite packages, displays the proposed `sudo apt-get install` command and asks
**Install these prerequisites now? [y/N]** when a terminal is available. Installation proceeds only
after an explicit yes and the libraries are checked again. Declining leaves the system unchanged.
With no terminal, it prints the instructions and stops rather than installing silently.

Normal downloading and application launch do not request administrator permissions. **Installing
missing system packages is separate and may require `sudo` or a system administrator.** Clients
without that permission can use the website or ask their administrator to prepare the dependencies.
Other distributions and unknown libraries receive package-manager guidance rather than guessed
installation commands. No sandbox, security policy, namespace setting or file permission is changed
automatically.

The Linux download command itself requires Bash, curl and the standard `sha256sum`/`mktemp`
utilities. If curl is absent, download the helper and AppImage through your browser instead; package
installation cannot be offered by a script that has not yet been downloaded.

For offline Linux launch, use the downloaded AppImage:

```sh
chmod u+x Diagnostic-Hub-linux-x64.AppImage
./Diagnostic-Hub-linux-x64.AppImage --appimage-extract-and-run
```

Alternatively extract the `.tar.gz` archive into a user-writable directory and run its `AppRun`.
Keep the extracted application directory together; the archive is portable but its ELF executable is
not a single self-contained file.

### Mac installation and launch

Intel x64 or Apple Silicon arm64, in Terminal:

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/download-run-macos.sh | /bin/bash'
```

The Mac helper installs the complete native `.app` into `~/Applications`, verifies same-release
ZIP/checksum/manifest and bundle integrity, and requests a normal launch. It uses built-in macOS
tools, including Bash 3.2; translated Apple Silicon terminals still select arm64. Quit the app
before rerunning for a manual update. In-app automatic installation is unsupported. Apps are ad-hoc
signed, not Developer ID signed or notarized; macOS/managed policies may block launch. See
[Mac installation, minimum OS and Gatekeeper guidance](macos-qualification.md).

## Missing prerequisites

Windows runtime prerequisites and Linux dependency handling are covered in their installation
sections above. For Mac minimum OS, bundle integrity and launch policy, see
[the Mac qualification guide](macos-qualification.md). Normal downloading and launch use the current
user; Linux system-package installation is a separate operation requiring explicit consent.

## Choose a version or download only

Download the helpers from the same repository or a release, then use their options:

```powershell
./download-run.ps1 -Version v0.3.1 -DownloadOnly
./download-run.ps1 -Version v0.3.1 -Directory "$env:USERPROFILE\DiagnosticHub"
```

```sh
bash download-run.sh --version v0.3.1 --download-only
bash download-run.sh --version v0.3.1 --format tar.gz --directory "$HOME/DiagnosticHub"
```

```sh
/bin/bash download-run-macos.sh --version v0.4.0 --no-launch
/bin/bash download-run-macos.sh --version v0.4.0 --directory "$HOME/My Applications"
```

Mac installs into `~/Applications/Diagnostic Hub.app` by default; keep the full bundle together. The
installer preserves app user data and restores the old bundle on failed replacement.

Default download locations are `%LOCALAPPDATA%\DiagnosticHub\downloads\<tag>` on Windows and
`${XDG_DATA_HOME:-$HOME/.local/share}/DiagnosticHub/downloads/<tag>` on Linux. Files are stored
under the current user rather than Program Files or system directories. Executable downloads do not
contain SSH credentials or device reports.

## Portable website

Download `Diagnostic-Hub-Web-<version>.zip`, extract it and serve the contents with any static
HTTP(S) host, at a root or nested path. Client browsers require no application installation. See
[website.md](website.md) for HTTPS gateway origins and hosting details.
