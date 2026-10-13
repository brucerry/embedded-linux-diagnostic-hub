#!/bin/bash
# macOS Bash 3.2 installer; uses built-in tools only.
set -euo pipefail
export LC_ALL=C
fail() { printf 'Diagnostic Hub: %s\n' "$*" >&2; exit 1; }
tag=''
directory="$HOME/Applications"
launch=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) [ "$#" -ge 2 ] || fail 'Missing version.'; tag="$2"; shift 2 ;;
        --directory) [ "$#" -ge 2 ] || fail 'Missing directory.'; directory="$2"; shift 2 ;;
        --no-launch) launch=0; shift ;;
        --help|-h) printf '%s\n' 'Usage: download-run-macos.sh [--version vX.Y.Z] [--directory PATH] [--no-launch] [-- APP_ARGUMENTS]'; exit 0 ;;
        --) shift; break ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[ "$(uname -s)" = Darwin ] || fail 'This helper requires macOS.'
[ "$EUID" -ne 0 ] || fail 'Run as your normal user, without sudo.'
if [ -n "$tag" ]; then
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'Unsafe version tag.'
fi
for tool in curl plutil shasum ditto codesign lipo unzip zipinfo lsof; do
    command -v "$tool" >/dev/null || fail "Missing macOS tool: $tool"
done
machine="$(uname -m)"
arm="$(sysctl -n hw.optional.arm64 2>/dev/null || printf 0)"
case "$machine:$arm" in
    arm64:*|x86_64:1) arch=arm64; slice=arm64 ;;
    x86_64:*) arch=x64; slice=x86_64 ;;
    *) fail "Unsupported Mac architecture: $machine" ;;
esac
case "$directory" in /*) ;; *) directory="$PWD/$directory" ;; esac
[ ! -L "$directory" ] || fail 'Installation directory must not be a symlink.'
mkdir -p "$directory"
directory="$(cd "$directory" && pwd -P)"
[ -O "$directory" ] || fail 'Choose an installation directory owned by your user.'
target="$directory/Diagnostic Hub.app"
[ ! -L "$target" ] || fail 'Existing application must not be a symlink.'
if [ -e "$target" ]; then
    [ -d "$target" ] || fail 'Existing application path is not a directory.'
    [ -O "$target" ] || fail 'Existing application must be owned by your user.'
    if lsof -t "$target/Contents/MacOS/Diagnostic Hub" >/dev/null 2>&1; then fail 'Quit Diagnostic Hub before installing or updating.'; fi
fi
umask 077
stage="$(mktemp -d "$directory/.DiagnosticHub-stage.XXXXXXXX")"
[ "$(cd "$stage" && pwd -P)" = "$stage" ] || fail 'Unsafe staging path.'
committed=0
cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$committed" -eq 0 ] && [ -e "$stage/previous.app" ]; then
        if [ -e "$target" ]; then mv "$target" "$stage/failed.app"; fi
        mv "$stage/previous.app" "$target" || {
            printf 'Rollback failed; prior app preserved at %s\n' "$stage/previous.app" >&2
            exit 1
        }
    fi
    case "$stage" in "$directory"/.DiagnosticHub-stage.*) rm -rf "$stage" ;; esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$1" -o "$2"; }
repo='brucerry/embedded-linux-diagnostic-hub'
api="https://api.github.com/repos/$repo/releases"
if [ -n "$tag" ]; then api="$api/tags/$tag"; else api="$api/latest"; fi
fetch "$api" "$stage/release.json"
json() { plutil -extract "$2" raw -o - "$1"; }
resolved="$(json "$stage/release.json" tag_name)"
[[ "$resolved" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'Unsafe release tag.'
[ -z "$tag" ] || [ "$tag" = "$resolved" ] || fail 'Release tag mismatch.'
[ "$(json "$stage/release.json" draft)" = false ] || fail 'Release is not published.'
tag="$resolved"
version="${tag#v}"
asset="Diagnostic-Hub-macos-$arch.zip"
base="https://github.com/$repo/releases/download/$tag"
fetch "$base/$asset" "$stage/app.zip"
fetch "$base/$asset.sha256" "$stage/checksum"
fetch "$base/macos-build-info-$arch.json" "$stage/manifest.json"
actual="$(shasum -a 256 "$stage/app.zip" | awk '{print $1}')"
printf '%s  %s\n' "$actual" "$asset" > "$stage/expected"
cmp -s "$stage/checksum" "$stage/expected" || fail 'Archive checksum mismatch.'
manifest="$stage/manifest.json"
[ "$(json "$manifest" platform)" = darwin ] || fail 'Manifest platform mismatch.'
[ "$(json "$manifest" arch)" = "$arch" ] || fail 'Manifest architecture mismatch.'
[ "$(json "$manifest" version)" = "$version" ] || fail 'Manifest version mismatch.'
[ "$(json "$manifest" asset)" = "$asset" ] || fail 'Manifest asset mismatch.'
[ "$(json "$manifest" sha256)" = "$actual" ] || fail 'Manifest checksum mismatch.'
[ "$(json "$manifest" bundleIdentifier)" = dev.diagnostichub.desktop ] || fail 'Bundle identifier mismatch.'
[ "$(json "$manifest" signature)" = ad-hoc ] || fail 'Unexpected signature policy.'
[ "$(json "$manifest" adHocIntegrityVerified)" = true ] || fail 'Missing integrity qualification.'
[ "$(json "$manifest" notarized)" = false ] || fail 'Unexpected notarization claim.'
commit="$(json "$manifest" commit)"
asar_hash="$(json "$manifest" asarSHA256)"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid source commit.'
[ "$(json "$stage/release.json" target_commitish)" = "$commit" ] || fail 'Release source commit mismatch.'
[[ "$asar_hash" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid ASAR checksum.'
minimum="$(json "$manifest" minimumMacOSVersion)"
[[ "$minimum" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail 'Invalid minimum macOS version.'
current="$(sw_vers -productVersion)"
os_ok() {
    local wanted="$1" installed="$2" w i n
    for n in 1 2 3; do
        w="${wanted%%.*}"; i="${installed%%.*}"
        [ "$i" -ge "$w" ] || return 1
        [ "$i" -eq "$w" ] || return 0
        case "$wanted" in *.*) wanted="${wanted#*.}" ;; *) wanted=0 ;; esac
        case "$installed" in *.*) installed="${installed#*.}" ;; *) installed=0 ;; esac
    done
}
os_ok "$minimum" "$current" || fail "Requires macOS $minimum or newer; this Mac runs $current."
zipinfo -1 "$stage/app.zip" > "$stage/entries"
[ -s "$stage/entries" ] || fail 'Empty archive.'
while IFS= read -r entry; do
    case "$entry" in
        'Diagnostic Hub.app/'*|'__MACOSX/Diagnostic Hub.app/'*|'__MACOSX/._Diagnostic Hub.app'|__MACOSX/) ;;
        *) fail "Unexpected archive root: $entry" ;;
    esac
    case "/${entry%/}/" in *'/../'*|*'/./'*|*'//'*) fail "Unsafe archive path: $entry" ;; esac
    case "$entry" in *\\*|*$'\r'*|*$'\t'*) fail 'Unsafe archive filename.' ;; esac
done < "$stage/entries"
[ "$(sort "$stage/entries" | uniq -d | wc -l | tr -d ' ')" = 0 ] || fail 'Duplicate archive paths.'
# Reject escaping links before extraction; Electron framework links are local.
zipinfo -l "$stage/app.zip" | awk '$1 ~ /^l/ {for(i=10;i<=NF;i++) printf "%s%s", $i,(i<NF?" ":"\n")}' > "$stage/links"
while IFS= read -r link; do
    value="$(unzip -p "$stage/app.zip" "$link")"
    [ -n "$value" ] || fail 'Empty archive link.'
    case "$value" in /*|*\\*|*$'\n'*|*$'\r'*) fail 'Unsafe archive link.' ;; esac
    case "/$value/" in *'/../'*|*'/./'*|*'//'*) fail 'Escaping archive link.' ;; esac
done < "$stage/links"
mkdir "$stage/extracted"
ditto -x -k "$stage/app.zip" "$stage/extracted"
app="$stage/extracted/Diagnostic Hub.app"
[ -d "$app" ] && [ ! -L "$app" ] || fail 'Archive must contain a real app bundle directory.'
plist="$app/Contents/Info.plist"
[ "$(json "$plist" CFBundleIdentifier)" = dev.diagnostichub.desktop ] || fail 'Installed bundle identity mismatch.'
[ "$(json "$plist" CFBundleShortVersionString)" = "$version" ] || fail 'Installed bundle version mismatch.'
[ "$(json "$plist" LSMinimumSystemVersion)" = "$minimum" ] || fail 'Installed minimum OS mismatch.'
for executable in 'Contents/MacOS/Diagnostic Hub' 'Contents/Frameworks/Electron Framework.framework/Electron Framework'; do
    [ "$(lipo -archs "$app/$executable")" = "$slice" ] || fail 'Installed binary architecture mismatch.'
done
[ "$(shasum -a 256 "$app/Contents/Resources/app.asar" | awk '{print $1}')" = "$asar_hash" ] || fail 'Installed application source mismatch.'
codesign --verify --deep --strict "$app" || fail 'Application integrity verification failed.'
codesign --display --verbose=4 "$app" 2> "$stage/signature"
grep -q '^Signature=adhoc$' "$stage/signature" || fail 'Expected an ad-hoc integrity signature.'
if [ -e "$target" ]; then
    if lsof -t "$target/Contents/MacOS/Diagnostic Hub" >/dev/null 2>&1; then fail 'Quit Diagnostic Hub before updating.'; fi
    mv "$target" "$stage/previous.app"
fi
mv "$app" "$target"
if [ "$launch" -eq 1 ]; then
    unset ELECTRON_RUN_AS_NODE
    if [ "$#" -gt 0 ]; then
        open -n -a "$target" --args "$@" || fail 'Launch refused; review macOS Privacy & Security or your organization policy.'
    else
        open -n -a "$target" || fail 'Launch refused; review macOS Privacy & Security or your organization policy.'
    fi
fi
committed=1
printf 'Installed Diagnostic Hub %s (%s), source %s at %s\n' "$version" "$arch" "$commit" "$target"
printf '%s\n' 'Ad-hoc integrity signature; not Developer ID signed or notarized. Updates require rerunning this helper.'
