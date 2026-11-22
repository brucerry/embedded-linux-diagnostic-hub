"""Explicit mount policy and provider-phase executable placement."""
from hashlib import sha256
import os
from pathlib import Path
import shutil
import stat

import tar_admission as pins

WORK_SIZE = 10 * 1024**3
SCRATCH_SIZE = 768 * 1024**2
MOUNTS = {'/work': (WORK_SIZE, 'exec'), '/scratch': (SCRATCH_SIZE, 'noexec')}
PAGE = 4096
NODE_BYTES = 126_881_248
ESBUILD_BYTES = 11_427_966
GO_BYTES = {
    'go/bin/go': 15_434_568,
    'go/pkg/tool/linux_amd64/asm': 5_016_588,
    'go/pkg/tool/linux_amd64/compile': 25_774_723,
    'go/pkg/tool/linux_amd64/link': 6_680_481,
}
GO_DATA = ('VERSION', 'go.env', 'src', 'lib', 'pkg/include')


def tmpfs_options(path, uid, gid):
    size, execute = MOUNTS[path]
    return f'rw,nosuid,nodev,{execute},size={size},mode=0700,uid={uid},gid={gid}'


def page_bytes(length):
    return (length + PAGE - 1) // PAGE * PAGE


class ProviderLayout:
    """Reserve in scratch the block budget of every approved executable in work."""

    def __init__(self, work, scratch, go_digests, node_digest, esbuild_digest):
        pins.need(set(go_digests) == GO_BYTES.keys(), 'provider-go-roster')
        self.work = work
        self.scratch = scratch
        self.data = scratch / 'compiler'
        self.tools = work / 'provider-tools'
        self.goroot = self.tools / 'go'
        self.node = work / 'node-sdk/bin/node'
        self.esbuild = self.tools / 'esbuild'
        self.expected = {
            self.node: (NODE_BYTES, node_digest),
            self.esbuild: (ESBUILD_BYTES, esbuild_digest),
            **{self.tools / path: (size, go_digests[path]) for path, size in GO_BYTES.items()},
        }
        self.reserve_bytes = sum(page_bytes(size) for size, _ in self.expected.values())
        self.reserve = scratch / '.provider-work-blocks'
        self.go_ready = False
        self.esbuild_ready = False
        self.links = {self.goroot / part: self.data / 'go' / part for part in GO_DATA}

    def begin(self):
        pins.need(os.sysconf('SC_PAGE_SIZE') == PAGE
                  and self.work.lstat().st_dev != self.scratch.lstat().st_dev
                  and not any(self.work.iterdir()) and not any(self.scratch.iterdir()),
                  'empty-distinct-provider-roots')
        with self.reserve.open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.posix_fallocate(stream.fileno(), 0, self.reserve_bytes)
            info = os.fstat(stream.fileno())
        self.reservation = pins.stamp(info)
        self.verify_reservation()
        self.work_blocks = self.used_blocks(self.work)
        pins.need(self.work_blocks == 0, 'empty-executable-volume')
        self.data.mkdir(mode=0o700)
        self.tools.mkdir(mode=0o700)
        self.tools_identity = self.directory_identity(self.tools)

    @staticmethod
    def used_blocks(path):
        space = os.statvfs(path)
        pins.need(space.f_frsize == PAGE, 'provider-block-unit')
        return (space.f_blocks - space.f_bfree) * PAGE

    @staticmethod
    def directory_identity(path):
        row = path.lstat()
        pins.need(path.resolve(strict=True) == path and stat.S_ISDIR(row.st_mode)
                  and (row.st_uid, row.st_gid, stat.S_IMODE(row.st_mode))
                  == (os.getuid(), os.getgid(), 0o700), 'owned-provider-directory')
        return row.st_dev, row.st_ino

    def verify_executable(self, path):
        size, expected = self.expected[path]
        info, hashes, _ = pins.file_data(path, 'provider-executable', byte_count=size)
        pins.need(hashes['sha256'] == expected and stat.S_IMODE(info.st_mode) == 0o700
                  and info.st_gid == os.getgid() and info.st_dev == self.work.lstat().st_dev
                  and info.st_blocks * 512 == page_bytes(size), 'provider-executable-identity')
        return info.st_blocks * 512

    def stage_executable(self, path, data, save):
        size, expected = self.expected[path]
        pins.need(len(data) == size and sha256(data).hexdigest() == expected,
                  'provider-executable-before-placement')
        parent = self.work
        for part in path.parent.relative_to(self.work).parts:
            parent /= part
            parent.mkdir(mode=0o700, exist_ok=True)
            self.directory_identity(parent)
        save(path.parent, path.name, data, True)
        self.verify_executable(path)
        if path == self.esbuild:
            self.esbuild_ready = True

    def link_go_data(self):
        for path, target in self.links.items():
            info = target.lstat()
            want_directory = path.name in {'src', 'lib', 'include'}
            pins.need(target.resolve(strict=True) == target
                      and info.st_dev == self.scratch.lstat().st_dev
                      and info.st_uid == os.getuid() and info.st_gid == os.getgid()
                      and (stat.S_ISDIR(info.st_mode) if want_directory else
                           stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600),
                      'provider-go-data-target')
            path.symlink_to(target)
        self.go_ready = True

    def verify_reservation(self):
        info = self.reserve.lstat()
        pins.need(pins.stamp(info) == self.reservation and info.st_nlink == 1
                  and stat.S_IMODE(info.st_mode) == 0o600
                  and info.st_size == info.st_blocks * 512 == self.reserve_bytes,
                  'provider-block-reservation')

    def check(self):
        self.verify_reservation()
        pins.need(self.directory_identity(self.tools) == self.tools_identity,
                  'owned-provider-tool-root')
        expected = {self.node}
        if self.go_ready:
            expected.update(self.tools / path for path in GO_BYTES)
        if self.esbuild_ready:
            expected.add(self.esbuild)
        known_links = self.links if self.go_ready else {}
        known_dirs = {self.tools} | {
            parent for path in (*expected, *known_links)
            for parent in path.parents if parent.is_relative_to(self.work) and parent != self.work
        }

        def fail(error):
            raise error

        observed = set()
        for root, dirs, files in os.walk(self.work, followlinks=False, onerror=fail):
            for name in (*dirs, *files):
                path = Path(root) / name
                if path.is_symlink():
                    pins.need(path in known_links and os.readlink(path) == str(known_links[path])
                              and path.resolve(strict=True) == known_links[path], 'provider-data-link')
                    observed.add(path)
                elif path in known_dirs:
                    self.directory_identity(path)
                else:
                    pins.need(path in expected, 'provider-work-roster')
                    observed.add(path)
        pins.need(observed == expected | known_links.keys(), 'provider-work-census')
        used = sum(self.verify_executable(path) for path in expected)
        scratch_used = self.used_blocks(self.scratch)
        pins.need(self.used_blocks(self.work) == self.work_blocks + used
                  and used <= self.reserve_bytes <= scratch_used <= SCRATCH_SIZE
                  and scratch_used - self.reserve_bytes + used <= SCRATCH_SIZE,
                  'provider-combined-blocks')

    def retire(self):
        pins.need(shutil.rmtree.avoids_symlink_attacks
                  and self.directory_identity(self.tools) == self.tools_identity,
                  'owned-provider-tool-retirement')
        shutil.rmtree(self.tools)
        pins.need(not os.path.lexists(self.tools), 'retired-provider-tools')
        self.verify_executable(self.node)
        pins.need(self.used_blocks(self.work) == page_bytes(NODE_BYTES), 'retired-provider-work-blocks')
        self.verify_reservation()
        before = self.used_blocks(self.scratch)
        self.reserve.unlink()
        pins.need(not os.path.lexists(self.reserve)
                  and self.used_blocks(self.scratch) == before - self.reserve_bytes,
                  'retired-provider-reservation')
