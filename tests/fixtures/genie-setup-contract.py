"""Filesystem/desktop API contract tests; these do not qualify compositor rendering."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
source, old_zip, new_zip, *formats = sys.argv[1:]
companion_format = formats[0] if formats else "modern"
sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location("genie_setup", source)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def build_of(archive):
    with zipfile.ZipFile(archive) as package:
        return json.loads(package.read("metadata.json"))["diagnostic-hub"]


class SetupContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hub-genie-contract-")
        self.root = Path(self.temporary.name)
        self.data = self.root / "user data"
        self.app = self.root / 'app with spaces % $ " quote.AppImage'
        self.app.write_bytes(b"verified application fixture")
        self.settings = {"enabled-extensions": ["another-extension@example.com"],
                         "disable-user-extensions": False}
        self.calls = []
        self.loaded = None
        self.fail_write = False
        self.environment = patch.dict(os.environ, {"XDG_DATA_HOME": str(self.data)})
        self.environment.start()
        self.commands = patch.object(setup, "command", self.command)
        self.commands.start()

    def tearDown(self):
        self.commands.stop()
        self.environment.stop()
        self.temporary.cleanup()

    def command(self, args, required=True):
        self.calls.append(args)
        if args[0] == "gsettings":
            key = args[3]
            if args[1] == "get":
                value = self.settings[key]
                return repr(value) if isinstance(value, list) else str(value).lower()
            updated = __import__("ast").literal_eval(args[4])
            if self.fail_write and setup.UUID in updated:
                self.fail_write = False
                raise RuntimeError("Injected settings write failure")
            self.settings[key] = updated
            return ""
        if args[0] == "gnome-extensions":
            return None  # First-install discovery/cached code cannot prove fresh activation.
        if args[0] == "gdbus":
            return repr((json.dumps(self.loaded),)) if self.loaded else None
        raise AssertionError(args)

    def args(self, archive=old_zip, appimage=True):
        build = build_of(archive)
        return SimpleNamespace(archive=archive, version=build["version"],
                               commit=build["commit"], format=companion_format, app=str(self.app), appimage=appimage,
                               app_sha256=hashlib.sha256(self.app.read_bytes()).hexdigest())

    def install(self, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            setup.install(args or self.args())
        return output.getvalue()

    def test_first_install_pending_repeat_and_observable_live_activation(self):
        output = self.install()
        self.assertIn("pending activation", output)
        self.assertIn("installed bytes", output)
        self.assertEqual(self.settings["enabled-extensions"], ["another-extension@example.com", setup.UUID])
        _data, extension, desktop, icon = setup.paths()
        record = setup.managed(extension, desktop, icon)
        self.assertEqual(record["build"], build_of(old_zip))
        self.assertIn("--appimage-extract-and-run", desktop.read_text())
        self.assertIn("%%", desktop.read_text())
        self.calls.clear()
        self.assertIn("pending activation", self.install())
        self.assertFalse(any(args[:2] in (["gsettings", "set"], ["gnome-extensions", "enable"]) for args in self.calls))
        self.loaded = {**record["build"], "active": True, "animations": True}
        self.assertIn("active for Diagnostic Hub", self.install())
        self.settings["enabled-extensions"].remove(setup.UUID)
        self.loaded = None
        self.assertIn("skipped", self.install())
        self.assertNotIn(setup.UUID, self.settings["enabled-extensions"])

    def test_global_policy_cached_update_and_rollback_preserve_unrelated_state(self):
        self.settings["disable-user-extensions"] = True
        self.assertIn("globally disabled", self.install())
        self.assertFalse(any(args[:2] == ["gnome-extensions", "enable"] for args in self.calls))
        self.settings["disable-user-extensions"] = False
        old = build_of(old_zip)
        self.loaded = {**old, "active": True, "animations": True}
        self.assertIn("pending activation", self.install(self.args(new_zip)))
        self.assertIn(["gnome-extensions", "disable", setup.UUID], self.calls)
        self.assertEqual(self.settings["enabled-extensions"], ["another-extension@example.com", setup.UUID])
        _data, extension, desktop, icon = setup.paths()
        current = setup.managed(extension, desktop, icon)
        self.fail_write = True
        with self.assertRaises(RuntimeError):
            self.install(self.args(old_zip))
        self.assertEqual(setup.managed(extension, desktop, icon), current)
        self.assertIn(setup.UUID, self.settings["enabled-extensions"])
        self.assertTrue(all(args[3] == "enabled-extensions" for args in self.calls if args[:2] == ["gsettings", "set"]))

    def test_symlinks_collisions_and_changed_source_are_preserved(self):
        self.data.mkdir()
        foreign = self.root / "foreign"
        foreign.mkdir()
        (self.data / "gnome-shell").symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(list(foreign.iterdir()), [])
        (self.data / "gnome-shell").unlink()
        desktop = self.data / "applications" / setup.APPLICATION_ID
        desktop.parent.mkdir()
        desktop.write_text("unmanaged shortcut")
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(desktop.read_text(), "unmanaged shortcut")
        desktop.unlink()
        self.install()
        _data, extension, desktop, icon = setup.paths()
        (extension / "extension.js").write_text("engineer's changed source")
        with self.assertRaises(ValueError):
            self.install(self.args(new_zip))
        with self.assertRaises(ValueError):
            setup.remove()
        self.assertEqual((extension / "extension.js").read_text(), "engineer's changed source")

    def test_managed_removal_preserves_downloads_and_other_files(self):
        self.install()
        unrelated = self.data / "gnome-shell/extensions/another-extension@example.com"
        unrelated.mkdir()
        (unrelated / "device.json").write_text("preserve")
        with contextlib.redirect_stdout(io.StringIO()):
            setup.remove()
            setup.remove()
        self.assertEqual(self.settings["enabled-extensions"], ["another-extension@example.com"])
        self.assertEqual((unrelated / "device.json").read_text(), "preserve")
        self.assertEqual(self.app.read_bytes(), b"verified application fixture")

    def test_archive_desktop_uses_persistent_verified_path_and_runtime_cleanup(self):
        self.app = self.root / "app archive with spaces.tar.gz"
        executable = b'#!/bin/sh\nprintf "%s" "$0" > "$HUB_GENIE_ARCHIVE_MARKER"\n'
        with tarfile.open(self.app, "w:gz") as archive:
            member = tarfile.TarInfo("Diagnostic Hub/AppRun")
            member.size = len(executable)
            member.mode = 0o700
            archive.addfile(member, io.BytesIO(executable))
        args = self.args(appimage=False)
        self.install(args)
        _data, extension, desktop, _icon = setup.paths()
        self.assertIn(str(extension / "setup.py"), desktop.read_text())
        self.assertIn("--launch-archive", desktop.read_text())
        marker = self.root / "launched"
        with patch.dict(os.environ, {"HUB_GENIE_ARCHIVE_MARKER": str(marker)}):
            self.assertEqual(setup.launch_archive(str(self.app), args.app_sha256), 0)
        self.assertFalse(Path(marker.read_text()).exists())
        marker.unlink()
        with self.assertRaises(ValueError):
            setup.launch_archive(str(self.app), "0" * 64)
        self.assertFalse(marker.exists())


unittest.main(verbosity=2)
