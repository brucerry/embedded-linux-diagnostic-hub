"""Non-shipping runner readiness draft; emits no release evidence."""
import importlib.util
import os
from pathlib import Path
import secrets
import selectors
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("receipt", HERE / "cgroup-receipt.py")
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)
BODY = '''set -eu
IFS= read -r own < /proc/self/cgroup
printf 'direct=%s\\n' "$own"
/bin/sh -c 'IFS= read -r child < /proc/self/cgroup; printf "child=%s\\n" "$child"; /usr/bin/sleep 1' &
wait "$!"
printf 'normal_payload_return\\n'
'''


def hosted_candidate():
    if (os.getuid() == 0 or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("RUNNER_OS") != "Linux" or os.environ.get("RUNNER_ARCH") != "X64"
            or Path("/.dockerenv").exists()):
        return False
    fields = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines()
                  if "=" in line and not line.startswith("#"))
    if fields.get("ID") != "ubuntu" or fields.get("VERSION_ID", "").strip('"') != "26.04":
        return False
    return subprocess.run(["/bin/sh", str(HERE / "runner-eligibility.sh")],
                          timeout=3, check=False).returncode == 0


def user_manager_ready():
    uid = os.getuid()
    runtime = Path("/run/user") / str(uid)
    image = os.environ.get("ImageVersion", "")
    print("runner_image=" + (image if re.fullmatch(r"[0-9.]{1,40}", image) else "unknown"))
    print(f"uid={uid}")
    try:
        if Path(os.environ.get("XDG_RUNTIME_DIR", "/missing")) != runtime:
            print("user_manager_unavailable_runtime_mismatch")
            return False
        owner = runtime.stat().st_uid
        print(f"user_runtime_owner={owner}")
        if owner != uid:
            return False
        result = subprocess.run(
            ["/usr/bin/systemctl", "--user", "show", "--property=Version", "--value"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=3, check=False)
        ok = result.returncode == 0 and bool(result.stdout.strip())
        print("user_manager=" + ("available" if ok else "unavailable"))
        return ok
    except (OSError, subprocess.SubprocessError):
        print("user_manager_unavailable")
        return False


def events(path):
    try:
        with path.open("rb") as f:
            return f.read(1025).decode("ascii")
    except FileNotFoundError:
        return None


def probe():
    unit = f"hub-v060-probe-{secrets.token_hex(12)}.service"
    args = ["/usr/bin/systemd-run", "--user", "--quiet", "--wait", "--pipe",
            "--unit", unit, "--property", "ExitType=cgroup",
            "--property", "RuntimeMaxSec=4s", "--property", "TimeoutStopSec=1s",
            "/bin/sh", "-c", BODY]
    active = retired = group = None
    out = b""
    eof = False
    with selectors.DefaultSelector() as selector:
        p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL)
        try:
            selector.register(p.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                for key, _ in selector.select(0.05):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        eof = True
                        selector.unregister(key.fileobj)
                    out += chunk
                    if len(out) > 8192:
                        raise ValueError("unexpected probe output size")
                lines = out.decode("ascii").splitlines()
                direct = [line[7:] for line in lines if line.startswith("direct=")]
                child = [line[6:] for line in lines if line.startswith("child=")]
                if len(direct) > 1 or len(child) > 1:
                    raise ValueError("duplicate membership")
                if direct and child and group is None:
                    a = receipt.cgroup_path(direct[0], unit)
                    if receipt.cgroup_path(child[0], unit) != a:
                        raise ValueError("different child scope")
                    root = Path("/sys/fs/cgroup")
                    path = root / a.removeprefix("/") / "cgroup.events"
                    if path.resolve(strict=False) != path:
                        raise ValueError("unexpected cgroup path")
                    group = path
                if group is not None:
                    current = events(group)
                    if current is not None:
                        if receipt.populated(current) and retired is None:
                            active = current
                        if not receipt.populated(current) and active is not None:
                            retired = current
                rc = p.poll()
                if rc is not None and eof:
                    if not (direct and child and active):
                        return "preflight_unknown_missing_membership"
                    own_exit = rc == 0 and lines[-1:] == ["normal_payload_return"]
                    return receipt.classify(unit, direct[0], child[0], active, retired,
                                            own_exit, eof)["status"]
            return "preflight_unknown_deadline"
        finally:
            if p.poll() is None:
                try:
                    subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=3, check=False)
                finally:
                    if p.poll() is None:
                        p.kill()
                    p.wait(timeout=2)


if __name__ == "__main__":
    if sys.argv != [sys.argv[0], "--run-benign-probe"] or not hosted_candidate():
        print("not_run_unsupported_or_not_requested")
        raise SystemExit(78)
    if not user_manager_ready():
        raise SystemExit(78)
    try:
        result = probe()
        print(result)
        raise SystemExit(0 if result == 'benign_process_and_group_retired' else 2)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("preflight_unknown_runner_error")
        raise SystemExit(1)
