"""Pre-launch, fixed-frame admission shared by the host and the gated Jammy guest."""

from dataclasses import dataclass
from hashlib import sha256
import os
from pathlib import Path
import re
import selectors
import socket
import stat
import struct
from time import monotonic

MiB = 2**20
MODEL_CAP = 2**31
DISK_FLOOR = 4 * 2**30
HOST_FLOOR = 6 * 2**30
CLUSTER = 65536


def need(value, label):
    if not value:
        raise ValueError(label)


def binding(nonce, pair_digest, observer_digest, case):
    need(all(type(x) is str and re.fullmatch('[a-f0-9]{64}', x)
             for x in (nonce, pair_digest, observer_digest)), 'launch-binding-digests')
    need(case in ('archive-runtime-identity', 'appimage-runtime-identity'), 'launch-case')
    return sha256(('\n'.join((nonce,pair_digest,observer_digest,case))+'\n').encode('ascii')).hexdigest()


def frame(kind, bound):
    need(kind in ('READY','GO') and re.fullmatch('[a-f0-9]{64}',bound), 'launch-gate-frame')
    return f'HUB-RT1 {kind} {bound}\n'.encode('ascii')


def duration(end, maximum=30):
    seconds = end - monotonic()
    need(seconds > 0, 'launch-gate-deadline')
    return min(seconds, maximum)


def exact(wire, amount, end, *, maximum=30, cancelled=None):
    answer = bytearray()
    while len(answer) < amount:
        need(cancelled is None or not cancelled(), 'launch-gate-cancelled')
        wire.settimeout(duration(end, maximum if cancelled is None else 1))
        try:
            block = wire.recv(amount - len(answer))
        except TimeoutError:
            if cancelled is not None:
                continue
            raise
        need(bool(block), 'launch-gate-truncated')
        answer.extend(block)
    return bytes(answer)


def peer(wire, pid, uid, gid):
    values = struct.unpack('3i', wire.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    need(values == (pid,uid,gid) and uid>0 and gid>0, 'launch-gate-peer-id')


@dataclass(frozen=True)
class OverlayOwner:
    dev: int
    ino: int
    uid: int
    gid: int


def inode(info):
    return OverlayOwner(info.st_dev,info.st_ino,info.st_uid,info.st_gid)


def qemu_limits(pid):
    text = Path(f'/proc/{pid}/limits').read_text(encoding='ascii')
    matches = re.findall(r'(?m)^Max file size\s+(\d+)\s+(\d+)\s+bytes\s*$', text)
    need(len(matches)==1, 'launch-qemu-limit-row')
    return tuple(int(col) for col in matches[0])


def measure(overlay, recorded, cap, remaining_overlay, *, limits):
    need(type(recorded) is OverlayOwner and recorded.uid==os.getuid()>0 and
         type(cap) is int and cap == MODEL_CAP and limits == (cap,cap) and
         0 < remaining_overlay < cap, 'launch-overlay-hard-limit')
    root = overlay.parent
    parent = root.lstat()
    need(root == root.resolve(strict=True) and stat.S_ISDIR(parent.st_mode) and
         parent.st_uid==recorded.uid and stat.S_IMODE(parent.st_mode)==0o700, 'launch-overlay-parent')
    fd = os.open(overlay, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and inode(info)==recorded==inode(overlay.lstat()) and
             info.st_nlink==1 and not info.st_mode & 0o7022, 'launch-overlay-identity')
        need(os.fstatvfs(fd).f_favail>=16 and
             os.fstatvfs(fd).f_bavail*os.fstatvfs(fd).f_frsize >= HOST_FLOOR+remaining_overlay,
             'launch-host-backing-reserve')
        occupied = max(info.st_size,info.st_blocks*512)
        need(0 < occupied <= cap and cap-occupied >= remaining_overlay, 'launch-overlay-reserve')
        return occupied
    finally:
        os.close(fd)


def check_guest_space(fs, guest_copy, inodes):
    need(not fs.f_flag & os.ST_RDONLY and fs.f_favail >= inodes and
         fs.f_bavail*fs.f_frsize >= DISK_FLOOR+guest_copy, 'launch-guest-free-floor')


def accept(wire, bound, end, admit, *, cancelled=None):
    """Read one exact READY frame and issue at most one grant on this connection."""
    expected = frame('READY',bound)
    # The host can connect before the guest provisions, within the shared 400 s boot deadline.
    need(exact(wire,len(expected),end,maximum=400,cancelled=cancelled)==expected, 'launch-host-foreign-ready')
    result = admit()
    need(cancelled is None or not cancelled(), 'launch-gate-cancelled')
    wire.settimeout(duration(end))
    wire.sendall(frame('GO',bound))
    return result


def decide(descriptor, bound, end):
    """Guest reads one exact grant from the dedicated virtio-serial character device."""
    os.set_blocking(descriptor, False)
    request = frame('READY',bound)
    grant = frame('GO',bound)
    written = 0
    received = bytearray()
    with selectors.DefaultSelector() as events:
        events.register(descriptor, selectors.EVENT_WRITE)
        while written < len(request):
            need(events.select(duration(end)), 'launch-guest-ready-timeout')
            try:
                count = os.write(descriptor, request[written:])
            except BlockingIOError:
                continue
            need(count > 0, 'launch-guest-ready-write')
            written += count
        events.modify(descriptor, selectors.EVENT_READ)
        while len(received) < len(grant):
            need(events.select(duration(end)), 'launch-guest-grant-timeout')
            try:
                part = os.read(descriptor, len(grant) - len(received))
            except BlockingIOError:
                continue
            need(bool(part), 'launch-gate-truncated')
            received.extend(part)
    need(received == grant, 'launch-guest-foreign-grant')
