# Build, deployment and releases

## Local builds

```sh
npm ci
npm run build
npm start
npm run build:web
npm run package:gateway
npm run package:win
npm run verify:package
npm run package:linux
npm run verify:linux
npm run package:web
npm run package:launchers
npm run checksums
```

Run portable packaging on Windows for release qualification and signing. The desktop output is one
`release/Diagnostic-Hub.exe`; Windows users do not need `win-unpacked/` or Node.js. Linux users
receive `Diagnostic-Hub-linux-x64.AppImage` or a portable archive. The Windows portable manifest
requests user privileges. Linux extraction avoids FUSE and uses no administrator launch. Missing
Ubuntu/Debian libraries trigger an explicit prerequisite installation prompt, separate from normal
execution; package installation can require `sudo`. See [download commands](downloads.md). Temporary
extraction and per-user trusted SSH key storage still require writable host directories. Do not ship
an old executable alongside the current one.

Unsigned Linux/WSL cross-build:

```sh
npm run build
npm run build:web
npx electron-builder --win portable --x64 -c.win.signExecutable=false -c.portable.useZip=true --publish never
npm run verify:package
npm run checksums
```

This preserves icons/metadata but does not replace a Windows runtime test. In WSL, use native
Windows PowerShell to run the packaged checks from [the development guide](development.md).

## Workflow structure

| File                                     | Responsibility                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `.github/workflows/verify-website.yml`   | Reusable Linux formatting, types, unit/SSH and browser verification; website and gateway build artifacts |
| `.github/workflows/github-pages.yml`     | PR/main/manual website checks; deployment only on `main` after verification                              |
| `.github/workflows/windows-portable.yml` | PR/main/manual and reusable Windows checks; package, inspect and run the actual portable executable      |
| `.github/workflows/linux-portable.yml`   | Ubuntu 22.04 x64 build; inspect AppImage/archive, run packaged SSH tests with sandboxing enabled         |
| `.github/workflows/release.yml`          | Version tag validation; invoke all verified builds; verify asset checksums and publish Releases          |

Each release publishes the exact Windows and Linux artifacts tested by their build jobs, without
rebuilding in the publish job. Only publishing has `contents: write`; Pages deployment has its own
`pages: write` and `id-token: write`. PR runs do not publish or deploy. Build artifacts are
available from Actions even without a release tag.

## One-time repository setup

1. Enable Actions and choose **Settings → Pages → Build and deployment → Source → GitHub Actions**.
   Review the `github-pages` environment so only `main` can deploy.
2. Optionally configure signing secrets `WINDOWS_CSC_LINK` (the certificate accepted by
   electron-builder) and `WINDOWS_CSC_KEY_PASSWORD`. Store signing material in secrets, never the
   repository. A configured certificate must produce a valid signature or the Windows job fails.
3. Allow release publication by the workflow's scoped `GITHUB_TOKEN`. Repository/organization
   policies must permit the requested permissions. Restrict release tag creation to maintainers.
4. Deploy the gateway separately following [gateway.md](gateway.md), with a random team token, exact
   website origin, target allowlist and trusted device fingerprints.

The Pages URL is `https://brucerry.github.io/embedded-linux-diagnostic-hub/`. Production gateway
URLs must use HTTPS. Website and desktop assets share the renderer, but only the desktop works
offline.

## Publish a release

After source changes have been committed, reviewed and pushed:

1. Set the intended semantic version in `package.json`, synchronize `package-lock.json` with
   `npm install --package-lock-only`, and record validation/known limitations.
2. Wait for main-branch checks to pass. Tag the reviewed commit with the exact manifest version:

    ```sh
    git tag -a v0.2.0-rc.1 -m "Diagnostic Hub v0.2.0-rc.1"
    git push origin v0.2.0-rc.1
    ```

3. The release workflow repeats website, Windows and Linux verification for that tag, then publishes
   `Diagnostic-Hub.exe`, Linux AppImage/archive, portable website ZIP, gateway archive, download
   helpers and their SHA-256 checksums. `build-info.json` and `linux-build-info.json` identify the
   source commit, architecture and Windows signing status. Versions with prerelease suffixes are
   marked prereleases; a plain version tag publishes an official release. Release notes identify
   unsigned engineering builds explicitly.
4. Inspect the Release assets and test downloaded packages on the intended Windows and Linux
   desktops, including Ubuntu 22.04. Review [production qualification](production.md) before
   declaring production readiness.

A mismatched tag fails before packaging. Asset checksum/commit mismatches fail before publication.
Existing release versions are not overwritten; use a new version for corrected builds. If
publication fails, investigate before retrying and check whether GitHub already created the release.

## Release notes

The publish job checks out the full history and reads the paginated GitHub Releases API. It uses
**the most recently published release**, including prereleases, as the baseline; drafts and
unreleased Git tags are excluded. Every commit in `previous-release..new-tag` appears on the new
GitHub Release page, including direct commits, branch commits and merge commits. The generated notes
group conventional commit subjects, link each commit and include the full comparison URL. With no
previous release, the notes cover the history through the release tag.

Use informative commit subjects such as `feat: add smart update recovery`,
`fix: retain SSH after RAM reset`, or `docs: explain update modes`. Add concise user-facing
highlights and validation limits in `docs/releases/<tag>.md` when useful; the workflow combines them
with package/signing information and the complete commit list. It fails if the published baseline is
missing from the checkout or is not an ancestor of the new tag, rather than publishing an incomplete
comparison. Publication is serialized so overlapping tag runs do not race when selecting the
baseline.

A normal branch push runs verification and Pages deployment. A version-tag push also builds and
publishes a Release with these notes. Commit the version and highlights before creating the tag. Do
not move an already-published tag. The proposed next release is `v0.2.0-rc.1`, with `v0.2.0`
reserved for the accepted feature release.

## Maintenance

Update Pages automatically through reviewed `main` changes; use a new version tag for desktop
updates. The portable updater includes prereleases by default, verifies the published SHA-256
checksum and uses per-user storage without elevation or system installation.

| Update choice                | Report behavior after restart                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Cancel update                | Keep the current connection, live updates and RAM data unchanged.                                               |
| Update without saving        | Start with empty RAM; do not create a report backup. Older saved files and trusted fingerprints remain.         |
| Save report & update         | Save the latest report in `update-reports`, then start empty. The backup path is shown for manual import.       |
| Save, update & reopen report | Save the report and automatically import it as historical evidence, with live updates off and SSH disconnected. |

If no report exists, every update mode starts empty. Starting an update pauses live collection,
waits for active collection to finish, disconnects SSH and blocks new connections throughout the
transaction. A backup failure prevents download/restart; a failed download keeps a completed backup
and leaves SSH disconnected for an explicit retry. Cancel before starting changes nothing. The
native process owns the transaction; the renderer cannot supply executable or backup paths. Report
backups use the normal bounded JSON report format and exclude connection credentials. Graph history
is held in RAM and is not part of the saved report. Recovery markers are acknowledged only after
loading; backup files remain available for later manual import.

The original executable is retained: future launches should use the downloaded version or a manually
replaced portable executable. No update check runs at startup. Linux AppImage launches use
extraction to avoid requiring FUSE. The red RAM reset control retains SSH, waits for collection,
clears the current snapshot/history and resumes live updates only if previously enabled.

CI prepares the gateway package but does not install it on the lab server. Follow the gateway guide
for server updates and token/pin rotation. Keep long validation history out of the README.

References:
[GitHub custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
[reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[GitHub CLI release creation](https://cli.github.com/manual/gh_release_create).
