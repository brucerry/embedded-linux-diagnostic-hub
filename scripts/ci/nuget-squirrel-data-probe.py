"""Data-only verification for one official Squirrel.Windows distribution."""

from base64 import b64decode
from datetime import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
import zipfile
import zlib

IMAGE = "20261116.376.1"
SDK = "10.0.404"
CURL = Path("/usr/bin/curl")
DOTNET = Path("/usr/share/dotnet/dotnet")
SDK_ROOT = DOTNET.parent / "sdk" / SDK
ORIGIN = "api.nuget.org"
SERVICE_INDEX = "https://api.nuget.org/v3/index.json"
CATALOG_PATH = "/v3/catalog0/data/2020.09.27.20.02.47/squirrel.windows.2.0.1.json"
PACKAGE_NAME = "squirrel.windows.2.0.1.nupkg"
PACKAGE_PATH = "/v3-flatcontainer/squirrel.windows/2.0.1/" + PACKAGE_NAME
PACKAGE_SIZE = 5_172_461
PACKAGE_ENTRY_COUNT = 30
SIGNATURE_SIZE = 9468
PACKAGE_HASH = "9Q8/it0BEh3hJv66f1MuCeQPyAWbIuRp7muNfIHbs+7etT/DYENgJuezs4qrSOWbT4Q4xAL7YeANmoDTVyjJYA=="
PACKAGE_DIGEST = b64decode(PACKAGE_HASH, validate=True)
REPOSITORY_SIGNER = "0e5f38f57dc1bcc806d8494f4f90fbcedd988b46760709cbeec6f4219aa6157d"
SIGNING_START = datetime(2018, 4, 10)
SIGNING_END = datetime(2021, 4, 14, 12)
PUBLISHER_TREE = "a47c5ecc3a151280251221f4b3a13cadf20cbe3f"
MEMBERS = {
    "tools/Setup.exe": (223232, "8c62c5c2e7db233c22d7ff3af7b37d274d5c89cf"),
    "tools/Squirrel-Mono.exe": (1856000, "49fec853acf57ad170cce13ff096870b50bee399"),
    "tools/Squirrel.exe": (1899520, "93108dec85039e1a30bc3767cc0a3ac8c27acde5"),
    "tools/StubExecutable.exe": (288768, "32c8c6bb5b8f84a83aee05349d56717638f7bfe9"),
    "tools/SyncReleases.exe": (1892864, "861598d7e6b2361b19d243f1f74c5c6b5539cb2f"),
    "tools/WriteZipToSetup.exe": (112128, "2bc3170abe0427e97f06b2a63b3da842cb705dac"),
}
CHUNK = 64 * 1024
CATALOG_CAP = 128 * 1024
OUTPUT_CAP = 96 * 1024
ENTRY_CAP = 16 * 1024 * 1024
INFLATED_CAP = 64 * 1024 * 1024
SAFE_PART = re.compile(r"[A-Za-z0-9_.%+\[\]-]{1,128}")
WARNING = re.compile(r"\bNU[0-9]{4}\b|\b(?:warnings?|errors?|failed)\b", re.IGNORECASE)
SUCCESS = re.compile(r"Successfully verified package 'squirrel\.windows\.2\.0\.1'\.", re.IGNORECASE)
FINGERPRINT = re.compile(r"SHA-?256 hash:\s*([a-fA-F0-9]{64})")
STAMP_SECTION = "Verifying repository primary signature's timestamp with timestamping service certificate:"
SIGNER_SECTION = "Verifying the repository primary signature with certificate:"


class Refusal(Exception):
    """Messages are fixed status categories, never input or tool output."""


def require(condition, category):
    if not condition:
        raise Refusal(category)


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "catalog")
        result[key] = value
    return result


def check_catalog(raw):
    try:
        data = json.loads(raw, object_pairs_hook=unique_json)
        require(data["id"] == "squirrel.windows" and data["version"] == "2.0.1"
                and type(data["packageSize"]) is int and data["packageSize"] == PACKAGE_SIZE
                and data["packageHashAlgorithm"] == "SHA512"
                and data["packageHash"] == PACKAGE_HASH, "catalog")
        rows = data["packageEntries"]
        require(type(rows) is list and len(rows) == PACKAGE_ENTRY_COUNT, "catalog")
        entries = {row["fullName"]: row["length"] for row in rows}
        require(len(entries) == PACKAGE_ENTRY_COUNT, "catalog")
        require(entries.get(".signature.p7s") == SIGNATURE_SIZE, "catalog")
        require(all(entries.get(path) == size for path, (size, _) in MEMBERS.items()), "catalog")
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError):
        raise Refusal("catalog") from None


def fetch(route, cap, directory, exact=None):
    """One bounded request over the stock official HTTPS route."""
    require(route in (CATALOG_PATH, PACKAGE_PATH), "official-fetch")
    proxy_names = ("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY")
    env = {name: os.environ[name] for name in proxy_names if name in os.environ}
    env.update({"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    result = bounded_command([
        str(CURL), "-q", "--fail", "--silent", "--show-error",
        "--proto", "=https", "--no-location", "--max-redirs", "0",
        "--connect-timeout", "6", "--max-time", "24", "--max-filesize", str(cap),
        "--write-out", "\n%{http_code}", "https://" + ORIGIN + route,
    ], directory, env, 25, cap + 4)
    code, stdout, stderr = result
    require(code == 0 and not stderr and stdout.endswith(b"\n200"), "official-fetch")
    body = stdout[:-4]
    require(0 < len(body) <= cap and (exact is None or len(body) == exact), "official-fetch")
    return body


def regular(handle):
    info = os.fstat(handle.fileno())
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "custody")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mode,
            info.st_uid, info.st_mtime_ns, info.st_ctime_ns)


def check_package(handle):
    original = regular(handle)
    require(original[2] == PACKAGE_SIZE and original[4] == os.geteuid(), "package-pin")
    handle.seek(0)
    digest = hashlib.sha512()
    remaining = PACKAGE_SIZE
    while remaining:
        block = handle.read(min(CHUNK, remaining))
        require(bool(block), "package-pin")
        remaining -= len(block)
        digest.update(block)
    require(not handle.read(1) and hmac.compare_digest(digest.digest(), PACKAGE_DIGEST)
            and regular(handle) == original, "package-pin")
    return original


def check_path(path, identity):
    info = path.stat(follow_symlinks=False)
    observed = (info.st_dev, info.st_ino, info.st_size, info.st_mode,
                info.st_uid, info.st_mtime_ns, info.st_ctime_ns)
    require(observed == identity, "custody")


def check_runner(env, machine, uid, os_release):
    require(env.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and env.get("ImageOS") == "ubuntu24" and env.get("ImageVersion") == IMAGE
            and env.get("RUNNER_OS") == "Linux" and env.get("RUNNER_ARCH") == "X64"
            and machine == "x86_64" and uid > 0
            and 'VERSION_ID="24.04"' in os_release.splitlines()
            and "ID=ubuntu" in os_release.splitlines(), "runner")


def check_stock_sdk():
    for path in (CURL, DOTNET, SDK_ROOT, SDK_ROOT / "dotnet.dll",
                 SDK_ROOT / "NuGet.CommandLine.XPlat.dll"):
        for item in (path, *path.parents):
            info = item.stat(follow_symlinks=False)
            require(info.st_uid == 0 and not info.st_mode & 0o022
                    and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
                    and not stat.S_ISLNK(info.st_mode), "sdk")
    require(DOTNET.is_file() and os.access(DOTNET, os.X_OK) and SDK_ROOT.is_dir(), "sdk")


def bounded_command(argv, directory, env, seconds, output_cap=OUTPUT_CAP):
    deadline = time.monotonic() + seconds
    output = {1: bytearray(), 2: bytearray()}
    with subprocess.Popen(argv, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as child:
        try:
            with selectors.DefaultSelector() as reader:
                reader.register(child.stdout, selectors.EVENT_READ, 1)
                reader.register(child.stderr, selectors.EVENT_READ, 2)
                while reader.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, "verifier-time")
                    for key, _ in reader.select(remaining):
                        block = os.read(key.fd, 8192)
                        if not block:
                            reader.unregister(key.fileobj)
                        output[key.data].extend(block)
                        require(sum(map(len, output.values())) <= output_cap, "verifier-output")
            code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except (subprocess.TimeoutExpired, Refusal, OSError):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise Refusal("verifier-bound") from None
    return code, bytes(output[1]), bytes(output[2])


def verifier_environment(directory):
    home = directory / "verifier-home"
    home.mkdir(mode=0o700)
    return {
        "HOME": str(home), "DOTNET_CLI_HOME": str(home),
        "PATH": "/usr/bin:/bin", "TZ": "UTC", "LANG": "en_US.UTF-8",
        "LC_ALL": "en_US.UTF-8", "DOTNET_CLI_UI_LANGUAGE": "en-US",
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
        "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH": "0", "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
        "NUGET_CERT_REVOCATION_MODE": "online",
    }


def configure_verifier(directory):
    (directory / "global.json").write_text(json.dumps({
        "sdk": {"version": SDK, "rollForward": "disable", "allowPrerelease": False},
    }), encoding="ascii")
    config = directory / "NuGet.Config"
    config.write_text(f"""<configuration>
  <config><add key="signatureValidationMode" value="require" /></config>
  <packageSources><clear /></packageSources>
  <trustedSigners>
    <repository name="NuGet.org" serviceIndex="{SERVICE_INDEX}">
      <certificate fingerprint="{REPOSITORY_SIGNER.upper()}" hashAlgorithm="SHA256"
        allowUntrustedRoot="false" />
    </repository>
  </trustedSigners>
</configuration>
""", encoding="ascii")
    return config


def parse_timestamp(value):
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise Refusal("timestamp")


def check_verification(result):
    code, stdout, stderr = result
    require(code == 0 and not stderr, "signature")
    require(0 < len(stdout) <= OUTPUT_CAP
            and not any(c < 32 and c not in (9, 10, 13) for c in stdout), "verifier-output")
    try:
        lines = [line.strip() for line in stdout.decode("utf-8", errors="strict").splitlines()
                 if line.strip()]
    except UnicodeError:
        raise Refusal("verifier-output") from None
    require(not any(WARNING.search(line) for line in lines), "signature-warning")
    require(len([line for line in lines if SUCCESS.fullmatch(line)]) == 1
            and SUCCESS.fullmatch(lines[-1]) is not None, "signature")
    require([line for line in lines if line.startswith("Signature type:")] ==
            ["Signature type: Repository"], "repository-signer")
    require([line for line in lines if line.startswith("nuget-v3-service-index-url:")] ==
            ["nuget-v3-service-index-url: " + SERVICE_INDEX], "repository-signer")
    require(lines.count(STAMP_SECTION) == 1, "timestamp")
    require(lines.count(SIGNER_SECTION) == 1, "repository-signer")
    stamp_start = lines.index(STAMP_SECTION)
    signer_start = lines.index(SIGNER_SECTION)
    stamps = [line.removeprefix("Timestamp: ").strip() for line in lines[:stamp_start]
              if line.startswith("Timestamp: ")]
    require(len(stamps) == 1 and stamp_start < signer_start, "timestamp")
    require(SIGNING_START <= parse_timestamp(stamps[0]) <= SIGNING_END, "timestamp")
    stamp_fingerprints = [match.group(1) for line in lines[stamp_start + 1:signer_start]
                          if (match := FINGERPRINT.fullmatch(line))]
    require(len(stamp_fingerprints) == 1, "timestamp")
    repo_fingerprints = [match.group(1).lower() for line in lines[signer_start + 1:]
                         if (match := FINGERPRINT.fullmatch(line))]
    require(repo_fingerprints == [REPOSITORY_SIGNER], "repository-signer")


def safe_name(info):
    # Permit literal internal OPC names, but no encoded slash/dot/control or Windows aliases.
    path = info.orig_filename
    parts = path.removesuffix("/").split("/")
    require(path == info.filename and len(path) <= 256
            and all(SAFE_PART.fullmatch(part) and part not in (".", "..")
                    and not part.endswith(".")
                    and not re.search(r"%[0-9a-fA-F]{2}", part)
                    for part in parts), "archive-layout")
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    require(kind in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG)
            and not info.flag_bits & 0x2041 and not info.external_attr & 0x400
            and (not info.is_dir() or info.file_size == 0)
            and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            and 0 <= info.file_size <= ENTRY_CAP, "archive-layout")
    return "/".join(parts).casefold()


def archive_census(archive):
    infos = archive.infolist()
    require(len(infos) == PACKAGE_ENTRY_COUNT
            and sum(info.file_size for info in infos) <= INFLATED_CAP, "archive-layout")
    folded = {}
    by_name = {}
    offsets = set()
    for info in infos:
        name = safe_name(info)
        require(name not in folded and info.header_offset not in offsets, "archive-layout")
        by_name[info.filename] = info
        folded[name] = info.is_dir()
        offsets.add(info.header_offset)
    for name in folded:
        parts = name.split("/")
        require(all(folded.get("/".join(parts[:i]), True)
                    for i in range(1, len(parts))), "archive-layout")
    signature = by_name.get(".signature.p7s")
    require(signature is not None and not signature.is_dir()
            and signature.file_size == SIGNATURE_SIZE, "archive-layout")
    return by_name


def hash_member(archive, info, size, expected_blob):
    require(info.file_size == size and not info.is_dir(), "member-size")
    sha = hashlib.sha256()
    blob = hashlib.sha1(f"blob {size}\0".encode("ascii"), usedforsecurity=False)
    count = 0
    with archive.open(info, "r") as member:
        for block in iter(lambda: member.read(CHUNK), b""):
            count += len(block)
            require(count <= size, "member-size")
            sha.update(block)
            blob.update(block)
    require(count == size, "member-size")
    require(hmac.compare_digest(blob.hexdigest(), expected_blob), "member-blob")
    return {"sha256": sha.hexdigest(), "git_blob": blob.hexdigest()}


def read_members(handle):
    try:
        with zipfile.ZipFile(handle, "r") as archive:
            infos = archive_census(archive)
            require(all(path in infos for path in MEMBERS), "member-missing")
            return {path: hash_member(archive, infos[path], size, blob)
                    for path, (size, blob) in MEMBERS.items()}
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, UnicodeError, EOFError, zlib.error):
        raise Refusal("archive-layout") from None


def run():
    require(os.getuid() == os.geteuid(), "runner")
    check_runner(os.environ, os.uname().machine, os.geteuid(),
                 Path("/etc/os-release").read_text(encoding="utf-8"))
    check_stock_sdk()
    temp_root = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="nuget-member-probe-", dir=temp_root) as temp:
        directory = Path(temp)
        env = verifier_environment(directory)
        config = configure_verifier(directory)
        version = bounded_command([str(DOTNET), "--version"], directory, env, 12)
        require(version == (0, (SDK + "\n").encode(), b""), "sdk")
        check_catalog(fetch(CATALOG_PATH, CATALOG_CAP, directory))
        path = directory / PACKAGE_NAME
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w+b") as handle:
            handle.write(fetch(PACKAGE_PATH, PACKAGE_SIZE, directory, exact=PACKAGE_SIZE))
            handle.flush()
            original = check_package(handle)
            check_path(path, original)
            verification = bounded_command([
                str(DOTNET), "nuget", "verify", "--all", "--verbosity", "detailed",
                "--configfile", str(config), "--certificate-fingerprint", REPOSITORY_SIGNER.upper(),
                str(path),
            ], directory, env, 65)
            check_verification(verification)
            check_path(path, original)
            require(check_package(handle) == original, "custody")
            members = read_members(handle)
            check_path(path, original)
            require(check_package(handle) == original, "custody")
    return {
        "verdict": "verified-six-member-byte-links",
        "package_sha512": PACKAGE_DIGEST.hex(), "repository_signer_sha256": REPOSITORY_SIGNER,
        "target_vendor_tree": PUBLISHER_TREE, "members": members,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(run(), sort_keys=True))
    except Refusal as exc:
        print(json.dumps({"verdict": "held", "reason": str(exc)}))
        raise SystemExit(1) from None
    except (OSError, KeyError, ValueError, subprocess.SubprocessError):
        print('{"verdict":"held","reason":"local-prerequisite"}')
        raise SystemExit(1) from None
