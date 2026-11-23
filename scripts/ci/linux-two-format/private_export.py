"""Bounded same-attempt tar handoff. Importing this module performs no effects."""

from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import re
import stat
import struct

import handoff
import folder_record


TAR = handoff.TARBALL
SIDECAR = TAR + '.sha256'
RECORD = handoff.RECORD
NAMES = (TAR, SIDECAR, RECORD)
LIMITS = (handoff.ARCHIVE_CAP, 256, 65536)
HEADER_LIMIT = 4096
MAGIC = b'HUBFOLDER2\n'
TRAILER = b'\nHUBFOLDER-END\n'
CHUNK = 65536


def need(ok, label):
    if not ok:
        raise ValueError(label)


def attempt_fields(attempt):
    from host_attempt import HostAttempt
    need(type(attempt) is HostAttempt, 'private-host-attempt-type')
    return attempt.fields


def worker_attempt(path, bound):
    import tar_admission
    _, _, data = tar_admission.file_data(path, 'attempt-input', capture=True, capture_limit=2048)
    row = json.loads(data, object_pairs_hook=handoff.closed_object)
    need(type(row) is dict and set(row) == {'source_commit','workflow_sha256','worker_binding','run_id'}
         and handoff.hex_string(row['source_commit'],40)
         and row['source_commit'] != '5e3c66f4a62e3606abdd650972e0f76b71ff5c54'
         and all(handoff.hex_string(row[key],64) for key in ('workflow_sha256','worker_binding'))
         and re.fullmatch(r'[1-9][0-9]{0,18}',row['run_id']) and row['run_id']+'-1' == bound,
         'exact-worker-attempt')
    return row | {
        'repository':handoff.REPOSITORY,'source_checkout_tree':handoff.SOURCE_CHECKOUT_TREE,
        'product_tree':handoff.PRODUCT_TREE,'manifest_sha256':handoff.PRODUCT_MANIFEST,
        'lock_sha256':handoff.LINUX_LOCK,'run_attempt':1,'job':'two-format',
    }


def frame(header):
    data = json.dumps(header, separators=(',', ':'), sort_keys=True).encode('ascii')
    need(0 < len(data) <= HEADER_LIMIT, 'export-header-size')
    return MAGIC + struct.pack('>I', len(data)) + data


def capture_original(folder, name, cap):
    with handoff.open_original(folder, name, cap, False) as (source, size, stamp):
        digest = file_digest(source,'sha256').hexdigest()
    return handoff.Artifact(name,size,digest,stamp)


def create_record(release, attempt):
    with handoff.release_directory(release) as (folder, _):
        tar, sidecar = [capture_original(folder,name,cap) for name,cap in zip(NAMES[:2],LIMITS[:2])]
        need(sidecar.sha256 == sha256(f'{tar.sha256}  {TAR}\n'.encode('ascii')).hexdigest(),
             'producer-original-sidecar')
        payload = folder_record.encode(folder_record.record(attempt,tar.size,tar.sha256))
        with os.fdopen(os.open(RECORD,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,
                               0o400,dir_fd=folder),'wb') as output:
            output.write(payload)
        created = capture_original(folder,RECORD,LIMITS[2])
        need(created.sha256 == sha256(payload).hexdigest(),'producer-original-record')
        return tar,sidecar,created


def write_originals(release, attempt, originals, out):
    """Transfer the sealed producer originals, after proof and child retirement."""
    with handoff.release_directory(release) as (folder, _):
        header = {'attempt':attempt,'members':[[item.name,item.size,item.sha256] for item in originals]}
        out.write(frame(header))
        for item,cap in zip(originals,LIMITS,strict=True):
            with handoff.open_original(folder,item.name,cap,False) as (source,size,stamp):
                need(size == item.size and stamp == item.identity,'export-original-identity')
                digest, transferred = sha256(),0
                while data := source.read(CHUNK):
                    transferred += len(data)
                    need(transferred <= size,'export-file-limit')
                    digest.update(data)
                    out.write(data)
                need(transferred == size and digest.hexdigest() == item.sha256,'export-file-digest')
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
    need(type(header) is dict and set(header) == {'attempt','members'} and
         header['attempt'] == attempt_fields(expected_attempt), 'export-attempt')
    tar_hash, record_hash = expected_digests
    expected_sidecar = f'{tar_hash}  {TAR}\n'.encode('ascii')
    pins = (tar_hash,sha256(expected_sidecar).hexdigest(),record_hash)
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
            need(record == folder_record.record(attempt_fields(expected_attempt),sizes[0],tar_hash),
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
