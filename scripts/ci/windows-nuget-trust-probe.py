"""Stock Windows NuGet verification on two local inert inputs."""

import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

IMAGE = "20261116.315.1"
TOOL = Path(r"C:\ProgramData\Chocolatey\lib\NuGet.CommandLine\tools\nuget.exe")
POWERSHELL = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
FIXTURE = Path(r"C:\Program Files\dotnet\templates\10.0.15\microsoft.dotnet.common.itemtemplates.10.0.404.nupkg")
TOOL_HASH = "d4ddb222cb8fca8200b59e82286c0cba9c29b4fce6f9835fdfa54e67c9483d07"
FIXTURE_HASH = "1bcb494348d4de68a22305727ad8d23e70b7179a3c933d712de21035a8101198"
FIXTURE_SIZE = 303380
CAP = 96 * 1024
TRUST_OK = b"stock-microsoft-nuget-8.0.0.137"
NU_CODES = re.compile(rb"\bNU[0-9]{4}\b")
WARNING = re.compile(rb"\b(?:warn(?:ing)?|error)s?\b|\bfailed\b", re.I)
AUTHENTICODE_CODE = r"""
$ErrorActionPreference = 'Stop'
$p = 'C:\ProgramData\Chocolatey\lib\NuGet.CommandLine\tools\nuget.exe'
$s = Get-AuthenticodeSignature -LiteralPath $p
$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)
if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or
    $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation' -or
    $s.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)' -or
    "$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart).$($v.FilePrivatePart)" -cne '8.0.0.137') { exit 1 }
[Console]::WriteLine('stock-microsoft-nuget-8.0.0.137')
exit 0
"""


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


def check_authenticode(result):
    rc, text = result
    require(rc == 0 and text.strip() == TRUST_OK, "nuget-authenticode-or-version")


def admit_tool(directory):
    before = pinned(TOOL, TOOL_HASH, 32 * 1024 * 1024)
    file_identity(POWERSHELL)
    check_authenticode(bounded([str(POWERSHELL), "-NoProfile", "-NonInteractive",
                                "-Command", AUTHENTICODE_CODE], directory, 25))
    require(pinned(TOOL, TOOL_HASH, 32 * 1024 * 1024) == before, "stock-hash")
    return before


def check_signed(result):
    rc, text = result
    require(rc == 0 and not NU_CODES.search(text) and not WARNING.search(text), "signed-trust")
    require(bool(re.search(rb"(?m)^\s*Timestamp:\s*[^\r\n]+", text))
            and bool(re.search(rb"(?m)^\s*Signature type:\s*(Author|Repository)\b", text))
            and b"successfully verified package 'microsoft.dotnet.common.itemtemplates.10.0.404'." in text.lower(),
            "signed-positive-evidence")


def check_unsigned(result):
    rc, text = result
    require(rc == 1 and set(NU_CODES.findall(text)) == {b"NU3004"}
            and b"successfully verified package" not in text.lower(), "unsigned-negative-evidence")


def unsigned_fixture(directory):
    dest = directory / "Portable.Probe.Inert.1.0.0.nupkg"
    with zipfile.ZipFile(dest, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="nuspec" ContentType="application/octet-stream"/>'
            '<Default Extension="txt" ContentType="text/plain"/></Types>')
        archive.writestr("Portable.Probe.Inert.nuspec",
            '<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd"><metadata>'
            '<id>Portable.Probe.Inert</id><version>1.0.0</version><authors>Fixture</authors>'
            '<description>Inert text signature check</description></metadata></package>')
        archive.writestr("content/text.txt", "inert fixture\n")
    return dest


def run(args):
    require(len(args) == 1 and args[0] in ("host", "tool", "fixture", "signed", "unsigned"), "scope")
    stage = args[0]
    host()
    if stage == "host":
        return "windows-2025-vs2026-x64-image-20261116.315.1-build-33828"
    if stage == "fixture":
        pinned(FIXTURE, FIXTURE_HASH, FIXTURE_SIZE, FIXTURE_SIZE)
        return "exact-sdk-signed-inert-template-present"
    require(os.environ.get("NUGET_CERT_REVOCATION_MODE", "").casefold() in ("", "online"),
            "stock-revocation-setting")
    with tempfile.TemporaryDirectory(prefix="nuget-inert-", dir=os.environ["RUNNER_TEMP"]) as work:
        folder = Path(work)
        tool_id = admit_tool(folder)
        if stage == "tool":
            return TRUST_OK.decode("ascii")
        config = folder / "NuGet.Config"
        config.write_text("<configuration><packageSources><clear /></packageSources></configuration>\n",
                          encoding="ascii")
        if stage == "signed":
            fixture_id = pinned(FIXTURE, FIXTURE_HASH, FIXTURE_SIZE, FIXTURE_SIZE)
            selected = FIXTURE
        else:
            selected = unsigned_fixture(folder)
        result = bounded([str(TOOL), "verify", "-All", str(selected), "-ForceEnglishOutput",
                          "-NonInteractive", "-Verbosity", "detailed", "-ConfigFile", str(config)], folder, 45)
        require(pinned(TOOL, TOOL_HASH, 32 * 1024 * 1024) == tool_id, "stock-hash")
        if stage == "signed":
            require(pinned(FIXTURE, FIXTURE_HASH, FIXTURE_SIZE, FIXTURE_SIZE) == fixture_id, "stock-hash")
            check_signed(result)
            return "signed-template-windows-trust-warning-free"
        check_unsigned(result)
        return "unsigned-synthetic-control-refused-nu3004"


if __name__ == "__main__":
    try:
        print(run(sys.argv[1:]))
    except Refused as exc:
        print(f"held {exc}")
        raise SystemExit(1) from None
    except (KeyError, OSError, subprocess.SubprocessError, ValueError):
        print("held local-managed-prerequisite")
        raise SystemExit(1) from None
