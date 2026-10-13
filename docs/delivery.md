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

Release validation requires the app, gateway, web and launcher assets with matching checksums and
source identity. Mac distribution includes native x64 and arm64 complete ZIPs, sidecars and
`macos-build-info-<arch>.json` (minimum OS, source, ASAR hash and ad-hoc signature status). Linux CI
retains its native compositor matrix. Historical published releases may include retired companion
ZIPs; they are not part of new builds.

Native Mac packaging on the matching architecture (Node.js 24, for development/CI):

```sh
npm ci
npm run build
node scripts/generate-macos-icon.mjs
npx electron-builder --mac dir --arm64 --publish never --config.mac.identity=- --config.mac.hardenedRuntime=false --config.mac.icon=release/macos-icon.png
node scripts/package-macos.mjs "release/mac-arm64/Diagnostic Hub.app" arm64
```

For Intel use `--x64`, `release/mac` and `x64`. The configured runtime minimum is macOS 13.0.0;
packaging does not qualify every supported older Mac. CI additionally runs installer controls,
packaged SSH checks and 100 native cycles before distribution.

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

The shared `.github/actions/macos-build` action qualifies both native architectures on main and in
`.github/workflows/macos-release.yml`, without Mac Actions artifacts or caches. Mac jobs produce
complete bundles with `scripts/package-macos.mjs`, roundtrip verify them and exercise the helper
before packaged SSH and 100 native cycles.

Each release publishes the exact Windows, Linux and Mac artifacts tested by their build jobs,
without rebuilding in the publish job. New-draft creation, native Mac staging and final publishing
have scoped `contents: write` with the existing job token; main Mac jobs remain read-only. Pages
deployment has its own `pages: write` and `id-token: write`. PR runs do not publish or deploy. Build
artifacts are available from Actions even without a release tag.

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

3. The release workflow creates a source-bound **unpublished** draft, repeats website, Windows,
   Linux/seven GNOME and both native Mac qualifications, and checks anonymous draft/API/asset
   denial. Mac bytes are staged privately using release assets rather than additional Actions
   storage. Any gate failure leaves the draft unpublished. After all gates and complete validation
   it publishes `Diagnostic-Hub.exe`, Linux AppImage/archive, portable website ZIP, gateway archive,
   download helpers (including `download-run-macos.sh`), both complete Mac ZIPs and their SHA-256
   checksums. All 24 files must match: ten payloads, ten sidecars and four manifests.
   `build-info.json`, `linux-build-info.json` and both Mac manifests identify the source commit,
   architecture and Windows signing status. Versions with prerelease suffixes are marked
   prereleases; a plain version tag publishes an official release. Release notes identify unsigned
   engineering builds explicitly.
4. Dependent native Mac jobs test the actual published one-line command, normal launch, source,
   architecture, renderer bridge, running-app refusal and downloaded packaged SSH behavior. These
   command-line checks do not establish Safari quarantine or physical/managed Mac acceptance.
   Inspect the Release assets and test downloaded packages on the intended Windows, Mac and Linux
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
not move an already-published tag. The Mac distribution increment uses a new `v0.4.0` tag; `v0.3.1`,
unpublished `v0.3.0` and `v0.2.0` are preserved.

## Immutable v0.4.0 publication recovery

The first v0.4.0 tag run qualified all Windows/Linux/seven GNOME/website builds and both native Mac
bundles, installers, SSH checks and 100 cycles. Staging then failed because the REST tag-name
endpoint exposes published releases, not unpublished drafts. The tag and private draft are
preserved.

Corrected release tooling discovers the draft through authenticated paginated listing, then reads
its stable release ID before every mutation. Tag/source/ownership/draft guards and anonymous
actual-ID/asset denial remain mandatory. A public published-release JSON control must also
return 200. The published-only tag endpoint is not used as draft-privacy evidence. Only confirmed
rate-limit responses may wait for their documented reset/Retry-After within bounded attempts and
time; ambiguous responses fail closed. It never modifies an existing published release or
substitutes a new app commit behind an old tag.

The one-time release-recovery workflow checks the original run and artifact source, requires all 13
main gates for the corrected operational commit and checks native qualification run 38348257545. It
reuses all six already uploaded Mac asset IDs, sizes and digests, rechecks sidecars/manifests,
compiles immutable source for ASAR byte comparison, and repeats bundle/signature/installer/SSH/100
cycles on both native Macs without repackaging or uploading replacement Mac files. Metadata privacy
runs centrally with an actual release-ID probe and public positive control; native readers retain
anonymous checks of actual asset URLs. It reads the already tested Windows/Linux/web artifacts from
the original run. Only recovery checks and publication gain per-job Actions read access for that
evidence/artifact retrieval; approved Contents write remains limited by source-owned draft guards.
No account setting, persistent credential or new Mac Actions artifact/cache is added. It then
repeats complete 24-file validation, publishes the same draft and runs both real published-command
checks. App source and release-tooling source are logged separately.

The initial v0.4.0 postpublication harness failed at TypeScript transformation because top-level
await was incompatible with this CommonJS package. Its corrected async entry point preserves all
assertions/deadlines. The read-only published-Mac verification workflow checks the immutable
consumer source and exercises actual public downloads/launch/installed SSH on both standard native
runners, without building, replacing or republishing any release file. The original failed test jobs
remain historical evidence.

## Published-release workflow audits

The `Publish verified release` workflow retains all new-tag publication gates. A main push affecting
its audit tooling or a manual `published_tag` request runs explicitly named read-only audit jobs;
publication entry runs only on tag pushes. The audit verifies the complete public catalog, API and
downloaded digests, sidecars, source manifests, exact tag helper bytes and generated source notes,
then both native public-command/installed SSH checks. These jobs use Contents read, no release
mutation calls, app rebuilding/packaging or new Mac artifact/cache storage. An empty tag audits
latest stable; a selected tag must also be latest for the documented latest-release command.

README separates latest release availability, release workflow health and published Mac
verification. A successful read-only run reports current verification, without changing the failed
original v0.4.0 publication run 38342913511. Recovery publication 38352448204 and subsequent
corrected public checks remain separate historical records. Releases and tags are preserved by this
workflow's policy and guards; this does not claim GitHub-enforced immutable-release settings.

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

Release pages follow [the four-section template](release-note-template.md). Names equal the tag; the
generator includes every commit since the previous published release and preserves caveats within
Description or Changes.
