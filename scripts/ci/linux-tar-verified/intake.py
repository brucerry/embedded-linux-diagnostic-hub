"""Bounded data intake for a Linux provider rehearsal. No package or worker execution."""

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import http.client
import json
import os
import re
import secrets
import signal
import ssl
import stat
from urllib.parse import urlsplit


FLOOR = 4 * 1024**3
BLOCK = 64 * 1024
MAX_OBJECTS = 64
MAX_INPUT_BYTES = 8 * 1024**2
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
SHA256 = re.compile(r'[0-9a-f]{64}')
SHA1 = re.compile(r'[0-9a-f]{40}')
COMPONENT = re.compile(r'[A-Za-z0-9_.-]{1,120}')
GROUPS = {
    'esbuild': ('evanw/esbuild', '609683d892977362a0f99026cb74b96263d728a9'),
    'filelist': ('mde/filelist', '7032f94d04ad905b4f32b92d2278785859e1d55f'),
    'ssh2': ('mscdex/ssh2', '844f1edfc41589737671f96a4f4e76afdf46abd4'),
    'builder': ('electron-userland/electron-builder', '512a57ec9bcda593d3e0970bd2b9a33a63beeb57'),
    'agent-base': ('TooTallNate/proxy-agents', 'b923f5363875d8fd56477094d5ffc562840a4b76'),
    'http-proxy-agent': ('TooTallNate/proxy-agents', 'b5f94e3222c0aaa3bc56218ff125e2c56417c86e'),
    'https-proxy-agent': ('TooTallNate/proxy-agents', '7cf0b795e05218d9e49047d5c93de77d2f606510'),
}
MODULE = 'golang.org/x/sys/@v/v0.0.0-20220715151400-c0bba94af5f8'
BLOCKED_ENV = {'http_proxy', 'https_proxy', 'all_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'sslkeylogfile'}


class Refused(ValueError):
    """Fixed diagnostic label with no transport, path or environment data."""


def need(condition, label):
    if not condition:
        raise Refused(label)


def components(path):
    pieces = path.split('/')
    need(all(COMPONENT.fullmatch(x) and x not in {'.', '..', '.git'} for x in pieces), 'path-shape')
    return pieces


@dataclass(frozen=True)
class Pin:
    name: str
    group: str
    url: str
    size: int
    sha256: str
    git_blob: str | None = None

    def address(self):
        u = urlsplit(self.url)
        need(self.url.isascii() and len(self.url) <= 400 and self.url == u.geturl() and
             u.scheme == 'https' and not u.query and not u.fragment, 'public-url')
        if self.group == 'x-sys':
            need(u.netloc == 'proxy.golang.org' and u.path in {f'/{MODULE}.{x}' for x in ('zip', 'mod', 'info')}
                 and self.git_blob is None, 'module-address')
        elif self.group == 'esbuild':
            repo, commit = GROUPS['esbuild']
            need(u.netloc == 'codeload.github.com' and u.path == f'/{repo}/tar.gz/{commit}' and
                 self.git_blob is None, 'esbuild-address')
        else:
            need(self.group in GROUPS, 'source-group')
            repo, commit = GROUPS[self.group]
            prefix = f'/{repo}/{commit}/'
            need(u.netloc == 'raw.githubusercontent.com' and u.path.startswith(prefix) and
                 isinstance(self.git_blob, str) and SHA1.fullmatch(self.git_blob), 'source-address')
            components(u.path[len(prefix):])
        return u


def pins_from_bytes(data, expected):
    need(len(data) <= 64 * 1024 and hashlib.sha256(data).hexdigest() == expected, 'manifest-sha')
    raw = json.loads(data)
    need(isinstance(raw, list) and 0 < len(raw) <= MAX_OBJECTS, 'manifest-count')
    pins = [Pin(*row) for row in raw]
    for p in pins:
        need(isinstance(p.name, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,45}', p.name)
             and type(p.size) is int and 0 < p.size <= MAX_INPUT_BYTES
             and isinstance(p.sha256, str) and SHA256.fullmatch(p.sha256), 'manifest-pin')
        p.address()
    need(len({p.name for p in pins}) == len({p.url for p in pins}) == len(pins), 'manifest-duplicate')
    need(sum(p.size for p in pins) <= MAX_INPUT_BYTES, 'manifest-byte-cap')
    return pins


@contextmanager
def deadline(seconds):
    def expired(_sig, _frame):
        raise Refused('intake-deadline')

    need(signal.getitimer(signal.ITIMER_REAL) == (0, 0), 'existing-timer')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@contextmanager
def public_bytes(pin):
    need(not any(value and name.lower() in BLOCKED_ENV for name, value in os.environ.items()),
         'ambient-proxy-or-trust-override')
    target = pin.address()
    connection = http.client.HTTPSConnection(target.hostname, timeout=6, context=ssl.create_default_context())
    try:
        try:
            connection.request('GET', target.path, headers={'Accept-Encoding': 'identity', 'Connection': 'close'})
            response = connection.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            raise Refused('official-transport') from exc
        with response:
            need(response.status == 200, 'official-http-status')
            lengths = response.headers.get_all('Content-Length', [])
            encoding = response.headers.get_all('Content-Encoding', [])
            framing = response.headers.get_all('Transfer-Encoding', [])
            need(lengths in ([], [str(pin.size)]) and encoding in ([], ['identity'])
                 and framing in ([], ['chunked']) and not (lengths and framing), 'official-http-framing')
            yield response
    finally:
        connection.close()


def verified_body(source, pin, destination=None):
    content = hashlib.sha256()
    git = hashlib.sha1(f'blob {pin.size}\0'.encode()) if pin.git_blob is not None else None
    remaining = pin.size
    while remaining:
        block = source.read(min(remaining, BLOCK))
        need(isinstance(block, bytes) and 0 < len(block) <= remaining, 'object-size')
        remaining -= len(block)
        content.update(block)
        if git is not None:
            git.update(block)
        if destination is not None:
            destination.write(block)
    need(source.read(1) == b'', 'object-size')
    need(content.hexdigest() == pin.sha256 and (git is None or git.hexdigest() == pin.git_blob), 'object-digest')


def inode(row):
    return row.st_dev, row.st_ino


def available(fd):
    space = os.fstatvfs(fd)
    return space.f_bavail * space.f_frsize


def ancestor(row, uid):
    return stat.S_ISDIR(row.st_mode) and row.st_uid in (0, uid) and not row.st_mode & 0o7022


@dataclass
class Checkpoints:
    data: str = 'unreached'
    capacity: str = 'unreached'
    retirement: str = 'unreached'


@contextmanager
def owned_parent(path):
    uid = os.getuid()
    need(0 < uid == os.geteuid(), 'nonroot')
    need(isinstance(path, str) and path.startswith('/') and len(path) <= 512, 'parent-path')
    names = components(path[1:])
    fd = os.open('/', DIR_FLAGS)
    try:
        need(ancestor(os.fstat(fd), uid), 'ancestor-owner-or-mode')
        for name in names:
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            need(ancestor(os.fstat(fd), uid), 'ancestor-owner-or-mode')
        need(os.fstat(fd).st_uid == uid, 'parent-owner')
        yield fd
    finally:
        os.close(fd)


class Stage:
    def __init__(self, parent_fd, name, stage_fd):
        self.parent_fd = parent_fd
        self.name = name
        self.fd = stage_fd
        self.files = {}

    def directory(self):
        row = os.fstat(self.fd)
        linked = os.stat(self.name, dir_fd=self.parent_fd, follow_symlinks=False)
        need(inode(row) == inode(linked) and stat.S_ISDIR(linked.st_mode)
             and (row.st_uid, row.st_gid) == (os.getuid(), os.getegid())
             and stat.S_IMODE(row.st_mode) == 0o700, 'stage-identity')
        return row

    def file(self, row, name):
        need(inode(row) == self.files[name] and stat.S_ISREG(row.st_mode)
             and row.st_uid == os.getuid() and row.st_nlink == 1
             and stat.S_IMODE(row.st_mode) == 0o600, 'stage-file-identity')

    def check_census(self):
        self.directory()
        observed = set()
        with os.scandir(self.fd) as entries:
            for entry in entries:
                need(entry.name in self.files, 'stage-foreign-entry')
                self.file(entry.stat(follow_symlinks=False), entry.name)
                observed.add(entry.name)
        need(observed == set(self.files), 'stage-missing-entry')

    def stage(self, pin, reader):
        self.directory()
        fd = os.open(pin.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.fd)
        with os.fdopen(fd, 'wb') as output:
            row = os.fstat(output.fileno())
            self.files[pin.name] = inode(row)
            self.file(row, pin.name)
            with reader(pin) as stream:
                verified_body(stream, pin, output)

    def readback(self, pins):
        self.check_census()
        for pin in pins:
            fd = os.open(pin.name, READ_FLAGS, dir_fd=self.fd)
            with os.fdopen(fd, 'rb') as stream:
                before = os.fstat(fd)
                self.file(before, pin.name)
                need(before.st_size == pin.size, 'readback-size')
                verified_body(stream, pin)
                linked = os.stat(pin.name, dir_fd=self.fd, follow_symlinks=False)
                self.file(linked, pin.name)
                need(linked.st_ctime_ns == os.fstat(fd).st_ctime_ns == before.st_ctime_ns, 'readback-change')

    def retire(self):
        self.check_census()
        for name in self.files:
            self.directory()
            self.file(os.stat(name, dir_fd=self.fd, follow_symlinks=False), name)
            os.unlink(name, dir_fd=self.fd)
        self.directory()
        os.rmdir(self.name, dir_fd=self.parent_fd)
        try:
            os.stat(self.name, dir_fd=self.parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise Refused('stage-retirement')


def run_intake(pins, parent, reader=public_bytes, *, checkpoints=None):
    # No output is handed to another process. Return a receipt only after retirement.
    checkpoints = checkpoints if checkpoints is not None else Checkpoints()
    checkpoints.data = 'fail'
    with owned_parent(parent) as parent_fd:
        fs = os.fstatvfs(parent_fd)
        block = max(4096, fs.f_frsize)
        reserve = sum(((p.size + block - 1) // block) * block for p in pins) + BLOCK
        need(available(parent_fd) >= FLOOR + reserve, 'pre-staging-capacity')
        name = 'hub-source-' + secrets.token_hex(12)
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        checkpoints.retirement = 'fail'
        try:
            fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
        except OSError as exc:
            raise Refused('scratch-retirement-unverified') from exc
        stage = Stage(parent_fd, name, fd)
        try:
            with deadline(160):
                for pin in pins:
                    stage.stage(pin, reader)
                stage.readback(pins)
                checkpoints.data = 'pass'
                checkpoints.capacity = 'fail'
                with owned_parent(parent) as real_parent:
                    need(inode(os.fstat(parent_fd)) == inode(os.fstat(real_parent)), 'parent-readback')
                    stage.directory()
                    need(os.fstat(fd).st_dev == os.fstat(real_parent).st_dev, 'stage-backing-store')
                    post = available(fd)
                    need(post >= FLOOR, 'post-staging-capacity')
                    checkpoints.capacity = 'pass'
        finally:
            try:
                stage.retire()
                checkpoints.retirement = 'pass'
            except (OSError, Refused) as exc:
                raise Refused('scratch-retirement-unverified') from exc
            finally:
                os.close(fd)
    return {'objects': len(pins), 'bytes': sum(pin.size for pin in pins), 'stageFreeBytes': post,
            'postStaging': True, 'canonicalReadback': True, 'retired': True}
