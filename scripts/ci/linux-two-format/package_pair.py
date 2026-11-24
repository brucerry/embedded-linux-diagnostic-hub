"""Same-worker AppImage tool intake and build-only evidence. No artifact execution."""

from contextlib import nullcontext
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile

import compiler_gate
import handoff
import read_envelope
import runtime_input
import tar_admission as pins


from worker_protocol import EXTRACTION_POLICY_REVIEWED
EXTRACTION_ARGV = ("npm", "run", "verify:linux")
LAUNCHER = "download-run.sh"
LAUNCHER_SHA256 = "2263c79e0a742cf16a4991c6d7c21458877da32e011d37c612033cca90477477"
PACKAGER_ELF = "linux/x64/mksquashfs"
CODECS = ("libz.so.1", "liblzma.so.5", "liblzo2.so.2", "liblz4.so.1", "libzstd.so.1")
WRAPPER_UTILITIES = ("env", "bash", "dirname", "basename", "uname", "tr")
NOBLE_LIBDL = Path("/usr/lib/x86_64-linux-gnu/libdl.so.2")
NOBLE_LIBDL_PIN = {"bytes":14408, "uid":0, "gid":0, "mode":"0644",
                  "sha256":"4dbcca3c01ca84d092b5b7b2610f5835b55fc70a0288dd9d766b40ac9386e2d9"}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def stock(path):
    located = path.resolve(strict=True)
    compiler_gate.protected_ancestors(located)
    info, observed, _ = pins.file_data(located, "pinned-image-stock-utility", owned=False)
    pins.need(info.st_uid == 0 and not info.st_mode & 0o7022, "image-tool-ownership")
    return str(located), observed["sha256"]


def pinned_link_target(name, roster):
    current = PurePosixPath(name)
    seen = set()
    while roster[str(current)]["type"] == "symlink":
        target = roster[str(current)]["linkTarget"]
        pins.need(current not in seen and "/" not in target and target not in ("", ".", ".."),
                  "appimage-pinned-alias-chain")
        seen.add(current)
        current = current.with_name(target)
    pins.need(roster[str(current)]["type"] == "file", "appimage-alias-file-target")
    return current


def stage_members(archive, root, spec, corrected):
    _, observed, data = pins.file_data(
        archive, "appimage-tools-body", byte_count=spec["bytes"], capture=True, capture_limit=12*1024**2,
    )
    pins.need(observed["sha256"] == spec["sha256"], "appimage-tools-archive-pin")
    runtime = runtime_input.read_runtime(corrected)
    notices = runtime_input.read_notices(runtime_input.read_spec())
    expected = spec["members"]
    pins.need(runtime_input.RUNTIME in expected and expected[runtime_input.RUNTIME]["type"] == "file",
              "publisher-runtime-role")
    seen = set()
    links = {}
    root.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as package:
        for member in package:
            name = member.name.removeprefix("./")
            if name not in expected:
                continue
            relative = PurePosixPath(name)
            pins.need(str(relative) == name and not relative.is_absolute()
                      and ".." not in relative.parts and name not in seen, "appimage-member-path")
            pin = expected[name]
            pins.need(member.mode == int(pin["mode"], 8) and member.size == pin["size"],
                      "appimage-member-shape")
            seen.add(name)
            path = root / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if pin["type"] == "directory":
                pins.need(member.isdir(), "appimage-member-directory")
                path.mkdir(mode=0o700, exist_ok=True)
            elif pin["type"] == "symlink":
                pins.need(member.issym() and member.linkname == pin["linkTarget"] and
                          "/" not in member.linkname and member.linkname not in ("", ".", ".."),
                          "appimage-link-pin")
                links[path] = member.linkname
            else:
                pins.need(pin["type"] == "file" and member.isfile() and not member.sparse,
                          "appimage-regular-member")
                body = package.extractfile(member).read(pin["size"] + 1)
                pins.need(len(body) == pin["size"] and sha(body) == pin["sha256"], "appimage-member-digest")
                with path.open("xb") as output:
                    output.write(runtime if name == runtime_input.RUNTIME else body)
                    os.fchmod(output.fileno(), member.mode)
    pins.need(seen == set(expected), "appimage-member-roster")
    for path, target in links.items():
        pinned_link_target(path.relative_to(root).as_posix(), expected)
        path.symlink_to(target)
    for path in links:
        canonical = root / pinned_link_target(path.relative_to(root).as_posix(), expected)
        pins.need(path.resolve(strict=True) == canonical and canonical.is_file(),
                  "appimage-canonical-alias-target")
    pins.need(runtime_input.read_runtime(root / runtime_input.RUNTIME) == runtime,
              "corrected-runtime-stage-readback")
    runtime_input.stage_notices(root, notices)
    return observed["sha256"]

def stage_tools(archive, root, spec, corrected, loader, parse_loader, command, *, phase=nullcontext):
    """Read pinned data before requesting a bounded normal loader observation in the worker."""
    with phase("packer_members"):
        archive_digest = stage_members(archive, root, spec, corrected)
    with phase("packer_stock"):
        utilities = {name:stock(Path("/usr/bin")/name) for name in WRAPPER_UTILITIES}
        libdir = root/"linux/x64/lib"
        resolution = {name:str((libdir/name).resolve(strict=True)) for name in CODECS}
        for name in ("libpthread.so.0", "libm.so.6", "libc.so.6"):
            resolution[name], _ = stock(Path("/usr/lib/x86_64-linux-gnu")/name)
        # The bundled liblzma has a DT_NEEDED edge to the Noble glibc compatibility DSO.
        compiler_gate.read_member(NOBLE_LIBDL, NOBLE_LIBDL_PIN, capture=False)
        resolution[NOBLE_LIBDL.name] = str(NOBLE_LIBDL)
        resolution[Path(loader).name], _ = stock(Path(loader))
    with phase("packer_loader"):
        pinned_env = {"PATH":"/usr/bin:/bin", "LANG":"C"}
        argv = [loader, "--library-path", libdir, "--list", root/PACKAGER_ELF]
        pins.need(parse_loader(command(argv, pinned_env, 12)) == resolution,
                  "appimage-packer-live-loader-resolution")
    return sha(json.dumps({"archive":archive_digest, "utilities":utilities, "resolution":resolution,
                           "corrected_runtime":runtime_input.RUNTIME_SHA,
                           "corrected_runtime_spec":runtime_input.SPEC_SHA},
                          sort_keys=True).encode())


def live_attempt(input_path, bound, tool_receipt):
    _, _, data = pins.file_data(input_path, "attempt-input", capture=True, capture_limit=2048)
    row = json.loads(data, object_pairs_hook=handoff.closed_object)
    pins.need(set(row) == {"source_commit","workflow_sha256","worker_binding","run_id"} and
              row["run_id"]+"-1" == bound, "same-job-source-and-attempt")
    result = handoff.Attempt(
        handoff.REPOSITORY, row["source_commit"], handoff.SOURCE_CHECKOUT_TREE, handoff.PRODUCT_TREE,
        handoff.PRODUCT_MANIFEST, handoff.LINUX_LOCK, row["workflow_sha256"], row["run_id"], 1,
        "two-format", row["worker_binding"], tool_receipt,
    )
    handoff.validate_attempt(result)
    return result


def appimage_envelope(release, attempt):
    seal = handoff.bind_after_producer(release, attempt)
    envelope = read_envelope.stable_read(release/handoff.APPIMAGE)
    appimage = seal.artifacts[0]
    pins.need((envelope["artifactSHA256"], envelope["bytes"]) == (appimage.sha256, appimage.size)
              and not envelope["artifactExecuted"] and not envelope["filesystemInventoryVerified"],
              "same-appimage-envelope")
    return seal


def copy_launcher(project, release):
    _, digests, data = pins.file_data(project/"public"/LAUNCHER, "linux-launcher-source",
                                       capture=True, capture_limit=65536)
    pins.need(digests["sha256"] == LAUNCHER_SHA256,"linux-launcher-pin")
    with (release/LAUNCHER).open("xb") as output:
        output.write(data)


def evidence(release, attempt, seal):
    checks = handoff.read_official_evidence(release, attempt, seal)
    _, observed, _ = pins.file_data(release/LAUNCHER, "same-job-launcher")
    _, _, sidecar = pins.file_data(release/(LAUNCHER+".sha256"), "same-job-launcher-checksum",
                                   capture=True, capture_limit=256)
    pins.need(observed["sha256"] == LAUNCHER_SHA256 and
              sidecar == f"{LAUNCHER_SHA256}  {LAUNCHER}\n".encode(),"same-job-launcher-sidecar")
    appimage, tarball = seal.artifacts
    return tarball.sha256, appimage.sha256, checks[handoff.RECORD], observed["sha256"]
