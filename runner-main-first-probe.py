"""Non-shipping hosted runner test with an inert, bounded test service only."""
import importlib.util
import os
from pathlib import Path
import secrets
import select
import sys
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("previous_probe", HERE / "runner-owned-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def ctl(*args, check=True):
    return subprocess.run(["/usr/bin/systemctl", "--user", *args],
                          stdin=subprocess.DEVNULL, capture_output=True, text=True,
                          timeout=3, check=check)


def show(unit):
    args = ("ActiveState", "ExecMainCode", "ExecMainStatus", "MainPID", "ControlGroup", "Result")
    out = ctl("show", unit, *("--property=" + a for a in args)).stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


PAYLOAD = """import os, pathlib, subprocess, sys, time
d = pathlib.Path(sys.argv[1]); phase = sys.argv[2]
def wait(name):
    end = time.monotonic()+8
    while time.monotonic()<end:
        if (d/name).is_file(): return
        time.sleep(.01)
    raise SystemExit(76)
if phase == 'main':
    subprocess.Popen([sys.executable, '-B', '-I', __file__, str(d), 'helper'])
    wait('main-exit')
else:
    member = pathlib.Path('/proc/self/cgroup').read_text(encoding='ascii').strip()
    (d/'helper-identity').write_text(str(os.getpid())+'\\n'+member+'\\n', encoding='ascii')
    (d/'helper-ready').touch()
    wait('helper-exit')
    (d/'helper-natural-return').touch()
"""


def require(value, message):
    if not value:
        raise ValueError(message)


def wait_until(test, deadline, message):
    while time.monotonic() < deadline:
        result = test()
        if result:
            return result
        time.sleep(.01)
    raise ValueError(message)


def run(exit_type, require_empty=False):
    unit = f"hub-v060-probe-{secrets.token_hex(12)}.service"
    with tempfile.TemporaryDirectory(prefix="hub-main-first-") as tmp:
        d = Path(tmp)
        payload = d / "payload.py"
        payload.write_text(PAYLOAD, encoding="ascii")
        args = ["/usr/bin/systemd-run", "--user", "--quiet", "--wait", "--pipe", "--unit", unit,
                "--property", "RuntimeMaxSec=10s", "--property", "TimeoutStopSec=1s"]
        if exit_type == "cgroup":
            args += ["--property", "ExitType=cgroup"]
        args += ["/usr/bin/python3", "-B", "-I", str(payload), str(d), "main"]
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        try:
            end = time.monotonic() + 8
            wait_until(lambda: (d / "helper-ready").is_file(), end, "helper handshake absent")
            pid, raw_group = (d / "helper-identity").read_text(encoding="ascii").splitlines()
            require(pid.isdecimal() and int(pid) > 1, "invalid helper PID")
            group = preflight.receipt.cgroup_path(raw_group, unit)
            member = Path("/proc") / pid / "cgroup"
            path = Path("/sys/fs/cgroup") / group.removeprefix("/") / "cgroup.events"
            require(path.resolve(strict=True) == path, "unexpected scope path")
            identity = path.stat()
            initial = show(unit)
            require(initial.get("ControlGroup") == group and int(initial["MainPID"]) > 0
                    and initial["MainPID"] != pid, "owned scope or main identity not confirmed")
            require(preflight.receipt.populated(preflight.events(path)), "scope not populated")
            require(member.read_text(encoding="ascii").strip() == raw_group,
                    "helper not in its owned scope")
            (d / "main-exit").touch()
            if exit_type == "main":
                result = proc.wait(timeout=8)
                require(result == 0 and not (d / "helper-natural-return").exists(),
                        "control failed to distinguish normal main exit from helper retirement")
                require(not member.exists() or member.read_text(encoding="ascii").strip() != raw_group,
                        "default main-exit control unexpectedly kept helper alive in its scope")
                return "default_main_did_not_preserve_helper"
            def main_first():
                facts = show(unit)
                if (facts.get("MainPID"), facts.get("ExecMainCode"), facts.get("ExecMainStatus")) != ("0", "1", "0"):
                    return False
                current = path.stat()
                require((current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino),
                        "scope identity changed before helper exit")
                require(facts.get("ControlGroup") == group and facts.get("ActiveState") == "active"
                        and member.read_text(encoding="ascii").strip() == raw_group
                        and preflight.receipt.populated(preflight.events(path)),
                        "helper survival did not follow a normal main exit")
                return True
            wait_until(main_first, end, "main-first exit not observed")
            if not require_empty:
                # Separate main-first survival from the race at cgroup removal.
                (d / "helper-exit").touch()
                require(proc.wait(timeout=3) == 0 and (d / "helper-natural-return").is_file(),
                        "helper natural completion not confirmed")
                return "natural_main_first_helper_completion"
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            try:
                st = os.fstat(fd)
                require((st.st_dev, st.st_ino) == (identity.st_dev, identity.st_ino),
                        "unexpected scope identity at attachment")
                def snapshot():
                    os.lseek(fd, 0, os.SEEK_SET)
                    return os.read(fd, 1025).decode("ascii")
                require(preflight.receipt.populated(snapshot()), "scope not populated at attachment")
                watcher = select.poll()
                watcher.register(fd, select.POLLPRI | select.POLLERR)
                (d / "helper-exit").touch()
                empty = False
                while time.monotonic() < end and not empty:
                    if not watcher.poll(100):
                        continue
                    try:
                        value = snapshot()
                    except OSError:
                        break  # Disappearance is not the same as observing an empty scope.
                    empty = bool(value) and not preflight.receipt.populated(value)
                require(empty, "owned cgroup empty transition not observed")
            finally:
                os.close(fd)
            require(proc.wait(timeout=3) == 0 and (d / "helper-natural-return").is_file(),
                    "helper natural completion not confirmed")
            return "natural_main_first_helper_then_empty"
        finally:
            if proc.poll() is None:
                ctl("stop", unit, check=False)
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("main-first", "empty", "default-control"):
        raise SystemExit("Expected one explicit runner fixture")
    if not preflight.hosted_candidate() or not preflight.user_manager_ready():
        raise SystemExit("Unsupported hosted runner")
    mode = sys.argv[1]
    print(run("main" if mode == "default-control" else "cgroup",
              require_empty=mode == "empty"), flush=True)
    print("readiness_only_not_installer_qualification", flush=True)
