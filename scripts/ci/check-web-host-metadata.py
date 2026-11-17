"""Fixed-path readonly host preflight before software acquisition.

Only ordinary metadata and two 64-byte ELF headers are read. No version probe,
browser, package, process, download, permission repair or native admission exists
here. A passing result is neither executable authentication nor sandbox proof.
"""

import inspect
import json
import math
import os
from pathlib import PurePosixPath
import re
import stat
import sys
import time


FILES = (("chrome", "/opt/google/chrome/chrome"),
         ("driver", "/usr/local/share/chromedriver-linux64/chromedriver"))
BRANCH = "ci/v060-web-sandbox-baseline-20261117"
WORKFLOW = ".github/workflows/web-public-baseline.yml"
SECONDS = 15
MAX_SAFE = 2**53 - 1
REASONS = frozenset(("none", "admission", "type", "owner", "mode", "inode", "link-count", "file-size",
                     "file-identity", "elf", "read", "close", "clock", "deadline", "missing",
                     "access-denied", "filesystem", "output", "unexpected"))
STAGES = frozenset(("admission", "parents", "executable", "complete"))
RETAINED = []


class MetadataRefused(ValueError):
    def __init__(self, reason, state=None):
        self.reason = reason if reason in REASONS and reason != "none" else "unexpected"
        self.state = state
        super().__init__("Web host metadata refused")


def require(value, reason):
    if not value:
        raise MetadataRefused(reason)


def context(environment, actual):
    fixed = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub",
             "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + BRANCH, "GITHUB_JOB": "web_baseline",
             "GITHUB_RUN_ATTEMPT": "1", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
             "RUNNER_ARCH": "X64"}
    require(type(actual) is dict and type(actual.get("uid")) is int and actual["uid"] > 0 and
            actual["uid"] == actual.get("euid") and actual.get("system") == "Linux" and
            actual.get("machine") == "x86_64" and all(environment.get(k) == v for k, v in fixed.items()),
            "admission")
    require(re.fullmatch(r"[a-f0-9]{40}", environment.get("GITHUB_SHA", "")) and
            environment.get("GITHUB_WORKFLOW_SHA") == environment["GITHUB_SHA"] and
            environment.get("GITHUB_WORKFLOW_REF") == fixed["GITHUB_REPOSITORY"] + "/" + WORKFLOW +
            "@" + fixed["GITHUB_REF"], "admission")
    return {"uid": actual["uid"]}


def identity(row):
    return tuple(getattr(row, key) for key in ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode",
                                               "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))


def checked_stat(row, directory=False):
    require(stat.S_ISDIR(row.st_mode) if directory else stat.S_ISREG(row.st_mode), "type")
    require(type(row.st_uid) is int and row.st_uid == 0, "owner")
    require(type(row.st_mode) is int and not row.st_mode & 0o7022, "mode")
    require(type(row.st_ino) is int and 0 < row.st_ino <= MAX_SAFE and
            type(row.st_dev) is int and 0 <= row.st_dev <= MAX_SAFE and
            type(row.st_gid) is int and 0 <= row.st_gid <= MAX_SAFE and
            type(row.st_mtime_ns) is int and row.st_mtime_ns >= 0 and
            type(row.st_ctime_ns) is int and row.st_ctime_ns >= 0, "inode")
    if not directory:
        require(row.st_nlink == 1, "link-count")
        require(type(row.st_size) is int and 64 <= row.st_size <= MAX_SAFE, "file-size")
        require(row.st_mode & stat.S_IXUSR, "mode")
    return row


def parents(file):
    return tuple(str(p) for p in reversed(PurePosixPath(file).parents))


def inspect_host(selected, ports):
    """Explicit synchronous ports and fixed paths only; fixtures are not host proof."""
    state = {"stage": "admission", "input": "none", "handles": [], "pending": [],
             "unknownReturns": [], "directories": {}, "headerBytes": 0, "reads": 0}

    def call(kind, *args):
        token = {"operation": kind}
        state["pending"].append(token)
        try:
            value = ports[kind](*args)
        except BaseException:
            if kind not in ("open", "close"):
                state["pending"].remove(token)
            raise
        if inspect.isawaitable(value):
            state["unknownReturns"].append(value)
            raise MetadataRefused("filesystem", state)
        state["pending"].remove(token)
        return value

    started, last = None, None

    def clock():
        nonlocal started, last
        now = call("now")
        require(type(now) in (float, int) and math.isfinite(now) and now >= 0, "clock")
        started = now if started is None else started
        require(last is None or now >= last, "clock")
        last = now
        require(now - started <= SECONDS, "deadline")

    def directory_chain(file):
        state["stage"] = "parents"
        for path in parents(file):
            clock()
            row = checked_stat(call("lstat", path), True)
            clock()
            # Check each parent before asking anything about a descendant. No realpath.
            key = tuple(getattr(row, k) for k in ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode"))
            original = state["directories"].setdefault(path, key)
            require(original == key, "file-identity")

    try:
        require(type(selected) is dict and type(selected.get("uid")) is int and selected["uid"] > 0,
                "admission")
        clock()
        for role, file in FILES:
            state["input"] = role
            directory_chain(file)
            state["stage"] = "executable"
            before = identity(checked_stat(call("lstat", file)))
            clock()
            handle = {"fd": None, "acquiring": True, "closed": False}
            state["handles"].append(handle)  # Retain original acquisition before submission.
            first = None
            try:
                fd = call("open", file)
                handle["fd"] = fd
                require(type(fd) is int and fd >= 0, "read")
                handle["acquiring"] = False
                require(identity(checked_stat(call("fstat", fd))) == before, "file-identity")
                header = bytearray()
                while len(header) < 64:
                    clock()
                    require(state["reads"] < 128, "read")
                    block = call("pread", fd, 64 - len(header), len(header))
                    state["reads"] += 1
                    clock()
                    require(type(block) is bytes and 0 < len(block) <= 64 - len(header), "read")
                    header.extend(block)
                    state["headerBytes"] += len(block)
                    require(state["headerBytes"] <= 128, "read")
                require(header[:4] == b"\x7fELF" and header[4] == 2 and header[5] == 1 and
                        int.from_bytes(header[16:18], "little") in (2, 3) and
                        int.from_bytes(header[18:20], "little") == 62, "elf")
                require(identity(checked_stat(call("fstat", fd))) == before, "file-identity")
                directory_chain(file)
                state["stage"] = "executable"
                require(identity(checked_stat(call("lstat", file))) == before, "file-identity")
                clock()
            except BaseException as error:
                first = error
            if type(handle["fd"]) is int and handle["fd"] >= 0:
                try:
                    require(call("close", handle["fd"]) is None, "close")
                    handle["closed"] = True
                except BaseException as error:
                    if first is not None:
                        state["primaryError"] = first
                    state.setdefault("closeErrors", []).append(error)
                    first = MetadataRefused("close", state)
            if first is not None:
                raise first
            clock()
        require(not state["pending"] and not state["unknownReturns"] and
                len(state["handles"]) == 2 and all(h["closed"] for h in state["handles"]), "close")
        state["stage"], state["input"] = "complete", "none"
        return state
    except BaseException as error:
        RETAINED.append({"error": error, "state": state, "ports": ports})
        if isinstance(error, MetadataRefused):
            error.state = state
            raise
        reason = ("missing" if isinstance(error, FileNotFoundError) else
                  "access-denied" if isinstance(error, PermissionError) else
                  "filesystem" if isinstance(error, OSError) else "unexpected")
        raise MetadataRefused(reason, state) from error


class NativePorts:
    def __init__(self):
        self.allowed = frozenset(path for _, file in FILES for path in (*parents(file), file))
        self.files = frozenset(file for _, file in FILES)
        self.handles = set()

    def lstat(self, file):
        require(file in self.allowed, "filesystem")
        return os.lstat(file)

    def open(self, file):
        require(file in self.files, "filesystem")
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        self.handles.add(fd)
        return fd

    def fstat(self, fd):
        require(fd in self.handles, "read")
        return os.fstat(fd)

    def pread(self, fd, count, offset):
        require(fd in self.handles and type(count) is int and 0 < count <= 64 and
                type(offset) is int and 0 <= offset < 64 and count + offset <= 64, "read")
        return os.pread(fd, count, offset)

    def close(self, fd):
        require(fd in self.handles, "close")
        require(os.close(fd) is None, "close")
        self.handles.remove(fd)

    def ports(self):
        return {name: getattr(self, name) for name in ("lstat", "open", "fstat", "pread", "close")} | {
            "now": time.monotonic}


def main():
    observed = os.uname()
    selected = context(os.environ, {"uid": os.getuid(), "euid": os.geteuid(),
                                    "system": observed.sysname, "machine": observed.machine})
    return inspect_host(selected, NativePorts().ports())


def entry(run=main, stdout=None, stderr=None):
    stdout = sys.stdout.buffer if stdout is None else stdout
    stderr = sys.stderr.buffer if stderr is None else stderr
    state, reason = None, "none"
    try:
        state = run()
        require(state["stage"] == "complete" and state["input"] == "none" and
                not state["pending"] and not state["unknownReturns"] and
                len(state["handles"]) == 2 and all(h["closed"] for h in state["handles"]), "close")
    except BaseException as error:
        observed_state = getattr(error, "state", None)
        if observed_state is not None:
            state = observed_state
        RETAINED.append({"error": error, "state": state})
        reason = error.reason if isinstance(error, MetadataRefused) else "unexpected"
    def payload():
        known = (state is None or (type(state) is dict and
                 state.get("pending") == [] and state.get("unknownReturns") == [] and
                 type(state.get("handles")) is list and
                 all(type(h) is dict and h.get("closed") is True for h in state["handles"])))
        return {"schemaVersion": 1, "status": "passed" if reason == "none" else "nonpassing",
                "stage": state["stage"] if type(state) is dict and state.get("stage") in STAGES else "admission",
                "reason": reason, "input": state["input"] if type(state) is dict and
                state.get("input") in ("none", "chrome", "driver") else "none",
                "closure": "known-readonly-scope" if known else "retained-unknown",
                "qualification": "host-metadata-only", "executed": False, "releaseAcceptance": False}
    encoded = (json.dumps(payload(), separators=(",", ":")) + "\n").encode()
    try:
        stream = stdout if reason == "none" else stderr
        require(stream.write(encoded) == len(encoded) and stream.flush() is None, "output")
    except BaseException as error:
        RETAINED.append({"error": error, "state": state})
        return 1
    return 0 if reason == "none" else 1


if __name__ == "__main__":
    raise SystemExit(entry())
