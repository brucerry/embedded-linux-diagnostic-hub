#!/bin/bash
# Source for a future verified complete-folder AppRun; not the existing portable launcher.
set -euo pipefail
[[ $(uname -s) == Linux && $(uname -m) == x86_64 && $EUID != 0 ]] || exit 1
runtime=$(CDPATH= cd -P -- "${BASH_SOURCE[0]%/*}" && pwd -P)
[[ ${runtime##*/} == app ]] || exit 1
root=${runtime%/*}
for metadata in .diagnostic-hub-installation.json .diagnostic-hub-release.json .diagnostic-hub-ownership.json; do
    [[ -f "$root/$metadata" && ! -L "$root/$metadata" ]] || exit 1
done
[[ -f "$runtime/diagnostic-hub" && ! -L "$runtime/diagnostic-hub" && -x "$runtime/diagnostic-hub" ]] || exit 1
# Installed startup verifies the actual record/manifest and selects its retained UUID profile.
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH APPIMAGE APPDIR PORTABLE_EXECUTABLE_FILE PORTABLE_EXECUTABLE_DIR PORTABLE_EXECUTABLE_APP_FILENAME
export LD_LIBRARY_PATH="$runtime/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$runtime/diagnostic-hub" "$@"
