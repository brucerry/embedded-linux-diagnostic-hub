"""Offline workflow text contracts and passive reporter memory controls only.

The workflow text checks are not a GitHub execution or a full YAML parser. No
publisher acquisition, worker, Node binary, package, network or child is run.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/ci" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load("report-gateway-health-job.py", "gateway_health_report")
P = load("prepare-gateway-health-job.py", "gateway_health_preparation")
WORKFLOW = (ROOT / ".github/workflows/gateway-same-job-health-smoke.yml").read_text()
OLD_WORKFLOW = (ROOT / ".github/workflows/gateway-publisher-node-buildonly.yml").read_text()


def environment():
    sha = "a" * 40
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": R.REPOSITORY, "GITHUB_REF": R.REF,
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "gateway_build", "GITHUB_EVENT_NAME": "push",
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "GITHUB_SHA": sha, "GITHUB_RUN_ID": "123", "GITHUB_WORKFLOW_SHA": sha,
            "GITHUB_WORKFLOW_REF": R.REPOSITORY + "/.github/workflows/gateway-same-job-health-smoke.yml@" + R.REF,
            "SMOKE_OUTCOME": "success", "RUNNER_TEMP": "/private/job",
            "GITHUB_OUTPUT": "/private/job/_runner_file_commands/set_output_fixture"}


def record():
    e = environment()
    return {"schemaVersion": 1, "kind": "gateway-current-job-health-diagnostic", "repository": R.REPOSITORY,
            "ref": R.REF, "sourceCommit": e["GITHUB_SHA"], "runId": e["GITHUB_RUN_ID"], "runAttempt": "1",
            "jobKey": "gateway_build", "result": "passed", "phase": "complete", "reason": "none",
            "releaseAcceptance": False}


def encoded(value):
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


class Awaitable:
    def __await__(self):
        raise AssertionError("Unsupported IO result must remain unexecuted")


class MemoryFiles:
    def __init__(self, raw=None):
        self.raw = encoded(record()) if raw is None else raw
        self.output, self.reads, self.appends = [], [], []
        self.read_error, self.append_error = None, None

    def read_report(self, path):
        self.reads.append(path)
        if self.read_error:
            raise self.read_error
        return self.raw

    def append_outputs(self, path, data):
        self.appends.append(path)
        if self.append_error:
            raise self.append_error
        self.output.append(data)


class MemoryOS:
    O_RDONLY, O_WRONLY, O_APPEND = os.O_RDONLY, os.O_WRONLY, os.O_APPEND
    O_NOFOLLOW, O_NONBLOCK = os.O_NOFOLLOW, os.O_NONBLOCK

    def __init__(self):
        selected = R.context(environment(), 1001)
        self.report, self.output = selected["report"], selected["output"]
        self.nodes, self.fds, self.events, self.nextfd = {}, {}, [], 10
        self.read_error, self.close_error, self.write_return = None, None, None
        self.stat_change = lambda row, _path: row
        self.add(self.report, encoded(record()))
        self.add(self.output, b"")
        for file in (self.report, self.output):
            for p in Path(file).parents:
                if str(p) not in self.nodes:
                    self.nodes[str(p)] = self.row(len(self.nodes) + 1, stat.S_IFDIR | 0o700, b"")

    def row(self, ino, mode, data):
        return SimpleNamespace(st_dev=1, st_ino=ino, st_uid=1001, st_gid=1001, st_mode=mode,
            st_nlink=2 if stat.S_ISDIR(mode) else 1, st_size=len(data), st_mtime_ns=1, st_ctime_ns=1,
            data=bytearray(data))

    def add(self, path, data):
        self.nodes[path] = self.row(len(self.nodes) + 1, stat.S_IFREG | 0o600, data)

    def lstat(self, path):
        self.events.append(("lstat", path))
        return self.stat_change(SimpleNamespace(**vars(self.nodes[path])), path)

    def open(self, path, flags):
        self.events.append(("open", path, flags))
        assert flags & self.O_NOFOLLOW and flags & self.O_NONBLOCK
        fd = self.nextfd; self.nextfd += 1
        self.fds[fd] = {"path": path, "position": 0}
        return fd

    def fstat(self, fd):
        path = self.fds[fd]["path"]
        return self.stat_change(SimpleNamespace(**vars(self.nodes[path])), path)

    def read(self, fd, maximum):
        self.events.append(("read", fd, maximum))
        if self.read_error:
            raise self.read_error
        value = self.fds[fd]; row = self.nodes[value["path"]]
        data = bytes(row.data[value["position"]:value["position"] + maximum])
        value["position"] += len(data)
        return data

    def write(self, fd, data):
        self.events.append(("write", fd, len(data)))
        if self.write_return is not None:
            return self.write_return
        row = self.nodes[self.fds[fd]["path"]]
        count = min(3, len(data))
        row.data.extend(data[:count]); row.st_size = len(row.data)
        row.st_mtime_ns += 1; row.st_ctime_ns += 1
        return count

    def fsync(self, fd):
        self.events.append(("fsync", fd))

    def close(self, fd):
        self.events.append(("close", fd))
        if self.close_error:
            raise self.close_error
        del self.fds[fd]

    def files(self):
        return R.OwnedReportFiles(1001, system=self, realpath=lambda path: path)


class GatewayHealthWorkflowMemory(unittest.TestCase):
    def test_preparation_calls_only_existing_provider_and_collector(self):
        calls = []
        provider = object()
        fake = SimpleNamespace(acquire_node=provider, COMMON=SimpleNamespace(
            collect_diagnostic=lambda **kwargs: calls.append(kwargs) or 0))
        self.assertEqual(P.entry(fake), 0)
        self.assertEqual(calls, [{"node_provider": provider, "expected_branch": R.BRANCH}])
        self.assertEqual(P.P.BRANCH, "ci/v060-gateway-publisher-node-buildonly-20261116")

    def test_workflow_is_one_exact_read_only_standard_hosted_job(self):
        self.assertIn("branches: [" + R.BRANCH + "]", WORKFLOW)
        self.assertEqual(WORKFLOW.count("runs-on:"), 1)
        self.assertIn("runs-on: ubuntu-24.04", WORKFLOW)
        self.assertIn("timeout-minutes: 20", WORKFLOW)
        self.assertIn("contents: read", WORKFLOW)
        for value in ["workflow_dispatch:", "workflow_call:", "pull_request:", "schedule:",
                      "continue-on-error:", "contents: write", "id-token:", "upload-artifact", "setup-node", "npm ci"]:
            self.assertNotIn(value, WORKFLOW)
        self.assertEqual(WORKFLOW.count("uses:"), 1)
        self.assertIn("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", WORKFLOW)
        for line in ["persist-credentials: false", "fetch-depth: 1", "clean: false",
                     "set-safe-directory: false", "submodules: false", "lfs: false"]:
            self.assertIn(line, WORKFLOW)

    def test_startup_controls_and_original_worker_exit_are_preserved(self):
        self.assertEqual(WORKFLOW.split("env:\n", 1)[1].split("\njobs:", 1)[0],
                         OLD_WORKFLOW.split("env:\n", 1)[1].split("\njobs:", 1)[0])
        self.assertIn("shell: /usr/bin/bash --noprofile --norc -euo pipefail {0}", WORKFLOW)
        self.assertEqual(WORKFLOW.count("/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u ESBUILD_BINARY_PATH"), 2)
        self.assertNotIn("\n                  env -u", WORKFLOW)
        self.assertEqual(WORKFLOW.count("scripts/observe-gateway-health-job.mjs --qualify-branch"), 1)
        self.assertNotIn("scripts/build-gateway-tag-archive.mjs", WORKFLOW)
        self.assertIn("SMOKE_OUTCOME: ${{ steps.smoke.outcome }}", WORKFLOW)
        self.assertIn("steps.health_report.outcome == 'success' && steps.health_report.outputs.result", " ".join(WORKFLOW.split()))
        self.assertIn('run: test "$HEALTH_RESULT" = passed', WORKFLOW)
        self.assertNotIn("|| true", WORKFLOW)

    def test_inert_import_check_is_prepared_and_precedes_the_single_worker(self):
        preparation = WORKFLOW.index('run: test "$PREPARATION_RESULT" = prepared')
        imported = WORKFLOW.index("- name: Check inert health entry imports before the worker")
        worker = WORKFLOW.index("- name: Produce once and exercise the same-job verified package health")
        self.assertLess(preparation, imported)
        self.assertLess(imported, worker)
        block = " ".join(WORKFLOW[imported:worker].split())
        self.assertIn("success() && steps.preparation.outcome == 'success' && steps.preparation.outputs.result == 'prepared'", block)
        self.assertIn("/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u ESBUILD_BINARY_PATH", block)
        self.assertIn('"$RUNNER_TEMP/gateway-publisher-node-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/bin/node"', block)
        self.assertEqual(WORKFLOW.count("scripts/check-gateway-health-entry.mjs"), 1)
        self.assertEqual(WORKFLOW.count("scripts/observe-gateway-health-job.mjs --qualify-branch"), 1)
        self.assertNotIn("scripts/build-gateway-tag-archive.mjs", WORKFLOW)

    def test_exact_context_and_report_filename(self):
        selected = R.context(environment(), 1001)
        self.assertEqual(selected["report"], "/private/job/gateway-health-job-123-1.json")
        for key, value in [("GITHUB_REF", "refs/heads/other"), ("GITHUB_RUN_ATTEMPT", "2"),
                           ("GITHUB_WORKFLOW_SHA", "b" * 40), ("GITHUB_JOB", "other"),
                           ("SMOKE_OUTCOME", "unknown"), ("GITHUB_OUTPUT", "/outside/output")]:
            with self.subTest(key=key), self.assertRaises(R.ReportRefused):
                R.context({**environment(), key: value}, 1001)

    def test_pass_requires_report_tuple_and_successful_worker(self):
        selected = R.context(environment(), 1001)
        self.assertEqual(R.classify(encoded(record()), selected),
                         {"result": "passed", "stage": "complete", "reason": "none"})
        for outcome in ["failure", "cancelled", "skipped"]:
            selected = R.context({**environment(), "SMOKE_OUTCOME": outcome}, 1001)
            self.assertEqual(R.classify(encoded(record()), selected),
                             {"result": "failed", "stage": "post-worker", "reason": "worker-failed-after-report"})

    def test_failure_phase_preserved_without_guessing_cause(self):
        for phase in R.PHASES:
            row = {**record(), "result": "failed", "phase": phase, "reason": "custody-held"}
            self.assertEqual(R.classify(encoded(row), R.context(environment(), 1001)),
                             {"result": "failed", "stage": phase, "reason": "custody-held"})

    def test_invalid_reports_never_become_success(self):
        variants = [
            {**record(), "extra": "not-allowed"}, {**record(), "schemaVersion": True},
            {**record(), "sourceCommit": "b" * 40}, {**record(), "runId": "other"},
            {**record(), "releaseAcceptance": True}, {**record(), "phase": "unrecognized"},
            {**record(), "phase": "post-worker"}, {**record(), "reason": "worker-failed-after-report"},
            {**record(), "result": "passed", "phase": "health"},
        ]
        for value in variants:
            with self.subTest(value=value), self.assertRaises((R.ReportRefused, ValueError)):
                R.classify(encoded(value), R.context(environment(), 1001))

    def test_duplicate_noncanonical_and_oversized_json_refused(self):
        raw = encoded(record())
        for value in [raw.replace(b'"schemaVersion":1', b'"schemaVersion":1,"schemaVersion":1'),
                      b" " + raw, raw + b" ", b"x" * 8193]:
            with self.subTest(length=len(value)), self.assertRaises((R.ReportRefused, ValueError)):
                R.classify(value, R.context(environment(), 1001))

    def test_missing_or_invalid_report_produces_only_unavailable(self):
        for failure in [FileNotFoundError("private fixture path"), None]:
            files = MemoryFiles(b"invalid")
            files.read_error = failure
            self.assertEqual(R.main(environment(), files, lambda: 1001), 0)
            self.assertEqual(files.output, [b"result=failed\nstage=unavailable\nreason=report-unavailable\n"])

    def test_authored_absent_unsafe_and_malformed_reports_share_only_unavailable(self):
        for variant in ["absent", "unsafe-mode", "malformed", "mismatched-source"]:
            system = MemoryOS()
            if variant == "absent":
                original = system.lstat
                def missing(path):
                    if path == system.report:
                        raise FileNotFoundError("Private inert missing-report detail.")
                    return original(path)
                system.lstat = missing
            elif variant == "unsafe-mode":
                system.nodes[system.report].st_mode = stat.S_IFREG | 0o644
            else:
                data = b'{"inert-malformed":' if variant == "malformed" else encoded({**record(), "sourceCommit": "b" * 40})
                system.nodes[system.report].data = bytearray(data)
                system.nodes[system.report].st_size = len(data)
            with self.subTest(variant=variant):
                self.assertEqual(R.main(environment(), system.files(), lambda: 1001), 0)
                self.assertEqual(bytes(system.nodes[system.output].data),
                                 b"result=failed\nstage=unavailable\nreason=report-unavailable\n")

    def test_post_worker_failure_cannot_be_masked_by_passed_record(self):
        files = MemoryFiles()
        self.assertEqual(R.main({**environment(), "SMOKE_OUTCOME": "failure"}, files, lambda: 1001), 0)
        self.assertEqual(files.output, [b"result=failed\nstage=post-worker\nreason=worker-failed-after-report\n"])

    def test_invalid_context_or_append_failure_is_not_acknowledged(self):
        files = MemoryFiles()
        self.assertEqual(R.main({**environment(), "GITHUB_REF": "other"}, files, lambda: 1001), 1)
        self.assertFalse(files.reads or files.appends)
        files = MemoryFiles(); files.append_error = OSError("private fixture error")
        self.assertEqual(R.main(environment(), files, lambda: 1001), 1)
        self.assertFalse(files.output)

    def test_owned_read_and_append_flags_identity_partial_write_fsync_close(self):
        system = MemoryOS(); files = system.files()
        self.assertEqual(R.main(environment(), files, lambda: 1001), 0)
        self.assertEqual(bytes(system.nodes[system.output].data), b"result=passed\nstage=complete\nreason=none\n")
        self.assertFalse(system.fds)
        opens = [row for row in system.events if row[0] == "open"]
        self.assertEqual(opens[0][2], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        self.assertEqual(opens[1][2], os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK)
        self.assertEqual(len([row for row in system.events if row[0] == "fsync"]), 1)
        self.assertEqual(len([row for row in system.events if row[0] == "close"]), 2)

    def test_private_report_owner_mode_and_identity_cannot_be_substituted(self):
        for key, value in [("st_uid", 0), ("st_mode", stat.S_IFREG | 0o644), ("st_nlink", 2), ("st_ino", 0)]:
            system = MemoryOS(); setattr(system.nodes[system.report], key, value)
            with self.subTest(key=key), self.assertRaises(R.ReportRefused):
                system.files().read_report(system.report)
            self.assertFalse(system.fds)

    def test_parent_refusal_prevents_traversal_to_private_report(self):
        system = MemoryOS(); system.nodes["/private"].st_mode = stat.S_IFDIR | 0o777
        with self.assertRaises(R.ReportRefused): system.files().read_report(system.report)
        self.assertFalse(any(row[0] == "open" or (row[0] == "lstat" and row[1] == system.report) for row in system.events))

    def test_read_and_close_failure_keep_first_error_and_block_append(self):
        system = MemoryOS(); files = system.files()
        first, second = OSError("private read fixture"), OSError("private close fixture")
        system.read_error, system.close_error = first, second
        with self.assertRaises(OSError) as failure: files.read_report(system.report)
        self.assertIs(failure.exception, first)
        self.assertIn(second, files.custody["secondary"])
        self.assertTrue(files.custody["held"])
        with self.assertRaises(R.ReportRefused): files.append_outputs(system.output, b"result=failed\n")

    def test_unknown_read_return_retains_borrowed_descriptor(self):
        system = MemoryOS(); files = system.files(); unknown = Awaitable()
        system.read = lambda *_args: unknown
        with self.assertRaises(R.ReportRefused): files.read_report(system.report)
        self.assertIn(unknown, files.custody["unknown"])
        self.assertTrue(system.fds)
        self.assertFalse(any(row[0] == "close" for row in system.events))

    def test_output_partial_or_close_failure_cannot_acknowledge_outputs(self):
        for fail in ["zero", "close"]:
            system = MemoryOS(); files = system.files()
            if fail == "zero": system.write_return = 0
            else:
                original = system.close
                def close(fd):
                    if system.fds[fd]["path"] == system.output: raise OSError("inert close fixture")
                    return original(fd)
                system.close = close
            with self.subTest(fail=fail):
                self.assertEqual(R.main(environment(), files, lambda: 1001), 1)

    def test_output_identity_mutation_is_not_acknowledged(self):
        system = MemoryOS(); files = system.files(); original = system.fsync
        def changed(fd):
            original(fd); system.nodes[system.output].st_ino += 100
        system.fsync = changed
        self.assertEqual(R.main(environment(), files, lambda: 1001), 1)

    def test_no_arbitrary_output_classification_or_newline_injection(self):
        for value in [{"result": "passed", "stage": "health", "reason": "none"},
                      {"result": "failed", "stage": "unavailable", "reason": "unknown\nresult=passed"}]:
            with self.subTest(value=value), self.assertRaises(R.ReportRefused): R.encode_outputs(value)


if __name__ == "__main__":
    def closed(*_args, **_kwargs):
        raise AssertionError("Native allocation is closed in health workflow/report memory controls")
    with mock.patch("builtins.open", closed), mock.patch.object(socket, "socket", closed), \
         mock.patch.object(socket, "create_connection", closed), mock.patch.object(subprocess, "Popen", closed), \
         mock.patch.object(os, "open", closed), mock.patch.object(os, "mkdir", closed), \
         mock.patch.object(os, "write", closed), mock.patch.object(os, "fsync", closed), \
         mock.patch.object(os, "unlink", closed), mock.patch.object(os, "remove", closed), \
         mock.patch.object(os, "rmdir", closed):
        unittest.main()
