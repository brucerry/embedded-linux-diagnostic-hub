"""Passive finite metadata for completed Web workers; never a qualification receipt.

No subprocess, browser, download, retry or cleanup. Initialization creates only one
new guarded private capture directory. Worker exit/outcome is never overwritten.
"""

import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

_spec = importlib.util.spec_from_file_location("web_report_files", Path(__file__).with_name("report-gateway-health-job.py"))
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
OwnedReportFiles = _files.OwnedReportFiles

REPOSITORY = "brucerry/embedded-linux-diagnostic-hub"
REF = "refs/heads/ci/v060-web-sandbox-reasons-20261117"
PHASES = frozenset(("host", "preparation", "runtime"))
HOST_STAGES = frozenset(("admission", "parents", "executable", "complete"))
HOST_REASONS = frozenset(("none", "admission", "type", "owner", "mode", "inode", "link-count", "file-size", "file-identity", "elf", "read", "close", "clock", "deadline", "missing", "access-denied", "filesystem", "output", "unexpected"))
PREP_STAGES = frozenset(("admission", "source", "node-fetch", "node-parse", "node-materialization", "package-fetch", "package-parse", "package-materialization", "readback", "complete"))
PREP_REASONS = frozenset(("none", "admission", "source-integrity", "profile", "closure", "archive-integrity", "archive-policy", "manifest", "aggregate-bounds", "deadline", "filesystem", "network", "publisher-input", "output", "unexpected"))
RUNTIME_STAGES = frozenset(("admission", "node-input", "host-metadata", "source-binding", "fixture", "archive-build", "host-recheck", "owned-browser", "complete"))
CLOSURES = frozenset(("known-readonly-scope", "not-runtime", "known-direct-scope", "retained-unknown", "unavailable"))
INPUTS = frozenset(("none", "chrome", "driver", *map(str, range(1, 27))))
RETAINED = []


class ReportRefused(ValueError):
    pass


def require(value):
    if not value:
        raise ReportRefused("Web worker metadata unavailable")


def json_object(raw, maximum=8192, exact=False):
    require(type(raw) is bytes and 0 < len(raw) <= maximum)

    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value)
            value[key] = item
        return value

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=lambda _: require(False))
    require(type(value) is dict)
    if exact:
        require(raw == (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii"))
    return value


def canonical(raw, maximum=8192):
    return json_object(raw, maximum, exact=True)


def context(environment, uid, phase):
    require(type(uid) is int and uid > 0 and phase in PHASES | {"initialize"})
    fixed = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_EVENT_NAME": "push", "GITHUB_REF": REF, "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "web_baseline", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64"}
    require(all(environment.get(key) == value for key, value in fixed.items()))
    sha, run = environment.get("GITHUB_SHA"), environment.get("GITHUB_RUN_ID")
    require(type(sha) is str and re.fullmatch(r"[a-f0-9]{40}", sha) and type(run) is str and re.fullmatch(r"[1-9][0-9]{0,19}", run))
    require(environment.get("GITHUB_WORKFLOW_SHA") == sha and environment.get("GITHUB_WORKFLOW_REF") == REPOSITORY + "/.github/workflows/web-public-baseline.yml@" + REF)
    temporary, output, event = (environment.get(name) for name in ("RUNNER_TEMP", "GITHUB_OUTPUT", "GITHUB_EVENT_PATH"))
    for name in (temporary, output, event):
        _files.absolute(name)
    require(temporary != "/" and output.startswith(temporary + "/") and event.startswith(temporary + "/"))
    directory = temporary + "/web-baseline-reports-" + run + "-1"
    require(not output.startswith(directory + "/") and output != directory and not event.startswith(directory + "/"))
    outcome = environment.get("WEB_WORKER_OUTCOME")
    if phase != "initialize":
        require(outcome in ("success", "failure", "cancelled", "skipped"))
    return {"phase": phase, "directory": directory, "output": output, "event": event,
            "sourceCommit": sha, "outcome": outcome}


def classify(stdout, stderr, exit_bytes, phase, outcome):
    require(phase in PHASES and outcome in ("success", "failure", "cancelled", "skipped"))
    require(type(stdout) is bytes and type(stderr) is bytes and len(stdout) <= 8192 and len(stderr) <= 8192)
    require(type(exit_bytes) is bytes and re.fullmatch(rb"(?:0|[1-9][0-9]{0,2})\n", exit_bytes))
    code = int(exit_bytes)
    require(code <= 255)
    require(bool(stdout) != bool(stderr))  # No mixed, missing, partial or competing report streams.
    value = canonical(stdout or stderr)
    if phase == "host":
        require(set(value) == {"schemaVersion", "status", "stage", "reason", "input", "closure", "qualification", "executed", "releaseAcceptance"})
        require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["qualification"] == "host-metadata-only" and value["executed"] is False and value["releaseAcceptance"] is False)
        require(value["status"] in ("passed", "nonpassing") and value["stage"] in HOST_STAGES and value["reason"] in HOST_REASONS and value["input"] in ("none", "chrome", "driver") and value["closure"] in ("known-readonly-scope", "retained-unknown"))
        passed = value["status"] == "passed"
        require((passed and stdout and value["stage"] == "complete" and value["reason"] == "none" and value["input"] == "none" and value["closure"] == "known-readonly-scope") or
                (not passed and stderr and value["reason"] != "none"))
        result = {"result": "passed" if passed else "nonpassing", "stage": value["stage"], "closure": value["closure"], "input": value["input"], "reason": value["reason"]}
    elif phase == "preparation":
        passed = value.get("status") == "prepared-inputs-not-runtime"
        if passed:
            require(set(value) == {"schemaVersion", "status", "stage", "reason", "input", "packageCount"} and stdout and type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["stage"] == "complete" and value["reason"] == "none" and value["input"] == "none" and type(value["packageCount"]) is int and value["packageCount"] == 26)
        else:
            require(set(value) == {"schemaVersion", "status", "stage", "reason", "input"} and stderr and type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and value["status"] == "refused" and value["stage"] in PREP_STAGES and value["reason"] in PREP_REASONS - {"none"} and value["input"] in {"none", *map(str, range(1, 27))})
        result = {"result": "passed" if passed else "nonpassing", "stage": value["stage"], "closure": "not-runtime" if passed else "retained-unknown", "input": value["input"]}
    else:
        require(set(value) == {"status", "stage", "closure", "qualification", "releaseAcceptance"} and stdout and value["qualification"] == "public-baseline-only" and value["releaseAcceptance"] is False)
        require(value["status"] in ("passed", "nonpassing") and value["stage"] in RUNTIME_STAGES and value["closure"] in ("known-direct-scope", "retained-unknown"))
        passed = value["status"] == "passed"
        require(not passed or (value["stage"] == "complete" and value["closure"] == "known-direct-scope"))
        result = {"result": "passed" if passed else "nonpassing", "stage": value["stage"], "closure": value["closure"], "input": "none"}
    if outcome != "success" or code != 0:
        result["result"] = "nonpassing"
        if passed:
            result["stage"] = "post-worker"
            if phase == "host":
                result["reason"] = "post-worker"
    return result


def encode_outputs(value):
    fields = {"result", "stage", "closure", "input"}
    require(type(value) is dict and set(value) in (fields, fields | {"reason"}))
    require(value["result"] in ("passed", "nonpassing") and value["stage"] in HOST_STAGES | PREP_STAGES | RUNTIME_STAGES | {"post-worker", "unavailable"} and value["closure"] in CLOSURES and value["input"] in INPUTS)
    require(value["result"] != "passed" or (value["stage"] == "complete" and value["closure"] in ("known-readonly-scope", "not-runtime", "known-direct-scope") and value["input"] == "none"))
    reason = ""
    if "reason" in value:
        require(value["reason"] in HOST_REASONS | {"post-worker", "unavailable"})
        require((value["result"] == "passed") == (value["reason"] == "none"))
        reason = "reason=" + value["reason"] + "\n"
    return ("result=" + value["result"] + "\nstage=" + value["stage"] + "\nclosure=" + value["closure"] + "\ninput=" + value["input"] + "\n" + reason).encode("ascii")


class WebReportFiles(OwnedReportFiles):
    def read_capture(self, path, maximum=8192, private=True):
        require(not self.custody["held"] and type(maximum) is int and 0 < maximum <= 4 * 1024**2)
        parent = str(PurePosixPath(path).parent)
        self.directory(parent)
        before = self.metadata(self.sync(self.system.lstat(path)), private=private)
        require(0 <= before.st_size <= maximum)
        lease, primary, result = None, None, None
        try:
            lease = self.open(path, self.system.O_RDONLY | self.system.O_NOFOLLOW | self.system.O_NONBLOCK)
            require(self.identity(self.metadata(self.sync(self.system.fstat(lease["fd"])), private=private)) == self.identity(before))
            chunks, count = [], 0
            while True:
                body = self.sync(self.system.read(lease["fd"], maximum + 1 - count))
                require(type(body) is bytes and len(body) <= maximum + 1 - count)
                if not body:
                    break
                count += len(body); require(count <= maximum); chunks.append(body)
            require(count == before.st_size)
            after = self.metadata(self.sync(self.system.fstat(lease["fd"])), private=private)
            require(self.identity(after) == self.identity(before) == self.identity(self.metadata(self.sync(self.system.lstat(path)), private=private)))
            self.directory(parent)
            result = b"".join(chunks)
        except BaseException as error:
            primary = error
        self.finish(lease, primary)
        return result

    def report_directory(self, directory):
        self.directory(directory)
        row = self.metadata(self.sync(self.system.lstat(directory)), directory=True)
        require(row.st_uid == self.uid and stat.S_IMODE(row.st_mode) == 0o700)

    def initialize(self, directory):
        self.directory(str(PurePosixPath(directory).parent))
        lease = {"directory": directory, "issued": True, "acknowledged": False}
        RETAINED.append(lease)
        returned = self.sync(self.system.mkdir(directory, 0o700))  # Exclusive; EEXIST is refusal, never adoption.
        if returned is not None:
            self.custody["unknown"].append(returned); self.custody["held"] = True
            require(False)
        lease["acknowledged"] = True
        self.report_directory(directory)


def main(args=None, environment=None, files=None, uid_provider=os.getuid, euid_provider=os.geteuid):
    args = sys.argv[1:] if args is None else args
    environment = os.environ if environment is None else environment
    try:
        require(type(args) is list and len(args) == 2 and args[0] == "--phase")
        uid = uid_provider()
        require(uid == euid_provider())
        selected = context(environment, uid, args[1])
        files = WebReportFiles(uid) if files is None else files
        event = json_object(files.read_capture(selected["event"], 4 * 1024**2, private=False), 4 * 1024**2)
        require(event.get("repository", {}).get("full_name") == REPOSITORY and event.get("repository", {}).get("private") is False and event.get("ref") == REF and event.get("after") == selected["sourceCommit"] and event.get("deleted") is False)
        if selected["phase"] == "initialize":
            files.initialize(selected["directory"])
            return 0  # New capture namespace only; no GITHUB_OUTPUT append or pass claim.
        files.report_directory(selected["directory"])
        try:
            prefix = selected["directory"] + "/" + selected["phase"]
            result = classify(files.read_capture(prefix + ".stdout"), files.read_capture(prefix + ".stderr"), files.read_capture(prefix + ".exit-code", 4), selected["phase"], selected["outcome"])
        except BaseException as error:
            RETAINED.append({"readbackError": error, "files": files})
            result = {"result": "nonpassing", "stage": "unavailable", "closure": "unavailable", "input": "none"}
            if selected["phase"] == "host":
                result["reason"] = "unavailable"
        files.append_outputs(selected["output"], encode_outputs(result))
        return 0  # Append/fsync/close acknowledgment only; workflow also requires worker success.
    except BaseException as error:
        RETAINED.append({"reportingError": error, "files": files})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
