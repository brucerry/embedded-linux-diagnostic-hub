#!/usr/bin/env python3
"""Verified per-user companion setup. Never elevates or controls an app window."""
import argparse
import ast
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

UUID = "diagnostic-hub-genie@diagnostichub.desktop"
APPLICATION_ID = "diagnostic-hub.desktop"
SOURCE_FILES = sorted(["LICENSE", "app-icon.png", "extension.js", "geometry.js", "setup.py"])
ARCHIVE_FILES = sorted(SOURCE_FILES + ["build-info.js", "metadata.json"])
MARKER = "managed.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_archive(archive, version, commit, format="modern"):
    if format not in ("modern", "legacy42"):
        raise ValueError("Unknown companion format")
    shells = ["42"] if format == "legacy42" else ["46", "48", "50"]
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        if sorted(item.filename for item in members) != ARCHIVE_FILES:
            raise ValueError("Unexpected companion archive contents")
        if sum(item.file_size for item in members) > 2 * 1024 * 1024:
            raise ValueError("Companion exceeds its size limit")
        for item in members:
            mode = item.external_attr >> 16
            if (item.flag_bits & 1 or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                    or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError("Unsafe companion archive member")
        files = {name: package.read(name) for name in ARCHIVE_FILES}
    metadata = json.loads(files["metadata.json"])
    build = metadata.get("diagnostic-hub", {})
    source = hashlib.sha256()
    for name in SOURCE_FILES:
        source.update((name + "\0").encode())
        source.update(files[name])
    declaration = "var" if format == "legacy42" else "export const"
    expected_module = declaration + " BUILD = Object.freeze(" + json.dumps(build, separators=(",", ":")) + ");\n"
    if (not re.fullmatch(r"\d+\.\d+\.\d+(?:-[\w.-]+)?", version)
            or not re.fullmatch(r"[a-f0-9]{40}", commit)
            or metadata.get("uuid") != UUID or metadata.get("version-name") != version
            or metadata.get("shell-version") != shells
            or build.get("format", "modern") != format
            or build.get("version") != version or build.get("commit") != commit
            or build.get("sourceHash") != source.hexdigest()
            or files["build-info.js"].decode() != expected_module):
        raise ValueError("Companion release identity mismatch")
    return files, build


def safe_path(path, owned=False):
    path = Path(path).absolute()
    if ".." in path.parts or any(char in str(path) for char in "\n\r\t"):
        raise ValueError("Unsafe integration path")
    for current in [path, *path.parents]:
        if current.is_symlink():
            raise ValueError("Symlinked integration path")
        if current.exists() and current.stat().st_uid not in (0, os.getuid()):
            raise ValueError("Integration path belongs to another user")
    if owned and path.exists() and path.stat().st_uid != os.getuid():
        raise ValueError("Integration destination is not user-owned")
    return path


def user_directory(path):
    path = safe_path(path, True)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    safe_path(path, True)
    return path


def command(args, required=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=5,
                            env={**os.environ, "LC_ALL": "C"})
    if required and result.returncode:
        raise RuntimeError("Desktop command failed: " + args[0])
    return result.stdout.strip() if result.returncode == 0 else None


def setting(key):
    value = command(["gsettings", "get", "org.gnome.shell", key])
    if value in ("true", "false"):
        return value == "true"
    return ast.literal_eval(value.removeprefix("@as "))


def set_enabled(wanted):
    # Read again on every write, preserving other extensions and concurrent edits.
    current = setting("enabled-extensions")
    if not isinstance(current, list) or any(not isinstance(item, str) for item in current):
        raise ValueError("Invalid extension enablement setting")
    updated = [item for item in current if item != UUID]
    if wanted:
        updated.append(UUID)
    if updated != current:
        command(["gsettings", "set", "org.gnome.shell", "enabled-extensions", repr(updated)])


def live_status(build):
    try:
        output = command(["gdbus", "call", "--session", "--dest", "org.gnome.Shell",
                          "--object-path", "/dev/diagnostichub/Genie", "--method",
                          "dev.diagnostichub.Genie1.GetStatus"], False)
        value = json.loads(ast.literal_eval(output)[0]) if output else {}
        return value if all(value.get(key) == build.get(key) for key in ("version", "commit", "sourceHash", "format")) else {}
    except (ValueError, TypeError, SyntaxError, OSError, subprocess.SubprocessError):
        return {}


def paths():
    home = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    if not home.is_absolute():
        raise ValueError("XDG data directory must be absolute")
    data = safe_path(home, True)
    return (data, safe_path(data / "gnome-shell/extensions" / UUID, True),
            safe_path(data / "applications" / APPLICATION_ID, True),
            safe_path(data / "icons/hicolor/256x256/apps/diagnostic-hub.png", True))


def managed(extension, desktop, icon):
    if not extension.exists():
        if desktop.exists() or icon.exists():
            raise ValueError("Existing desktop registration is not managed by this helper")
        return None
    if not extension.is_dir():
        raise ValueError("Extension destination is not a directory")
    marker = safe_path(extension / MARKER, True)
    if not marker.is_file():
        raise ValueError("Existing extension is not managed by this helper")
    previous = json.loads(marker.read_text())
    if previous.get("uuid") != UUID or sorted(previous.get("files", {})) != ARCHIVE_FILES:
        raise ValueError("Invalid integration ownership record")
    if sorted(item.name for item in extension.iterdir()) != sorted(ARCHIVE_FILES + [MARKER]):
        raise ValueError("Existing integration contains unowned files")
    for name, checksum in previous["files"].items():
        file = safe_path(extension / name, True)
        if not file.is_file() or digest(file.read_bytes()) != checksum:
            raise ValueError("Existing managed source was modified; preserving it")
    for file, key in ((desktop, "desktopSha256"), (icon, "iconSha256")):
        if not file.is_file() or digest(file.read_bytes()) != previous.get(key):
            raise ValueError("Managed registration was modified; preserving it")
    return previous


def exec_argument(value):
    value = str(value).replace("%", "%%")
    if any(char in value for char in "\n\r\t"):
        raise ValueError("Unsafe desktop argument")
    for char in ("\\", '"', "`", "$"):
        value = value.replace(char, "\\" + char)
    return ('"' + value + '"').replace("\\", "\\\\")


def desktop_entry(app, appimage, icon, extension, checksum):
    app = safe_path(app, True)
    if not app.is_file():
        raise ValueError("Persistent verified application is missing")
    # Apply Exec argument quoting, then the desktop file's string escaping.
    if appimage:
        executable = exec_argument(app) + " --appimage-extract-and-run"
    else:
        executable = " ".join(exec_argument(arg) for arg in (
            sys.executable, extension / "setup.py", "--launch-archive", app,
            "--app-sha256", checksum))
    icon_value = str(icon).replace("\\", "\\\\")
    return ("[Desktop Entry]\nName=Diagnostic Hub\nType=Application\nTerminal=false\n"
            f"Exec={executable}\nIcon={icon_value}\n"
            "StartupWMClass=diagnostic-hub\nCategories=Development;\n"
            "X-Diagnostic-Hub-Managed=true\n").encode()


def describe(build, extension, desktop, icon):
    value = live_status(build)
    size = sum(file.stat().st_size for file in extension.iterdir()) + desktop.stat().st_size + icon.stat().st_size
    print(f"Genie companion and registration: {size} installed bytes. System prerequisites are separate.")
    if value.get("active"):
        suffix = " Desktop animations are disabled by your preference." if not value.get("animations") else ""
        print("Genie: active for Diagnostic Hub." + suffix)
    elif setting("disable-user-extensions"):
        print("Genie: pending activation; user extensions are globally disabled. Your desktop preference was preserved.")
    elif UUID not in setting("enabled-extensions"):
        print("Genie: skipped; this companion is disabled by your preference.")
    else:
        print("Genie: pending activation. Sign out and back in when convenient; the app can run now.")


@contextmanager
def workspace(data):
    work = Path(tempfile.mkdtemp(prefix=".diagnostic-hub-genie-", dir=data))
    try:
        yield work
    except Exception:
        if any(item.name.startswith("old-") for item in work.iterdir()):
            print(f"Previous integration backup retained for recovery: {work}")
        else:
            shutil.rmtree(work)
        raise
    else:
        shutil.rmtree(work)


def install(args):
    files, build = validate_archive(args.archive, args.version, args.commit, getattr(args, "format", "modern"))
    data, extension, desktop, icon = paths()
    previous = managed(extension, desktop, icon)
    app = safe_path(args.app, True)
    if not re.fullmatch(r"[a-f0-9]{64}", args.app_sha256) or digest(app.read_bytes()) != args.app_sha256:
        raise ValueError("Verified application checksum mismatch")
    if previous and previous.get("build") == build and previous.get("app") == str(Path(args.app).absolute()) and previous.get("appimage") == args.appimage:
        describe(build, extension, desktop, icon)
        return
    entry = desktop_entry(args.app, args.appimage, icon, extension, args.app_sha256)
    was_enabled = UUID in setting("enabled-extensions")
    user_directory(data)
    for parent in (extension.parent, desktop.parent, icon.parent):
        user_directory(parent)
    # All proposed changes are validated before the old effect is disabled.
    with workspace(data) as work:
        fresh = work / "extension"
        fresh.mkdir(mode=0o700)
        for name, contents in files.items():
            (fresh / name).write_bytes(contents)
            (fresh / name).chmod(0o600)
        record = {"uuid": UUID, "build": build, "app": str(Path(args.app).absolute()), "appimage": args.appimage,
                  "files": {name: digest(contents) for name, contents in files.items()},
                  "desktopSha256": digest(entry), "iconSha256": digest(files["app-icon.png"])}
        (fresh / MARKER).write_text(json.dumps(record, indent=4) + "\n")
        (work / "desktop").write_bytes(entry)
        (work / "icon").write_bytes(files["app-icon.png"])
        changes = []
        try:
            if previous:
                command(["gnome-extensions", "disable", UUID], False)
                set_enabled(False)
            for destination, source, backup_name in (
                    (extension, fresh, "old-extension"),
                    (desktop, work / "desktop", "old-desktop"),
                    (icon, work / "icon", "old-icon")):
                safe_path(destination, True)
                backup = work / backup_name if destination.exists() else None
                if backup:
                    destination.rename(backup)
                changes.append((destination, backup))
                source.rename(destination)
            if not setting("disable-user-extensions"):
                command(["gnome-extensions", "enable", UUID], False)
            set_enabled(True)
        except Exception:
            for destination, backup in reversed(changes):
                if destination.exists():
                    if destination.is_dir():
                        shutil.rmtree(destination)
                    else:
                        destination.unlink()
                if backup:
                    backup.rename(destination)
            set_enabled(was_enabled)
            raise
    describe(build, extension, desktop, icon)


def remove():
    data, extension, desktop, icon = paths()
    previous = managed(extension, desktop, icon)
    if not previous:
        print("Genie: no managed integration to remove.")
        return
    was_enabled = UUID in setting("enabled-extensions")
    with workspace(data) as work:
        changes = []
        try:
            command(["gnome-extensions", "disable", UUID], False)
            set_enabled(False)
            for file in (extension, desktop, icon):
                backup = work / ("old-" + file.name)
                file.rename(backup)
                changes.append((file, backup))
        except Exception:
            for file, backup in reversed(changes):
                backup.rename(file)
            set_enabled(was_enabled)
            raise
    print("Genie: removed. Downloaded apps, other extensions and device data remain.")


def launch_archive(archive, checksum):
    archive = safe_path(archive, True)
    if not re.fullmatch(r"[a-f0-9]{64}", checksum) or digest(archive.read_bytes()) != checksum:
        raise ValueError("Application archive checksum mismatch")
    with tempfile.TemporaryDirectory(prefix="diagnostic-hub-app-") as work:
        with tarfile.open(archive, "r:gz") as package:
            package.extractall(work, filter="data")
        launchers = list(Path(work).glob("*/AppRun")) + list(Path(work).glob("AppRun"))
        if len(launchers) != 1 or not launchers[0].is_file():
            raise ValueError("Application archive has no unique launcher")
        environment = dict(os.environ)
        environment.pop("ELECTRON_RUN_AS_NODE", None)
        return subprocess.call([str(launchers[0])], env=environment)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive")
    parser.add_argument("--format", choices=("modern", "legacy42"), default="modern")
    parser.add_argument("--version")
    parser.add_argument("--commit")
    parser.add_argument("--app")
    parser.add_argument("--appimage", action="store_true")
    parser.add_argument("--app-sha256")
    parser.add_argument("--launch-archive")
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if os.getuid() == 0:
        raise ValueError("Run optional setup as your ordinary desktop user")
    if args.launch_archive:
        if not args.app_sha256:
            parser.error("Verified archive checksum is required")
        raise SystemExit(launch_archive(args.launch_archive, args.app_sha256))
    elif args.remove:
        remove()
    elif args.status:
        _data, extension, desktop, icon = paths()
        previous = managed(extension, desktop, icon)
        if previous:
            describe(previous["build"], extension, desktop, icon)
        else:
            print("Genie: not installed.")
    else:
        if not all((args.archive, args.version, args.commit, args.app, args.app_sha256)):
            parser.error("Verified archive, release identity and persistent app path are required")
        install(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Genie: setup failed ({error}). The ordinary app can still run.", file=__import__("sys").stderr)
        raise SystemExit(1)
