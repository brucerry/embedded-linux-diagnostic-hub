"""Disabled host/guest control endpoints for one no-NIC portable launch."""

from dataclasses import dataclass
import os
from pathlib import Path
import re
import socket
import stat

from runtime_gate import accept, duration, inode, measure, need, peer, qemu_limits, decide

PORT_NAME = 'org.hub.runtime-preflight'
SOCK_LEAF = 'runtime-gate.sock'
ARGS = (
    '-chardev', 'socket,id=hubgate,path=/work/runtime-gate.sock,server=on,wait=off',
    '-device', 'virtio-serial-pci,id=hubserial',
    '-device', 'virtserialport,bus=hubserial.0,chardev=hubgate,name=org.hub.runtime-preflight',
)


@dataclass(frozen=True)
class Worker:
    pid: int
    pid_start: str
    uid: int
    gid: int


def start_readback(pid):
    body=Path(f'/proc/{pid}/stat').read_text(encoding='ascii')
    pre,sep,end=body.rpartition(') ')
    need(sep and len(body)<=4096 and pre.partition(' (')[0]==str(pid),'launch-qemu-process-id')
    ticks=end.split()[19]
    need(ticks.isdecimal(),'launch-qemu-process-start')
    return ticks


def host_work(work, overlay_owner, capacity, remaining, host_measurement, bound, end, *, cancelled=None, pregrant, measure_overlay=measure):
    need(type(host_measurement) is Worker and host_measurement.pid>1 and
         host_measurement.uid==os.getuid()>0 and host_measurement.gid==os.getgid()==overlay_owner.gid and
         host_measurement.pid_start==start_readback(host_measurement.pid),'launch-qemu-owner')
    owned=work.lstat()
    need(work==work.resolve(strict=True) and stat.S_ISDIR(owned.st_mode) and
         owned.st_uid==host_measurement.uid and stat.S_IMODE(owned.st_mode)==0o700,
         'launch-qemu-socket-parent')
    endpoint=work/SOCK_LEAF
    need(len(os.fsencode(endpoint))<=107,'launch-qemu-socket-path-length')
    state=endpoint.lstat()
    need(stat.S_ISSOCK(state.st_mode) and not state.st_mode&0o077 and
         state.st_uid==host_measurement.uid and state.st_gid==host_measurement.gid,
         'launch-qemu-socket-owner')
    def accept_guest():
        pregrant()
        need(inode(owned)==inode(work.lstat()) and inode(state)==inode(endpoint.lstat()) and
             host_measurement.pid_start==start_readback(host_measurement.pid),
             'launch-qemu-identity-drift')
        value=measure_overlay(work/'disk.qcow2',overlay_owner,capacity,remaining,
                       limits=qemu_limits(host_measurement.pid))
        need(host_measurement.pid_start==start_readback(host_measurement.pid),'launch-qemu-after-measure')
        return value
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as wire:
        wire.settimeout(duration(end))
        wire.connect(os.fspath(endpoint))
        peer(wire,host_measurement.pid,host_measurement.uid,host_measurement.gid)
        return accept(wire,bound,end,accept_guest,cancelled=cancelled)


def guest_control(bound,end):
    need(os.geteuid()==os.getuid()==0,'launch-guest-root-control')
    roster=[]
    for port in Path('/sys/class/virtio-ports').iterdir():
        if (port/'name').read_text(encoding='ascii').strip()==PORT_NAME:
            roster.append(port)
    need(len(roster)==1,'launch-guest-dedicated-port')
    port=roster[0]
    need(re.fullmatch(r'vport[0-9]+p[0-9]+',port.name),'launch-guest-port-id')
    dev=Path('/dev')/port.name
    need(dev==dev.resolve(strict=True),'launch-guest-port-path')
    initial=dev.lstat()
    expect_dev=(port/'dev').read_text(encoding='ascii').strip()
    need(stat.S_ISCHR(initial.st_mode) and initial.st_uid==initial.st_gid==0 and
         not initial.st_mode&0o077 and expect_dev==f'{os.major(initial.st_rdev)}:{os.minor(initial.st_rdev)}',
         'launch-guest-port-identity')
    fd=os.open(dev,os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        current=os.fstat(fd)
        need(inode(current)==inode(initial) and current.st_rdev==initial.st_rdev,'launch-guest-port-drift')
        decide(fd,bound,end)
    finally:
        os.close(fd)
