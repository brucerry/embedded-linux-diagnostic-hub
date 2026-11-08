#!/bin/bash
# macOS Bash 3.2 installer; uses built-in tools only.
set -euo pipefail
export LC_ALL=C
fail() { printf 'Diagnostic Hub: %s\n' "$*" >&2; exit 1; }
tag=''
directory="$HOME/Applications"
launch=0
launch_allowed=1
terminal_review=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) [ "$#" -ge 2 ] || fail 'Missing version.'; tag="$2"; shift 2 ;;
        --directory) [ "$#" -ge 2 ] || fail 'Missing directory.'; directory="$2"; shift 2 ;;
        --no-launch) launch=0; launch_allowed=0; shift ;;
        --terminal) terminal_review=1; shift ;;
        --help|-h) printf '%s\n' 'Usage: download-run-macos.sh [--version vX.Y.Z] [--directory PATH] [--no-launch] [--terminal] [-- APP_ARGUMENTS]'; exit 0 ;;
        --) shift; break ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[ "$(uname -s)" = Darwin ] || fail 'This helper requires macOS.'
[ "$EUID" -ne 0 ] || fail 'Run as your normal user, without sudo.'
if [ -n "$tag" ]; then
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'Unsafe version tag.'
fi
for tool in curl plutil shasum ditto codesign lipo unzip zipinfo lsof stat; do
    command -v "$tool" >/dev/null || fail "Missing macOS tool: $tool"
done
machine="$(uname -m)"
arm="$(sysctl -n hw.optional.arm64 2>/dev/null || printf 0)"
case "$machine:$arm" in
    arm64:*|x86_64:1) arch=arm64; slice=arm64 ;;
    x86_64:*) arch=x64; slice=x86_64 ;;
    *) fail "Unsupported Mac architecture: $machine" ;;
esac
# BEGIN GUARDED PATHS: Bash 3.2, fresh canonical ancestors at each mutation boundary.
hub_guard_paths=()
hub_guard_tokens=()
hub_guard_count=0
hub_guard_failed=0
hub_native_token() { stat -f '%d:%i' "$1"; }
hub_guard_error() {
    hub_guard_failed=1
    printf 'Diagnostic Hub: filesystem identity check failed: %s. Preserve setup artifacts.\n' "$*" >&2
    return 1
}
hub_guard_index() {
    local i
    for ((i=0; i<hub_guard_count; i++)); do
        if [ "${hub_guard_paths[$i]}" = "$1" ]; then printf '%s' "$i"; return 0; fi
    done
    return 1
}
hub_directory_token() {
    local current token
    [ ! -L "$1" ] || return 1
    if [ ! -e "$1" ]; then printf absent; return 0; fi
    [ -d "$1" ] || return 1
    current="$(CDPATH= cd -- "$1" && pwd -P)" || return 1
    [ "$current" = "$1" ] || return 1
    token="$(hub_native_token "$1")" || return 1
    [[ "$token" =~ ^[0-9]+:[0-9]+$ ]] || return 1
    printf '%s' "$token"
}
hub_guard_remember() {
    local index
    if index="$(hub_guard_index "$1")"; then hub_guard_tokens[$index]="$2"; return 0; fi
    [ "$hub_guard_count" -lt 512 ] || { hub_guard_error 'path table exceeds its bound'; return 1; }
    hub_guard_paths[$hub_guard_count]="$1"
    hub_guard_tokens[$hub_guard_count]="$2"
    hub_guard_count=$((hub_guard_count+1))
}
hub_walk_directory_path() {
    local path="$1" mode="$2" prefix=/ rest part actual index expected
    case "$path" in /*) ;; *) hub_guard_error 'absolute canonical path required'; return 1 ;; esac
    case "$path" in *[[:cntrl:]]*|*'/../'*|*'/./'*|*'//'*) hub_guard_error 'non-canonical path'; return 1 ;; esac
    [ "${#path}" -le 4096 ] || { hub_guard_error 'path exceeds its bound'; return 1; }
    rest="${path#/}"
    while :; do
        actual="$(hub_directory_token "$prefix")" || { hub_guard_error "$prefix is aliased or not a plain directory"; return 1; }
        if index="$(hub_guard_index "$prefix")"; then
            expected="${hub_guard_tokens[$index]}"
            [ "$actual" = "$expected" ] || { hub_guard_error "$prefix changed since review/creation"; return 1; }
        elif [ "$mode" = track ]; then
            hub_guard_remember "$prefix" "$actual" || return 1
        else
            hub_guard_error "$prefix was not bound before mutation"; return 1
        fi
        [ -n "$rest" ] || break
        part="${rest%%/*}"
        case "$part" in ''|.|..) hub_guard_error 'unsafe path component'; return 1 ;; esac
        prefix="${prefix%/}/$part"
        if [ "$rest" = "$part" ]; then rest=''; else rest="${rest#*/}"; fi
    done
}
hub_track_directory_path() { hub_walk_directory_path "$1" track; }
hub_assert_directory_path() { hub_walk_directory_path "$1" check; }
hub_assert_existing_directory() {
    local index
    hub_assert_directory_path "$1" || return 1
    index="$(hub_guard_index "$1")" || return 1
    [ "${hub_guard_tokens[$index]}" != absent ] || { hub_guard_error 'required parent is absent'; return 1; }
}
hub_expect_new_destination() {
    local parent="${1%/*}" index
    [ -n "$parent" ] || parent=/
    hub_assert_existing_directory "$parent" || return 1
    if [ -e "$1" ] || [ -L "$1" ]; then hub_guard_error "$1 unexpectedly exists"; return 1; fi
    if index="$(hub_guard_index "$1")"; then
        [ "${hub_guard_tokens[$index]}" = absent ] || { hub_guard_error 'destination identity changed'; return 1; }
    else
        hub_guard_remember "$1" absent || return 1
    fi
}
hub_adopt_created_directory() {
    local parent="${1%/*}" token index
    [ -n "$parent" ] || parent=/
    hub_assert_existing_directory "$parent" || return 1
    token="$(hub_directory_token "$1")" || { hub_guard_error 'new directory is aliased'; return 1; }
    [ "$token" != absent ] || { hub_guard_error 'new directory is absent'; return 1; }
    if index="$(hub_guard_index "$1")"; then
        [ "${hub_guard_tokens[$index]}" = absent ] || [ "${hub_guard_tokens[$index]}" = "$token" ] || { hub_guard_error 'new directory replaced a bound identity'; return 1; }
    fi
    hub_guard_remember "$1" "$token"
}
hub_make_new_directory() {
    hub_expect_new_destination "$1" || return 1
    mkdir "$1" || return 1
    hub_adopt_created_directory "$1"
}
hub_make_directory_tree() {
    local path="$1" prefix=/ rest="${1#/}" part index
    # Check the entire reviewed ancestry before creating even the first missing component.
    hub_assert_directory_path "$path" || return 1
    while [ -n "$rest" ]; do
        part="${rest%%/*}"; prefix="${prefix%/}/$part"
        index="$(hub_guard_index "$prefix")" || { hub_guard_error 'unbound creation path'; return 1; }
        if [ "${hub_guard_tokens[$index]}" = absent ]; then hub_make_new_directory "$prefix" || return 1; fi
        if [ "$rest" = "$part" ]; then rest=''; else rest="${rest#*/}"; fi
    done
    hub_assert_existing_directory "$path"
}
hub_guard_new_file() {
    local parent="${1%/*}"
    [ -n "$parent" ] || parent=/
    hub_assert_existing_directory "$parent" || return 1
    if [ -e "$1" ] || [ -L "$1" ]; then hub_guard_error 'refuse replacement of an existing setup file'; return 1; fi
}
hub_move_directory() {
    local source="$1" destination="$2" token index parent="${2%/*}" parent_token
    [ -n "$parent" ] || parent=/
    hub_assert_existing_directory "$source" || return 1
    hub_expect_new_destination "$destination" || return 1
    index="$(hub_guard_index "$source")" || return 1; token="${hub_guard_tokens[$index]}"
    parent_token="$(hub_directory_token "$parent")" || { hub_guard_error 'move parent is unsafe'; return 1; }
    [ "${token%%:*}" = "${parent_token%%:*}" ] || { hub_guard_error 'replacement must remain on one filesystem'; return 1; }
    mv "$source" "$destination" || return 1
    hub_guard_remember "$source" absent || return 1
    hub_guard_remember "$destination" "$token" || return 1
    hub_assert_directory_path "$source" && hub_assert_existing_directory "$destination"
}
hub_assert_tree_bindings() {
    local root="$1" i candidate
    hub_assert_existing_directory "$root" || return 1
    for ((i=0; i<hub_guard_count; i++)); do
        candidate="${hub_guard_paths[$i]}"
        case "$candidate" in "$root"|"$root"/*) hub_assert_directory_path "$candidate" || return 1 ;; esac
    done
}
hub_remove_owned_stage() {
    local root="$1" expected="$2" actual i candidate
    [ "$hub_guard_failed" -eq 0 ] || { hub_guard_error 'earlier identity failure requires preserving artifacts'; return 1; }
    [ -n "$root" ] && [ -n "$expected" ] && [ "$expected" != absent ] || { hub_guard_error 'missing stage identity'; return 1; }
    case "$root" in
        "$download_parent"/DiagnosticHub-download.????????) ;;
        "$directory"/.DiagnosticHub-stage.????????) ;;
        *) hub_guard_error 'stage outside its exact creation namespace'; return 1 ;;
    esac
    hub_assert_tree_bindings "$root" || return 1
    actual="$(hub_directory_token "$root")" || { hub_guard_error 'stage root is unsafe'; return 1; }
    [ "$actual" = "$expected" ] || { hub_guard_error 'stage device/inode changed'; return 1; }
    rm -rf -- "$root" || return 1
    if [ -e "$root" ] || [ -L "$root" ]; then hub_guard_error 'stage removal did not complete'; return 1; fi
    for ((i=0; i<hub_guard_count; i++)); do
        candidate="${hub_guard_paths[$i]}"
        case "$candidate" in "$root"|"$root"/*) hub_guard_tokens[$i]=absent ;; esac
    done
}
# END GUARDED PATHS

case "$directory" in /*) ;; *) directory="$PWD/$directory" ;; esac
case "$directory" in *$'\n'*|*$'\r'*) fail 'Choose a folder without line breaks.' ;; esac
[ ! -L "$directory" ] || fail 'Installation directory must not be a symlink.'
# Resolve the existing ancestor without creating the requested application folder.
ancestor="$directory"
suffix=''
while [ ! -e "$ancestor" ]; do
    [ ! -L "$ancestor" ] || fail 'Installation directory must not contain a dangling alias.'
    leaf="${ancestor##*/}"
    case "$leaf" in ''|.|..) fail 'Use an ordinary existing parent for the application folder.' ;; esac
    suffix="/$leaf$suffix"
    ancestor="${ancestor%/*}"
    [ -n "$ancestor" ] || ancestor=/
done
[ -d "$ancestor" ] || fail 'The application parent is not a directory.'
directory="$(cd "$ancestor" && pwd -P)$suffix"
target="$directory/Diagnostic Hub.app"
hub_track_directory_path "$directory" || fail 'Application ancestry is unsafe.'
hub_track_directory_path "$target" || fail 'Application identity is unsafe.'
[ ! -L "$target" ] || fail 'Existing application must not be a symlink.'
if [ -e "$target" ]; then
    [ -d "$target" ] && [ -O "$target" ] || fail 'Existing application must be a directory owned by your user.'
    if lsof -t "$target/Contents/MacOS/Diagnostic Hub" >/dev/null 2>&1; then fail 'Quit Diagnostic Hub before installing or updating.'; fi
fi
umask 077
# Bind canonical existing ancestors before temporary creation; later changes preserve artifacts.
download_parent="$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)" || fail 'Temporary directory is unavailable.'
hub_track_directory_path "$download_parent" || fail 'Temporary ancestry is unsafe.'
hub_assert_existing_directory "$download_parent" || fail 'Temporary ancestry changed.'
download_stage="$(mktemp -d "$download_parent/DiagnosticHub-download.XXXXXXXX")"
hub_adopt_created_directory "$download_stage" || fail 'Download scratch identity is unsafe; preserve it.'
download_stage_token="$(hub_directory_token "$download_stage")" || fail 'Download scratch identity is unavailable.'
stage="$download_stage"
install_stage=''
install_stage_token=''
committed=0
cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$hub_guard_failed" -ne 0 ] || ! hub_assert_directory_path "$directory" || ! hub_assert_directory_path "$target" || ! hub_assert_tree_bindings "$download_stage"; then
        printf 'Setup identity changed; no cleanup or recovery move attempted. Preserve download %s and stage %s.\n' "$download_stage" "$install_stage" >&2
        [ "$status" -ne 0 ] || status=1
        exit "$status"
    fi
    if [ -n "$install_stage" ] && ! hub_assert_tree_bindings "$install_stage"; then
        printf 'Installation stage changed; preserve %s and %s.\n' "$install_stage" "$download_stage" >&2
        [ "$status" -ne 0 ] || status=1
        exit "$status"
    fi
    if [ "$committed" -eq 0 ] && [ -n "$install_stage" ] && [ -e "$install_stage/previous.app" ]; then
        if [ -e "$target" ]; then
            hub_move_directory "$target" "$install_stage/failed.app" || {
                printf 'Recovery refused; retain app and stage %s.\n' "$install_stage" >&2; exit 1;
            }
        fi
        hub_move_directory "$install_stage/previous.app" "$target" || {
            printf 'Rollback failed; prior app preserved at %s\n' "$install_stage/previous.app" >&2; exit 1;
        }
    fi
    if [ -n "$install_stage" ]; then
        hub_remove_owned_stage "$install_stage" "$install_stage_token" || {
            printf 'Stage cleanup refused; preserve %s and %s.\n' "$install_stage" "$download_stage" >&2; exit 1;
        }
    fi
    hub_remove_owned_stage "$download_stage" "$download_stage_token" || {
        printf 'Download cleanup refused; preserve %s.\n' "$download_stage" >&2; exit 1;
    }
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fetch() { hub_guard_new_file "$2" || fail 'Unsafe download destination.'; curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$1" -o "$2"; }
repo='brucerry/embedded-linux-diagnostic-hub'
api="https://api.github.com/repos/$repo/releases"
if [ -n "$tag" ]; then api="$api/tags/$tag"; else api="$api/latest"; fi
printf '%s\n' 'Downloading release metadata…'
fetch "$api" "$stage/release.json"
json() {
    case "$1" in
        "$stage"/*) hub_assert_existing_directory "$stage" || return 1 ;;
        "$target"/*) hub_assert_existing_directory "$target" || return 1 ;;
        *) fail 'Metadata path is outside the selected bundle/scratch.' ;;
    esac
    [ -f "$1" ] && [ ! -L "$1" ] || fail 'Metadata file is not regular.'
    plutil -extract "$2" raw -o - "$1"
}
resolved="$(json "$stage/release.json" tag_name)"
[[ "$resolved" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'Unsafe release tag.'
[ -z "$tag" ] || [ "$tag" = "$resolved" ] || fail 'Release tag mismatch.'
[ "$(json "$stage/release.json" draft)" = false ] || fail 'Release is not published.'
tag="$resolved"
version="${tag#v}"
asset="Diagnostic-Hub-macos-$arch.zip"
base="https://github.com/$repo/releases/download/$tag"
printf 'Downloading macOS %s bundle…\n' "$arch"
fetch "$base/$asset" "$stage/app.zip"
fetch "$base/$asset.sha256" "$stage/checksum"
fetch "$base/macos-build-info-$arch.json" "$stage/manifest.json"
printf '%s\n' 'Verifying archive checksum and release identity…'
actual="$(shasum -a 256 "$stage/app.zip" | awk '{print $1}')"
hub_guard_new_file "$stage/expected" || fail 'Unsafe checksum scratch.'
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
hub_guard_new_file "$stage/entries" || fail 'Unsafe archive inventory.'
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
hub_guard_new_file "$stage/links" || fail 'Unsafe link inventory.'
zipinfo -l "$stage/app.zip" | awk '$1 ~ /^l/ {for(i=10;i<=NF;i++) printf "%s%s", $i,(i<NF?" ":"\n")}' > "$stage/links"
while IFS= read -r link; do
    value="$(unzip -p "$stage/app.zip" "$link")"
    [ -n "$value" ] || fail 'Empty archive link.'
    case "$value" in /*|*\\*|*$'\n'*|*$'\r'*) fail 'Unsafe archive link.' ;; esac
    case "/$value/" in *'/../'*|*'/./'*|*'//'*) fail 'Escaping archive link.' ;; esac
done < "$stage/links"
hub_make_new_directory "$stage/extracted" || fail 'Unsafe extraction directory.'
hub_expect_new_destination "$stage/extracted/Diagnostic Hub.app" || fail 'Unexpected extraction bundle.'
hub_assert_existing_directory "$stage/extracted" || fail 'Extraction ancestry changed.'
ditto -x -k "$stage/app.zip" "$stage/extracted"
hub_adopt_created_directory "$stage/extracted/Diagnostic Hub.app" || fail 'Extracted bundle identity changed.'
app="$stage/extracted/Diagnostic Hub.app"
[ -d "$app" ] && [ ! -L "$app" ] || fail 'Archive must contain a real app bundle directory.'
verify_bundle() {
    app="$1"
    hub_assert_existing_directory "$app" || fail 'Bundle ancestry changed.'
    plist="$app/Contents/Info.plist"
    [ "$(json "$plist" CFBundleIdentifier)" = dev.diagnostichub.desktop ] || fail 'Installed bundle identity mismatch.'
    [ "$(json "$plist" CFBundleShortVersionString)" = "$version" ] || fail 'Installed bundle version mismatch.'
    [ "$(json "$plist" LSMinimumSystemVersion)" = "$minimum" ] || fail 'Installed minimum OS mismatch.'
    for executable in 'Contents/MacOS/Diagnostic Hub' 'Contents/Frameworks/Electron Framework.framework/Electron Framework'; do
        [ "$(lipo -archs "$app/$executable")" = "$slice" ] || fail 'Installed binary architecture mismatch.'
    done
    [ "$(shasum -a 256 "$app/Contents/Resources/app.asar" | awk '{print $1}')" = "$asar_hash" ] || fail 'Installed application source mismatch.'
    printf '%s\n' 'Verifying native bundle architecture, source and integrity…'
    codesign --verify --deep --strict "$app" || fail 'Application integrity verification failed.'
    hub_guard_new_file "$stage/signature" || fail 'Unsafe integrity output.'
    codesign --display --verbose=4 "$app" 2> "$stage/signature"
    grep -q '^Signature=adhoc$' "$stage/signature" || fail 'Expected an ad-hoc integrity signature.'

}
verify_bundle "$app"
# BEGIN GUIDED REVIEW: standalone Bash 3.2; input is never read from piped stdin.
hub_terminal_review() {
    # /dev/tty is the controlling terminal, independent of curl | bash script input.
    if ! { : </dev/tty; } 2>/dev/null; then return 3; fi
    exec 3<>/dev/tty || return 3
    printf '\n%s\n' "$review_text" >&3
    if [ "$launch_allowed" -eq 1 ]; then
        printf '%s [i], %s and open [o], or cancel [c, default]: ' "$review_action" "$review_action" >&3
    else
        printf '%s [i], or cancel [c, default] (launch disabled by --no-launch): ' "$review_action" >&3
    fi
    answer=''
    if ! IFS= read -r -t 120 -u 3 answer; then
        printf '\nReview timed out or the terminal closed; cancelled.\n' >&3
        exec 3>&-
        return 1
    fi
    exec 3>&-
    case "$answer" in
        i|I) launch=0; return 0 ;;
        o|O) if [ "$launch_allowed" -eq 1 ]; then launch=1; return 0; fi ;;
    esac
    return 1
}

hub_native_review() {
    command -v osascript >/dev/null 2>&1 || return 3
    response=''
    if ! response=$(osascript - "$review_text" "$review_action" "$launch_allowed" <<'HUB_REVIEW_APPLESCRIPT'
on run argv
    set reviewText to item 1 of argv
    set actionText to item 2 of argv
    set openText to actionText & " and Open"
    set reviewButtons to {"Cancel", actionText}
    if item 3 of argv is "1" then set reviewButtons to {"Cancel", actionText, openText}
    try
        with timeout of 65 seconds
            set choice to display dialog reviewText with title "Diagnostic Hub Setup" buttons reviewButtons default button "Cancel" cancel button "Cancel" giving up after 60
        end timeout
        if gave up of choice then return "cancel"
        if button returned of choice is openText then return "open"
        if button returned of choice is actionText then return "install"
        return "cancel"
    on error errorMessage number errorNumber
        if errorNumber is -128 then return "cancel"
        return "unavailable"
    end try
end run
HUB_REVIEW_APPLESCRIPT
    ); then return 3; fi
    case "$response" in
        install) launch=0; return 0 ;;
        open) if [ "$launch_allowed" -eq 1 ]; then launch=1; return 0; fi ;;
        cancel) return 1 ;;
    esac
    return 3
}

hub_confirm_review() {
    review_text="Verified Diagnostic Hub $version ($arch), release $tag
Action: $review_action application files
Existing version: $installed_version
Application: $target

Current user only. Existing settings and reports are retained; credentials, device connections and grants are not migrated. No login items, global shortcuts or host security settings are changed.

Ad-hoc integrity signature; not Developer ID signed or notarized. Normal macOS policy still applies. Updates remain manual. Launch is off unless you explicitly choose Open."
    review_status=3
    if [ "$terminal_review" -eq 0 ]; then
        if hub_native_review; then return 0; else review_status=$?; fi
        [ "$review_status" -ne 1 ] || return 1
        printf '%s\n' 'Native review is unavailable; trying the controlling terminal.' >&2
    fi
    if hub_terminal_review; then return 0; else review_status=$?; fi
    if [ "$review_status" -eq 3 ]; then
        printf 'No usable setup dialog or controlling terminal. Nothing was installed. Run from an interactive Terminal, or manually download and verify:\n  %s/%s\n  %s/%s.sha256\n  %s/macos-build-info-%s.json\nPiped stdin is not installation consent.\n' "$base" "$asset" "$base" "$asset" "$base" "$arch" >&2
        return 3
    fi
    return 1
}
# END GUIDED REVIEW

installed_version=None
review_action=Install
target_token=absent
target_info_hash=''
if [ -e "$target" ]; then
    [ "$(json "$target/Contents/Info.plist" CFBundleIdentifier)" = dev.diagnostichub.desktop ] || fail 'Existing folder is not a recognized Diagnostic Hub bundle; choose another directory.'
    installed_version="$(json "$target/Contents/Info.plist" CFBundleShortVersionString)"
    [[ "$installed_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'Existing app version is invalid; preserve it and choose another directory.'
    target_token="$(stat -f '%d:%i' "$target")"
    target_info_hash="$(shasum -a 256 "$target/Contents/Info.plist" | awk '{print $1}')"
    review_action=Replace
    [ "$installed_version" != "$version" ] || review_action=Repair
fi
if hub_confirm_review; then :; else
    review_status=$?
    [ "$review_status" -ne 1 ] || { printf '%s\n' 'Setup cancelled. Application files and settings were not changed.'; exit 0; }
    fail 'Setup review could not obtain explicit confirmation. Use an interactive Terminal or the manual ZIP/checksum download.'
fi
# Only the confirmed operation can create a destination or same-volume stage.
hub_make_directory_tree "$directory" || fail 'Reviewed ancestry changed before directory creation; preserve artifacts.'
[ "$(cd "$directory" && pwd -P)" = "$directory" ] && [ -O "$directory" ] && [ ! -L "$directory" ] || fail 'Application directory identity or ownership changed; preserve existing files.'
check_reviewed_target() {
    hub_assert_directory_path "$target" || fail 'Reviewed application ancestry changed.'
    [ ! -L "$target" ] || fail 'Application path changed to an alias after review.'
    if [ "$target_token" = absent ]; then
        [ ! -e "$target" ] || fail 'An application appeared after review; run setup again to review it.'
    else
        [ -d "$target" ] && [ -O "$target" ] && [ "$(stat -f '%d:%i' "$target")" = "$target_token" ] || fail 'Existing application identity changed after review.'
        [ "$(shasum -a 256 "$target/Contents/Info.plist" | awk '{print $1}')" = "$target_info_hash" ] || fail 'Existing application metadata changed after review.'
    fi
}
check_reviewed_target
hub_assert_existing_directory "$directory" || fail 'Installation ancestry changed before staging.'
install_stage="$(mktemp -d "$directory/.DiagnosticHub-stage.XXXXXXXX")"
hub_adopt_created_directory "$install_stage" || fail 'Unsafe installation stage; preserve artifacts.'
install_stage_token="$(hub_directory_token "$install_stage")" || fail 'Stage identity unavailable.'
hub_make_new_directory "$install_stage/extracted" || fail 'Unsafe same-volume extraction directory.'
hub_assert_existing_directory "$app" || fail 'Source bundle ancestry changed.'
hub_expect_new_destination "$install_stage/extracted/Diagnostic Hub.app" || fail 'Unexpected staging bundle.'
ditto "$app" "$install_stage/extracted/Diagnostic Hub.app"
hub_adopt_created_directory "$install_stage/extracted/Diagnostic Hub.app" || fail 'Staged bundle identity changed.'
stage="$install_stage"
verify_bundle "$install_stage/extracted/Diagnostic Hub.app"
check_reviewed_target
if [ -e "$target" ]; then
    if lsof -t "$target/Contents/MacOS/Diagnostic Hub" >/dev/null 2>&1; then fail 'Quit Diagnostic Hub before updating.'; fi
    hub_move_directory "$target" "$stage/previous.app" || fail 'Could not retain the reviewed previous app.'
fi
printf 'Installing verified application at %s…\n' "$target"
hub_move_directory "$app" "$target" || fail 'Could not activate verified bundle; guarded rollback will be attempted.'
if [ "$launch" -eq 1 ]; then
    printf 'Requesting normal launch of %s…\n' "$target"
    unset ELECTRON_RUN_AS_NODE
    if [ "$#" -gt 0 ]; then
        open -n -a "$target" --args "$@" || fail 'Launch refused; review macOS Privacy & Security or your organization policy.'
    else
        open -n -a "$target" || fail 'Launch refused; review macOS Privacy & Security or your organization policy.'
    fi
fi
committed=1
if [ "$launch" -eq 1 ]; then
    printf '%s\n' 'Launch requested; confirm the opened application version and location.'
else
    printf '%s\n' 'No launch requested.'
fi
printf 'Installed Diagnostic Hub %s (%s), source %s at %s\n' "$version" "$arch" "$commit" "$target"
printf '%s\n' 'Ad-hoc integrity signature; not Developer ID signed or notarized. Updates require rerunning this helper.'
