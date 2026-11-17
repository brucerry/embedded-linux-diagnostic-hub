"""Literal benign host-metadata controls; no real host or executable is inspected."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("web_host_metadata_memory_subject",
                                            ROOT / "scripts/ci/check-web-host-metadata.py")
SUBJECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBJECT)


def row(*, directory=False, uid=0, permissions=0o755, ino=7, nlink=1, size=4096, tick=1):
    return SimpleNamespace(st_mode=(stat.S_IFDIR if directory else stat.S_IFREG) | permissions,
                           st_uid=uid, st_gid=0, st_dev=1, st_ino=ino, st_nlink=nlink,
                           st_size=size, st_mtime_ns=tick, st_ctime_ns=tick)


class Fixture:
    def __init__(self):
        self.calls, self.overrides, self.fds, self.closed = [], {}, {}, []
        self.clock, self.clock_step, self.chunk = 0.0, 0.001, 64
        self.close_error, self.fstat_change, self.short_header = False, False, False
        self.open_none = False
        self.header = bytearray(64)
        self.header[:4], self.header[4], self.header[5] = b"\x7fELF", 2, 1
        self.header[16:18], self.header[18:20] = (3).to_bytes(2, "little"), (62).to_bytes(2, "little")
        self.stats = {}
        for _, file in SUBJECT.FILES:
            for path in SUBJECT.parents(file):
                self.stats.setdefault(path, row(directory=True, ino=len(self.stats) + 1))
            self.stats[file] = row(ino=len(self.stats) + 1)

    def now(self):
        self.clock += self.clock_step
        return self.clock

    def lstat(self, file):
        self.calls.append(("lstat", file))
        override = self.overrides.get(file)
        if isinstance(override, BaseException):
            raise override
        return override if override is not None else self.stats[file]

    def open(self, file):
        self.calls.append(("open", file))
        if self.open_none:
            return None
        fd = 17 + len(self.fds)
        self.fds[fd] = file
        return fd

    def fstat(self, fd):
        self.calls.append(("fstat", fd))
        return row(ino=9999) if self.fstat_change else self.stats[self.fds[fd]]

    def pread(self, fd, count, offset):
        self.calls.append(("pread", fd, count, offset))
        if self.short_header:
            return b""
        return bytes(self.header[offset:offset + min(count, self.chunk)])

    def close(self, fd):
        self.calls.append(("close", fd))
        if self.close_error:
            raise OSError("ordinary inert close failure")
        self.closed.append(fd)

    def ports(self):
        return {name: getattr(self, name) for name in ("now", "lstat", "open", "fstat", "pread", "close")}

    def run(self):
        return SUBJECT.inspect_host({"uid": 1000}, self.ports())


class MetadataTests(unittest.TestCase):
    def test_fixed_two_elf_headers_have_observed_readonly_closure(self):
        f = Fixture()
        state = f.run()
        self.assertEqual(state["stage"], "complete")
        self.assertEqual(state["input"], "none")
        self.assertEqual(state["headerBytes"], 128)
        self.assertEqual(len(f.closed), 2)
        self.assertTrue(all(handle["closed"] for handle in state["handles"]))
        self.assertEqual([c[1] for c in f.calls if c[0] == "open"], [file for _, file in SUBJECT.FILES])

    def test_rejected_parent_stops_before_any_descendant_query(self):
        f = Fixture()
        rejected = "/usr/local/share"
        f.overrides[rejected] = row(directory=True, permissions=0o777)
        with self.assertRaises(SUBJECT.MetadataRefused) as caught:
            f.run()
        self.assertEqual(caught.exception.reason, "mode")
        self.assertFalse(any(c[0] == "lstat" and c[1].startswith(rejected + "/") for c in f.calls))
        self.assertEqual(len(f.closed), 1)

    def test_root_owner_mode_inode_type_and_links_remain_guarded(self):
        file = SUBJECT.FILES[0][1]
        cases = [(row(uid=1000), "owner"), (row(permissions=0o775), "mode"),
                 (row(permissions=0o4755), "mode"), (row(ino=0), "inode"),
                 (row(ino=SUBJECT.MAX_SAFE + 1), "inode"), (row(directory=True), "type"),
                 (row(nlink=2), "link-count"), (row(size=63), "file-size")]
        for metadata, reason in cases:
            f = Fixture()
            f.overrides[file] = metadata
            with self.subTest(reason=reason), self.assertRaises(SUBJECT.MetadataRefused) as caught:
                f.run()
            self.assertEqual(caught.exception.reason, reason)
            self.assertFalse(any(c[0] == "open" for c in f.calls))

    def test_symlink_parent_is_not_followed(self):
        f = Fixture()
        f.overrides["/opt/google"] = row()
        f.overrides["/opt/google"].st_mode = stat.S_IFLNK | 0o777
        with self.assertRaises(SUBJECT.MetadataRefused) as caught:
            f.run()
        self.assertEqual(caught.exception.reason, "type")
        self.assertNotIn(("lstat", "/opt/google/chrome"), f.calls)

    def test_elf_architecture_or_class_mismatch_closes_own_descriptor(self):
        for offset, value in [(0, 0), (4, 1), (5, 2), (18, 183)]:
            f = Fixture()
            f.header[offset] = value
            with self.subTest(offset=offset), self.assertRaises(SUBJECT.MetadataRefused) as caught:
                f.run()
            self.assertEqual(caught.exception.reason, "elf")
            self.assertEqual(f.closed, [17])

    def test_opened_identity_change_refuses_before_header_read(self):
        f = Fixture()
        f.fstat_change = True
        with self.assertRaises(SUBJECT.MetadataRefused) as caught:
            f.run()
        self.assertEqual(caught.exception.reason, "file-identity")
        self.assertFalse(any(c[0] == "pread" for c in f.calls))
        self.assertEqual(f.closed, [17])

    def test_partial_reads_are_bounded_and_empty_read_is_not_success(self):
        f = Fixture()
        f.chunk = 1
        self.assertEqual(f.run()["reads"], 128)
        short = Fixture()
        short.short_header = True
        with self.assertRaises(SUBJECT.MetadataRefused) as caught:
            short.run()
        self.assertEqual(caught.exception.reason, "read")
        self.assertEqual(short.closed, [17])

    def test_close_error_is_retained_unknown_not_metadata_pass(self):
        f = Fixture()
        f.close_error = True
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(f.run, out, err), 1)
        result = json.loads(err.getvalue())
        self.assertEqual(result["status"], "nonpassing")
        self.assertEqual(result["reason"], "close")
        self.assertEqual(result["closure"], "retained-unknown")
        self.assertEqual(out.getvalue(), b"")
        self.assertEqual(sum(c[0] == "close" for c in f.calls), 1)
        primary = Fixture()
        primary.close_error, primary.short_header = True, True
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(primary.run, out, err), 1)
        self.assertEqual(json.loads(err.getvalue())["reason"], "close")
        self.assertEqual(json.loads(err.getvalue())["closure"], "retained-unknown")
        self.assertEqual(SUBJECT.RETAINED[-1]["state"]["primaryError"].reason, "read")

    def test_missing_file_and_deadline_stop_without_fallback(self):
        missing = Fixture()
        missing.overrides[SUBJECT.FILES[0][1]] = FileNotFoundError("ordinary inert missing metadata")
        slow = Fixture()
        slow.clock_step = 20
        for f, reason in [(missing, "missing"), (slow, "deadline")]:
            with self.subTest(reason=reason), self.assertRaises(SUBJECT.MetadataRefused) as caught:
                f.run()
            self.assertEqual(caught.exception.reason, reason)
            self.assertFalse(any(c[0] == "open" for c in f.calls))

    def test_unacknowledged_open_has_no_invented_closure(self):
        f = Fixture()
        f.open_none = True
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(f.run, out, err), 1)
        self.assertEqual(json.loads(err.getvalue())["closure"], "retained-unknown")
        self.assertFalse(any(c[0] == "close" for c in f.calls))


class ContextAndReportTests(unittest.TestCase):
    def fixture(self):
        env = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub",
               "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + SUBJECT.BRANCH,
               "GITHUB_JOB": "web_baseline", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_ENVIRONMENT": "github-hosted",
               "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "GITHUB_SHA": "a" * 40,
               "GITHUB_WORKFLOW_SHA": "a" * 40,
               "GITHUB_WORKFLOW_REF": "brucerry/embedded-linux-diagnostic-hub/" + SUBJECT.WORKFLOW +
                                      "@refs/heads/" + SUBJECT.BRANCH}
        actual = {"uid": 1000, "euid": 1000, "system": "Linux", "machine": "x86_64"}
        return env, actual

    def test_exact_context_only_and_never_root_or_other_architecture(self):
        env, actual = self.fixture()
        self.assertEqual(SUBJECT.context(env, actual), {"uid": 1000})
        for field, value in [("uid", 0), ("euid", 0), ("system", "Darwin"), ("machine", "aarch64")]:
            with self.subTest(field=field), self.assertRaises(SUBJECT.MetadataRefused):
                SUBJECT.context(env, dict(actual, **{field: value}))
        for field, value in [("GITHUB_REF", "refs/heads/ordinary"), ("GITHUB_RUN_ATTEMPT", "2"),
                             ("GITHUB_WORKFLOW_SHA", "b" * 40)]:
            with self.subTest(field=field), self.assertRaises(SUBJECT.MetadataRefused):
                SUBJECT.context(dict(env, **{field: value}), actual)

    def test_success_is_fixed_metadata_only_json_without_paths(self):
        f = Fixture()
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(f.run, out, err), 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result, {"schemaVersion": 1, "status": "passed", "stage": "complete", "reason": "none",
                                  "input": "none", "closure": "known-readonly-scope",
                                  "qualification": "host-metadata-only", "executed": False, "releaseAcceptance": False})
        self.assertNotIn(b"/", out.getvalue())
        self.assertEqual(err.getvalue(), b"")

    def test_raw_error_is_never_formatted_or_promoted(self):
        class Opaque(Exception):
            def __str__(self):
                raise AssertionError("Never format private errors")
        def fail():
            raise Opaque()
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(fail, out, err), 1)
        self.assertEqual(json.loads(err.getvalue())["reason"], "unexpected")
        self.assertEqual(out.getvalue(), b"")
        incomplete = {"stage": "complete", "input": "none", "pending": [], "unknownReturns": [],
                      "handles": [{"closed": False}, {"closed": False}]}
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(lambda: incomplete, out, err), 1)
        self.assertEqual(json.loads(err.getvalue())["closure"], "retained-unknown")

    def test_native_adapter_refuses_all_unlisted_paths_before_io(self):
        adapter = SUBJECT.NativePorts()
        with self.assertRaises(SUBJECT.MetadataRefused):
            adapter.lstat("/ordinary-unlisted-fixture")
        with self.assertRaises(SUBJECT.MetadataRefused):
            adapter.open("/ordinary-unlisted-fixture")
        with patch.object(SUBJECT.os, "open", return_value=17) as opened:
            self.assertEqual(adapter.open(SUBJECT.FILES[0][1]), 17)
        flags = opened.call_args.args[1]
        self.assertTrue(flags & SUBJECT.os.O_NOFOLLOW and flags & SUBJECT.os.O_CLOEXEC and
                        flags & SUBJECT.os.O_NONBLOCK)


if __name__ == "__main__":
    with contextlib.ExitStack() as boundary:
        for target in ("os.open", "os.lstat", "os.fstat", "os.pread", "os.close", "os.mkdir", "os.unlink",
                       "os.remove", "os.rmdir", "os.chmod", "os.chown", "subprocess.Popen", "socket.create_connection"):
            boundary.enter_context(patch(target, side_effect=AssertionError("Real host effect port is closed")))
        unittest.main()
