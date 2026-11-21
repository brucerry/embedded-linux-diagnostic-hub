"""One isolated hosted diagnostic. The workflow's job condition is held false."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from assemble import assemble, need
import preflight_data as data
from lifecycle import exact_gateway_mounts, reached

IMAGE = "docker.io/library/ubuntu@sha256:77eb101c607d6e3d4f5ad0c8a02c2136c689b98aba1f359e6502ba517e5c57ec"
CONFIG = "sha256:7da97f743f397971f35dd21cd2d19a7da070a150e0cfa3eda559e71891ec7533"
LAYERS = ["sha256:21210938f5a37a9887b2d0a20428917b923a636ca6efe038c3c7d9cd9f1f9b61"]
FLOOR = 4 * 1024**3
LABEL_PREFIX = "org.diagnostichub.gateway."


def available(path):
    fs = os.statvfs(path)
    return fs.f_bavail * fs.f_frsize


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


def verify_container(row, cid, stage, uid, gid, labels):
    host = row["HostConfig"]
    need(row["Id"] == cid and row["Image"] == CONFIG and row["Config"]["User"] == f"{uid}:{gid}"
         and row["Config"]["Labels"] == labels
         and row["Config"]["Entrypoint"] == ["/bin/sh"] and row["Config"]["Cmd"] == ["/staged/worker.sh"],
         "container-identity")
    need(host["ReadonlyRootfs"] and not host["Privileged"] and host["NetworkMode"] == "none"
         and host["PidMode"] in ("", "private") and not host["PortBindings"] and not host["CapAdd"]
         and host["CapDrop"] == ["ALL"] and not host["Devices"] and not host["DeviceRequests"]
         and host["SecurityOpt"] in (["no-new-privileges"], ["no-new-privileges:true"])
         and host["PidsLimit"] == 16 and host["Memory"] == 128 * 1024**2
         and host["LogConfig"]["Type"] == "none" and not host.get("VolumesFrom"), "container-isolation")
    tmpfs = f"rw,nosuid,nodev,noexec,size=16m,mode=0700,uid={uid},gid={gid}"
    need(host["Tmpfs"] == {"/scratch": tmpfs}, "bounded-writes")
    exact_gateway_mounts(row["Mounts"], stage)


def run(root, uid, gid, env):
    stage = root / "stage"
    stage.mkdir(mode=0o700)

    def docker(*args, timeout=8):
        kept = data.docker(root, *args)
        code, out, err = data.bounded(kept, root, timeout, 65536, capture_timeout=True)
        need(code == 0 and not err, "docker-client")
        return out

    def inspect(kind, identity):
        rows = json.loads(docker(kind, "inspect", identity))
        need(len(rows) == 1, "docker-inspect-cardinality")
        return rows[0]

    with reached("image"):
        docker("image", "pull", "--platform=linux/amd64", "--quiet", IMAGE, timeout=55)
        img = inspect("image", IMAGE)
        policy = json.loads(env["NOBLE_POLICY"])
        need((policy["image"], policy["config"], [policy["diffID"]]) == (IMAGE, CONFIG, LAYERS),
             "exact-image-policy")
        data.image_identity(img, policy)
        base_labels = img["Config"].get("Labels") or {}
        need(all(not key.startswith(LABEL_PREFIX) for key in base_labels), "unambiguous-base-labels")
    graph_name, driver, os_type, *security = docker("info", "--format",
        "{{.DockerRootDir}}\n{{.Driver}}\n{{.OSType}}{{range .SecurityOptions}}\n{{.}}{{end}}").decode().splitlines()
    graph = Path(graph_name)
    need(graph == Path("/var/lib/docker") and graph.resolve(strict=True) == graph
         and driver in ("overlay2", "overlayfs", "vfs") and os_type == "linux"
         and "name=seccomp,profile=builtin" in security, "stock-docker-profile")
    with reached("assembly"):
        need(available(graph) >= FLOOR and available(stage) >= FLOOR, "initial-headroom")
        census = assemble(root, stage)
        same_files(stage, census)

    run_labels = {LABEL_PREFIX + "run": env["GITHUB_RUN_ID"], LABEL_PREFIX + "commit": env["GITHUB_SHA"]}
    labels = base_labels | run_labels
    options = [flag for key, value in run_labels.items() for flag in ("--label", key + "=" + value)]
    cid = None
    create_pending = False
    data.note(root, env, "runtime-entered")
    try:
        with reached("venue"):
            create_pending = True
            identity = docker("container", "create", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges", "--user", f"{uid}:{gid}", "--pids-limit=16", "--memory=128m",
                "--log-driver=none", "--mount", f"type=bind,src={stage},dst=/staged,readonly",
                "--tmpfs", f"/scratch:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid={uid},gid={gid}",
                "--env", f"EXPECTED_UID={uid}", "--env", f"EXPECTED_GID={gid}", "--entrypoint=/bin/sh",
                *options, IMAGE, "/staged/worker.sh").decode().strip()
            need(re.fullmatch("[a-f0-9]{64}", identity), "container-id")
            cid = identity
            create_pending = False
            verify_container(inspect("container", cid), cid, stage, uid, gid, labels)
            need(available(graph) >= FLOOR and available(stage) >= FLOOR, "real-post-staging-headroom")
            same_files(stage, census)
        with reached("worker"):
            need(docker("container", "start", "--attach", cid, timeout=23)
                 == b"gateway-startup-and-teardown-pass\n", "worker-runtime-result")
            end = inspect("container", cid)
            state = end["State"]
            need(end["Id"] == cid and state["Status"] == "exited" and state["Pid"] == 0
                 and state["ExitCode"] == 0 and not state["OOMKilled"] and not state["Error"], "worker-exit")
    finally:
        with reached("container-cleanup"):
            if cid is not None:
                row = inspect("container", cid)
                need(row["Id"] == cid and row["Image"] == CONFIG and row["Config"]["Labels"] == labels,
                     "scoped-cleanup-identity")
                if row["State"]["Running"]:
                    docker("container", "stop", "--time=2", cid)
                state = inspect("container", cid)["State"]
                need(not state["Running"] and state["Pid"] == 0, "gateway-no-live-cleanup")
                need(docker("container", "rm", cid).decode().strip() == cid, "owned-removal")
                need(not docker("container", "ls", "--all", "--quiet", "--filter", "id=" + cid),
                     "container-retired")
            filters = [flag for key, value in run_labels.items()
                       for flag in ("--filter", "label=" + key + "=" + value)]
            need(not docker("container", "ls", "--all", "--quiet", *filters), "no-unknown-run-container")
            need(not create_pending, "gateway-create-unsettled")
            data.note(root, env, "runtime-retired")
    with reached("mounted-readback"):
        same_files(stage, census)


def main():
    os.umask(0o077)
    env = os.environ
    uid, gid = os.getuid(), os.getgid()
    with reached("same-job-inputs"):
        root = data.scratch_path(env)
        data.require_handoff(root, env)
        need(platform.machine() == "x86_64", "hosted-machine")
        data.checked_tool("/usr/bin/docker")
        st = Path("/var/run/docker.sock").lstat()
        need(stat.S_ISSOCK(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o002, "ordinary-local-docker")
    run(root, uid, gid, env)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # The job shows fixed passed checkpoints. Raw transport and child streams stay private.
        print("gateway-diagnostic/refused", file=sys.stderr)
        raise SystemExit(1) from None
