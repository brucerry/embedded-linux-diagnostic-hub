#!/usr/bin/env bash
# Reviewed portable Linux delivery. Permanent managed layouts remain separately gated.
set -euo pipefail
umask 077
export LC_ALL=C
fail() { printf 'Diagnostic Hub: %s\n' "$*" >&2; exit 1; }
repo=brucerry/embedded-linux-diagnostic-hub
website=https://brucerry.github.io/embedded-linux-diagnostic-hub/
version=
format=AppImage
directory=
download_only=0
terminal_review=0
no_launch=0
launch=0
portable_choice=0
permanent_choice=0
install_directory=
install_choice=0
menu_choice=
while (( $# )); do
    case "$1" in
        --version|--format|--directory|--install-directory)
            (( $# >= 2 )) || fail "Missing value for $1"
            case "$1" in
                --version) version=$2 ;;
                --format) format=$2; portable_choice=1 ;;
                --directory) directory=$2; portable_choice=1 ;;
                --install-directory) [[ $install_choice == 0 ]] || fail 'Repeated permanent setup choice.'; install_directory=$2; install_choice=1; permanent_choice=1 ;;
            esac
            shift 2 ;;
        --download-only) download_only=1; portable_choice=1; shift ;;
        --portable) portable_choice=1; shift ;;
        --menu|--no-menu)
            [[ -z $menu_choice ]] || fail 'Repeated or conflicting menu choice.'
            menu_choice=$1; permanent_choice=1; shift ;;
        --terminal) terminal_review=1; shift ;;
        --no-launch) no_launch=1; shift ;;
        --help|-h) printf '%s\n' 'Usage: download-run.sh [--version vX.Y.Z] [--format AppImage|tar.gz] [--directory PATH] [--download-only] [--no-launch] [--terminal] [--portable] [--install-directory PATH] [--menu|--no-menu] (permanent setup is unavailable until qualified)'; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done
# New permanent intent never reinterprets the historical cache/format/download-only options.
if [[ $permanent_choice == 1 ]]; then
    [[ $portable_choice == 0 ]] || fail 'Permanent setup choices conflict with portable format/cache/download-only choices.'
    fail 'Permanent AppDir setup is not qualified. No download or installation was attempted. Use --portable or --download-only for the same selected release.'
fi
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail "This desktop release requires Linux x86_64. Use the web workspace: $website"
[[ $download_only == 1 || $EUID != 0 ]] || fail 'Run as your normal desktop user; administrator/root access is not needed.'
[[ $format == AppImage || $format == tar.gz ]] || fail 'Format must be AppImage or tar.gz.'
if [[ -n $version ]]; then [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'Use a release tag such as v0.6.0.'; fi
for tool in curl sha256sum mktemp realpath stat awk grep sed head wc cp ln cut cat rm chmod; do command -v "$tool" >/dev/null || fail "Required utility is unavailable: $tool"; done
asset="Diagnostic-Hub-linux-x64.$format"
# BEGIN GUARDED PATHS: Bash 3.2, fresh canonical ancestors at each mutation boundary.
hub_guard_paths=()
hub_guard_tokens=()
hub_guard_count=0
hub_guard_failed=0
hub_native_token() { stat -c '%d:%i' "$1"; }
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

# BEGIN LINUX METADATA: bounded parser; metadata is data, never shell code.
hub_json_scalar() {
    local file="$1" key="$2" bytes
    [ -f "$file" ] && [ ! -L "$file" ] || return 1
    bytes="$(wc -c < "$file")"
    [ "$bytes" -gt 0 ] && [ "$bytes" -le 2097152 ] || return 1
    LC_ALL=C awk -v requested="$key" '
    { document = document $0 "\n" }
    function error() { exit 65 }
    function space( c) { while (position <= length(document)) { c=substr(document,position,1); if(c!~/[ \t\r\n]/) break; position++ } }
    function component(parent,key) { return parent "/" length(key) ":" key }
    function string_value( out,c,e,u) {
        if(substr(document,position++,1)!="\"") error()
        out=""
        while(position<=length(document)) {
            c=substr(document,position++,1)
            if(c=="\"") return out
            if(c~/[[:cntrl:]]/) error()
            if(c=="\\") {
                e=substr(document,position++,1)
                if(e=="\"" || e=="\\" || e=="/") c=e
                else if(e=="b") c=sprintf("%c",8)
                else if(e=="f") c=sprintf("%c",12)
                else if(e=="n") c="\n"
                else if(e=="r") c="\r"
                else if(e=="t") c="\t"
                else if(e=="u") {
                    u=substr(document,position,4)
                    if(length(u)!=4 || u!~/^[0-9a-fA-F]+$/) error()
                    position+=4
                    # Known protocol keys/values are ASCII; escaped Unicode is unsupported there.
                    c="\\u" u
                } else error()
            }
            out=out c
        }
        error()
    }
    function scalar(path,type,content) {
        if(path==wanted) { found++; selected_type=type; selected_value=content }
    }
    function object_value(path,depth, k,separator,child) {
        position++; space()
        if(substr(document,position,1)=="}") { position++; return }
        while(1) {
            if(substr(document,position,1)!="\"") error()
            k=string_value(); if(index(k,"\\u")) error(); child=component(path,k)
            if(seen[child]++) error()
            space(); if(substr(document,position++,1)!=":") error()
            value(child,depth+1); space(); separator=substr(document,position++,1)
            if(separator=="}") return
            if(separator!=",") error()
            space()
        }
    }
    function array_value(path,depth, element_index,separator) {
        position++; space(); element_index=0
        if(substr(document,position,1)=="]") {position++;return}
        while(1) {
            value(component(path,"#" element_index++),depth+1); space(); separator=substr(document,position++,1)
            if(separator=="]") return
            if(separator!=",") error()
            space()
        }
    }
    function value(path,depth, c,number,tail) {
        if(depth>32 || ++tokens>100000) error()
        space(); c=substr(document,position,1)
        if(c=="{") {object_value(path,depth);return}
        if(c=="[") {array_value(path,depth);return}
        if(c=="\"") {scalar(path,"s",string_value());return}
        tail=substr(document,position)
        if(substr(tail,1,4)=="true") {position+=4;scalar(path,"b","true");return}
        if(substr(tail,1,5)=="false") {position+=5;scalar(path,"b","false");return}
        if(substr(tail,1,4)=="null") {position+=4;scalar(path,"z","null");return}
        if(match(tail,/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) {
            number=substr(tail,1,RLENGTH);position+=RLENGTH;scalar(path,"n",number);return
        }
        error()
    }
    END {
        wanted=""; count=split(requested,parts,"/")
        for(i=1;i<=count;i++) wanted=component(wanted,parts[i])
        position=1;tokens=0;found=0;space()
        if(substr(document,position,1)!="{") error()
        value("",0);space()
        if(position<=length(document) || found!=1) error()
        printf "%s\t%s",selected_type,selected_value
    }' "$file"
}
hub_json_string() {
    local field value
    field="$(hub_json_scalar "$1" "$2")" || return 1
    [ "${field%%$'\t'*}" = s ] || return 1
    value="${field#*$'\t'}"
    case "$value" in *[[:cntrl:]]*|*'\'*) return 1 ;; esac
    printf '%s' "$value"
}
# END LINUX METADATA

download_parent="$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)" || fail 'Temporary storage is unavailable.'
hub_track_directory_path "$download_parent" || fail 'Temporary ancestry is unsafe.'
hub_assert_existing_directory "$download_parent" || fail 'Temporary ancestry changed.'
staged="$(mktemp -d "$download_parent/DiagnosticHub-download.XXXXXXXX")"
hub_adopt_created_directory "$staged" || fail 'Temporary scratch identity is unsafe; preserve artifacts.'
staged_token="$(hub_directory_token "$staged")"
install_stage=''
install_stage_token=''
directory_tracked=0
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [ "$hub_guard_failed" -ne 0 ] || ! hub_assert_tree_bindings "$staged"; then
        printf 'Scratch identity changed; preserve %s and %s.\n' "$staged" "$install_stage" >&2
        [ "$status" -ne 0 ] || status=1; exit "$status"
    fi
    if [ "$directory_tracked" -eq 1 ] && ! hub_assert_directory_path "$directory"; then
        printf 'Destination ancestry changed; preserve %s and %s.\n' "$staged" "$install_stage" >&2
        [ "$status" -ne 0 ] || status=1; exit "$status"
    fi
    if [ -n "$install_stage" ]; then hub_remove_owned_stage "$install_stage" "$install_stage_token" || exit 1; fi
    hub_remove_owned_stage "$staged" "$staged_token" || exit 1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() {
    hub_guard_new_file "$2" || fail 'Unsafe download scratch.'
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-filesize "${3:-2147483648}" --output "$2" "$1"
}
fetch_metadata() {
    local status result
    hub_guard_new_file "$2" || fail 'Unsafe metadata download scratch.'
    if status=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-filesize "$3" --write-out '%{http_code}' --output "$2" "$1"); then result=0; else result=$?; fi
    if [[ $result == 0 && $status == 200 ]]; then return 0; fi
    if [[ $result == 22 && ( $status == 404 || $status == 410 ) && ! -s $2 ]]; then return 1; fi
    fail 'Metadata request failed or was incomplete; no checksum-only fallback is allowed for a damaged or denied response.'
}
if [[ -z $version ]]; then
    fetch "https://api.github.com/repos/$repo/releases?per_page=100" "$staged/releases.json" 2097152 || fail 'Release listing unavailable; retry with an explicit --version.'
    [[ $(wc -c < "$staged/releases.json") -le 2097152 ]] || fail 'Release listing exceeds its bound; choose --version.'
    # Retain the existing published-candidate selection, including engineering previews.
    url=$(grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"\\]+"' "$staged/releases.json" \
        | sed -E 's/^[^"]*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)"$/\1/' \
        | grep -E "^https://github.com/$repo/releases/download/v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?/${asset//./\.}$" | head -n 1) || true
    [[ -n $url ]] || fail "No compatible published release was found. See https://github.com/$repo/releases"
    version=${url%/*}; version=${version##*/}
fi
base="https://github.com/$repo/releases/download/$version"
printf 'Downloading %s for %s…\n' "$asset" "$version"
fetch "$base/$asset.sha256" "$staged/$asset.sha256"
line=$(cat "$staged/$asset.sha256")
[[ $line =~ ^([[:xdigit:]]{64})\ \ (.+)$ && ${BASH_REMATCH[2]} == "$asset" ]] || fail 'Invalid release checksum document; no package will be saved or launched.'
app_checksum=${line:0:64}; app_checksum=${app_checksum,,}
fetch "$base/$asset" "$staged/$asset"
[[ $(wc -c < "$staged/$asset") -gt 0 && $(wc -c < "$staged/$asset") -le 2147483648 ]] || fail 'Package is empty or exceeds its bound.'
(cd -- "$staged" && sha256sum --check --status "$asset.sha256") || fail 'Download checksum mismatch; no package will be saved or launched.'
source_available=0
source_commit=unavailable
release_fetched=0
info_fetched=0
if fetch_metadata "https://api.github.com/repos/$repo/releases/tags/$version" "$staged/selected-release.json" 2097152; then
    selected_tag=$(hub_json_string "$staged/selected-release.json" tag_name) || fail 'Invalid selected release metadata.'
    selected_commit=$(hub_json_string "$staged/selected-release.json" target_commitish) || fail 'Invalid release source commit.'
    draft=$(hub_json_scalar "$staged/selected-release.json" draft) || fail 'Missing release publication state.'
    [[ $selected_tag == "$version" && $draft == $'b\tfalse' && $selected_commit =~ ^[a-f0-9]{40}$ ]] || fail 'Release tag/publication/source identity mismatch.'
    release_fetched=1
fi
if fetch_metadata "$base/linux-build-info.json" "$staged/linux-build-info.json" 65536; then
    [[ $(wc -c < "$staged/linux-build-info.json") -le 65536 ]] || fail 'Linux source metadata exceeds its bound.'
    info_version=$(hub_json_string "$staged/linux-build-info.json" version) || fail 'Missing Linux build version.'
    info_platform=$(hub_json_string "$staged/linux-build-info.json" platform) || fail 'Missing Linux build platform.'
    info_arch=$(hub_json_string "$staged/linux-build-info.json" arch) || fail 'Missing Linux build architecture.'
    info_commit=$(hub_json_string "$staged/linux-build-info.json" commit) || fail 'Missing Linux build source.'
    info_hash=$(hub_json_string "$staged/linux-build-info.json" "assets/$asset") || fail 'Missing matching Linux package hash.'
    [[ $info_version == "${version#v}" && $info_platform == linux && $info_arch == x64 && $info_commit =~ ^[a-f0-9]{40}$ && $info_hash == "$app_checksum" ]] || fail 'Linux package version/architecture/source/checksum mismatch.'
    info_fetched=1
fi
if [[ $release_fetched == 1 && $info_fetched == 1 ]]; then
    [[ $selected_commit == "$info_commit" ]] || fail 'Linux package version/architecture/source/checksum mismatch.'
    source_commit=$info_commit
    source_available=1
elif [[ $download_only != 1 ]]; then
    fail "Selected release source metadata is unavailable. Use --download-only for a checksum-only legacy download or the web workspace: $website"
fi

directory=${directory:-${XDG_DATA_HOME:-$HOME/.local/share}/DiagnosticHub/downloads/$version}
directory=$(realpath -m -- "$directory") || fail 'Destination cannot be resolved.'
hub_track_directory_path "$directory" || fail 'Destination ancestry is unsafe.'
directory_tracked=1
target="$directory/$asset"
check_existing_package() {
    hub_assert_directory_path "$directory" || return 1
    if [[ -e $target || -L $target ]]; then
        [[ -f $target && ! -L $target && $(stat -c %h -- "$target") == 1 ]] || fail 'Existing package is aliased or not a regular single-link file; choose another folder.'
        [[ $(sha256sum -- "$target" | cut -d' ' -f1) == "$app_checksum" ]] || fail 'Existing package differs from the verified release; preserve it and choose another folder.'
    fi
}
check_existing_package
hub_bounded_tar_listing() {
    awk '{ bytes+=length($0)+1; count++; if(length($0)>4096 || bytes>4194304 || count>20000) exit 1; print } END { if(count==0) exit 1 }'
}
hub_validate_portable_tar() {
    local entry normalized members="$staged/archive-members.txt" details="$staged/archive-details.txt" names="$staged/archive-normalized.txt"
    for tool in tar find sort uniq; do command -v "$tool" >/dev/null || return 1; done
    hub_assert_existing_directory "$staged" || return 1
    hub_guard_new_file "$members" || return 1
    tar --list --quoting-style=escape -zf "$staged/$asset" | hub_bounded_tar_listing > "$members" || return 1
    [[ $(wc -c < "$members") -le 4194304 && $(wc -l < "$members") -gt 0 && $(wc -l < "$members") -le 20000 ]] || return 1
    hub_guard_new_file "$details" || return 1
    tar --list --verbose --numeric-owner --quoting-style=escape -zf "$staged/$asset" | hub_bounded_tar_listing > "$details" || return 1
    # This portable adapter supports plain files/directories only, never devices or links.
    awk '
        substr($1,1,1)!~/^[d-]$/ { exit 1 }
        substr($1,1,10)~/[sStT]/ { exit 1 }
        $3!~/^[0-9]+$/ { exit 1 }
        { count++; total+=$3; if(count>20000 || total>2147483648) exit 1 }
        END { if(count==0) exit 1 }
    ' "$details" || return 1
    hub_guard_new_file "$names" || return 1
    {
        while IFS= read -r entry; do
            normalized=${entry%/}; normalized=${normalized#./}
            [[ -n $normalized && $normalized != . ]] || continue
            [[ ${#normalized} -le 1024 ]] || return 1
            case "$normalized" in /*|*'\'*|*[[:cntrl:]]*) return 1 ;; esac
            case "/$normalized/" in *'/../'*|*'/./'*|*'//'*) return 1 ;; esac
            printf '%s\n' "$normalized"
        done < "$members"
    } > "$names"
    [[ -z $(sort "$names" | uniq -d) ]]
}

desktop_available=0
[[ -z ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] || desktop_available=1
launch_allowed=0
launch_reason='Open disabled by --no-launch.'
if [[ $no_launch == 0 ]]; then
    if [[ $desktop_available == 0 ]]; then launch_reason="No graphical session; save only or use $website"
    elif ! command -v setsid >/dev/null; then launch_reason='No session-isolation utility; save only and launch manually after checking prerequisites.'
    else launch_allowed=1; launch_reason='Open is optional and off by default. Missing libraries remain a manual prerequisite.'; fi
fi
tar_qualified=0
if [[ $format == tar.gz && $launch_allowed == 1 && $download_only != 1 ]]; then
    if hub_validate_portable_tar; then tar_qualified=1; else launch_allowed=0; launch_reason='Archive links/types/paths or inventory cannot be qualified for portable extraction; save only.'; fi
fi
review_action='Save portable package'
layout_note='Portable AppImage: the file is durable, but no-FUSE extraction occurs on each launch.'
[[ $format == AppImage ]] || layout_note='Portable archive: extraction is temporary for each run; this is not permanent-folder installation.'
review_text="Verified Diagnostic Hub $version (Linux x64)
Source commit: $source_commit
SHA256: $app_checksum
Package: $target

$layout_note
$launch_reason
Existing profiles/reports are retained. This helper adds no shortcuts or installed identity. Permanent managed/folder setup remains unavailable until its native contract is qualified.
No sudo, FUSE installation, sandbox override or host permission change. Unsigned package; publisher metadata/checksum integrity is not an independent signature."
review_file="$staged/review.txt"
hub_guard_new_file "$review_file" || fail 'Unsafe review scratch.'
printf '%s\n' "$review_text" > "$review_file"
# BEGIN LINUX GUIDED REVIEW
hub_terminal_review() {
    # /dev/tty is the controlling terminal, independent of curl | bash script input.
    if ! { : </dev/tty; } 2>/dev/null; then return 3; fi
    exec 3<>/dev/tty || return 3
    printf '\n%s\n' "$review_text" >&3
    if [ "$launch_allowed" -eq 1 ]; then
        printf '%s [i], %s and open [o], or cancel [c, default]: ' "$review_action" "$review_action" >&3
    else
        printf '%s [i], or cancel [c, default] (Open unavailable for this choice or host): ' "$review_action" >&3
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


hub_linux_gui_review() {
    local response='' result=3 markup encoded
    [ "$desktop_available" -eq 1 ] || return 3
    command -v timeout >/dev/null 2>&1 || return 3
    markup="$(printf '%s' "$review_text" | sed 's/\&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g')"
    # Zenity list labels use Pango markup and GLib backslash decoding.
    encoded="$(printf '%s' "$markup" | sed 's/\\/\\\\/g')"
    if command -v zenity >/dev/null 2>&1; then
        choices=(TRUE "$review_action")
        if [ "$launch_allowed" -eq 1 ]; then choices+=(FALSE "$review_action and Open"); fi
        if response=$(timeout --kill-after=2s 65s zenity --list --radiolist --title='Diagnostic Hub Setup' --text="$encoded" --column='' --column=Action --print-column=2 --hide-header --ok-label=Continue --cancel-label=Cancel --timeout=60 --width=760 --height=540 "${choices[@]}" </dev/null); then
            case "$response" in
                "$review_action") launch=0; return 0 ;;
                "$review_action and Open") [ "$launch_allowed" -eq 1 ] && { launch=1; return 0; } ;;
            esac
            return 3
        else
            result=$?
            case "$result" in 1|5|124|137) return 1 ;; esac
        fi
    fi
    if command -v kdialog >/dev/null 2>&1; then
        # A readonly file view preserves literal full paths without Qt rich-text inference.
        if timeout --kill-after=2s 65s kdialog --title 'Diagnostic Hub Setup — review' --textbox "$review_file" 760 540 </dev/null; then :; else
            result=$?; case "$result" in 1|2|124|137) return 1 ;; *) return 3 ;; esac
        fi
        choices=(save "$review_action" on)
        if [ "$launch_allowed" -eq 1 ]; then choices+=(open "$review_action and Open" off); fi
        if response=$(timeout --kill-after=2s 65s kdialog --title 'Diagnostic Hub Setup' --radiolist 'Choose the reviewed operation; Open is optional.' "${choices[@]}" </dev/null); then
            case "$response" in save) launch=0; return 0 ;; open) [ "$launch_allowed" -eq 1 ] && { launch=1; return 0; } ;; esac
            return 3
        else
            result=$?; case "$result" in 1|2|124|137) return 1 ;; esac
        fi
    fi
    return 3
}
hub_linux_confirm() {
    local result=3
    if [ "$terminal_review" -eq 0 ]; then
        if hub_linux_gui_review; then return 0; else result=$?; fi
        [ "$result" -ne 1 ] || return 1
        printf '%s\n' 'Native review is unavailable; trying the controlling terminal.' >&2
    fi
    if hub_terminal_review; then return 0; else result=$?; fi
    if [ "$result" -eq 3 ]; then
        printf 'No usable native dialog or controlling terminal. Nothing was saved to the selected folder or launched. Piped stdin is not consent. Use --download-only, or download and verify:\n  %s/%s\n  %s/%s.sha256\n  %s/linux-build-info.json\nWeb workspace: %s\n' "$base" "$asset" "$base" "$asset" "$base" "$website" >&2
        return 3
    fi
    return 1
}
# END LINUX GUIDED REVIEW

if [[ $download_only != 1 ]]; then
    if hub_linux_confirm; then :; else
        result=$?; [[ $result != 1 ]] || { printf '%s\n' 'Setup cancelled; selected folder and existing package were not changed.'; exit 0; }
        fail 'Explicit setup confirmation is unavailable.'
    fi
fi
# Verify every bound ancestor BEFORE any destination creation, including missing components.
hub_make_directory_tree "$directory" || fail 'Reviewed ancestry changed before destination creation; preserve artifacts.'
[[ -O $directory ]] || fail 'Choose a destination directory owned by your user.'
check_existing_package
if [[ ! -e $target ]]; then
    hub_assert_existing_directory "$directory" || fail 'Destination ancestry changed before staging.'
    install_stage=$(mktemp -d "$directory/.DiagnosticHub-stage.XXXXXXXX")
    hub_adopt_created_directory "$install_stage" || fail 'Package stage identity changed.'
    install_stage_token=$(hub_directory_token "$install_stage")
    incoming="$install_stage/$asset"
    hub_guard_new_file "$incoming" || fail 'Unsafe package copy destination.'
    hub_assert_existing_directory "$staged" || fail 'Download ancestry changed.'
    cp -- "$staged/$asset" "$incoming"
    hub_assert_existing_directory "$install_stage" || fail 'Package stage ancestry changed.'
    [[ -f $incoming && ! -L $incoming && $(stat -c %h -- "$incoming") == 1 && $(sha256sum -- "$incoming" | cut -d' ' -f1) == "$app_checksum" ]] || fail 'Staged package bytes changed.'
    incoming_token=$(hub_native_token "$incoming")
    if [[ $format == AppImage ]]; then
        hub_assert_existing_directory "$install_stage" || fail 'Stage ancestry changed before setting the owned package executable bit.'
        [[ ! -L $incoming && $(stat -c %h -- "$incoming") == 1 && $(hub_native_token "$incoming") == "$incoming_token" ]] || fail 'Package identity changed before setting its executable bit.'
        chmod u+x -- "$incoming"
    fi
    hub_guard_new_file "$target" || fail 'Destination appeared or changed before activation.'
    hub_assert_existing_directory "$install_stage" || fail 'Stage ancestry changed before activation.'
    [[ $(hub_native_token "$incoming") == "$incoming_token" && ! -L $incoming ]] || fail 'Package file identity changed.'
    # Same-volume exclusive link avoids overwriting an unexpected destination.
    ln -T -- "$incoming" "$target" || fail 'Exclusive final-file creation failed; destination changed or this filesystem lacks hard-link support. Existing files were preserved; choose another owned folder.'
    hub_assert_existing_directory "$directory" || fail 'Destination ancestry changed after activation.'
    hub_assert_existing_directory "$install_stage" || fail 'Stage ancestry changed after activation.'
    [[ ! -L $target && $(hub_native_token "$target") == "$incoming_token" && $(hub_native_token "$incoming") == "$incoming_token" ]] || fail 'Activated package identity changed; preserve artifacts.'
    rm -- "$incoming"
fi
printf 'Saved verified %s: %s\nSource: %s\n' "$version" "$target" "$source_commit"
if [[ $source_available == 0 ]]; then printf '%s\n' 'Checksum verified; source metadata was unavailable for this download-only request.'; fi
[[ $download_only != 1 && $launch == 1 ]] || exit 0
[[ $launch_allowed == 1 ]] || fail 'Open is unavailable on this host; the verified package remains saved.'
check_existing_package
target_token=$(hub_native_token "$target")
hub_assert_existing_directory "$directory" || fail 'Destination ancestry changed before launch.'
[[ ! -L $target && $(stat -c %h -- "$target") == 1 && $(hub_native_token "$target") == "$target_token" ]] || fail 'Verified package identity changed before launch.'
unset ELECTRON_RUN_AS_NODE
printf '%s\n' 'Requesting normal portable launch. Native application readiness has not been observed.'
if [[ $format == AppImage ]]; then
    [[ -x $target ]] || fail 'Verified AppImage is not executable here; choose an executable user-owned location. No permission policy was changed.'
    setsid --wait "$target" --appimage-extract-and-run || fail 'Normal launch failed; the verified file remains saved. Check desktop libraries or executable-mount policy; no host settings were changed.'
else
    [[ $tar_qualified == 1 ]] || fail 'Archive extraction is unsupported; the verified file remains saved.'
    hub_make_new_directory "$staged/app" || fail 'Unsafe temporary archive extraction root.'
    hub_assert_existing_directory "$directory" || fail 'Package ancestry changed before extraction.'
    hub_assert_existing_directory "$staged/app" || fail 'Extraction ancestry changed.'
    [[ ! -L $target && $(hub_native_token "$target") == "$target_token" ]] || fail 'Archive file identity changed.'
    tar --no-same-owner --no-same-permissions -xzf "$target" -C "$staged/app"
    hub_assert_existing_directory "$staged/app" || fail 'Extraction root identity changed.'
    mapfile -t launchers < <(find "$staged/app" -mindepth 1 -maxdepth 2 -type f -name AppRun -print)
    [[ ${#launchers[@]} == 1 ]] || fail 'Archive needs exactly one supported AppRun entry; no application was started.'
    app_root=${launchers[0]%/AppRun}
    hub_track_directory_path "$app_root" || fail 'Extracted entry ancestry is unsafe.'
    hub_assert_existing_directory "$app_root" || fail 'Extracted entry ancestry changed.'
    [[ -x "$app_root/AppRun" && -f "$app_root/diagnostic-hub" && ! -L "$app_root/AppRun" && ! -L "$app_root/diagnostic-hub" ]] || fail 'Archive executable or safe launcher is absent.'
    setsid --wait "$app_root/AppRun" || fail 'Normal archive launch failed; verified archive remains saved. Check manual prerequisites without changing host policy.'

fi
