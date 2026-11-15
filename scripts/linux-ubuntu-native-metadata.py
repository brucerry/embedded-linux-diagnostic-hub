"""Inert until main: fixed current-job metadata only, never native admission."""
import os
import pathlib
import re
import signal
import stat
import sys
import time

BRANCH = 'refs/heads/ci/v060-ubuntu-native-metadata-20261115'
FIELDS = ('result', 'stage', 'reason', 'identity', 'filesystem', 'xvfb', 'xauth',
          'xdpyinfo', 'python', 'slots', 'ptmx', 'devpts', 'tty', 'display', 'auth',
          'pidfd', 'sigchld')
REASONS = ('ok', 'context', 'non_root', 'uid_mismatch', 'missing', 'access_error',
           'kind', 'owner', 'mode_special', 'mode_group_write', 'mode_other_write',
           'nlink', 'inode', 'unsafe_number', 'canonical', 'executable', 'deadline',
           'occupied', 'device', 'mount', 'api', 'signal', 'unexpected')
MAX_SAFE = 9007199254740991
VALUES = frozenset((*REASONS, *FIELDS, 'not-checked', 'refused', 'metadata-only-pass',
    'non-root-matched', 'metadata-safe', 'metadata-eligible', 'absent-at-observation',
    'character-access-metadata', 'mounted-metadata', 'attached', 'not-attached',
    'advertised', 'unset', 'api-present-untested', 'default', 'context', 'complete'))
OUTPUT = []  # Original FD/primary/secondary custody survives an uncertain output failure.


class Refusal(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else 'unexpected'


def require(value, reason):
    if not value:
        raise Refusal(reason)


def attributes(info, kind, owners, safe_numbers=False, executable=False):
    predicate = stat.S_ISREG if kind == 'file' else stat.S_ISDIR
    require(predicate(info.st_mode), 'kind')  # lstat: symlinks never pass.
    require(info.st_uid in owners, 'owner')
    for mask, reason in ((0o7000, 'mode_special'), (0o20, 'mode_group_write'),
                         (0o2, 'mode_other_write')):
        require(not info.st_mode & mask, reason)
    require(info.st_nlink == 1 if kind == 'file' else info.st_nlink >= 1, 'nlink')
    require(info.st_ino > 0, 'inode')
    if safe_numbers:
        require(0 <= info.st_dev <= MAX_SAFE and info.st_ino <= MAX_SAFE and
                info.st_nlink <= MAX_SAFE, 'unsafe_number')
    if executable:
        require(bool(info.st_mode & 0o111) and 0 < info.st_size <= 256 * 1024 ** 2,
                'executable')


def observed(io, file):
    try:
        return io.lstat(file)
    except FileNotFoundError:
        raise Refusal('missing') from None
    except OSError:
        raise Refusal('access_error') from None


def checked(io, file, uid, kind, root=False, safe=False, executable=False):
    require(type(file) is str and file.startswith('/') and
            str(pathlib.PurePosixPath(file)) == file and
            not re.search(r'[\\\x00-\x1f\x7f]', file), 'canonical')
    info = observed(io, file)
    attributes(info, kind, (0,) if root else (0, uid), safe, executable)
    require(io.realpath(file) == file, 'canonical')
    return info


def parents(io, file, uid, safe=False):
    for parent in reversed(pathlib.PurePosixPath(file).parents):
        checked(io, str(parent), uid, 'directory', safe=safe)


def probe(io):
    """All observations supplied by the caller; no launch/connection authority."""
    report = dict.fromkeys(FIELDS, 'not-checked')
    report['result'], report['reason'] = 'refused', 'unexpected'
    started = io.now()

    def stage(value):
        report['stage'] = value
        require(0 <= io.now() - started < 15, 'deadline')

    try:
        stage('context')
        env = io.env
        require(io.platform == 'linux' and io.machine == 'x86_64' and
                env.get('RUNNER_OS') == 'Linux' and
                env.get('RUNNER_ARCH') == 'X64' and
                env.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
                env.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub' and
                env.get('GITHUB_REF') == BRANCH and env.get('GITHUB_RUN_ATTEMPT') == '1' and
                env.get('GITHUB_EVENT_NAME') == 'push' and
                re.fullmatch('[a-f0-9]{40}', env.get('GITHUB_SHA', '')) and
                env.get('GITHUB_WORKFLOW_SHA') == env.get('GITHUB_SHA'), 'context')
        stage('identity')
        uid = io.uid()
        require(uid > 0, 'non_root')
        require(uid == io.euid(), 'uid_mismatch')
        report['identity'] = 'non-root-matched'
        stage('filesystem')
        for key in ('HOME', 'GITHUB_WORKSPACE'):
            file = env.get(key, '')
            parents(io, file, uid, True)
            info = checked(io, file, uid, 'directory', safe=True)
            require(info.st_uid == uid, 'owner')
        report['filesystem'] = 'metadata-safe'
        for label, file in (('xvfb', '/usr/bin/Xvfb'), ('xauth', '/usr/bin/xauth'),
                            ('xdpyinfo', '/usr/bin/xdpyinfo'), ('python', io.python)):
            stage(label)
            if label == 'python':
                require(re.fullmatch(r'/usr/bin/python3\.[0-9]{1,2}', file), 'canonical')
            parents(io, file, uid)
            checked(io, file, uid, 'file', root=True, executable=True)
            report[label] = 'metadata-eligible'
        stage('slots')
        require(re.fullmatch('[1-9][0-9]{0,31}', env.get('GITHUB_RUN_ID', '')), 'context')
        owned = env['HOME'] + '/.hub-owned-x11-' + env['GITHUB_RUN_ID'] + '-attempt-1'
        for file in ('/tmp/.X11-unix/X97', '/tmp/.X97-lock', owned):
            try:
                io.lstat(file)
            except FileNotFoundError:
                continue
            except OSError:
                raise Refusal('access_error') from None
            raise Refusal('occupied')
        report['slots'] = 'absent-at-observation'
        stage('ptmx')
        require(io.realpath('/dev/ptmx') == '/dev/pts/ptmx', 'device')
        require(stat.S_ISCHR(io.stat('/dev/ptmx').st_mode) and
                io.access('/dev/ptmx', os.R_OK | os.W_OK), 'device')
        report['ptmx'] = 'character-access-metadata'
        stage('devpts')
        require(io.devpts(), 'mount')
        report['devpts'] = 'mounted-metadata'
        report['tty'] = 'attached' if io.isatty(0) else 'not-attached'
        report['display'] = 'advertised' if (env.get('DISPLAY') or env.get('WAYLAND_DISPLAY')) else 'unset'
        report['auth'] = 'advertised' if env.get('XAUTHORITY') else 'unset'
        stage('pidfd')
        require(io.pidfd_api, 'api')
        report['pidfd'] = 'api-present-untested'
        stage('sigchld')
        require(io.sigchld_default, 'signal')
        report['sigchld'] = 'default'
        stage('complete')
        report['result'], report['reason'] = 'metadata-only-pass', 'ok'
    except Refusal as error:
        report['reason'] = error.reason
    except BaseException:
        report['reason'] = 'unexpected'
    return report


def encoded(report):
    require(type(report) is dict and set(report) == set(FIELDS), 'unexpected')
    require(all(type(v) is str and v in VALUES
                for v in report.values()) and report['reason'] in REASONS, 'unexpected')
    raw = ''.join(key + '=' + report[key] + '\n' for key in FIELDS).encode('ascii')
    require(len(raw) <= 1536, 'unexpected')
    return raw


class Host:
    platform = sys.platform
    machine = os.uname().machine
    python = os.path.realpath(sys.executable)
    env = os.environ
    now = staticmethod(time.monotonic)
    uid = staticmethod(os.getuid)
    euid = staticmethod(os.geteuid)
    lstat = staticmethod(os.lstat)
    stat = staticmethod(os.stat)
    realpath = staticmethod(os.path.realpath)
    access = staticmethod(os.access)
    isatty = staticmethod(os.isatty)
    pidfd_api = hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
    sigchld_default = signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL

    @staticmethod
    def devpts():
        # Read mount metadata only. Never open ptmx or allocate a PTY.
        with open('/proc/self/mountinfo', 'rb') as file:
            raw = file.read(65537)
        require(len(raw) <= 65536, 'mount')
        return any(len(line.split(b' - ', 1)) == 2 and
                   len(line.split(b' - ', 1)[0].split()) >= 5 and
                   line.split(b' - ', 1)[0].split()[4] == b'/dev/pts' and
                   line.split(b' - ', 1)[1].startswith(b'devpts ')
                   for line in raw.splitlines())


def publish(raw):
    """Only append fixed bounded classifications to the CI-managed output file."""
    file = os.environ.get('GITHUB_OUTPUT', '')
    require(file.startswith('/') and os.path.realpath(file) == file, 'canonical')
    owner = {'open_issued': True, 'fd': None, 'close_issued': False, 'closed': False,
             'primary': None, 'secondary': None}
    OUTPUT.append(owner)
    fd = os.open(file, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
    owner['fd'] = fd
    primary = None
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                info.st_nlink == 1, 'owner')
        require(os.write(fd, raw) == len(raw), 'unexpected')
    except BaseException as error:
        primary = error
        owner['primary'] = error
    try:
        owner['close_issued'] = True
        os.close(fd)
        owner['closed'] = True
    except BaseException as error:
        if primary is None:
            owner['primary'] = error
            raise
        owner['secondary'] = error
    if primary is not None:
        raise primary


if __name__ == '__main__':
    try:
        result = probe(Host())
        publish(encoded(result))
        sys.exit(0 if result['result'] == 'metadata-only-pass' else 1)
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        sys.exit(1)  # No raw exception, endpoint, path, ID, environment or stream output.
