"""Bounded passive report readback; acknowledgment never overrides worker outcome.

No downloads, subprocesses, installation, cleanup, stdout diagnostics or native
defaults are used by pure classification. Native file operations are injectable.
"""

import inspect
import json
import os
from pathlib import PurePosixPath
import re
import stat


REPOSITORY = "brucerry/embedded-linux-diagnostic-hub"
BRANCH = "ci/v060-gateway-health-root-metadata-20261116"
REF = "refs/heads/" + BRANCH
PHASES = frozenset(("admission", "canonical-build", "package-readback", "tool-selection",
                    "runtime-inputs", "health", "complete", "report"))
REASONS = frozenset(("none", "operation-failed", "custody-held", "report-failed"))
FIELDS = frozenset(("schemaVersion", "kind", "repository", "ref", "sourceCommit", "runId",
                    "runAttempt", "jobKey", "result", "phase", "reason", "releaseAcceptance"))
RETAINED = []


class ReportRefused(ValueError):
    pass


def require(condition):
    if not condition:
        raise ReportRefused("Gateway health report unavailable")


def absolute(path):
    require(type(path) is str and path.startswith("/") and len(path) <= 4096 and
            str(PurePosixPath(path)) == path and ".." not in path.split("/") and
            not re.search(r"[\\\x00-\x20\x7f]", path))


def context(environment, uid):
    require(type(uid) is int and uid > 0)
    fixed = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPOSITORY,
             "GITHUB_REF": REF, "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "gateway_build",
             "GITHUB_EVENT_NAME": "push", "RUNNER_ENVIRONMENT": "github-hosted",
             "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64"}
    require(all(environment.get(key) == value for key, value in fixed.items()))
    sha, run = environment.get("GITHUB_SHA"), environment.get("GITHUB_RUN_ID")
    require(type(sha) is str and re.fullmatch(r"[a-f0-9]{40}", sha) and
            type(run) is str and re.fullmatch(r"[1-9][0-9]{0,31}", run))
    require(environment.get("GITHUB_WORKFLOW_SHA") == sha and
            environment.get("GITHUB_WORKFLOW_REF") == REPOSITORY +
            "/.github/workflows/gateway-same-job-health-smoke.yml@" + REF)
    require(environment.get("SMOKE_OUTCOME") in ("success", "failure", "cancelled", "skipped"))
    temporary, output = environment.get("RUNNER_TEMP"), environment.get("GITHUB_OUTPUT")
    absolute(temporary); absolute(output)
    require(temporary != "/")
    report = temporary + "/gateway-health-job-" + run + "-1.json"
    require(output.startswith(temporary + "/") and output != report)
    return {"repository": REPOSITORY, "ref": REF, "sourceCommit": sha, "runId": run,
            "runAttempt": "1", "jobKey": "gateway_build", "report": report, "output": output,
            "outcome": environment["SMOKE_OUTCOME"]}


def classify(raw, selected):
    require(type(raw) is bytes and 0 < len(raw) <= 8192)

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                       parse_constant=lambda _: require(False))
    require(type(value) is dict and set(value) == FIELDS and
            type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and
            value["kind"] == "gateway-current-job-health-diagnostic" and
            value["releaseAcceptance"] is False and
            all(value[key] == selected[key] for key in
                ("repository", "ref", "sourceCommit", "runId", "runAttempt", "jobKey")))
    require(value["result"] in ("passed", "failed") and value["phase"] in PHASES and
            value["reason"] in REASONS)
    require((value["result"] == "passed" and value["phase"] == "complete" and value["reason"] == "none") or
            (value["result"] == "failed" and value["reason"] != "none"))
    require(raw == (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii"))
    if value["result"] == "passed" and selected["outcome"] != "success":
        return {"result": "failed", "stage": "post-worker", "reason": "worker-failed-after-report"}
    return {"result": value["result"], "stage": value["phase"], "reason": value["reason"]}


def encode_outputs(result):
    require(type(result) is dict and set(result) == {"result", "stage", "reason"} and
            result["result"] in ("passed", "failed") and
            result["stage"] in PHASES | {"post-worker", "unavailable"} and
            result["reason"] in REASONS | {"worker-failed-after-report", "report-unavailable"})
    require((result["result"] == "passed" and result["stage"] == "complete" and result["reason"] == "none") or
            (result["result"] == "failed" and result["reason"] != "none"))
    return ("result=" + result["result"] + "\nstage=" + result["stage"] +
            "\nreason=" + result["reason"] + "\n").encode("ascii")


class OwnedReportFiles:
    def __init__(self, uid, system=os, realpath=os.path.realpath):
        require(type(uid) is int and uid > 0)
        self.uid, self.system, self.realpath = uid, system, realpath
        self.custody = {"descriptors": [], "unknown": [], "secondary": [], "parents": {}, "held": False}

    def sync(self, value):
        if inspect.isawaitable(value):
            self.custody["held"] = True
            self.custody["unknown"].append(value)
            require(False)
        return value

    def identity(self, row):
        return tuple(getattr(row, key) for key in ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode",
                     "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))

    def metadata(self, row, directory=False, private=False):
        for key in ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink", "st_size"):
            require(type(getattr(row, key)) is int and getattr(row, key) >= 0)
        require(0 < row.st_ino <= 2**53 - 1 and row.st_dev <= 2**53 - 1 and
                row.st_mode <= 0o177777 and row.st_uid in (0, self.uid) and not row.st_mode & 0o7022 and
                (stat.S_ISDIR(row.st_mode) if directory else stat.S_ISREG(row.st_mode)))
        require(row.st_nlink > 0 if directory else row.st_nlink == 1)
        if private:
            require(row.st_uid == self.uid and stat.S_IMODE(row.st_mode) == 0o600)
        return row

    def directory(self, path):
        absolute(path)
        for part in reversed((PurePosixPath(path), *PurePosixPath(path).parents)):
            name = str(part)
            row = self.metadata(self.sync(self.system.lstat(name)), True)
            require(self.sync(self.realpath(name)) == name)
            identity = self.identity(row)[:5]
            require(self.custody["parents"].setdefault(name, identity) == identity)

    def open(self, path, flags):
        lease = {"fd": None, "closed": False, "closeIssued": False}
        self.custody["descriptors"].append(lease)
        value = self.sync(self.system.open(path, flags))
        lease["returned"] = value
        require(type(value) is int and value >= 0)
        lease["fd"] = value
        return lease

    def finish(self, lease, primary):
        if lease is not None and lease["fd"] is not None and not self.custody["held"]:
            lease["closeIssued"] = True
            try:
                returned = self.sync(self.system.close(lease["fd"]))
                if returned is not None:
                    self.custody["unknown"].append(returned)
                    require(False)
                lease["closed"] = True
            except BaseException as error:
                self.custody["held"] = True
                if primary is None:
                    primary = error
                else:
                    self.custody["secondary"].append(error)
        if primary is not None:
            raise primary

    def read_report(self, path):
        require(not self.custody["held"])
        parent = str(PurePosixPath(path).parent)
        self.directory(parent)
        before = self.metadata(self.sync(self.system.lstat(path)), private=True)
        require(0 < before.st_size <= 8192)
        lease, primary, result = None, None, None
        try:
            lease = self.open(path, self.system.O_RDONLY | self.system.O_NOFOLLOW | self.system.O_NONBLOCK)
            require(self.identity(self.metadata(self.sync(self.system.fstat(lease["fd"])), private=True)) == self.identity(before))
            chunks, count = [], 0
            while True:
                chunk = self.sync(self.system.read(lease["fd"], 8193 - count))
                require(type(chunk) is bytes and len(chunk) <= 8193 - count)
                if not chunk:
                    break
                count += len(chunk); require(count <= 8192); chunks.append(chunk)
            require(count == before.st_size)
            after = self.metadata(self.sync(self.system.fstat(lease["fd"])), private=True)
            require(self.identity(after) == self.identity(before) ==
                    self.identity(self.metadata(self.sync(self.system.lstat(path)), private=True)))
            self.directory(parent)
            result = b"".join(chunks)
        except BaseException as error:
            primary = error
        self.finish(lease, primary)
        return result

    def append_outputs(self, path, data):
        require(not self.custody["held"] and type(data) is bytes and 0 < len(data) <= 512)
        parent = str(PurePosixPath(path).parent)
        self.directory(parent)
        before = self.metadata(self.sync(self.system.lstat(path)))
        lease, primary = None, None
        try:
            lease = self.open(path, self.system.O_WRONLY | self.system.O_APPEND |
                              self.system.O_NOFOLLOW | self.system.O_NONBLOCK)
            require(self.identity(self.metadata(self.sync(self.system.fstat(lease["fd"])))) == self.identity(before))
            written = 0
            while written < len(data):
                count = self.sync(self.system.write(lease["fd"], data[written:]))
                require(type(count) is int and 0 < count <= len(data) - written)
                written += count
            require(self.sync(self.system.fsync(lease["fd"])) is None)
            after = self.metadata(self.sync(self.system.fstat(lease["fd"])))
            require(self.identity(after)[:6] == self.identity(before)[:6] and
                    after.st_size == before.st_size + len(data) and
                    self.identity(self.metadata(self.sync(self.system.lstat(path)))) == self.identity(after))
            self.directory(parent)
        except BaseException as error:
            primary = error
        self.finish(lease, primary)


def main(environment=None, files=None, uid_provider=os.getuid):
    environment = os.environ if environment is None else environment
    try:
        uid = uid_provider()
        selected = context(environment, uid)
        files = OwnedReportFiles(uid) if files is None else files
        try:
            result = classify(files.read_report(selected["report"]), selected)
        except BaseException as error:
            RETAINED.append({"readbackError": error, "files": files})
            result = {"result": "failed", "stage": "unavailable", "reason": "report-unavailable"}
        files.append_outputs(selected["output"], encode_outputs(result))
        # This zero acknowledges the output append/fsync/close only. The passive
        # workflow test propagates result=failed; the original smoke exit remains.
        return 0
    except BaseException as error:
        RETAINED.append({"reportingError": error, "files": files})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
