"""Data-only custody bridge for a just-built, in-worker Linux package pair."""

from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import re
import stat


APPIMAGE = "Diagnostic-Hub-linux-x64.AppImage"
TARBALL = "Diagnostic-Hub-linux-x64.tar.gz"
ARTIFACTS = (APPIMAGE, TARBALL)
RECORD = "linux-build-info.json"
SOURCE_CHECKOUT_TREE = "04750dde7d6a027568f0aa855795c1efaa80d6a5"
PRODUCT_TREE = "ffd5fece5f1e66b3f3aee944717987be25731c13"
PRODUCT_MANIFEST = "db69f2f556942cf45edbd6d4fe352a13ef2338f7083b87a807e366bbdebae57d"
LINUX_LOCK = "6eda133d8af11aae5e896876515130792e781f2054d071e2f68a9bcc4272b64c"
REPOSITORY = "brucerry/embedded-linux-diagnostic-hub"
RUNTIME_BYTES = 944_632
RUNTIME_SHA256 = "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
ARCHIVE_CAP = 256 * 1024**2  # This venue plan's allowance, below the repository-wide acceptance cap.
UNPERFORMED = "unperformed: packaged loopback SSH; real-PC acceptance remains separate."


@dataclass(frozen=True)
class Attempt:
    """Only the admitted controller can supply authoritative live attempt fields."""

    repository: str
    source_commit: str
    source_checkout_tree: str
    product_tree: str
    manifest_sha256: str
    lock_sha256: str
    workflow_sha256: str
    run_id: str
    run_attempt: int
    job: str
    worker_binding: str
    runner_tool_receipt_sha256: str


@dataclass(frozen=True)
class Artifact:
    name: str
    size: int
    sha256: str
    identity: tuple


@dataclass(frozen=True)
class Seal:
    attempt: Attempt
    directory: tuple
    artifacts: tuple[Artifact, ...]


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def hex_string(value, width):
    return isinstance(value, str) and re.fullmatch(f"[a-f0-9]{{{width}}}", value) is not None


def validate_attempt(attempt):
    need(type(attempt) is Attempt, "controller-attempt")
    need((attempt.repository, attempt.product_tree, attempt.manifest_sha256, attempt.lock_sha256) ==
         (REPOSITORY, PRODUCT_TREE, PRODUCT_MANIFEST, LINUX_LOCK), "exact-linux-profile")
    need(attempt.source_commit != "5e3c66f4a62e3606abdd650972e0f76b71ff5c54"
         and hex_string(attempt.source_commit, 40) and attempt.source_checkout_tree == SOURCE_CHECKOUT_TREE,
         "reviewed-successor-checkout-required")
    need(type(attempt.run_attempt) is int and attempt.run_attempt == 1
         and re.fullmatch(r"[1-9][0-9]{0,18}", attempt.run_id)
         and re.fullmatch(r"[a-z][a-z0-9_-]{0,62}", attempt.job), "exact-attempt")
    for item in (attempt.workflow_sha256, attempt.worker_binding, attempt.runner_tool_receipt_sha256):
        need(hex_string(item, 64), "attempt-pinned-control-and-worker")


def stamp(st):
    return (st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode,
            st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def directory_identity(st):
    return st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode


@contextmanager
def release_directory(path):
    uid = os.geteuid()
    need(uid == os.getuid() and uid > 0, "nonroot-controller")
    need(path.name == "release" and path.is_absolute() and path.resolve(strict=True) == path,
         "canonical-release-directory")
    for parent in path.parents:
        if parent == Path("/"):
            break
        entry = parent.lstat()
        need(stat.S_ISDIR(entry.st_mode) and entry.st_uid in (0, uid) and not entry.st_mode & 0o7022,
             "release-directory-ancestry")
    need(path.parent.stat().st_uid == uid and stat.S_IMODE(path.parent.stat().st_mode) == 0o700,
         "private-project")
    descriptor = os.open(path, os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_RDONLY)
    try:
        info = os.fstat(descriptor)
        identity = directory_identity(info)
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o7022
             and identity == directory_identity(path.lstat()), "release-directory-identity")
        yield descriptor, identity
        need(identity == directory_identity(path.lstat()) == directory_identity(os.fstat(descriptor)),
             "release-directory-replaced")
    finally:
        os.close(descriptor)


@contextmanager
def open_original(directory, name, cap, executable):
    need(name in {*ARTIFACTS, RECORD, *(artifact + ".sha256" for artifact in ARTIFACTS)}, "closed-output-path")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        before = stamp(info)
        need(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= cap and info.st_nlink == 1
             and info.st_uid == os.geteuid() and info.st_dev == os.fstat(directory).st_dev
             and not info.st_mode & 0o7022
             and (stat.S_IMODE(info.st_mode) == 0o755 if executable else not info.st_mode & 0o111),
             "original-artifact-identity")
        need(before == stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)), "original-path-race")
        yield stream, info.st_size, before
        need(before == stamp(os.fstat(stream.fileno())) ==
             stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)), "original-artifact-mutated")


def appimage_prefix(stream):
    prefix = stream.read(RUNTIME_BYTES)
    need(len(prefix) == RUNTIME_BYTES and sha256(prefix).hexdigest() == RUNTIME_SHA256
         and prefix[:7] == b"\x7fELF\x02\x01\x01" and prefix[8:11] == b"AI\x02"
         and prefix[18:20] == b"\x3e\x00" and stream.read(4) == b"hsqs", "exact-static-x64-runtime")
    stream.seek(0)


def read_artifacts(directory):
    rows = []
    for name in ARTIFACTS:
        with open_original(directory, name, ARCHIVE_CAP, name == APPIMAGE) as (body, count, identity):
            if name == APPIMAGE:
                appimage_prefix(body)
            else:
                need(body.read(3) == b"\x1f\x8b\x08", "gzip-envelope")
                body.seek(0)
            rows.append(Artifact(name, count, file_digest(body, "sha256").hexdigest(), identity))
    return tuple(rows)


def bind_after_producer(path, attempt):
    """Read only after checked empty start, official producer exit and producer process closure."""
    validate_attempt(attempt)
    with release_directory(path) as (directory, owner):
        present = set(os.listdir(directory))
        need(set(ARTIFACTS) <= present and RECORD not in present
             and not any(name + ".sha256" in present for name in (*ARTIFACTS, "download-run.sh")), "fresh-pre-verification-outputs")
        return Seal(attempt, owner, read_artifacts(directory))


def recheck_for_verifier(path, live_attempt, seal):
    """Rebind immediately before official verification, inside the trusted controller."""
    validate_attempt(live_attempt)
    need(type(seal) is Seal and seal.attempt == live_attempt, "same-live-producer-attempt")
    with release_directory(path) as (directory, owner):
        need(owner == seal.directory and read_artifacts(directory) == seal.artifacts, "same-produced-originals")


def closed_object(pairs):
    out = dict(pairs)
    need(len(out) == len(pairs), "duplicate-archive-record-keys")
    return out


def read_official_evidence(path, live_attempt, seal):
    """Validate the unchanged producer files after successful official verification."""
    recheck_for_verifier(path, live_attempt, seal)
    with release_directory(path) as (directory, owner):
        need(owner == seal.directory, "same-evidence-directory")
        hashes = {}
        evidence = {}
        for row in seal.artifacts:
            sidecar = row.name + ".sha256"
            expected = f"{row.sha256}  {row.name}\n".encode("ascii")
            with open_original(directory, sidecar, 256, False) as (body, _, _):
                need(body.read() == expected, "original-sidecar-content")
            evidence[sidecar] = sha256(expected).hexdigest()
            hashes[row.name] = row.sha256
        with open_original(directory, RECORD, 65536, False) as (body, _, _):
            raw = body.read()
            record = json.loads(raw, object_pairs_hook=closed_object)
            need(record == {"version": "0.6.0", "platform": "linux", "arch": "x64", "assets": hashes,
                            "commit": live_attempt.source_commit, "validation": UNPERFORMED},
                 "official-linux-build-record-content")
            evidence[RECORD] = sha256(raw).hexdigest()
        need(read_artifacts(directory) == seal.artifacts, "same-originals-after-custody-readback")
        return evidence


if __name__ == "__main__":
    raise SystemExit("held: no approved live controller supplies the actual same-attempt package pair")
