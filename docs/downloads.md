# Download and run

Download helpers fetch the newest published release with the appropriate desktop asset, including
engineering prereleases. They verify its SHA-256 checksum before replacing a previous download or
launching it. Both the executable and its checksum come from the same release tag.

These commands become available after the source is pushed to `main` and a release is published. Run
them as your ordinary desktop user; no application installer, Node.js or administrator launch is
needed. Unsigned Windows builds can still show a publisher warning.

## One-line commands

Windows 10/11 x64, in ordinary Windows PowerShell 5.1 or newer:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/brucerry/embedded-linux-diagnostic-hub/main/public/download-run.ps1).Content))
```

Linux x86_64, from a terminal in a graphical desktop session:

```sh
bash -c 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/brucerry/embedded-linux-diagnostic-hub/main/public/download-run.sh | bash'
```

The Linux helper extracts the AppImage for execution, avoiding FUSE installation and mount
permissions. It removes that temporary extraction after the application closes. The verified
AppImage remains available for later offline use. Downloads require internet; subsequent direct SSH
sessions do not.

## Missing prerequisites

Windows packages include Electron and the application dependencies. Windows 10/11 supplies the
PowerShell, TLS and system facilities used by the helper; a separate JavaScript runtime is not
required.

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

## Platform coverage

| Client                                           | Delivery                       | Qualification                                                                           |
| ------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| Windows 10/11 x64                                | `Diagnostic-Hub.exe`           | Existing Windows 11 launch checks; Windows 10 acceptance remains separate               |
| Ubuntu 22.04 / compatible Debian x86_64 desktops | AppImage or `.tar.gz`          | Ubuntu 22.04 CI build/runtime checks prepared; real-PC acceptance pending               |
| Other glibc Linux x86_64 desktops                | Same Linux packages            | Requires compatible libraries and desktop sandbox support; distribution testing pending |
| Windows 10 x86 / Linux i686                      | Website                        | Current Electron runtime has no 32-bit build                                            |
| Windows 11 x86                                   | Website                        | Windows 11 has no 32-bit OS edition                                                     |
| ARM PCs, musl Linux, headless hosts              | Website in a supported browser | No native package shipped for these clients                                             |

The SSH target can use a different CPU architecture and Linux distribution from the client PC. There
is no promise that one glibc binary works on every Linux distribution or version.

References:
[Electron 44 supported platforms](https://github.com/electron/electron/blob/v44.5.1/README.md),
[Windows 11 requirements](https://www.microsoft.com/en-us/windows/windows-11-specifications),
[AppImage extraction without FUSE](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

## Choose a version or download only

Download the helpers from the same repository or a release, then use their options:

```powershell
./download-run.ps1 -Version v0.1.0 -DownloadOnly
./download-run.ps1 -Version v0.1.0 -Directory "$env:USERPROFILE\DiagnosticHub"
```

```sh
bash download-run.sh --version v0.1.0 --download-only
bash download-run.sh --version v0.1.0 --format tar.gz --directory "$HOME/DiagnosticHub"
```

Default download locations are `%LOCALAPPDATA%\DiagnosticHub\downloads\<tag>` on Windows and
`${XDG_DATA_HOME:-$HOME/.local/share}/DiagnosticHub/downloads/<tag>` on Linux. Files are stored
under the current user rather than Program Files or system directories. Executable downloads do not
contain SSH credentials or device reports.

For offline Linux launch, use the downloaded AppImage:

```sh
chmod u+x Diagnostic-Hub-linux-x64.AppImage
./Diagnostic-Hub-linux-x64.AppImage --appimage-extract-and-run
```

Alternatively extract the `.tar.gz` archive into a user-writable directory and run its `AppRun`.
Keep the extracted application directory together; the archive is portable but its ELF executable is
not a single self-contained file.

## Portable website

Download `Diagnostic-Hub-Web-<version>.zip`, extract it and serve the contents with any static
HTTP(S) host, at a root or nested path. Client browsers require no application installation. See
[website.md](website.md) for HTTPS gateway origins and hosting details.
