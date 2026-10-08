# Website and desktop editions

The two editions share the React UI, probe catalogue, parsers, findings and JSON report format.

| Mode                     | Device connection                                   | Internet requirement                                                               |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GitHub Pages website     | Browser → HTTPS lab gateway → SSH device            | Required to load the hosted website; gateway reachability is required for live SSH |
| Desktop with internet    | Direct SSH over reachable LAN/Wi-Fi/VPN             | No cloud service or gateway dependency                                             |
| Desktop without internet | Direct SSH over local Ethernet/Wi-Fi; local reports | None; the target still needs local network reachability                            |

Offline desktop use does not require a browser, account, further package download or separate
JavaScript runtime once host prerequisites are satisfied. A disconnected/offline board can still be
investigated using a previously saved report. Serial/UART transport is a future feature.

## GitHub Pages

Repository: `brucerry/embedded-linux-diagnostic-hub`.

Expected site URL after successful publication:

```text
https://brucerry.github.io/embedded-linux-diagnostic-hub/
```

The Vite web build derives `/embedded-linux-diagnostic-hub/` from `GITHUB_REPOSITORY`. Desktop
builds use relative asset paths and a separate output directory, so a Pages build cannot overwrite
packaged desktop resources. `WEB_BASE_PATH=/` supports an eventual custom-domain build.

The workflow in `.github/workflows/github-pages.yml` tests and builds the website, uploads the lab
gateway package, and deploys the site for pushes to `main` or manual runs. Pull requests run
checks/builds without deployment. GitHub repository **Settings → Pages → Build and deployment →
Source** must be set to **GitHub Actions** before the first deployment. Initial enablement needs
repository administration access; an ordinary workflow `GITHUB_TOKEN` cannot perform that first
enablement. [Vite Pages deployment](https://vite.dev/guide/static-deploy.html),
[configure-pages enablement](https://github.com/actions/configure-pages/blob/main/action.yml).

GitHub Pages hosts the static GUI; it cannot run this Node SSH gateway.
[GitHub Pages hosting model](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
Deploy the gateway separately using [the lab gateway guide](gateway.md).

## Local web build

```sh
npm ci
GITHUB_REPOSITORY=brucerry/embedded-linux-diagnostic-hub npm run build:web
GITHUB_REPOSITORY=brucerry/embedded-linux-diagnostic-hub npm run preview:web
```

Use the same base-path environment for build and preview. With that base path, open
`http://127.0.0.1:4173/embedded-linux-diagnostic-hub/`. For root-path preview, omit
`GITHUB_REPOSITORY`. The development server (`npm run dev`) uses the root path and allows HTTP
loopback gateways for local tests. Production builds permit HTTPS gateway requests.

## Reports and source labels

The **Terminal** tab uses a shell created automatically on the existing gateway-backed SSH
connection; commands run with the SSH account's permissions. A matching updated gateway is required.
An older gateway produces a terminal-unavailable message while existing diagnostic collection
remains usable. The output uses authenticated HTTPS streaming, so the reverse proxy must forward
streaming responses without buffering. See [gateway setup](gateway.md).

Terminal scrollback stays in RAM and is excluded from reports. Tab changes retain the shell;
disconnect, report import and leaving the page release it. A normal outer-shell exit starts a fresh
shell on the same SSH connection, retaining local history and discarding queued input. Refusal,
stream failures or repeated rapid exits require reconnecting; input is never replayed. Copy uses the
highlighted selection or local history. Clipboard paste requires browser permission on HTTPS or
local loopback; Ctrl+C copies a selection or interrupts, and Ctrl+V pastes. Left-drag selects text
and right-click opens Copy/Paste. Clear terminal keeps the current prompt/input and restores input
focus; Ctrl+L uses the device's redraw behavior. The terminal contains its own scrolling and fitted
rows.

**Import report** reads the selected JSON file locally using the browser File API, in either
edition. Report parsing validates schema version, IDs, statuses/exit codes, timestamps and output
bounds. Files above 16 MiB are rejected. Reports from an earlier catalogue remain readable; checks
absent from the file explicitly say they were not collected. Recorded commands are preserved and are
never executed during import.

Imported evidence is labeled **IMPORTED REPORT** and cannot be refreshed as a live session. Its
underlying `mode: demo` or `mode: ssh` remains in exports. Neither a report's source label nor a
completed command establishes authenticity or hardware health.

Empty startup, imported report, connected session and disconnected historical snapshot states are
distinct. Metrics only update after an explicit collection. SSH credentials and gateway tokens are
not placed in localStorage, URLs or reports.

## Relocatable website archive

```sh
npm run package:web
```

This produces `release/Diagnostic-Hub-Web-<version>.zip` from `dist-site/`, using relative asset
URLs. Extract the ZIP into any static HTTP(S) hosting directory; it works at the root or a nested
URL without recompiling. This build is separate from the repository-specific GitHub Pages build.
Client users need only a modern browser, not Node.js or administrator permissions. Production
portability tests exercise the nested-path build with Chromium, Firefox and WebKit, including empty
startup, report import, structured evidence, export and a narrow viewport.

Open the hosted HTTP(S) URL; loading `index.html` directly with `file://` is not supported because
browser module/security behavior differs. Live SSH still requires the HTTPS lab gateway. Configure
`HUB_ALLOWED_ORIGINS` for the actual website origin when relocating it. Browser HTTPS connectivity
and supported browser features are required; this is not a universal legacy-browser guarantee.
