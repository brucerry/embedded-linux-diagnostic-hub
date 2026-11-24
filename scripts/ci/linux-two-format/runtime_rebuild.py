"""Rebuild the pinned runtime from public inputs before the offline worker starts."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
from time import monotonic

import runtime_input as runtime
import tar_admission as pins

INPUTS_SHA = "f606455052017524ad31cc08115891920301cf2a0d16788903815cc84f6b6d04"
APK_BYTES = 207146643
REQUIRED_FREE = pins.FLOOR + 1024**3
LEAF = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]+")
RECIPE = ("build-offline.sh", "link-runtime.sh", "squash-env.sh", "squash-compile.sh")
KEY_NAME = "alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub"


def prepare_apk(work, invoke):
    alpine = work / "alpine"
    snapshot = alpine / "apk-tools-static.apk"
    keyring = alpine / "keys"
    keyring.mkdir(mode=0o700)
    shutil.copyfile(alpine / "site.rsa.pub", keyring / KEY_NAME)
    required = {"sbin/apk.static": (alpine / "apk", 4762720),
                "sbin/apk.static.SIGN.RSA.sha256." + KEY_NAME: (alpine / "apk.sig", 512)}
    with tarfile.open(snapshot, "r:gz", ignore_zeros=True) as archive:
        members = archive.getmembers()
        for name, (destination, cap) in required.items():
            rows = [member for member in members if member.name == name]
            pins.need(len(rows) == 1 and rows[0].isfile() and rows[0].size == cap, "apk-bootstrap-member")
            with archive.extractfile(rows[0]) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
    invoke(["/usr/bin/openssl", "dgst", "-sha256", "-verify", keyring / KEY_NAME,
            "-signature", alpine / "apk.sig", alpine / "apk"], 6, "pinned-apk-bootstrap")
    (alpine / "apk").chmod(0o700)
    return alpine / "apk", keyring


def install_sysroot(work, archives, invoke):
    apk, keys = prepare_apk(work, invoke)
    alpine = work / "alpine"
    root = alpine / "sysroot"
    (root / "etc/apk/cache").mkdir(mode=0o700, parents=True)
    repos = root / "etc/apk/repositories"
    repos.touch(exist_ok=False)
    base = [apk, "--root", root, "--keys-dir", keys, "--repositories-file", repos,
            "--no-network", "--arch", "x86_64"]
    invoke([*base, "verify", *archives], 20, "signed-alpine-toolchain")
    invoke([*base, "--cache-dir", "etc/apk/cache", "add", "--initdb", "--no-scripts",
            "--no-commit-hooks", *archives], 38, "private-alpine-sysroot")
    audit = invoke([*base, "audit", "--system"], 20, "installed-alpine-file-readback")
    names = (root / "lib/apk/db/installed").read_bytes().splitlines()
    pins.need(not audit and sum(line.startswith(b"P:") for line in names) == len(archives),
              "closed-alpine-sysroot")
    (alpine / "SYSROOT-PATH.txt").write_text(str(root) + "\n", encoding="ascii")
    return root


def prepare_recipe(work, sysroot, spec, invoke):
    source = work / "src/runtime"
    source.mkdir(mode=0o700, parents=True)
    shutil.copyfile(work / "upstream/runtime.c", source / "runtime.c")
    patch = runtime.SOURCE / "patches/runtime-cleanup.patch"
    _, digest, _ = pins.file_data(patch, "cleanup-source-patch")
    pins.need(digest["sha256"] == spec["cleanupPatchSHA256"], "cleanup-source-patch-pin")
    invoke(["/usr/bin/patch", "--batch", "--fuzz=0", "-d", work, "-p1", "-i", patch],
           5, "patched-runtime-source")
    code = (source / "runtime.c").read_bytes()
    pins.need(sha256(code).hexdigest() == spec["cleanupSourceSHA256"], "patched-runtime-source-pin")
    (work / "candidate").mkdir(mode=0o700)
    (work / "candidate/runtime.c").write_bytes(code)
    for shell in RECIPE:
        shutil.copyfile(runtime.SOURCE / shell, work / shell)
    controls = ["alpine/libfuse.tar.xz", "alpine/squashfuse.tar.gz", "candidate/runtime.c",
                "upstream/data_sections.ld", "upstream/libfuse-mount.c.diff"]
    (work / "BUILD-INPUTS.sha256").write_text("".join(
        sha256((work / name).read_bytes()).hexdigest() + "  " + name + "\n" for name in controls
    ), encoding="ascii")
    tools = work / "local-bin"
    tools.mkdir(mode=0o700)
    wrappers = json.loads((runtime.SOURCE / "tool-wrappers.json").read_bytes())
    for name, value in wrappers.items():
        pins.need(LEAF.fullmatch(name), "runtime-wrapper-name")
        rendered = value.replace("@SYSROOT@", str(sysroot)).replace("@TOOLS@", str(tools))
        executable = tools / name
        executable.write_text(rendered, encoding="ascii")
        executable.chmod(0o700)
    libtool = tools / "relocated-libtool"
    libtool.mkdir(mode=0o700)
    for name, target in {"build-aux": "libtool/build-aux", "m4": "aclocal", "libltdl": "libtool"}.items():
        (libtool / name).symlink_to(sysroot / "usr/share" / target)
    config = (sysroot / "usr/share/autoconf/autom4te.cfg").read_text()
    (tools / "autom4te.cfg").write_text(config.replace(
        "/usr/share/autoconf", str(sysroot / "usr/share/autoconf")
    ))


def rebuild(parent, destination, download, command, *, free, deadline):
    """No registry writes, uploads, host settings changes or runtime launch."""
    pins.need(free(parent) >= REQUIRED_FREE, "runtime-rebuild-backing")
    pins.need(parent.resolve(strict=True) == parent and parent.stat().st_uid == os.getuid()
              and re.fullmatch(r"/[A-Za-z0-9_./-]+", str(parent)), "unambiguous-runtime-build-path")
    spec = runtime.read_spec()
    _, pin, body = pins.file_data(runtime.SOURCE / "BUILD-INPUTS.json", "runtime-inputs", capture=True)
    pins.need(pin["sha256"] == INPUTS_SHA, "runtime-input-manifest")
    config = json.loads(body)
    packages, sources = config["packages"], config["sources"]
    pins.need(len(packages) == 77 and sum(p["size"] for p in packages) == APK_BYTES,
              "runtime-package-closure")
    work = Path(tempfile.mkdtemp(prefix="appimage-input-", dir=parent))
    owned = (work.stat().st_dev, work.stat().st_ino, work.stat().st_uid)

    def invoke(argv, seconds, label):
        remaining = deadline - monotonic()
        pins.need(remaining > 1, "runtime-rebuild-deadline")
        return command([str(part) for part in argv],
                       {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "HOME": str(work), "TMPDIR": str(work)},
                       min(seconds, remaining), label, cwd=work)

    def fetch(row):
        remaining = deadline - monotonic()
        pins.need(remaining > 1, "runtime-intake-deadline")
        download(row, work, seconds=min(57, remaining))

    try:
        for path in ("alpine", "upstream", "packages"):
            (work / path).mkdir(mode=0o700)
        plan = [(name, row["url"], row["bytes"], row["sha256"], row["redirect"])
                for name, row in sources.items()]
        paths = []
        for row in packages:
            filename = f'{row["name"]}-{row["version"]}.apk'
            pins.need(LEAF.fullmatch(filename) and row["repo"] in ("main", "community")
                      and row["url"] == f'https://dl-cdn.alpinelinux.org/alpine/v3.21/{row["repo"]}/x86_64/{filename}',
                      "runtime-public-apk-url")
            name = "packages/" + filename
            paths.append(work / name)
            plan.append((name, row["url"], row["size"], row["sha256"], False))
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(fetch, plan))
        pins.need(monotonic() < deadline and free(parent) >= pins.FLOOR, "runtime-input-budget")
        root = install_sysroot(work, paths, invoke)
        prepare_recipe(work, root, spec, invoke)
        pins.need(free(parent) >= pins.FLOOR, "runtime-post-stage-floor")
        invoke(["/bin/bash", work / "build-offline.sh", "cold"], 110, "runtime-rebuild")
        pins.need(monotonic() < deadline and free(parent) >= pins.FLOOR, "runtime-output-budget")
        _, digest, body = pins.file_data(work / "cold/runtime/runtime-x86_64", "runtime-build-output",
                                         byte_count=runtime.RUNTIME_BYTES, capture=True)
        pins.need(digest["sha256"] == runtime.RUNTIME_SHA, "exact-rebuilt-runtime")
        with destination.open("xb") as output:
            output.write(body)
            os.fchmod(output.fileno(), 0o400)
        runtime.read_runtime(destination)
    finally:
        stamp = work.lstat()
        pins.need((stamp.st_dev, stamp.st_ino, stamp.st_uid) == owned and work.resolve() == work
                  and shutil.rmtree.avoids_symlink_attacks, "runtime-rebuild-scratch-ownership")
        shutil.rmtree(work)
        pins.need(not os.path.lexists(work), "runtime-rebuild-scratch-retirement")
