"""Hosted Linux folder installer host check. Only an inert child can be executed."""

import ctypes
import errno
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile


REPOSITORY = "brucerry/embedded-linux-diagnostic-hub"
REF = "refs/heads/ci/v060-linux-folder-host-probe-20261118"
WORKFLOW = ".github/workflows/linux-folder-host-check.yml"
BUCKETS = frozenset({
    "admission", "home", "parent-type", "parent-inode", "parent-owner",
    "parent-mode", "parent-alias", "parent-metadata", "prefix", "rename", "closure",
})


class Refusal(Exception):
    pass


def need(condition, bucket):
    if not condition:
        raise Refusal(bucket)


def admit(env, uid, euid, system, machine):
    expected = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": REPOSITORY,
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_REF": REF,
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_JOB": "host_check",
        "GITHUB_WORKFLOW_REF": REPOSITORY + "/" + WORKFLOW + "@" + REF,
        "RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux",
        "RUNNER_ARCH": "X64",
        "ImageOS": "ubuntu22",
    }
    need(all(env.get(key) == value for key, value in expected.items()), "admission")
    sha = env.get("GITHUB_SHA", "")
    need(
        re.fullmatch("[a-f0-9]{40}", sha) and env.get("GITHUB_WORKFLOW_SHA") == sha
        and re.fullmatch("[1-9][0-9]{0,31}", env.get("GITHUB_RUN_ID", "")),
        "admission",
    )
    need(uid > 0 and uid == euid and system == "Linux" and machine == "x86_64", "admission")


def parents(directory, uid, lstat=Path.lstat, resolve=Path.resolve):
    # Match scripts/linux-owned-installation-pty.py:parents, including the root visit.
    current = Path("/")
    for component in ["", *Path(directory).parts[1:]]:
        current = current / component
        try:
            row = lstat(current)
            need(stat.S_ISDIR(row.st_mode) and not stat.S_ISLNK(row.st_mode), "parent-type")
            need(row.st_ino > 0 and row.st_ino <= 9007199254740991, "parent-inode")
            need(row.st_uid in (0, uid), "parent-owner")
            need(not row.st_mode & 0o7022, "parent-mode")
            need(str(resolve(current)) == str(current), "parent-alias")
        except OSError as error:
            raise Refusal("parent-metadata") from error


def allocate(home, account_home, uid, check_parents=parents, make=tempfile.mkdtemp):
    need(
        bool(home) and os.path.isabs(home) and os.path.realpath(home) == home
        and account_home == home,
        "home",
    )
    check_parents(home, uid)
    try:
        prefix = make(prefix="hub-folder-host-", dir=home)
    except OSError as error:
        raise Refusal("prefix") from error
    need(
        prefix.startswith(home + "/") and os.path.normpath(prefix) == prefix and len(prefix) <= 220,
        "prefix",
    )
    check_parents(prefix, uid)
    row = Path(prefix).lstat()
    need(row.st_uid == uid and stat.S_IMODE(row.st_mode) == 0o700, "prefix")
    return prefix


def rename_probe(prefix):
    try:
        rename = ctypes.CDLL(None, use_errno=True).renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        fd = os.open(prefix, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for leaf in ("source", "occupied"):
                os.mkdir(leaf, 0o700, dir_fd=fd)

            def identity(leaf):
                row = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                return row.st_dev, row.st_ino

            source, occupied = identity("source"), identity("occupied")
            need(
                rename(fd, b"source", fd, b"occupied", 1) == -1
                and ctypes.get_errno() == errno.EEXIST,
                "rename",
            )
            need(identity("source") == source and identity("occupied") == occupied, "rename")
            need(rename(fd, b"source", fd, b"moved", 1) == 0, "rename")
            need(identity("moved") == source, "rename")
            try:
                identity("source")
            except FileNotFoundError:
                pass
            else:
                raise Refusal("rename")
        finally:
            os.close(fd)
    except (AttributeError, OSError) as error:
        raise Refusal("rename") from error


PTY_STUB = r"""
import errno, os, pty, select, time
pid, fd = pty.fork()
if pid == 0:
    os.write(1, b"inert\n")
    os._exit(0)
status = None
eof = False
data = bytearray()
deadline = time.monotonic() + 2
try:
    while status is None or not eof:
        if time.monotonic() >= deadline:
            raise RuntimeError("inert deadline")
        if status is None:
            waited, row = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = row
        if eof:
            time.sleep(0.01)
            continue
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        try:
            part = os.read(fd, 32)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            part = b""
        data.extend(part)
        if len(data) > 32:
            raise RuntimeError("inert output bound")
        eof = not part
finally:
    os.close(fd)
if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0 or data.replace(b"\r\n", b"\n") != b"inert\n":
    raise RuntimeError("inert status")
os.write(1, b"pty-closed\n")
os.write(2, b"inert-stderr\n")
"""


def closure_probe(prefix, home, run=subprocess.run):
    try:
        # communicate (used by run) consumes both pipes through EOF and waits for the wrapper.
        result = run(
            ["/usr/bin/python3", "-I", "-B", "-c", PTY_STUB],
            cwd=prefix,
            env={"PATH": "/usr/bin:/bin", "HOME": home, "LC_ALL": "C"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=4,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal("closure") from error
    need(
        result.returncode == 0 and result.stdout == b"pty-closed\n"
        and result.stderr == b"inert-stderr\n",
        "closure",
    )


def check():
    uid, euid = os.getuid(), os.geteuid()
    system = os.uname()
    admit(os.environ, uid, euid, system.sysname, system.machine)
    home = os.environ.get("HOME", "")
    prefix = allocate(home, pwd.getpwuid(uid).pw_dir, uid)
    rename_probe(prefix)
    closure_probe(prefix, home)


def main():
    status, bucket = "fail", "unexpected"
    try:
        check()
        status, bucket = "pass", "none"
    except Refusal as error:
        if error.args and error.args[0] in BUCKETS:
            bucket = error.args[0]
    except Exception:
        pass
    try:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="ascii") as output:
            output.write("status=" + status + "\nbucket=" + bucket + "\n")
    except (KeyError, OSError):
        return 1
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
