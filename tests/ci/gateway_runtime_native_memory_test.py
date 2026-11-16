"""Literal benign memory fixtures for native port kwargs and strict child protocol.

Inert checked-in source/profile reads occur before closed native allocation ports.
No actual child, network request, package extraction, file creation or cleanup.
"""

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import socket
import ssl
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


N = load("gateway-runtime-native.py", "native_runtime")
C = load("prepare-gateway-runtime-child.py", "runtime_child")
P = load("prepare-gateway-runtime-inputs.py", "runtime_inputs")
LOCK = (ROOT / "package-lock.json").read_bytes()
PROFILE = (ROOT / "scripts/ci/gateway-runtime-inputs.json").read_bytes()
PACKAGES = P.validate_runtime_inputs(LOCK, PROFILE)
INSTALL = "/private/job/validation/gateway-runtime/install"
ARCHIVES = "/private/job/validation/gateway-runtime/inputs/runtime-archives"


class Awaitable:
    def __await__(self):
        raise AssertionError("Unsupported async value must remain unexecuted")


class MemoryOS:
    O_RDONLY, O_WRONLY, O_CREAT, O_EXCL = os.O_RDONLY, os.O_WRONLY, os.O_CREAT, os.O_EXCL
    O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK = os.O_DIRECTORY, os.O_NOFOLLOW, os.O_NONBLOCK

    def __init__(self):
        self.nodes, self.fds, self.opens, self.stats = {}, {}, [], []
        self.closes, self.syncs, self.mkdirs, self.writes = [], [], [], []
        self.next_fd, self.next_ino, self.partial = 100, 1, 2
        self.write_return, self.close_error, self.sync_error = None, None, None
        self.metadata_change = lambda row, _path: row
        for path in ["/"] + [str(p) for p in reversed(PurePosixPath(INSTALL).parents) if str(p) != "/"] + [INSTALL, str(PurePosixPath(ARCHIVES).parent)]:
            self.add(path, True)

    def add(self, path, directory):
        if path in self.nodes:
            return
        self.nodes[path] = SimpleNamespace(st_dev=1, st_ino=self.next_ino, st_uid=1001,
            st_gid=1001, st_mode=(stat.S_IFDIR | 0o700) if directory else (stat.S_IFREG | 0o600),
            st_nlink=2 if directory else 1, st_size=0, data=bytearray())
        self.next_ino += 1

    def getuid(self):
        return 1001

    def full(self, path, fd=None):
        return path if path.startswith("/") else self.fds[fd].rstrip("/") + "/" + path

    def snapshot(self, path):
        return self.metadata_change(SimpleNamespace(**vars(self.nodes[path])), path)

    def lstat(self, path):
        return self.snapshot(path)

    def stat(self, path, **kwargs):
        self.stats.append((path, kwargs.copy()))
        assert kwargs["follow_symlinks"] is False
        return self.snapshot(self.full(path, kwargs["dir_fd"]))

    def fstat(self, fd):
        return self.snapshot(self.fds[fd])

    def open(self, path, flags, mode=None, **kwargs):
        self.opens.append((path, flags, mode, kwargs.copy()))
        assert flags & self.O_NOFOLLOW and flags & self.O_NONBLOCK
        full = self.full(path, kwargs.get("dir_fd"))
        if flags & self.O_CREAT:
            assert flags & self.O_EXCL and mode == 0o600
            if full in self.nodes:
                raise FileExistsError("inert existing slot")
            self.add(full, False)
        else:
            assert flags & self.O_DIRECTORY
            assert stat.S_ISDIR(self.nodes[full].st_mode)
        fd = self.next_fd; self.next_fd += 1
        self.fds[fd] = full
        return fd

    def mkdir(self, path, *, mode, dir_fd):
        self.mkdirs.append((path, mode, dir_fd))
        assert mode == 0o700
        full = self.full(path, dir_fd)
        if full in self.nodes:
            raise FileExistsError("inert existing slot")
        self.add(full, True)
        self.nodes[self.fds[dir_fd]].st_nlink += 1

    def write(self, fd, data):
        self.writes.append((fd, bytes(data)))
        if self.write_return is not None:
            return self.write_return
        count = min(self.partial, len(data))
        row = self.nodes[self.fds[fd]]
        row.data.extend(bytes(data[:count])); row.st_size += count
        return count

    def fsync(self, fd):
        self.syncs.append(fd)
        if self.sync_error:
            raise self.sync_error

    def close(self, fd):
        self.closes.append(fd)
        if self.close_error:
            raise self.close_error
        del self.fds[fd]


class MemoryResponse:
    def __init__(self):
        self.status, self.data = 200, io.BytesIO(b"inert-fixture")
        self.headers = {"Content-Length": "13"}
        self.closed, self.close_error, self.read_error = 0, None, None

    def getheader(self, key):
        return self.headers.get(key)

    def read(self, maximum):
        if self.read_error:
            raise self.read_error
        return self.data.read(maximum)

    def close(self):
        self.closed += 1
        if self.close_error:
            raise self.close_error


class MemoryConnection:
    def __init__(self, response):
        self.response, self.calls, self.closed = response, [], 0

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed += 1


def fixture(system=None, environment=None):
    system = MemoryOS() if system is None else system
    response = MemoryResponse(); connection = MemoryConnection(response)
    calls, context_calls, clock = [], [], [0]
    context = SimpleNamespace(verify_mode=ssl.CERT_REQUIRED, check_hostname=True, keylog_filename=None)
    def context_factory():
        context_calls.append(True)
        return context
    def factory(*args, **kwargs):
        calls.append((args, kwargs))
        return connection
    native = N.NativeRuntimePorts(1001, INSTALL, ARCHIVES, "/checkout", PACKAGES,
        environment={} if environment is None else environment, system=system,
        connection_factory=factory, context_factory=context_factory, clock=lambda: clock[0])
    return SimpleNamespace(native=native, system=system, response=response, connection=connection,
                           calls=calls, context_calls=context_calls, context=context, clock=clock)


def request():
    return {"url": N.URLS[0], "maximumBytes": 16 * 1024**2, "timeoutSeconds": 15,
            "deadlineSeconds": 45, "redirects": False, "retries": 0, "credentials": False,
            "proxy": False, "customTrust": False}


def child_request():
    return {"schemaVersion": 1, "sourceLockBase64": base64.b64encode(LOCK).decode(),
            "profileBase64": base64.b64encode(PROFILE).decode(), "installRoot": INSTALL,
            "archivesRoot": ARCHIVES, "checkoutRoot": "/checkout", "uid": 1001}


class FixtureModule:
    """Only protocol/control fixtures: this fake cannot authenticate real package bytes."""
    def __init__(self):
        self.packages, rows = [], []
        for name in N.NAMES:
            raw = ("benign-archive-fixture-" + name).encode()
            sri = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
            self.packages.append({"name": name, "integrity": sri})
            rows.append({"path": "node_modules/" + name, "bytes": raw})
        self.state = {"phase": "complete", "status": "prepared-inputs-not-runtime", "pending": [],
                      "unknownReturns": [], "runtimeExecuted": False, "archives": rows}
        self.error = None

    def validate_runtime_inputs(self, source, profile):
        assert source == LOCK and profile == PROFILE
        return self.packages

    def absolute(self, path):
        P.absolute(path)

    def prepare_runtime_inputs(self, *_args):
        if self.error:
            raise self.error
        return self.state


class NativeRuntimeMemory(unittest.TestCase):
    def test_fixed_host_request_kwargs_and_response_close(self):
        f = fixture(); owner = f.native.fetch(request())
        self.assertEqual(f.calls[0][0], ("registry.npmjs.org",))
        self.assertEqual(f.calls[0][1]["port"], 443)
        self.assertEqual(f.calls[0][1]["timeout"], 15)
        args, kwargs = f.connection.calls[0]
        self.assertEqual(args, ("GET", "/asn1/-/asn1-0.2.6.tgz"))
        self.assertIsNone(kwargs["body"])
        self.assertEqual(set(kwargs["headers"]), {"Accept", "Accept-Encoding", "Connection", "User-Agent"})
        self.assertEqual(owner["read"](65536), b"inert-fixture")
        self.assertEqual(owner["read"](65536), b"")
        owner["close"]()
        self.assertEqual((f.response.closed, f.connection.closed), (1, 1))

    def test_request_override_or_duplicate_never_opens_another_connection(self):
        f = fixture()
        for change in [{"url": "https://example.invalid/inert"}, {"redirects": True}, {"timeoutSeconds": 15.0},
                       {"extra": True}, {"retries": 1}]:
            with self.subTest(change=change), self.assertRaises(N.NativePortRefused):
                f.native.fetch({**request(), **change})
        self.assertFalse(f.calls)
        f.native.fetch(request())["close"]()
        with self.assertRaisesRegex(N.NativePortRefused, ""):
            f.native.fetch(request())
        self.assertEqual(len(f.calls), 1)

    def test_proxy_trust_keylog_rejected_before_tls(self):
        for key in ["HTTPS_PROXY", "SSL_CERT_FILE", "SSLKEYLOGFILE", "OPENSSL_CONF", "npm_config_ca"]:
            with self.subTest(key=key), self.assertRaises(N.NativePortRefused):
                fixture(environment={key: "inert-value-never-output"})

    def test_tls_context_must_keep_verification_and_no_keylog(self):
        for key, value in [("verify_mode", ssl.CERT_NONE), ("check_hostname", False), ("keylog_filename", "inert")]:
            f = fixture(); setattr(f.context, key, value)
            with self.subTest(key=key), self.assertRaises(N.NativePortRefused):
                f.native.fetch(request())
            self.assertFalse(f.calls)

    def test_redirect_encoding_and_length_are_closed_not_followed(self):
        for status, headers in [(302, {}), (200, {"Content-Encoding": "gzip"}),
                                (200, {"Content-Length": "16777217"}), (200, {"Content-Length": "1,1"})]:
            f = fixture(); f.response.status, f.response.headers = status, headers
            with self.subTest(status=status, headers=headers), self.assertRaises(N.NativePortRefused):
                f.native.fetch(request())
            self.assertEqual(len(f.connection.calls), 1)
            self.assertEqual((f.response.closed, f.connection.closed), (1, 1))

    def test_read_deadline_and_body_length_fail_without_retry(self):
        f = fixture(); owner = f.native.fetch(request()); f.clock[0] = 46
        with self.assertRaises(N.NativePortRefused): owner["read"](65536)
        owner["close"]()
        f = fixture(); f.response.headers["Content-Length"] = "12"
        owner = f.native.fetch(request()); owner["read"](65536)
        with self.assertRaises(N.NativePortRefused): owner["read"](65536)
        owner["close"]()
        self.assertEqual(len(f.calls), 1)

    def test_read_failure_and_close_failure_remain_separate(self):
        f = fixture(); first = OSError("private inert read error"); second = OSError("private inert close error")
        f.response.read_error, f.response.close_error = first, second
        owner = f.native.fetch(request())
        with self.assertRaises(OSError) as failure: owner["read"](65536)
        self.assertIs(failure.exception, first)
        with self.assertRaises(OSError) as failure: owner["close"]()
        self.assertIs(failure.exception, second)
        self.assertFalse(f.native.state["responses"][0]["closed"])
        self.assertEqual((f.response.closed, f.connection.closed), (1, 1))

    def test_awaitable_request_retains_connection_without_http_close_or_retry(self):
        f = fixture(); unknown = Awaitable(); calls = []
        def pending(*args, **kwargs):
            calls.append((args, kwargs)); return unknown
        f.connection.request = pending
        with self.assertRaises(N.NativePortRefused): f.native.fetch(request())
        with self.assertRaises(N.NativePortRefused): f.native.fetch(request())
        self.assertEqual(len(calls), 1)
        self.assertIn(unknown, f.native.state["unknown"])
        owner = f.native.state["responses"][0]
        self.assertFalse(owner["closed"]); self.assertTrue(owner["closeRefusedUnsettled"])
        self.assertEqual((f.response.closed, f.connection.closed), (0, 0))

    def test_awaitable_getresponse_retains_connection_without_http_close(self):
        f = fixture(); unknown = Awaitable(); calls = []
        def pending():
            calls.append(True); return unknown
        f.connection.getresponse = pending
        with self.assertRaises(N.NativePortRefused): f.native.fetch(request())
        self.assertEqual(len(calls), 1)
        self.assertIn(unknown, f.native.state["unknown"])
        owner = f.native.state["responses"][0]
        self.assertFalse(owner["closed"]); self.assertTrue(owner["closeRefusedUnsettled"])
        self.assertEqual((f.response.closed, f.connection.closed), (0, 0))

    def test_awaitable_read_refuses_close_without_retirement_or_second_submission(self):
        f = fixture(); unknown = Awaitable(); calls = []
        def pending(maximum):
            calls.append(maximum); return unknown
        f.response.read = pending
        lease = f.native.fetch(request())
        with self.assertRaises(N.NativePortRefused): lease["read"](65536)
        with self.assertRaises(N.NativePortRefused): lease["close"]()
        with self.assertRaises(N.NativePortRefused): lease["close"]()
        self.assertEqual(calls, [65536])
        self.assertIn(unknown, f.native.state["unknown"])
        owner = f.native.state["responses"][0]
        self.assertFalse(owner["closed"]); self.assertTrue(owner["closeRefusedUnsettled"])
        self.assertEqual((f.response.closed, f.connection.closed), (0, 0))

    def test_awaitable_response_close_does_not_close_borrowed_connection(self):
        f = fixture(); unknown = Awaitable()
        def pending():
            f.response.closed += 1; return unknown
        f.response.close = pending
        lease = f.native.fetch(request())
        with self.assertRaises(N.NativePortRefused): lease["close"]()
        with self.assertRaises(N.NativePortRefused): lease["close"]()
        self.assertIn(unknown, f.native.state["unknown"])
        owner = f.native.state["responses"][0]
        self.assertFalse(owner["closed"]); self.assertTrue(owner["closeRefusedUnsettled"])
        self.assertEqual((f.response.closed, f.connection.closed), (1, 0))

    def test_frozen_preparer_preserves_read_error_when_native_close_also_fails(self):
        f = fixture(); first = OSError("inert original read failure"); second = OSError("inert original close failure")
        f.response.read_error, f.response.close_error = first, second
        with self.assertRaises(P.RuntimeInputRefused) as failure:
            P.prepare_runtime_inputs(LOCK, PROFILE, INSTALL, ARCHIVES, "/checkout", 1001, f.native.ports())
        self.assertIs(failure.exception.__cause__, first)
        self.assertIn(second, failure.exception.custody["secondary"])
        self.assertFalse(f.system.writes)

    def test_descriptor_relative_private_creation_partial_writes_and_fsync(self):
        f = fixture(); f.native.mkdir_exclusive(ARCHIVES, 0o700)
        f.native.write_exclusive(ARCHIVES + "/1.tgz", b"fixture-content", 0o600)
        self.assertEqual(bytes(f.system.nodes[ARCHIVES + "/1.tgz"].data), b"fixture-content")
        self.assertGreater(len(f.system.writes), 1)
        self.assertEqual(len(f.system.syncs), 1)
        self.assertFalse(f.system.fds)
        self.assertTrue(all(kwargs.get("follow_symlinks") is False for _, kwargs in f.system.stats))
        self.assertTrue(all(flags & os.O_NOFOLLOW and flags & os.O_NONBLOCK for _, flags, _, _ in f.system.opens))
        file_open = [row for row in f.system.opens if row[1] & os.O_CREAT]
        self.assertEqual(len(file_open), 1)
        self.assertTrue(file_open[0][1] & os.O_EXCL)
        self.assertEqual(file_open[0][2], 0o600)

    def test_existing_slot_or_scope_expansion_is_not_adopted(self):
        f = fixture(); f.system.add(ARCHIVES, True)
        with self.assertRaises(FileExistsError): f.native.mkdir_exclusive(ARCHIVES, 0o700)
        for path in ["/unrelated/fixture", INSTALL + "/node_modules/optional", ARCHIVES + "/6.tgz"]:
            with self.subTest(path=path), self.assertRaises(N.NativePortRefused):
                f.native.write_exclusive(path, b"inert", 0o600)
        self.assertFalse(f.system.writes)

    def test_unsafe_parent_is_not_traversed(self):
        f = fixture()
        f.system.nodes["/private"].st_mode = stat.S_IFDIR | 0o777
        with self.assertRaises(N.NativePortRefused): f.native.lstat_directory(INSTALL)
        self.assertFalse(any(path == "private" for path, _, _, _ in f.system.opens))
        self.assertFalse(f.system.fds)

    def test_parent_identity_replacement_refused(self):
        f = fixture(); f.native.lstat_directory(INSTALL)
        f.system.nodes[INSTALL].st_ino += 100
        with self.assertRaises(N.NativePortRefused): f.native.lstat_directory(INSTALL)
        self.assertFalse(f.system.fds)

    def test_zero_write_and_fsync_errors_retain_files_without_cleanup(self):
        for fail in ("zero", "fsync"):
            f = fixture(); f.native.mkdir_exclusive(ARCHIVES, 0o700)
            if fail == "zero": f.system.write_return = 0
            else: f.system.sync_error = OSError("inert fsync error")
            with self.subTest(fail=fail), self.assertRaises((N.NativePortRefused, OSError)):
                f.native.write_exclusive(ARCHIVES + "/1.tgz", b"fixture", 0o600)
            self.assertIn(ARCHIVES + "/1.tgz", f.system.nodes)
            self.assertFalse(f.system.fds)

    def test_unknown_write_preserves_borrowed_descriptors(self):
        f = fixture(); f.native.mkdir_exclusive(ARCHIVES, 0o700)
        unknown = Awaitable(); f.system.write_return = unknown
        before = len(f.system.closes)
        with self.assertRaises(N.NativePortRefused):
            f.native.write_exclusive(ARCHIVES + "/1.tgz", b"fixture", 0o600)
        self.assertIn(unknown, f.native.state["unknown"])
        self.assertTrue(f.system.fds)
        self.assertEqual(len(f.system.closes), before)

    def test_unknown_open_handle_is_retained_without_adoption(self):
        f = fixture(); unknown = Awaitable()
        f.system.open = lambda *_args, **_kwargs: unknown
        with self.assertRaises(N.NativePortRefused): f.native.lstat_directory(INSTALL)
        self.assertIn(unknown, f.native.state["unknown"])
        self.assertFalse(f.system.closes)

    def test_post_write_file_metadata_mutation_is_refused(self):
        for key, value in [("st_ino", 999), ("st_nlink", 2), ("st_mode", stat.S_IFREG | 0o666)]:
            f = fixture(); f.native.mkdir_exclusive(ARCHIVES, 0o700)
            original = f.system.fsync
            def changed(fd):
                original(fd); setattr(f.system.nodes[f.system.fds[fd]], key, value)
            f.system.fsync = changed
            with self.subTest(key=key), self.assertRaises(N.NativePortRefused):
                f.native.write_exclusive(ARCHIVES + "/1.tgz", b"fixture", 0o600)
            self.assertIn(ARCHIVES + "/1.tgz", f.system.nodes)
            self.assertFalse(f.system.fds)

    def test_write_error_preserved_when_descriptor_close_fails(self):
        f = fixture(); f.native.mkdir_exclusive(ARCHIVES, 0o700)
        first, second = OSError("inert fsync error"), OSError("inert close error")
        f.system.sync_error, f.system.close_error = first, second
        with self.assertRaises(OSError) as failure:
            f.native.write_exclusive(ARCHIVES + "/1.tgz", b"fixture", 0o600)
        self.assertIs(failure.exception, first)
        self.assertTrue(f.native.state["secondary"])
        self.assertTrue(f.system.fds)

    def test_child_success_manifest_is_bounded_and_payload_free(self):
        module = FixtureModule(); stdout, stderr = io.BytesIO(), io.BytesIO(); calls = []
        native = SimpleNamespace(ports=lambda: {}, state={})
        def factory(*args, **kwargs): calls.append((args, kwargs)); return native
        code = C.main(io.BytesIO(json.dumps(child_request()).encode()), stdout, stderr, module=module,
                      native_factory=factory, uid_provider=lambda: 1001, environment={})
        self.assertEqual(code, 0); self.assertFalse(stderr.getvalue())
        value = json.loads(stdout.getvalue())
        self.assertLessEqual(len(stdout.getvalue()), 8192)
        self.assertEqual(set(value), {"schemaVersion", "status", "sourceLockSHA256", "profileSHA256", "archives"})
        self.assertEqual(len(value["archives"]), 5)
        self.assertEqual([row["file"] for row in value["archives"]], ["1.tgz", "2.tgz", "3.tgz", "4.tgz", "5.tgz"])
        self.assertNotIn(b"Base64", stdout.getvalue()); self.assertNotIn(INSTALL.encode(), stdout.getvalue())
        self.assertEqual(len(calls), 1)

    def test_request_failures_stop_before_native_factory(self):
        good = child_request()
        variants = [json.dumps({**good, "extra": True}).encode(), json.dumps({**good, "schemaVersion": True}).encode(),
                    json.dumps({**good, "sourceLockBase64": good["sourceLockBase64"] + "="}).encode(),
                    json.dumps({**good, "uid": 0}).encode(), b"{" + b" " * C.REQUEST_LIMIT]
        for raw in variants:
            stdout, stderr = io.BytesIO(), io.BytesIO()
            def forbidden(*_args, **_kwargs): raise AssertionError("native factory must not be called")
            with self.subTest(length=len(raw)):
                self.assertEqual(C.main(io.BytesIO(raw), stdout, stderr, module=P, native_factory=forbidden,
                                        uid_provider=lambda: 1001), 1)
            self.assertFalse(stdout.getvalue())
            self.assertEqual(json.loads(stderr.getvalue())["stage"], "request")

    def test_original_pin_failure_stops_before_native_factory(self):
        raw = child_request(); raw["sourceLockBase64"] = base64.b64encode(LOCK + b" ").decode()
        stdout, stderr = io.BytesIO(), io.BytesIO()
        def forbidden(*_args, **_kwargs): raise AssertionError("native factory must not be called")
        self.assertEqual(C.main(io.BytesIO(json.dumps(raw).encode()), stdout, stderr, module=P,
                                native_factory=forbidden, uid_provider=lambda: 1001), 1)
        self.assertFalse(stdout.getvalue()); self.assertEqual(json.loads(stderr.getvalue())["stage"], "request")

    def test_duplicate_request_key_is_not_accepted(self):
        raw = json.dumps(child_request()).encode().replace(b'"schemaVersion": 1',
                b'"schemaVersion": 1, "schemaVersion": 1', 1)
        stdout, stderr = io.BytesIO(), io.BytesIO()
        def forbidden(*_args, **_kwargs): raise AssertionError("native factory must not be called")
        self.assertEqual(C.main(io.BytesIO(raw), stdout, stderr, module=P,
                                native_factory=forbidden, uid_provider=lambda: 1001), 1)
        self.assertFalse(stdout.getvalue()); self.assertEqual(json.loads(stderr.getvalue())["stage"], "request")

    def test_preparation_failure_is_sanitized_with_custody_retained(self):
        module = FixtureModule(); error = ValueError("private inert path and error")
        module.error = error; stdout, stderr = io.BytesIO(), io.BytesIO()
        code = C.main(io.BytesIO(json.dumps(child_request()).encode()), stdout, stderr, module=module,
                      native_factory=lambda *_args, **_kwargs: SimpleNamespace(ports=lambda: {}), uid_provider=lambda: 1001)
        self.assertEqual(code, 1); self.assertFalse(stdout.getvalue())
        self.assertNotIn(b"private", stderr.getvalue()); self.assertLessEqual(len(stderr.getvalue()), 1024)
        self.assertIs(C.RETAINED[-1]["error"], error)

    def test_manifest_mismatch_cannot_be_labelled_success(self):
        for field in ["archives", "status", "pending"]:
            module = FixtureModule()
            module.state[field] = [] if field == "archives" else ("unexpected" if field == "status" else ["inert-pending"])
            stdout, stderr = io.BytesIO(), io.BytesIO()
            with self.subTest(field=field):
                code = C.main(io.BytesIO(json.dumps(child_request()).encode()), stdout, stderr, module=module,
                              native_factory=lambda *_args, **_kwargs: SimpleNamespace(ports=lambda: {}), uid_provider=lambda: 1001)
                self.assertEqual(code, 1); self.assertFalse(stdout.getvalue())

    def test_output_partial_write_and_flush_failure_are_nonzero_without_retry(self):
        for kind in ("partial", "flush"):
            class BrokenOutput(io.BytesIO):
                calls = 0
                def write(self, value):
                    self.calls += 1
                    return super().write(value[:3] if kind == "partial" else value)
                def flush(self):
                    if kind == "flush": raise OSError("inert output failure")
            stdout, stderr = BrokenOutput(), io.BytesIO()
            code = C.main(io.BytesIO(json.dumps(child_request()).encode()), stdout, stderr, module=FixtureModule(),
                          native_factory=lambda *_args, **_kwargs: SimpleNamespace(ports=lambda: {}), uid_provider=lambda: 1001)
            self.assertEqual(code, 1); self.assertEqual(stdout.calls, 1)
            self.assertEqual(json.loads(stderr.getvalue())["stage"], "output")


if __name__ == "__main__":
    def closed(*_args, **_kwargs):
        raise AssertionError("Native allocation is closed in physical-port memory fixtures")
    with mock.patch("builtins.open", closed), mock.patch.object(socket, "socket", closed), \
         mock.patch.object(socket, "create_connection", closed), mock.patch.object(subprocess, "Popen", closed), \
         mock.patch.object(os, "open", closed), mock.patch.object(os, "mkdir", closed), \
         mock.patch.object(os, "write", closed), mock.patch.object(os, "fsync", closed), \
         mock.patch.object(os, "unlink", closed), mock.patch.object(os, "remove", closed), \
         mock.patch.object(os, "rmdir", closed), mock.patch.object(ssl, "create_default_context", closed):
        unittest.main()
