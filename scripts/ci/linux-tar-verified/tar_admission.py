"""Data-only pre-install admission for the held tar.gz caller."""
import hashlib
import json
import os
from pathlib import Path
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

def native_ancestors(path):
    for parent in [*reversed(path.parents), path]:
        if parent == Path("/"):
            continue  # Same walk as the tracked Linux native builder.
        mode = parent.lstat()
        need(stat.S_ISDIR(mode.st_mode) and mode.st_uid in (0, os.getuid())
             and not mode.st_mode & 0o7022 and parent.resolve(strict=True) == parent, "native-ancestry")

def stock_packages(reference):
    """Verify the installed names, architectures and versions."""
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


def stock_members(reference):
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


def stock_compiler_alias():
    for location in ("/usr/bin/cc", "/etc/alternatives/cc"):
        alias = Path(location)
        info = alias.lstat()
        need(stat.S_ISLNK(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0), "native-cc-alias")
        native_ancestors(alias.parent)
    need(os.readlink("/usr/bin/cc") == "/etc/alternatives/cc"
         and Path("/usr/bin/cc").resolve(strict=True) ==
         Path("/usr/bin/x86_64-linux-gnu-gcc-13"), "native-cc-alias")

