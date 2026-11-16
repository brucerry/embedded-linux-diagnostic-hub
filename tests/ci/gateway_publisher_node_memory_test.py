"""Literal synthetic cohort: no publisher archive, executable, network or disk effects.

Fixture digests authenticate only ordinary memory bytes. They never become host,
publisher, build or release evidence. Existing closed-port memory fixtures are reused.
"""

import contextlib
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SUBJECT = load("publisher_node_memory_subject", ROOT / "scripts/ci/prepare-gateway-publisher-node.py")
COMMON = SUBJECT.COMMON
FIXTURES = load("existing_preparation_memory_fixtures", ROOT / "tests/ci/gateway_four_tool_diagnostics_memory_test.py")
PROFILE = json.loads((ROOT / "scripts/ci/gateway-four-tool-inputs.json").read_bytes())
WORKFLOW = (ROOT / ".github/workflows/gateway-publisher-node-buildonly.yml").read_text()
NPM = "lib/node_modules/npm"


def fixture(long_name=False):
    files = {"bin/node": b"ordinary memory data, never executable", NPM: None,
             NPM + "/bin": None, NPM + "/bin/npm-cli.js": b"ordinary memory text",
             NPM + "/package.json": b'{"name":"npm","version":"11.19.1"}'}
    if long_name:
        files[NPM + "/component-" + "a" * 120 + ".js"] = b"ordinary long-name fixture"
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(SUBJECT.NODE_ARCHIVE["root"] + "/" + name)
            info.type = tarfile.DIRTYPE if data is None else tarfile.REGTYPE
            info.mode = 0o755 if data is None or name == "bin/node" else 0o644
            info.size = 0 if data is None else len(data)
            archive.addfile(info, None if data is None else io.BytesIO(data))
        for name, target in SUBJECT.IGNORED_LINKS.items():
            info = tarfile.TarInfo(SUBJECT.NODE_ARCHIVE["root"] + "/" + name)
            info.type, info.mode, info.linkname = tarfile.SYMTYPE, 0o777, target
            archive.addfile(info)
    data = gzip.compress(raw.getvalue(), mtime=0)
    spec = dict(SUBJECT.NODE_ARCHIVE, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    rows = []
    for name, body in files.items():
        if name.startswith(NPM + "/"):
            rows.append([name[len(NPM) + 1:], "directory" if body is None else "file",
                         None if body is None else len(body),
                         None if body is None else hashlib.sha256(body).hexdigest()])
    rows.sort(key=lambda row: row[0])
    node = dict(PROFILE["node"], bytes=len(files["bin/node"]),
                sha256=hashlib.sha256(files["bin/node"]).hexdigest(), npmEntries=len(rows),
                npmFileBytes=sum(row[2] or 0 for row in rows),
                npmInventorySHA256=hashlib.sha256(json.dumps(rows, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest())
    profile = copy.deepcopy(PROFILE)
    profile["node"] = node
    profile["reference"]["distributionSHA256"] = spec["sha256"]
    return SimpleNamespace(files=files, raw=raw.getvalue(), data=data, spec=spec, node=node, profile=profile)


class ParserTests(unittest.TestCase):
    def test_authentication_precedes_decoder(self):
        f = fixture()
        with patch.object(SUBJECT.gzip, "GzipFile", side_effect=AssertionError("Decoder must not run")) as decoder:
            with self.assertRaises(COMMON.PreparationRefused):
                SUBJECT.inspect_distribution(f.data, f.node, dict(f.spec, sha256="0" * 64))
            decoder.assert_not_called()

    def test_required_subset_and_exact_inert_links(self):
        f = fixture()
        members = SUBJECT.inspect_distribution(f.data, f.node, f.spec)
        self.assertEqual(members, f.files)
        self.assertTrue(all(name not in members for name in SUBJECT.IGNORED_LINKS))

    def test_known_gnu_long_names_are_bounded_data(self):
        f = fixture(long_name=True)
        self.assertEqual(SUBJECT.inspect_distribution(f.data, f.node, f.spec), f.files)

    def test_physical_and_expanded_limits_refuse(self):
        f = fixture(long_name=True)
        for expected in [dict(f.spec, maximumMembers=1),
                         dict(f.spec, maximumExpandedBytes=len(f.raw) - 1)]:
            with self.subTest(bound=list(k for k in expected if expected[k] != f.spec[k])):
                with self.assertRaises(COMMON.PreparationRefused):
                    SUBJECT.inspect_distribution(f.data, f.node, expected)

    def test_truncated_gzip_refuses_after_fixture_digest(self):
        f = fixture()
        data = f.data[:-8]
        spec = dict(f.spec, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        with self.assertRaises(COMMON.PreparationRefused) as caught:
            SUBJECT.inspect_distribution(data, f.node, spec)
        self.assertEqual(caught.exception.reason, "archive-policy")

    def test_complete_npm_and_node_references_are_mandatory(self):
        f = fixture()
        cases = [dict(f.node, sha256="0" * 64), dict(f.node, npmEntries=f.node["npmEntries"] + 1),
                 dict(f.node, npmFileBytes=f.node["npmFileBytes"] + 1),
                 dict(f.node, npmInventorySHA256="0" * 64)]
        for node in cases:
            with self.subTest(changed=[k for k in node if node[k] != f.node[k]]):
                with self.assertRaises(COMMON.PreparationRefused):
                    SUBJECT.inspect_distribution(f.data, node, f.spec)


class AcquisitionTests(unittest.TestCase):
    @contextlib.contextmanager
    def ports(self, f, existing=False, directory_error=None, bad_data=None):
        environment = {"RUNNER_TEMP": "/fixture/private", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        fake_os = SimpleNamespace(environ=environment, path=SimpleNamespace(lexists=lambda _: existing))
        fetch = Mock(return_value=f.data if bad_data is None else bad_data)
        write, mkdir = Mock(), Mock()
        directory = Mock(side_effect=directory_error)
        with patch.object(SUBJECT, "NODE_ARCHIVE", f.spec), \
                patch.object(SUBJECT, "fetch_distribution", fetch), \
                patch.object(COMMON, "os", fake_os), patch.object(COMMON, "Path", FIXTURES.MemoryPath), \
                patch.object(COMMON, "directory", directory), patch.object(COMMON, "write", write), \
                patch.object(FIXTURES.MemoryPath, "mkdir", mkdir):
            yield SimpleNamespace(fetch=fetch, write=write, mkdir=mkdir, directory=directory)

    def test_new_prefix_only_owner_private_files_no_links(self):
        f = fixture()
        with self.ports(f) as ports:
            prefix = SUBJECT.acquire_node(f.profile)
        self.assertEqual(str(prefix), "/fixture/private/gateway-publisher-node-123-1")
        self.assertEqual(ports.fetch.call_count, 1)
        names = []
        for call in ports.write.call_args_list:
            name = call.args[0].relative_to(prefix).as_posix()
            names.append(name)
            mode = call.args[2] if len(call.args) > 2 else 0o600
            self.assertEqual(mode, 0o700 if name == "bin/node" else 0o600)
        self.assertIn("node-distribution.tar.gz", names)
        self.assertIn("publisher-input-reference.json", names)
        self.assertTrue(all(name not in names for name in SUBJECT.IGNORED_LINKS))
        self.assertTrue(all(call.kwargs.get("mode") == 0o700 for call in ports.mkdir.call_args_list))

    def test_unsafe_parent_stops_before_any_fetch_or_creation(self):
        f = fixture()
        with self.ports(f, directory_error=COMMON.PreparationRefused("mode")) as ports:
            with self.assertRaises(COMMON.PreparationRefused):
                SUBJECT.acquire_node(f.profile)
        ports.fetch.assert_not_called()
        ports.mkdir.assert_not_called()
        ports.write.assert_not_called()

    def test_existing_slot_is_refused_without_adoption(self):
        f = fixture()
        with self.ports(f, existing=True) as ports:
            with self.assertRaises(COMMON.PreparationRefused):
                SUBJECT.acquire_node(f.profile)
        ports.fetch.assert_not_called()
        ports.mkdir.assert_not_called()
        ports.write.assert_not_called()

    def test_replaced_transport_cannot_write_or_decode_bad_bytes(self):
        f = fixture()
        with self.ports(f, bad_data=b"ordinary wrong data") as ports, \
                patch.object(SUBJECT, "inspect_distribution") as inspect:
            with self.assertRaises(COMMON.PreparationRefused):
                SUBJECT.acquire_node(f.profile)
        ports.write.assert_not_called()
        inspect.assert_not_called()

    def test_input_reference_mismatch_stops_before_fetch(self):
        f = fixture()
        f.profile["reference"]["distributionSHA256"] = "0" * 64
        with self.ports(f) as ports:
            with self.assertRaises(COMMON.PreparationRefused):
                SUBJECT.acquire_node(f.profile)
        ports.directory.assert_not_called()
        ports.fetch.assert_not_called()

    def test_materialization_error_is_not_cleaned_or_retried(self):
        f = fixture()
        with self.ports(f) as ports:
            ports.write.side_effect = OSError("ordinary synthetic write failure")
            with self.assertRaises(OSError):
                SUBJECT.acquire_node(f.profile)
        self.assertEqual(ports.fetch.call_count, 1)
        self.assertEqual(ports.write.call_count, 1)


class FetchAndWiringTests(unittest.TestCase):
    def test_fixed_request_digest_and_no_retry(self):
        f = fixture()
        response = io.BytesIO(f.data)
        response.status, response.headers = 200, {"Content-Length": str(len(f.data))}
        response.geturl = lambda: f.spec["url"]
        opener = SimpleNamespace(open=Mock(return_value=response))
        with patch.object(COMMON.urllib.request, "build_opener", return_value=opener), \
                patch.object(COMMON.ssl, "create_default_context", return_value=None):
            self.assertEqual(SUBJECT.fetch_distribution(f.spec), f.data)
        self.assertEqual(opener.open.call_count, 1)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, SUBJECT.NODE_ARCHIVE["url"])
        self.assertFalse(any(k.lower() in ("authorization", "cookie") for k in request.headers))

    def test_fetch_length_mismatch_refuses_without_read(self):
        f = fixture()
        response = Mock(status=200, headers={"Content-Length": str(len(f.data) + 1)})
        response.geturl.return_value = f.spec["url"]
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = SimpleNamespace(open=Mock(return_value=response))
        with patch.object(COMMON.urllib.request, "build_opener", return_value=opener), \
                patch.object(COMMON.ssl, "create_default_context", return_value=None):
            with self.assertRaises(COMMON.PreparationRefused):
                SUBJECT.fetch_distribution(f.spec)
        response.read.assert_not_called()
        self.assertEqual(opener.open.call_count, 1)

    def test_entry_calls_guarded_collector_with_fixed_provider_and_branch(self):
        with patch.object(COMMON, "collect_diagnostic", return_value=1) as collect:
            self.assertEqual(SUBJECT.entry(), 1)
        collect.assert_called_once_with(node_provider=SUBJECT.acquire_node, expected_branch=SUBJECT.BRANCH)

    def test_real_shared_main_uses_provider_then_same_integrity_and_four_tools(self):
        original = COMMON.main
        with patch.object(FIXTURES, "SUBJECT", COMMON):
            f = FIXTURES.PreparationFixture()
            f.environment["GITHUB_REF"] = "refs/heads/" + SUBJECT.BRANCH
            selected = FIXTURES.MemoryPath("/fixture/private/publisher")
            provider = Mock(return_value=selected)
            with patch.object(COMMON, "main", side_effect=lambda: original(
                    node_provider=provider, expected_branch=SUBJECT.BRANCH)):
                result, _ = f.run()
        self.assertEqual(result, 0)
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(f.reports, [("prepared", "complete", "none", "none")])
        self.assertFalse(any(stage == "cache-selection" and kind == "directory" for stage, kind, _ in f.calls))
        self.assertEqual(sum(kind == "download" for _, kind, _ in f.calls), 4)

    def test_workflow_never_selects_cache_or_changes_global_state(self):
        self.assertNotIn("RUNNER_TOOL_CACHE", WORKFLOW)
        self.assertNotIn("GITHUB_PATH", WORKFLOW)
        self.assertNotIn("GITHUB_ENV", WORKFLOW)
        self.assertIn('"$RUNNER_TEMP/gateway-publisher-node-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/bin/node"', WORKFLOW)
        self.assertIn("run: /usr/bin/python3 -I -B scripts/ci/prepare-gateway-publisher-node.py", WORKFLOW)
        self.assertIn("steps.preparation.outputs.result == 'prepared'", WORKFLOW)
        self.assertEqual(SUBJECT.NODE_ARCHIVE["bytes"], 58299872)
        self.assertEqual(SUBJECT.NODE_ARCHIVE["maximumMembers"], 10000)


if __name__ == "__main__":
    with contextlib.ExitStack() as boundary:
        for target in ("socket.create_connection", "subprocess.Popen", "os.open",
                       "os.unlink", "os.remove", "os.rmdir", "os.mkdir"):
            boundary.enter_context(patch(target, side_effect=AssertionError("Real effect port is closed")))
        unittest.main()
