"""Literal offline controls. No host/app/display/network/package action is invoked."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import gzip
import tarfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/ci" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load("test_native_host", "linux-native-host.py")
INPUTS = load("test_native_inputs", "linux-native-inputs.py")
ELF = load("test_native_elf", "linux-native-elf.py")
DRIVER = load("test_native_driver", "run-linux-native-baseline.py")
PROFILE = json.loads((ROOT / "scripts/ci/linux-native-inputs.json").read_text())


class Controls(unittest.TestCase):
    def environment(self):
        sha = "a" * 40
        return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub",
                "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + PROFILE["branch"],
                "GITHUB_JOB": PROFILE["job"], "GITHUB_RUN_ATTEMPT": "1", "RUNNER_OS": "Linux",
                "RUNNER_ARCH": "X64", "RUNNER_ENVIRONMENT": "github-hosted", "ImageOS": "ubuntu22",
                "ImageVersion": PROFILE["imageVersion"],
                "GITHUB_SHA": sha, "GITHUB_WORKFLOW_SHA": sha,
                "GITHUB_WORKFLOW_REF": "brucerry/embedded-linux-diagnostic-hub/" + PROFILE["workflow"] +
                "@refs/heads/" + PROFILE["branch"]}

    def test_exact_context(self):
        self.assertEqual(HOST.admit(self.environment(), {"uid": 1000, "euid": 1000,
            "system": "Linux", "machine": "x86_64"}, PROFILE), "a" * 40)

    def test_context_refuses_rerun_host_privilege_route_or_source_change(self):
        for patch_env in [{"GITHUB_RUN_ATTEMPT": "2"}, {"ImageOS": "ubuntu24"},
                          {"GITHUB_REF": "refs/heads/main"}, {"HTTP_PROXY": "fixture"},
                          {"GITHUB_WORKFLOW_SHA": "b" * 40}, {"NODE_OPTIONS": "fixture"}]:
            with self.subTest(patch_env=patch_env), self.assertRaises(HOST.Refused):
                HOST.admit({**self.environment(), **patch_env}, {"uid": 1000, "euid": 1000,
                    "system": "Linux", "machine": "x86_64"}, PROFILE)
        with self.assertRaises(HOST.Refused):
            HOST.admit(self.environment(), {"uid": 0, "euid": 0, "system": "Linux", "machine": "x86_64"}, PROFILE)

    def test_policy_metadata_is_necessary_only(self):
        good = {"userns": "1", "maxUserns": "100", "apparmorRestriction": "absent",
                "apparmorProfile": "unconfined", "seccomp": "0", "effectiveCaps": "00"}
        self.assertEqual(HOST.policy(good), "necessary-metadata-ready")
        for changed in [{"userns": "0"}, {"maxUserns": "0"}, {"apparmorRestriction": "1"},
                        {"apparmorProfile": "fixture-confined"}, {"seccomp": "2"}, {"effectiveCaps": "01"}]:
            with self.subTest(changed=changed), self.assertRaises(HOST.Refused):
                HOST.policy({**good, **changed})

    def test_rejected_parent_stops_before_descendants(self):
        calls = []
        def lstat(path):
            calls.append(str(path))
            return SimpleNamespace(st_mode=stat.S_IFDIR | (0o777 if str(path) == "/owned" else 0o755),
                                   st_uid=0, st_ino=2, st_dev=1)
        port = SimpleNamespace(lstat=lstat, path=SimpleNamespace(realpath=lambda p: str(p)))
        with self.assertRaises(HOST.Refused):
            HOST.safe_directory(Path("/owned/deeper"), 1000, port)
        self.assertEqual(calls, ["/", "/owned"])

    def test_x11_authentication_packet_and_refusals(self):
        cookie = bytes(range(16));packet = HOST.setup_request(cookie)
        self.assertEqual(struct.unpack("<BBHHHHH", packet[:12]), (108, 0, 11, 0, 18, 16, 0))
        self.assertEqual(packet[12:30], b"MIT-MAGIC-COOKIE-1")
        self.assertEqual(packet[-16:], cookie)
        HOST.check_setup_response(struct.pack("<BBHHH", 1, 0, 11, 0, 2), bytes(8))
        for header, body in [(struct.pack("<BBHHH", 0, 0, 11, 0, 2), bytes(8)),
                             (struct.pack("<BBHHH", 1, 0, 10, 0, 2), bytes(8)),
                             (struct.pack("<BBHHH", 1, 0, 11, 0, 2), bytes(7))]:
            with self.assertRaises(HOST.Refused):
                HOST.check_setup_response(header, body)

    def test_changed_display_process_refuses_before_socket_creation(self):
        with patch.object(HOST.socket, "socket", side_effect=AssertionError("closed port")):
            with self.assertRaises(HOST.Refused):
                HOST.authenticate_display(bytes(16), {"pid": 42, "startTicks": 1},
                                          lambda pid: {"pid": 42, "startTicks": 2})

    def test_authenticated_owned_display_protocol_with_memory_socket_only(self):
        original = {"pid": 42, "startTicks": 1}
        class Channel:
            def __init__(self, uid):
                self.uid = uid
                self.data = io.BytesIO(struct.pack("<BBHHH", 1, 0, 11, 0, 2) + bytes(8))
                self.sent = None
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def settimeout(self, seconds): self.timeout = seconds
            def connect(self, name): self.name = name
            def getsockopt(self, *args): return struct.pack("3i", 42, self.uid, 1000)
            def sendall(self, data): self.sent = data
            def recv(self, size): return self.data.read(size)
        good = Channel(HOST.os.getuid())
        with patch.object(HOST.socket, "socket", return_value=good):
            HOST.authenticate_display(bytes(16), original, lambda pid: original)
        self.assertEqual(good.sent, HOST.setup_request(bytes(16)))
        wrong = Channel(HOST.os.getuid() + 1)
        with patch.object(HOST.socket, "socket", return_value=wrong), self.assertRaises(HOST.Refused):
            HOST.authenticate_display(bytes(16), original, lambda pid: original)
        self.assertIsNone(wrong.sent)

    def test_public_lock_exact_positive(self):
        data = (ROOT / "package-lock.json").read_bytes()
        self.assertEqual(len(INPUTS.validate_lock(data, PROFILE)), 416)

    def test_lock_mismatch_refuses_and_other_source_never_becomes_admitted(self):
        data = (ROOT / "package-lock.json").read_bytes()
        with self.assertRaises(INPUTS.InputRefused):
            INPUTS.validate_lock(data + b" ", PROFILE)
        for change in [{"resolved": "file:fixture"}, {"resolved": "https://unapproved.invalid/fixture"},
                       {"integrity": "sha512-AAAA"}]:
            value = json.loads(data)
            name = next(k for k in value["packages"] if k)
            value["packages"][name].update(change)
            synthetic = json.dumps(value).encode()
            with self.assertRaises(ValueError):
                INPUTS.validate_lock(synthetic, {**PROFILE, "lockSHA256": hashlib.sha256(synthetic).hexdigest()})

    def test_download_verification_before_interpretation(self):
        data = b"benign inert transport fixture"
        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Length": str(len(data))}
        opener = SimpleNamespace(open=lambda *a, **k: Response(data))
        pin = {"url": "https://nodejs.org/dist/fixture", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        self.assertEqual(INPUTS.fetch_exact(pin, opener=opener), data)
        with self.assertRaises(INPUTS.InputRefused):
            INPUTS.fetch_exact({**pin, "sha256": "a" * 64}, opener=opener)
        with patch.object(INPUTS.PUBLISHER, "inspect_distribution", side_effect=AssertionError("closed parser")):
            with self.assertRaises(INPUTS.InputRefused):
                INPUTS.inspect_node(data, PROFILE)

    def test_environment_and_commands_have_no_inherited_credentials_or_publication(self):
        env = INPUTS.child_environment(Path("/owned"), Path("/owned/sdk"), Path("/source"))
        self.assertEqual(env["NPM_CONFIG_IGNORE_SCRIPTS"], "true")
        self.assertEqual(env["NPM_CONFIG_REGISTRY"], "https://registry.npmjs.org/")
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertNotIn("NODE_OPTIONS", env)
        commands = INPUTS.build_commands(Path("/source"), Path("/owned"), Path("/owned/sdk"))
        self.assertEqual([x[0] for x in commands], ["dependencies", "frontend", "native", "package"])
        self.assertIn("--ignore-scripts", commands[0][1])
        self.assertIn("dir", commands[-1][1])
        self.assertNotIn("AppImage", commands[-1][1])
        self.assertNotIn("tar.gz", commands[-1][1])
        self.assertEqual(commands[-1][1][commands[-1][1].index("--publish") + 1], "never")

    def test_literal_header_read_is_hash_checked_after_existing_archive_parser(self):
        body = b"ordinary inert header fixture\n"
        raw = io.BytesIO()
        name = "include/node/node_api.h"
        with tarfile.open(fileobj=raw, mode="w") as archive:
            info = tarfile.TarInfo(INPUTS.PUBLISHER.NODE_ARCHIVE["root"] + "/" + name)
            info.size = len(body);info.mode = 0o644
            archive.addfile(info, io.BytesIO(body))
        data = gzip.compress(raw.getvalue(), mtime=0)
        synthetic = {"nodeDistribution": {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()},
                     "node": {}, "headers": [{"path": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}]}
        with patch.object(INPUTS.PUBLISHER, "inspect_distribution", return_value={}) as existing:
            result = INPUTS.inspect_node(data, synthetic)
            self.assertEqual(result[name], body);self.assertEqual(existing.call_count, 1)
        synthetic["headers"][0]["sha256"] = "a" * 64
        with patch.object(INPUTS.PUBLISHER, "inspect_distribution", return_value={}):
            with self.assertRaises(INPUTS.InputRefused):
                INPUTS.inspect_node(data, synthetic)

    def test_actor_failure_or_uncertain_close_never_becomes_success(self):
        positive = {"schema": 1, "status": "pass", "reason": "none", "closeIssued": True,
                    "closure": True, "qualified": False, "scope": "public-native-baseline-only"}
        DRIVER.validate_actor_result(positive, 0)
        for changed in [{"closure": False}, {"closeIssued": False}, {"qualified": True}]:
            with self.assertRaises(DRIVER.HOST.Refused):
                DRIVER.validate_actor_result({**positive, **changed}, 0)
        with self.assertRaises(DRIVER.HOST.Refused):
            DRIVER.validate_actor_result(positive, 1)
        negative = {**positive, "status": "fail", "reason": "close", "closure": False}
        DRIVER.validate_actor_result(negative, 1)

    def test_elf_parser_has_specific_needed_and_version_edges(self):
        deps, paths = ELF.dynamic(' 0x1 (NEEDED) Shared library: [libc.so.6]\n 0xf (RUNPATH) Library runpath: [$ORIGIN]')
        self.assertEqual(deps, ["libc.so.6"]);self.assertEqual(paths, ["$ORIGIN"])
        req, provided = ELF.versions("Version definition section '.gnu.version_d':\n Name: GLIBC_2.35\nVersion needs section '.gnu.version_r':\n File: libc.so.6\n Name: GLIBC_2.34")
        self.assertEqual(req, {"libc.so.6": {"GLIBC_2.34"}});self.assertEqual(provided, {"GLIBC_2.35"})
        with self.assertRaises(ELF.ElfRefused):
            ELF.dynamic(' (NEEDED) Shared library: [../fixture]')

    def test_report_requires_exact_source_and_complete_verified_close(self):
        source = "a" * 40
        result = {"status": "pass", "stage": "complete", "reason": "none", "source": source,
                  "scope": "public-native-baseline-only", "qualified": False,
                  "normalAppAndOwnedDisplayClosed": True}
        self.assertEqual(DRIVER.classify_report(result, source)["status"], "pass")
        for changed in [{"normalAppAndOwnedDisplayClosed": False}, {"source": "b" * 40},
                        {"stage": "host"}, {"qualified": True}, {"reason": "unbounded fixture text"}]:
            with self.subTest(changed=changed), self.assertRaises(DRIVER.HOST.Refused):
                DRIVER.classify_report({**result, **changed}, source)
        with self.assertRaises(DRIVER.HOST.Refused):
            DRIVER.classify_report({}, source)
        failure = {"status": "fail", "stage": "runtime", "reason": "deadline", "source": source,
                   "qualified": False, "pendingOwnedResource": True}
        self.assertEqual(DRIVER.classify_report(failure, source)["status"], "fail")


if __name__ == "__main__":
    unittest.main()
