"""Inert path, digest, version and signature checks for stock Windows NuGet."""

import base64
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time

IMAGE = "20261116.315.1"
TOOL = Path(r"C:\ProgramData\Chocolatey\lib\NuGet.CommandLine\tools\nuget.exe")
POWERSHELL = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
TOOL_HASH = "d4ddb222cb8fca8200b59e82286c0cba9c29b4fce6f9835fdfa54e67c9483d07"
CAP = 96 * 1024
SHIM = Path(r"C:\ProgramData\Chocolatey\bin\nuget.exe")
class Refused(Exception):
    """Fixed, safe outcome category."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def check_host(env, version, window_build, ubr, installation):
    require(env.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and env.get("RUNNER_OS") == "Windows" and env.get("RUNNER_ARCH") == "X64"
            and env.get("PROCESSOR_ARCHITECTURE") == "AMD64", "host-identity")
    require(env.get("ImageVersion") == IMAGE, "runner-image")
    require(version == (10, 0, 26100)
            and window_build == "26100" and ubr == 33828 and installation == "Server",
            "windows-build")


def host():
    require(os.name == "nt" and sys.version_info[:3] == (3, 12, 10)
            and sys.maxsize > 2**32, "stock-python")
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                        0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        fields = [winreg.QueryValueEx(key, n)[0] for n in
                  ("CurrentBuildNumber", "UBR", "InstallationType")]
    v = sys.getwindowsversion()
    check_host(os.environ, (v.major, v.minor, v.build), *fields)


def file_identity(path):
    for parent in path.parents:
        data = parent.lstat()
        require(stat.S_ISDIR(data.st_mode)
                and not data.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT, "stock-parent")
    data = path.lstat()
    require(stat.S_ISREG(data.st_mode) and data.st_nlink == 1
            and not data.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT, "stock-file")
    return data.st_dev, data.st_ino, data.st_size, data.st_mtime_ns, data.st_ctime_ns


def pinned(path, expect, maximum, exact=None):
    before = file_identity(path)
    require(0 < before[2] <= maximum and (exact is None or exact == before[2]), "stock-size")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        require((opened.st_dev, opened.st_ino, opened.st_size) == before[:3], "stock-file")
        remain = before[2]
        while remain:
            chunk = stream.read(min(65536, remain))
            require(bool(chunk), "stock-hash")
            remain -= len(chunk)
            digest.update(chunk)
        require(not stream.read(1) and digest.hexdigest() == expect
                and file_identity(path) == before, "stock-hash")
    return before


def bounded(argv, directory, seconds):
    deadline = time.monotonic() + seconds
    output = bytearray()
    overflow = threading.Event()
    read_error = threading.Event()
    with subprocess.Popen(argv, cwd=directory, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT) as child:
        def collect():
            try:
                while block := child.stdout.read1(4096):
                    if len(output) + len(block) > CAP:
                        overflow.set()
                        return
                    output.extend(block)
            except OSError:
                read_error.set()

        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            while child.poll() is None and not overflow.is_set() and not read_error.is_set():
                require(time.monotonic() < deadline, "command-timeout")
                time.sleep(0.02)
            require(not overflow.is_set() and not read_error.is_set(), "command-output")
            reader.join(max(0, deadline - time.monotonic()))
            require(not reader.is_alive() and not overflow.is_set() and not read_error.is_set(),
                    "command-closure")
            return child.returncode, bytes(output)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=4)
            child.stdout.close()
            reader.join(2)



VERSION_CODE = r"""
$ErrorActionPreference = 'Stop'
$p = 'C:\ProgramData\Chocolatey\lib\NuGet.CommandLine\tools\nuget.exe'
$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)
if ("$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart).$($v.FilePrivatePart)" -cne '8.0.0.137') { exit 1 }
[Console]::WriteLine('stock-file-version-8.0.0.137')
exit 0
"""
SIGNATURE_CODE = r"""
$ErrorActionPreference = 'Stop'
$p = 'C:\ProgramData\Chocolatey\lib\NuGet.CommandLine\tools\nuget.exe'
$s = Get-AuthenticodeSignature -LiteralPath $p
if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or
    $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation' -or
    $s.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { exit 1 }
[Console]::WriteLine('windows-authenticode-microsoft-valid')
exit 0
"""


def check_resolved(resolved, payload=TOOL, shim=SHIM, identify=file_identity):
    require(resolved is not None, "nuget-path-resolution")
    normalized = os.path.normcase(resolved)
    choices = {os.path.normcase(str(path)): path for path in (payload, shim)}
    require(normalized in choices, "nuget-stock-path")
    identify(choices[normalized])


def powershell_args(code):
    encoded = base64.b64encode(code.encode("utf-16-le")).decode("ascii")
    return [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]


def check_result(result, marker, reason):
    code, data = result
    require(code == 0 and data.strip() == marker, reason)


def inspect_with_powershell(code, marker, reason):
    before = file_identity(TOOL)
    file_identity(POWERSHELL)
    with tempfile.TemporaryDirectory(prefix="nuget-file-inspect-", dir=os.environ["RUNNER_TEMP"]) as work:
        check_result(bounded(powershell_args(code), Path(work), 25), marker, reason)
    require(file_identity(TOOL) == before, "stock-file-changed")


def run(args):
    require(len(args) == 1 and args[0] in
            ("host", "revocation", "path", "custody", "hash", "version", "signature"), "scope")
    stage = args[0]
    host()
    if stage == "host":
        return "windows-2025-vs2026-x64-image-20261116.315.1-build-33828"
    if stage == "revocation":
        require(os.environ.get("NUGET_CERT_REVOCATION_MODE", "").casefold() in ("", "online"),
                "stock-revocation-setting")
        return "stock-nuget-revocation-setting"
    if stage == "path":
        check_resolved(shutil.which("nuget.exe"))
        return "stock-nuget-resolution"
    if stage == "custody":
        file_identity(TOOL)
        return "stock-nuget-payload-custody"
    if stage == "hash":
        pinned(TOOL, TOOL_HASH, 32 * 1024 * 1024)
        return "stock-nuget-sha256-matched"
    if stage == "version":
        inspect_with_powershell(VERSION_CODE, b"stock-file-version-8.0.0.137", "nuget-file-version")
        return "stock-file-version-8.0.0.137"
    inspect_with_powershell(SIGNATURE_CODE, b"windows-authenticode-microsoft-valid", "nuget-authenticode")
    return "windows-authenticode-microsoft-valid"


if __name__ == "__main__":
    try:
        print(run(sys.argv[1:]))
    except Refused as exc:
        print(f"held {exc}")
        raise SystemExit(1) from None
    except (KeyError, OSError, subprocess.SubprocessError, ValueError):
        print("held local-managed-prerequisite")
        raise SystemExit(1) from None
