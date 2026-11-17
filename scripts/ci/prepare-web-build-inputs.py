"""Fixed Web build inputs only; no build, browser, package manager or scripts.

The real entry has its own exact branch/job admission. Gateway entrypoints and
their globals are never called or changed. Pure parsers accept inert fixtures;
fixture digests do not authenticate a publisher, host, build or release.
"""

import base64
import hashlib
import importlib.util
import inspect
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import threading
import time
import zlib


def sibling(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PUBLISHER = sibling("prepare-gateway-publisher-node.py", "web_publisher_parser")
COMMON = PUBLISHER.COMMON
BRANCH = "ci/v060-web-sandbox-reasons-20261117"
JOB = "web_baseline"
WORKFLOW_PATH = ".github/workflows/web-public-baseline.yml"
SOURCE_PACKAGE_SHA256 = "67e56df326b6c7f2bab40c8a190c730468e7c368d7db328047fe7771ce046116"
SOURCE_LOCK_SHA256 = "19b9794c0da10a71bb3ecdb4cc03019706e3f4c45a070bc3fcdf07b9a53c2ec3"
NAMES = (
    "@esbuild/linux-x64", "@oxc-project/types", "@rolldown/binding-linux-x64-gnu",
    "@rolldown/pluginutils", "@vitejs/plugin-react", "@xterm/addon-fit", "@xterm/xterm",
    "detect-libc", "esbuild", "fdir", "fflate", "lightningcss", "lightningcss-linux-x64-gnu",
    "lucide-react", "nanoid", "picocolors", "picomatch", "postcss", "react", "react-dom",
    "rolldown", "scheduler", "semver", "source-map-js", "tinyglobby", "vite",
)
SEEDS = ("vite", "@vitejs/plugin-react", "esbuild", "react", "react-dom", "lucide-react",
         "@xterm/xterm", "@xterm/addon-fit", "semver", "fflate")
FOUR = frozenset(("semver", "fflate", "esbuild", "@esbuild/linux-x64"))
DEPENDENCY_FIELDS = ("dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta")
LIMITS = {"seconds": 360, "compressedTotal": 128 * 1024**2,
          "expandedTotal": 256 * 1024**2, "membersTotal": 16384, "member": 32 * 1024**2}
NODE = {
    "version": "24.22.2", "sha256": "904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52",
    "bytes": 126881248, "npmVersion": "11.19.1",
    "npmInventorySHA256": "86c8f0b981ac3e1e424cd9d3c9f3f26c3edf4bad388cbcd6bf761a373c35d4ac",
    "npmEntries": 2380, "npmFileBytes": 12205960,
}
NODE_ARCHIVE = {
    "url": "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz",
    "sha256": "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
    "bytes": 58299872, "maximumCompressedBytes": 96 * 1024**2,
    "maximumExpandedBytes": 512 * 1024**2, "maximumMembers": 10000,
    "root": "node-v24.22.2-linux-x64",
}
STAGES = frozenset(("admission", "source", "node-fetch", "node-parse", "node-materialization",
                    "package-fetch", "package-parse", "package-materialization", "readback", "complete"))
REASONS = frozenset(("none", "admission", "source-integrity", "profile", "closure", "archive-integrity",
                     "archive-policy", "manifest", "aggregate-bounds", "deadline", "filesystem",
                     "network", "publisher-input", "output", "unexpected"))
RETAINED = []
GIT_OWNERS = []
GIT_ENVIRONMENT = {"PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0",
                   "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}
GIT_LIMITS = {"seconds": 30, "stdout": 65536, "stderr": 16384, "chunks": 256}


class FixedGitOwner:
    """Two fixed readonly reads, bounded acceptance, retained direct-child custody.

    The injected worker/launch/clock ports are only for memory controls. Native
    readers drain owned pipes through actual EOF; a deadline never sends a signal,
    closes a live pipe or admits a late success. Unknown dispatch/worker custody
    remains held, including while the entrypoint is trying to report a failure.
    """
    def __init__(self, role, root, deadline, ports):
        require(role in ("head", "status") and type(root) is str and root.startswith("/"), "admission")
        self.role, self.root, self.deadline, self.ports = role, root, deadline, ports
        self.command = ["/usr/bin/git", "--no-replace-objects", "--no-pager", "-c", "core.fsmonitor=false",
                        "-c", "core.untrackedCache=false"] + (
            ["rev-parse", "HEAD"] if role == "head" else ["status", "--porcelain", "--untracked-files=all"])
        self.lock = threading.Lock()
        self.child, self.workers, self.failures = None, [], []
        self.submitted, self.launch_issued, self.dispatch_pending, self.exit_observed = False, False, False, False
        self.workers_joined, self.join_submitted = False, False
        self.code, self.pid, self.last_clock = None, None, None
        self.streams = {name: {"stream": None, "eof": False, "closed": False, "chunks": [], "bytes": 0}
                        for name in ("stdout", "stderr")}

    def fail(self, reason, error=None):
        with self.lock:
            self.fail_locked(reason, error)

    def fail_locked(self, reason, error=None):
        if len(self.failures) < 8 and not any(row[0] == reason for row in self.failures):
            self.failures.append((reason, error))

    def observe_clock(self):
        value = self.ports["now"]()
        with self.lock:
            if (type(value) not in (float, int) or not math.isfinite(value) or value < 0 or
                    type(self.deadline) not in (float, int) or not math.isfinite(self.deadline) or
                    (self.last_clock is not None and value < self.last_clock)):
                self.fail_locked("clock")
            elif value > self.deadline:
                self.fail_locked("deadline")
            self.last_clock = value

    def direct_closed(self):
        with self.lock:
            return (not self.dispatch_pending and self.child is not None and self.exit_observed and
                    all(row["eof"] and row["closed"] for row in self.streams.values()))

    def closed(self):
        return self.direct_closed() and self.workers_joined

    def read_stream(self, name):
        row = self.streams[name]
        try:
            while True:
                body = row["stream"].read(65536)
                if type(body) is not bytes or len(body) > 65536:
                    self.fail("pipe-read")
                    return
                if not body:
                    with self.lock:
                        row["eof"] = True
                    if row["stream"].close() is not None:
                        self.fail("pipe-close")
                        return
                    with self.lock:
                        row["closed"] = True
                    return
                with self.lock:
                    if (row["bytes"] + len(body) > GIT_LIMITS[name] or
                            len(row["chunks"]) >= GIT_LIMITS["chunks"]):
                        self.fail_locked("output-bound")
                    elif not self.failures:
                        row["chunks"].append(body)
                        row["bytes"] += len(body)
                # Continue draining without retaining output after any failure.
        except BaseException as error:
            self.fail("pipe-unknown", error)

    def wait_child(self):
        try:
            code = self.child.wait()
            with self.lock:
                if type(code) is not int:
                    self.fail_locked("exit-unknown")
                    return
                self.code, self.exit_observed = code, True
                if code != 0:
                    self.fail_locked("exit-nonzero")
        except BaseException as error:
            self.fail("exit-unknown", error)

    def submit(self):
        require(not self.submitted, "admission")
        self.submitted = True
        GIT_OWNERS.append(self)  # Before submitting an operation that may return uncertainly.
        try:
            self.observe_clock()
            require(not self.failures, "deadline")
            self.dispatch_pending = True
            self.launch_issued = True
            child = self.ports["launch"](self.command, cwd=self.root, env=dict(GIT_ENVIRONMENT),
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, shell=False, close_fds=True)
            self.child = child
            self.pid = child.pid
            require(type(self.pid) is int and self.pid > 0 and child.stdin is None, "admission")
            for name in self.streams:
                self.streams[name]["stream"] = getattr(child, name)
                require(self.streams[name]["stream"] is not None, "admission")
            self.dispatch_pending = False
            for work in (lambda: self.read_stream("stdout"), lambda: self.read_stream("stderr"), self.wait_child):
                require(self.ports["start"](work, self) is None, "admission")
        except BaseException as error:
            self.fail("dispatch-or-worker-unknown", error)
            # A refusal before dispatch has no child or live submission to retain.
            if not self.launch_issued:
                self.workers_joined = True
                GIT_OWNERS.remove(self)
                raise WebPreparationRefused("deadline") from error

    def join_workers(self):
        if not self.direct_closed() or self.join_submitted:
            return
        self.join_submitted = True
        try:
            require(self.ports["join"](self) is None, "admission")
            self.workers_joined = True
        except BaseException as error:
            self.fail("worker-close-unknown", error)

    def keep(self):
        """Never retries a child or an uncertain join, signals, or closes live pipes."""
        while not self.closed():
            try:
                self.observe_clock()
                self.join_workers()
                if not self.closed():
                    self.ports["pause"](0.01)
            except BaseException as error:
                self.fail("keeper-unknown", error)

    def finish(self):
        self.observe_clock()
        require(self.closed() and not self.failures and self.code == 0, "source-integrity")
        return b"".join(self.streams["stdout"]["chunks"])


def native_git_ports():
    def start(work, owner):
        worker = threading.Thread(target=work, daemon=False)
        owner.workers.append(worker)
        require(worker.start() is None, "admission")

    def join(owner):
        for worker in owner.workers:
            require(worker.join() is None and worker.is_alive() is False, "admission")

    return {"launch": subprocess.Popen, "start": start, "join": join,
            "now": time.monotonic, "pause": time.sleep}


def read_fixed_git(role, root, deadline):
    git = Path("/usr/bin/git")
    COMMON.directory(Path(root))
    COMMON.directory(git.parent)
    require(git.resolve(strict=True) == git and COMMON.metadata(git).st_mode & stat.S_IXUSR, "admission")
    owner = FixedGitOwner(role, str(root), deadline, native_git_ports())
    owner.submit()
    owner.keep()
    try:
        return owner.finish()
    finally:
        if owner.closed():
            GIT_OWNERS.remove(owner)
        RETAINED.append({"gitOwner": owner})


def keep_git_custody():
    # This guard precedes any fallible success/failure reporting at the entrypoint.
    while GIT_OWNERS:
        for owner in list(GIT_OWNERS):
            try:
                owner.keep()
                if owner.closed():
                    GIT_OWNERS.remove(owner)
                    RETAINED.append({"gitOwner": owner})
            except BaseException as error:
                owner.fail("entry-keeper-unknown", error)


class WebPreparationRefused(ValueError):
    def __init__(self, reason, state=None):
        self.reason = reason if reason in REASONS and reason != "none" else "unexpected"
        self.state = state
        super().__init__("Web build-input preparation refused")


def require(condition, reason):
    if not condition:
        raise WebPreparationRefused(reason)


def json_bytes(raw, maximum):
    require(type(raw) is bytes and 0 < len(raw) <= maximum, "profile")

    def pairs(rows):
        result = {}
        for name, value in rows:
            require(name not in result, "profile")
            result[name] = value
        return result

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False, "profile"))


def compatible(entry):
    for field, value in (("os", "linux"), ("cpu", "x64"), ("libc", "glibc")):
        wanted = entry.get(field)
        if wanted is not None:
            require(type(wanted) is list and all(type(x) is str for x in wanted), "closure")
            if "!" + value in wanted or (any(not x.startswith("!") for x in wanted) and value not in wanted):
                return False
    return True


def closure(lock):
    """Exact root-level native-loader build closure, not a dependency solver."""
    packages, pending, found = lock["packages"], list(SEEDS), set()
    while pending:
        name = pending.pop()
        if name in found:
            continue
        require(name in NAMES, "closure")
        entry = packages["node_modules/" + name]
        require(not entry.get("link") and compatible(entry), "closure")
        found.add(name)
        pending.extend(entry.get("dependencies", {}))
        for child in entry.get("optionalDependencies", {}):
            candidate = packages.get("node_modules/" + child)
            require(type(candidate) is dict, "closure")
            if compatible(candidate):
                pending.append(child)
        for child in entry.get("peerDependencies", {}):
            optional = entry.get("peerDependenciesMeta", {}).get(child, {}).get("optional") is True
            if child in NAMES or not optional:
                pending.append(child)
    require(found == set(NAMES), "closure")
    return found


def validate_inputs(package_bytes, lock_bytes, profile_bytes):
    require(hashlib.sha256(package_bytes).hexdigest() == SOURCE_PACKAGE_SHA256 and
            hashlib.sha256(lock_bytes).hexdigest() == SOURCE_LOCK_SHA256, "source-integrity")
    manifest = json_bytes(package_bytes, 1024**2)
    lock = json_bytes(lock_bytes, 4 * 1024**2)
    profile = json_bytes(profile_bytes, 32768)
    require(type(profile) is dict and set(profile) == {
        "schemaVersion", "scope", "target", "sourcePackageSHA256", "sourceLockSHA256",
        "node", "reference", "packages", "sizeMeaning"}, "profile")
    require(type(profile["schemaVersion"]) is int and profile["schemaVersion"] == 1 and
            profile["scope"] == "web-build-inputs-only" and
            profile["target"] == {"os": "linux", "cpu": "x64", "libc": "glibc"} and
            profile["sourcePackageSHA256"] == SOURCE_PACKAGE_SHA256 and
            profile["sourceLockSHA256"] == SOURCE_LOCK_SHA256 and profile["node"] == NODE and
            profile["reference"] == {"distribution": NODE_ARCHIVE["url"],
                                     "distributionSHA256": NODE_ARCHIVE["sha256"]} and
            type(profile["sizeMeaning"]) is str and len(profile["sizeMeaning"]) <= 1024, "profile")
    require(manifest["version"] == lock["version"] == "0.6.0" and lock["lockfileVersion"] == 3, "source-integrity")
    roots = {**manifest["dependencies"], **manifest["devDependencies"]}
    require(all(name in roots for name in SEEDS), "closure")
    closure(lock)
    require(type(profile["packages"]) is list and
            tuple(p["name"] for p in profile["packages"]) == NAMES, "profile")
    result = []
    for pin in profile["packages"]:
        require(set(pin) == {"name", "version", "url", "integrity", "maximumCompressedBytes",
                             "maximumExpandedBytes", "maximumMembers"}, "profile")
        entry = lock["packages"]["node_modules/" + pin["name"]]
        require(all(pin[a] == entry[b] for a, b in (("version", "version"), ("url", "resolved"),
                                                    ("integrity", "integrity"))), "profile")
        url = "https://registry.npmjs.org/" + pin["name"] + "/-/" + pin["name"].split("/")[-1] + "-" + pin["version"] + ".tgz"
        require(pin["url"] == url and re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", pin["integrity"]), "profile")
        old = pin["name"] in FOUR
        require(type(pin["maximumCompressedBytes"]) is int and
                pin["maximumCompressedBytes"] == (16 if old else 32) * 1024**2 and
                type(pin["maximumExpandedBytes"]) is int and
                pin["maximumExpandedBytes"] == (64 if old else 128) * 1024**2 and
                type(pin["maximumMembers"]) is int and pin["maximumMembers"] == (4096 if old else 8192), "profile")
        result.append({**pin, **{key: entry.get(key, {}) for key in DEPENDENCY_FIELDS}})
    return profile, result


def inspect_package(data, package):
    """SRI first; ordinary bounded tar files/directories only. No extraction API."""
    require(type(data) is bytes and 0 < len(data) <= package["maximumCompressedBytes"], "archive-integrity")
    sri = package["integrity"]
    require(type(sri) is str and re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", sri), "archive-integrity")
    expected = base64.b64decode(sri[7:], validate=True)
    require(base64.b64encode(expected).decode() == sri[7:] and hashlib.sha512(data).digest() == expected,
            "archive-integrity")
    decoder = zlib.decompressobj(31)
    raw = decoder.decompress(data, package["maximumExpandedBytes"] + 1)
    require(len(raw) <= package["maximumExpandedBytes"] and decoder.eof and
            not decoder.unused_data and not decoder.unconsumed_tail, "archive-policy")
    position, physical = 0, 0
    while True:
        require(position + 512 <= len(raw), "archive-policy")
        header = raw[position:position + 512]
        if header == bytes(512):
            require(len(raw) - position >= 1024 and not any(raw[position:]), "archive-policy")
            break
        physical += 1
        require(physical <= package["maximumMembers"], "archive-policy")
        item = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        require(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE,
                             tarfile.GNUTYPE_LONGNAME) and
                0 <= item.size <= LIMITS["member"] and
                (item.type != tarfile.GNUTYPE_LONGNAME or item.size <= 2048), "archive-policy")
        position += 512 + ((item.size + 511) // 512) * 512
        require(position <= len(raw), "archive-policy")
    members, seen, parents = {}, {}, set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:", encoding="utf-8", errors="strict") as archive:
        for count, item in enumerate(archive, 1):
            require(count <= package["maximumMembers"], "archive-policy")
            name = item.name[:-1] if item.isdir() and item.name.endswith("/") else item.name
            parts = name.split("/")
            require(0 < len(name) <= 2048 and parts[0] == "package" and
                    all(p not in ("", ".", "..") for p in parts) and
                    not re.search(r"[\\:\x00-\x1f\x7f]", name), "archive-policy")
            require(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and
                    item.sparse is None and not item.mode & 0o7022 and
                    0 <= item.size <= LIMITS["member"] and
                    (not item.isdir() or item.size == 0), "archive-policy")
            key = name.lower()
            require(key not in seen and (item.isdir() or key not in parents), "archive-policy")
            parent = key
            while "/" in parent:
                parent = parent.rsplit("/", 1)[0]
                require(seen.get(parent) != "file", "archive-policy")
                parents.add(parent)
            seen[key] = "directory" if item.isdir() else "file"
            if len(parts) == 1:
                require(item.isdir(), "archive-policy")
                continue
            relative = "/".join(parts[1:])
            if item.isdir():
                members[relative] = (None, 0o700)
            else:
                with archive.extractfile(item) as stream:
                    body = stream.read(LIMITS["member"] + 1)
                require(len(body) == item.size, "archive-policy")
                members[relative] = (body, 0o700 if item.mode & 0o100 else 0o600)
    manifest = json_bytes(members["package.json"][0], 1024**2)
    require(manifest["name"] == package["name"] and manifest["version"] == package["version"] and
            not manifest.get("bundledDependencies") and not manifest.get("bundleDependencies"), "manifest")
    require(all(manifest.get(key, {}) == package.get(key, {}) for key in DEPENDENCY_FIELDS), "manifest")
    return {"members": members, "expandedBytes": len(raw), "physicalMembers": physical,
            "logicalMembers": len(seen)}


def directory_names(members):
    names = {name for name, (body, _) in members.items() if body is None}
    for name in members:
        names.update(str(p) for p in PurePosixPath(name).parents if str(p) != ".")
    return sorted(names, key=lambda n: (n.count("/"), n))


def inventory(members):
    rows = [[name, "directory", None, None] for name in directory_names(members)]
    rows.extend([name, "file", len(body), hashlib.sha256(body).hexdigest()]
                for name, (body, _) in members.items() if body is not None)
    rows.sort(key=lambda row: row[0])
    return rows


def prepare_inputs(profile, packages, root, prefix, ports):
    """Explicit synchronous ports; no native defaults, retries, scripts or deletion."""
    state = {"stage": "admission", "input": "none", "status": "pending", "created": [],
             "pending": [], "unknownReturns": [], "packageCount": 0}

    def call(name, *args, acknowledgement=False):
        token = {"operation": name}
        state["pending"].append(token)
        value = ports[name](*args)
        if inspect.isawaitable(value):
            state["unknownReturns"].append(value)
            raise WebPreparationRefused("filesystem", state)
        if acknowledgement:
            if value is not None:
                state["unknownReturns"].append(value)
                raise WebPreparationRefused("filesystem", state)
        state["pending"].remove(token)
        return value

    start = call("now")
    last = start

    def deadline():
        nonlocal last
        now = call("now")
        require(type(now) in (float, int) and type(last) in (float, int) and
                math.isfinite(now) and math.isfinite(start) and start >= 0 and
                last <= now <= start + LIMITS["seconds"], "deadline")
        last = now

    def mkdir(path):
        deadline()
        call("mkdir", path, acknowledgement=True)
        state["created"].append(path)

    def write(path, body, mode=0o600):
        deadline()
        call("write", path, body, mode, acknowledgement=True)

    def materialize(at, members):
        for name in directory_names(members):
            mkdir(at + "/" + name)
        for name, (body, mode) in sorted(members.items()):
            if body is not None:
                write(at + "/" + name, body, mode)

    try:
        deadline()
        call("directory", str(PurePosixPath(prefix).parent), acknowledgement=True)
        mkdir(prefix)
        state["stage"] = "node-fetch"
        raw = call("node_fetch", NODE_ARCHIVE)
        deadline()
        state["stage"] = "node-parse"
        node_members = PUBLISHER.inspect_distribution(raw, profile["node"], NODE_ARCHIVE)
        deadline()
        state["stage"] = "node-materialization"
        write(prefix + "/node-distribution.tar.gz", raw)
        mkdir(prefix + "/node")
        materialize(prefix + "/node", {name: (body, 0o700 if name == "bin/node" else 0o600)
                                      for name, body in node_members.items()})
        call("node_readback", prefix + "/node", profile["node"], acknowledgement=True)
        mkdir(prefix + "/package-archives")
        parsed, compressed, expanded, physical, logical = [], 0, 0, 0, 0
        for ordinal, package in enumerate(packages, 1):
            state["input"], state["stage"] = str(ordinal), "package-fetch"
            deadline()
            raw = call("package_fetch", package)
            deadline()
            state["stage"] = "package-parse"
            item = inspect_package(raw, package)
            compressed += len(raw)
            expanded += item["expandedBytes"]
            physical += item["physicalMembers"]
            logical += item["logicalMembers"]
            require(compressed <= LIMITS["compressedTotal"] and expanded <= LIMITS["expandedTotal"] and
                    physical <= LIMITS["membersTotal"] and logical <= LIMITS["membersTotal"], "aggregate-bounds")
            deadline()
            write(prefix + "/package-archives/" + str(ordinal) + ".tgz", raw)
            parsed.append((package, item))
        state["stage"], state["input"] = "package-materialization", "none"
        modules = root + "/node_modules"
        mkdir(modules)
        for scope in sorted({p["name"].split("/")[0] for p in packages if p["name"].startswith("@")}):
            mkdir(modules + "/" + scope)
        for ordinal, (package, item) in enumerate(parsed, 1):
            state["input"] = str(ordinal)
            at = modules + "/" + package["name"]
            mkdir(at)
            materialize(at, item["members"])
            state["packageCount"] += 1
        state["stage"], state["input"] = "readback", "none"
        expected = []
        for package, item in parsed:
            expected.extend([package["name"] + "/" + row[0], *row[1:]] for row in inventory(item["members"]))
            expected.append([package["name"], "directory", None, None])
        expected.extend([scope, "directory", None, None] for scope in
                        sorted({p["name"].split("/")[0] for p in packages if p["name"].startswith("@")}))
        expected.sort(key=lambda row: row[0])
        require(call("inventory", modules) == expected, "filesystem")
        call("node_readback", prefix + "/node", profile["node"], acknowledgement=True)
        deadline()
        state["stage"], state["status"] = "complete", "prepared-inputs-not-runtime"
        require(not state["pending"] and not state["unknownReturns"] and state["packageCount"] == 26, "filesystem")
        return state
    except BaseException as error:
        state["status"] = "refused-custody-retained"
        RETAINED.append({"error": error, "state": state, "ports": ports})
        if isinstance(error, WebPreparationRefused):
            error.state = state
            raise
        if isinstance(error, COMMON.PreparationRefused):
            reason = "archive-integrity" if error.reason == "package-integrity" else "publisher-input"
        elif isinstance(error, COMMON.urllib.error.URLError):
            reason = "network"
        elif isinstance(error, (tarfile.TarError, zlib.error, EOFError)):
            reason = "archive-policy"
        elif isinstance(error, OSError):
            reason = "filesystem"
        else:
            reason = "unexpected"
        raise WebPreparationRefused(reason, state) from error


class NativePorts:
    """Narrow scopes only. Every created parent is reobserved; no existing slot adoption."""
    def __init__(self, root, prefix):
        self.root, self.prefix = Path(root), Path(prefix)
        self.identities = {}

    def directory(self, value):
        p = Path(value)
        COMMON.directory(p)
        for parent in reversed((p, *p.parents)):
            row = COMMON.metadata(parent, True)
            observed = (row.st_dev, row.st_ino, row.st_uid, row.st_gid, row.st_mode)
            original = self.identities.setdefault(str(parent), observed)
            require(original == observed, "filesystem")

    def inside(self, value):
        p = Path(value)
        require(p.is_absolute() and str(p) == value and
                (p == self.prefix or self.prefix in p.parents or
                 p == self.root / "node_modules" or self.root / "node_modules" in p.parents), "filesystem")
        return p

    def mkdir(self, value):
        p = self.inside(value)
        self.directory(str(p.parent))
        require(not os.path.lexists(p), "filesystem")
        p.mkdir(mode=0o700)
        self.directory(str(p))

    def write(self, value, body, mode):
        p = self.inside(value)
        require(type(body) is bytes and mode in (0o600, 0o700), "filesystem")
        self.directory(str(p.parent))
        COMMON.write(p, body, mode)
        self.directory(str(p.parent))
        require(COMMON.read(p, len(body)) == body, "filesystem")

    def node_readback(self, value, expected):
        require(value == str(self.prefix / "node"), "filesystem")
        p = Path(value) / "bin/node"
        raw = COMMON.read(p, 128 * 1024**2)
        require(len(raw) == expected["bytes"] and hashlib.sha256(raw).hexdigest() == expected["sha256"] and
                COMMON.metadata(p).st_mode & stat.S_IXUSR, "publisher-input")
        COMMON.npm_inventory(Path(value) / "lib/node_modules/npm", expected)

    def inventory(self, value):
        require(value == str(self.root / "node_modules"), "filesystem")
        root, rows, total, pending = Path(value), [], 0, [Path(value)]
        while pending:
            at = pending.pop()
            self.directory(str(at))
            with os.scandir(at) as entries:
                for item in entries:
                    require(len(rows) < LIMITS["membersTotal"], "filesystem")
                    p = at / item.name
                    name = p.relative_to(root).as_posix()
                    s = p.lstat()
                    if stat.S_ISDIR(s.st_mode):
                        self.directory(str(p))
                        rows.append([name, "directory", None, None])
                        pending.append(p)
                    else:
                        body = COMMON.read(p, LIMITS["member"])
                        total += len(body)
                        require(total <= LIMITS["expandedTotal"], "filesystem")
                        rows.append([name, "file", len(body), hashlib.sha256(body).hexdigest()])
        rows.sort(key=lambda row: row[0])
        return rows

    def ports(self):
        return {"now": time.monotonic, "directory": self.directory, "mkdir": self.mkdir,
                "write": self.write, "node_fetch": PUBLISHER.fetch_distribution,
                "package_fetch": COMMON.download, "node_readback": self.node_readback,
                "inventory": self.inventory}


def admit(environment, root, git_reader=None):
    expected = {"GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub", "GITHUB_ACTIONS": "true",
                "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + BRANCH,
                "GITHUB_JOB": JOB, "GITHUB_RUN_ATTEMPT": "1", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64"}
    require(os.getuid() > 0 and os.uname().sysname == "Linux" and os.uname().machine == "x86_64" and
            all(environment.get(k) == v for k, v in expected.items()), "admission")
    require(re.fullmatch(r"[1-9][0-9]{0,19}", environment.get("GITHUB_RUN_ID", "")) and
            re.fullmatch(r"[a-f0-9]{40}", environment.get("GITHUB_SHA", "")), "admission")
    require(environment.get("GITHUB_WORKFLOW_SHA") == environment["GITHUB_SHA"] and
            environment.get("GITHUB_WORKFLOW_REF") == expected["GITHUB_REPOSITORY"] + "/" + WORKFLOW_PATH +
            "@" + expected["GITHUB_REF"], "admission")
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
                "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_OPTIONS", "NODE_PATH",
                "ESBUILD_BINARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"):
        require(not environment.get(key), "admission")
    require(environment.get("NODE_TLS_REJECT_UNAUTHORIZED") in (None, "1"), "admission")
    COMMON.directory(root)
    require(Path(environment["GITHUB_WORKSPACE"]).resolve(strict=True) == root and
            not any(os.path.lexists(root / n) for n in ("node_modules", "validation", ".npmrc")), "admission")
    git = Path("/usr/bin/git")
    COMMON.directory(git.parent)
    require(git.resolve(strict=True) == git and COMMON.metadata(git).st_mode & stat.S_IXUSR,
            "admission")
    git_reader = read_fixed_git if git_reader is None else git_reader
    deadline = time.monotonic() + GIT_LIMITS["seconds"]
    require(git_reader("head", str(root), deadline).decode().strip() == environment["GITHUB_SHA"] and
            git_reader("status", str(root), deadline) == b"", "source-integrity")
    event = json_bytes(COMMON.read(Path(environment["GITHUB_EVENT_PATH"]), 4 * 1024**2), 4 * 1024**2)
    require(event["repository"]["full_name"] == expected["GITHUB_REPOSITORY"] and
            event["repository"]["private"] is False and event["deleted"] is False and
            event["ref"] == expected["GITHUB_REF"] and event["after"] == environment["GITHUB_SHA"], "admission")
    temporary = Path(environment["RUNNER_TEMP"])
    COMMON.directory(temporary)
    return temporary / ("web-baseline-inputs-" + environment["GITHUB_RUN_ID"] + "-1")


def main():
    state = {"stage": "admission", "input": "none"}
    try:
        root = Path.cwd()
        prefix = admit(os.environ, root)
        state["stage"] = "source"
        profile, packages = validate_inputs(COMMON.read(root / "package.json", 1024**2),
                                           COMMON.read(root / "package-lock.json", 4 * 1024**2),
                                           COMMON.read(root / "scripts/ci/web-build-inputs.json", 32768))
        owner = NativePorts(str(root), str(prefix))
        return prepare_inputs(profile, packages, str(root), str(prefix), owner.ports())
    except BaseException as error:
        if isinstance(error, WebPreparationRefused):
            error.state = error.state or state
            raise
        RETAINED.append({"error": error, "state": state})
        raise WebPreparationRefused("unexpected", state) from error


def entry(run=main, stdout=None, stderr=None):
    stdout = sys.stdout.buffer if stdout is None else stdout
    stderr = sys.stderr.buffer if stderr is None else stderr
    try:
        state = run()
        keep_git_custody()
        require(state["status"] == "prepared-inputs-not-runtime" and state["stage"] == "complete" and
                state["packageCount"] == 26 and not state["pending"] and not state["unknownReturns"], "output")
        payload = b'{"schemaVersion":1,"status":"prepared-inputs-not-runtime","stage":"complete","reason":"none","input":"none","packageCount":26}\n'
        require(stdout.write(payload) == len(payload) and stdout.flush() is None, "output")
        return 0
    except BaseException as error:
        keep_git_custody()
        state = getattr(error, "state", None)
        RETAINED.append({"error": error, "state": state})
        stage = state.get("stage") if type(state) is dict else "admission"
        ordinal = state.get("input") if type(state) is dict else "none"
        reason = error.reason if isinstance(error, WebPreparationRefused) else "unexpected"
        stage = stage if stage in STAGES else "admission"
        ordinal = ordinal if ordinal in ("none", *map(str, range(1, 27))) else "none"
        diagnostic = (json.dumps({"schemaVersion": 1, "status": "refused", "stage": stage,
                                 "reason": reason, "input": ordinal}, separators=(",", ":")) + "\n").encode()
        try:
            require(stderr.write(diagnostic) == len(diagnostic) and stderr.flush() is None, "output")
        except BaseException as reporting_error:
            RETAINED[-1]["reportingError"] = reporting_error
        return 1


if __name__ == "__main__":
    raise SystemExit(entry())
