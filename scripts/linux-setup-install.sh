#!/bin/bash
# Explicit permanent entry for an independently prepared complete-folder package ROOT/app.
# The ordinary portable AppRun remains unchanged and never loads this helper implicitly.
set -euo pipefail
[[ $(uname -s) == Linux && $(uname -m) == x86_64 && $EUID != 0 ]] || exit 1
resources=$(CDPATH= cd -P -- "${BASH_SOURCE[0]%/*}" && pwd -P)
app=${resources%/*}
[[ ${resources##*/} == resources && ${app##*/} == app ]] || exit 1
root=${app%/*}
[[ -f "$root/diagnostic-hub-setup-payload.json" && ! -L "$root/diagnostic-hub-setup-payload.json" ]] || exit 1
[[ -f "$app/diagnostic-hub" && ! -L "$app/diagnostic-hub" && -x "$app/diagnostic-hub" ]] || exit 1
[[ -f "$resources/linux-setup-install.cjs" && ! -L "$resources/linux-setup-install.cjs" ]] || exit 1
unset NODE_OPTIONS NODE_PATH APPIMAGE APPDIR PORTABLE_EXECUTABLE_FILE PORTABLE_EXECUTABLE_DIR PORTABLE_EXECUTABLE_APP_FILENAME
export ELECTRON_RUN_AS_NODE=1
export LD_LIBRARY_PATH="$app/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$app/diagnostic-hub" "$resources/linux-setup-install.cjs" "$@"
