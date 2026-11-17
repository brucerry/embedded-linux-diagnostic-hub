"""Local CI draft: pinned publisher data into a new private tool prefix.

No refused-cache access, permission repair, package scripts or cleanup. The CLI
uses the existing admission, physical Node/npm checks and four-input preparer.
Pure parsing fixtures are not publisher, host, runtime or release evidence.
"""

import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import time


_SPEC = importlib.util.spec_from_file_location(
    "gateway_shared_preparation", Path(__file__).with_name("prepare-gateway-four-tools.py"))
COMMON = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(COMMON)

BRANCH = "ci/v060-gateway-two-stage-20261117"
NODE_ARCHIVE = {
    "url": "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz",
    "sha256": "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
    "bytes": 58299872,
    "maximumCompressedBytes": 96 * 1024**2,
    "maximumExpandedBytes": 512 * 1024**2,
    "maximumMembers": 10000,
    "root": "node-v24.22.2-linux-x64",
}
IGNORED_LINKS = {
    "bin/npm": "../lib/node_modules/npm/bin/npm-cli.js",
    "bin/npx": "../lib/node_modules/npm/bin/npx-cli.js",
    "bin/corepack": "../lib/node_modules/corepack/dist/corepack.js",
}


def fetch_distribution(expected):
    """One fixed request in production; no redirect, retry, auth or scripts."""
    request = COMMON.urllib.request.Request(expected["url"], headers={
        "Accept": "application/octet-stream", "Accept-Encoding": "identity",
        "User-Agent": "DiagnosticHub-PublisherNode"})
    opener = COMMON.urllib.request.build_opener(
        COMMON.NoRedirect(), COMMON.urllib.request.HTTPSHandler(
            context=COMMON.ssl.create_default_context()))
    start = time.monotonic()
    with opener.open(request, timeout=15) as response:
        COMMON.require(response.status == 200 and response.geturl() == expected["url"], "endpoint")
        length = response.headers.get("Content-Length")
        if length is not None:
            COMMON.require(length.isascii() and length.isdecimal() and
                           int(length) == expected["bytes"], "download-size")
        chunks, total = [], 0
        while True:
            COMMON.require(time.monotonic() - start <= 120, "download-deadline")
            data = response.read(65536)
            COMMON.require(time.monotonic() - start <= 120, "download-deadline")
            if not data:
                break
            total += len(data)
            COMMON.require(total <= expected["bytes"] <= expected["maximumCompressedBytes"], "download-size")
            chunks.append(data)
    COMMON.require(time.monotonic() - start <= 120, "download-deadline")
    data = b"".join(chunks)
    COMMON.require(len(data) == expected["bytes"] and
                   hashlib.sha256(data).hexdigest() == expected["sha256"], "package-integrity")
    return data


def inspect_distribution(data, node, expected):
    """Authenticate before decoding; inspect all entries, return only required data.

    expected/node are trusted pins supplied by the production caller. Synthetic
    fixtures supply separate pins to this pure parser, not to the live entrypoint.
    """
    COMMON.require(len(data) == expected["bytes"] <= expected["maximumCompressedBytes"] and
                   hashlib.sha256(data).hexdigest() == expected["sha256"], "package-integrity")
    raw = bytearray()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as stream:
            while True:
                block = stream.read(65536)
                if not block:
                    break
                COMMON.require(len(raw) + len(block) <= expected["maximumExpandedBytes"], "archive-policy")
                raw.extend(block)
    except (gzip.BadGzipFile, EOFError):
        raise COMMON.PreparationRefused("archive-policy") from None
    # Count physical GNU long-name records too, before stdlib folds them into entries.
    position, physical = 0, 0
    while True:
        COMMON.require(position + 512 <= len(raw), "archive-policy")
        header = bytes(raw[position:position + 512])
        if header == bytes(512):
            COMMON.require(len(raw) - position >= 1024 and not any(raw[position:]), "archive-policy")
            break
        physical += 1
        COMMON.require(physical <= expected["maximumMembers"], "archive-policy")
        item = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        COMMON.require(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE,
                                     tarfile.SYMTYPE, tarfile.GNUTYPE_LONGNAME), "archive-policy")
        COMMON.require(0 <= item.size <= expected["maximumExpandedBytes"], "archive-policy")
        if item.type == tarfile.GNUTYPE_LONGNAME:
            COMMON.require(item.size <= 4096, "archive-policy")
        position += 512 + ((item.size + 511) // 512) * 512
        COMMON.require(position <= len(raw), "archive-policy")
    root, npm = expected["root"], "lib/node_modules/npm"
    members, rows, seen = {}, [], set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:", encoding="utf-8", errors="strict") as archive:
        for index, item in enumerate(archive, 1):
            COMMON.require(index <= expected["maximumMembers"], "archive-policy")
            name = item.name[:-1] if item.isdir() and item.name.endswith("/") else item.name
            parts = name.split("/")
            COMMON.require(len(name) <= 4096 and all(p not in ("", ".", "..") for p in parts) and
                           parts[0] == root and not any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in name), "archive-policy")
            COMMON.require(name not in seen and item.sparse is None, "archive-policy")
            seen.add(name)
            relative = "/".join(parts[1:])
            if item.issym():
                # Exactly known publisher links are data only; never followed or written.
                COMMON.require(relative in IGNORED_LINKS and item.linkname == IGNORED_LINKS[relative] and
                               item.size == 0 and item.mode == 0o777, "archive-policy")
                continue
            COMMON.require(item.isdir() or item.isfile(), "archive-policy")
            COMMON.require(not (item.mode & 0o7022), "archive-policy")
            COMMON.require(not item.isdir() or item.size == 0, "archive-policy")
            selected = relative == "bin/node" or relative == npm or relative.startswith(npm + "/")
            if not selected:
                continue
            if item.isdir():
                members[relative] = None
                if relative.startswith(npm + "/"):
                    rows.append([relative[len(npm) + 1:], "directory", None, None])
            else:
                maximum = node["bytes"] if relative == "bin/node" else node["npmFileBytes"]
                COMMON.require(0 <= item.size <= maximum, "archive-policy")
                with archive.extractfile(item) as stream:
                    body = stream.read(maximum + 1)
                COMMON.require(len(body) == item.size, "archive-policy")
                members[relative] = body
                if relative.startswith(npm + "/"):
                    rows.append([relative[len(npm) + 1:], "file", len(body), hashlib.sha256(body).hexdigest()])
    binary = members["bin/node"]
    COMMON.require(isinstance(binary, bytes) and len(binary) == node["bytes"] and
                   hashlib.sha256(binary).hexdigest() == node["sha256"], "node-integrity")
    rows.sort(key=lambda row: row[0])
    COMMON.require(len(rows) == node["npmEntries"], "npm-entry-count")
    COMMON.require(sum(row[2] or 0 for row in rows) == node["npmFileBytes"], "npm-byte-count")
    encoded = json.dumps(rows, separators=(",", ":"), ensure_ascii=True).encode()
    COMMON.require(hashlib.sha256(encoded).hexdigest() == node["npmInventorySHA256"], "npm-integrity")
    manifest = json.loads(members[npm + "/package.json"])
    COMMON.require(manifest["name"] == "npm" and manifest["version"] == node["npmVersion"] and
                   isinstance(members[npm + "/bin/npm-cli.js"], bytes), "package-manifest")
    return members


def acquire_node(profile):
    """Invoked only after shared real job/source/lock admission; no cache access."""
    COMMON.PHASE = "publisher-node"
    COMMON.require(profile["reference"]["distribution"] == NODE_ARCHIVE["url"] and
                   profile["reference"]["distributionSHA256"] == NODE_ARCHIVE["sha256"], "source-integrity")
    temporary = COMMON.Path(COMMON.os.environ["RUNNER_TEMP"])
    COMMON.directory(temporary)
    run = COMMON.os.environ["GITHUB_RUN_ID"]
    attempt = COMMON.os.environ["GITHUB_RUN_ATTEMPT"]
    COMMON.require(run.isascii() and run.isdecimal() and 0 < len(run) <= 20 and
                   int(run) > 0 and attempt == "1")
    prefix = temporary / ("gateway-publisher-node-" + run + "-" + attempt)
    COMMON.require(not COMMON.os.path.lexists(prefix))
    prefix.mkdir(mode=0o700)
    COMMON.directory(prefix)
    data = fetch_distribution(NODE_ARCHIVE)
    # Recheck even a replaced transport before retaining or interpreting any bytes.
    COMMON.require(len(data) == NODE_ARCHIVE["bytes"] and
                   hashlib.sha256(data).hexdigest() == NODE_ARCHIVE["sha256"], "package-integrity")
    COMMON.write(prefix / "node-distribution.tar.gz", data)
    COMMON.PHASE = "publisher-archive"
    members = inspect_distribution(data, profile["node"], NODE_ARCHIVE)
    COMMON.PHASE = "publisher-materialization"
    for name, body in sorted(members.items(), key=lambda row: (len(row[0].split("/")), row[0])):
        target = prefix / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if body is None:
            target.mkdir(mode=0o700, exist_ok=True)
        else:
            COMMON.write(target, body, 0o700 if name == "bin/node" else 0o600)
    receipt = {"distribution": NODE_ARCHIVE, "node": profile["node"],
               "scope": "Publisher input verification only; not runner/job/upload/runtime or release acceptance."}
    COMMON.write(prefix / "publisher-input-reference.json", json.dumps(receipt, sort_keys=True).encode())
    # Shared main rechecks physical metadata, exact Node and complete npm before --version.
    return prefix


def entry():
    return COMMON.collect_diagnostic(node_provider=acquire_node, expected_branch=BRANCH)


if __name__ == "__main__":
    raise SystemExit(entry())
