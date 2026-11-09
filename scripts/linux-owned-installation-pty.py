"""One fixed prepared Linux installer invocation on an owned controlling PTY.

Not a generic command runner. Unknown child/PTY/FD custody is retained without
signals, retry, restoration or cleanup. Importing this file performs no IO.
"""
import errno
import hashlib
import json
import os
import pathlib
import pty
import re
import select
import stat
import sys
import time

A = '0.6.0-qualification.0'
B = '0.6.0'
STATE = {'fds': set(), 'submitted': False, 'pid': None, 'waited': False,
         'eof': False, 'first_set': False, 'first': None, 'child': False}


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def identity(value):
    return tuple(getattr(value, name) for name in
                 ('st_dev', 'st_ino', 'st_uid', 'st_mode', 'st_nlink',
                  'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def parents(directory, uid):
    current = pathlib.Path('/')
    for component in ['', *pathlib.Path(directory).parts[1:]]:
        current = current / component
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and info.st_ino > 0 and info.st_ino <= 9007199254740991
                and info.st_uid in (0, uid) and not info.st_mode & 0o7022
                and str(current.resolve()) == str(current), 'PTY_PARENT')


def read_owned(file, cap, uid):
    parents(str(pathlib.Path(file).parent), uid)
    before = os.lstat(file)
    require(stat.S_ISREG(before.st_mode) and before.st_uid == uid
            and before.st_nlink == 1 and 0 < before.st_size <= cap
            and not before.st_mode & 0o7022 and os.path.realpath(file) == file,
            'PTY_INPUT')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    STATE['fds'].add(fd)
    require(identity(before) == identity(os.fstat(fd)), 'PTY_INPUT_CHANGED')
    parts = []
    size = 0
    while True:
        part = os.read(fd, min(65536, cap - size + 1))
        if not part:
            break
        size += len(part)
        require(size <= cap, 'PTY_INPUT_CAP')
        parts.append(part)
    require(size == before.st_size and identity(before) == identity(os.fstat(fd))
            and identity(before) == identity(os.lstat(file)), 'PTY_INPUT_CHANGED')
    os.close(fd)
    STATE['fds'].remove(fd)
    return b''.join(parts)


def expected_review(request, text):
    """A literal expected current operation, not a caller-supplied consent bit."""
    operation = request['operation']
    installed = {'install': 'none', 'update': A, 'rollback': B}[operation]
    prefix = ('\nDiagnostic Hub Linux setup\nOperation: ' + operation
              + '\nApplication: ' + request['target']
              + '\nCandidate version: ' + request['version']
              + '\nInstalled version: ' + installed
              + '\nSettings/reports: ' + request['appData']
              + '/DiagnosticHub/profiles/')
    tail = ('\nPrevious payloads are retained. No Finalize or removal is performed.'
            + '\nType "apply menu" or "apply no-menu" to apply this operation;'
            + ' Enter/cancel leaves everything unchanged: ')
    text = text.replace('\r\n', '\n')
    return (text.startswith(prefix)
            and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',
                             text[len(prefix):len(prefix) + 36]) is not None
            and text[len(prefix) + 36:] == tail)


def main(args):
    require(len(args) == 4 and args[0] == '--request' and args[2] == '--sha256'
            and re.fullmatch('[a-f0-9]{64}', args[3]), 'PTY_ARGUMENT')
    uid = os.getuid()
    home = os.environ.get('HOME', '')
    require(sys.platform == 'linux' and uid > 0 and uid == os.geteuid()
            and os.path.isabs(home) and os.path.realpath(home) == home, 'PTY_HOST')
    raw = read_owned(args[1], 65536, uid)
    require(hashlib.sha256(raw).hexdigest() == args[3], 'PTY_REQUEST_HASH')
    request = json.loads(raw)
    require(sorted(request) == sorted(['schema', 'operation', 'version',
            'fixtureRoot', 'envelope', 'target', 'appData', 'dataHome',
            'sourceCommit', 'uid']), 'PTY_REQUEST_KEYS')
    operation = request['operation']
    require(request['schema'] == 1 and request['uid'] == uid
            and operation in ('install', 'update', 'rollback')
            and request['version'] == (A if operation == 'install' else B)
            and re.fullmatch('[a-f0-9]{40}', request['sourceCommit']), 'PTY_SCOPE')
    root = request['fixtureRoot']
    require(isinstance(root, str) and root.startswith(home + '/')
            and os.path.normpath(root) == root and len(root) <= 220, 'PTY_ROOT')
    require(request['target'] == root + '/installed'
            and request['appData'] == root + '/config'
            and request['dataHome'] == root + '/data'
            and request['envelope'] == root + ('/envelope-a' if operation == 'install' else '/envelope-b')
            and args[1] == root + '/operations/' + operation + '/request.json'
            and os.getcwd() == root + '/operations/' + operation, 'PTY_FIXED_PATHS')
    for file in [root, request['envelope'] + '/app/resources', request['appData'], request['dataHome']]:
        parents(file, uid)
    executable = request['envelope'] + '/app/diagnostic-hub'
    entry = request['envelope'] + '/app/resources/linux-setup-install.cjs'
    # Read and retain the exact nominal bytes before execution. This is not loaded-code attestation.
    executable_bytes = read_owned(executable, 536870912, uid)
    require(executable_bytes[:4] == b'\x7fELF' and executable_bytes[4:6] == b'\x02\x01'
            and int.from_bytes(executable_bytes[18:20], 'little') == 62
            and os.lstat(executable).st_mode & 0o100, 'PTY_EXECUTABLE')
    entry_bytes = read_owned(entry, 1048576, uid)
    transcript = os.open('pty-original.bin', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    STATE['fds'].add(transcript)
    env = dict(os.environ)
    for key in ('NODE_OPTIONS', 'NODE_PATH', 'APPIMAGE', 'APPDIR', 'PORTABLE_EXECUTABLE_FILE',
                'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME',
                'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY'):
        env.pop(key, None)
    env.update(ELECTRON_RUN_AS_NODE='1', XDG_CONFIG_HOME=request['appData'],
               XDG_DATA_HOME=request['dataHome'],
               LD_LIBRARY_PATH=request['envelope'] + '/app/usr/lib')
    argv = [executable, entry, '--install-directory', request['target'],
            '--version', request['version'], '--operation', operation,
            '--terminal', '--no-menu', '--no-launch']
    # Responsible owner exists before the allocation/submission. Adopt returned master and PID first.
    STATE['submitted'] = True
    pid, master = pty.fork()
    if pid == 0:
        STATE['child'] = True
        try:
            os.execve(executable, argv, env)
        except BaseException:
            try:
                os.write(2, b'Fixed prepared installer exec failed.\n')
            except BaseException:
                pass
            # Normal interpreter error exit, never a signal/termination of an owned target.
            raise SystemExit(78)
    STATE['pid'] = pid
    STATE['fds'].add(master)
    os.set_blocking(master, False)
    until = time.monotonic() + 135
    output = bytearray()
    consent = False
    status = None
    while not (STATE['waited'] and STATE['eof']):
        require(time.monotonic() < until, 'PTY_DEADLINE_RETAINED')
        if not STATE['waited']:
            got, value = os.waitpid(pid, os.WNOHANG)
            if got == pid:
                STATE['waited'] = True
                status = value
        ready, _, _ = select.select([master] if not STATE['eof'] else [], [], [], 0.05)
        if ready:
            try:
                part = os.read(master, 16384)
            except OSError as error:
                if error.errno == errno.EIO:
                    part = b''  # PTY slave closure only; waitpid is still separately required.
                elif error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    continue
                else:
                    raise
            if not part:
                STATE['eof'] = True
            else:
                require(len(output) + len(part) <= 131072, 'PTY_OUTPUT_CAP')
                output.extend(part)
                at = 0
                while at < len(part):
                    count = os.write(transcript, part[at:])
                    require(count > 0, 'PTY_TRANSCRIPT_WRITE')
                    at += count
                if not consent and expected_review(request, output.decode('utf8')):
                    require(os.write(master, b'apply no-menu\n') == 14, 'PTY_CONSENT_WRITE')
                    consent = True
    # Close only after actual direct child retirement and slave EOF, never to stop a live helper.
    os.close(master)
    STATE['fds'].remove(master)
    os.fsync(transcript)
    os.close(transcript)
    STATE['fds'].remove(transcript)
    require(STATE['waited'] and STATE['eof'] and status is not None
            and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 and consent,
            'PTY_HELPER_NONPASS')
    result = {'operation': operation, 'helperExit': 0, 'waitpidObserved': True,
              'ptyEOF': True, 'consentSent': consent, 'noSignals': True,
              'stdoutAndStderrCombinedByPTY': True, 'transcriptBytes': len(output),
              'transcriptSHA256': hashlib.sha256(output).hexdigest(),
              'executableDiskSHA256': hashlib.sha256(executable_bytes).hexdigest(),
              'entryDiskSHA256': hashlib.sha256(entry_bytes).hexdigest(),
              'pythonVersion': '.'.join(str(x) for x in sys.version_info[:3]),
              'pythonExecutable': sys.executable,
              'physicalLoadedBytesVerified': False, 'releaseAcceptance': False}
    raw_result = (json.dumps(result, sort_keys=True) + '\n').encode()
    fd = os.open('pty-result.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    STATE['fds'].add(fd)
    at = 0
    while at < len(raw_result):
        n = os.write(fd, raw_result[at:])
        require(n > 0, 'PTY_RESULT_WRITE')
        at += n
    os.fsync(fd)
    os.close(fd)
    STATE['fds'].remove(fd)
    sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        if STATE['child']:
            raise
        if not STATE['first_set']:
            STATE['first_set'] = True
            STATE['first'] = error
        unknown = bool(STATE['fds']) or (STATE['submitted'] and not STATE['waited'])
        try:
            sys.stderr.write('Fixed Linux PTY fixture nonpassing; preserve originals and owners.\n')
            sys.stderr.flush()
        except BaseException:
            pass
        if unknown:
            while True:
                try:
                    time.sleep(60)
                except BaseException:
                    pass
        raise SystemExit(1)
