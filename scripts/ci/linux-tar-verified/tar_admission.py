"""Data-only pre-install admission for the held tar.gz caller."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat

HERE = Path(__file__).resolve().parent
REPO = "brucerry/embedded-linux-diagnostic-hub"
REF = "refs/heads/ci/v060-linux-folder-mode-tar-buildonly-20261121"
ENTRY = REPO + "/.github/workflows/linux-tar-only-entry.yml@" + REF
BASE = "5e3c66f4a62e3606abdd650972e0f76b71ff5c54"
TREE = "25bee80732419d25b98614c414ef3d336bd9f03d"
LOCK = "6eda133d8af11aae5e896876515130792e781f2054d071e2f68a9bcc4272b64c"
FLOOR = 4 * 1024**3
CAP = 256 * 1024**2
ELECTRON = ".linux-package-inputs/electron-v44.5.1-linux-x64"
MANIFESTS = {
    "BUILD-ADMISSION.json": "9ff1008e31d2052d4d86a5df1d9b23ac678d0fc369a09fc90afadb2002b2513a",
    "CUSTODY.json": "12a27a8ead5d61f91205a4d9bb8cddec1d6754ac14f8193a526eca7eca7deea4",
    "NOBLE-COMPILER-REFERENCE.json": "bd9984d62023c8f161426429fdfb1a6ea7e5da66eea62a2e529e7c8e0970bd62",
    "PROVIDER-INPUTS.json": "f1cae7b1b253672e9de857aac673c1b275e65b7d20b2a8022e03228faf4fddf2",
    "REGISTRY-PLAN.json": "5cdad124072fe4422fb7b27691731c98fee1fe92558195dc6ea8ec6338e2c259",
    "SDK-MEMBERS.json": "3382c6771e2a08245e2a274ece91d2b780f1ee6eca3cf6d8500d63d717ec5199",
    "SOURCE-FILES.json": "e8959a2e567247223cf66a010a3e1f8fef68062ef85aff6094d3e1d527d2c7ab",
}

class Refused(Exception):
    pass

def need(ok, label):
    if not ok:
        raise Refused(label)

def stamp(info):
    return tuple(getattr(info, name) for name in (
        "st_dev", "st_ino", "st_uid", "st_gid", "st_nlink", "st_mode", "st_size",
        "st_mtime_ns", "st_ctime_ns",
    ))

def file_data(path, label, *, byte_count=None, digests=("sha256",), capture=False,
              owned=True, capture_limit=2 * 1024**2):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and (not owned or (
             info.st_uid == os.getuid() and info.st_nlink == 1 and not info.st_mode & 0o7022
        )), label)
        need(path.resolve(strict=True) == path and stamp(path.lstat()) == stamp(info), label)
        limit = capture_limit if capture else CAP
        need(0 <= info.st_size <= limit and (byte_count is None or info.st_size == byte_count), label)
        hasher = {name: hashlib.new("sha1" if name == "git" else name) for name in digests}
        if "git" in hasher:
            hasher["git"].update(f"blob {info.st_size}\0".encode())
        counter = 0
        data = bytearray()
        for part in iter(lambda: stream.read(128 * 1024), b""):
            counter += len(part)
            need(counter <= info.st_size, label)
            for digest in hasher.values():
                digest.update(part)
            if capture:
                data.extend(part)
        need(counter == info.st_size and stamp(os.fstat(stream.fileno())) == stamp(info)
             and stamp(path.lstat()) == stamp(info) and path.resolve(strict=True) == path, label)
        return info, {name: h.hexdigest() for name, h in hasher.items()}, bytes(data)

def pins(root=HERE):
    result = {}
    for name, expected in MANIFESTS.items():
        _, observed, body = file_data(root / "pins" / name, "control-pin", capture=True)
        need(observed["sha256"] == expected, "control-pin")
        result[name] = json.loads(body)
    build = result["BUILD-ADMISSION.json"]
    plan = result["PROVIDER-INPUTS.json"]
    need(build["testOnlyOverlayTree"] == TREE and plan["baseCommit"] == BASE
         and build["successorTree"] == plan["tree"] and build["lockSHA256"] == plan["lockSHA256"] == LOCK
         and result["SOURCE-FILES.json"]["tree"] == TREE
         and build["registryPlanSHA256"] == MANIFESTS["REGISTRY-PLAN.json"]
         and len(plan["inputs"]) == 80, "control-binding")
    return result

def sri(hexadecimal):
    return "sha512-" + base64.b64encode(bytes.fromhex(hexadecimal)).decode("ascii")

def fail_walk(error):
    raise error

def file_inventory(root, omit=()):
    need(root.resolve(strict=True) == root and stat.S_ISDIR(root.lstat().st_mode), "inventory-root")
    files = set()
    for current, dirs, names in os.walk(root, followlinks=False, onerror=fail_walk):
        rel = Path(current).relative_to(root)
        for name in tuple(dirs):
            path = Path(current) / name
            if str(rel / name) in omit:
                dirs.remove(name)
                continue
            info = path.lstat()
            need(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o7022
                 and info.st_uid == os.getuid(), "inventory-directory")
        for name in names:
            files.add(str(rel / name))
    return files

def providers(path, build):
    expected = build["allFileProviders"]
    need(len(expected) == 8, "provider-roster")
    need(file_inventory(path) == {Path(entry["path"]).name for entry in expected.values()},
         "provider-roster")
    for name, entry in sorted(expected.items()):
        label = "provider:" + name
        _, found, _ = file_data(path / Path(entry["path"]).name, label,
                               byte_count=entry["size"], digests=("sha256", "sha512"))
        need(found["sha256"] == entry["sha256"] and sri(found["sha512"]) == entry["integrity"], label)

def source(project, source_map):
    expected = source_map["files"]
    # Official Electron is read independently. Nothing else may be staged in source.
    need(file_inventory(project, (ELECTRON,)) == set(expected), "source-roster")
    for rel, (oid, executable) in expected.items():
        file, found, _ = file_data(project / rel, "source-blob", digests=("git",))
        need(found["git"] == oid and bool(file.st_mode & 0o111) == executable, "source-blob")

def registry(root, plan, lock_file):
    _, observed, body = file_data(lock_file, "lock-digest", capture=True)
    need(observed["sha256"] == LOCK, "lock-digest")
    lock = json.loads(body)["packages"]
    expected = {key + ".tgz" for key in plan}
    need(len(expected) == 299 and file_inventory(root) == expected, "registry-roster")
    slots = set()
    for index, (digest, pin) in enumerate(sorted(plan.items()), 1):
        label = f"registry:{index}"
        _, response, _ = file_data(root / (digest + ".tgz"), label,
                                  byte_count=pin["bytes"], digests=("sha256", "sha512"))
        need(response["sha256"] == pin["sha256"] and response["sha512"] == digest
             and sri(digest) == pin["sri"], label)
        for slot in pin["slots"]:
            need(slot not in slots and lock[slot]["integrity"] == pin["sri"]
                 and lock[slot]["resolved"] == pin["url"], label)
            slots.add(slot)
    need(len(slots) == 306, "registry-placements")

def signed_media(node, electron, custody):
    for name, path in (("node", node), ("electron", electron)):
        expected = custody["officialMediaReadback"][name]
        _, found, _ = file_data(path, "media:" + name, byte_count=expected["bytes"])
        need(found["sha256"] == expected["sha256"], "media:" + name)

def sdk_members(sdk, electron, manifest):
    node_files = file_inventory(sdk / "include/node")
    npm_files = file_inventory(sdk / "lib/node_modules/npm")
    for prefix, present in (("include/node/", node_files), ("lib/node_modules/npm/", npm_files)):
        need({prefix + leaf for leaf in present} == {leaf for leaf in manifest["node"]
             if leaf.startswith(prefix)}, "sdk-member-roster")
    need(file_inventory(electron) == set(manifest["electron"]), "electron-member-roster")
    # Verify the selected npm lane and forbid off-tree npm aliases.
    for kind, root in (("node", sdk), ("electron", electron)):
        for rel, entry in manifest[kind].items():
            path = root / rel
            label = kind + "-member"
            if "link" in entry:
                info = path.lstat()
                need(stat.S_ISLNK(info.st_mode) and info.st_uid == os.getuid()
                     and os.readlink(path) == entry["link"]
                     and path.resolve(strict=True) == sdk / "lib/node_modules/npm/bin/npm-cli.js", label)
                continue
            info, found, _ = file_data(path, label, byte_count=entry["bytes"])
            need(found["sha256"] == entry["sha256"] and bool(info.st_mode & 0o111) == entry["exec"], label)

def native_ancestors(path):
    for parent in [*reversed(path.parents), path]:
        if parent == Path("/"):
            continue  # Same walk as the tracked Linux native builder.
        mode = parent.lstat()
        need(stat.S_ISDIR(mode.st_mode) and mode.st_uid in (0, os.getuid())
             and not mode.st_mode & 0o7022 and parent.resolve(strict=True) == parent, "native-ancestry")

def stock_native(reference):
    """Read-only package and member proof; cache/actual execution proof is separate."""
    _, _, raw = file_data(Path("/var/lib/dpkg/status"), "native-package-db", capture=True,
                          owned=False, capture_limit=16 * 1024**2)
    installed = {}
    for paragraph in raw.decode().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in paragraph.splitlines()
                      if line and not line[0].isspace() and ": " in line)
        if fields.get("Status") == "install ok installed" and "Package" in fields:
            installed[fields["Package"], fields.get("Architecture")] = fields.get("Version")
    for name, pin in reference["packages"].items():
        need(installed.get((name, pin["Architecture"])) == pin["Version"], "native-package:" + name)
    for members in reference["members"].values():
        for rel, entry in members.items():
            path = Path("/") / rel
            info = path.lstat()
            need((info.st_uid, info.st_gid, f"{info.st_mode & 0o7777:04o}") ==
                 (entry["uid"], entry["gid"], entry["mode"]), "native-member-metadata")
            if entry["type"] == "symlink":
                need(stat.S_ISLNK(info.st_mode) and os.readlink(path) == entry["target"], "native-alias")
            else:
                _, found, _ = file_data(path, "native-member", byte_count=entry["bytes"], owned=False)
                need(found["sha256"] == entry["sha256"], "native-member")
    for location in ("/usr/bin/cc", "/etc/alternatives/cc"):
        alias = Path(location)
        info = alias.lstat()
        need(stat.S_ISLNK(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0), "native-cc-alias")
        native_ancestors(alias.parent)
    need(os.readlink("/usr/bin/cc") == "/etc/alternatives/cc"
         and Path("/usr/bin/cc").resolve(strict=True) ==
         Path("/usr/bin/x86_64-linux-gnu-gcc-13"), "native-cc-alias")

def space(paths):
    observed = {}
    for role, path in paths.items():
        need(path.resolve(strict=True) == path and stat.S_ISDIR(path.lstat().st_mode), "storage-path")
        info = path.stat()
        volume = os.statvfs(path)
        observed[role] = {"device": info.st_dev, "available": volume.f_bavail * volume.f_frsize}
    return observed

def context(env):
    sha = env.get("GITHUB_SHA", "")
    run = env.get("GITHUB_RUN_ID", "")
    need(env.get("GITHUB_ACTIONS") == "true" and env.get("GITHUB_REPOSITORY") == REPO
         and env.get("GITHUB_REF") == REF and env.get("GITHUB_WORKFLOW_REF") == ENTRY
         and env.get("GITHUB_EVENT_NAME") == "push" and env.get("GITHUB_JOB") == "tar-only"
         and env.get("GITHUB_RUN_ATTEMPT") == "1"
         and re.fullmatch(r"[a-f0-9]{40}", sha) and sha != BASE
         and sha == env.get("GITHUB_WORKFLOW_SHA") == env.get("REVIEWED_WORKFLOW_SHA")
         and re.fullmatch(r"[1-9][0-9]{0,18}", run), "exact-workflow-context")
    event_file = Path(env.get("GITHUB_EVENT_PATH", ""))
    need(event_file.is_absolute(), "push-event")
    _, _, event_body = file_data(event_file, "push-event", capture=True)
    event = json.loads(event_body)
    need(event.get("ref") == REF and event.get("after") == sha and event.get("created") is True
         and event.get("forced") is False and event.get("deleted") is False, "push-event")
    # Paths and run ID come from stock Actions context; the stage is never selected by user input.
    temp = Path(env.get("RUNNER_TEMP", ""))
    need(temp.is_absolute() and temp.resolve(strict=True) == temp, "runner-temp")
    return temp / ("hub-tar-only-" + run + "-1")

def hosted_scope(env):
    release = Path("/etc/os-release").read_text().splitlines()
    need(os.uname().sysname == "Linux" and os.uname().machine == "x86_64"
         and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
         and env.get("RUNNER_ARCH") == "X64" and env.get("RUNNER_OS") == "Linux"
         and os.getuid() > 0 and os.getuid() == os.geteuid()
         and "ID=ubuntu" in release and 'VERSION_ID="24.04"' in release, "host-platform")

def owned_stage(root):
    need(root.exists(), "same-job-stage-missing")
    native_ancestors(root)
    stat_ = root.lstat()
    need(stat_.st_uid == os.getuid() and stat_.st_mode & 0o7777 == 0o700, "same-job-stage-owner")

def decision(env):
    completed = []
    stage = "workflow"
    try:
        root = context(env)
        completed.append(stage)
        stage = "host"
        hosted_scope(env)
        completed.append(stage)
        stage = "control-pins"
        cfg = pins()
        completed.append(stage)
        stage = "staging"
        owned_stage(root)
        completed.append(stage)
        project = root / "source"
        sdk = root / "node-sdk"
        stage = "providers"
        providers(project / "vendor", cfg["BUILD-ADMISSION.json"])
        completed.append(stage)
        stage = "source"
        source(project, cfg["SOURCE-FILES.json"])
        completed.append(stage)
        stage = "registry"
        registry(root / "registry", cfg["REGISTRY-PLAN.json"], project / "package-lock.json")
        completed.append(stage)
        stage = "tools"
        signed_media(root / "media/node.tar.gz", root / "media/electron.zip", cfg["CUSTODY.json"])
        sdk_members(sdk, project / ELECTRON, cfg["SDK-MEMBERS.json"])
        native_ancestors(sdk / "include/node")
        stock_native(cfg["NOBLE-COMPILER-REFERENCE.json"])
        completed.append(stage)
        stage = "storage"
        for rel in ("node_modules", "dist-linux-native", "release"):
            need(not os.path.lexists(project / rel), "dirty-output-stage")
        observations = space({
            "native-and-release-parent": project,
            "node-sdk": sdk,
            "registry": root / "registry",
            "process-temp": root / "tmp",
            "builder-temp": root / "builder-tmp",
            "readback": root / "private-receipts",
        })
        need(observations["native-and-release-parent"]["available"] >= FLOOR, "post-staging-four-gib")
        completed.append(stage)
        # The data probes cannot attest who populated the job or enforce execution-time limits.
        # This held caller has no runner adapter or reviewed allocation/confinement policy.
        stage = "bounded-worker"
        raise Refused("same-job-staging-and-worker-supervisor-unbound")
    except Refused as error:
        reason = str(error)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Only fixed messages leave this step. Never print a path or a runner error.
        reason = "input-missing" if isinstance(error, FileNotFoundError) else "unreadable-or-invalid"
    return {"decision": "refused", "firstFailure": stage, "reason": reason, "checks": completed}

if __name__ == "__main__":
    print(json.dumps(decision(os.environ), separators=(",", ":")))
    raise SystemExit(1)
