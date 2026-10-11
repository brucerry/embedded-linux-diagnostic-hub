#!/usr/bin/env bash
# Run a verified portable app with optional per-user GNOME integration.
set -euo pipefail
umask 077

repo=brucerry/embedded-linux-diagnostic-hub
website=https://brucerry.github.io/embedded-linux-diagnostic-hub/
version=
format=AppImage
directory=
download_only=0
no_genie=0
remove_genie=0
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
        --no-genie) no_genie=1; shift ;;
        --remove-genie) remove_genie=1; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
done

# Execute installed setup only after checking the helper's recorded owned bytes.
managed_genie() {
    command -v python3 >/dev/null || { printf 'python3 is needed to manage the companion.\n' >&2; return 1; }
    python3 - "$1" <<'PY'
import hashlib, json, os, pathlib, subprocess, sys
uuid = 'diagnostic-hub-genie@diagnostichub.desktop'
root = pathlib.Path(os.environ.get('XDG_DATA_HOME', str(pathlib.Path.home()/'.local/share')))/'gnome-shell/extensions'/uuid
for path in [root, *root.parents]:
    if path.is_symlink(): raise SystemExit('Refusing a symlinked integration path.')
if not root.exists():
    print('Genie: no managed integration installed.')
    raise SystemExit(0)
record = json.loads((root/'managed.json').read_text())
names = sorted(['LICENSE','app-icon.png','extension.js','geometry.js','setup.py','build-info.js','metadata.json'])
if record.get('uuid') != uuid or sorted(record.get('files',{})) != names:
    raise SystemExit('Invalid integration ownership record.')
for name in names:
    path = root/name
    if path.is_symlink() or path.stat().st_uid != os.getuid() or hashlib.sha256(path.read_bytes()).hexdigest() != record['files'][name]:
        raise SystemExit('Managed source was changed; preserving it.')
raise SystemExit(subprocess.call([sys.executable,str(root/'setup.py'),sys.argv[1]]))
PY
}
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
    printf 'This desktop release requires Linux x86_64. Use the web workspace: %s\n' "$website" >&2
    exit 1
}
if (( remove_genie )); then
    (( EUID != 0 )) || { printf 'Manage Genie as your normal desktop user.\n' >&2; exit 1; }
    managed_genie --remove
    exit $?
fi
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
# BASH_REMATCH may be changed by another condition; read the verified document directly.
app_checksum=${line:0:64}
app_checksum=${app_checksum,,}
chmod u+x -- "$staged/$asset"
mv -f -- "$staged/$asset" "$directory/$asset"
printf 'Verified %s: %s/%s\n' "$version" "$directory" "$asset"
(( download_only )) && exit 0

optional_genie() {
    (( no_genie )) && { printf 'Genie: skipped (--no-genie).\n'; return 0; }
    local companion_format=modern shell_version= major= candidate= desktop=${XDG_CURRENT_DESKTOP:-} missing=() packages=() tool
    if command -v gdbus >/dev/null; then
        shell_version=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion 2>/dev/null) || true
    fi
    if [[ $shell_version =~ \'([0-9]+)\. ]]; then
        major=${BASH_REMATCH[1]}
    elif [[ ${desktop,,} == *gnome* ]] && command -v gnome-shell >/dev/null; then
        # A hint only until missing D-Bus utilities are installed and the live version is rechecked.
        candidate=$(gnome-shell --version 2>/dev/null) || true
        [[ $candidate =~ ([0-9]+)\. ]] && major=${BASH_REMATCH[1]}
    fi
    local ID= VERSION_ID=
    [[ -f /etc/os-release ]] && . /etc/os-release
    case "$ID:$VERSION_ID:$major" in
        ubuntu:24.04:46|ubuntu:26.04:50|debian:13:48) ;;
        ubuntu:22.04:42)
            companion_format=legacy42
            ;;
        *) printf 'Genie: unsupported desktop/session; using normal native window motion.\n'; return 0 ;;
    esac
    local integration="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/diagnostic-hub-genie@diagnostichub.desktop"
    local app_path="$(CDPATH= cd -- "$directory" && pwd)/$asset"
    if command -v python3 >/dev/null && python3 - "$integration/managed.json" "${version#v}" "$app_path" "$format" "$companion_format" <<'PY'
import json, pathlib, sys
try:
    record=json.loads(pathlib.Path(sys.argv[1]).read_text())
    valid=record['build']['version']==sys.argv[2] and record.get('app')==sys.argv[3] and record.get('appimage')==(sys.argv[4]=='AppImage') and record['build'].get('format','modern')==sys.argv[5]
except (OSError, ValueError, KeyError): valid=False
raise SystemExit(0 if valid else 1)
PY
    then
        managed_genie --status
        return $?
    fi
    local companion="Diagnostic-Hub-Genie-${version#v}.zip" checksum_line checksum
    [[ $companion_format != legacy42 ]] || companion="Diagnostic-Hub-Genie-Legacy42-${version#v}.zip"
    if ! fetch "$base/$companion.sha256" "$staged/$companion.sha256"; then
        printf 'Genie: no verified companion available for this release; using native motion.\n'
        return 0
    fi
    checksum_line=$(cat "$staged/$companion.sha256")
    [[ $checksum_line =~ ^([[:xdigit:]]{64})\ \ (.+)$ && ${BASH_REMATCH[2]} == "$companion" ]] || return 1
    checksum=${BASH_REMATCH[1],,}
    fetch "$base/$companion" "$staged/$companion" || return 1
    (cd -- "$staged" && sha256sum --check --status "$companion.sha256") || return 1
    fetch "$base/linux-build-info.json" "$staged/linux-build-info.json" || return 1
    for tool in python3 gdbus gsettings gnome-extensions; do
        if ! command -v "$tool" >/dev/null; then
            missing+=("$tool")
            case "$tool" in
                python3) packages+=(python3) ;;
                gdbus|gsettings) packages+=(libglib2.0-bin) ;;
                # Never install a desktop to obtain this utility.
                gnome-extensions) printf 'Genie: extension utility is unavailable; using native motion.\n'; return 0 ;;
            esac
        fi
    done
    { true </dev/tty; } 2>/dev/null || { printf 'Genie: skipped (no interactive terminal).\n'; return 0; }
    if (( ${#packages[@]} )); then
        command -v apt-get >/dev/null && command -v sudo >/dev/null || {
            printf 'Genie: missing optional utilities; sudo/apt is unavailable. Using native motion.\n'; return 0;
        }
        mapfile -t packages < <(printf '%s\n' "${packages[@]}" | sort -u)
    fi
    printf '\nOptional Genie motion for Diagnostic Hub only.\n' >/dev/tty
    printf 'Adds a per-user GNOME companion, app shortcut and icon. May need your next normal login.\n' >/dev/tty
    printf 'Preserves other extensions and global desktop preferences.\n' >/dev/tty
    if (( ${#packages[@]} )); then
        printf 'Missing optional apt packages:' >/dev/tty
        printf ' %s' "${packages[@]}" >/dev/tty
        printf '\nOnly package installation uses sudo.\n' >/dev/tty
    else
        printf 'No additional system packages are needed.\n' >/dev/tty
    fi
    printf 'Set up Genie? [y/N] ' >/dev/tty
    local answer=n
    read -r answer </dev/tty || answer=n
    [[ $answer == y || $answer == Y || $answer == yes ]] || { printf 'Genie: skipped.\n'; return 0; }
    if (( ${#packages[@]} )); then
        sudo apt-get install -y "${packages[@]}" || return 1
    fi
    for tool in python3 gdbus gsettings gnome-extensions; do command -v "$tool" >/dev/null || return 1; done
    shell_version=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion 2>/dev/null) || return 1
    [[ $shell_version =~ \'([0-9]+)\. && ${BASH_REMATCH[1]} == "$major" ]] || return 1
    # Verified bytes only; validate the complete archive before executing its setup module.
    python3 - "$staged/$companion" "$staged/genie" "${version#v}" "$staged/linux-build-info.json" \
        "$asset" "$app_checksum" "$companion" "$checksum" "$app_path" "$format" "$companion_format" <<'PY'
import hashlib, json, os, pathlib, re, stat, subprocess, sys, zipfile
archive, output, version, manifest, asset, app_hash, companion, zip_hash, app, format, companion_format = sys.argv[1:]
release=json.loads(pathlib.Path(manifest).read_text())
commit=release.get('commit','')
if release.get('version')!=version or not re.fullmatch('[a-f0-9]{40}',commit) or release.get('assets',{}).get(asset)!=app_hash or release['assets'].get(companion)!=zip_hash:
    raise SystemExit('Application/companion release identity mismatch.')
source=sorted(['LICENSE','app-icon.png','extension.js','geometry.js','setup.py'])
names=sorted(source+['build-info.js','metadata.json'])
with zipfile.ZipFile(archive) as package:
    members=package.infolist()
    if sorted(item.filename for item in members)!=names or sum(item.file_size for item in members)>2*1024*1024:
        raise SystemExit('Unexpected companion archive contents.')
    for item in members:
        if item.flag_bits&1 or stat.S_IFMT(item.external_attr>>16) not in (0,stat.S_IFREG) or item.compress_type not in (0,8):
            raise SystemExit('Unsafe companion archive member.')
    files={name:package.read(name) for name in names}
metadata=json.loads(files['metadata.json'])
build=metadata.get('diagnostic-hub',{})
hash=hashlib.sha256()
for name in source: hash.update((name+'\0').encode()); hash.update(files[name])
declaration='var' if companion_format=='legacy42' else 'export const'
shells=['42'] if companion_format=='legacy42' else ['46','48','50']
module=declaration+' BUILD = Object.freeze('+json.dumps(build,separators=(',',':'))+');\n'
if metadata.get('uuid')!='diagnostic-hub-genie@diagnostichub.desktop' or metadata.get('version-name')!=version or metadata.get('shell-version')!=shells or build.get('format','modern')!=companion_format or build.get('version')!=version or build.get('commit')!=commit or build.get('sourceHash')!=hash.hexdigest() or files['build-info.js'].decode()!=module:
    raise SystemExit('Companion metadata/source identity mismatch.')
output=pathlib.Path(output); output.mkdir(mode=0o700)
for name,data in files.items(): (output/name).write_bytes(data)
args=[sys.executable,str(output/'setup.py'),'--archive',archive,'--format',companion_format,'--version',version,'--commit',commit,'--app',app,'--app-sha256',app_hash]
if format=='AppImage': args.append('--appimage')
raise SystemExit(subprocess.call(args))
PY
}
if ! optional_genie; then
    printf 'Genie: setup failed; the verified app will run with native window motion.\n' >&2
fi
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
