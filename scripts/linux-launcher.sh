#!/usr/bin/env bash
# This launcher is copied into both Linux packages as AppRun.
set -euo pipefail
APPDIR=${APPDIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
binary="$APPDIR/diagnostic-hub"

missing_libraries() {
    { ldd "$binary" 2>&1 || true; } | awk '/=> not found/ { print $1 }' | sort -u
}
missing=$(missing_libraries)
if [[ -n $missing ]]; then
    printf 'Diagnostic Hub needs these desktop libraries:\n%s\n' "$missing" >&2
    if command -v apt-get >/dev/null; then
        packages=()
        for library in $missing; do
            case "$library" in
                libnss3.so|libnssutil3.so|libsmime3.so) package=libnss3 ;;
                libnspr4.so|libplc4.so|libplds4.so) package=libnspr4 ;;
                libasound.so.2) package=libasound2 ;;
                libgtk-3.so.0|libgdk-3.so.0) package=libgtk-3-0 ;;
                libatk-1.0.so.0) package=libatk1.0-0 ;;
                libatk-bridge-2.0.so.0|libatspi.so.0) package=libatk-bridge2.0-0 ;;
                libcups.so.2) package=libcups2 ;;
                libX11-xcb.so.1) package=libx11-xcb1 ;;
                libXcomposite.so.1) package=libxcomposite1 ;;
                libXdamage.so.1) package=libxdamage1 ;;
                libXrandr.so.2) package=libxrandr2 ;;
                libgbm.so.1) package=libgbm1 ;;
                libdrm.so.2) package=libdrm2 ;;
                libxkbcommon.so.0) package=libxkbcommon0 ;;
                libXss.so.1) package=libxss1 ;;
                *) printf 'Ask your distribution package manager for %s.\n' "$library" >&2; continue ;;
            esac
            # Ubuntu 24.04 and newer Debian releases renamed selected packages for time64.
            if [[ $package == libasound2 || $package == libgtk-3-0 || $package == libatk1.0-0 || $package == libatk-bridge2.0-0 || $package == libcups2 ]]; then
                if apt-cache show "${package}t64" >/dev/null 2>&1; then package="${package}t64"; fi
            fi
            packages+=("$package")
        done
        if (( ${#packages[@]} )); then
            mapfile -t packages < <(printf '%s\n' "${packages[@]}" | sort -u)
            printf '\nSuggested prerequisite installation:\nsudo apt-get install' >&2
            printf ' %q' "${packages[@]}" >&2
            printf '\nOnly package installation may need administrator approval; normal app launch does not.\n' >&2
            if { true </dev/tty; } 2>/dev/null && command -v sudo >/dev/null; then
                printf 'Install these prerequisites now? [y/N] ' >/dev/tty
                read -r answer </dev/tty || answer=n
                if [[ $answer == y || $answer == Y || $answer == yes ]]; then
                    sudo apt-get install "${packages[@]}"
                    missing=$(missing_libraries)
                fi
            fi
        fi
    else
        printf 'Install the listed libraries through your distribution package manager, then retry.\n' >&2
    fi
    if [[ -n $missing ]]; then
        printf 'Application not started. Retry after prerequisites are available, or use the website.\n' >&2
        exit 1
    fi
fi
# Never add --no-sandbox automatically or change host namespace/permission settings.
unset ELECTRON_RUN_AS_NODE
exec "$binary" "$@"
