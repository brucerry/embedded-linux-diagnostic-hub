"""Single-job build-input preparation. No Node acquisition, package scripts or cleanup.

This file is an unexecuted CI review draft. Package extraction provisions build tools;
it is not a Gateway installation, runtime test, or release/provenance admission.
"""

import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import ssl
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zlib


BRANCH = "ci/v060-gateway-four-tool-buildonly-20261116"
NAMES = ("semver", "fflate", "esbuild", "@esbuild/linux-x64")
VERSIONS = ("7.8.5", "0.8.3", "0.28.2", "0.28.2")
UID = os.getuid()
PHASE = "admission"


def require(condition):
    if not condition:
        raise ValueError("Build-input precondition refused")


def identity(s):
    return (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode, s.st_nlink,
            s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def metadata(p, directory=False):
    s = p.lstat()
    require((stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)))
    require(s.st_uid in (0, UID) and not (s.st_mode & 0o7022))
    require(0 < s.st_ino <= 2**53 - 1 and 0 <= s.st_dev <= 2**53 - 1)
    require(directory or s.st_nlink == 1)
    return s


def directory(p):
    require(p.is_absolute() and p.resolve(strict=True) == p)
    for ancestor in reversed((p, *p.parents)):
        metadata(ancestor, True)


def read(p, maximum):
    directory(p.parent)
    before = metadata(p)
    require(0 <= before.st_size <= maximum)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(identity(os.fstat(fd)) == identity(before))
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            require(total <= maximum)
            chunks.append(chunk)
        require(total == before.st_size)
        require(identity(os.fstat(fd)) == identity(before))
        require(identity(metadata(p)) == identity(before))
        return b"".join(chunks)
    finally:
        os.close(fd)


def write(p, data, mode=0o600):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def npm_inventory(root, expected):
    directory(root)
    rows = []
    total = 0
    pending = [root]
    while pending:
        parent = pending.pop()
        with os.scandir(parent) as entries:
            for entry in entries:
                require(len(rows) < expected["npmEntries"])
                p = parent / entry.name
                name = p.relative_to(root).as_posix()
                if stat.S_ISDIR(p.lstat().st_mode):
                    metadata(p, True)
                    rows.append([name, "directory", None, None])
                    pending.append(p)
                else:
                    b = read(p, expected["npmFileBytes"])
                    total += len(b)
                    require(total <= expected["npmFileBytes"])
                    rows.append([name, "file", len(b), hashlib.sha256(b).hexdigest()])
    rows.sort(key=lambda row: row[0])
    encoded = json.dumps(rows, separators=(",", ":"), ensure_ascii=True).encode()
    require(len(rows) == expected["npmEntries"])
    require(total == expected["npmFileBytes"])
    require(hashlib.sha256(encoded).hexdigest() == expected["npmInventorySHA256"])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def download(package):
    # All four URLs and their exact compressed-byte SRI must match the source lock.
    # No credentials, mirror, redirect, registry lookup, script or retry is used.
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request(package["url"], headers={
        "Accept": "application/octet-stream", "User-Agent": "DiagnosticHub-BuildInputs"})
    start = time.monotonic()
    maximum = package["maximumCompressedBytes"]
    with opener.open(request, timeout=15) as response:
        require(response.status == 200 and response.geturl() == package["url"])
        length = response.headers.get("Content-Length")
        if length is not None:
            require(length.isascii() and length.isdecimal() and int(length) <= maximum)
        chunks = []
        count = 0
        while True:
            require(time.monotonic() - start <= 45)
            chunk = response.read(65536)
            require(time.monotonic() - start <= 45)
            if not chunk:
                break
            count += len(chunk)
            require(count <= maximum)
            chunks.append(chunk)
        require(count > 0 and (length is None or count == int(length)))
    require(time.monotonic() - start <= 45)
    data = b"".join(chunks)
    expected = base64.b64decode(package["integrity"].removeprefix("sha512-"), validate=True)
    require(len(expected) == 64 and hashlib.sha512(data).digest() == expected)
    return data


def inspect_package(data, package):
    decoder = zlib.decompressobj(31)
    raw = decoder.decompress(data, package["maximumExpandedBytes"] + 1)
    require(len(raw) <= package["maximumExpandedBytes"])
    require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail)
    members = {}
    end = 0
    count = 0
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for member in archive:
            count += 1
            require(count <= package["maximumMembers"])
            name = member.name.rstrip("/")
            require(name not in seen)
            seen.add(name)
            if name == "package" and member.isdir():
                continue
            parts = name.split("/")
            require(parts[0] == "package" and len(parts) > 1)
            require(all(part not in ("", ".", "..") for part in parts))
            require(not any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in name))
            relative = PurePosixPath(*parts[1:]).as_posix()
            require(len(relative) <= 1024 and relative not in members)
            require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE))
            require(member.sparse is None)
            require(member.isdir() or member.name == name)
            require(not (member.mode & 0o7022))
            require(0 <= member.size <= 32 * 1024**2)
            end = max(end, member.offset_data + ((member.size + 511) // 512) * 512)
            if member.isdir():
                require(member.size == 0)
                members[relative] = (None, 0o700)
            else:
                with archive.extractfile(member) as stream:
                    b = stream.read(32 * 1024**2 + 1)
                require(len(b) == member.size)
                members[relative] = (b, 0o600 | (member.mode & 0o100))
    require(len(raw) - end >= 1024 and not any(raw[end:]))
    manifest = json.loads(members["package.json"][0])
    require(manifest["name"] == package["name"] and manifest["version"] == package["version"])
    require(not manifest.get("dependencies") and not manifest.get("peerDependencies"))
    if package["name"] != "esbuild":
        require(not manifest.get("optionalDependencies"))
    return members


def main():
    global PHASE
    require(UID > 0 and os.uname().sysname == "Linux" and os.uname().machine == "x86_64")
    expected_environment = {
        "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub",
        "GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "push",
        "GITHUB_REF": "refs/heads/" + BRANCH, "GITHUB_RUN_ATTEMPT": "1",
        "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
    }
    require(all(os.environ.get(key) == value for key, value in expected_environment.items()))
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
                "all_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        require(not os.environ.get(key))  # Refuse unsupported routing/trust, never clear it.
    require(os.environ.get("NODE_TLS_REJECT_UNAUTHORIZED") in (None, "1"))
    root = Path.cwd()
    directory(root)
    require(Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True) == root)
    require(not any(os.path.lexists(root / n) for n in ("node_modules", "validation", ".npmrc")))
    git_env = {"PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0",
               "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}
    def git(*args):
        return subprocess.check_output([
            "/usr/bin/git", "--no-replace-objects", "--no-pager", "-c", "core.fsmonitor=false",
            "-c", "core.untrackedCache=false", *args], env=git_env)
    require(git("rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"])
    require(git("status", "--porcelain", "--untracked-files=all") == b"")
    event = json.loads(read(Path(os.environ["GITHUB_EVENT_PATH"]), 4 * 1024**2))
    require(event["repository"]["full_name"] == expected_environment["GITHUB_REPOSITORY"])
    require(event["repository"]["private"] is False and event["deleted"] is False)
    require(event["ref"] == expected_environment["GITHUB_REF"])
    require(event["after"] == os.environ["GITHUB_SHA"])
    profile = json.loads(read(root / "scripts/ci/gateway-four-tool-inputs.json", 16384))
    require(profile["schemaVersion"] == 1)
    require(profile["node"]["version"] == "24.22.2")
    require(profile["node"]["npmVersion"] == "11.19.1")
    lock_bytes = read(root / "package-lock.json", 1024**2)
    require(hashlib.sha256(lock_bytes).hexdigest() == profile["sourceLockSHA256"])
    lock = json.loads(lock_bytes)["packages"]
    require(tuple(p["name"] for p in profile["packages"]) == NAMES)
    require(tuple(p["version"] for p in profile["packages"]) == VERSIONS)
    for package in profile["packages"]:
        pinned = lock["node_modules/" + package["name"]]
        require((package["version"], package["url"], package["integrity"]) ==
                (pinned["version"], pinned["resolved"], pinned["integrity"]))
        expected_url = "https://registry.npmjs.org/" + package["name"] + "/-/" + package["name"].split("/")[-1] + "-" + package["version"] + ".tgz"
        require(package["url"] == expected_url and package["integrity"].startswith("sha512-"))
        require(package["maximumCompressedBytes"] == 16777216)
        require(package["maximumExpandedBytes"] == 67108864 and package["maximumMembers"] == 4096)
    PHASE = "preinstalled-node-npm"
    # The provider locator is not authority: exact Node and complete npm contents must match
    # the retained trusted distribution reference before any package request or Node execution.
    cache = Path(os.environ["RUNNER_TOOL_CACHE"])
    directory(cache)
    prefix = cache / "node" / profile["node"]["version"] / "x64"
    node = prefix / "bin/node"
    b = read(node, 128 * 1024**2)
    require(len(b) == profile["node"]["bytes"] and
            hashlib.sha256(b).hexdigest() == profile["node"]["sha256"])
    require(metadata(node).st_mode & stat.S_IXUSR)
    npm_inventory(prefix / "lib/node_modules/npm", profile["node"])
    # This prospective CI-only invocation occurs only after content/metadata verification.
    # No package has been fetched; an unusable preinstalled runtime stops here.
    version = subprocess.check_output([str(node), "--version"], stderr=subprocess.STDOUT,
                                     env={"LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
                                          "NODE_DISABLE_COMPILE_CACHE": "1"})
    require(version == b"v24.22.2\n")
    PHASE = "download-and-inspect"
    temporary = Path(os.environ["RUNNER_TEMP"])
    directory(temporary)
    scratch = Path(tempfile.mkdtemp(prefix="gateway-four-tools-", dir=temporary))
    inspected = []
    for package in profile["packages"]:
        b = download(package)
        write(scratch / (package["name"].replace("/", "-") + ".tgz"), b)
        inspected.append((package, inspect_package(b, package)))
    PHASE = "materialize-only-four"
    destination = root / "node_modules"
    destination.mkdir(mode=0o700)
    (destination / "@esbuild").mkdir(mode=0o700)
    for package, members in inspected:
        package_root = destination / package["name"]
        package_root.mkdir(mode=0o700)
        for name, (b, mode) in sorted(members.items(), key=lambda row: (len(PurePosixPath(row[0]).parts), row[0])):
            target = package_root / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if b is None:
                target.mkdir(mode=0o700, exist_ok=True)
            else:
                write(target, b, mode)
    print("Four locked Gateway build inputs prepared; no runtime or release qualification.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Gateway build-input preparation refused at " + PHASE + "; state retained.")
        raise SystemExit(1)
