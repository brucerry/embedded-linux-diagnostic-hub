# Design

Electron v44.5.1 platform_util_linux.cc reads CHROME_DESKTOP on each GetXdgAppId call; native_window_views.cc assigns that value to WM_CLASS and Wayland app ID synchronously during widget initialization. Use a narrowly scoped public setDesktopName call around BrowserWindow creation, then restore the stable desktop name in finally. This changes the main window identity without a new launcher file, app.setName or data-path migration. Existing pinned metadata may need refresh as already documented.

The compositor assertion continues to require one window owned by the Electron process with class diagnostic-hub-native. Log only pid/class metadata in the private CI session. Assert the desktop identity is restored and exercise unit success/failure restoration. Keep native minimize/restore/resize/session checks and the exact existing matrix. Preserve all initial seven failures as evidence; release waits for corrected exact-source gates.

No open decisions; the user already authorized this correction and gated stable publication. Published notes/assets and original user edits remain unchanged.

Second-source qualification bd80da1 proved actual class diagnostic-hub-native in every case; GNOME46/48 Wayland passed, three X11 cases failed to restore and GNOME42/50 Wayland failed to minimize under the back-to-back maximize/unmaximize sequence. Candidate e1360b5 separates requests and requires both Electron and compositor state confirmation, preserving 5-second assertions. Event/phase state traces distinguish ordering, sluggishness and actual stuck states; no timeout increase or environment/condition waiver occurred.

Sequenced e1360b5 traces confirm all transitions through minimize, then show the actual compositor remaining minimized after the test calls client restore. Wayland local Electron state can clear while compositor state stays1; X11 both remain minimized. Correct test operation to the owned compositor native desktop/window-switcher restore, retaining both state checks, 5-second deadlines, restore notifications and session continuity. No application restore API or production fallback is introduced.
