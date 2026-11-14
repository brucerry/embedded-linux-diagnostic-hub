"""Fixed read-only client/package metadata, never a provisioning/runtime claim.

The sole child is dpkg-query. No X client, APT, package action, Hub code,
display, PTY or process-control operation is selected. Raw child output stays
in new private runner-local files; public output contains finite enums only.
"""
import errno
import hashlib
import json
import os
import pathlib
import re
import select
import stat
import subprocess
import sys
import time

REPOSITORY = 'brucerry/embedded-linux-diagnostic-hub'
BRANCH = 'refs/heads/ci/v060-x11-client-plan-20261114'
CLIENT = '/usr/bin/xdpyinfo'
DPKG = '/usr/bin/dpkg-query'
ARGV = (DPKG, '--admindir=/var/lib/dpkg', '--no-pager', '-W',
        '-f=${db:Status-Abbrev}\t${Version}\t${Architecture}\n', 'x11-utils:amd64')
CHILD_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C', 'TZ': 'UTC',
             'TERM': 'dumb', 'DPKG_COLORS': 'never', 'DPKG_PAGER': '', 'PAGER': ''}
CLIENT_REASONS = ('accepted', 'absent', 'type', 'canonical', 'owner', 'mode', 'nlink',
                  'executable', 'parent', 'bound', 'unavailable')
PACKAGE_REASONS = ('expected', 'other', 'absent', 'unavailable')
CURRENT = []


def need(value, code):
    if not value:
        raise RuntimeError(code)


def safe_phase(value):
    return value if type(value) is str and value in ('binding', 'client', 'package', 'readback', 'output') else 'binding'


def identity(value):
    return tuple(getattr(value, name) for name in ('st_dev', 'st_ino', 'st_uid', 'st_mode',
                 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def client_reason(info, canonical, executable, parents_safe):
    if not stat.S_ISREG(info.st_mode):
        return 'type'
    if not canonical:
        return 'canonical'
    if info.st_uid != 0:
        return 'owner'
    if info.st_mode & 0o7022:
        return 'mode'
    if info.st_nlink != 1:
        return 'nlink'
    if not executable:
        return 'executable'
    if not parents_safe:
        return 'parent'
    if not 0 < info.st_size <= 16 * 1024 ** 2:
        return 'bound'
    return 'accepted'


def package_reason(code, stdout, stderr):
    if code == 1 and stdout == b'' and stderr == b'dpkg-query: no packages found matching x11-utils:amd64\n':
        return 'absent'
    if code != 0 or stderr:
        return 'unavailable'
    match = re.fullmatch(rb'ii \t([A-Za-z0-9.+:~\-]{1,128})\tamd64\n', stdout)
    if not match:
        return 'unavailable'
    return 'expected' if match[1] == b'7.7+6build2' else 'other'


class Probe:
    def __init__(self, started):
        self.started, self.until = started, started + 70
        self.fds, self.returned, self.secondary = [], [], []
        self.child = {'issued': False, 'returned': False, 'object': None, 'exit': None,
                      'pipes': {}, 'stdout': bytearray(), 'stderr': bytearray(), 'soft_expired': False}
        self.first_set, self.first, self.frozen = False, None, False
        self.phase = 'binding'

    def fail(self, error):
        self.frozen = True
        if not self.first_set:
            self.first_set, self.first = True, error
        else:
            self.secondary.append(error)

    def gate(self):
        need(not self.frozen and self.started <= time.monotonic() < self.until, 'METADATA_DEADLINE')

    def capture(self, value):
        self.returned.append(value)
        self.gate()
        return value

    def opened(self, file, flags, mode=0o600):
        self.gate()
        owner = {'path': file, 'issued': True, 'returned': False, 'fd': None,
                 'close_issued': False, 'closed': False}
        self.fds.append(owner)
        fd = os.open(file, flags | os.O_CLOEXEC, mode)
        owner['fd'], owner['returned'] = fd, True
        self.capture(fd)
        return owner

    def closed(self, owner):
        need(not owner['close_issued'], 'METADATA_CLOSE_ONCE')
        owner['close_issued'] = True
        value = os.close(owner['fd'])
        owner['closed'] = True
        self.capture(value)

    def parents(self, directory, uid):
        current = pathlib.Path('/')
        for part in pathlib.Path(directory).parts[1:]:
            current = current / part
            info = self.capture(os.lstat(current))
            if not (stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid) and
                    not info.st_mode & 0o7022 and os.path.realpath(current) == str(current)):
                return False
        return True

    def read(self, file, cap, uid):
        self.gate()
        need(self.parents(str(pathlib.Path(file).parent), os.getuid()), 'METADATA_INPUT_PARENT')
        before = self.capture(os.lstat(file))
        need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and
             0 < before.st_size <= cap and not before.st_mode & 0o7022 and
             os.path.realpath(file) == file, 'METADATA_INPUT')
        owner = self.opened(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        need(identity(os.fstat(owner['fd'])) == identity(before), 'METADATA_INPUT_CHANGED')
        parts, count = [], 0
        while True:
            part = self.capture(os.read(owner['fd'], min(65536, before.st_size - count + 1)))
            if not part:
                break
            parts.append(part)
            count += len(part)
            need(count <= before.st_size, 'METADATA_INPUT_BOUND')
        need(count == before.st_size and identity(os.fstat(owner['fd'])) == identity(before) and
             identity(os.lstat(file)) == identity(before), 'METADATA_INPUT_CHANGED')
        self.closed(owner)
        return b''.join(parts)

    def tool(self, file, uid):
        need(file in (CLIENT, DPKG), 'METADATA_FIXED_TOOL')
        try:
            info = self.capture(os.lstat(file))
            reason = client_reason(info, os.path.realpath(file) == file, os.access(file, os.X_OK),
                                   self.parents(str(pathlib.Path(file).parent), uid))
        except FileNotFoundError as error:
            self.returned.append(error)
            return 'absent'
        except OSError as error:
            self.returned.append(error)
            return 'unavailable'
        if reason != 'accepted':
            return reason
        raw = self.read(file, 16 * 1024 ** 2, 0)
        self.returned.append({'tool': file, 'identity': identity(info), 'sha256': hashlib.sha256(raw).hexdigest()})
        need(identity(os.lstat(file)) == identity(info), 'METADATA_TOOL_CHANGED')
        return 'accepted'

    def package(self, directory):
        self.gate()
        child = self.child
        need(not child['issued'], 'METADATA_ONE_COMMAND')
        logs = {name: self.opened(directory + '/' + name + '.bin', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
                for name in ('stdout', 'stderr')}
        started = time.monotonic()
        child['issued'] = True
        actual = subprocess.Popen(ARGV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=dict(CHILD_ENV), close_fds=True)
        child['object'], child['returned'] = actual, True
        self.returned.append(actual)
        for name in ('stdout', 'stderr'):
            child['pipes'][name] = {'object': getattr(actual, name), 'eof': False,
                                    'close_issued': False, 'closed': False}
        self.gate()  # All actual returned child/pipe objects are owned before lateness or mode effects.
        for pipe in child['pipes'].values():
            os.set_blocking(pipe['object'].fileno(), False)
            self.gate()
        while not (child['exit'] is not None and all(pipe['eof'] for pipe in child['pipes'].values())):
            self.gate()
            if time.monotonic() - started >= 20:
                child['soft_expired'] = True  # Observe only this issued child; no timeout kill/retry.
            if child['exit'] is None:
                child['exit'] = actual.poll()
                self.capture(child['exit'])
            readable = {pipe['object'].fileno(): (name, pipe) for name, pipe in child['pipes'].items() if not pipe['eof']}
            ready, _, _ = select.select(list(readable), [], [], 0.05)
            self.gate()
            for fd in ready:
                name, pipe = readable[fd]
                try:
                    part = os.read(fd, 4096)
                except OSError as error:
                    if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        continue
                    raise
                self.returned.append(part)
                if not part:
                    pipe['eof'] = True
                self.gate()
                if not part:
                    continue
                need(len(child[name]) + len(part) <= 65536, 'METADATA_OUTPUT_BOUND')
                child[name].extend(part)
                at = 0
                while at < len(part):
                    count = self.capture(os.write(logs[name]['fd'], part[at:]))
                    need(type(count) is int and 0 < count <= len(part) - at, 'METADATA_OUTPUT_WRITE')
                    at += count
        for name, pipe in child['pipes'].items():
            pipe['close_issued'] = True
            value = pipe['object'].close()
            pipe['closed'] = True
            self.capture(value)
            need(self.capture(os.pread(logs[name]['fd'], 65537, 0)) == bytes(child[name]), 'METADATA_OUTPUT_READBACK')
            self.capture(os.fsync(logs[name]['fd']))
            self.closed(logs[name])
        child['soft_expired'] |= time.monotonic() - started >= 20
        need(not child['soft_expired'], 'METADATA_CHILD_SOFT_DEADLINE')
        return package_reason(child['exit'], bytes(child['stdout']), bytes(child['stderr']))

    def managed_output(self, file, temporary, uid, values):
        need(set(values) == {'binding', 'client', 'package', 'plan', 'child'} and
             values['binding'] == 'verified' and values['client'] in CLIENT_REASONS and
             values['package'] in PACKAGE_REASONS and values['plan'] == 'not-run' and
             values['child'] in ('joined', 'not-run'), 'METADATA_ENUMS')
        raw = ''.join(key + '=' + value + '\n' for key, value in values.items()).encode('ascii')
        need(temporary.startswith('/') and file.startswith(temporary + '/') and os.path.realpath(file) == file and
             self.parents(str(pathlib.Path(file).parent), uid), 'METADATA_MANAGED_OUTPUT')
        before = self.capture(os.lstat(file))
        need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and
             before.st_size <= 1048576 and not before.st_mode & 0o7022, 'METADATA_MANAGED_OUTPUT')
        owner = self.opened(file, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
        need(identity(os.fstat(owner['fd'])) == identity(before), 'METADATA_MANAGED_CHANGED')
        at = 0
        while at < len(raw):
            count = self.capture(os.write(owner['fd'], raw[at:]))
            need(type(count) is int and 0 < count <= len(raw) - at, 'METADATA_MANAGED_WRITE')
            at += count
        self.capture(os.fsync(owner['fd']))
        after = self.capture(os.fstat(owner['fd']))
        need((after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_nlink) ==
             (before.st_dev, before.st_ino, before.st_uid, before.st_mode, before.st_nlink) and
             after.st_size == before.st_size + len(raw) and identity(os.lstat(file)) == identity(after), 'METADATA_MANAGED_CHANGED')
        self.closed(owner)

    def unknown(self):
        return (any(not owner['returned'] or not owner['closed'] for owner in self.fds) or
                (self.child['issued'] and (not self.child['returned'] or self.child['exit'] is None or
                 len(self.child['pipes']) != 2 or any(not pipe['closed'] for pipe in self.child['pipes'].values()))))


def main(args):
    probe = Probe(time.monotonic())
    CURRENT.append(probe)
    need(not args and sys.platform == 'linux', 'METADATA_ARGUMENT')
    uid = os.getuid()
    need(uid > 0 and uid == os.geteuid() and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and
         os.environ.get('GITHUB_REF') == BRANCH and os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
         os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
         os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64' and
         re.fullmatch('[1-9][0-9]{0,31}', os.environ.get('GITHUB_RUN_ID', '')), 'METADATA_CONTEXT')
    source = str(pathlib.Path(__file__).resolve().parents[1])
    need(source == os.environ.get('GITHUB_WORKSPACE') and probe.parents(source, uid), 'METADATA_SOURCE')
    head = probe.read(source + '/.git/HEAD', 256, uid)
    commit = head.decode('ascii').strip()
    need(re.fullmatch('[a-f0-9]{40}', commit) and commit == os.environ.get('GITHUB_SHA'), 'METADATA_HEAD')
    own_file = source + '/scripts/linux-x11-client-plan.py'
    own = probe.read(own_file, 1024 * 1024, uid)
    event = json.loads(probe.read(os.environ.get('GITHUB_EVENT_PATH', ''), 2 * 1024 ** 2, uid))
    need(event['repository']['full_name'] == REPOSITORY and event['repository']['private'] is False and
         event['after'] == commit and event['ref'] == BRANCH, 'METADATA_PUBLIC_SOURCE')
    probe.phase = 'client'
    client = probe.tool(CLIENT, uid)
    probe.phase = 'package'
    package, child = 'unavailable', 'not-run'
    if probe.tool(DPKG, uid) == 'accepted':
        temporary = os.environ.get('RUNNER_TEMP', '')
        need(temporary.startswith('/') and os.path.realpath(temporary) == temporary and
             probe.parents(temporary, uid), 'METADATA_SCRATCH')
        directory = temporary + '/hub-x11-client-plan-' + os.environ['GITHUB_RUN_ID'] + '-attempt-1'
        probe.capture(os.mkdir(directory, 0o700))  # Exclusive; no removal or collision fallback.
        package = probe.package(directory)
        child = 'joined'
    probe.phase = 'readback'
    need(probe.read(source + '/.git/HEAD', 256, uid) == head and probe.read(own_file, 1024 * 1024, uid) == own,
         'METADATA_SOURCE_CHANGED')
    values = {'binding': 'verified', 'client': client, 'package': package, 'plan': 'not-run', 'child': child}
    probe.phase = 'output'
    probe.managed_output(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
    probe.gate()
    need(not probe.unknown(), 'METADATA_RETAINED')
    print(json.dumps(values, sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        probe = CURRENT[0] if CURRENT else None
        if probe is not None:
            probe.fail(error)
        try:
            phase = safe_phase(probe.phase if probe is not None else None)
            print('::error title=X11 client metadata::Fixed metadata unavailable at ' + phase + '; uncertain custody retained.')
        except BaseException as reporting_error:
            if probe is not None:
                probe.secondary.append(reporting_error)
        while probe is not None and probe.unknown():
            try:
                time.sleep(0.5)
            except BaseException as waiting_error:
                probe.secondary.append(waiting_error)
        raise SystemExit(1)
