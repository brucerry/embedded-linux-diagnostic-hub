"""Fixed-path host prerequisites and normal X11 setup authentication.

Metadata is eligibility evidence only; renderer behavior is checked separately.
No namespace creation, security-setting change, package install or app on import.
"""
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time

REASONS = frozenset(("admission", "source", "product-policy", "custody", "tool", "sandbox",
                     "display-slot", "display-ready", "display-auth", "input", "lock", "endpoint",
                     "integrity", "archive", "dependencies", "child", "deadline", "output",
                     "launch", "window", "renderer", "interaction", "close", "report", "unexpected"))
STAGES = frozenset(("admission", "host", "inputs", "dependencies", "frontend", "native", "package", "libraries",
                    "display", "runtime", "complete", "report"))
DISPLAY = 177


class Refused(ValueError):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else "unexpected"
        super().__init__("Public native baseline refused")


def need(value, reason):
    if not value:
        raise Refused(reason)


def admit(environment, actual, profile):
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub",
                "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/" + profile["branch"],
                "GITHUB_JOB": profile["job"], "GITHUB_RUN_ATTEMPT": "1", "RUNNER_OS": "Linux",
                "RUNNER_ARCH": "X64", "RUNNER_ENVIRONMENT": "github-hosted", "ImageOS": "ubuntu22",
                "ImageVersion": profile["imageVersion"]}
    need(all(environment.get(k) == v for k, v in expected.items()), "admission")
    sha = environment.get("GITHUB_SHA", "")
    need(re.fullmatch("[a-f0-9]{40}", sha) and environment.get("GITHUB_WORKFLOW_SHA") == sha and
         environment.get("GITHUB_WORKFLOW_REF") == expected["GITHUB_REPOSITORY"] + "/" +
         profile["workflow"] + "@" + expected["GITHUB_REF"], "admission")
    need(actual["uid"] > 0 and actual["uid"] == actual["euid"] and
         actual["system"] == "Linux" and actual["machine"] == "x86_64", "admission")
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
                "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "LD_PRELOAD", "NODE_OPTIONS",
                "NODE_PATH", "PYTHONPATH", "PYTHONHOME"):
        need(not environment.get(key), "admission")
    return sha


def safe_directory(directory, uid, filesystem=os):
    need(directory.is_absolute(), "custody")
    for parent in reversed((directory, *directory.parents)):
        row = filesystem.lstat(parent)
        need(stat.S_ISDIR(row.st_mode) and row.st_uid in (0, uid) and not row.st_mode & 0o7022 and
             0 < row.st_ino <= 2**53 - 1 and 0 <= row.st_dev <= 2**53 - 1, "custody")
    need(Path(filesystem.path.realpath(directory)) == directory, "custody")


def tool(path, uid):
    safe_directory(path.parent, uid)
    real = path.resolve(strict=True)
    safe_directory(real.parent, uid)
    row = real.lstat()
    need(row.st_uid == 0 and stat.S_ISREG(row.st_mode) and row.st_nlink == 1 and
         not row.st_mode & 0o7022 and row.st_mode & stat.S_IXUSR, "tool")
    fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        active = os.fstat(fd)
        need((active.st_dev, active.st_ino) == (row.st_dev, row.st_ino), "tool")
        header = os.read(fd, 64)
        need(len(header) == 64 and header[:6] == b"\x7fELF\x02\x01" and
             int.from_bytes(header[18:20], "little") == 62, "tool")
        need(os.fstat(fd).st_mtime_ns == row.st_mtime_ns, "tool")
    finally:
        os.close(fd)
    return str(real)


def policy(values):
    # Necessary preconditions, not proof that a later Electron launch is sandboxed.
    need(values["userns"] == "1" and values["maxUserns"].isascii() and
         values["maxUserns"].isdecimal() and int(values["maxUserns"]) > 0, "sandbox")
    need(values["apparmorRestriction"] in ("absent", "0") and
         values["apparmorProfile"] == "unconfined" and
         values["seccomp"] == "0" and int(values["effectiveCaps"], 16) == 0, "sandbox")
    return "necessary-metadata-ready"


def bounded_kernel(path, maximum=8192):
    # Fixed procfs fields only; these are kernel records, not stable regular artifacts.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        value = os.read(fd, maximum + 1)
        need(len(value) <= maximum, "sandbox")
        return value.decode("ascii", "strict").strip()
    finally:
        os.close(fd)


def physical_policy():
    status = dict(line.split(":", 1) for line in bounded_kernel("/proc/" + str(os.getpid()) + "/status").splitlines() if ":" in line)
    try:
        restriction = bounded_kernel("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
    except FileNotFoundError:
        restriction = "absent"
    values = {"userns": bounded_kernel("/proc/sys/kernel/unprivileged_userns_clone"),
              "maxUserns": bounded_kernel("/proc/sys/user/max_user_namespaces"),
              "apparmorRestriction": restriction,
              "apparmorProfile": bounded_kernel("/proc/" + str(os.getpid()) + "/attr/current"),
              "seccomp": status["Seccomp"].strip(), "effectiveCaps": status["CapEff"].strip()}
    return policy(values)


def display_slot():
    temporary = Path("/tmp").lstat()
    need(stat.S_ISDIR(temporary.st_mode) and temporary.st_uid == 0 and
         stat.S_IMODE(temporary.st_mode) == 0o1777, "display-slot")
    # OS X11 rendezvous directory is intentionally sticky; never a trusted-tool ancestor.
    socket_root = Path("/tmp/.X11-unix")
    if socket_root.exists():
        row = socket_root.lstat()
        need(stat.S_ISDIR(row.st_mode) and not socket_root.is_symlink() and row.st_uid == 0 and
             stat.S_IMODE(row.st_mode) == 0o1777, "display-slot")
    for path in [Path("/tmp/.X177-lock"), socket_root / "X177"]:
        need(not os.path.lexists(path), "display-slot")


def setup_request(cookie):
    need(isinstance(cookie, bytes) and len(cookie) == 16, "display-auth")
    name = b"MIT-MAGIC-COOKIE-1"
    return struct.pack("<BBHHHHH", ord("l"), 0, 11, 0, len(name), len(cookie), 0) + name + b"\0\0" + cookie


def check_setup_response(header, body):
    need(len(header) == 8, "display-auth")
    status, _, major, minor, units = struct.unpack("<BBHHH", header)
    need(status == 1 and major == 11 and minor == 0 and 0 < units <= 65535 and len(body) == units * 4,
         "display-auth")


def authenticate_display(cookie, original, process_identity):
    started = time.monotonic()
    need(process_identity(original["pid"]) == original, "display-auth")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(2)
        channel.connect("/tmp/.X11-unix/X177")
        pid, uid, _ = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        need(pid == original["pid"] and uid == os.getuid(), "display-auth")
        channel.sendall(setup_request(cookie))
        def receive(size):
            parts, used = [], 0
            while used < size:
                need(time.monotonic() - started <= 3, "display-auth")
                data = channel.recv(min(65536, size - used))
                need(data, "display-auth")
                used += len(data)
                parts.append(data)
            return b"".join(parts)
        header = receive(8)
        units = struct.unpack_from("<H", header, 6)[0]
        need(units <= 65535, "display-auth")
        check_setup_response(header, receive(units * 4))
    need(time.monotonic() - started <= 3, "display-auth")
    need(process_identity(original["pid"]) == original, "display-auth")
