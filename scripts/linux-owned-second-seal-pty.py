"""Fixed outer controlling-TTY actor for the owned second-seal coordinator.

Import is inert. Invocation is a real lifecycle action, never a build/test check.
Only exact source-bound B/C Finalize and current-uninstall reviews receive one
no-menu reply. Uncertain children/PTYs/FDs remain owned without signals or retry.
"""
import codecs
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
import termios
import time

A = '0.6.0-qualification.0'
B = '0.6.0'
C = '0.6.1-qualification.0'
STAGES = ('b-finalize', 'c-finalize', 'c-uninstall')
TAIL = '\nType "apply menu" or "apply no-menu" to apply this operation; Enter/cancel leaves everything unchanged: '
NOTICE = '::notice title=Linux second seal fixture::outcome=complete releaseAcceptance=false\n'
NODE_SHA256 = '67ca5783febb8bf85736c79fcdd92c8d6d465a0eb2a082672bcdfa76a506751c'
RECORD_NAMES = ('census.json', 'package.json', 'capability.json', 'descriptor.json', 'preparation.json', 'inputs.json')
SOURCE_NAMES = ('scripts/linux-owned-second-seal-fixture.ts', 'scripts/linux-owned-installation-fixture.ts',
                'scripts/lib/linux-owned-current-c.ts', 'scripts/lib/linux-owned-fixture-records.ts',
                'scripts/linux-owned-installation-pty.py', 'electron/linux-permanent-setup.ts',
                'electron/linux-setup-prompts.ts', 'electron/linux-native-driver.ts',
                'electron/linux-initial-uninstall.ts', 'scripts/linux-owned-second-seal-pty.py')
STATE = {'fds': set(), 'opens': [], 'writes': [], 'consents': [], 'submitted': False,
         'pid': None, 'waited': False, 'status': None, 'eof': False, 'stderr_eof': False, 'child': False,
         'first_set': False, 'first': None, 'secondary': [], 'frozen': False,
         'reported': False, 'returned': [], 'raw': bytearray(), 'stderr': b''}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def fail(error):
    STATE['frozen'] = True
    if not STATE['first_set']:
        STATE['first_set'] = True
        STATE['first'] = error
    else:
        STATE['secondary'].append(error)


def expected_review(stage, fixture_root, installation_id):
    """Literal real describe()+normal-finalize+linuxTerminalPrompt contract."""
    require(stage in STAGES and isinstance(installation_id, str) and
            re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', installation_id),
            'OUTER_REVIEW_IDENTITY')
    root = fixture_root + '/installed'
    profile = fixture_root + '/config/DiagnosticHub/profiles/' + installation_id
    if stage in ('b-finalize', 'c-finalize'):
        version = B if stage == 'b-finalize' else C
        detail = ('Diagnostic Hub Linux setup\nOperation: finalize\nApplication: ' + root
                  + '\nCandidate version: ' + version + '\nInstalled version: ' + version
                  + '\nSettings/reports: ' + profile
                  + '\nConfirm the current no-menu app while it is ready, then remove only the previous application payload. Settings, reports and original recovery records are retained.'
                  + '\nOwned fixture: complete the described Finalize, then request ordinary app quit through its inherited control channel. No signal or cleanup is performed.')
    else:
        detail = ('Diagnostic Hub Linux setup\nOperation: uninstall-current\nApplication: ' + root
                  + '\nInstalled version: ' + C + '\nSettings/reports retained: ' + profile
                  + '\nOnly this current no-menu payload is removed. Its predecessor cleanup is complete and published. The external cleanup ledger and original transaction records are retained. Prior recovery payloads are not removed.')
    return '\n' + detail + TAIL


class OuterReviewProtocol:
    """Bounded bytes/state only; no IO, child, clock, record or consent authority."""
    def __init__(self, fixture_root, started, deadline):
        require(isinstance(fixture_root, str) and fixture_root.startswith('/') and
                not re.search(r'[\\\x00-\x1f\x7f]', fixture_root) and
                isinstance(started, (int, float)) and isinstance(deadline, (int, float)) and
                started >= 0 and deadline > started and deadline - started <= 540,
                'OUTER_PROTOCOL_INPUT')
        self.root, self.started, self.deadline = fixture_root, started, deadline
        self.stage = 0
        self.decoder = codecs.getincrementaldecoder('utf-8')('strict')
        self.pending_cr = False
        self.text = ''
        self.total = 0
        self.issued = False
        self.returned = False
        self.echo = False
        self.complete = False
        self.frozen = False
        self.counts = []

    def gate(self, now):
        if self.frozen or not isinstance(now, (int, float)) or not self.started <= now < self.deadline:
            self.frozen = True
            raise RuntimeError('OUTER_DEADLINE_OR_FROZEN')

    def append(self, part, now):
        self.gate(now)
        require(isinstance(part, bytes), 'OUTER_BYTES')
        self.total += len(part)
        require(self.total <= 131072, 'OUTER_TRANSCRIPT_BOUND')
        decoded = self.decoder.decode(part, final=False)
        for char in decoded:
            if self.pending_cr:
                require(char == '\n', 'OUTER_BARE_CR')
                self.text += '\n'
                self.pending_cr = False
            elif char == '\r':
                self.pending_cr = True
            else:
                self.text += char
        if self.echo:
            wanted = 'apply no-menu\n'
            require(wanted.startswith(self.text) or self.text.startswith(wanted), 'OUTER_ECHO_CHANGED')
            if self.text.startswith(wanted):
                self.text = self.text[len(wanted):]
                self.stage += 1
                self.issued = self.returned = self.echo = False
        if self.stage == len(STAGES):
            require(NOTICE.startswith(self.text) or self.text == NOTICE, 'OUTER_COMPLETION_TEXT')
            self.complete = self.text == NOTICE and not self.pending_cr and not self.decoder.getstate()[0]
            return
        if not self.echo and not self.issued:
            operation = 'uninstall-current' if self.stage == 2 else 'finalize'
            prefix = '\nDiagnostic Hub Linux setup\nOperation: ' + operation + '\n'
            require(prefix.startswith(self.text) or self.text.startswith(prefix), 'OUTER_REVIEW_ORDER')
            at = self.text.find(TAIL)
            if at >= 0:
                require(at + len(TAIL) == len(self.text), 'OUTER_REVIEW_TRAILING')
        require(len(self.text.encode('utf-8')) <= 16384, 'OUTER_REVIEW_BOUND')

    def ready(self):
        return (not self.frozen and not self.issued and not self.echo and self.stage < len(STAGES)
                and self.text.endswith(TAIL) and not self.pending_cr and not self.decoder.getstate()[0])

    def issue(self, installation_id, now):
        self.gate(now)
        require(self.ready() and self.text == expected_review(STAGES[self.stage], self.root, installation_id),
                'OUTER_REVIEW_CHANGED')
        self.issued = True  # Before the only actual write can succeed, fail or partially return.
        self.text = ''
        return b'apply no-menu\n'

    def acknowledge(self, count, now):
        require(self.issued and not self.returned, 'OUTER_WRITE_ORDER')
        self.returned = True
        self.counts.append(count)  # Adopt the actual return before late gating.
        self.gate(now)
        require(type(count) is int and count == 14, 'OUTER_CONSENT_WRITE')
        self.echo = True

    def finish(self, now):
        self.gate(now)
        require(self.decoder.decode(b'', final=True) == '' and not self.pending_cr and
                self.complete and self.stage == 3 and self.counts == [14, 14, 14], 'OUTER_INCOMPLETE')


def consent_step(protocol, part, now, original, write):
    """Actual review-to-one-write seam, exercised only with closed ports in memory tests."""
    try:
        protocol.append(part, now())
        if protocol.ready():
            installation_id = original(STAGES[protocol.stage])
            reply = protocol.issue(installation_id, now())
            count = write(reply)
            protocol.acknowledge(count, now())
    except BaseException:
        protocol.frozen = True
        raise


def identity(value):
    return tuple(getattr(value, name) for name in ('st_dev', 'st_ino', 'st_uid', 'st_mode',
                 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def parents(directory, uid):
    current = pathlib.Path('/')
    for component in ['', *pathlib.Path(directory).parts[1:]]:
        current = current / component
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_ino > 0 and
                info.st_uid in (0, uid) and not info.st_mode & 0o7022 and str(current.resolve()) == str(current), 'OUTER_PARENT')


def opened(file, flags, mode=0o600):
    owner = {'file': file, 'issued': True, 'returned': False, 'fd': None, 'close_issued': False, 'closed': False}
    STATE['opens'].append(owner)
    fd = os.open(file, flags | os.O_CLOEXEC, mode)
    owner['fd'], owner['returned'] = fd, True
    STATE['fds'].add(fd)
    return owner


def closed(owner):
    require(not owner['close_issued'], 'OUTER_CLOSE_ONCE')
    owner['close_issued'] = True
    os.close(owner['fd'])
    owner['closed'] = True
    STATE['fds'].remove(owner['fd'])


def opened_stderr_pipe():
    owners = [{'file': 'owned-stderr-pipe', 'issued': True, 'returned': False, 'fd': None,
               'close_issued': False, 'closed': False} for _ in range(2)]
    STATE['opens'].extend(owners)  # Before pipe allocation, including a throwing/unknown return.
    read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
    for owner, fd in zip(owners, (read_fd, write_fd)):
        owner['fd'], owner['returned'] = fd, True
        STATE['fds'].add(fd)
    os.set_blocking(read_fd, False)  # Both returns are owned first; leave the child's write end blocking.
    return owners


def observed(file, cap, uid, retain=True):
    parents(str(pathlib.Path(file).parent), uid)
    before = os.lstat(file)
    require(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and
            0 < before.st_size <= cap and not before.st_mode & 0o7022 and os.path.realpath(file) == file, 'OUTER_INPUT')
    owner = opened(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    require(identity(before) == identity(os.fstat(owner['fd'])), 'OUTER_INPUT_CHANGED')
    checksum, count, parts = hashlib.sha256(), 0, []
    while True:
        part = os.read(owner['fd'], min(65536, before.st_size - count + 1))
        if not part:
            break
        count += len(part)
        require(count <= before.st_size, 'OUTER_INPUT_BOUND')
        checksum.update(part)
        if retain:
            parts.append(part)
    require(count == before.st_size and identity(before) == identity(os.fstat(owner['fd'])) and
            identity(before) == identity(os.lstat(file)), 'OUTER_INPUT_CHANGED')
    closed(owner)
    return {'bytes': count, 'sha256': checksum.hexdigest(), 'identity': identity(before), 'raw': b''.join(parts) if retain else None}


def send_consent(master, raw):
    owner = {'issued': True, 'returned': False, 'value': None, 'error': None}
    STATE['consents'].append(owner)
    try:
        count = os.write(master, raw)
        owner['value'], owner['returned'] = count, True
        return count
    except BaseException as error:
        owner['error'] = error
        raise


def validate_request(value, home, source_commit):
    require(type(value) is dict and set(value) == {'schema', 'sourceCommit', 'buildRoot',
            'loaderSHA256', 'sourceSHA256', 'recordsSHA256'}, 'OUTER_REQUEST_KEYS')
    require(type(value['schema']) is int and value['schema'] == 1 and
            re.fullmatch('[a-f0-9]{40}', source_commit) and value['sourceCommit'] == source_commit, 'OUTER_SOURCE_CONTEXT')
    root = value['buildRoot']
    require(isinstance(root, str) and root.startswith(home + '/') and str(pathlib.PurePosixPath(root)) == root and
            len(root) <= 170 and not re.search(r'[\\\x00-\x1f\x7f]', root), 'OUTER_BUILD_ROOT')
    hashes = value['sourceSHA256']
    require(type(hashes) is dict and set(hashes) == set(SOURCE_NAMES) and
            all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in hashes.values()) and
            isinstance(value['loaderSHA256'], str) and re.fullmatch('[a-f0-9]{64}', value['loaderSHA256']), 'OUTER_SOURCE_HASHES')
    records = value['recordsSHA256']
    require(type(records) is dict and set(records) == {'a', 'b', 'c'}, 'OUTER_RECORD_HASHES')
    for role in ('a', 'b', 'c'):
        require(type(records[role]) is dict and set(records[role]) == set(RECORD_NAMES) and
                all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in records[role].values()), 'OUTER_RECORD_HASHES')
    return root


def fixed_argv(node, source, build):
    fixture = build + '/second-seal-fixture'
    return [node, '--import', source + '/node_modules/tsx/dist/loader.mjs',
            source + '/scripts/linux-owned-second-seal-fixture.ts',
            '--a-appdir', build + '/build-a/linux-unpacked', '--a-archive', build + '/build-a/Diagnostic-Hub-linux-x64.tar.gz',
            '--b-appdir', build + '/build-b/linux-unpacked', '--b-archive', build + '/build-b/Diagnostic-Hub-linux-x64.tar.gz',
            '--fixture-root', fixture, '--c-appdir', build + '/build-c/linux-unpacked',
            '--c-archive', build + '/build-c/Diagnostic-Hub-linux-x64.tar.gz']


def read_inputs(request, source, uid):
    """Pin originals, never manufacture an approval/capability or use record flags as admission."""
    originals = {}
    for relative in SOURCE_NAMES:
        value = observed(source + '/' + relative, 1024 * 1024, uid)
        require(value['sha256'] == request['sourceSHA256'][relative], 'OUTER_SOURCE_CHANGED')
        originals[source + '/' + relative] = value
    loader = source + '/node_modules/tsx/dist/loader.mjs'
    value = observed(loader, 1024 * 1024, uid)
    require(value['sha256'] == request['loaderSHA256'], 'OUTER_LOADER_CHANGED')
    originals[loader] = value
    build = request['buildRoot']
    for role, version in (('a', A), ('b', B), ('c', C)):
        records = {}
        for name in RECORD_NAMES:
            cap = 16 * 1024 ** 2 if name == 'inputs.json' else 4 * 1024 ** 2
            file = build + '/records-' + role + '/' + name
            value = observed(file, cap, uid)
            require(value['sha256'] == request['recordsSHA256'][role][name], 'OUTER_BUILD_RECORD_CHANGED')
            originals[file] = value
            records[name] = json.loads(value['raw'])
        package, inputs, descriptor, preparation = (records[n] for n in ('package.json', 'inputs.json', 'descriptor.json', 'preparation.json'))
        archive = build + '/build-' + role + '/Diagnostic-Hub-linux-x64.tar.gz'
        appdir = build + '/build-' + role + '/linux-unpacked'
        descriptor_sha = originals[build + '/records-' + role + '/descriptor.json']['sha256']
        require(package['name'] == 'embedded-linux-diagnostic-hub' and package['version'] == version and
                inputs['sourceCommit'] == request['sourceCommit'] and inputs['role'] == role and inputs['version'] == version and
                inputs['sourceRoot'] == appdir and inputs['archive']['path'] == archive and
                inputs['envelopeRoot'] == build + '/envelope-' + role and
                descriptor['version'] == version and descriptor['sourceCommit'] == request['sourceCommit'] and
                records['capability.json']['version'] == version and
                inputs['descriptorSHA256'] == descriptor_sha and preparation['descriptorSHA256'] == descriptor_sha and
                preparation['status'] == 'prepared-install-envelope' and preparation['root'] == build + '/envelope-' + role,
                'OUTER_BUILD_BINDING')
        actual = observed(archive, 2 * 1024 ** 3, uid, False)
        require(actual['bytes'] == inputs['archive']['bytes'] and actual['sha256'] == inputs['archive']['sha256'], 'OUTER_ARCHIVE_CHANGED')
        require(records['census.json']['compressedBytes'] == actual['bytes'] and
                records['census.json']['compressedSHA256'] == actual['sha256'], 'OUTER_CENSUS_CHANGED')
        before = os.lstat(archive)
        for name, attr in (('dev', 'st_dev'), ('ino', 'st_ino'), ('uid', 'st_uid'), ('mode', 'st_mode'), ('nlink', 'st_nlink'), ('size', 'st_size')):
            require(inputs['archive']['identity'][name] == getattr(before, attr), 'OUTER_ARCHIVE_IDENTITY')
        originals[archive] = actual
        parents(appdir, uid)
    return originals


def review_binding(stage, fixture, source_commit, uid, pinned):
    role, version = ('b', B) if stage == 'b-finalize' else ('c', C)
    values = {}
    for name, cap in (('installation', 16384), ('manifest', 4 * 1024 ** 2), ('journal', 8192)):
        file = fixture + '/records/updated-' + role + '-' + name + '.json'
        value = observed(file, cap, uid)
        if file in pinned:
            require(value == pinned[file], 'OUTER_ORIGINAL_CHANGED')
        else:
            pinned[file] = value
        values[name] = json.loads(value['raw'])
    record, manifest, journal = (values[n] for n in ('installation', 'manifest', 'journal'))
    key = record['installationId']
    require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', key) and
            record['profile'] == 'dedicated' and record['manifestSHA256'] == pinned[fixture + '/records/updated-' + role + '-manifest.json']['sha256'] and
            manifest['version'] == version and manifest['sourceCommit'] == source_commit and
            journal['root'] == fixture + '/installed' and journal['uid'] == uid and journal['installationId'] == key and
            journal['profile'] == fixture + '/config/DiagnosticHub/profiles/' + key and journal['phase'] == 'candidate-active',
            'OUTER_REVIEW_ORIGINALS')
    return key


def report_nonpassing():
    if not STATE['reported']:
        STATE['reported'] = True
        try:
            os.write(2, b'Fixed outer second-seal actor is nonpassing; uncertain custody is retained.\n')
        except BaseException as error:
            STATE['secondary'].append(error)


def final_readback(protocol, now, original, read, fixture, uid, commit, run_id):
    """Fixed final IO seam: retain the real return before any late/validation refusal."""
    original('c-uninstall')
    protocol.finish(now())  # A late revalidation must not issue the next read.
    final = read(fixture + '/records/second-seal-uninstall.json', 16 * 1024 ** 2, uid)
    STATE['returned'].append(final)
    protocol.finish(now())
    record = json.loads(final['raw'])
    require(record['scenario'] == 'owned-b-to-c-normal-finalize-and-current-removal' and
            record['sourceCommit'] == commit and record['runId'] == run_id and
            record['runAttempt'] == '1' and record['releaseAcceptance'] is False, 'OUTER_FINAL_RECORD')
    protocol.finish(now())
    return final


def main(args):
    started = time.monotonic()
    until = started + 540
    require(len(args) == 4 and args[0] == '--request' and args[2] == '--sha256' and
            re.fullmatch('[a-f0-9]{64}', args[3]), 'OUTER_ARGUMENT')
    uid, home = os.getuid(), os.environ.get('HOME', '')
    source = str(pathlib.Path(__file__).resolve().parents[1])
    require(sys.platform == 'linux' and uid > 0 and uid == os.geteuid() and home.startswith('/') and
            os.path.realpath(home) == home and (os.environ.get('DISPLAY') or
            (os.environ.get('WAYLAND_DISPLAY') and os.environ.get('XDG_RUNTIME_DIR'))), 'OUTER_HOST_AND_GUI')
    for name in ('NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'ELECTRON_RUN_AS_NODE'):
        require(name not in os.environ, 'OUTER_RUNTIME_OVERRIDE')
    require(os.environ.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub' and
            os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and re.fullmatch('[1-9][0-9]{0,31}', os.environ.get('GITHUB_RUN_ID', '')),
            'OUTER_ACTUAL_RUN_CONTEXT')
    commit = observed(source + '/.git/HEAD', 256, uid)['raw'].decode('ascii').strip()
    require(re.fullmatch('[a-f0-9]{40}', commit) and commit == os.environ.get('GITHUB_SHA'), 'OUTER_DETACHED_SOURCE')
    request_raw = observed(args[1], 65536, uid)['raw']
    require(hashlib.sha256(request_raw).hexdigest() == args[3], 'OUTER_REQUEST_HASH')
    request = json.loads(request_raw)
    build = validate_request(request, home, commit)
    require(args[1] == build + '/outer-second-seal-request.json' and source != build and
            not source.startswith(build + '/') and not build.startswith(source + '/'), 'OUTER_FIXED_REQUEST')
    parents(build, uid)
    fixture = build + '/second-seal-fixture'
    for fresh in (fixture, build + '/outer-second-seal'):
        try:
            os.lstat(fresh)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError('OUTER_OUTPUT_EXISTS')
    sdk, node = os.environ.get('HUB_PRIVATE_SDK_ROOT', ''), os.environ.get('HUB_PRIVATE_NODE', '')
    require(sdk.startswith(home + '/') and node == sdk + '/bin/node' and os.path.realpath(node) == node, 'OUTER_SELECTED_NODE')
    node_original = observed(node, 256 * 1024 ** 2, uid, False)
    require(node_original['sha256'] == NODE_SHA256, 'OUTER_NODE_HASH')
    originals = read_inputs(request, source, uid)
    STATE['returned'].append(originals)
    record_pins = {}
    output = build + '/outer-second-seal'
    os.mkdir(output, 0o700)
    transcript = opened(output + '/tty-original.bin', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
    stderr = opened(output + '/stderr-original.bin', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
    stderr_read, stderr_write = opened_stderr_pipe()
    protocol = OuterReviewProtocol(fixture, started, until)
    STATE['returned'].append(protocol)
    argv = fixed_argv(node, source, build)
    require(time.monotonic() < until, 'OUTER_DEADLINE')
    STATE['submitted'] = True  # Before fork; no throwing submission is treated as authoritative noncreation.
    pid, master = pty.fork()
    if pid == 0:
        STATE['child'] = True
        try:
            os.dup2(stderr_write['fd'], 2)
            os.chdir(source)
            os.execve(node, argv, dict(os.environ))
        except BaseException:
            try:
                os.write(2, b'Fixed second-seal coordinator exec failed.\n')
            except BaseException:
                pass
            raise SystemExit(78)
    STATE['pid'] = pid
    STATE['fds'].add(master)
    closed(stderr_write)  # Only this parent's copy; the child's distinct fd2 remains owned by it.
    os.set_blocking(master, False)
    attrs = termios.tcgetattr(master)
    require(attrs[3] & termios.ICANON and attrs[3] & termios.ECHO and
            attrs[1] & termios.OPOST and attrs[1] & termios.ONLCR, 'OUTER_CANONICAL_ECHO')
    def original(stage):
        for file, before in originals.items():
            current = observed(file, before['bytes'], uid, before['raw'] is not None)
            require(current == before, 'OUTER_INPUT_CHANGED')
        require(observed(node, 256 * 1024 ** 2, uid, False) == node_original, 'OUTER_NODE_CHANGED')
        key = review_binding(stage, fixture, commit, uid, record_pins)
        if 'installation_id' in STATE:
            require(STATE['installation_id'] == key, 'OUTER_INSTALLATION_CHANGED')
        else:
            STATE['installation_id'] = key
        return key
    while not (STATE['waited'] and STATE['eof'] and STATE['stderr_eof']):
        if time.monotonic() >= until and not STATE['frozen']:
            fail(RuntimeError('OUTER_DEADLINE'))
            protocol.frozen = True
            report_nonpassing()
        if not STATE['waited']:
            got, status = os.waitpid(pid, os.WNOHANG)
            if got == pid:
                STATE['waited'], STATE['status'] = True, status
        streams = ([] if STATE['eof'] else [master]) + ([] if STATE['stderr_eof'] else [stderr_read['fd']])
        ready, _, _ = select.select(streams, [], [], 0.05)
        for fd in ready:
            try:
                part = os.read(fd, 16384)
            except OSError as error:
                if fd == master and error.errno == errno.EIO:
                    part = b''
                elif error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    continue
                else:
                    raise
            if not part:
                STATE['eof' if fd == master else 'stderr_eof'] = True
                continue
            original_stream = STATE['raw'] if fd == master else STATE['stderr']
            require(len(original_stream) + len(part) <= 131072, 'OUTER_STREAM_BOUND')
            if fd == master:
                STATE['raw'].extend(part)
            else:
                STATE['stderr'] += part
            # Only bounded parent writes reach runner-local files. Overflow leaves the
            # unread pipe/child retained; it never closes a channel to stop a target.
            at = 0
            target_fd = transcript['fd'] if fd == master else stderr['fd']
            while at < len(part):
                count = os.write(target_fd, part[at:])
                require(type(count) is int and count > 0, 'OUTER_TRANSCRIPT_WRITE')
                at += count
            if fd == master and not STATE['frozen']:
                try:
                    consent_step(protocol, part, time.monotonic, original, lambda raw: send_consent(master, raw))
                except BaseException as error:
                    fail(error)
                    report_nonpassing()
    # EOF and actual waitpid precede closing only this retired PTY, never actuation to stop it.
    os.close(master)
    STATE['fds'].remove(master)
    closed(stderr_read)
    require(os.pread(stderr['fd'], 131073, 0) == STATE['stderr'], 'OUTER_STDERR_READBACK')
    require(os.pread(transcript['fd'], 131073, 0) == bytes(STATE['raw']), 'OUTER_TTY_READBACK')
    os.fsync(transcript['fd'])
    os.fsync(stderr['fd'])
    closed(transcript)
    closed(stderr)
    require(not STATE['frozen'] and os.WIFEXITED(STATE['status']) and os.WEXITSTATUS(STATE['status']) == 0, 'OUTER_COORDINATOR_NONPASS')
    protocol.finish(time.monotonic())
    final = final_readback(protocol, time.monotonic, original, observed, fixture, uid, commit, os.environ['GITHUB_RUN_ID'])
    require(not STATE['fds'], 'OUTER_RETAINED_FDS')
    protocol.finish(time.monotonic())  # Immediately before reporting; never extend/reset the original deadline.
    sys.stdout.write(json.dumps({'status': 'completed-fixed-outer-second-seal', 'sourceCommit': commit,
        'directChildWaited': True, 'ptyEOF': True, 'consentCount': 3, 'noSignals': True,
        'stderrBytes': len(STATE['stderr']), 'stderrSHA256': hashlib.sha256(STATE['stderr']).hexdigest(),
        'finalRecordSHA256': final['sha256'], 'wholeGroupRetirement': False, 'releaseAcceptance': False}) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        if STATE['child']:
            raise
        fail(error)
        report_nonpassing()
        # A reporting deadline is not target retirement. Never close/kill to force completion.
        while STATE['fds'] or (STATE['submitted'] and not (STATE['waited'] and STATE['eof'] and STATE['stderr_eof'])) or any(
                not item['returned'] or (item['close_issued'] and not item['closed']) for item in STATE['opens']):
            time.sleep(0.5)
        raise SystemExit(78)
