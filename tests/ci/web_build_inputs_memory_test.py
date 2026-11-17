"""Benign stdlib-only controls. No real archive, package, browser or build effects.

All compressed data is authored in memory here. Synthetic pins and explicit fake
ports cannot qualify actual software, a hosted image, source or a release.
"""

import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import tarfile
import zlib


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/ci/prepare-web-build-inputs.py"
SPEC = importlib.util.spec_from_file_location("web_build_inputs_memory_subject", SOURCE)
SUBJECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBJECT)
PROFILE = (ROOT / "scripts/ci/web-build-inputs.json").read_bytes()
LOCK = (ROOT / "package-lock.json").read_bytes()
PACKAGE = (ROOT / "package.json").read_bytes()
MARKER = "INERT_PRIVATE_MARKER"


def authored_archive(package, *, long_name=False, native_name=False):
    manifest = {"name": package["name"], "version": package["version"]}
    manifest.update({k: package.get(k, {}) for k in SUBJECT.DEPENDENCY_FIELDS})
    files = {"package.json": json.dumps(manifest).encode(), "ordinary/readme.txt": b"ordinary memory text"}
    if long_name:
        files["ordinary/component-" + "a" * 120 + ".js"] = b"ordinary long-name memory text"
    if native_name:
        files["ordinary.node"] = b"ordinary memory data; not a library"
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as archive:
        info = tarfile.TarInfo("package/ordinary")
        info.type, info.mode = tarfile.DIRTYPE, 0o755
        archive.addfile(info)
        for name, body in files.items():
            info = tarfile.TarInfo("package/" + name)
            info.size, info.mode = len(body), 0o644
            archive.addfile(info, io.BytesIO(body))
    encoder = zlib.compressobj(wbits=31)
    compressed = encoder.compress(raw.getvalue()) + encoder.flush()
    expected = dict(package, integrity="sha512-" + base64.b64encode(hashlib.sha512(compressed).digest()).decode())
    return SimpleNamespace(data=compressed, package=expected, files=files, raw=raw.getvalue())


def valid_inputs():
    return SUBJECT.validate_inputs(PACKAGE, LOCK, PROFILE)


class ProfileTests(unittest.TestCase):
    def test_exact_lock_profile_and_native_loader_closure(self):
        profile, packages = valid_inputs()
        self.assertEqual(tuple(p["name"] for p in packages), SUBJECT.NAMES)
        self.assertEqual(len(packages), 26)
        self.assertEqual(SUBJECT.closure(json.loads(LOCK)), set(SUBJECT.NAMES))
        self.assertEqual(profile["node"], SUBJECT.NODE)
        self.assertNotIn("playwright", SUBJECT.NAMES)
        self.assertNotIn("ssh2", SUBJECT.NAMES)

    def test_source_mutation_refuses_before_profile_use(self):
        for package, lock in [(PACKAGE + b" ", LOCK), (PACKAGE, LOCK + b" ")]:
            with self.subTest(package=package != PACKAGE):
                with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
                    SUBJECT.validate_inputs(package, lock, PROFILE)
                self.assertEqual(caught.exception.reason, "source-integrity")

    def test_profile_changes_are_not_alternate_inputs(self):
        for change in ("node", "url", "count", "limit"):
            profile = json.loads(PROFILE)
            if change == "node":
                profile["node"]["sha256"] = "0" * 64
            elif change == "url":
                profile["packages"][0]["url"] = "https://example.invalid/ordinary.tgz"
            elif change == "count":
                profile["packages"].pop()
            else:
                profile["packages"][0]["maximumCompressedBytes"] += 1
            with self.subTest(change=change), self.assertRaises(SUBJECT.WebPreparationRefused):
                SUBJECT.validate_inputs(PACKAGE, LOCK, json.dumps(profile).encode())

    def test_duplicate_json_is_not_a_profile(self):
        with self.assertRaises(SUBJECT.WebPreparationRefused):
            SUBJECT.json_bytes(b'{"ordinary":1,"ordinary":2}', 1024)

    def test_optional_native_selection_stays_linux_x64_glibc(self):
        self.assertTrue(SUBJECT.compatible({"os": ["linux"], "cpu": ["x64"], "libc": ["glibc"]}))
        for entry in [{"os": ["darwin"]}, {"cpu": ["arm64"]}, {"libc": ["musl"]}]:
            with self.subTest(entry=entry):
                self.assertFalse(SUBJECT.compatible(entry))

    def test_original_four_caps_stay_exact_and_new_caps_are_bounds(self):
        profile, _ = valid_inputs()
        for pin in profile["packages"]:
            old = pin["name"] in SUBJECT.FOUR
            self.assertEqual(pin["maximumCompressedBytes"], (16 if old else 32) * 1024**2)
            self.assertEqual(pin["maximumExpandedBytes"], (64 if old else 128) * 1024**2)
        self.assertIn("not publisher-reported exact", profile["sizeMeaning"])


class ParserTests(unittest.TestCase):
    def test_ordinary_memory_tar_is_data_only(self):
        _, packages = valid_inputs()
        fixture = authored_archive(packages[0])
        item = SUBJECT.inspect_package(fixture.data, fixture.package)
        self.assertEqual({name: body for name, (body, _) in item["members"].items() if body is not None}, fixture.files)
        self.assertTrue(all(mode in (0o600, 0o700) for _, mode in item["members"].values()))

    def test_compressed_integrity_precedes_any_decoder(self):
        _, packages = valid_inputs()
        fixture = authored_archive(packages[0])
        pin = dict(fixture.package, integrity="sha512-" + base64.b64encode(bytes(64)).decode())
        with patch.object(SUBJECT.zlib, "decompressobj", side_effect=AssertionError("Decoder must remain closed")) as decoder:
            with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
                SUBJECT.inspect_package(fixture.data, pin)
        decoder.assert_not_called()
        self.assertEqual(caught.exception.reason, "archive-integrity")

    def test_expansion_and_entry_caps_refuse_ordinary_fixture(self):
        _, packages = valid_inputs()
        fixture = authored_archive(packages[0])
        for pin in [dict(fixture.package, maximumExpandedBytes=1024), dict(fixture.package, maximumMembers=1)]:
            with self.subTest(limit=pin["maximumMembers"]), self.assertRaises(SUBJECT.WebPreparationRefused):
                SUBJECT.inspect_package(fixture.data, pin)

    def test_truncated_memory_gzip_is_not_admitted(self):
        _, packages = valid_inputs()
        fixture = authored_archive(packages[0])
        data = fixture.data[:-8]
        pin = dict(fixture.package, integrity="sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode())
        with self.assertRaises(SUBJECT.WebPreparationRefused):
            SUBJECT.inspect_package(data, pin)

    def test_dependency_manifest_must_equal_source_lock_fields(self):
        _, packages = valid_inputs()
        fixture = authored_archive(next(p for p in packages if p["name"] == "vite"))
        for field in SUBJECT.DEPENDENCY_FIELDS:
            pin = copy.deepcopy(fixture.package)
            pin[field] = {"ordinary-unselected": "1.0.0"}
            with self.subTest(field=field), self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
                SUBJECT.inspect_package(fixture.data, pin)
            self.assertEqual(caught.exception.reason, "manifest")

    def test_gnu_long_name_is_bounded_regular_data(self):
        _, packages = valid_inputs()
        fixture = authored_archive(packages[0], long_name=True)
        item = SUBJECT.inspect_package(fixture.data, fixture.package)
        self.assertGreater(item["physicalMembers"], item["logicalMembers"])
        self.assertEqual(len(item["members"]), len(fixture.files) + 1)

    def test_native_extension_name_does_not_execute_memory_bytes(self):
        _, packages = valid_inputs()
        fixture = authored_archive(packages[0], native_name=True)
        item = SUBJECT.inspect_package(fixture.data, fixture.package)
        self.assertEqual(item["members"]["ordinary.node"][0], fixture.files["ordinary.node"])


class MemoryPorts:
    def __init__(self):
        self.profile, packages = valid_inputs()
        self.fixtures = [authored_archive(p) for p in packages]
        self.packages = [f.package for f in self.fixtures]
        self.data = {p["name"]: f.data for p, f in zip(self.packages, self.fixtures)}
        self.files, self.directories, self.calls = {}, set(), []
        self.clock, self.fetches, self.failure = 0.0, 0, None
        self.node_members = {"bin/node": b"ordinary memory node data", "lib/node_modules/npm": None,
                             "lib/node_modules/npm/package.json": b'{"name":"npm","version":"11.19.1"}'}

    def now(self):
        self.clock += 0.001
        return self.clock

    def mkdir(self, path):
        self.calls.append(("mkdir", path))
        if path in self.directories:
            raise SUBJECT.WebPreparationRefused("filesystem")
        self.directories.add(path)

    def write(self, path, data, mode):
        self.calls.append(("write", path))
        if path in self.files:
            raise SUBJECT.WebPreparationRefused("filesystem")
        self.files[path] = (data, mode)

    def package_fetch(self, package):
        self.calls.append(("fetch", package["name"]))
        self.fetches += 1
        if self.failure == self.fetches:
            raise SUBJECT.WebPreparationRefused("network")
        return self.data[package["name"]]

    def inventory(self, root):
        result = [[p[len(root) + 1:], "directory", None, None] for p in self.directories if p.startswith(root + "/")]
        result.extend([p[len(root) + 1:], "file", len(data), hashlib.sha256(data).hexdigest()]
                      for p, (data, _) in self.files.items() if p.startswith(root + "/"))
        return sorted(result, key=lambda row: row[0])

    def ports(self):
        return {"now": self.now, "directory": lambda _: None, "mkdir": self.mkdir, "write": self.write,
                "node_fetch": lambda _: b"ordinary memory transport", "package_fetch": self.package_fetch,
                "node_readback": lambda *_: None, "inventory": self.inventory}

    def run(self, ports=None):
        with patch.object(SUBJECT.PUBLISHER, "inspect_distribution", return_value=self.node_members):
            return SUBJECT.prepare_inputs(self.profile, self.packages, "/fixture/project",
                                          "/fixture/temp/web-baseline-inputs-123-1", ports or self.ports())


class PreparationTests(unittest.TestCase):
    def test_all_26_verify_before_checkout_materialization(self):
        f = MemoryPorts()
        state = f.run()
        self.assertEqual(state["status"], "prepared-inputs-not-runtime")
        self.assertEqual(state["packageCount"], 26)
        first_modules = next(i for i, row in enumerate(f.calls) if row == ("mkdir", "/fixture/project/node_modules"))
        self.assertEqual(sum(row[0] == "fetch" for row in f.calls[:first_modules]), 26)
        self.assertEqual(state["pending"], [])
        self.assertEqual(state["unknownReturns"], [])

    def test_last_package_failure_never_creates_checkout_modules(self):
        f = MemoryPorts()
        f.failure = 26
        with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
            f.run()
        self.assertEqual(caught.exception.state["stage"], "package-fetch")
        self.assertEqual(caught.exception.state["input"], "26")
        self.assertNotIn("/fixture/project/node_modules", f.directories)
        self.assertEqual(f.fetches, 26)

    def test_node_parser_refusal_precedes_all_materialization(self):
        f = MemoryPorts()
        with patch.object(SUBJECT.PUBLISHER, "inspect_distribution", side_effect=SUBJECT.COMMON.PreparationRefused("package-integrity")):
            with self.assertRaises(SUBJECT.WebPreparationRefused):
                SUBJECT.prepare_inputs(f.profile, f.packages, "/fixture/project",
                                       "/fixture/temp/web-baseline-inputs-123-1", f.ports())
        self.assertEqual(f.files, {})
        self.assertEqual(f.fetches, 0)

    def test_fixed_clock_budget_stops_without_retry(self):
        f = MemoryPorts()
        ports = f.ports()
        calls = iter([0.0, 0.0, 0.0, 361.0])
        ports["now"] = lambda: next(calls)
        with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
            f.run(ports)
        self.assertEqual(caught.exception.reason, "deadline")
        self.assertEqual(f.fetches, 0)

    def test_readback_difference_cannot_be_prepared(self):
        f = MemoryPorts()
        ports = f.ports()
        ports["inventory"] = lambda _: []
        with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
            f.run(ports)
        self.assertEqual(caught.exception.state["stage"], "readback")
        self.assertEqual(caught.exception.state["status"], "refused-custody-retained")

    def test_unknown_acknowledgement_retains_pending_owner(self):
        f = MemoryPorts()
        ports = f.ports()
        unknown = object()
        ports["mkdir"] = lambda _: unknown
        with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
            f.run(ports)
        self.assertTrue(caught.exception.state["pending"])
        self.assertEqual(caught.exception.state["unknownReturns"], [unknown])
        self.assertEqual(f.fetches, 0)

    def test_awaitable_port_is_not_consumed_or_admitted(self):
        class OrdinaryAwaitable:
            def __await__(self):
                raise AssertionError("Never await a synchronous port")
        f = MemoryPorts()
        ports = f.ports()
        unknown = OrdinaryAwaitable()
        ports["node_fetch"] = lambda _: unknown
        with self.assertRaises(SUBJECT.WebPreparationRefused) as caught:
            f.run(ports)
        self.assertIn(unknown, caught.exception.state["unknownReturns"])
        self.assertEqual(f.fetches, 0)

    def test_existing_native_slot_is_never_adopted(self):
        owner = SUBJECT.NativePorts("/fixture/project", "/fixture/temp/web-baseline-inputs-123-1")
        with patch.object(owner, "directory"), patch.object(SUBJECT.os.path, "lexists", return_value=True), \
                patch.object(Path, "mkdir") as mkdir:
            with self.assertRaises(SUBJECT.WebPreparationRefused):
                owner.mkdir("/fixture/temp/web-baseline-inputs-123-1")
        mkdir.assert_not_called()


class AdmissionAndOutputTests(unittest.TestCase):
    def environment(self):
        return {"GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub", "GITHUB_ACTIONS": "true",
                "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + SUBJECT.BRANCH,
                "GITHUB_JOB": "web_baseline", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "GITHUB_RUN_ID": "123", "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "brucerry/embedded-linux-diagnostic-hub/" + SUBJECT.WORKFLOW_PATH +
                                       "@refs/heads/" + SUBJECT.BRANCH,
                "GITHUB_WORKSPACE": "/fixture/project", "GITHUB_EVENT_PATH": "/fixture/event.json",
                "RUNNER_TEMP": "/fixture/temp"}

    def test_wrong_job_branch_attempt_are_not_gateway_fallbacks(self):
        for key, value in [("GITHUB_JOB", "gateway_build"), ("GITHUB_REF", "refs/heads/ordinary"),
                           ("GITHUB_RUN_ATTEMPT", "2"), ("GITHUB_WORKFLOW_SHA", "b" * 40),
                           ("GITHUB_WORKFLOW_REF", "ordinary-memory-ref")]:
            env = self.environment()
            env[key] = value
            child = Mock()
            with self.subTest(key=key), patch.object(SUBJECT.os, "getuid", return_value=1000), \
                    patch.object(SUBJECT.os, "uname", return_value=SimpleNamespace(sysname="Linux", machine="x86_64")):
                with self.assertRaises(SUBJECT.WebPreparationRefused):
                    SUBJECT.admit(env, Path("/fixture/project"), git_reader=child)
            child.assert_not_called()

    def test_source_checks_have_complete_minimal_git_environment(self):
        env = self.environment()
        event = json.dumps({"repository": {"full_name": env["GITHUB_REPOSITORY"], "private": False},
                            "deleted": False, "ref": env["GITHUB_REF"], "after": env["GITHUB_SHA"]}).encode()
        child = Mock(side_effect=[b"a" * 40 + b"\n", b""])
        with patch.object(SUBJECT.os, "getuid", return_value=1000), \
                patch.object(SUBJECT.os, "uname", return_value=SimpleNamespace(sysname="Linux", machine="x86_64")), \
                patch.object(SUBJECT.COMMON, "directory"), patch.object(SUBJECT.COMMON, "read", return_value=event), \
                patch.object(SUBJECT.COMMON, "metadata", return_value=SimpleNamespace(st_mode=0o100500)) as metadata, \
                patch.object(SUBJECT.os.path, "lexists", return_value=False), patch.object(Path, "resolve", lambda p, **_: p):
            prefix = SUBJECT.admit(env, Path("/fixture/project"), git_reader=child)
        self.assertEqual(str(prefix), "/fixture/temp/web-baseline-inputs-123-1")
        metadata.assert_called_once_with(Path("/usr/bin/git"))
        self.assertEqual([call.args[0] for call in child.call_args_list], ["head", "status"])
        self.assertTrue(all(call.args[1] == "/fixture/project" for call in child.call_args_list))
        self.assertEqual(child.call_args_list[0].args[2], child.call_args_list[1].args[2])

    def test_only_completed_input_preparation_emits_fixed_success(self):
        state = {"status": "prepared-inputs-not-runtime", "stage": "complete", "packageCount": 26,
                 "pending": [], "unknownReturns": []}
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(lambda: state, out, err), 0)
        self.assertEqual(json.loads(out.getvalue())["packageCount"], 26)
        self.assertEqual(err.getvalue(), b"")
        self.assertNotIn(b"/", out.getvalue())

    def test_refusal_never_formats_private_error(self):
        def run():
            raise RuntimeError(MARKER)
        out, err = io.BytesIO(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(run, out, err), 1)
        self.assertEqual(out.getvalue(), b"")
        self.assertEqual(json.loads(err.getvalue())["status"], "refused")
        self.assertNotIn(MARKER.encode(), err.getvalue())

    def test_partial_success_output_is_nonzero_and_retained(self):
        class Partial(io.BytesIO):
            def write(self, body):
                return super().write(body[:4])
        state = {"status": "prepared-inputs-not-runtime", "stage": "complete", "packageCount": 26,
                 "pending": [], "unknownReturns": []}
        out, err = Partial(), io.BytesIO()
        self.assertEqual(SUBJECT.entry(lambda: state, out, err), 1)
        self.assertTrue(out.getvalue())
        self.assertEqual(json.loads(err.getvalue())["status"], "refused")

    def test_entry_does_not_call_gateway_entrypoints(self):
        source = SOURCE.read_text()
        self.assertNotIn("COMMON.main(", source)
        self.assertNotIn("collect_diagnostic(", source)
        self.assertNotIn("acquire_node(", source)
        self.assertNotIn("subprocess.check_output([str(node)", source)
        self.assertIn('JOB = "web_baseline"', source)


class GitOwnerTests(unittest.TestCase):
    def fixture(self, *, body=b"a" * 40 + b"\n", code=0, deferred=False, bad_pipe=False):
        clock, queued = [0.0], []
        out = io.BytesIO(body)
        if bad_pipe:
            out = SimpleNamespace(read=Mock(side_effect=OSError("ordinary memory read failure")), close=Mock())
        child = SimpleNamespace(pid=123, stdin=None, stdout=out, stderr=io.BytesIO(), wait=lambda: code,
                                kill=Mock(), terminate=Mock(), send_signal=Mock())
        launch = Mock(return_value=child)
        def start(work, _):
            if deferred:
                queued.append(work)
            else:
                work()
        ports = {"launch": launch, "start": start, "join": lambda _: None,
                 "now": lambda: clock[0], "pause": lambda _: None}
        owner = SUBJECT.FixedGitOwner("head", "/fixture/project", 30.0, ports)
        return SimpleNamespace(owner=owner, child=child, clock=clock, queued=queued, launch=launch)

    def test_exact_fixed_reader_waits_for_child_pipes_and_workers(self):
        with patch.object(SUBJECT, "GIT_OWNERS", []):
            f = self.fixture()
            f.owner.submit()
            self.assertFalse(f.owner.closed())
            f.owner.keep()
            self.assertEqual(f.owner.finish(), b"a" * 40 + b"\n")
            self.assertTrue(f.owner.closed())
        call = f.launch.call_args
        self.assertEqual(call.args[0][-2:], ["rev-parse", "HEAD"])
        self.assertEqual(call.kwargs["env"], {"PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0",
                                             "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"})
        self.assertFalse(call.kwargs["shell"])

    def test_deadline_failure_cannot_become_late_success(self):
        with patch.object(SUBJECT, "GIT_OWNERS", []):
            f = self.fixture(deferred=True)
            f.owner.submit()
            f.clock[0] = 31.0
            f.owner.observe_clock()
            self.assertFalse(f.owner.direct_closed())
            self.assertIn(f.owner, SUBJECT.GIT_OWNERS)
            for work in f.queued:
                work()
            f.owner.join_workers()
            with self.assertRaises(SUBJECT.WebPreparationRefused):
                f.owner.finish()
            self.assertEqual(f.launch.call_count, 1)
        for method in (f.child.kill, f.child.terminate, f.child.send_signal):
            method.assert_not_called()

    def test_overflow_is_drained_but_not_accepted_or_retained_unbounded(self):
        with patch.object(SUBJECT, "GIT_OWNERS", []):
            f = self.fixture(body=b"ordinary" * 10000)
            f.owner.submit()
            f.owner.keep()
            self.assertTrue(f.owner.closed())
            self.assertLessEqual(f.owner.streams["stdout"]["bytes"], SUBJECT.GIT_LIMITS["stdout"])
            with self.assertRaises(SUBJECT.WebPreparationRefused):
                f.owner.finish()

    def test_nonzero_direct_closure_remains_a_refusal(self):
        with patch.object(SUBJECT, "GIT_OWNERS", []):
            f = self.fixture(code=1)
            f.owner.submit()
            f.owner.keep()
            self.assertTrue(f.owner.closed())
            with self.assertRaises(SUBJECT.WebPreparationRefused):
                f.owner.finish()

    def test_unknown_pipe_custody_is_retained_without_forced_close(self):
        with patch.object(SUBJECT, "GIT_OWNERS", []):
            f = self.fixture(bad_pipe=True)
            f.owner.submit()
            f.owner.observe_clock()
            self.assertFalse(f.owner.direct_closed())
            self.assertIn(f.owner, SUBJECT.GIT_OWNERS)
            self.assertTrue(any(reason == "pipe-unknown" for reason, _ in f.owner.failures))
            f.child.stdout.close.assert_not_called()

    def test_submitted_none_or_awaitable_is_never_reclassified_predispatch(self):
        class OrdinaryAwaitable:
            def __await__(self):
                raise AssertionError("Never await an unknown launch")
        for unknown in (None, OrdinaryAwaitable()):
            with self.subTest(kind=type(unknown).__name__), patch.object(SUBJECT, "GIT_OWNERS", []):
                f = self.fixture()
                f.launch.return_value = unknown
                f.owner.submit()
                self.assertTrue(f.owner.launch_issued)
                self.assertTrue(f.owner.dispatch_pending)
                self.assertFalse(f.owner.closed())
                self.assertIn(f.owner, SUBJECT.GIT_OWNERS)
                with self.assertRaises(SUBJECT.WebPreparationRefused):
                    f.owner.submit()
                self.assertEqual(f.launch.call_count, 1)


if __name__ == "__main__":
    with contextlib.ExitStack() as boundary:
        for target in ("socket.create_connection", "subprocess.Popen", "os.open", "os.mkdir", "os.unlink",
                       "os.remove", "os.rmdir", "os.chmod", "os.chown", "threading.Thread"):
            boundary.enter_context(patch(target, side_effect=AssertionError("Real effect port is closed")))
        unittest.main()
