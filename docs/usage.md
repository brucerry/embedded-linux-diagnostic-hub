# Using Diagnostic Hub

The desktop and website share the same workspace. The desktop connects directly over SSH; the
website needs a matching [HTTPS lab gateway](gateway.md). Start with a reachable Linux SSH service
and credentials, choose **Connect device**, and verify the device fingerprint before accepting it.
See [download and platform requirements](downloads.md) for installation and launch options.

## Minimize and restore

On Windows, the native title-bar **Minimize** control folds the app content toward its current
taskbar button with a short Genie effect. Restoring from the taskbar reverses it. It follows top,
bottom, left and right taskbars, re-reads the button before each direction and accounts for display
scaling. Grouped windows use their app group button. Shells that do not expose a unique button use
the detected taskbar center as an approximation; unknown placement uses native behavior.

The native system-menu minimize command uses the same effect. OS paths that bypass that command,
such as Show Desktop, retain ordinary Windows transitions. There is no in-app motion button. Only
app content is animated; the OS frame is not captured. System reduced motion also uses native
transitions. Linux and browser editions keep their existing controls.

Minimizing preserves SSH, the terminal, tests and edits. Snapshots remain in memory for one
transition. Native behavior remains available while the animation adapter initializes. Capture or
rendering failure recovers through native behavior within two seconds.

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

**Import report** and **Export report** work locally on diagnostic pages in both editions. Terminal
and Tests omit these diagnostic actions; Tests has [separate test reports](board-test-reports.md).
Imported diagnostic reports are labeled as historical evidence and do not execute their recorded
commands. Connect a device to collect new readings. Report files contain diagnostic evidence, not
credentials or terminal transcripts.

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

Choose **Check for updates** in the desktop header; prereleases are supported. The available choices
are **Update without saving**, **Save report & update**, and **Save, update & reopen report**.
Cancel leaves the session unchanged.

Updates wait for active collection, disconnect SSH, verify the download and restart without
reconnecting. Saved reports remain under `update-reports` in the user's application data folder.
Updating without saving keeps older backups and trusted SSH fingerprints. See
[update and release details](delivery.md#maintenance).
