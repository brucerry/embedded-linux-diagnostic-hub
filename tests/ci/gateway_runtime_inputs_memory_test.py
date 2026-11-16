"""Literal memory-only tests. Fixture pins never enter a production admission path.

Imports and inert checked-in JSON reads precede the closed native-effect boundary.
No fixture archive is downloaded, installed, executed or written to disk.
"""

import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "runtime_inputs", ROOT / "scripts/ci/prepare-gateway-runtime-inputs.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
LOCK = (ROOT / "package-lock.json").read_bytes()
PROFILE = (ROOT / "scripts/ci/gateway-runtime-inputs.json").read_bytes()


def archive(name="fixture", version="1.0.0", members=None, manifest=None):
    manifest = manifest or {"name": name, "version": version}
    rows = [("package/package.json", json.dumps(manifest).encode(), tarfile.REGTYPE, 0o644)]
    rows.extend(members or [])
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as writer:
        for path, body, kind, mode in rows:
            row = tarfile.TarInfo(path)
            row.type, row.mode, row.size = kind, mode, len(body)
            if kind == tarfile.SYMTYPE:
                row.linkname = "fixture-inert-target"
            writer.addfile(row, io.BytesIO(body) if row.isfile() else None)
    packed = gzip.compress(raw.getvalue(), mtime=0)
    pin = {"name": name, "version": version, "url": "https://registry.npmjs.org/" + name + "/-/fixture.tgz",
           "integrity": "sha512-" + base64.b64encode(hashlib.sha512(packed).digest()).decode()}
    return packed, pin


def resign(raw, pin):
    return {**pin, "integrity": "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()}


class Awaitable:
    def __await__(self):
        raise AssertionError("An unsupported awaitable must never be run")


class MemoryPorts:
    def __init__(self):
        self.data, self.pins = [], []
        for name in M.NAMES:
            raw, pin = archive(name=name, members=[("package/lib/fixture.js", b"fixture only", tarfile.REGTYPE, 0o664)])
            self.data.append(raw)
            self.pins.append(pin)
        self.fetches, self.closes, self.directories, self.writes = [], [], [], []
        self.events, self.clock = [], 0
        self.row_change = lambda row: row
        self.response_change = lambda row: row
        self.write_result = None
        self.mkdir_error = None

    def now(self):
        return self.clock

    def directory(self, path):
        return self.row_change({"path": path, "realpath": path, "uid": 1001,
                                "mode": 0o40700, "ino": 1, "dev": 1, "directory": True})

    def fetch(self, request):
        index = len(self.fetches)
        self.fetches.append(request)
        self.events.append("fetch")
        data = io.BytesIO(self.data[index])
        return self.response_change({"status": 200, "url": request["url"], "length": len(self.data[index]),
                                     "read": data.read, "close": lambda: self.closes.append(index)})

    def mkdir(self, path, mode):
        self.events.append("mkdir")
        if self.mkdir_error and path.endswith("node_modules"):
            raise self.mkdir_error
        self.directories.append((path, mode))

    def write(self, path, data, mode):
        self.events.append("write")
        self.writes.append((path, data, mode))
        return self.write_result

    def ports(self):
        return {"now": self.now, "fetch": self.fetch, "lstat_directory": self.directory,
                "mkdir_exclusive": self.mkdir, "write_exclusive": self.write}

    def prepare(self, install="/private/job/validation/gateway-runtime/install", checkout="/checkout"):
        # Mock only the separately tested frozen-pin boundary. Fetch, SRI verification,
        # archive parsing, orchestration and all native-effect ports use real code/memory.
        with mock.patch.object(M, "validate_runtime_inputs", return_value=self.pins):
            return M.prepare_runtime_inputs(LOCK, PROFILE, install,
                                           str(M.PurePosixPath(install).parent) + "/inputs/runtime-archives",
                                           checkout, 1001, self.ports())


class RuntimeInputsMemory(unittest.TestCase):
    def test_exact_original_source_and_five_pins(self):
        rows = M.validate_runtime_inputs(LOCK, PROFILE)
        self.assertEqual([row["name"] for row in rows], list(M.NAMES))
        self.assertEqual(len(rows), 5)
        self.assertTrue(all(row["url"].startswith("https://registry.npmjs.org/") for row in rows))

    def test_profile_and_source_tampering_fail_before_ports(self):
        profile = json.loads(PROFILE)
        profile["packages"][0]["url"] = "https://example.invalid/not-used"
        for lock, pins in [(LOCK + b" ", PROFILE), (LOCK, json.dumps(profile).encode())]:
            with self.subTest(source=lock == LOCK), self.assertRaises(M.RuntimeInputRefused):
                M.prepare_runtime_inputs(lock, pins, "/unused", "/unused", "/checkout", 1001, {})

    def test_duplicate_json_key_refused(self):
        with self.assertRaisesRegex(M.RuntimeInputRefused, "json-duplicate"):
            M.validate_runtime_inputs(LOCK, b'{"schemaVersion":1,"schemaVersion":1}')

    def test_boolean_schema_does_not_equal_integer_pin(self):
        profile = json.loads(PROFILE); profile["schemaVersion"] = True
        with self.assertRaisesRegex(M.RuntimeInputRefused, "input-profile"):
            M.validate_runtime_inputs(LOCK, json.dumps(profile).encode())

    def test_complete_fixture_content_and_scripts_stay_inert(self):
        raw, pin = archive(manifest={"name": "fixture", "version": "1.0.0", "scripts": {"install": "echo fixture-only"}},
                           members=[("package/install.js", b"fixture only", tarfile.REGTYPE, 0o664)])
        value = M.inspect_runtime_archive(raw, pin)
        self.assertEqual(value["files"]["install.js"], b"fixture only")

    def test_sri_is_checked_before_decoder(self):
        raw, pin = archive()
        with mock.patch.object(M.zlib, "decompressobj", side_effect=AssertionError("must not decode")):
            with self.assertRaisesRegex(M.RuntimeInputRefused, "archive-integrity"):
                M.inspect_runtime_archive(raw + b"changed", pin)

    def test_trailing_gzip_data_is_not_authenticated_content(self):
        raw, pin = archive()
        tampered = raw + raw
        with self.assertRaises(M.RuntimeInputRefused):
            M.inspect_runtime_archive(tampered, resign(tampered, pin))

    def test_only_existing_inert_initial_pax_comment_grammar_is_supported(self):
        raw, pin = archive()
        for char, accepted in [(b"a", True), (b"z", False)]:
            body = b"52 comment=" + char * 40 + b"\n"
            header = tarfile.TarInfo("pax_global_header")
            header.type, header.mode, header.size = tarfile.XGLTYPE, 0o666, len(body)
            changed = gzip.compress(header.tobuf(format=tarfile.USTAR_FORMAT) + body +
                                    b"\0" * (512 - len(body)) + gzip.decompress(raw), mtime=0)
            with self.subTest(accepted=accepted):
                if accepted:
                    self.assertIn("package.json", M.inspect_runtime_archive(changed, resign(changed, pin))["files"])
                else:
                    with self.assertRaisesRegex(M.RuntimeInputRefused, "pax-policy"):
                        M.inspect_runtime_archive(changed, resign(changed, pin))

    def test_archive_types_paths_aliases_and_native_members_refused(self):
        groups = [
            [("package/../outside", b"inert", tarfile.REGTYPE, 0o644)],
            [("package/link", b"", tarfile.SYMTYPE, 0o644)],
            [("package/addon.node", b"inert", tarfile.REGTYPE, 0o644)],
            [("package/node_modules/other/x", b"inert", tarfile.REGTYPE, 0o644)],
            [("package/FILE", b"inert", tarfile.REGTYPE, 0o644), ("package/file", b"inert", tarfile.REGTYPE, 0o644)],
            [("package/lib", b"inert", tarfile.REGTYPE, 0o644), ("package/lib/x", b"inert", tarfile.REGTYPE, 0o644)],
            [("package/special", b"inert", tarfile.REGTYPE, 0o4644)],
        ]
        for rows in groups:
            with self.subTest(rows=rows), self.assertRaises(M.RuntimeInputRefused):
                raw, pin = archive(members=rows)
                M.inspect_runtime_archive(raw, pin)

    def test_manifest_identity_and_closure_mismatch_refused(self):
        for manifest in [{"name": "other", "version": "1.0.0"},
                         {"name": "fixture", "version": "1.0.0", "dependencies": {"other": "1"}},
                         {"name": "fixture", "version": "1.0.0", "bin": {"fixture": "x.js"}}]:
            raw, pin = archive(manifest=manifest)
            with self.subTest(manifest=manifest), self.assertRaises(M.RuntimeInputRefused):
                M.inspect_runtime_archive(raw, pin)

    def test_archive_checksum_and_size_bounds(self):
        raw, pin = archive()
        packed = bytearray(gzip.decompress(raw)); packed[0] ^= 1
        changed = gzip.compress(bytes(packed), mtime=0)
        with self.assertRaisesRegex(M.RuntimeInputRefused, "tar-checksum"):
            M.inspect_runtime_archive(changed, resign(changed, pin))
        with mock.patch.dict(M.LIMITS, {"expanded": 1024}):
            with self.assertRaisesRegex(M.RuntimeInputRefused, "gzip-size"):
                M.inspect_runtime_archive(raw, pin)

    def test_all_five_verified_before_any_materialization(self):
        ports = MemoryPorts()
        value = ports.prepare()
        self.assertEqual(value["status"], "prepared-inputs-not-runtime")
        self.assertEqual(ports.events[:5], ["fetch"] * 5)
        self.assertEqual(ports.closes, list(range(5)))
        self.assertEqual(len(value["archives"]), 5)
        self.assertFalse(value["runtimeExecuted"])
        self.assertFalse(value["pending"])
        self.assertTrue(all(mode == 0o600 for _, _, mode in ports.writes))
        self.assertTrue(all(mode == 0o700 for _, mode in ports.directories))
        self.assertTrue(all(x["retries"] == 0 and not x["redirects"] and not x["credentials"] and
                            not x["proxy"] and not x["customTrust"] for x in ports.fetches))

    def test_last_input_tamper_retains_originals_without_filesystem_writes(self):
        ports = MemoryPorts(); ports.data[-1] += b"fixture tamper"
        with self.assertRaises(M.RuntimeInputRefused) as failure:
            ports.prepare()
        self.assertFalse(ports.writes or ports.directories)
        self.assertEqual(len(failure.exception.custody["archives"]), 5)
        self.assertEqual(ports.closes, list(range(5)))

    def test_endpoint_and_declared_length_refusals_close_response(self):
        for change in [{"url": "https://example.invalid/not-used"}, {"length": 16 * 1024**2 + 1}]:
            ports = MemoryPorts(); ports.response_change = lambda row: {**row, **change}
            with self.subTest(change=change), self.assertRaises(M.RuntimeInputRefused):
                ports.prepare()
            self.assertEqual(ports.closes, [0]); self.assertFalse(ports.writes)

    def test_deadline_and_backward_clock_refuse_before_writes(self):
        for end in [46, -1]:
            ports = MemoryPorts()
            original = ports.fetch
            def delayed(request):
                result = original(request); ports.clock = end; return result
            ports.fetch = delayed
            with self.subTest(end=end), self.assertRaises(M.RuntimeInputRefused):
                ports.prepare()
            self.assertEqual(ports.closes, [0]); self.assertFalse(ports.writes)

    def test_tiny_read_chunks_have_a_finite_bound(self):
        ports = MemoryPorts()
        def tiny(row):
            original = row["read"]
            return {**row, "read": lambda _: original(1)}
        ports.response_change = tiny
        with mock.patch.dict(M.LIMITS, {"chunksPerInput": 2}):
            with self.assertRaisesRegex(M.RuntimeInputRefused, "fetch-length"):
                ports.prepare()
        self.assertEqual(ports.closes, [0]); self.assertFalse(ports.writes)

    def test_first_read_error_preserved_when_close_also_fails(self):
        ports = MemoryPorts(); first = ValueError("private fixture read error")
        def broken(row):
            def read(_): raise first
            def close(): raise RuntimeError("private fixture close error")
            return {**row, "read": read, "close": close}
        ports.response_change = broken
        with self.assertRaises(M.RuntimeInputRefused) as failure:
            ports.prepare()
        self.assertIs(failure.exception.__cause__, first)
        self.assertEqual(len(failure.exception.custody["secondary"]), 1)
        self.assertEqual(len(failure.exception.custody["responses"]), 1)
        self.assertFalse(ports.writes)

    def test_existing_modules_slot_refused_without_cleanup(self):
        ports = MemoryPorts(); ports.mkdir_error = FileExistsError("fixture existing")
        with self.assertRaises(M.RuntimeInputRefused) as failure:
            ports.prepare()
        self.assertIs(failure.exception.__cause__, ports.mkdir_error)
        self.assertEqual(len(failure.exception.custody["archives"]), 5)
        self.assertEqual(len(ports.writes), 5)  # Retained originals only; never package writes.
        self.assertTrue(failure.exception.custody["pending"])

    def test_unknown_write_return_keeps_custody(self):
        ports = MemoryPorts(); unknown = Awaitable(); ports.write_result = unknown
        with self.assertRaisesRegex(M.RuntimeInputRefused, "unsupported-port-return") as failure:
            ports.prepare()
        self.assertIn(unknown, failure.exception.custody["unknownReturns"])
        self.assertTrue(failure.exception.custody["pending"])

    def test_async_fetch_factory_retained_without_adopting_owner(self):
        ports = MemoryPorts(); unknown = Awaitable(); ports.fetch = lambda _: unknown
        with self.assertRaises(M.RuntimeInputRefused) as failure:
            ports.prepare()
        self.assertIn(unknown, failure.exception.custody["unknownReturns"])
        self.assertFalse(ports.writes or ports.closes)

    def test_unsafe_parent_and_checkout_inheritance_refused_before_fetch(self):
        ports = MemoryPorts(); ports.row_change = lambda row: {**row, "mode": 0o40777}
        with self.assertRaises(M.RuntimeInputRefused): ports.prepare()
        self.assertFalse(ports.fetches)
        ports = MemoryPorts()
        with self.assertRaises(M.RuntimeInputRefused):
            ports.prepare(install="/checkout/validation/gateway-runtime/install")
        self.assertFalse(ports.fetches)

    def test_parent_identity_change_during_fetch_refused_before_writes(self):
        ports = MemoryPorts()
        ports.row_change = lambda row: {**row, "ino": 2 if len(ports.fetches) == 5 else 1}
        with self.assertRaisesRegex(M.RuntimeInputRefused, "directory-identity"):
            ports.prepare()
        self.assertEqual(len(ports.fetches), 5)
        self.assertFalse(ports.writes or ports.directories)

    def test_invalid_directory_mode_refused_before_fetch(self):
        for mode in [-0o100000 + 0o40700, 0o240700]:
            ports = MemoryPorts()
            ports.row_change = lambda row: {**row, "mode": mode}
            with self.subTest(mode=mode), self.assertRaises(M.RuntimeInputRefused):
                ports.prepare()
            self.assertFalse(ports.fetches or ports.writes or ports.directories)

    def test_aggregate_member_bound_precedes_materialization(self):
        ports = MemoryPorts()
        with mock.patch.dict(M.LIMITS, {"entriesTotal": 5}):
            with self.assertRaisesRegex(M.RuntimeInputRefused, "aggregate-bounds"):
                ports.prepare()
        self.assertFalse(ports.writes or ports.directories)


if __name__ == "__main__":
    # Any accidental native allocation makes the literal cohort fail immediately.
    def closed(*_args, **_kwargs):
        raise AssertionError("Native effects are closed in runtime-input memory controls")
    with mock.patch("builtins.open", closed), mock.patch.object(socket, "socket", closed), \
         mock.patch.object(socket, "create_connection", closed), mock.patch.object(subprocess, "Popen", closed), \
         mock.patch.object(os, "open", closed), mock.patch.object(os, "mkdir", closed), \
         mock.patch.object(os, "unlink", closed), mock.patch.object(os, "remove", closed), \
         mock.patch.object(os, "rmdir", closed):
        unittest.main()
