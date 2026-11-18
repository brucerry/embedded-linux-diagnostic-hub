"""Opt-in public native baseline, never a release/installer admission.

Each CLI phase rebinds exact source and custody. Children and output are owned
before waiting. This controller never force-kills or retries unknown children.
The pinned Playwright Electron launcher has its own launch-failure/exit kill
handlers; future runtime effect review must account for those library effects.
No live operation occurs on import.
"""
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import shutil
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True


def load(name, file):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load("native_host", "linux-native-host.py")
INPUTS = load("native_inputs", "linux-native-inputs.py")
ELF = load("native_elf", "linux-native-elf.py")
OWNERS = []
ACTIVE_ROOT = None
PHASE = "admission"
RUNTIME_DEADLINE = None


def save(path, value):
    INPUTS.COMMON.write(path, json.dumps(value, separators=(",", ":")).encode())


def process_identity(pid):
    value = Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()
    return {"pid": pid, "startTicks": int(value[19])}


def group_members(group):
    rows = []
    for p in Path("/proc").iterdir():
        if not p.name.isdecimal():
            continue
        try:
            fields = (p / "stat").read_text().rsplit(") ", 1)[1].split()
        except (OSError, ProcessLookupError):
            continue
        if int(fields[2]) == group and int(fields[3]) == group:
            rows.append({"pid": int(p.name), "startTicks": int(fields[19]), "state": fields[0]})
    return rows


class Owner:
    def __init__(self, root, role, argv, env, cwd, stdin=None, pass_fds=()):
        self.role, self.root, self.child = role, root, None
        self.count = {"stdout": 0, "stderr": 0}
        self.closed = {"stdout": False, "stderr": False}
        self.captures = {}
        self.expired = False
        OWNERS.append(self)
        for name in self.count:
            self.captures[name] = (root / (role + "." + name)).open("xb")
        self.child = subprocess.Popen(argv, cwd=cwd, env=env, shell=False,
                                      stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
                                      pass_fds=pass_fds, start_new_session=True, umask=0o022)
        self.original = process_identity(self.child.pid)
        save(root / (role + "-start.json"), {"process": self.original, "role": role,
                                           "ordinaryOutputCap": 1024**2})
        for stream in (self.child.stdout, self.child.stderr):
            os.set_blocking(stream.fileno(), False)
        if stdin is not None:
            self.child.stdin.write(stdin)
            self.child.stdin.close()

    def drain(self):
        for name in self.count:
            stream = getattr(self.child, name)
            if self.closed[name]:
                continue
            try:
                data = os.read(stream.fileno(), 65536)
            except BlockingIOError:
                continue
            if not data:
                stream.close()
                self.closed[name] = True
            else:
                room = max(0, 1024**2 - self.count[name])
                self.captures[name].write(data[:room])
                self.count[name] += len(data)

    def terminal(self):
        return self.child.poll() is not None and all(self.closed.values())

    def finish(self, expected=(0,)):
        code = self.child.wait()
        for stream in self.captures.values():
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
        remaining = group_members(self.child.pid)
        save(self.root / (self.role + "-result.json"), {"process": self.original, "exit": code,
             "closed": self.closed, "bytes": self.count, "expired": self.expired,
             "remainingOriginalGroup": remaining, "broaderRetirementInferred": False})
        HOST.need(code in expected and not self.expired and not remaining, "child")
        HOST.need(all(n <= 1024**2 for n in self.count.values()), "output")


def wait(owner, deadline, expected=(0,)):
    while not owner.terminal():
        for current in OWNERS:
            if current.child is not None and any(not x for x in current.closed.values()):
                current.drain()
        if time.monotonic() > deadline and not owner.expired:
            owner.expired = True
            failure("deadline", pending=True)
        # After expiry only the existing owner drains/reaps; no new operation or signal.
        time.sleep(0.01)
    owner.finish(expected)


def run(root, role, argv, env, cwd, seconds=120, stdin=None):
    owner = Owner(root, role, argv, env, cwd, stdin)
    wait(owner, time.monotonic() + seconds)
    return owner


def failure(reason, pending=False):
    if ACTIVE_ROOT is not None and not (ACTIVE_ROOT / "failure.json").exists():
        save(ACTIVE_ROOT / "failure.json", {"status": "fail", "stage": PHASE,
             "reason": reason if reason in HOST.REASONS else "unexpected", "pendingOwnedResource": pending,
             "qualified": False, "source": os.environ.get("GITHUB_SHA", "")})


def source_binding(project, profile):
    env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0"}
    def git(*args):
        result = subprocess.run(["/usr/bin/git", *args], cwd=project, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        HOST.need(result.returncode == 0 and len(result.stdout) <= 1024**2 and
                  len(result.stderr) <= 1024**2, "source")
        return result.stdout
    HOST.need(git("rev-parse", "HEAD").decode().strip() == os.environ["GITHUB_SHA"] and
              git("status", "--porcelain=v1", "--untracked-files=all") == b"", "source")
    for name, digest in profile["productFiles"].items():
        HOST.need(hashlib.sha256(INPUTS.COMMON.read(project / name, 4 * 1024**2)).hexdigest() == digest,
                  "product-policy")
    INPUTS.validate_lock(INPUTS.COMMON.read(project / "package-lock.json", 1024**2), profile)


def context(create=False):
    global ACTIVE_ROOT
    project = Path.cwd()
    profile = json.loads(INPUTS.COMMON.read(project / "scripts/ci/linux-native-inputs.json", 32768))
    HOST.admit(os.environ, {"uid": os.getuid(), "euid": os.geteuid(),
               "system": os.uname().sysname, "machine": os.uname().machine}, profile)
    HOST.safe_directory(project, os.getuid())
    HOST.need(Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True) == project, "source")
    source_binding(project, profile)
    event = json.loads(INPUTS.COMMON.read(Path(os.environ["GITHUB_EVENT_PATH"]), 4 * 1024**2))
    HOST.need(event["repository"]["full_name"] == "brucerry/embedded-linux-diagnostic-hub" and
              event["repository"]["private"] is False and event["deleted"] is False and
              event["after"] == os.environ["GITHUB_SHA"] and event["ref"] == os.environ["GITHUB_REF"], "admission")
    run_id = os.environ["GITHUB_RUN_ID"]
    HOST.need(run_id.isascii() and run_id.isdecimal() and 0 < len(run_id) <= 20, "admission")
    parent = Path(os.environ["RUNNER_TEMP"])
    HOST.safe_directory(parent, os.getuid())
    root = parent / ("hub-public-native-" + run_id + "-1")
    if create:
        HOST.need(not os.path.lexists(root) and not os.path.lexists(project / "node_modules") and
                  not os.path.lexists(project / ".npmrc"), "custody")
        root.mkdir(mode=0o700)
    HOST.safe_directory(root, os.getuid())
    row = root.lstat()
    HOST.need(row.st_uid == os.getuid() and stat.S_IMODE(row.st_mode) == 0o700, "custody")
    ACTIVE_ROOT = root
    return project, root, profile


def host_phase(project, root, profile):
    HOST.need(shutil.disk_usage(root).free >= 4 * 1024**3, "custody")
    tools = {name: HOST.tool(Path("/usr/bin") / name, os.getuid()) for name in ("Xvfb", "xauth", "cc", "readelf")}
    tools["ldconfig"] = HOST.tool(Path("/usr/sbin/ldconfig.real"), os.getuid())
    HOST.physical_policy()
    HOST.display_slot()
    for name in ("home", "tmp", "config", "cache", "data", "runtime", "profile", "playwright-data"):
        (root / name).mkdir(mode=0o700)
    for name in ("empty-user.npmrc", "empty-global.npmrc"):
        INPUTS.COMMON.write(root / name, b"")
    save(root / "host.json", {"schema": 1, "source": os.environ["GITHUB_SHA"], "tools": tools,
                               "sandbox": "necessary-metadata-ready", "qualified": False})


def build_phase(project, root, profile):
    global PHASE
    host = json.loads(INPUTS.COMMON.read(root / "host.json", 8192))
    HOST.need(host["source"] == os.environ["GITHUB_SHA"] and host["qualified"] is False, "source")
    for name in ("dist", "dist-electron", "dist-linux-native", "release"):
        HOST.need(not os.path.lexists(project / name), "custody")
    members = INPUTS.inspect_node(INPUTS.fetch_exact(profile["nodeDistribution"]), profile)
    sdk = root / "sdk"
    INPUTS.materialize_node(sdk, members)
    INPUTS.COMMON.npm_inventory(sdk / "lib/node_modules/npm", profile["node"])
    node = INPUTS.COMMON.read(sdk / "bin/node", 128 * 1024**2)
    HOST.need(hashlib.sha256(node).hexdigest() == profile["node"]["sha256"], "integrity")
    # Exact complete official ZIP is supplied to the builder; no cache/download/7zip branch.
    INPUTS.COMMON.write(root / "electron.zip", INPUTS.fetch_exact(profile["electron"]))
    env = INPUTS.child_environment(root, sdk, project)
    for stage, argv in INPUTS.build_commands(project, root, sdk):
        PHASE = stage
        run(root, stage, argv, env, project, seconds=420)
        if stage == "dependencies":
            save(root / "dependencies.json", INPUTS.check_dependency_tree(project))
        source_binding(project, profile)
    manifest = payload_manifest(root / "out/linux-unpacked")
    save(root / "payload.json", {"schema": 1, "source": os.environ["GITHUB_SHA"], "files": manifest,
                                 "qualified": False})
    PHASE = "libraries"
    def collect(role, argv):
        run(root, role, argv, {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, project)
        return INPUTS.COMMON.read(root / (role + ".stdout"), 1024**2).decode("utf8", "strict")
    save(root / "libraries.json", ELF.inspect(root / "out/linux-unpacked", host["tools"], collect, INPUTS.COMMON.read))


def payload_manifest(directory):
    HOST.safe_directory(directory, os.getuid())
    result, total = {}, 0
    for at, directories, files in os.walk(directory, followlinks=False):
        for name in directories:
            HOST.safe_directory(Path(at) / name, os.getuid())
        for name in files:
            file = Path(at) / name
            data = INPUTS.COMMON.read(file, 256 * 1024**2)
            total += len(data)
            HOST.need(len(result) < 10000 and total <= 1024**3, "input")
            result[file.relative_to(directory).as_posix()] = {"bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "mode": stat.S_IMODE(file.lstat().st_mode)}
    HOST.need(all(name in result for name in ("AppRun", "diagnostic-hub", "resources/app.asar")), "input")
    return result


def smoke_phase(project, root, profile):
    global PHASE, RUNTIME_DEADLINE
    host = json.loads(INPUTS.COMMON.read(root / "host.json", 8192))
    expected = json.loads(INPUTS.COMMON.read(root / "payload.json", 4 * 1024**2))
    node_bytes = INPUTS.COMMON.read(root / "sdk/bin/node", 128 * 1024**2)
    HOST.need(hashlib.sha256(node_bytes).hexdigest() == profile["node"]["sha256"], "integrity")
    HOST.need(expected["source"] == os.environ["GITHUB_SHA"] and
              expected["files"] == payload_manifest(root / "out/linux-unpacked"), "input")
    HOST.need(json.loads(INPUTS.COMMON.read(root / "libraries.json", 8192))["missingOrVersionMismatch"] is False, "input")
    HOST.physical_policy()
    HOST.display_slot()
    deadline = time.monotonic() + 90
    RUNTIME_DEADLINE = deadline
    env = {"PATH": "/usr/bin:/bin", "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"),
           "LANG": "C", "LC_ALL": "C", "TZ": "UTC"}
    for name in ("Xvfb", "xauth"):
        HOST.need(HOST.tool(Path("/usr/bin") / name, os.getuid()) == host["tools"][name], "tool")
    cookie = os.urandom(16)
    INPUTS.COMMON.write(root / "Xauthority", b"")
    run(root, "xauth", [host["tools"]["xauth"], "-f", str(root / "Xauthority"), "source", "-"],
        env, project, seconds=10, stdin=("add :177 MIT-MAGIC-COOKIE-1 " + cookie.hex() + "\n").encode())
    read_fd, write_fd = os.pipe()
    server = Owner(root, "display", [host["tools"]["Xvfb"], ":177", "-screen", "0", "1280x800x24",
                   "-nolisten", "tcp", "-auth", str(root / "Xauthority"), "-displayfd", str(write_fd)],
                   env, project, pass_fds=(write_fd,))
    os.close(write_fd)
    os.set_blocking(read_fd, False)
    ready = b""
    ready_deadline = min(deadline, time.monotonic() + 10)
    try:
        while b"\n" not in ready and time.monotonic() < ready_deadline:
            server.drain()
            HOST.need(server.child.poll() is None, "display-ready")
            try:
                part = os.read(read_fd, 16)
                HOST.need(part, "display-ready")
                ready += part
                HOST.need(len(ready) <= 16, "display-ready")
            except BlockingIOError:
                time.sleep(0.01)
        HOST.need(ready == b"177\n", "display-ready")
    finally:
        os.close(read_fd)
    HOST.authenticate_display(cookie, server.original, process_identity)
    cookie = None  # Never serialized, printed or passed as an app argument.
    save(root / "display-ready.json", {"authenticated": True, "ownedServer": server.original,
                                       "qualified": False})
    context_data = {"source": os.environ["GITHUB_SHA"], "project": str(project), "root": str(root),
                    "profile": str(root / "profile"), "appdir": str(root / "out/linux-unpacked"),
                    "asarSHA256": expected["files"]["resources/app.asar"]["sha256"]}
    save(root / "smoke-input.json", context_data)
    PHASE = "runtime"
    app_env = {**env, "PATH": str(root / "sdk/bin") + ":/usr/bin:/bin", "NODE_DISABLE_COMPILE_CACHE": "1"}
    worker = Owner(root, "runtime", [str(root / "sdk/bin/node"), str(project / "scripts/ci/linux-native-smoke.mjs"),
                   str(root / "smoke-input.json")], app_env, project)
    wait(worker, deadline, expected=(0, 1))
    output = INPUTS.COMMON.read(root / "runtime.stdout", 8192)
    result = json.loads(output)
    validate_actor_result(result, worker.child.returncode)
    HOST.need(result["closure"] is True, "close")
    stop_display(server, deadline)
    HOST.need(result["status"] == "pass", result["reason"])
    HOST.need(expected["files"] == payload_manifest(root / "out/linux-unpacked"), "input")
    HOST.need(time.monotonic() <= deadline, "deadline")
    save(root / "complete.json", {"status": "pass", "stage": "complete", "reason": "none",
         "source": os.environ["GITHUB_SHA"], "scope": "public-native-baseline-only", "qualified": False,
         "normalAppAndOwnedDisplayClosed": True})


def validate_actor_result(result, exit_code):
    HOST.need(type(result) is dict and result.get("schema") == 1 and result.get("qualified") is False and
              result.get("scope") == "public-native-baseline-only" and
              type(result.get("closure")) is bool and type(result.get("closeIssued")) is bool, "report")
    if result.get("status") == "pass":
        HOST.need(result == {"schema": 1, "status": "pass", "reason": "none", "closeIssued": True,
                            "closure": True, "qualified": False, "scope": "public-native-baseline-only"} and
                  exit_code == 0, "report")
    else:
        HOST.need(result.get("status") == "fail" and exit_code == 1 and
                  result.get("reason") in HOST.REASONS, "report")


def stop_display(server, deadline, preapp=False):
    HOST.need(time.monotonic() <= deadline, "deadline")
    if server.child.poll() is None:
        HOST.need(process_identity(server.child.pid) == server.original, "close")
        server.child.send_signal(signal.SIGTERM)  # Normal stop of this exact owned display only.
    while not server.terminal() and time.monotonic() <= deadline:
        server.drain()
        time.sleep(0.01)
    if not server.terminal():
        failure("close", pending=True)
        hold()
    server.finish(expected=(0, 1, -signal.SIGTERM) if preapp else (0, -signal.SIGTERM))


def hold():
    # Original owners stay accounted for; no new request, app action, signal or cleanup.
    while True:
        for owner in OWNERS:
            if owner.child is not None:
                owner.drain()
                owner.child.poll()
        time.sleep(0.1)


def classify_report(result, source):
    HOST.need(type(result) is dict and result.get("source") == source and result.get("qualified") is False,
              "report")
    if result.get("status") == "pass":
        HOST.need(result == {"status": "pass", "stage": "complete", "reason": "none", "source": source,
                  "scope": "public-native-baseline-only", "qualified": False,
                  "normalAppAndOwnedDisplayClosed": True}, "report")
    else:
        HOST.need(result.get("status") == "fail" and result.get("stage") in HOST.STAGES and
                  result.get("reason") in HOST.REASONS and type(result.get("pendingOwnedResource")) is bool,
                  "report")
    return {key: result[key] for key in ("status", "stage", "reason")}


def report(root):
    if (root / "failure.json").exists():
        result = json.loads(INPUTS.COMMON.read(root / "failure.json", 8192))
    elif (root / "complete.json").exists():
        result = json.loads(INPUTS.COMMON.read(root / "complete.json", 8192))
    else:
        result = {"status": "fail", "stage": "report", "reason": "report", "qualified": False,
                  "source": os.environ["GITHUB_SHA"], "pendingOwnedResource": False}
    result = classify_report(result, os.environ["GITHUB_SHA"])
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="ascii") as f:
        for key in ("status", "stage", "reason"):
            f.write(key + "=" + result[key] + "\n")
    print("Public native baseline fixed outcome collected; no release admission.")
    return 0 if result["status"] == "pass" else 1


def main():
    global PHASE
    HOST.need(len(sys.argv) == 2 and sys.argv[1] in ("host", "build", "smoke", "report"), "admission")
    phase = sys.argv[1]
    project, root, profile = context(create=phase == "host")
    if phase == "report":
        return report(root)
    PHASE = {"host": "host", "build": "inputs", "smoke": "display"}[phase]
    {"host": host_phase, "build": build_phase, "smoke": smoke_phase}[phase](project, root, profile)
    print("PUBLIC_NATIVE_" + phase.upper() + "_COMPLETE")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        reason = error.reason if isinstance(error, HOST.Refused) else str(error) if isinstance(error, (INPUTS.InputRefused, ELF.ElfRefused)) else "unexpected"
        reason = reason if reason in HOST.REASONS else "unexpected"
        failure(reason, pending=any(o.child is not None and not o.terminal() for o in OWNERS))
        # Before app submission a known owned display can be stopped normally within
        # its original deadline. Never do this when app closure is unknown or late.
        if PHASE == "display" and not any(o.role == "runtime" for o in OWNERS) and RUNTIME_DEADLINE is not None:
            server = next((o for o in OWNERS if o.role == "display"), None)
            if server is not None and time.monotonic() <= RUNTIME_DEADLINE:
                try:
                    stop_display(server, RUNTIME_DEADLINE, preapp=True)
                except Exception:
                    pass  # The original refusal is retained; owner custody below remains active.
        print("PUBLIC_NATIVE_REFUSED_" + reason.upper())
        if any(o.child is not None and not o.terminal() for o in OWNERS):
            hold()
        raise SystemExit(1)
