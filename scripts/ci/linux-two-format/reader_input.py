"""Data-only intake and private staging of the exact signed Canonical reader."""

from hashlib import sha256
import io
import os
from pathlib import Path
import stat
import tarfile

import compiler_gate
import tar_admission as pins


DEB = 'squashfs-tools_4.6.1-1build1_amd64.deb'
URL = 'https://archive.ubuntu.com/ubuntu/pool/main/s/squashfs-tools/' + DEB
DEB_BYTES = 189326
DEB_SHA256 = '87fae263846bab255d4a51ad9fc623685497ad830db60758dde39589c9fdadcb'
NOBLE_INDEX_SHA256 = '2a6a199e1031a5c279cb346646d594993f35b1c03dd4a82aaa0323980dd92451'
ARCHIVE_SIGNER = 'F6ECB3762474EDA9D21B7022871920D1991BC93C'
MEMBER = '/usr/bin/unsquashfs'
MEMBER_BYTES = 151448
MEMBER_MODE = 0o755
MEMBER_SHA256 = 'b305985eb764b6d0ef757571e3e44044ebf71c827c4263efe576e9e14b4abcfb'
PAYLOAD_CAP = 1024**2
LEAF = 'unsquashfs'
WORK = Path('/work')
INPUT = Path('/inputs/media')/LEAF


def archive_stamp(archive):
    info, hashes, _ = pins.file_data(archive, 'reader-signed-noble-deb', byte_count=DEB_BYTES)
    pins.need(hashes['sha256'] == DEB_SHA256 and stat.S_IMODE(info.st_mode) == 0o400,
              'reader-signed-noble-deb')
    return pins.stamp(info)


def read_payload(raw, expected):
    pins.need(0 < len(raw) <= PAYLOAD_CAP, 'reader-deb-tar-bound')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as data:
        members = [row for row in data if row.name.removeprefix('./') == MEMBER[1:]]
        pins.need(len(members) == 1, 'reader-deb-member-count')
        member = members[0]
        pins.need(member.isreg() and not member.issparse() and
                  (member.uid, member.gid, member.mode, member.size) == (0, 0, MEMBER_MODE, MEMBER_BYTES),
                  'reader-deb-regular-member')
        with data.extractfile(member) as stream:
            return verify_body(stream.read(MEMBER_BYTES + 1), expected)


def verify_body(body, expected):
    pins.need((expected['canonical'], expected['package'], expected['version'], expected['bytes'],
               expected['mode'], expected['digest']) ==
              (MEMBER, 'squashfs-tools', '1:4.6.1-1build1', MEMBER_BYTES, MEMBER_MODE, MEMBER_SHA256),
              'reader-signed-projection')
    pins.need(len(body) == MEMBER_BYTES and sha256(body).hexdigest() == MEMBER_SHA256, 'reader-member-digest')
    linked = expected['elf']
    pins.need(compiler_gate.elf_identity(body) == (linked['interpreter'], linked['needed']) and
              linked['interpreter'] == [compiler_gate.INTERPRETER] and not linked['searchPaths'], 'reader-elf-identity')
    return body


def private_directory(path):
    info = path.lstat()
    pins.need(path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode) and
              (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (os.getuid(), os.getgid(), 0o700),
              'reader-private-directory')
    return info.st_dev, info.st_ino


def check_stage(path):
    root = private_directory(WORK)
    owner = private_directory(path.parent)
    pins.need(path == WORK/'appimage-reader'/LEAF and owner[0] == root[0] and
              {item.name for item in path.parent.iterdir()} == {LEAF}, 'reader-dedicated-work-path')
    row, hashes, _ = pins.file_data(path, 'reader-staged-file', byte_count=MEMBER_BYTES)
    pins.need(row.st_dev == root[0] and row.st_gid == os.getgid() and stat.S_IMODE(row.st_mode) == MEMBER_MODE
              and hashes['sha256'] == MEMBER_SHA256 and private_directory(path.parent) == owner,
              'reader-staged-file-identity')
    return owner, pins.stamp(row)


def stage_member(source, expected):
    row, _, body = pins.file_data(source, 'reader-same-job-input', byte_count=MEMBER_BYTES, capture=True)
    pins.need(row.st_gid == os.getgid() and stat.S_IMODE(row.st_mode) == 0o400, 'reader-input-mode')
    verify_body(body, expected)
    private_directory(WORK)
    path = WORK/'appimage-reader'/LEAF
    path.parent.mkdir(mode=0o700)
    with path.open('xb') as out:
        out.write(body)
        os.fchmod(out.fileno(), MEMBER_MODE)
    return path, check_stage(path)
