#!/usr/bin/env bash
# Dedicated compositor qualification. Does not reuse a user's desktop or session bus.
set -euo pipefail
(( EUID != 0 )) || { echo 'Run GNOME qualification as an ordinary test user.' >&2; exit 1; }
[[ ${HUB_GNOME_ISOLATED:-} == 1 && -n ${HUB_TEST_EXECUTABLE:-} && -n ${HUB_TEST_LINUX_CONNECTION:-} ]] || exit 1
project=$(pwd)
if [[ ${1:-} != --inside ]]; then
    qualification=$(mktemp -d /tmp/hub-gnome-session.XXXXXX)
    profile=${HUB_GNOME_PERSISTENT_PROFILE:-$qualification}
    if [[ -n ${HUB_GNOME_PERSISTENT_PROFILE:-} ]]; then
        [[ $profile == /home/hubengineer/qualification/evidence/*/profile ]] || exit 1
    fi
    export XDG_CONFIG_HOME=$profile/config XDG_DATA_HOME=$profile/data
    export XDG_CACHE_HOME=$qualification/cache XDG_RUNTIME_DIR=$qualification/runtime
    mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"
    export LIBGL_ALWAYS_SOFTWARE=1 GTK_A11Y=none
    unset WAYLAND_DISPLAY
    display_args=(-displayfd 3)
    if [[ -n ${HUB_GNOME_OUTER_DISPLAY:-} ]]; then
        [[ $HUB_GNOME_OUTER_DISPLAY =~ ^[1-9][0-9]{2}$ ]] || exit 1
        display_args=(":$HUB_GNOME_OUTER_DISPLAY")
        printf '%s\n' "$HUB_GNOME_OUTER_DISPLAY" >"$qualification/display"
    fi
    Xvfb "${display_args[@]}" -screen 0 1600x1000x24 -nolisten tcp 3>>"$qualification/display" >"$qualification/xvfb.log" 2>&1 &
    xvfb_pid=$!
    trap 'kill "$xvfb_pid" 2>/dev/null || true; rm -rf -- "$qualification"' EXIT
    for attempt in $(seq 1 100); do [[ -s $qualification/display ]] && break; sleep .05; done
    [[ -s $qualification/display ]] || { cat "$qualification/xvfb.log"; exit 1; }
    export DISPLAY=:$(cat "$qualification/display")
    dbus-run-session -- bash "$project/tests/gnome-session.sh" --inside "$qualification"
    exit $?
fi
qualification=$2
major=$(gnome-shell --version | sed -E 's/.* ([0-9]+)\..*/\1/')
[[ $major == 42 || $major == 46 || $major == 48 || $major == 50 ]] || exit 1
test -f "$HUB_TEST_EXECUTABLE" && test ! -L "$HUB_TEST_EXECUTABLE"
sha256sum "$HUB_TEST_EXECUTABLE" > "$HUB_GNOME_EVIDENCE/current-runtime-appimage-sha256.txt"
printf '#!/bin/bash\nexec "%s" --appimage-extract-and-run "$@"\n' "$HUB_TEST_EXECUTABLE" >"$qualification/launch-app"
chmod 700 "$qualification/launch-app"
export HUB_TEST_EXECUTABLE=$qualification/launch-app
unset HUB_TEST_APPIMAGE
export GNOME_SHELL_SESSION_MODE=user
shell_args=(--unsafe-mode)
if [[ ${HUB_GNOME_BACKEND:-wayland} == x11 ]]; then
    [[ $major != 50 ]] || { echo 'GNOME 50 has no X11 backend.' >&2; exit 1; }
    shell_args+=(--x11 --sm-disable)
elif [[ $major == 50 ]]; then
    pipewire >"$qualification/pipewire.log" 2>&1 &
    pipewire_pid=$!
    # Disposable devkit capture uses its own media-session manager, never the host bus.
    wireplumber >"$qualification/wireplumber.log" 2>&1 &
    wireplumber_pid=$!
    if [[ -n ${HUB_GNOME_TEST_GSK_RENDERER:-} ]]; then
        [[ $HUB_GNOME_TEST_GSK_RENDERER == gl || $HUB_GNOME_TEST_GSK_RENDERER == cairo ]] || exit 1
        export GSK_RENDERER=$HUB_GNOME_TEST_GSK_RENDERER
    fi
    for attempt in $(seq 1 100); do [[ -S $XDG_RUNTIME_DIR/pipewire-0 ]] && break; sleep .05; done
    # Devkit owns its virtual output; an extra persistent output can strand the app
    # on an uncaptured monitor while the devkit shows only a secondary background.
    shell_args+=(--devkit --wayland --no-x11 --wayland-display=hub-qualification-0)
else
    export MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1000
    shell_args+=(--nested --wayland --no-x11 --wayland-display=hub-qualification-0)
fi
gnome-shell "${shell_args[@]}" >"$qualification/shell.log" 2>&1 &
shell_pid=$!
trap 'kill "$shell_pid" ${pipewire_pid:-} ${wireplumber_pid:-} 2>/dev/null || true; mkdir -p "$HUB_GNOME_EVIDENCE"; cp "$qualification/shell.log" "$HUB_GNOME_EVIDENCE/"; for log in pipewire wireplumber; do [[ ! -f "$qualification/$log.log" ]] || cp "$qualification/$log.log" "$HUB_GNOME_EVIDENCE/"; done' EXIT
if [[ $major == 50 ]]; then
    # The minimal headless devkit has no physical seat; seed owned virtual input for EIS.
    for attempt in $(seq 1 100); do
        if gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval '(async()=>{ const {default:Clutter}=await import("gi://Clutter"); const seat=Clutter.get_default_backend().get_default_seat(); global.hubQualificationInput=[seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE),seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)]; return true; })()' >/dev/null 2>&1; then break; fi
        sleep .1
    done
    for attempt in $(seq 1 100); do
        window=$(xdotool search --name '^Mutter Development Kit$' 2>/dev/null | head -1) || true
        [[ -n $window ]] && { xdotool windowsize "$window" 1600 1000; break; }
        sleep .1
    done
fi
if [[ $major == 50 ]]; then
    stage_ready=0
    stable_geometry=0
    for attempt in $(seq 1 100); do
        if (( attempt % 10 == 1 )); then xdotool windowsize "$window" 1600 1000; fi
        stage_geometry=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval 'JSON.stringify({width:global.stage.width,height:global.stage.height})' 2>/dev/null) || true
        printf '%s\n' "$stage_geometry" >> "$HUB_GNOME_EVIDENCE/stage-preflight-observations.txt"
        if [[ $stage_geometry =~ width[^0-9]*1590[^0-9] && $stage_geometry =~ height[^0-9]*944[^0-9] ]]; then
            stable_geometry=$((stable_geometry+1))
            if (( stable_geometry >= 3 )); then stage_ready=1; break; fi
        else
            stable_geometry=0
        fi
        sleep .1
    done
    printf '%s\n' "$stage_geometry" > "$HUB_GNOME_EVIDENCE/verified-stage-geometry.txt"
    [[ $stage_ready == 1 ]] || { echo 'Controlled 1590x944 stage did not settle before the workload.' >&2; exit 1; }
fi
if [[ ${HUB_GNOME_BACKEND:-wayland} != x11 ]]; then export WAYLAND_DISPLAY=hub-qualification-0; fi
npx --no-install tsx tests/native-window-smoke.ts
