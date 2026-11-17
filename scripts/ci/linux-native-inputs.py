"""Public-baseline inputs only. No acquisition or execution on import.

The existing publisher parser authenticates the whole official Node archive before
inspection. npmci is an explicitly reviewed prospective dependency installation,
with all lifecycle scripts disabled; it is not an installation-free test.
"""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import time
import urllib.parse
import urllib.request


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PUBLISHER = load("native_publisher", Path(__file__).with_name("prepare-gateway-publisher-node.py"))
COMMON = PUBLISHER.COMMON


class InputRefused(ValueError):
    pass


def need(value, reason):
    if not value:
        raise InputRefused(reason)


def validate_lock(data, profile):
    need(hashlib.sha256(data).hexdigest() == profile["lockSHA256"], "lock")
    packages = json.loads(data)["packages"]
    need(len(packages) == 416 and packages[""]["engines"]["node"] == ">=24 <25", "lock")
    for name, item in packages.items():
        if not name:
            continue
        url = item.get("resolved", "")
        parsed = urllib.parse.urlsplit(url)
        need(parsed.scheme == "https" and parsed.netloc == "registry.npmjs.org" and
             not parsed.query and not parsed.fragment and not item.get("link"), "endpoint")
        integrity = item.get("integrity", "")
        need(integrity.startswith("sha512-") and len(base64.b64decode(integrity[7:], validate=True)) == 64,
             "integrity")
    need(packages["node_modules/electron"]["version"] == profile["electron"]["version"], "lock")
    return packages


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.count = 0

    def redirect_request(self, request, response, code, message, headers, target):
        old, new = urllib.parse.urlsplit(request.full_url), urllib.parse.urlsplit(target)
        need(self.count == 0 and old.scheme == "https" and old.netloc == "github.com" and
             new.scheme == "https" and new.netloc == "release-assets.githubusercontent.com" and
             not new.fragment and code in (301, 302, 303, 307, 308), "endpoint")
        self.count += 1
        # New request deliberately carries no authorization, cookie or other inherited header.
        return urllib.request.Request(target, headers={"Accept": "application/octet-stream",
                                                      "Accept-Encoding": "identity"})


def fetch_exact(pin, opener=None, clock=time.monotonic):
    expected = urllib.parse.urlsplit(pin["url"])
    need(expected.scheme == "https" and expected.netloc in ("nodejs.org", "github.com") and
         not expected.query and not expected.fragment, "endpoint")
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), OfficialRedirect())
    start = clock()
    request = urllib.request.Request(pin["url"], headers={"Accept": "application/octet-stream",
                                                        "Accept-Encoding": "identity"})
    parts, total = [], 0
    with opener.open(request, timeout=20) as response:
        need(response.status == 200 and response.headers.get("Content-Encoding", "identity") == "identity",
             "download")
        length = response.headers.get("Content-Length")
        need(length is None or length == str(pin["bytes"]), "integrity")
        while True:
            need(clock() - start <= 120, "deadline")
            part = response.read(65536)
            if not part:
                break
            total += len(part)
            need(total <= pin["bytes"], "integrity")
            parts.append(part)
    data = b"".join(parts)
    need(len(data) == pin["bytes"] and hashlib.sha256(data).hexdigest() == pin["sha256"], "integrity")
    return data


def inspect_node(data, profile):
    pin = profile["nodeDistribution"]
    need(len(data) == pin["bytes"] and hashlib.sha256(data).hexdigest() == pin["sha256"], "integrity")
    members = PUBLISHER.inspect_distribution(data, profile["node"], PUBLISHER.NODE_ARCHIVE)
    # All archive paths/types/modes/duplicates have already passed that unchanged parser.
    # Read only four literal authenticated header members; no general extraction path.
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as stream:
        raw = stream.read(512 * 1024**2 + 1)
    need(len(raw) <= 512 * 1024**2, "archive")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for pin in profile["headers"]:
            item = archive.getmember(PUBLISHER.NODE_ARCHIVE["root"] + "/" + pin["path"])
            need(item.isfile() and item.size == pin["bytes"], "integrity")
            with archive.extractfile(item) as stream:
                body = stream.read(pin["bytes"] + 1)
            need(len(body) == pin["bytes"] and hashlib.sha256(body).hexdigest() == pin["sha256"], "integrity")
            members[pin["path"]] = body
    return members


def materialize_node(sdk, members):
    sdk.mkdir(mode=0o700)
    for name, body in sorted(members.items(), key=lambda row: (len(row[0].split("/")), row[0])):
        target = sdk / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if body is None:
            target.mkdir(mode=0o700, exist_ok=True)
        else:
            executable = name in ("bin/node", "lib/node_modules/npm/bin/npm-cli.js",
                                  "lib/node_modules/npm/bin/npx-cli.js")
            COMMON.write(target, body, 0o700 if executable else 0o600)
    for name in ("npm", "npx"):
        (sdk / "bin" / name).symlink_to("../lib/node_modules/npm/bin/" + name + "-cli.js")


def child_environment(root, sdk, project):
    return {"PATH": str(sdk / "bin") + ":" + str(project / "node_modules/.bin") + ":/usr/bin:/bin",
            "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"), "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8", "TZ": "UTC", "CI": "true", "NODE_DISABLE_COMPILE_CACHE": "1",
            "NPM_CONFIG_USERCONFIG": str(root / "empty-user.npmrc"),
            "NPM_CONFIG_GLOBALCONFIG": str(root / "empty-global.npmrc"),
            "NPM_CONFIG_CACHE": str(root / "npm-cache"), "NPM_CONFIG_PREFIX": str(sdk),
            "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/", "NPM_CONFIG_IGNORE_SCRIPTS": "true",
            "NPM_CONFIG_FETCH_RETRIES": "0", "NPM_CONFIG_FETCH_TIMEOUT": "20000",
            "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false", "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            "NO_UPDATE_NOTIFIER": "1", "ESBUILD_BINARY_PATH": str(project / "node_modules/@esbuild/linux-x64/bin/esbuild"),
            "ELECTRON_BUILDER_CACHE": str(root / "builder-cache"), "ELECTRON_CACHE": str(root / "electron-cache")}


def build_commands(project, root, sdk):
    node = str(sdk / "bin/node")
    npm = str(sdk / "lib/node_modules/npm/bin/npm-cli.js")
    return [("dependencies", [node, npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"]),
            ("frontend", [node, npm, "run", "build"]),
            ("native", [node, npm, "run", "build:linux-native"]),
            ("package", [node, str(project / "node_modules/electron-builder/out/cli/cli.js"),
                         "--projectDir", str(project), "--linux", "dir", "--x64", "--publish", "never",
                         "--config.electronDist=" + str(root / "electron.zip"),
                         "--config.directories.output=" + str(root / "out")])]


def check_dependency_tree(project):
    root = project / "node_modules"
    count, total = 0, 0
    for at, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            p = Path(at) / name
            row = p.lstat()
            count += 1
            need(count <= 60000 and row.st_uid == os.getuid(), "dependencies")
            if p.is_symlink():
                need(p.resolve(strict=True).is_relative_to(root), "dependencies")
            else:
                need((stat.S_ISREG(row.st_mode) or stat.S_ISDIR(row.st_mode)) and
                     not row.st_mode & 0o7022, "dependencies")
                if p.is_file():
                    total += row.st_size
                    need(row.st_nlink == 1 and total <= 2 * 1024**3, "dependencies")
    for name, target in [("tsc", "typescript/bin/tsc"), ("vite", "vite/bin/vite.js"),
                         ("esbuild", "esbuild/bin/esbuild")]:
        need((root / ".bin" / name).resolve(strict=True) == root / target, "dependencies")
    return {"entries": count, "bytes": total}
