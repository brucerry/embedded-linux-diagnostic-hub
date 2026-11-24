"""Offline extraction/readback/retirement for the documented portable archive layout."""

from dataclasses import dataclass
from hashlib import sha256
from native_hash import sha256_stream
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
from time import monotonic

import archive_inventory
from native_preflight import need, by_descriptor
from pair_wire import directory_stamp, same_directory, stamp, tick


@dataclass(frozen=True)
class Staged:
    root: Path
    identity: tuple


def hashes(source, rows, deadline):
    result = {}
    source.seek(0)
    with tarfile.open(fileobj=source, mode='r|gz') as archive:
        for member in archive:
            tick(deadline)
            path = Path(member.name)
            expected = rows[path]
            if expected.kind == 'file':
                digest = sha256()
                with archive.extractfile(member) as stream:
                    remaining = expected.size
                    while remaining:
                        tick(deadline)
                        chunk = stream.read(min(65536, remaining))
                        need(bool(chunk), 'portable-member-truncated')
                        digest.update(chunk)
                        remaining -= len(chunk)
                    need(not stream.read(1), 'portable-member-surplus')
                result[path] = digest.hexdigest()
    need(set(result) == {path for path,row in rows.items() if row.kind == 'file'},
         'portable-archive-file-set')
    return result


def readback(root, rows, pins):
    owner = os.getuid()
    found = set()
    for parent, dirs, files in os.walk(root, followlinks=False):
        for item in (*dirs, *files):
            leaf = Path(parent) / item
            relative = leaf.relative_to(root)
            need(relative in rows and relative not in found, 'portable-readback-roster')
            found.add(relative)
            before = leaf.lstat()
            expected = rows[relative]
            need(before.st_uid == owner and before.st_gid == os.getgid() and
                 stat.S_IMODE(before.st_mode) == expected.mode, 'portable-readback-mode-owner')
            if expected.kind == 'directory':
                need(stat.S_ISDIR(before.st_mode), 'portable-readback-directory')
                continue
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                 before.st_size == expected.size, 'portable-readback-file')
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            with os.fdopen(fd, 'rb') as stream:
                opened = os.fstat(stream.fileno())
                need(stamp(opened) == stamp(before) and sha256_stream(stream).hexdigest() == pins[relative]
                     and stamp(opened) == stamp(os.fstat(stream.fileno())) == stamp(leaf.lstat()),
                     'portable-readback-bytes')
    need(found == set(rows), 'portable-readback-completeness')


def stage(mount, archive_size, archive_pin, root, deadline):
    # The private staging root is provided by the caller and empty. No package entry point runs.
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        identity = directory_stamp(info)
        same_directory(root, fd, identity)
        need(os.getuid() == os.geteuid() == info.st_uid > 0 and info.st_gid == os.getgid() and
             stat.S_IMODE(info.st_mode) == 0o700 and not os.listdir(fd), 'portable-staging-root')
        def checked_extract(source):
            rows = archive_inventory.tar_inventory(source)
            pins = hashes(source, rows, deadline)
            source.seek(0)
            # Match the tracked archive-runtime-identity extraction semantics.
            argv = ['/usr/bin/tar','--no-same-owner','--no-same-permissions','-xzf',
                    f'/proc/self/fd/{source.fileno()}','-C',f'/proc/self/fd/{fd}']
            seconds = deadline - monotonic()
            need(seconds > 0, 'portable-extract-deadline')
            subprocess.run(argv, pass_fds=(fd,source.fileno()), env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                           stdin=subprocess.DEVNULL,check=True,timeout=min(45,seconds),umask=0o022)
            same_directory(root, fd, identity)
            readback(root, rows, pins)
            tick(deadline)
            return rows, pins
        rows,pins = by_descriptor(mount,'tar.tgz',archive_pin,archive_size,checked_extract)
        return Staged(root, identity), rows,pins
    finally:
        os.close(fd)

