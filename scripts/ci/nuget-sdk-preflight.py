"""Read-only runner and CLI checks. Invokes only .NET version and help commands."""

import json
import os
from pathlib import Path
import re
import selectors
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time

IMAGE = "20261116.376.1"
SDK = "10.0.404"
DOTNET = Path("/usr/share/dotnet/dotnet")
SDK_ROOT = DOTNET.parent / "sdk" / SDK
SYSTEM_SIGNING = Path("/etc/pki/ca-trust/extracted/pem/objsign-ca-bundle.pem")
OUTPUT_CAP = 48 * 1024
HELP_OPTIONS = (b"--all", b"--certificate-fingerprint", b"--configfile")
BAD_OUTPUT = re.compile(rb"\bNU[0-9]{4}\b|\b(?:warning|error)(?:[ :]|$)", re.I)


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


def stock_file(path):
    for part in path.parents:
        info = part.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, "stock-path")
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and not info.st_mode & 0o022, "stock-file")


def bounded_dotnet(args, directory, env):
    require(args in (("--version",), ("nuget", "verify", "--help")), "command-scope")
    deadline = time.monotonic() + 12
    output = {1: bytearray(), 2: bytearray()}
    with subprocess.Popen([str(DOTNET), *args], cwd=directory, env=env, stdin=subprocess.DEVNULL,
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


def check_help(result):
    code, stdout, stderr = result
    require(code == 0 and not stderr and 0 < len(stdout) <= OUTPUT_CAP, "verify-help")
    require(not BAD_OUTPUT.search(stdout)
            and all(re.search(rb"(?m)^\s*" + option + rb"(?:\s|$)", stdout)
                    for option in HELP_OPTIONS), "verify-help")


def check_pem_bundle(raw):
    require(0 < len(raw) <= 512 * 1024, "stock-trust-bundle")
    certs = re.findall(rb"-----BEGIN CERTIFICATE-----\r?\n[\w+/=\r\n]+?-----END CERTIFICATE-----", raw)
    require(bool(certs), "stock-trust-bundle")
    try:
        for cert in certs:
            require(ssl.PEM_cert_to_DER_cert(cert.decode("ascii")).startswith(b"0"),
                    "stock-trust-bundle")
    except (ValueError, UnicodeError):
        raise Refused("stock-trust-bundle") from None


def check_stock_trust():
    paths = [SDK_ROOT / "trustedroots" / name for name in ("codesignctl.pem", "timestampctl.pem")]
    if SYSTEM_SIGNING.exists() or SYSTEM_SIGNING.is_symlink():
        paths.append(SYSTEM_SIGNING)
    for path in paths:
        stock_file(path)
        with path.open("rb") as stream:
            check_pem_bundle(stream.read(512 * 1024 + 1))


def prepare_environment(directory):
    (directory / "global.json").write_text(json.dumps({
        "sdk": {"version": SDK, "rollForward": "disable", "allowPrerelease": False},
    }), encoding="ascii")
    return {
        "HOME": str(directory), "DOTNET_CLI_HOME": str(directory),
        "PATH": "/usr/bin:/bin", "LC_ALL": "en_US.UTF-8", "DOTNET_CLI_UI_LANGUAGE": "en-US",
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
        "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH": "0", "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
        "NUGET_CERT_REVOCATION_MODE": "online",
    }


def run(stage):
    require(stage in ("inventory", "sdk", "cli"), "stage")
    with Path("/etc/os-release").open("r", encoding="utf-8") as stream:
        release = stream.read(8193)
    require(len(release) <= 8192, "runner-os")
    check_inventory(os.environ, os.uname().machine, os.getuid(), os.geteuid(), release)
    if stage == "inventory":
        return f"runner-ready ubuntu-24.04 x64 {IMAGE}"
    stock_file(DOTNET)
    stock_file(SDK_ROOT / "dotnet.dll")
    require(os.access(DOTNET, os.X_OK), "stock-file")
    with tempfile.TemporaryDirectory(prefix="nuget-sdk-check-", dir=os.environ["RUNNER_TEMP"]) as work:
        directory = Path(work)
        env = prepare_environment(directory)
        check_version(bounded_dotnet(("--version",), directory, env))
        if stage == "sdk":
            return f"sdk-selected {SDK}"
        stock_file(SDK_ROOT / "NuGet.CommandLine.XPlat.dll")
        check_stock_trust()
        check_help(bounded_dotnet(("nuget", "verify", "--help"), directory, env))
    return "verify-cli-and-stock-trust-inputs-available"


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
