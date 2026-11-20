"""Read-only diagnostics for the stock .NET launcher, SDK and SDK selection."""

import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

IMAGE = "20261116.376.1"
SDK = "10.0.404"
LAUNCHER = Path("/usr/bin/dotnet")
DOTNET = Path("/usr/share/dotnet/dotnet")
SDK_ROOT = DOTNET.parent / "sdk" / SDK
OUTPUT_CAP = 48 * 1024


class Refused(Exception):
    """Fixed result category suitable for an Actions step."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def check_inventory(env, arch, uid, euid, os_release):
    require(uid == euid and uid != 0 and env.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "runner-user-or-environment")
    require(arch == "x86_64" and env.get("RUNNER_ARCH") == "X64"
            and env.get("RUNNER_OS") == "Linux", "runner-platform")
    require("ID=ubuntu" in os_release.splitlines()
            and 'VERSION_ID="24.04"' in os_release.splitlines(), "runner-os")
    require(env.get("ImageOS") == "ubuntu24" and env.get("ImageVersion") == IMAGE, "runner-image")


def check_launcher_present():
    require(stat.S_ISLNK(LAUNCHER.lstat().st_mode) or LAUNCHER.is_file(), "launcher-entry")


def check_sdk_present():
    require(SDK_ROOT.is_dir() and (SDK_ROOT / "dotnet.dll").is_file(), "sdk-presence")


def check_link_target():
    require(stat.S_ISLNK(LAUNCHER.lstat().st_mode)
            and os.readlink(LAUNCHER) == str(DOTNET)
            and DOTNET.is_file(), "launcher-link-target")


def stock_directories(path):
    for part in path.parents:
        info = part.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, "stock-directory")


def stock_file(path):
    stock_directories(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and not info.st_mode & 0o022, "stock-file")


def check_custody():
    stock_directories(LAUNCHER)
    check_link_target()
    require(LAUNCHER.lstat().st_uid == 0, "launcher-owner")
    stock_file(DOTNET)
    stock_file(SDK_ROOT / "dotnet.dll")
    require(os.access(DOTNET, os.X_OK), "launcher-access")


def bounded_dotnet(args, directory, env):
    require(args == ("--version",), "command-scope")
    deadline = time.monotonic() + 12
    output = {1: bytearray(), 2: bytearray()}
    with subprocess.Popen([str(LAUNCHER), *args], cwd=directory, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as child:
        try:
            with selectors.DefaultSelector() as reader:
                reader.register(child.stdout, selectors.EVENT_READ, 1)
                reader.register(child.stderr, selectors.EVENT_READ, 2)
                while reader.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, "command-timeout")
                    for key, _ in reader.select(remaining):
                        block = os.read(key.fd, 4096)
                        if not block:
                            reader.unregister(key.fileobj)
                        output[key.data].extend(block)
                        require(sum(map(len, output.values())) <= OUTPUT_CAP, "command-output-cap")
            code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise Refused("command-timeout") from None
        except (OSError, Refused):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
    return code, bytes(output[1]), bytes(output[2])


def check_version(result):
    require(result == (0, (SDK + "\n").encode("ascii"), b""), "sdk-selection")


def prepare_environment(directory):
    (directory / "global.json").write_text(json.dumps({
        "sdk": {"version": SDK, "rollForward": "disable", "allowPrerelease": False},
    }), encoding="ascii")
    return {
        "HOME": str(directory), "DOTNET_CLI_HOME": str(directory),
        "PATH": "/usr/bin:/bin", "LC_ALL": "en_US.UTF-8", "DOTNET_CLI_UI_LANGUAGE": "en-US",
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
        "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH": "0", "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
    }


def run(stage):
    controls = {
        "launcher": (check_launcher_present, "system-launcher-present"),
        "sdk-files": (check_sdk_present, "pinned-sdk-files-present"),
        "link": (check_link_target, "documented-absolute-launcher-target"),
        "custody": (check_custody, "root-owned-stock-launcher-and-sdk"),
    }
    require(stage in (*controls, "inventory", "select"), "stage")
    with Path("/etc/os-release").open("r", encoding="utf-8") as stream:
        release = stream.read(8193)
    require(len(release) <= 8192, "runner-os")
    check_inventory(os.environ, os.uname().machine, os.getuid(), os.geteuid(), release)
    if stage == "inventory":
        return f"runner-ready ubuntu-24.04 x64 {IMAGE}"
    if stage in controls:
        action, verdict = controls[stage]
        action()
        return verdict
    check_custody()
    with tempfile.TemporaryDirectory(prefix="nuget-sdk-check-", dir=os.environ["RUNNER_TEMP"]) as work:
        directory = Path(work)
        env = prepare_environment(directory)
        check_version(bounded_dotnet(("--version",), directory, env))
    return f"sdk-selected {SDK}"


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "stage")
        print(run(sys.argv[1]))
    except Refused as exc:
        print(f"held {exc}")
        raise SystemExit(1) from None
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print("held local-prerequisite")
        raise SystemExit(1) from None
