"""One isolated hosted diagnostic. The workflow's job condition is held false."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from assemble import assemble, need

IMAGE = "docker.io/library/ubuntu@sha256:77eb101c607d6e3d4f5ad0c8a02c2136c689b98aba1f359e6502ba517e5c57ec"
CONFIG = "sha256:7da97f743f397971f35dd21cd2d19a7da070a150e0cfa3eda559e71891ec7533"
LAYERS = ["sha256:21210938f5a37a9887b2d0a20428917b923a636ca6efe038c3c7d9cd9f1f9b61"]
FLOOR = 4 * 1024**3
REF = "refs/heads/ci/v060-noble-apt-runtime-observations-20261120"


def available(path):
    fs = os.statvfs(path)
    return fs.f_bavail * fs.f_frsize


def mark(label):
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(label + "=pass\n")


def same_files(stage, census):
    actual = {}
    for path in stage.rglob("*"):
        st = path.lstat()
        need(not st.st_mode & 0o7022 and path.resolve(strict=True) == path, "stage-file-ancestry")
        if not stat.S_ISDIR(st.st_mode):
            need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, "stage-file-mode")
            key = path.relative_to(stage).as_posix()
            need(key in census and st.st_size <= 128 * 1024**2, "unbound-stage-file")
            actual[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    need(actual == census, "stage-readback")


def verify_container(row, cid, stage, uid, gid):
    host = row["HostConfig"]
    need(row["Id"] == cid and row["Image"] == CONFIG and row["Config"]["User"] == f"{uid}:{gid}"
         and row["Config"]["Entrypoint"] == ["/bin/sh"] and row["Config"]["Cmd"] == ["/staged/worker.sh"],
         "container-identity")
    need(host["ReadonlyRootfs"] and not host["Privileged"] and host["NetworkMode"] == "none"
         and host["PidMode"] in ("", "private") and not host["PortBindings"] and not host["CapAdd"]
         and host["CapDrop"] == ["ALL"] and not host["Devices"] and not host["DeviceRequests"]
         and host["SecurityOpt"] in (["no-new-privileges"], ["no-new-privileges:true"])
         and host["PidsLimit"] == 16 and host["Memory"] == 128 * 1024**2
         and host["LogConfig"]["Type"] == "none", "container-isolation")
    tmpfs = f"rw,nosuid,nodev,noexec,size=16m,mode=0700,uid={uid},gid={gid}"
    need(host["Tmpfs"] == {"/scratch": tmpfs}, "bounded-writes")
    mounts = [m for m in row["Mounts"] if m["Type"] == "bind"]
    need(len(mounts) == 1 and mounts[0]["Source"] == str(stage)
         and mounts[0]["Destination"] == "/staged" and not mounts[0]["RW"], "input-mounts")


def run(root, uid, gid):
    stage = root / "stage"
    (root / "config").mkdir(mode=0o700)
    stage.mkdir(mode=0o700)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(root), "DOCKER_CONFIG": str(root / "config"),
           "LANG": "C.UTF-8"}

    def docker(*args, timeout=8):
        result = subprocess.run(["/usr/bin/docker", "--host=unix:///var/run/docker.sock", *args],
            env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        need(result.returncode == 0 and len(result.stdout) <= 65536, "docker-client")
        return result.stdout

    def inspect(kind, identity):
        rows = json.loads(docker(kind, "inspect", identity))
        need(len(rows) == 1, "docker-inspect-cardinality")
        return rows[0]

    docker("image", "pull", "--platform=linux/amd64", "--quiet", IMAGE, timeout=55)
    img = inspect("image", IMAGE)
    need((img["Id"], img["Os"], img["Architecture"], img["RootFS"]["Layers"])
         == (CONFIG, "linux", "amd64", LAYERS), "pinned-noble-image")
    mark("image")
    graph_name, driver, os_type, *security = docker("info", "--format",
        "{{.DockerRootDir}}\n{{.Driver}}\n{{.OSType}}{{range .SecurityOptions}}\n{{.}}{{end}}").decode().splitlines()
    graph = Path(graph_name)
    need(graph == Path("/var/lib/docker") and graph.resolve(strict=True) == graph
         and driver in ("overlay2", "overlayfs", "vfs") and os_type == "linux"
         and "name=seccomp,profile=builtin" in security, "stock-docker-profile")
    need(available(graph) >= FLOOR and available(stage) >= FLOOR, "initial-headroom")
    census = assemble(root, stage)
    same_files(stage, census)
    mark("assembly")
    cid = docker("container", "create", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--user", f"{uid}:{gid}", "--pids-limit=16", "--memory=128m",
        "--log-driver=none", "--mount", f"type=bind,src={stage},dst=/staged,readonly",
        "--tmpfs", f"/scratch:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid={uid},gid={gid}",
        "--env", f"EXPECTED_UID={uid}", "--env", f"EXPECTED_GID={gid}", "--entrypoint=/bin/sh",
        IMAGE, "/staged/worker.sh").decode().strip()
    need(re.fullmatch("[a-f0-9]{64}", cid), "container-id")
    try:
        verify_container(inspect("container", cid), cid, stage, uid, gid)
        need(available(graph) >= FLOOR and available(stage) >= FLOOR, "real-post-staging-headroom")
        same_files(stage, census)
        mark("venue")
        need(docker("container", "start", "--attach", cid, timeout=23)
             == b"gateway-startup-and-teardown-pass\n", "worker-runtime-result")
        end = inspect("container", cid)
        state = end["State"]
        need(end["Id"] == cid and state["Status"] == "exited" and state["Pid"] == 0
             and state["ExitCode"] == 0 and not state["OOMKilled"], "worker-exit")
    finally:
        state = inspect("container", cid)["State"]
        if state["Running"]:
            docker("container", "stop", "--time=2", cid)
        need(docker("container", "rm", cid).decode().strip() == cid, "owned-removal")
        need(docker("container", "ls", "--all", "--quiet", "--filter", "id=" + cid) == b"", "container-retired")
    same_files(stage, census)
    mark("closure")


def main():
    uid, gid = os.getuid(), os.getgid()
    need(0 < uid == os.geteuid() and 0 < gid == os.getegid(), "nonroot-host")
    expected = {"RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
                "GITHUB_REPOSITORY": "brucerry/embedded-linux-diagnostic-hub", "GITHUB_REF": REF,
                "GITHUB_EVENT_NAME": "push", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "gateway-diagnostic"}
    need(all(os.environ.get(k) == v for k, v in expected.items()) and platform.machine() == "x86_64",
         "hosted-context")
    for path, kind in [("/usr/bin/docker", stat.S_ISREG), ("/var/run/docker.sock", stat.S_ISSOCK)]:
        st = os.stat(path)
        need(kind(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o002, "local-docker-path")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="hub-gateway-diagnostic-", dir=os.environ["RUNNER_TEMP"]) as tmp:
        root = Path(tmp)
        need(root.resolve(strict=True) == root and root.stat().st_uid == uid
             and root.stat().st_mode & 0o777 == 0o700, "owned-root")
        run(root, uid, gid)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # The job shows fixed passed checkpoints. Raw transport and child streams stay private.
        print("gateway-diagnostic/refused", file=sys.stderr)
        raise SystemExit(1) from None
