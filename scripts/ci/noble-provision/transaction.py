"""One explicitly approved Noble compiler-root transaction on a stock hosted runner."""

from collections import defaultdict
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import intake
import preflight_data as data
from lifecycle import reached, report

need = intake.need
NODE_BYTES = 58299872
NODE_SHA = "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9"
NODE_URL = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz"
GIB = 1 << 30
SHA_ID = re.compile(r"sha256:[a-f0-9]{64}")
CID = re.compile(r"[a-f0-9]{64}")
LABEL_PREFIX = "org.diagnostichub.noble."


def save(path, data, mode=0o444):
    with path.open("xb") as stream:
        stream.write(data)
        os.fchmod(stream.fileno(), mode)


def package_rows(rows):
    return "".join(f"{name}\t{arch}\t{version}\tinstall ok installed\n"
                   for name, (arch, version) in sorted(rows.items())).encode()


def authenticate_policy(pins, original_bytes):
    need(intake.SHA(original_bytes) == intake.EXPECTED_POLICY, "original-signed-policy")
    policy = json.loads(original_bytes)
    records = policy["archives"]
    names = sorted(records)
    need(len(names) == 39 and set(names) == set(pins["archives"]), "signed-input-census")
    need(sum(records[n]["Size"] for n in names) == 58852226, "archive-byte-total")
    need(pins["aptArgv"] == ["/usr/bin/apt-get", "--no-download", "--no-remove",
         "--no-install-recommends", "--assume-yes", "install", *["/approved/" + n + ".deb" for n in names]],
         "approved-argv")
    before = pins["before"]
    predicted = dict(before)
    for name in names:
        row, approved = records[name], pins["archives"][name]
        need((row["Size"], row["SHA256"], row["Version"], row["Architecture"])
             == (approved["archiveBytes"], approved["archiveSHA256"], approved["version"], approved["arch"]),
             "archive-lock-conflict")
        predicted[name] = [row["Architecture"], row["Version"]]
    upgrades = {"libc-bin", "libc6"}
    need(len(before) == 92 and len(predicted) == 129 and predicted == pins["after"]
         and len(set(predicted) - set(before)) == 37 and set(before) <= set(predicted)
         and {n for n in before if predicted[n] != before[n]} == upgrades
         and all(before[n] == ["amd64", "2.39-0ubuntu8.9"]
                 and predicted[n] == ["amd64", "2.39-0ubuntu8.12"] for n in upgrades), "approved-transaction")
    base = pins["base"]
    need((base["image"], base["config"], "sha256:" + base["diffID"], base["statusSHA256"])
         == (policy["image"], policy["config"], policy["diffID"], policy["statusSHA256"]),
         "approved-base")
    return policy


def capacity(paths, pins, phase):
    budget = pins["capacity"]
    need(budget["sameDeviceAllAlreadyStagedFloorBytes"] == 5337583616
         and budget["nativeFloorBytes"] == 4 * GIB
         and budget["engineReserveBytes"] == 639963136
         and budget["readbackMaximumBytes"] == 384 << 20, "approved-storage-budget")
    due = {"work": 4 * GIB, "engine": budget["engineReserveBytes"] if phase != "reader" else 0,
           "evidence": budget["readbackMaximumBytes"],
           "archives": budget["packageArchivesBytes"] if phase == "initial" else 0,
           "apt-input": budget["packageArchivesBytes"] if phase == "initial" else 0}
    groups = defaultdict(list)
    for role, path in paths.items():
        row = intake.local_directory(path, owner_only=(role != "engine"))
        groups[row["dev"]].append((row["bytes"], due[role]))
    need(all(min(free for free, _ in rows) >= sum(need_bytes for _, need_bytes in rows)
             for rows in groups.values()), "capacity-" + phase)


def compare_views(root, pins):
    original, copied = root / "approved", root / "apt-input"
    names = sorted(n + ".deb" for n in pins["archives"])
    for folder, dir_mode, mode in ((original, 0o700, 0o600), (copied, 0o555, 0o444)):
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            a = os.fstat(fd)
            need(a.st_uid == os.getuid() and stat.S_IMODE(a.st_mode) == dir_mode
                 and sorted(os.listdir(fd)) == names, "readonly-input-census")
            for name in names:
                expected = pins["archives"][name[:-4]]
                fileno = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(fileno, "rb") as stream:
                    start = os.fstat(stream.fileno())
                    need(stat.S_ISREG(start.st_mode) and start.st_size == expected["archiveBytes"]
                         and start.st_mode & 0o7777 == mode and start.st_uid == os.getuid()
                         and start.st_nlink == 1, "exact-deb-mode-and-custody")
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                    end = os.fstat(stream.fileno())
                    named = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    key = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_ctime_ns)
                    need(key(start) == key(end) == key(named) and digest == expected["archiveSHA256"],
                         "same-immutable-deb")
            b = os.fstat(fd)
            need((a.st_dev, a.st_ino, a.st_ctime_ns) == (b.st_dev, b.st_ino, b.st_ctime_ns),
                 "stable-input-directory")
        finally:
            os.close(fd)


def selected_headers(raw, pins):
    need(len(raw) == NODE_BYTES and intake.SHA(raw) == NODE_SHA, "official-node-headers-source")
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
        tar = stream.read((512 << 20) + 1)
    need(len(tar) <= 512 << 20, "node-distribution-bound")
    wanted = pins["nodeHeaderSHA256"]
    prefix = "node-v24.22.2-linux-x64/include/node/"
    result = {}
    with tarfile.open(fileobj=io.BytesIO(tar), mode="r:") as archive:
        for index, member in enumerate(archive, 1):
            need(index <= 10000, "node-distribution-census")
            name = member.name.removeprefix(prefix)
            if member.name == prefix + name and name in wanted:
                need(name not in result and member.isfile() and not member.issparse()
                     and member.size == pins["nodeHeaderBytes"][name], "node-header-member")
                body = archive.extractfile(member).read()
                need(intake.SHA(body) == wanted[name], "node-header-signed-hash")
                result[name] = body
    need(result.keys() == wanted.keys(), "four-node-headers")
    return result


def stage_headers(root, pins):
    target = root / "node-distribution.tar.gz"
    raw = intake.bound_file(target, NODE_BYTES, NODE_SHA)
    location = root / "sdk/node24/include/node"
    location.mkdir(parents=True, mode=0o700)
    for name, body in selected_headers(raw, pins).items():
        save(location / name, body)


def write_probes(root, pins):
    policy, probe = root / "policy", root / "probe"
    output = package_rows(pins["after"])
    save(policy / "expected-installed", output)
    save(probe / "expected-installed", output)
    save(policy / "policy-rc.d.expected", pins["policyRc"].encode())
    save(policy / "ordered-paths", ("\n".join(pins["aptArgv"][6:]) + "\n").encode())
    save(policy / "base-pins", (pins["base"]["statusSHA256"] + "  /var/lib/dpkg/status\n"
          + pins["setpriv"]["sha256"] + "  /usr/bin/setpriv\n").encode())
    save(policy / "archives.sha256", "".join(
        f"{p['archiveSHA256']}  /approved/{n}.deb\n" for n, p in sorted(pins["archives"].items())).encode())
    save(policy / "writer.sh", (HERE / "writer.sh").read_bytes())
    save(probe / "reader.sh", (HERE / "reader.sh").read_bytes())
    save(probe / "header-sha", "".join(f"{digest}  /sdk/node24/include/node/{name}\n"
         for name, digest in sorted(pins["nodeHeaderSHA256"].items())).encode())
    members = pins["nativeMembers"]
    need(len(members) == 1640 and len(pins["elf"]) == 18
         and all(name in members and elf["sha256"] == members[elf["canonical"].lstrip("/")]["sha256"]
                 for name, elf in pins["elf"].items()), "native-member-census")
    regular, shape = [], []
    for name, row in sorted(members.items()):
        need(re.fullmatch(r"[A-Za-z0-9_+./%~-]+", name) and ".." not in Path(name).parts,
             "native-roster-path")
        base = ["/" + name, row["mode"].lstrip("0"), str(row["uid"]), str(row["gid"])]
        if row["type"] == "file":
            regular.append(f"{row['sha256']}  /{name}\n")
            fields = [*base, "regular file", str(row["bytes"])]
        else:
            need(row["type"] == "symlink" and re.fullmatch(r"[A-Za-z0-9_+./%~-]+", row["target"]),
                 "native-roster-link")
            fields = [*base, "symbolic link", row["target"]]
        shape.append("\t".join(fields) + "\n")
    save(probe / "native-sha", "".join(regular).encode())
    save(probe / "native-meta", "".join(shape).encode())
    save(probe / "cache-targets", "".join(f"{name}\t{path}\n"
         for name, path in sorted(pins["libraries"].items())).encode())
    save(probe / "ldconfig-sha", b"bfd5df90c7f070feab584435f106f254ffffaa268a04de5b5c3bd61d59c092f3  /usr/sbin/ldconfig\n"
         b"f11a9ee2864823f6a973a789c9736573cc6075e4549683a5e5fcb34762b744a0  /usr/sbin/ldconfig.real\n")
    policy.chmod(0o555)


def change_check(raw, stdout, pins):
    """Refuse any path beyond signed payloads, superseded glibc files and reviewed generated state."""
    signed = {"/" + p for p in pins["allPayloadPaths"]}
    prev = {line.removeprefix("old-path ") for line in stdout.splitlines() if line.startswith("old-path ")}
    need(0 < len(prev) < 2000 and all(re.fullmatch(r"/[A-Za-z0-9_+./%~-]*", p)
         and ".." not in Path(p).parts for p in prev), "original-glibc-file-list")
    generated = {
        "/etc/alternatives/cc", "/etc/alternatives/cpp", "/usr/bin/cc", "/usr/lib/cpp", "/lib/cpp",
        "/etc/ld.so.cache", "/var/cache/ldconfig/aux-cache", "/var/log/dpkg.log",
        "/var/log/alternatives.log", "/var/log/apt/history.log", "/var/log/apt/term.log",
        "/var/lib/apt/extended_states", "/var/cache/debconf/config.dat", "/var/cache/debconf/config.dat-old",
        "/var/cache/debconf/templates.dat", "/var/cache/debconf/templates.dat-old",
        "/var/lib/dpkg/status", "/var/lib/dpkg/status-old", "/var/lib/dpkg/lock",
        "/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/diversions", "/var/lib/dpkg/diversions-old",
        "/var/lib/dpkg/triggers/Lock", "/var/lib/dpkg/triggers/Unincorp", "/var/lib/dpkg/triggers/File",
        "/var/lib/dpkg/triggers/ldconfig", "/var/lib/dpkg/alternatives/cc",
        "/var/lib/dpkg/alternatives/cpp", "/var/cache/apt/archives/lock",
    }
    for name in ("cc", "c89", "c99", "cpp"):
        generated.update(("/etc/alternatives/" + name, "/etc/alternatives/" + name + ".1.gz",
            "/usr/bin/" + name, "/usr/share/man/man1/" + name + ".1.gz",
            "/var/lib/dpkg/alternatives/" + name))
    for name, entries in pins["controlMemberNames"].items():
        arch = pins["archives"][name]["arch"]
        for prefix in (name, name + ":" + arch):
            for field in ("list", *[entry for entry in entries if entry != "control"]):
                generated.add("/var/lib/dpkg/info/" + prefix + "." + field)
    possible = signed | generated | prev
    ancestors = {str(parent) for path in possible for parent in Path(path).parents}
    for line in raw.splitlines():
        need(re.fullmatch(r"[ACD] /[A-Za-z0-9_+./%:~-]+", line), "change-inventory-shape")
        kind, path = line.split(" ", 1)
        need(".." not in Path(path).parts and
             (path in signed or path in generated or (kind == "D" and path in prev)
              or (kind in ("A", "C") and path in ancestors)), "unreviewed-disposable-layer-change")


def real_transaction(root, pins, policy, run, commit, env):
    uid, gid = os.getuid(), os.getgid()
    intake.checked_tool(intake.DOCKER)
    intake.checked_tool("/usr/bin/curl")
    socket = Path("/var/run/docker.sock").stat()
    need(stat.S_ISSOCK(socket.st_mode) and socket.st_uid == 0 and not socket.st_mode & 0o002,
         "ordinary-local-docker")

    def docker(*args, timeout=20, limit=128 << 10):
        return intake.call(intake.docker(root, *args), root, timeout, limit)

    def inspect(kind, ident):
        return intake.one(docker(kind, "inspect", ident))

    parts = docker("info", "--format",
        "{{.OSType}} {{.Architecture}} {{.Driver}} {{.DockerRootDir}}{{range .SecurityOptions}} {{.}}{{end}}").decode().split()
    need(parts[0] == "linux" and parts[1] in ("x86_64", "amd64") and parts[2] in ("overlay2", "vfs")
         and parts[3] == "/var/lib/docker" and "name=seccomp,profile=builtin" in parts[4:],
         "approved-docker-backing")
    paths = {"work": root / "work", "engine": Path(parts[3]), "evidence": root / "evidence",
             "archives": root / "approved", "apt-input": root / "apt-input"}
    with reached("image"):
        docker("image", "pull", "--platform=linux/amd64", "--quiet", policy["image"], timeout=105)
        base = inspect("image", policy["image"])
        intake.image_identity(base, policy)
        base_labels = base["Config"].get("Labels") or {}
        need(all(not key.startswith(LABEL_PREFIX) for key in base_labels), "unambiguous-base-labels")

    with reached("runtime-inputs"):
        compare_views(root, pins)
        expected = root / "policy"
        save(expected / "apt.conf", intake.APT_CONF.encode())
        save(expected / "empty.conf", b"")
        (expected / "empty").mkdir(mode=0o555)
        intake.archive_readback(policy, root)
        stage_headers(root, pins)
        write_probes(root, pins)
        capacity(paths, pins, "writer")

    label = {LABEL_PREFIX + "run": run, LABEL_PREFIX + "commit": commit}
    writer = reader = derived = None
    pending_creates = set()
    commit_pending = False

    def mount(dest, leaf):
        return dest, str(root / leaf)

    def verify_role(row, ident, role, image, bindings, runtime):
        h = row["HostConfig"]
        expected_label = base_labels | label | {LABEL_PREFIX + "role": role}
        user = "0:0" if role == "writer" else f"{uid}:{gid}"
        need(row["Id"] == ident and row["Image"] == image and row["Path"] == "/usr/bin/env"
             and row["Args"] == runtime and row["Config"]["User"] == user
             and row["Config"]["Labels"] == expected_label, "exact-owned-container")
        need(h["NetworkMode"] == "none" and h["IpcMode"] == "private"
             and h["PidMode"] in ("", "private") and h["UtsMode"] in ("", "private")
             and not h["Privileged"] and not h["CapAdd"] and not h["PortBindings"]
             and not h["Devices"] and not h["DeviceRequests"]
             and h["SecurityOpt"] in (["no-new-privileges"], ["no-new-privileges:true"])
             and h["ReadonlyRootfs"] == (role == "reader") and h["PidsLimit"] == 64
             and h["CapDrop"] in (([], None) if role == "writer" else (["ALL"],))
             and h["ShmSize"] == 64 << 20 and h["Memory"] == 512 << 20
             and {"Name": "cpu", "Hard": 120, "Soft": 120} in h["Ulimits"]
             and h["LogConfig"]["Type"] == "none" and h["RestartPolicy"]["Name"] in ("no", ""),
             "stock-contained-role")
        actual = {m["Destination"]: m["Source"] for m in row["Mounts"] if m["Type"] == "bind" and not m["RW"]}
        need(len(row["Mounts"]) == len(actual) == len(bindings) and actual == dict(bindings),
             "only-approved-readonly-mounts")

    def create(role, image, bindings, inputs):
        origin = policy["image"] if role == "writer" else image
        user = "0:0" if role == "writer" else f"{uid}:{gid}"
        flags = [] if role == "writer" else ["--read-only", "--cap-drop=ALL"]
        args = ["--pull=never", "--platform=linux/amd64", "--network=none", "--ipc=private",
                "--security-opt=no-new-privileges", "--user", user, "--pids-limit=64", "--memory=512m",
                "--ulimit=cpu=120:120", "--shm-size=64m", "--log-driver=none", "--entrypoint=/usr/bin/env",
                *flags]
        for k, v in dict(label, **{LABEL_PREFIX + "role": role}).items():
            args.extend(("--label", k + "=" + v))
        for dest, path in bindings:
            args.extend(("--mount", f"type=bind,src={path},dst={dest},readonly"))
        sh = "/policy/writer.sh" if role == "writer" else "/probe/reader.sh"
        runtime = ["-i", "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "/bin/sh", "-e", sh, *inputs]
        pending_creates.add(role)
        ident = docker("container", "create", *args, origin, *runtime).decode().strip()
        need(CID.fullmatch(ident), "known-created-container-id")
        pending_creates.remove(role)
        return ident, runtime

    def inode(path):
        s = Path(path).lstat()
        return f"{s.st_dev}:{s.st_ino}"

    def stopped(ident, code):
        state = inspect("container", ident)["State"]
        need(state["Status"] == "exited" and state["Pid"] == 0 and state["ExitCode"] == code
             and not state["OOMKilled"] and not state["Error"], "exact-worker-closed")

    def remove(ident, role):
        row = inspect("container", ident)
        need(row["Id"] == ident and row["Config"]["Labels"] == base_labels | label | {LABEL_PREFIX + "role": role},
             "scoped-cleanup-identity")
        if row["State"]["Running"]:
            docker("container", "kill", "--signal=TERM", ident)
            docker("container", "wait", ident, timeout=8)
        state = inspect("container", ident)["State"]
        need(not state["Running"] and state["Pid"] == 0, "no-live-cleanup")
        need(docker("container", "rm", ident).decode().strip() == ident
             and not docker("container", "ls", "--all", "--quiet", "--filter", "id=" + ident),
             "owned-container-absent")

    data.note(root, env, "runtime-entered")
    try:
        with reached("writer-admitted"):
            mounts = [mount("/approved", "apt-input"), mount("/policy", "policy")]
            writer, argv = create("writer", policy["config"], mounts, [inode(path) for _, path in mounts]
                                 + pins["aptArgv"][6:])
            verify_role(inspect("container", writer), writer, "writer", policy["config"], mounts, argv)
            compare_views(root, pins)
            capacity(paths, pins, "writer")
        code, stdout, stderr = intake.bounded(intake.docker(root, "container", "start", "--attach", writer),
                                              root, 240, 128 << 10, capture_timeout=True)
        lines = stdout.decode("utf-8", errors="strict").splitlines()
        if lines.count("apt-readable") == 1:
            report("apt-readable", "pass")
        if lines.count("transaction-invoked") == 1:
            report("transaction-invoked", "pass")
        with reached("transaction"):
            need(code == 0 and not stderr and lines.count("apt-readable") == 1
                 and lines.count("transaction-invoked") == 1 and lines.count("transaction-verified") == 1
                 and lines.index("apt-readable") < lines.index("transaction-invoked")
                 and lines[-1] == "transaction-verified", "writer-transaction-refused")
            stopped(writer, 0)
        with reached("delta"):
            change_check(docker("container", "diff", writer, limit=384 << 10).decode(), stdout.decode(), pins)
        with reached("reader"):
            capacity(paths, pins, "writer")
            commit_pending = True
            candidate = docker("container", "commit", writer, timeout=80).decode().strip()
            need(SHA_ID.fullmatch(candidate) and candidate != policy["config"], "distinct-local-derived-image")
            image = inspect("image", candidate)
            layers = image["RootFS"]["Layers"]
            writer_labels = base_labels | label | {LABEL_PREFIX + "role": "writer"}
            need(image["Id"] == candidate and len(layers) == 2 and layers[0] == policy["diffID"]
                 and SHA_ID.fullmatch(layers[1]) and layers[1] != layers[0]
                 and not image["RepoTags"] and not image["RepoDigests"]
                 and image["Config"]["Labels"] == writer_labels, "owned-untagged-derived-image")
            derived = candidate
            commit_pending = False
            capacity(paths, pins, "reader")
            mounts = [mount("/job", "work"), mount("/sdk", "sdk"), mount("/probe", "probe")]
            reader, argv = create("reader", derived, mounts, [str(uid), str(gid), *[inode(path) for _, path in mounts]])
            verify_role(inspect("container", reader), reader, "reader", derived, mounts, argv)
            code, stdout, stderr = intake.bounded(intake.docker(root, "container", "start", "--attach", reader),
                                                  root, 105, 768 << 10, capture_timeout=True)
            need(code == 0 and not stderr and re.fullmatch(rb"reader-verified [a-f0-9]{64}\n", stdout),
                 "nonroot-toolchain-readback")
            stopped(reader, 0)
    finally:
        with reached("container-cleanup"):
            if reader:
                remove(reader, "reader")
            if writer:
                remove(writer, "writer")
            if derived:
                image = inspect("image", derived)
                need(image["Id"] == derived and image["Config"]["Labels"] == writer_labels,
                     "derived-cleanup-identity")
                docker("image", "rm", derived)
                visible = docker("image", "ls", "--no-trunc", "--quiet").decode().splitlines()
                need(derived not in visible, "derived-image-absent")
            need(not docker("container", "ls", "--all", "--quiet", "--filter",
                            "label=" + LABEL_PREFIX + "run=" + run, "--filter",
                            "label=" + LABEL_PREFIX + "commit=" + commit), "no-unknown-run-container")
            need(not pending_creates and not commit_pending, "noble-operation-unsettled")
            data.note(root, env, "runtime-retired")


def main():
    os.umask(0o077)
    env = os.environ
    root = data.scratch_path(env)
    with reached("same-job-inputs"):
        data.require_handoff(root, env)
        pins = json.loads((HERE / "pins.json").read_bytes())
        policy = authenticate_policy(pins, (HERE / "signed-policy.json").read_bytes())
    real_transaction(root, pins, policy, env["GITHUB_RUN_ID"], env["GITHUB_SHA"], env)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        text = str(error)
        print("noble-provision/refused/" + (text if re.fullmatch("[a-z][a-z0-9-]{0,65}", text) else "bounded"))
        sys.exit(1)
