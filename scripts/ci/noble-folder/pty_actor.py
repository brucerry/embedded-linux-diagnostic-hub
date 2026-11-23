"""Two fixed installer operations on a private PTY. Importing never starts a process."""
from contextlib import nullcontext
from dataclasses import dataclass
import errno
import os
from pathlib import Path
import pty
import re
import select
import termios
from time import monotonic

import consent
from loader_gate import need
from filesystem import UUID4


PROMPT_CAP = 16384
OUTPUT_CAP = 131072
OP_SECONDS = 135
TAIL = {
    'install': b'Linux setup operation completed; previous transaction artifacts remain retained.\n',
    'uninstall-current': b'Linux current no-menu payload removed. Settings, reports, original transaction records and any completed Finalize ledger are retained.\n',
}
EXEC = Path(consent.APP) / 'diagnostic-hub'
ENV = {
    'PATH': '/usr/bin:/bin',
    'LANG': 'C.UTF-8',
    'HOME': consent.HOME,
    'TMPDIR': consent.HOME + '/tmp',
    'XDG_CONFIG_HOME': consent.CONFIG,
    'XDG_DATA_HOME': consent.HOME + '/data',
    'ELECTRON_RUN_AS_NODE': '1',
    'LD_LIBRARY_PATH': consent.APP + '/usr/lib',
}


@dataclass(frozen=True)
class Receipt:
    operation: str
    profile: str
    pid: int
    start_ticks: int
    reviewed: int
    exit_status: int
    pt_eof: bool


def pump(port, operation, profile, deadline, *, now=monotonic, phase=nullcontext):
    """One positive write after an entire exact prompt. A failed port remains adopted."""
    need(operation in TAIL, 'pty-fixed-operation')
    scope = 'actor_install' if operation == 'install' else 'actor_uninstall'
    with phase(scope+'_exit'):
        limit = min(deadline, now() + OP_SECONDS)
        prompt = bytearray()
        tail = bytearray()
        sent = False
        selected_profile = None
        eof = False
        result = None
        owner = None
        while not (eof and result is not None):
            need(now() < limit, 'pty-deadline-retained')
            result = port.poll_exit()
            packet = port.read(eof, min(0.05, limit - now()))
            if packet is None:
                continue
            if packet == b'':
                eof = True
                continue
            need(type(packet) is bytes and not eof, 'pty-packet')
            if sent:
                tail.extend(packet)
                need(len(tail) + len(prompt) <= OUTPUT_CAP, 'pty-output-cap')
                continue
            prompt.extend(packet)
            need(len(prompt) <= PROMPT_CAP, 'pty-prompt-cap')
            if consent.TAIL.encode() not in prompt:
                continue
            word, selected_profile = consent.consent(operation, bytes(prompt), installed_profile=profile)
            need(re.fullmatch(re.escape(consent.PROFILE) + UUID4, selected_profile), 'pty-profile-v4')
            need(result is None and now() < limit, 'pty-child-exited-before-consent')
            owner = port.assert_prompt_owner(operation)
            need(type(owner) is tuple and len(owner) == 2 and
                 all(type(value) is int and value > 0 for value in owner), 'pty-child-identity')
            sent = True  # A partial/error write can never be retried.
            need(port.write_once(word) == len(word), 'pty-consent-write-retained')
        valid = sent and result == 0 and tail.replace(b'\r\n', b'\n') == TAIL[operation]
        if not valid:
            port.close_observed(eof,result)
            need(False,'pty-exact-completion')
    with phase(scope+'_closure'):
        port.close_observed(eof,result)
    return Receipt(operation, selected_profile, *owner, 1, result, eof)


def proc_bytes(path,cap):
    with path.open('rb') as body:
        value = body.read(cap+1)
    need(len(value)<=cap,'pty-proc-bound')
    return value


def proc_stat(pid):
    text = proc_bytes(Path(f'/proc/{pid}/stat'),8192)
    need(len(text) <= 8192 and text.startswith(f'{pid} ('.encode()), 'pty-proc-stat')
    rest = text.rsplit(b') ', 1)[1].split()
    need(len(rest) >= 20, 'pty-proc-stat')
    return tuple(int(rest[i]) for i in (1, 2, 3, 4, 19))


def only_uid_owners(uid, allowed):
    need(type(uid) is int and uid > 0, 'pty-no-root')
    live = set()
    scan = 0
    with os.scandir('/proc') as table:
        for entry in table:
            if not entry.name.isascii() or not entry.name.isdecimal():
                continue
            scan += 1
            need(scan <= 8192, 'pty-proc-bound')
            try:
                if entry.stat(follow_symlinks=False).st_uid == uid:
                    live.add(int(entry.name))
            except FileNotFoundError:
                continue
    need(live == set(allowed), 'pty-other-uid-process')


class PrivatePTY:
    """The future guest owner must retain this instance on an unresolved boundary."""

    def __init__(self, executable_stat, recheck):
        self.executable_stat = executable_stat
        self.recheck = recheck
        self.pid = self.master = self.pidfd = self.status = None
        self.owner = None
        self.written = False
        self.parent = os.getpid()
        self.uid = os.getuid()

    def spawn(self, operation):
        need(self.pid is None and self.uid == os.geteuid() > 0, 'pty-spawn-scope')
        arguments = consent.argv(operation)
        self.recheck(operation)
        only_uid_owners(self.uid, [self.parent])
        pid, master = pty.fork()
        if pid == 0:
            try:
                attrs = termios.tcgetattr(0)
                attrs[3] &= ~(termios.ECHO | termios.ECHONL)
                termios.tcsetattr(0, termios.TCSANOW, attrs)
                os.umask(0o022)  # Match the prepared envelope's file modes in the shipping copier.
                os.chdir(consent.HOME)
                os.execve(EXEC, arguments, ENV)
            finally:
                os._exit(78)
        self.pid, self.master = pid, master
        self.pidfd = os.pidfd_open(pid)
        os.set_blocking(master, False)

    def assert_prompt_owner(self, operation):
        need(self.pidfd is not None and self.status is None and
             not select.select([self.pidfd], [], [], 0)[0], 'pty-owned-live-child')
        self.recheck(operation)
        before = proc_stat(self.pid)
        ppid, group, session, tty, ticks = before
        need(ppid == self.parent and group == session == self.pid and tty > 0 and ticks > 0
             and os.tcgetpgrp(self.master)==self.pid,
             'pty-child-ancestry')
        proc = Path(f'/proc/{self.pid}')
        image = (proc / 'exe').stat()
        need(os.readlink(proc / 'exe') == str(EXEC) and
             (image.st_dev, image.st_ino) == self.executable_stat, 'pty-effective-executable')
        raw = proc_bytes(proc/'cmdline',8192)
        wanted = b'\0'.join(os.fsencode(value) for value in consent.argv(operation)) + b'\0'
        need(raw == wanted, 'pty-effective-argv')
        only_uid_owners(self.uid, [self.parent, self.pid])
        need(proc_stat(self.pid) == before and not select.select([self.pidfd], [], [], 0)[0],
             'pty-child-identity-changed')
        self.owner = self.pid, ticks
        return self.owner

    def read(self, eof, seconds):
        if not select.select([] if eof else [self.master], [], [], max(0, seconds))[0]:
            return None
        try:
            return os.read(self.master, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                return b''
            if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                return None
            raise

    def write_once(self, data):
        need(not self.written and self.owner is not None and data == b'apply no-menu\n',
             'pty-single-consent')
        self.written = True
        return os.write(self.master, data)

    def poll_exit(self):
        if self.status is None:
            got, status = os.waitpid(self.pid, os.WNOHANG)
            if got:
                need(got == self.pid, 'pty-wait-owner')
                self.status = os.waitstatus_to_exitcode(status)
        return self.status

    def close_observed(self, eof, status):
        need(eof is True and status == self.status and self.status is not None,
             'pty-retirement-uncertain')
        only_uid_owners(self.uid, [self.parent])
        os.close(self.master)
        os.close(self.pidfd)
        self.master = self.pidfd = None
