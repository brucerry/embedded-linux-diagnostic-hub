"""Literal memory-only cohort. No real preparer, cache, process or network effects.

Synthetic ports validate control flow and diagnostics, never installation or CI evidence.
The only repository reads load this module's source and the existing profile/lock/workflow.
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
import zlib


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "gateway_preparation_memory_subject", ROOT / "scripts/ci/prepare-gateway-four-tools.py")
SUBJECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBJECT)
PROFILE = json.loads((ROOT / "scripts/ci/gateway-four-tool-inputs.json").read_bytes())
LOCK = (ROOT / "package-lock.json").read_bytes()
WORKFLOW = (ROOT / ".github/workflows/gateway-native-source-buildonly.yml").read_text()
MARKER = "PRIVATE_FIXTURE_MARKER"


class MemoryPath(PurePosixPath):
    @classmethod
    def cwd(cls):
        return cls("/fixture/project")

    def resolve(self, strict=False):
        return self

    def lstat(self):
        raise AssertionError("Unconfigured memory metadata port")

    def mkdir(self, *args, **kwargs):
        raise AssertionError("Unconfigured memory directory port")


def file_stat(size=0, mode=stat.S_IFREG | 0o600, uid=1000, ino=7, tick=1):
    return SimpleNamespace(st_dev=1, st_ino=ino, st_uid=uid, st_gid=1000,
                           st_mode=mode, st_nlink=1, st_size=size,
                           st_mtime_ns=tick, st_ctime_ns=tick)


class PreparationFixture:
    def __init__(self, failure=None, error=None, bad_node=False, version=b"v24.22.2\n"):
        self.failure, self.error = failure, error
        self.bad_node, self.version = bad_node, version
        self.calls, self.reports = [], []
        self.node = b"ordinary memory data, never executable"
        self.profile = json.loads(json.dumps(PROFILE))
        self.profile["node"].update(bytes=len(self.node), sha256=hashlib.sha256(self.node).hexdigest())
        self.environment = {
            "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub", "GITHUB_ACTIONS": "true",
            "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + SUBJECT.BRANCH,
            "GITHUB_RUN_ATTEMPT": "1", "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "GITHUB_SHA": "a" * 40,
            "GITHUB_WORKSPACE": "/fixture/project", "GITHUB_EVENT_PATH": "/fixture/event.json",
            "RUNNER_TOOL_CACHE": "/fixture/cache", "RUNNER_TEMP": "/fixture/temp",
        }

    def operation(self, kind):
        self.calls.append((SUBJECT.PHASE, kind, SUBJECT.INPUT))
        if self.failure == (SUBJECT.PHASE, kind):
            raise self.error

    def read(self, path, maximum):
        self.operation("read")
        path = str(path)
        if path.endswith("event.json"):
            return json.dumps({"repository": {"full_name": self.environment["GITHUB_REPOSITORY"],
                                              "private": False}, "deleted": False,
                               "ref": self.environment["GITHUB_REF"], "after": "a" * 40}).encode()
        if path.endswith("gateway-four-tool-inputs.json"):
            return json.dumps(self.profile).encode()
        if path.endswith("package-lock.json"):
            return LOCK
        if path.endswith("bin/node"):
            return b"different ordinary data" if self.bad_node else self.node
        raise AssertionError("Unconfigured memory read port")

    def child(self, argv, **kwargs):
        self.operation("child")
        if argv[0] == "/usr/bin/git":
            assert kwargs["stderr"] == SUBJECT.subprocess.PIPE
            return ("a" * 40 + "\n").encode() if "rev-parse" in argv else b""
        assert argv[-1] == "--version"
        return self.version

    def report(self, *values):
        self.reports.append(values)

    def run(self):
        fake_os = SimpleNamespace(
            environ=self.environment, uname=lambda: SimpleNamespace(sysname="Linux", machine="x86_64"),
            path=SimpleNamespace(lexists=lambda _: False))
        with contextlib.ExitStack() as stack:
            for name, value in {
                "UID": 1000, "Path": MemoryPath, "os": fake_os, "read": self.read,
                "directory": lambda _: self.operation("directory"),
                "metadata": lambda _: file_stat(mode=stat.S_IFREG | 0o500),
                "npm_inventory": lambda *_: self.operation("inventory"),
                "download": lambda _: (self.operation("download"), b"inert fixture bytes")[1],
                "inspect_package": lambda *_: (self.operation("inspect"), {"package.json": (b"{}", 0o600)})[1],
                "write": lambda *_: self.operation("write"), "publish_diagnostic": self.report,
                "tempfile": SimpleNamespace(mkdtemp=lambda **_: (self.operation("scratch"), "/fixture/temp/owned")[1]),
                "subprocess": SimpleNamespace(check_output=self.child, PIPE=-1, STDOUT=-2,
                                               CalledProcessError=SUBJECT.subprocess.CalledProcessError),
            }.items():
                stack.enter_context(patch.object(SUBJECT, name, value))
            stack.enter_context(patch.object(MemoryPath, "mkdir", lambda *_, **__: self.operation("mkdir")))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            result = SUBJECT.collect_diagnostic()
        return result, output.getvalue()


class PreparationFlowTests(unittest.TestCase):
    def test_prepared_report_preserves_order_and_all_four_inputs(self):
        f = PreparationFixture()
        result, _ = f.run()
        self.assertEqual(result, 0)
        self.assertEqual(f.reports, [("prepared", "complete", "none", "none")])
        self.assertEqual([x[2] for x in f.calls if x[1] == "download"], ["1", "2", "3", "4"])
        self.assertEqual([x[2] for x in f.calls if x[1] == "inspect"], ["1", "2", "3", "4"])
        first_fetch = next(i for i, x in enumerate(f.calls) if x[1] == "download")
        self.assertTrue(any(x[:2] == ("npm-integrity", "inventory") for x in f.calls[:first_fetch]))
        self.assertTrue(any(x[:2] == ("node-version", "child") for x in f.calls[:first_fetch]))
        first_mkdir = next(i for i, x in enumerate(f.calls) if x[1] == "mkdir")
        self.assertEqual(sum(x[1] == "inspect" for x in f.calls[:first_mkdir]), 4)

    def test_cache_missing_is_distinct_and_stops_before_integrity_or_fetch(self):
        f = PreparationFixture(("cache-selection", "directory"), FileNotFoundError(MARKER))
        result, text = f.run()
        self.assertEqual(result, 0)  # Closed refusal report, not preparation success.
        self.assertEqual(f.reports, [("refused", "cache-selection", "missing", "none")])
        self.assertFalse(any(x[0] in ("node-integrity", "tool-fetch") for x in f.calls))
        self.assertNotIn(MARKER, text)

    def test_actual_node_size_guard_reports_without_version_or_fetch(self):
        f = PreparationFixture(bad_node=True)
        f.run()
        self.assertEqual(f.reports, [("refused", "node-integrity", "node-size", "none")])
        self.assertFalse(any(x[0] in ("node-version", "tool-fetch") for x in f.calls))

    def test_actual_node_digest_guard_is_distinct(self):
        f = PreparationFixture()
        f.profile["node"]["sha256"] = "0" * 64
        f.run()
        self.assertEqual(f.reports[0][:3], ("refused", "node-integrity", "node-integrity"))

    def test_actual_version_guard_remains_closed(self):
        f = PreparationFixture(version=b"v24.22.0\n")
        f.run()
        self.assertEqual(f.reports[0][:3], ("refused", "node-version", "node-version"))
        self.assertFalse(any(x[1] == "download" for x in f.calls))

    def test_finite_stage_classification_at_original_operations(self):
        cases = [
            ("npm-integrity", "inventory", SUBJECT.PreparationRefused("npm-integrity"), "npm-integrity"),
            ("node-version", "child", SUBJECT.subprocess.CalledProcessError(1, [MARKER]), "child-failed"),
            ("tool-fetch", "download", urllib.error.URLError(MARKER), "network-error"),
            ("safe-extraction", "inspect", SUBJECT.tarfile.ReadError(MARKER), "invalid-archive"),
            ("build-preparation", "scratch", OSError(MARKER), "filesystem-error"),
            ("build-preparation", "write", PermissionError(MARKER), "access-denied"),
        ]
        for stage, operation, error, reason in cases:
            with self.subTest(stage=stage, operation=operation):
                f = PreparationFixture((stage, operation), error)
                result, text = f.run()
                self.assertEqual(result, 0)
                self.assertEqual(f.reports[0][:3], ("refused", stage, reason))
                self.assertNotIn(MARKER, text)
                self.assertNotIn("/fixture", text)
                self.assertNotIn("complete", f.reports[0][1])

    def test_source_lock_guard_still_precedes_cache(self):
        f = PreparationFixture()
        f.profile["sourceLockSHA256"] = "0" * 64
        f.run()
        self.assertEqual(f.reports[0][:3], ("refused", "source-integrity", "source-integrity"))
        self.assertFalse(any(x[0] == "cache-selection" for x in f.calls))


class ReporterTests(unittest.TestCase):
    @contextlib.contextmanager
    def ports(self, close_error=False, partial=False):
        written = bytearray()
        calls = []
        before = file_stat()
        def observed():
            return file_stat(size=len(written), tick=2 if written else 1)
        def append(fd, data):
            calls.append("write")
            part = data[:3] if partial else data
            written.extend(part)
            return len(part)
        def close(fd):
            calls.append("close")
            if close_error:
                raise OSError(MARKER)
        fake_os = SimpleNamespace(
            environ={"GITHUB_OUTPUT": "/fixture/output"}, O_WRONLY=os.O_WRONLY,
            O_APPEND=os.O_APPEND, O_NOFOLLOW=os.O_NOFOLLOW,
            open=Mock(return_value=17), fstat=lambda _: observed(), write=append,
            fsync=lambda _: calls.append("fsync"), close=close)
        with patch.object(SUBJECT, "Path", MemoryPath), patch.object(SUBJECT, "os", fake_os), \
                patch.object(SUBJECT, "directory"), \
                patch.object(SUBJECT, "metadata", side_effect=lambda _: before if not written else observed()):
            yield written, calls, fake_os

    def test_closed_refusal_report_is_finite(self):
        with self.ports() as (written, calls, fake_os):
            SUBJECT.publish_diagnostic("refused", "safe-extraction", "archive-policy", "2")
        self.assertEqual(written.decode(), "result=refused\nstage=safe-extraction\nreason=archive-policy\ninput=2\n")
        self.assertEqual(calls, ["write", "fsync", "close"])
        flags = fake_os.open.call_args.args[1]
        self.assertTrue(flags & os.O_NOFOLLOW and flags & os.O_APPEND)

    def test_invalid_tuple_refuses_before_output_access(self):
        for values in [("other", "complete", "none", "none"),
                       ("prepared", "tool-fetch", "none", "none"),
                       ("refused", "cache-selection", "none", "none"),
                       ("refused", "unknown-stage", "missing", "1"),
                       ("refused", "cache-selection", "unknown-reason", "1"),
                       ("refused", "cache-selection", "missing", "5")]:
            with self.subTest(values=values), self.ports() as (_, _, fake_os):
                with self.assertRaises(ValueError):
                    SUBJECT.publish_diagnostic(*values)
                fake_os.open.assert_not_called()

    def test_partial_write_is_nonzero_and_closed_once(self):
        with self.ports(partial=True) as (_, calls, _), \
                patch.object(SUBJECT, "main", side_effect=lambda: self.prepared()), \
                contextlib.redirect_stdout(io.StringIO()) as text:
            result = SUBJECT.collect_diagnostic()
        self.assertEqual(result, 1)
        self.assertEqual(calls, ["write", "close"])
        self.assertNotIn(MARKER, text.getvalue())

    def test_close_failure_after_complete_append_does_not_admit(self):
        with self.ports(close_error=True) as (written, calls, _), \
                patch.object(SUBJECT, "main", side_effect=lambda: self.prepared()), \
                contextlib.redirect_stdout(io.StringIO()) as text:
            result = SUBJECT.collect_diagnostic()
        self.assertEqual(result, 1)
        self.assertIn(b"result=prepared\n", written)  # Partial custody is deliberately not trusted.
        self.assertEqual(calls, ["write", "fsync", "close"])
        self.assertIn("diagnostic unavailable", text.getvalue())
        self.assertNotIn(MARKER, text.getvalue())

    @staticmethod
    def prepared():
        SUBJECT.PHASE, SUBJECT.INPUT = "complete", "none"

    def test_main_exception_cannot_be_reported_prepared(self):
        with patch.object(SUBJECT, "main", side_effect=RuntimeError(MARKER)), \
                patch.object(SUBJECT, "publish_diagnostic") as report, \
                contextlib.redirect_stdout(io.StringIO()) as text:
            self.assertEqual(SUBJECT.collect_diagnostic(), 0)
        report.assert_called_once_with("refused", "admission", "unexpected", "none")
        self.assertNotIn(MARKER, text.getvalue())

    def test_interruption_is_not_swallowed_or_reported_prepared(self):
        with patch.object(SUBJECT, "main", side_effect=KeyboardInterrupt), \
                patch.object(SUBJECT, "publish_diagnostic") as report:
            with self.assertRaises(KeyboardInterrupt):
                SUBJECT.collect_diagnostic()
        report.assert_not_called()


class GuardAndWorkflowTests(unittest.TestCase):
    def test_inert_fetch_integrity_refusal_never_opens_a_network_port(self):
        body = b"ordinary memory response"
        response = io.BytesIO(body)
        response.status = 200
        response.geturl = lambda: PROFILE["packages"][0]["url"]
        response.headers = {"Content-Length": str(len(body))}
        package = dict(PROFILE["packages"][0], integrity="sha512-" + SUBJECT.base64.b64encode(bytes(64)).decode())
        opener = SimpleNamespace(open=Mock(return_value=response))
        with patch.object(SUBJECT.urllib.request, "build_opener", return_value=opener), \
                patch.object(SUBJECT.ssl, "create_default_context", return_value=None):
            with self.assertRaises(SUBJECT.PreparationRefused) as caught:
                SUBJECT.download(package)
        self.assertEqual(caught.exception.reason, "package-integrity")
        self.assertEqual(opener.open.call_count, 1)

    def test_safe_inert_package_and_truncation_use_existing_parser(self):
        package = PROFILE["packages"][0]
        data = json.dumps({"name": package["name"], "version": package["version"]}).encode()
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w") as archive:
            info = tarfile.TarInfo("package/package.json")
            info.size, info.mode = len(data), 0o644
            archive.addfile(info, io.BytesIO(data))
        encoder = zlib.compressobj(wbits=31)
        compressed = encoder.compress(raw.getvalue()) + encoder.flush()
        members = SUBJECT.inspect_package(compressed, package)
        self.assertEqual(members["package.json"][0], data)
        with self.assertRaises(SUBJECT.PreparationRefused) as caught:
            SUBJECT.inspect_package(compressed[:-8], package)
        self.assertEqual(caught.exception.reason, "archive-policy")
        different = dict(package, version="0.0.0")
        with self.assertRaises(SUBJECT.PreparationRefused) as caught:
            SUBJECT.inspect_package(compressed, different)
        self.assertEqual(caught.exception.reason, "package-manifest")

    def test_synthetic_metadata_classifies_same_refusals(self):
        cases = [(file_stat(mode=stat.S_IFDIR | 0o700), "type"),
                 (file_stat(uid=2000), "owner"), (file_stat(mode=stat.S_IFREG | 0o622), "mode"),
                 (file_stat(ino=0), "inode")]
        for value, reason in cases:
            with self.subTest(reason=reason), patch.object(SUBJECT, "UID", 1000), \
                    patch.object(MemoryPath, "lstat", return_value=value):
                with self.assertRaises(SUBJECT.PreparationRefused) as caught:
                    SUBJECT.metadata(MemoryPath("/fixture/data"))
                self.assertEqual(caught.exception.reason, reason)

    def test_exception_text_is_never_formatted(self):
        class OpaqueError(Exception):
            def __str__(self):
                raise AssertionError("Exception text must remain opaque")
        self.assertEqual(SUBJECT.reason_for(OpaqueError()), "unexpected")
        self.assertEqual(SUBJECT.reason_for(urllib.error.HTTPError("/fixture", 404, MARKER, {}, None)), "http-error")

    def test_workflow_requires_closed_prepared_report_and_fails_refusal(self):
        self.assertNotIn("continue-on-error", WORKFLOW)
        self.assertIn("if: ${{ always() }}", WORKFLOW)
        self.assertIn('run: test "$PREPARATION_RESULT" = prepared', WORKFLOW)
        self.assertIn("if: ${{ success() && steps.preparation.outcome == 'success' && steps.preparation.outputs.result == 'prepared' }}", WORKFLOW)
        for field in ("result", "stage", "reason", "input"):
            self.assertIn("steps.preparation.outcome == 'success' && steps.preparation.outputs." + field, WORKFLOW)
        self.assertEqual(PROFILE["node"]["version"], "24.22.2")
        self.assertEqual(len(PROFILE["packages"]), 4)


if __name__ == "__main__":
    # Make accidental real effects a test failure, including any unreviewed fixture cleanup.
    with contextlib.ExitStack() as boundary:
        for target in ("socket.create_connection", "subprocess.Popen", "os.open",
                       "os.unlink", "os.remove", "os.rmdir", "os.mkdir"):
            boundary.enter_context(patch(target, side_effect=AssertionError("Real effect port is closed")))
        unittest.main()
