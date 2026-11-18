import os
from pathlib import Path
import runpy
import stat
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, mock_open, patch


source = Path(__file__).resolve().parents[1] / "scripts/ci/linux-folder-host-check.py"
probe = runpy.run_path(str(source))
Refusal = probe["Refusal"]
HOME = "/synthetic/runner"
PREFIX = HOME + "/host-check"
UID = 1001


def row(owner=UID, mode=stat.S_IFDIR | 0o700, inode=27):
    return SimpleNamespace(st_uid=owner, st_mode=mode, st_ino=inode)


def environment():
    return {
        "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": probe["REPOSITORY"],
        "GITHUB_EVENT_NAME": "push", "GITHUB_REF": probe["REF"],
        "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34", "GITHUB_JOB": "host_check",
        "GITHUB_SHA": "a" * 40, "GITHUB_WORKFLOW_SHA": "a" * 40,
        "GITHUB_WORKFLOW_REF": f'{probe["REPOSITORY"]}/{probe["WORKFLOW"]}@{probe["REF"]}',
        "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
        "RUNNER_ARCH": "X64", "ImageOS": "ubuntu22",
    }


class HostCheck(unittest.TestCase):
    def test_exact_hosted_context(self):
        probe["admit"](environment(), UID, UID, "Linux", "x86_64")

    def test_refuses_changed_metadata_or_host_identity(self):
        for key, value in (
            ("GITHUB_EVENT_NAME", "workflow_dispatch"),
            ("GITHUB_RUN_ATTEMPT", "2"),
            ("GITHUB_REF", "refs/tags/v0.6.0"),
            ("GITHUB_WORKFLOW_SHA", "b" * 40),
            ("RUNNER_ENVIRONMENT", "self-hosted"),
        ):
            with self.subTest(key=key), self.assertRaisesRegex(Refusal, "^admission$"):
                probe["admit"]({**environment(), key: value}, UID, UID, "Linux", "x86_64")
        for uid, euid, machine in ((0, 0, "x86_64"), (UID, 0, "x86_64"), (UID, UID, "arm64")):
            with self.subTest(uid=uid, machine=machine), self.assertRaisesRegex(Refusal, "^admission$"):
                probe["admit"](environment(), uid, euid, "Linux", machine)

    def test_ancestry_visits_root_and_all_parents_in_order(self):
        lstat = Mock(side_effect=[row(owner=0), row(owner=0), row(inode=9007199254740991)])
        probe["parents"](HOME, UID, lstat, lambda path: path)
        self.assertEqual([str(call.args[0]) for call in lstat.call_args_list], ["/", "/synthetic", HOME])

    def test_original_owner_mode_inode_type_and_metadata_refusals(self):
        for entry, bucket in (
            (row(owner=65534), "parent-owner"),
            (row(mode=stat.S_IFDIR | 0o0702), "parent-mode"),
            (row(mode=stat.S_IFDIR | 0o2700), "parent-mode"),
            (row(inode=9007199254740992), "parent-inode"),
            (row(inode=0), "parent-inode"),
            (row(mode=stat.S_IFLNK | 0o700), "parent-type"),
            (PermissionError("private path omitted"), "parent-metadata"),
        ):
            with self.subTest(bucket=bucket), self.assertRaisesRegex(Refusal, "^" + bucket + "$"):
                probe["parents"](HOME, UID, Mock(side_effect=[entry]), lambda path: path)

    def test_resolved_path_cannot_substitute_for_original_parent(self):
        with self.assertRaisesRegex(Refusal, "^parent-alias$"):
            probe["parents"](HOME, UID, lambda _: row(), lambda _: "/different")

    def test_canonical_account_home_required_before_allocation(self):
        for account, canonical in (("/different-account", HOME), (HOME, "/different-path")):
            check, make = Mock(), Mock()
            with self.subTest(account_matches=account == HOME):
                with patch.object(os.path, "realpath", return_value=canonical):
                    with self.assertRaisesRegex(Refusal, "^home$"):
                        probe["allocate"](HOME, account, UID, check, make)
                check.assert_not_called()
                make.assert_not_called()

    def test_refused_home_ancestry_does_not_make_a_prefix(self):
        check, make = Mock(side_effect=Refusal("parent-owner")), Mock()
        with patch.object(os.path, "realpath", return_value=HOME):
            with self.assertRaisesRegex(Refusal, "^parent-owner$"):
                probe["allocate"](HOME, HOME, UID, check, make)
        check.assert_called_once_with(HOME, UID)
        make.assert_not_called()

    def test_prefix_allocation_order_and_final_ownership(self):
        calls = Mock()
        calls.make.return_value = PREFIX
        with patch.object(os.path, "realpath", return_value=HOME):
            with patch.object(Path, "lstat", return_value=row()):
                self.assertEqual(probe["allocate"](HOME, HOME, UID, calls.check, calls.make), PREFIX)
            with patch.object(Path, "lstat", return_value=row(owner=0)):
                with self.assertRaisesRegex(Refusal, "^prefix$"):
                    probe["allocate"](HOME, HOME, UID, Mock(), Mock(return_value=PREFIX))
        self.assertEqual(
            [(c[0], c.args, c.kwargs) for c in calls.mock_calls],
            [("check", (HOME, UID), {}), ("make", (), {"prefix": "hub-folder-host-", "dir": HOME}),
             ("check", (PREFIX, UID), {})],
        )

    def test_rename_refuses_if_required_symbol_is_missing(self):
        with patch.object(probe["ctypes"], "CDLL", return_value=object()):
            with self.assertRaisesRegex(Refusal, "^rename$"):
                probe["rename_probe"](PREFIX)

    def test_only_fixed_inert_child_with_bounds_and_original_home(self):
        run = Mock(return_value=SimpleNamespace(
            returncode=0, stdout=b"pty-closed\n", stderr=b"inert-stderr\n",
        ))
        probe["closure_probe"](PREFIX, HOME, run)
        self.assertEqual(run.call_args.args[0], ["/usr/bin/python3", "-I", "-B", "-c", probe["PTY_STUB"]])
        self.assertEqual(run.call_args.kwargs["timeout"], 4)
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": HOME, "LC_ALL": "C"})

    def test_timeout_missing_pipe_marker_and_signal_are_refused(self):
        for run in (
            Mock(side_effect=subprocess.TimeoutExpired("inert", 4)),
            Mock(return_value=SimpleNamespace(returncode=0, stdout=b"pty-closed\n", stderr=b"")),
            Mock(return_value=SimpleNamespace(returncode=-15, stdout=b"pty-closed\n", stderr=b"inert-stderr\n")),
        ):
            with self.assertRaisesRegex(Refusal, "^closure$"):
                probe["closure_probe"](PREFIX, HOME, run)

    def test_outputs_only_fixed_buckets(self):
        main = probe["main"]
        for failure, code, expected in (
            (None, 0, "status=pass\nbucket=none\n"),
            (Refusal("parent-mode"), 1, "status=fail\nbucket=parent-mode\n"),
            (Refusal("sensitive details"), 1, "status=fail\nbucket=unexpected\n"),
            (RuntimeError("sensitive details"), 1, "status=fail\nbucket=unexpected\n"),
        ):
            output = mock_open()
            with patch.dict(main.__globals__, {"check": Mock(side_effect=failure)}):
                with patch.dict(os.environ, {"GITHUB_OUTPUT": "/synthetic/report"}):
                    with patch("builtins.open", output):
                        self.assertEqual(main(), code)
            output().write.assert_called_once_with(expected)


if __name__ == "__main__":
    unittest.main()
