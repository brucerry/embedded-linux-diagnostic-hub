#!/usr/bin/env bash
# Download and run a verified release in the current user's folder, without installation.
set -euo pipefail
umask 077

repo=brucerry/embedded-linux-diagnostic-hub
website=https://brucerry.github.io/embedded-linux-diagnostic-hub/
version=
format=AppImage
directory=
download_only=0
while (( $# )); do
    case "$1" in
        --version|--format|--directory)
            (( $# >= 2 )) || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
            case "$1" in
                --version) version=$2 ;;
                --format) format=$2 ;;
                --directory) directory=$2 ;;
            esac
            shift 2 ;;
        --download-only) download_only=1; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
done
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
    printf 'This desktop release requires Linux x86_64. Use the web workspace: %s\n' "$website" >&2
    exit 1
}
[[ $download_only == 1 || $EUID != 0 ]] || {
    printf 'Run as your normal desktop user; administrator/root access is not needed.\n' >&2
    exit 1
}
[[ $download_only == 1 || -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] || {
    printf 'A graphical desktop session is needed. Use the website on headless systems: %s\n' "$website" >&2
    exit 1
}
[[ $format == AppImage || $format == tar.gz ]] || { printf 'Format must be AppImage or tar.gz.\n' >&2; exit 1; }
asset="Diagnostic-Hub-linux-x64.$format"
for tool in curl sha256sum mktemp; do
    command -v "$tool" >/dev/null || { printf 'Required download utility is unavailable: %s\n' "$tool" >&2; exit 1; }
done
if [[ -n $version ]]; then
    [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || {
        printf 'Use a release tag such as v0.1.0.\n' >&2; exit 1
    }
else
    # The public releases API includes published prereleases; /latest omits engineering previews.
    releases=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        "https://api.github.com/repos/$repo/releases?per_page=100")
    url=$(printf '%s' "$releases" | grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | sed -E 's/^[^"]*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)"$/\1/' \
        | grep -E "^https://github.com/$repo/releases/download/v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?/$asset$" \
        | head -n 1) || true
    [[ -n $url ]] || { printf 'No published Linux release was found. Check %s/releases.\n' "https://github.com/$repo" >&2; exit 1; }
    version=${url%/*}; version=${version##*/}
fi
base="https://github.com/$repo/releases/download/$version"
directory=${directory:-${XDG_DATA_HOME:-$HOME/.local/share}/DiagnosticHub/downloads/$version}
mkdir -p -- "$directory"
# A private staging directory prevents incomplete downloads from replacing an existing copy.
staged=$(mktemp -d "$directory/.download.XXXXXX")
trap 'rm -rf -- "$staged"' EXIT
fetch() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --output "$2" "$1"
}
fetch "$base/$asset.sha256" "$staged/$asset.sha256"
line=$(cat "$staged/$asset.sha256")
[[ $line =~ ^([[:xdigit:]]{64})\ \ (.+)$ && ${BASH_REMATCH[2]} == "$asset" ]] || {
    printf 'Invalid release checksum document; no application will be launched.\n' >&2; exit 1
}
fetch "$base/$asset" "$staged/$asset"
(cd -- "$staged" && sha256sum --check --status "$asset.sha256") || {
    printf 'Download checksum mismatch; no application will be launched.\n' >&2; exit 1
}
chmod u+x -- "$staged/$asset"
mv -f -- "$staged/$asset" "$directory/$asset"
printf 'Verified %s: %s/%s\n' "$version" "$directory" "$asset"
(( download_only )) && exit 0
unset ELECTRON_RUN_AS_NODE
if [[ $format == AppImage ]]; then
    # Extraction avoids FUSE installation/mount permissions; the runtime cleans up after exit.
    "$directory/$asset" --appimage-extract-and-run
else
    command -v tar >/dev/null || { printf 'tar is needed for the archive format.\n' >&2; exit 1; }
    mkdir -- "$staged/app"
    tar --no-same-owner --no-same-permissions -xzf "$directory/$asset" -C "$staged/app"
    # The release archive has one top-level product directory, created by electron-builder.
    executable=$(find "$staged/app" -maxdepth 2 -type f -name diagnostic-hub -print -quit)
    [[ -n $executable ]] || { printf 'Application executable is absent from the archive.\n' >&2; exit 1; }
    "$(dirname -- "$executable")/AppRun"
fi
