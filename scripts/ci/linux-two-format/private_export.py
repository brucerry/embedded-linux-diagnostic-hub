"""Bounded same-attempt tar handoff. Importing this module performs no effects."""

from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
import struct

import handoff


TAR = handoff.TARBALL
SIDECAR = TAR + '.sha256'
RECORD = handoff.RECORD
NAMES = (TAR, SIDECAR, RECORD)
LIMITS = (handoff.ARCHIVE_CAP, 256, 65536)
HEADER_LIMIT = 4096
MAGIC = b'HUBFOLDER1\n'
TRAILER = b'\nHUBFOLDER-END\n'
CHUNK = 65536


def need(ok, label):
    if not ok:
        raise ValueError(label)


def attempt_fields(attempt):
    if type(attempt) is not handoff.Attempt:
        from host_attempt import HostAttempt
        need(type(attempt) is HostAttempt, "private-host-attempt-type")
        return attempt.fields
    handoff.validate_attempt(attempt)
    return {key:getattr(attempt,key) for key in (
        'repository', 'source_commit', 'source_checkout_tree', 'product_tree', 'manifest_sha256',
        'lock_sha256', 'workflow_sha256', 'run_id', 'run_attempt', 'job', 'worker_binding',
    )}


def path_digest(data):
    return sha256(data).hexdigest()


def frame(header):
    data = json.dumps(header, separators=(',', ':'), sort_keys=True).encode('ascii')
    need(0 < len(data) <= HEADER_LIMIT, 'export-header-size')
    return MAGIC + struct.pack('>I', len(data)) + data


def write_originals(release, attempt, seal, verified_digests, out):
    """Call after archive and process verification, while the producing worker owns the originals."""
    checks = handoff.read_official_evidence(release, attempt, seal)
    image, tar = seal.artifacts
    need((tar.sha256,image.sha256,checks[RECORD]) == tuple(verified_digests[:3]), 'export-originals')
    sidecar = f'{tar.sha256}  {TAR}\n'.encode('ascii')
    need(checks[SIDECAR] == path_digest(sidecar), 'export-sidecar-pin')
    with handoff.release_directory(release) as (folder, identity):
        need(identity == seal.directory, 'export-release-identity')
        with handoff.open_original(folder, RECORD, LIMITS[2], False) as (_, size, __):
            sizes = (tar.size, len(sidecar), size)
        pins = (tar.sha256, checks[SIDECAR], checks[RECORD])
        header = {'attempt': attempt_fields(attempt), 'appimageSHA256': image.sha256,
                  'members': [[name, size, digest] for name,size,digest in zip(NAMES,sizes,pins)]}
        out.write(frame(header))
        for name, expected_size, expected_sha, cap in zip(NAMES,sizes,pins,LIMITS):
            with handoff.open_original(folder, name, cap, False) as (source, count, stamp):
                need(count == expected_size and (name != TAR or stamp == tar.identity), 'export-file-seal')
                digest, transferred = sha256(), 0
                while data := source.read(CHUNK):
                    transferred += len(data)
                    need(transferred <= expected_size, 'export-file-limit')
                    digest.update(data)
                    out.write(data)
                need(transferred == expected_size and digest.hexdigest() == expected_sha, 'export-file-digest')
    need(handoff.read_official_evidence(release, attempt, seal) == checks, 'export-source-recheck')
    out.write(TRAILER)
    out.flush()


def exact(incoming, size):
    parts = bytearray()
    while len(parts) < size:
        data = incoming.read(size - len(parts))
        need(data and len(data) <= size - len(parts), 'export-truncated')
        parts.extend(data)
    return bytes(parts)


def receive(incoming, directory, expected_attempt, expected_digests, *, reserve):
    """Receive into an attempt-owned empty directory from the supervisor's deadline-bound pipe."""
    need(exact(incoming,len(MAGIC)) == MAGIC, 'export-magic')
    length, = struct.unpack('>I',exact(incoming,4))
    need(0 < length <= HEADER_LIMIT, 'export-header-size')
    header = json.loads(exact(incoming,length), object_pairs_hook=handoff.closed_object)
    need(type(header) is dict and set(header) == {'attempt','appimageSHA256','members'} and
         header['attempt'] == attempt_fields(expected_attempt), 'export-attempt')
    tar_hash, appimage_hash, record_hash = expected_digests[:3]
    need(header['appimageSHA256'] == appimage_hash,'export-appimage-record-binding')
    expected_sidecar = f'{tar_hash}  {TAR}\n'.encode('ascii')
    pins = (tar_hash,path_digest(expected_sidecar),record_hash)
    members = header['members']
    need(type(members) is list and len(members) == len(NAMES), 'export-member-roster')
    sizes = []
    for row, name, cap, expected_sha in zip(members,NAMES,LIMITS,pins):
        need(type(row) is list and len(row) == 3 and row[0] == name and type(row[1]) is int and
             0 < row[1] <= cap and row[2] == expected_sha and re.fullmatch(r'[0-9a-f]{64}',expected_sha),
             'export-member-binding')
        sizes.append(row[1])
    need(sizes[1] == len(expected_sidecar), 'export-sidecar-size')
    fd = os.open(directory,os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        need(os.getuid() == os.geteuid() == info.st_uid != 0 and
             stat.S_IMODE(info.st_mode) == 0o700 and not os.listdir(fd), 'export-private-stage')
        check_directory(directory,fd,info)
        space = os.fstatvfs(fd)
        charge = sum((size + space.f_frsize - 1) // space.f_frsize * space.f_frsize for size in sizes)
        need(not space.f_flag & os.ST_RDONLY and space.f_favail >= len(NAMES) and
             space.f_bavail * space.f_frsize >= reserve + charge, 'export-stage-space')
        for name,size,expected_sha in zip(NAMES,sizes,pins):
            target = os.open(name,os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o400,dir_fd=fd)
            with os.fdopen(target,'wb') as out:
                digest = sha256()
                pending = size
                while pending:
                    chunk = exact(incoming,min(pending,CHUNK))
                    out.write(chunk)
                    digest.update(chunk)
                    pending -= len(chunk)
                out.flush()
                need(os.fstat(out.fileno()).st_size == size and digest.hexdigest() == expected_sha,
                     'export-received-digest')
        need(exact(incoming,len(TRAILER)) == TRAILER and incoming.read(1) == b'', 'export-trailer-and-eof')
        check_directory(directory,fd,info)
        need(set(os.listdir(fd)) == set(NAMES), 'export-final-roster')
        with handoff.open_original(fd, RECORD, LIMITS[2], False) as (source, _, __):
            record = json.loads(source.read(), object_pairs_hook=handoff.closed_object)
            need(record == {'version':'0.6.0','platform':'linux','arch':'x64',
                            'assets':{TAR:tar_hash,handoff.APPIMAGE:appimage_hash},
                            'commit':expected_attempt.source_commit,'validation':handoff.UNPERFORMED},
                 'export-record-profile')
        space = os.fstatvfs(fd)
        need(space.f_bavail * space.f_frsize >= reserve, 'export-post-stage-space')
        return header
    finally:
        os.close(fd)


def check_directory(path, fd, initial):
    need(Path(path).resolve(strict=True) == Path(path) and
         handoff.directory_identity(initial) == handoff.directory_identity(os.fstat(fd)) ==
         handoff.directory_identity(os.stat(path, follow_symlinks=False)), 'export-directory-replaced')
