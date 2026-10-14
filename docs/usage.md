# Using Diagnostic Hub

The desktop and website share the same workspace. For SSH diagnostics, the desktop connects
directly; the website needs a matching [HTTPS lab gateway](gateway.md). Choose **Connect device**
with a reachable Linux SSH service and verify the device fingerprint. For local UART access, open
**Serial** without an SSH connection and follow [the Serial guide](serial.md). See
[download and platform requirements](downloads.md) for installation and launch options.

Windows and Linux provide verified in-app updates. Mac uses the verified manual installer helper;
quit the app before replacing its bundle. The website is updated by its host. See
[Desktop updates](#desktop-updates) for progress, report handling and platform limits.
[Connection attempts and Cancel](connection-retries.md) explains three-second temporary retries,
credential/trust correction and keeping healthy SSH when collection fails.

## Minimize and restore

Windows and Linux use standard native window controls. Minimizing preserves the authenticated SSH
connection, terminal and current diagnostic evidence. No snapshots or companion extension are used.
Existing saved reports remain on disk.

## Snapshots and live graphs

Connect once to collect evidence. **Live updates** reuse the authenticated SSH connection; switch
updates off for manual snapshots. **Disconnect device** retains the displayed evidence and graph
history. Reconnecting appends samples, with the latest 120 samples retained per window. The
**Collection source** selector separates evidence from different endpoints.

The app starts without fabricated readings. Diagnostic checks are read-only and report unavailable
capabilities or failed probes explicitly. Graphs show collected numeric evidence, rather than
inventing values for missing readings.

## Device time

The green pixel clock in the header shows the connected device's system date, seven-segment 24-hour
time, and effective timezone abbreviation and UTC offset on every page. It refreshes once per
minute, even with live diagnostics paused, and after connection, reconnection, session reset, and
return to the app. A detected reboot refreshes it at the next clock read or earlier uptime evidence.
Reloading the app/page clears the old clock; reconnect to read fresh device time.

The compact display places the pixel clock on the left, date above timezone in the middle, and
seven-segment time on the right. The pixel clock hands follow the same device time. The orange
**Disconnect device** button ends the SSH connection.

Unavailable timezone details are labeled explicitly. A failed refresh retains the last reading with
**Stale** until a successful retry. Disconnected and imported-report views show **No device
connected**. Clock reads use a separate read-only SSH channel, leave device settings unchanged, and
do not enter terminal output or report exports. A `TZ` override inside the user terminal is local to
that shell and does not change the header's source.

## Reports and session data

**Import report** and **Export report** work locally on diagnostic pages in both editions. The
Terminal page keeps its own interactive workspace. Imported diagnostic reports are labeled as
historical evidence and do not execute their recorded commands. Connect a device to collect new
readings. Report files contain diagnostic evidence, not credentials or terminal transcripts.

Snapshots, graph history and terminal history stay in RAM. Explicit report exports, desktop update
report backups and trusted desktop SSH fingerprints are saved to disk.

**Reset session data** clears the current snapshot, graphs and local terminal history. It keeps the
current page, SSH connection and saved files, and sends no terminal command. A progress cover
remains while cleanup and the first fresh live snapshot complete. With live updates off, the
existing cards remain with cleared readings.

## Device terminal

The terminal shell starts automatically on connection and stays available across workspace tabs.
Commands run with the connected SSH user's permissions and can change the device. Multiline syntax,
working directory, interactive programs and shell key bindings are handled by the device's shell.

| Action                | Behavior                                                                               |
| --------------------- | -------------------------------------------------------------------------------------- |
| Left-button drag      | Highlight text.                                                                        |
| Right-click           | Open the Copy/Paste menu without losing the selection.                                 |
| Top-right copy button | Copy the selection, or bounded local history, with the shared copy animation.          |
| Ctrl+C                | Copy selected text; otherwise interrupt the remote program.                            |
| Ctrl+V                | Paste into the current terminal. Browser clipboard permission may be required.         |
| Clear terminal        | Remove previous history, retain the current prompt/input line and restore input focus. |
| Ctrl+L                | Use the remote shell's normal redraw behavior.                                         |
| Ctrl+Shift+Escape     | Return focus to the Clear terminal control.                                            |

Other terminal keys follow xterm and the remote shell's keymap. Scrolling remains inside the
terminal when it has scrollback or an interactive program consumes wheel input. A short normal
terminal without scrollback allows the page to scroll. Its scrollbar appears only when history
extends beyond the fitted screen and disappears after clearing that history. Recognizable uncolored
prompts receive a local mint color; the device's own colors remain intact.

Ending the outer shell with `exit`, `logout` where supported, or Ctrl+D starts a fresh shell on the
same healthy SSH connection. Local history remains, queued input is discarded and input is never
replayed. The new shell uses its default directory and environment; nested shells exit normally.
Refused shells, transport failures or repeated rapid exits require reconnecting the device.
Disconnect and report import release the shell.

Live collection output, including collected kernel/system logs, stays in diagnostic evidence and
never enters the terminal. The terminal displays the remote PTY, including command output, prompts,
login banners and any background jobs or device broadcasts writing directly to it. Terminal history
stays in bounded RAM and is excluded from reports and update backups.

Pixel trees, a duck and pig playing ball, and a tilted Earth rotating once per second appear behind
the terminal text. The animation pauses when the terminal is hidden or blocked by a dialog.

## Desktop updates

On Windows and Linux, choose **Check for updates** in the desktop header; prereleases are supported.
The choices are **Update without saving**, **Save report & update**, and **Save, update & reopen
report**. Cancel before starting leaves the session unchanged. Once an update transaction starts,
cancellation is disabled; closing the dialog is not presented as cancelling the native transaction.

Mac shows manual update guidance and a verification command for its saved installer helper. Quit the
app before running that helper to replace the bundle; see
[Mac installation](downloads.md#mac-installation-and-launch).

Windows and Linux in-app updates wait for active collection, disconnect SSH, verify the download and
restart without reconnecting. Saved reports remain under `update-reports` in the user's application
data folder. Updating without saving keeps older backups and trusted SSH fingerprints. See
[update and release details](delivery.md#maintenance).

### Update progress and executable locations

Download progress reports measured bytes against the validated release metadata size. Missing HTTP
Content-Length does not remove that known total. Unknown totals and verification, commit and restart
stages stay indeterminate; a completed download does not imply a successful launch.

The Windows download helper's original cache under
`%LOCALAPPDATA%\DiagnosticHub\downloads\v<version>` is separate from the in-app update destination:
`<Electron userData>\updates\<version>\Diagnostic-Hub.exe`. With ordinary defaults this is under
`%APPDATA%\Diagnostic Hub`; an explicit user-data-dir changes it. Linux automatic updates retain the
verified AppImage in the corresponding userData updates directory. The original executable is kept.
Temporary portable extraction and process.execPath are not the durable Windows EXE/AppImage.

The update dialog provides native Open folder and Copy path actions for the current launchable app
and saved verified update. A bounded native handoff receipt survives clean, preserve and smart
modes. The reopened app displays versions and location status near the top: restart requested
differs from confirmation that the expected version is running from the verified destination with
matching checksum. Reopening an older executable still shows the saved new destination. Native
actions accept only current/verified selectors, never arbitrary renderer filesystem paths. macOS
retains manual update guidance.

### Update platform coverage

| Platform            | Mechanism                                                                  | Destination/status                                                                                      | Native qualification                                                               |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Windows x64         | Automatic verified EXE handoff                                             | Measured download, separate verification/commit/restart; wrapper path and receipt                       | Actual local new-process version/path/checksum qualified                           |
| Linux x64           | Automatic verified AppImage handoff                                        | Same stages; durable APPIMAGE, preserved profile and receipt                                            | Native AppImage handoff verified in Linux CI; physical desktop acceptance separate |
| macOS x64           | Verified manual .app installer; automatic update disabled                  | Terminal stages and launch requested; default ~/Applications/Diagnostic Hub.app plus actual bundle path | Existing Intel CI installer/rollback and new native UI/path/normal-launch checks   |
| macOS arm64         | Same manual mechanism; native machine detected even in translated terminal | Same truthful stages and bundle paths                                                                   | Existing Apple Silicon CI runs the same native checks                              |
| Other architectures | Automatic update unavailable                                               | Explicit unsupported status and releases link                                                           | No compatible automatic handoff claim                                              |

For Mac, download helper/checksum from the same release tag, verify the saved helper, then run the
saved installer locally as your ordinary user. The app copies only the verification command. Normal
codesign/Gatekeeper policy, archive/source/architecture verification and failure rollback remain.
Logical platform tests on Windows do not replace native Linux/Mac CI results. No quarantine,
notarization, older macOS or physical-device acceptance is claimed.

## Serial, network insights and Automation

Use [Serial](serial.md) for local UART access, [WLAN/LAN insights](network-insights.md) for readable
network evidence, and [Automation](automation.md) for ordered SSH/Serial flows and QA exports.
Target UART enablement, wiring and operation belong to the user. Physical adapter, port and driver
acceptance remain separate from automated fixtures. Armed Automation scripts can change the target;
ordinary diagnostic collection remains read-only.
