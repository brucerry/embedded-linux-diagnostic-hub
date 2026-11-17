"""Reporter policy and fake descriptors only; no worker or real output file is used."""
import importlib.util
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest

_spec = importlib.util.spec_from_file_location("web_report_under_test", Path(__file__).parents[2] / "scripts/ci/report-web-baseline.py")
REPORT = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(REPORT)


def encoded(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPORT.REPOSITORY,
            "GITHUB_EVENT_NAME": "push", "GITHUB_REF": REPORT.REF, "GITHUB_JOB": "web_baseline",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "123", "GITHUB_SHA": "a" * 40,
            "GITHUB_WORKFLOW_SHA": "a" * 40,
            "GITHUB_WORKFLOW_REF": REPORT.REPOSITORY + "/.github/workflows/web-public-baseline.yml@" + REPORT.REF,
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "RUNNER_TEMP": "/memory/temporary", "GITHUB_OUTPUT": "/memory/temporary/github-output",
            "GITHUB_EVENT_PATH": "/memory/temporary/event.json", "WEB_WORKER_OUTCOME": "success"}


def positive(phase):
    if phase == "host":
        return {"schemaVersion": 1, "status": "passed", "stage": "complete", "reason": "none", "input": "none", "closure": "known-readonly-scope", "qualification": "host-metadata-only", "executed": False, "releaseAcceptance": False}
    if phase == "preparation":
        return {"schemaVersion": 1, "status": "prepared-inputs-not-runtime", "stage": "complete", "reason": "none", "input": "none", "packageCount": 26}
    return {"status": "passed", "stage": "complete", "closure": "known-direct-scope", "qualification": "public-baseline-only", "releaseAcceptance": False}


class MemoryOS:
    O_RDONLY, O_WRONLY, O_APPEND, O_NOFOLLOW, O_NONBLOCK = (getattr(os, name) for name in ("O_RDONLY", "O_WRONLY", "O_APPEND", "O_NOFOLLOW", "O_NONBLOCK"))

    def __init__(self):
        self.rows, self.bodies, self.fds, self.opens, self.closes, self.created = {}, {}, {}, [], [], []
        self.next_inode, self.next_fd = 1, 10
        self.read_failure = self.close_failure = self.fsync_failure = None
        for name in ("/", "/memory", "/memory/temporary"):
            self.add(name, None, 0o700)

    def add(self, name, body, mode=0o600):
        self.next_inode += 1
        self.rows[name] = dict(st_dev=1, st_ino=self.next_inode, st_uid=1000, st_gid=1000,
            st_mode=(stat.S_IFDIR if body is None else stat.S_IFREG) | mode,
            st_nlink=2 if body is None else 1, st_size=0 if body is None else len(body), st_mtime_ns=1, st_ctime_ns=1)
        if body is not None:
            self.bodies[name] = body

    def lstat(self, name):
        if name not in self.rows:
            raise FileNotFoundError(name)
        return SimpleNamespace(**self.rows[name])

    def mkdir(self, name, mode):
        if name in self.rows:
            raise FileExistsError(name)
        self.created.append((name, mode))
        self.add(name, None, mode)

    def open(self, name, flags):
        self.lstat(name)
        self.next_fd += 1
        self.fds[self.next_fd] = {"name": name, "offset": 0, "flags": flags}
        self.opens.append((name, flags))
        return self.next_fd

    def fstat(self, fd):
        return self.lstat(self.fds[fd]["name"])

    def read(self, fd, maximum):
        lease = self.fds[fd]
        if self.read_failure and lease["name"].endswith(".stdout"):
            raise self.read_failure
        offset, name = lease["offset"], lease["name"]
        value = self.bodies[name][offset:offset + min(maximum, 7)]
        lease["offset"] += len(value)
        return value

    def write(self, fd, data):
        name = self.fds[fd]["name"]
        count = min(5, len(data))
        self.bodies[name] += data[:count]
        self.rows[name]["st_size"] = len(self.bodies[name])
        self.rows[name]["st_mtime_ns"] += 1
        self.rows[name]["st_ctime_ns"] += 1
        return count

    def fsync(self, fd):
        self.fstat(fd)
        if self.fsync_failure and self.fds[fd]["name"].endswith("github-output"):
            raise self.fsync_failure

    def close(self, fd):
        self.closes.append(fd)
        if self.close_failure and self.fds[fd]["name"].endswith(".stdout"):
            raise self.close_failure
        del self.fds[fd]


def memory(phase="runtime", body=None, outcome="success", code=b"0\n"):
    env = environment()
    env["WEB_WORKER_OUTCOME"] = outcome
    native = MemoryOS()
    event = {"repository": {"full_name": REPORT.REPOSITORY, "private": False}, "ref": REPORT.REF, "after": "a" * 40, "deleted": False}
    # Actual service events need not use the compact worker-report encoding.
    native.add(env["GITHUB_EVENT_PATH"], json.dumps(event, indent=2).encode(), 0o600)
    native.add(env["GITHUB_OUTPUT"], b"")
    selected = REPORT.context(env, 1000, phase)
    if phase != "initialize":
        native.add(selected["directory"], None, 0o700)
        prefix = selected["directory"] + "/" + phase
        native.add(prefix + ".stdout", encoded(positive(phase)) if body is None else body)
        native.add(prefix + ".stderr", b"")
        native.add(prefix + ".exit-code", code)
    files = REPORT.WebReportFiles(1000, system=native, realpath=lambda name: name)
    return env, native, files, selected


class WebReportMemoryTests(unittest.TestCase):
    def test_each_phase_positive_model_is_only_finite_metadata(self):
        for phase in ("host", "preparation", "runtime"):
            result = REPORT.classify(encoded(positive(phase)), b"", b"0\n", phase, "success")
            self.assertEqual(result["result"], "passed")
            output = REPORT.encode_outputs(result)
            expected = {b"result", b"stage", b"closure", b"input"}
            if phase == "host":
                expected.add(b"reason")
                self.assertIn(b"reason=none\n", output)
            self.assertEqual(set(line.split(b"=", 1)[0] for line in output.splitlines()), expected)
            self.assertNotIn(b"releaseAcceptance", output)
            self.assertNotIn(b"runId", output)
            self.assertNotIn(b"authenticated", output)

    def test_worker_failure_cancellation_skip_or_nonzero_cannot_become_pass(self):
        for phase in ("host", "preparation", "runtime"):
            for outcome, code in (("failure", b"0\n"), ("cancelled", b"0\n"), ("skipped", b"0\n"), ("success", b"137\n")):
                result = REPORT.classify(encoded(positive(phase)), b"", code, phase, outcome)
                self.assertEqual(result["result"], "nonpassing")
                self.assertEqual(result["stage"], "post-worker")

    def test_missing_mixed_truncated_noncanonical_or_forged_report_is_refused(self):
        raw = encoded(positive("runtime"))
        for stdout, stderr, code in ((b"", b"", b"0\n"), (raw, raw, b"0\n"), (raw[:-1], b"", b"0\n"), (raw + raw, b"", b"0\n"), (b" " + raw, b"", b"0\n"), (raw, b"", b"00\n"), (raw, b"", b"256\n"), (b"x" * 8193, b"", b"0\n")):
            with self.assertRaises(Exception):
                REPORT.classify(stdout, stderr, code, "runtime", "success")
        changed = positive("runtime")
        changed["releaseAcceptance"] = True
        with self.assertRaises(Exception):
            REPORT.classify(encoded(changed), b"", b"0\n", "runtime", "success")

    def test_refusals_preserve_explicit_stage_input_and_closure(self):
        host = positive("host")
        host.update(status="nonpassing", stage="executable", reason="close", input="driver", closure="retained-unknown")
        result = REPORT.classify(b"", encoded(host), b"1\n", "host", "failure")
        self.assertEqual(result, {"result": "nonpassing", "stage": "executable", "closure": "retained-unknown", "input": "driver", "reason": "close"})
        prep = {"schemaVersion": 1, "status": "refused", "stage": "package-parse", "reason": "archive-policy", "input": "26"}
        self.assertEqual(REPORT.classify(b"", encoded(prep), b"1\n", "preparation", "failure")["input"], "26")
        runtime = positive("runtime")
        runtime.update(status="nonpassing", stage="owned-browser", closure="retained-unknown")
        self.assertEqual(REPORT.classify(encoded(runtime), b"", b"1\n", "runtime", "failure")["closure"], "retained-unknown")

    def test_host_reason_is_allowlisted_and_cannot_promote_a_rejection(self):
        for reason in REPORT.HOST_REASONS - {"none"}:
            host = positive("host")
            host.update(status="nonpassing", stage="parents", reason=reason, input="chrome")
            result = REPORT.classify(b"", encoded(host), b"1\n", "host", "failure")
            self.assertEqual(result["result"], "nonpassing")
            self.assertIn(("reason=" + reason + "\n").encode(), REPORT.encode_outputs(result))
            host.update(status="passed", stage="complete", input="none")
            with self.assertRaises(REPORT.ReportRefused):
                REPORT.classify(encoded(host), b"", b"0\n", "host", "success")
        host = positive("host")
        host.update(status="nonpassing", stage="parents", reason="unlisted-reason", input="driver")
        with self.assertRaises(REPORT.ReportRefused):
            REPORT.classify(b"", encoded(host), b"1\n", "host", "failure")

    def test_host_outcome_mismatch_and_unavailable_data_never_report_reason_none(self):
        result = REPORT.classify(encoded(positive("host")), b"", b"1\n", "host", "failure")
        self.assertEqual(result["reason"], "post-worker")
        self.assertEqual(result["result"], "nonpassing")
        for reason in ("none", "unlisted-reason"):
            with self.assertRaises(REPORT.ReportRefused):
                REPORT.encode_outputs(dict(result, reason=reason))
        env, native, files, _ = memory("host", body=b"ordinary invalid fixture")
        self.assertEqual(REPORT.main(["--phase", "host"], env, files, lambda: 1000, lambda: 1000), 0)
        output = native.bodies[env["GITHUB_OUTPUT"]]
        self.assertIn(b"reason=unavailable\n", output)
        self.assertIn(b"result=nonpassing\n", output)
        self.assertNotIn(b"ordinary", output)

    def test_initialization_is_one_fresh_private_namespace_without_output_claim(self):
        env, native, files, selected = memory("initialize")
        self.assertEqual(REPORT.main(["--phase", "initialize"], env, files, lambda: 1000, lambda: 1000), 0)
        self.assertEqual(native.created, [(selected["directory"], 0o700)])
        self.assertEqual(native.bodies[env["GITHUB_OUTPUT"]], b"")
        self.assertEqual(REPORT.main(["--phase", "initialize"], env, files, lambda: 1000, lambda: 1000), 1)
        self.assertEqual(len(native.created), 1)

    def test_real_reader_append_guard_uses_only_fake_nofollow_descriptors(self):
        env, native, files, _ = memory()
        self.assertEqual(REPORT.main(["--phase", "runtime"], env, files, lambda: 1000, lambda: 1000), 0)
        self.assertIn(b"result=passed\n", native.bodies[env["GITHUB_OUTPUT"]])
        self.assertFalse(native.fds)
        self.assertTrue(all(flags & os.O_NOFOLLOW for _, flags in native.opens))
        self.assertTrue(any(flags & os.O_APPEND for _, flags in native.opens))

    def test_malformed_report_is_unavailable_but_never_echoes_private_bytes(self):
        env, native, files, _ = memory(body=b"private path /memory/secret and raw error\n")
        self.assertEqual(REPORT.main(["--phase", "runtime"], env, files, lambda: 1000, lambda: 1000), 0)
        output = native.bodies[env["GITHUB_OUTPUT"]]
        self.assertIn(b"result=nonpassing\n", output)
        self.assertIn(b"stage=unavailable\n", output)
        self.assertNotIn(b"private", output)

    def test_read_close_uncertainty_prevents_output_and_preserves_primary_failure(self):
        env, native, files, _ = memory()
        primary, secondary = OSError("memory primary read"), OSError("memory unresolved close")
        native.read_failure, native.close_failure = primary, secondary
        self.assertEqual(REPORT.main(["--phase", "runtime"], env, files, lambda: 1000, lambda: 1000), 1)
        self.assertEqual(native.bodies[env["GITHUB_OUTPUT"]], b"")
        self.assertTrue(files.custody["held"])
        self.assertIn(secondary, files.custody["secondary"])
        self.assertEqual(sum(name.endswith(".stdout") for name, _ in native.opens), 1)
        self.assertEqual(len(native.fds), 1)

    def test_wrong_context_or_public_event_never_creates_or_publishes(self):
        for change in ("ref", "workflow", "private", "deleted", "euid"):
            env, native, files, selected = memory("initialize")
            if change == "ref": env["GITHUB_REF"] = "refs/heads/main"
            if change == "workflow": env["GITHUB_WORKFLOW_SHA"] = "b" * 40
            if change in ("private", "deleted"):
                event = json.loads(native.bodies[env["GITHUB_EVENT_PATH"]])
                if change == "private": event["repository"]["private"] = True
                else: event["deleted"] = True
                native.bodies[env["GITHUB_EVENT_PATH"]] = encoded(event)
                native.rows[env["GITHUB_EVENT_PATH"]]["st_size"] = len(encoded(event))
            self.assertEqual(REPORT.main(["--phase", "initialize"], env, files, lambda: 1000, lambda: 0 if change == "euid" else 1000), 1)
            self.assertNotIn(selected["directory"], native.rows)
            self.assertEqual(native.bodies[env["GITHUB_OUTPUT"]], b"")

    def test_unsafe_parent_is_rejected_before_capture_namespace_creation(self):
        for change in ("mode", "symlink", "owner"):
            env, native, files, selected = memory("initialize")
            parent = native.rows[env["RUNNER_TEMP"]]
            if change == "mode": parent["st_mode"] = stat.S_IFDIR | 0o777
            if change == "symlink": parent["st_mode"] = stat.S_IFLNK | 0o777
            if change == "owner": parent["st_uid"] = 1001
            self.assertEqual(REPORT.main(["--phase", "initialize"], env, files, lambda: 1000, lambda: 1000), 1)
            self.assertFalse(native.created)
            self.assertFalse(native.opens)
            self.assertNotIn(selected["directory"], native.rows)

    def test_output_bytes_never_override_failed_append_acknowledgment(self):
        env, native, files, _ = memory()
        native.fsync_failure = OSError("memory output acknowledgment failure")
        self.assertEqual(REPORT.main(["--phase", "runtime"], env, files, lambda: 1000, lambda: 1000), 1)
        self.assertIn(b"result=passed\n", native.bodies[env["GITHUB_OUTPUT"]])
        # The workflow must require reporter outcome success too. A field written
        # before fsync/close acknowledgment is never an independent pass receipt.
        self.assertFalse(native.fds)


if __name__ == "__main__":
    unittest.main()
