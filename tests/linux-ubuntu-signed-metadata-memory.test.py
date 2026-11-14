"""Fixed-source AST/data/owned-port tests, not actual network or crypto proof."""
import ast
import datetime
import email.utils
import errno
import hashlib
import json
import pathlib
import re
import stat
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/linux-ubuntu-signed-metadata.py'
SOURCE_SHA256 = 'cea45073f428f74d7369871acb518958df9da972b60de96585e10a465b25a4cb'
RAW = SOURCE.read_bytes()
TREE = ast.parse(RAW, filename=str(SOURCE))
SELECTED = {'need', 'safe_stage', 'identity', 'fixed_command', 'fixed_environment', 'status_time',
            'signature_status', 'release_metadata', 'preflight_attribute_reason', 'preflight_stat_reason',
            'candidate_parent_reason', 'candidate_metadata', 'Probe'}
NOW = datetime.datetime(2026, 11, 14, tzinfo=datetime.timezone.utc).timestamp()
CREATED = int(datetime.datetime(2024, 4, 25, tzinfo=datetime.timezone.utc).timestamp())
PRIMARY = 'F6ECB3762474EDA9D21B7022871920D1991BC93C'


def status(signer=PRIMARY, primary=PRIMARY, created=None, expires=b'0'):
    stamp = str(CREATED).encode() if created is None else created
    fields = [signer.encode(), b'2024-04-25', stamp, expires, b'4', b'0', b'1', b'8', b'01']
    if primary is not None:
        fields.append(primary.encode())
    return b'[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 871920D1991BC93C ignored-uid\n[GNUPG:] VALIDSIG ' + b' '.join(fields) + b'\n'


def release(expiry=None):
    # Release Date need not be ordered against signature creation by this unit.
    raw = b'Origin: Ubuntu\nLabel: Ubuntu\nSuite: noble\nCodename: noble\nArchitectures: amd64 arm64\nComponents: main universe\nDate: Fri, 26 Apr 2024 00:00:00 UTC\n'
    if expiry is not None:
        raw += b'Valid-Until: ' + expiry + b'\n'
    return raw


class Pipe:
    def __init__(self, fd):
        self.fd, self.closed = fd, False
    def fileno(self):
        return self.fd
    def close(self):
        self.closed = True


class Memory:
    def __init__(self):
        self.clock, self.events, self.files, self.fds, self.positions = [0.0], [], {}, {}, {}
        self.printed = []
        self.directories = {}
        self.next_fd, self.queues, self.on_popen, self.on_poll, self.on_mode, self.on_close = 100, {}, None, None, None, None
        self.os = types.SimpleNamespace(O_CLOEXEC=1, O_RDONLY=2, O_NOFOLLOW=4, O_NONBLOCK=8,
            O_RDWR=16, O_CREAT=32, O_EXCL=64, O_WRONLY=128, O_APPEND=256, X_OK=1,
            open=self.open, close=self.close, read=self.read, write=self.write,
            fstat=lambda fd: self.info(self.fds[fd]), lstat=lambda p: self.info(str(p)),
            path=types.SimpleNamespace(realpath=lambda p: str(p)), getuid=lambda: 1000,
            access=lambda p, mode: str(p) in self.files, set_blocking=self.mode,
            pread=lambda fd, count, offset: self.files[self.fds[fd]]['raw'][offset:offset + count], fsync=lambda fd: None,
            environ={'GITHUB_OUTPUT': '/tmp/managed/output', 'RUNNER_TEMP': '/tmp/managed'})
        self.subprocess = types.SimpleNamespace(DEVNULL=-3, PIPE=-1, Popen=self.popen)
        namespace = {'__builtins__': __builtins__, 'datetime': datetime, 'email': email, 'errno': errno,
            'hashlib': hashlib, 'pathlib': pathlib, 're': re, 'stat': stat, 'json': json, 'os': self.os, 'subprocess': self.subprocess,
            'print': lambda text: self.printed.append(text),
            'select': types.SimpleNamespace(select=self.select), 'time': types.SimpleNamespace(monotonic=lambda: self.clock[0], time=lambda: NOW),
            'sys': types.SimpleNamespace(platform='linux'), '__file__': str(SOURCE), 'CURRENT': []}
        selected = []
        for node in TREE.body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in
                    {'CURL', 'GPGV', 'KEYRING', 'PRIMARY', 'URL', 'SNAPSHOT', 'TRUST_ENV', 'PHASES',
                     'PREFLIGHT_REASONS', 'CANDIDATE_PATHS', 'CANDIDATE_REASONS', 'REPOSITORY',
                     'BRANCH', 'CLASSIFICATION_BRANCH', 'CANDIDATE_BRANCH', 'VERIFICATION_BRANCH'} for target in node.targets):
                selected.append(node)
            elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in SELECTED:
                selected.append(node)
        self.selected = {node.name for node in selected if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), namespace)
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        branches = [node for node in main.body if isinstance(node, ast.If) and isinstance(node.test, ast.Call) and
            isinstance(node.test.func, ast.Name) and node.test.func.id == 'any' and any(
                isinstance(child, ast.Constant) and child.value == 'SIGNED_PREREQUISITE_UNAVAILABLE' for child in ast.walk(node))]
        assert len(branches) == 1
        missing = ast.FunctionDef(name='missing', args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=name) for name in
            ('probe', 'originals', 'values', 'uid')], kwonlyargs=[], kw_defaults=[], defaults=[]), body=[branches[0]], decorator_list=[])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[missing], type_ignores=[])), str(SOURCE), 'exec'), namespace)
        classify = next(node for node in main.body if isinstance(node, ast.If) and
                        isinstance(node.test, ast.Name) and node.test.id == 'classification')
        classify_function = ast.FunctionDef(name='classify', args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=name) for name in
            ('probe', 'values', 'uid', 'source', 'head', 'own_file', 'own')], kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=classify.body, decorator_list=[])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[classify_function], type_ignores=[])), str(SOURCE), 'exec'), namespace)
        candidate = next(node for node in main.body if isinstance(node, ast.If) and
                         isinstance(node.test, ast.Name) and node.test.id == 'candidate')
        candidate_function = ast.FunctionDef(name='candidate', args=classify_function.args,
            body=candidate.body, decorator_list=[])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[candidate_function], type_ignores=[])), str(SOURCE), 'exec'), namespace)
        full_function = ast.FunctionDef(name='verified_main', args=main.args, body=main.body, decorator_list=[])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[full_function], type_ignores=[])), str(SOURCE), 'exec'), namespace)
        self.ns, self.probe = namespace, namespace['Probe'](0)

    def add(self, path, raw, uid=1000, mode=0o600):
        self.files[path] = {'raw': raw, 'uid': uid, 'mode': mode, 'ino': len(self.files) + 10}

    def info(self, path):
        if path in self.directories:
            return types.SimpleNamespace(st_dev=1, st_ino=2000, st_uid=1000,
                st_mode=stat.S_IFDIR | self.directories[path], st_nlink=2, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
        if path not in self.files:
            return types.SimpleNamespace(st_dev=1, st_ino=2, st_uid=0, st_mode=stat.S_IFDIR | 0o755,
                st_nlink=2, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
        row = self.files[path]
        return types.SimpleNamespace(st_dev=1, st_ino=row['ino'], st_uid=row['uid'],
            st_mode=stat.S_IFREG | row['mode'], st_nlink=1, st_size=len(row['raw']), st_mtime_ns=1, st_ctime_ns=1)

    def verification_environment(self):
        source = str(SOURCE.resolve().parents[1])  # Resolves only the pinned task source path.
        sha = 'a' * 40
        env = {'GITHUB_REPOSITORY': self.ns['REPOSITORY'], 'GITHUB_REF': self.ns['VERIFICATION_BRANCH'],
               'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_EVENT_NAME': 'push', 'RUNNER_ENVIRONMENT': 'github-hosted',
               'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_RUN_ID': '123', 'GITHUB_WORKSPACE': source,
               'GITHUB_SHA': sha, 'GITHUB_EVENT_PATH': '/tmp/managed/event.json',
               'GITHUB_OUTPUT': '/tmp/managed/output', 'RUNNER_TEMP': '/tmp/managed'}
        self.os.environ, self.os.geteuid = env, lambda: 1000
        self.add(source + '/.git/HEAD', sha.encode())
        self.add(str(SOURCE), RAW)
        self.add(env['GITHUB_EVENT_PATH'], json.dumps({'repository': {'full_name': self.ns['REPOSITORY'],
            'private': False}, 'after': sha, 'ref': env['GITHUB_REF']}).encode())
        self.add(env['GITHUB_OUTPUT'], b'')
        self.add(self.ns['CURL'], b'fake-curl-not-executable-code', 0, 0o755)
        self.add(self.ns['GPGV'], b'fake-gpgv-not-executable-code', 0, 0o755)
        keyring = self.ns['CANDIDATE_PATHS'][-1][1]
        self.add(keyring, b'fake-public-keyring-not-cryptographic-evidence', 0, 0o644)
        def mkdir(path, mode):
            assert path not in self.directories and path not in self.files
            self.directories[path] = mode
            self.events.append(('mkdir', path, mode))
        self.os.mkdir = mkdir
        self.os.listdir = lambda path: sorted({p[len(path) + 1:].split('/')[0] for p in
            (*self.files, *self.directories) if p.startswith(path + '/')})
        def factory(started):
            assert started == self.probe.started
            return self.probe
        self.ns['Probe'] = factory  # Fully owned fake ports retain the already constructed actual class instance.
        return keyring

    def open(self, path, flags, mode):
        assert self.probe.fds[-1]['issued'] and not self.probe.fds[-1]['returned']
        if flags & self.os.O_CREAT:
            assert path not in self.files
            self.add(path, b'', mode=mode)
        assert path in self.files
        fd = self.next_fd
        self.next_fd += 1
        self.fds[fd], self.positions[fd] = path, 0
        self.events.append(('open', path, fd))
        return fd

    def close(self, fd):
        assert any(owner['fd'] == fd and owner['close_issued'] for owner in self.probe.fds)
        self.events.append(('close', fd))
        if self.on_close:
            self.on_close()

    def read(self, fd, cap):
        if fd in self.queues:
            value = self.queues[fd].pop(0)
            assert len(value) <= cap
            return value
        raw = self.files[self.fds[fd]]['raw']
        at = self.positions[fd]
        self.positions[fd] += min(cap, len(raw) - at)
        return raw[at:at + cap]

    def write(self, fd, raw):
        self.files[self.fds[fd]]['raw'] += raw
        self.events.append(('write', fd, raw))
        return len(raw)

    def mode(self, fd, blocking):
        self.events.append(('mode', fd, blocking))
        if self.on_mode:
            self.on_mode()

    def popen(self, args, **kwargs):
        owner = self.probe.children[-1]
        assert owner['issued'] and not owner['returned']
        self.events.append(('popen', args, kwargs))
        child = types.SimpleNamespace(stdout=Pipe(10), stderr=Pipe(11), result=0)
        stdout, stderr = (b'opaque-signed-bytes', b'') if owner['role'] == 'download' else (release(), status())
        self.queues[10], self.queues[11] = [stdout, b''], [stderr, b''] if stderr else [b'']
        def poll():
            if self.on_poll:
                self.on_poll()
            return child.result
        child.poll = poll
        if self.on_popen:
            self.on_popen(child)
        return child

    def select(self, readable, writeable, exceptional, delay):
        return [fd for fd in readable if self.queues.get(fd)], [], []


class SignedMetadataMemory(unittest.TestCase):
    def test_exact_two_commands_and_only_approved_transport_environment(self):
        m = Memory()
        curl = m.ns['fixed_command']('download', '/private')
        self.assertEqual(curl, ('/usr/bin/curl', '--disable', '--proto', '=https', '--fail', '--silent', '--show-error',
            '--max-time', '20', '--connect-timeout', '10', '--retry', '0', '--max-filesize', '1048576',
            'https://snapshot.ubuntu.com/ubuntu/20261113T000000Z/dists/noble/InRelease'))
        self.assertEqual(m.ns['fixed_command']('verification', '/private'), ('/usr/bin/gpgv', '--homedir', '/private/gnupg',
            '--keyring', '/usr/share/keyrings/ubuntu-archive-keyring.gpg', '--status-fd', '2', '--output', '-', '/private/InRelease'))
        inherited = {'PATH': '/existing/toolpath', 'HTTPS_PROXY': 'private-proxy', 'CURL_CA_BUNDLE': '/private/ca', 'LD_PRELOAD': 'bad',
                     'GITHUB_TOKEN': 'private-token', 'CURL_HOME': 'bad', 'GNUPGHOME': 'bad'}
        env = m.ns['fixed_environment']('download', '/private', inherited)
        self.assertEqual(env['HTTPS_PROXY'], inherited['HTTPS_PROXY'])
        self.assertEqual(env['CURL_CA_BUNDLE'], inherited['CURL_CA_BUNDLE'])
        self.assertEqual(env['PATH'], inherited['PATH'])
        self.assertFalse(set(env) & {'LD_PRELOAD', 'GITHUB_TOKEN', 'CURL_HOME'})
        verifier = m.ns['fixed_environment']('verification', '/private', inherited)
        self.assertFalse(set(verifier) & {'HTTPS_PROXY', 'CURL_CA_BUNDLE', 'LD_PRELOAD', 'GITHUB_TOKEN', 'CURL_HOME'})
        self.assertEqual(verifier['PATH'], inherited['PATH'])
        self.assertEqual(verifier['GNUPGHOME'], '/private/gnupg')
        with self.assertRaisesRegex(RuntimeError, 'FIXED_ROLE'):
            m.ns['fixed_command']('arbitrary', '/private')

    def test_full_primary_status_not_short_id_uid_or_diagnostic_text(self):
        parse = Memory().ns['signature_status']
        self.assertEqual(parse(0, status(), NOW)[0]['primary'], PRIMARY)
        self.assertEqual(parse(0, status(primary=None), NOW)[0]['primary'], PRIMARY)
        self.assertEqual(parse(0, status(signer='A' * 40), NOW)[0]['primary'], PRIMARY)
        for raw in (b'gpgv: Good signature from Ubuntu\n', b'[GNUPG:] GOODSIG 871920D1991BC93C Ubuntu\n',
                    status(primary='A' * 40), status(signer='A' * 40, primary=None), status(signer='871920D1991BC93C')):
            with self.assertRaises(RuntimeError):
                parse(0, raw, NOW)
        with self.assertRaises(RuntimeError):
            parse(1, status(), NOW)

    def test_rejected_statuses_override_validsig_and_epoch_iso_expiry_policy(self):
        parse = Memory().ns['signature_status']
        for rejected in ('BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY', 'NODATA', 'FAILURE', 'ERROR', 'KEYEXPIRED', 'SIGEXPIRED', 'UNKNOWN'):
            with self.assertRaisesRegex(RuntimeError, 'REJECTED_STATUS'):
                parse(0, status() + ('[GNUPG:] ' + rejected + ' private\n').encode(), NOW)
        self.assertEqual(parse(0, status(created=b'20240425T000000'), NOW)[0]['created'], CREATED)
        self.assertEqual(parse(0, status(created=b'2024-04-25T00:00:00Z'), NOW)[0]['created'], CREATED)
        future = str(int(NOW + 1)).encode()
        with self.assertRaises(RuntimeError):
            parse(0, status(created=future), NOW)
        with self.assertRaises(RuntimeError):
            parse(0, status(expires=str(int(NOW - 1)).encode()), NOW)

    def test_verified_cleartext_historical_date_optional_expiry_not_future_index_gate(self):
        parse = Memory().ns['release_metadata']
        self.assertEqual(parse(release(), NOW)['expiry'], 'not-declared')
        self.assertEqual(parse(release(b'Sun, 15 Nov 2026 00:00:00 UTC'), NOW)['expiry'], 'present-valid')
        for raw in (release(b'Thu, 12 Nov 2026 00:00:00 UTC'), release().replace(b'noble', b'jammy'),
                    release().replace(b'Origin: Ubuntu', b'Origin: Other'), release().replace(b'amd64 arm64', b'arm64'),
                    release().replace(b'main universe', b'universe'), release() + b'Origin: Ubuntu\n',
                    release().replace(b'Fri, 26 Apr 2024', b'Sun, 15 Nov 2026')):
            with self.assertRaises((RuntimeError, ValueError)):
                parse(raw, NOW)
        # No fabricated Packages.xz/checksum or recent-Date requirement is needed.
        self.assertNotIn(b'Packages.xz', release())

    def test_actual_owned_capture_role_order_join_and_private_signed_bytes(self):
        m = Memory()
        signed, _ = m.probe.run('download', '/private', {'HTTPS_PROXY': 'private'})
        self.assertEqual(signed, b'opaque-signed-bytes')
        m.probe.write_private('/private/InRelease', signed)
        before = m.probe.pin('/private/InRelease', 1048576, 1000)
        verified, sig = m.probe.run('verification', '/private', {})
        self.assertEqual(verified, release())
        self.assertEqual(sig, status())
        self.assertFalse(m.probe.unknown())
        self.assertEqual(len([event for event in m.events if event[0] == 'popen']), 2)
        self.assertTrue(all(child['exit'] == 0 and all(pipe['eof'] and pipe['closed'] for pipe in child['pipes'].values()) for child in m.probe.children))
        m.files['/private/InRelease']['ino'] += 1
        self.assertNotEqual(m.probe.pin('/private/InRelease', 1048576, 1000), before)
        with self.assertRaisesRegex(RuntimeError, 'ROLE_ORDER'):
            m.probe.run('download', '/another', {})

    def test_late_failed_factory_modes_and_soft_deadline_keep_issued_owner(self):
        for kind in ('late', 'factory', 'mode', 'soft'):
            m, primary = Memory(), RuntimeError('private-primary')
            def throwing(*args):
                raise primary
            if kind == 'late':
                m.on_popen = lambda child: m.clock.__setitem__(0, 71)
            elif kind == 'factory':
                m.on_popen = throwing
            elif kind == 'mode':
                m.on_mode = throwing
            else:
                m.on_poll = lambda: m.clock.__setitem__(0, 21)
            with self.assertRaises(RuntimeError) as caught:
                m.probe.run('download', '/private', {})
            m.probe.fail(caught.exception)
            m.probe.fail(None)
            self.assertIs(m.probe.first, caught.exception)
            self.assertEqual(m.probe.secondary, [None])
            self.assertEqual(len([event for event in m.events if event[0] == 'popen']), 1)
            if kind == 'late':
                self.assertTrue(m.probe.children[0]['returned'])
                self.assertEqual(len(m.probe.children[0]['pipes']), 2)
                self.assertIn(m.probe.children[0]['object'], m.probe.returned)
                self.assertFalse(any(event[0] == 'mode' for event in m.events))
            self.assertEqual(m.probe.unknown(), kind != 'soft')
            with self.assertRaises(RuntimeError):
                m.probe.run('verification', '/private', {})

    def test_bounded_status_stream_and_preflight_close_uncertainty_do_not_fallback(self):
        m = Memory()
        original = m.popen
        def factory(*args, **kwargs):
            child = original(*args, **kwargs)
            m.queues[11] = [b'x' * 4096] * 17
            return child
        m.subprocess.Popen = factory
        with self.assertRaisesRegex(RuntimeError, 'STREAM_BOUND'):
            m.probe.run('download', '/private', {})
        self.assertEqual(len(m.probe.children[0]['stderr']), 65536)
        self.assertEqual(m.probe.returned[-1], b'x' * 4096)
        self.assertTrue(m.probe.unknown())
        m = Memory()
        m.add('/usr/share/keyrings/ubuntu-archive-keyring.gpg', b'only-read-guard-test-not-a-real-key', 0, 0o644)
        error = OSError('private-close')
        def close_failure():
            raise error
        m.on_close = close_failure
        with self.assertRaises(OSError) as caught:
            m.probe.preflight('/usr/share/keyrings/ubuntu-archive-keyring.gpg', False)
        self.assertIs(caught.exception, error)
        self.assertTrue(m.probe.unknown())
        self.assertEqual(m.probe.children, [])

    def test_actual_missing_prerequisite_branch_is_finite_and_nonpassing(self):
        m = Memory()
        m.add('/tmp/managed/output', b'')
        values = {'verifier': 'unavailable', 'anchor': 'unavailable', 'anchor_reason': 'not-reported', 'signature': 'not-verified',
                  'metadata': 'not-verified', 'signer': 'unavailable', 'inrelease_sha256': 'unavailable', 'expiry': 'unavailable'}
        with self.assertRaisesRegex(RuntimeError, 'PREREQUISITE_UNAVAILABLE'):
            m.ns['missing'](m.probe, {'curl': None}, values, 1000)
        self.assertIn(b'signature=not-verified\n', m.files['/tmp/managed/output']['raw'])
        self.assertEqual(m.probe.children, [])
        self.assertFalse(m.probe.unknown())
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_ENUMS'):
            m.probe.publish('/tmp/managed/output', '/tmp/managed', 1000, {**values, 'signer': 'private-untrusted'})
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_ENUMS'):
            m.probe.publish('/tmp/managed/output', '/tmp/managed', 1000, {**values, 'anchor_reason': 'private-untrusted'})

    def test_attribute_reasons_preserve_every_original_preflight_predicate(self):
        classify = Memory().ns['preflight_attribute_reason']
        expected = {'symlink': {'st_mode': stat.S_IFLNK | 0o777},
                    'nonregular': {'st_mode': stat.S_IFDIR | 0o755},
                    'non-root-owner': {'st_uid': 1000}, 'link-count': {'st_nlink': 2},
                    'empty': {'st_size': 0}, 'oversize': {'st_size': 16 * 1024 ** 2 + 1},
                    'unsafe-mode': {'st_mode': stat.S_IFREG | 0o664}, 'attributes-ok': {}}
        for reason, changes in expected.items():
            info = types.SimpleNamespace(**{'st_mode': stat.S_IFREG | 0o644, 'st_uid': 0,
                'st_nlink': 1, 'st_size': 32, **changes})
            self.assertEqual(classify(info), reason)
        for kind in (stat.S_IFREG, stat.S_IFLNK, stat.S_IFDIR):
            for mode in (0o400, 0o644, 0o600, 0o664, 0o646, 0o1644, 0o2644, 0o4644):
                for uid in (0, 1000):
                    for links in (0, 1, 2):
                        for size in (0, 1, 16 * 1024 ** 2, 16 * 1024 ** 2 + 1):
                            info = types.SimpleNamespace(st_mode=kind | mode, st_uid=uid, st_nlink=links, st_size=size)
                            original = stat.S_ISREG(info.st_mode) and uid == 0 and links == 1 and 0 < size <= 16 * 1024 ** 2 and not info.st_mode & 0o7022
                            self.assertEqual(classify(info) == 'attributes-ok', bool(original))

    def test_stat_canonical_and_executable_reasons_are_finite_without_fallback(self):
        for error_number, reason in ((errno.ENOENT, 'path-absent'), (errno.EACCES, 'stat-denied'),
                                     (errno.EPERM, 'stat-denied'), (errno.ENOTDIR, 'stat-error'), (errno.EIO, 'stat-error')):
            m = Memory()
            def failed_stat(path):
                raise OSError(error_number, 'private diagnostic and path')
            m.os.lstat = failed_stat
            self.assertEqual(m.probe.preflight_metadata(m.ns['KEYRING'], False), (None, reason))
            self.assertEqual(m.probe.preflight_reasons[m.ns['KEYRING']], reason)
            self.assertFalse(m.events)
            self.assertFalse(m.probe.children)
        m = Memory()
        m.add(m.ns['KEYRING'], b'not-a-key', 0, 0o644)
        m.os.path.realpath = lambda path: 'unpublished-target'
        self.assertEqual(m.probe.preflight_metadata(m.ns['KEYRING'], False)[1], 'noncanonical')
        m.os.path.realpath = lambda path: path
        m.os.access = lambda *args: False
        self.assertEqual(m.probe.preflight_metadata(m.ns['KEYRING'], False)[1], 'attributes-ok')
        self.assertEqual(m.probe.preflight_metadata(m.ns['KEYRING'], True)[1], 'not-executable')
        self.assertFalse(m.events)

    def test_actual_classification_branch_reads_no_key_content_or_children_and_never_admits_anchor(self):
        m = Memory()
        m.add(m.ns['KEYRING'], b'not-a-real-key', 0, 0o644)
        source, own_file = '/memory/source', '/memory/source/scripts/linux-ubuntu-signed-metadata.py'
        m.add(source + '/.git/HEAD', b'A' * 40)
        m.add(own_file, b'memory source bytes')
        m.add('/tmp/managed/output', b'')
        head = m.probe.pin(source + '/.git/HEAD', 256, 1000)
        own = m.probe.pin(own_file, 1048576, 1000)
        def forbidden(*args, **kwargs):
            raise AssertionError('classification must not enter content preflight or child execution')
        m.probe.preflight = forbidden
        m.probe.run = forbidden
        values = {'verifier': 'unavailable', 'anchor': 'unavailable', 'anchor_reason': 'not-reported', 'signature': 'not-verified',
                  'metadata': 'not-verified', 'signer': 'unavailable', 'inrelease_sha256': 'unavailable', 'expiry': 'unavailable'}
        m.ns['classify'](m.probe, values, 1000, source, head, own_file, own)
        self.assertEqual(values['anchor_reason'], 'attributes-ok')
        self.assertEqual(values['anchor'], 'unavailable')
        self.assertEqual(values['signature'], 'not-verified')
        self.assertEqual(values['metadata'], 'not-verified')
        self.assertFalse(any(event[0] == 'open' and event[1] == m.ns['KEYRING'] for event in m.events))
        self.assertEqual(m.probe.children, [])
        self.assertFalse(m.probe.unknown())
        for expected, change in (('path-absent', None), ('unsafe-mode', 0o664)):
            if change is None:
                original_stat = m.os.lstat
                def missing_keyring(path):
                    if path == m.ns['KEYRING']:
                        raise FileNotFoundError(errno.ENOENT, 'private missing path')
                    return original_stat(path)
                m.os.lstat = missing_keyring
            else:
                m.os.lstat = original_stat
                m.files[m.ns['KEYRING']]['mode'] = change
            m.ns['classify'](m.probe, values, 1000, source, head, own_file, own)
            self.assertEqual(values['anchor_reason'], expected)
            self.assertEqual(values['anchor'], 'unavailable')
            self.assertEqual(values['signature'], 'not-verified')
            self.assertFalse(m.probe.unknown())
        self.assertFalse(any(event[0] == 'open' and event[1] == m.ns['KEYRING'] for event in m.events))
        self.assertEqual(m.probe.children, [])
        self.assertEqual([json.loads(raw) for raw in m.printed], [
            {'anchor_reason': reason, 'scope': 'attributes-only'} for reason in
            ('attributes-ok', 'path-absent', 'unsafe-mode')])
        # The exact new flag and ref are bound before any classification operation.
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        assignment = next(node for node in main.body if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == 'expected_ref' for target in node.targets))
        self.assertEqual(ast.unparse(assignment.value),
                         'VERIFICATION_BRANCH if candidate_verification else CANDIDATE_BRANCH if candidate else CLASSIFICATION_BRANCH if classification else BRANCH')

    def test_fixed_candidate_verifier_selector_rejects_unknown_and_falsey_inputs_before_effects(self):
        m = Memory()
        keyring = m.ns['CANDIDATE_PATHS'][-1][1]
        expected = ('/usr/bin/gpgv', '--homedir', '/private/gnupg', '--keyring', keyring,
                    '--status-fd', '2', '--output', '-', '/private/InRelease')
        self.assertEqual(m.ns['fixed_command']('verification', '/private', keyring), expected)
        for invalid in (None, False, '', '/tmp/untrusted-keyring.gpg'):
            with self.assertRaisesRegex(RuntimeError, 'FIXED_KEYRING'):
                m.ns['fixed_command']('verification', '/private', invalid)
            with self.assertRaisesRegex(RuntimeError, 'FIXED_KEYRING'):
                m.probe.run('download', '/private', {}, invalid)
        self.assertEqual(m.events, [])
        self.assertEqual(m.probe.children, [])
        self.assertFalse(m.probe.unknown())

    def test_full_verification_mode_uses_exact_candidate_and_refuses_mismatch_mutation_or_invalid_data(self):
        for case, failure in (('success', None), ('key-mutation', 'ANCHOR_OR_TOOL_CHANGED'),
                              ('wrong-ref', 'CONTEXT'), ('unsafe-parent', 'CANDIDATE_REFUSED'),
                              ('unsafe-tool', 'PREREQUISITE_UNAVAILABLE'), ('wrong-signer', 'AUTHORIZED_PRIMARY'),
                              ('bad-metadata', 'RELEASE_IDENTITY')):
            m = Memory()
            keyring = m.verification_environment()
            if case == 'key-mutation':
                def mutate():
                    if m.probe.children[-1]['role'] == 'verification':
                        m.files[keyring]['raw'] = b'changed-fake-keyring'
                m.on_poll = mutate
            elif case == 'wrong-ref':
                m.os.environ['GITHUB_REF'] = m.ns['BRANCH']
            elif case == 'unsafe-parent':
                original = m.os.lstat
                m.os.lstat = lambda path: types.SimpleNamespace(**{**vars(original(path)),
                    'st_mode': stat.S_IFDIR | 0o775}) if path == '/etc/apt' else original(path)
            elif case == 'unsafe-tool':
                m.files[m.ns['GPGV']]['mode'] = 0o775
            elif case in ('wrong-signer', 'bad-metadata'):
                original = m.subprocess.Popen
                def altered(*args, **kwargs):
                    child = original(*args, **kwargs)
                    if m.probe.children[-1]['role'] == 'verification':
                        if case == 'wrong-signer':
                            m.queues[11] = [status(primary='A' * 40), b'']
                        else:
                            m.queues[10] = [release().replace(b'Origin: Ubuntu', b'Origin: Other'), b'']
                    return child
                m.subprocess.Popen = altered
            if failure:
                with self.assertRaisesRegex(RuntimeError, failure):
                    m.ns['verified_main'](['--verify-ubuntu-archive-input'])
            else:
                m.ns['verified_main'](['--verify-ubuntu-archive-input'])
                result = json.loads(m.printed[-1])
                self.assertEqual(result['signature'], 'verified')  # Mock status only, not actual crypto proof.
                self.assertEqual(result['metadata'], 'verified')
                self.assertEqual(result['signer'], PRIMARY)
                self.assertEqual(result['inrelease_sha256'], hashlib.sha256(b'opaque-signed-bytes').hexdigest())
                calls = [event[1] for event in m.events if event[0] == 'popen']
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[1][calls[1].index('--keyring') + 1], keyring)
                self.assertEqual(calls[0][-1], m.ns['URL'])
                self.assertGreaterEqual(len([e for e in m.events if e[0] == 'open' and e[1] == keyring]), 2)
            if case in ('wrong-ref', 'unsafe-parent', 'unsafe-tool'):
                self.assertEqual(m.probe.children, [])
                self.assertFalse(any(e[0] == 'open' and e[1] == keyring for e in m.events))
            elif failure:
                self.assertNotIn(b'signature=verified\n', m.files[m.os.environ['GITHUB_OUTPUT']]['raw'])
            self.assertFalse(m.probe.unknown())

    def test_candidate_parent_predicate_matches_existing_directory_guard(self):
        classify = Memory().ns['candidate_parent_reason']
        for kind in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK):
            for mode in (0o755, 0o555, 0o777, 0o775, 0o757, 0o1755, 0o2755, 0o4755):
                for uid in (0, 1000, 2000):
                    info = types.SimpleNamespace(st_mode=kind | mode, st_uid=uid)
                    original = stat.S_ISDIR(info.st_mode) and uid in (0, 1000) and not info.st_mode & 0o7022
                    self.assertEqual(classify(info, 1000) == 'attributes-ok', bool(original))

    def test_candidate_each_parent_refuses_unsafe_paths_before_descending(self):
        for index, (label, path) in enumerate(Memory().ns['CANDIDATE_PATHS'][:-1]):
            cases = (('symlink', {'st_mode': stat.S_IFLNK | 0o777}),
                     ('non-directory', {'st_mode': stat.S_IFREG | 0o644}),
                     ('parent-owner', {'st_uid': 2000}), ('unsafe-mode', {'st_mode': stat.S_IFDIR | 0o775}),
                     ('noncanonical', {}))
            for expected, changes in cases:
                m = Memory()
                visited, old_stat = [], m.os.lstat
                def checked_stat(actual_path):
                    visited.append(actual_path)
                    info = old_stat(actual_path)
                    return types.SimpleNamespace(**{**vars(info), **changes}) if actual_path == path else info
                m.os.lstat = checked_stat
                if expected == 'noncanonical':
                    m.os.path.realpath = lambda actual_path: 'unpublished-alias' if actual_path == path else actual_path
                result = m.ns['candidate_metadata'](m.probe, 1000)
                self.assertEqual(result, 'input-' + label + '-' + expected)
                self.assertEqual(visited, [step[1] for step in m.ns['CANDIDATE_PATHS'][:index + 1]])
                self.assertEqual(m.events, [])
                self.assertEqual(m.probe.children, [])

    def test_candidate_exact_file_guard_and_stat_errors_do_not_read_key_material(self):
        for expected, changes in (('symlink', {'st_mode': stat.S_IFLNK | 0o777}),
                                  ('nonregular', {'st_mode': stat.S_IFDIR | 0o755}),
                                  ('non-root-owner', {'st_uid': 1000}), ('link-count', {'st_nlink': 2}),
                                  ('empty', {'st_size': 0}), ('oversize', {'st_size': 16 * 1024 ** 2 + 1}),
                                  ('unsafe-mode', {'st_mode': stat.S_IFREG | 0o664}), ('noncanonical', {})):
            m = Memory()
            path = m.ns['CANDIDATE_PATHS'][-1][1]
            m.add(path, b'test-only-not-key-material', 0, 0o644)
            old_stat = m.os.lstat
            m.os.lstat = lambda actual_path: types.SimpleNamespace(**{**vars(old_stat(actual_path)), **changes}) if actual_path == path else old_stat(actual_path)
            if expected == 'noncanonical':
                m.os.path.realpath = lambda actual_path: 'unpublished-alias' if actual_path == path else actual_path
            self.assertEqual(m.ns['candidate_metadata'](m.probe, 1000), 'input-keyring-' + expected)
            self.assertEqual(m.events, [])
        for index, (label, path) in enumerate(Memory().ns['CANDIDATE_PATHS']):
            for number, expected in ((errno.ENOENT, 'path-absent'), (errno.EACCES, 'stat-denied'), (errno.EIO, 'stat-error')):
                m = Memory()
                old_stat, visited = m.os.lstat, []
                def failed_stat(actual_path):
                    visited.append(actual_path)
                    if actual_path == path:
                        raise OSError(number, 'private error detail')
                    return old_stat(actual_path)
                m.os.lstat = failed_stat
                self.assertEqual(m.ns['candidate_metadata'](m.probe, 1000), 'input-' + label + '-' + expected)
                self.assertEqual(visited, [step[1] for step in m.ns['CANDIDATE_PATHS'][:index + 1]])
                self.assertEqual(m.events, [])

    def test_actual_candidate_branch_is_fixed_metadata_only_and_does_not_admit_trust(self):
        m = Memory()
        candidate = '/etc/apt/trusted.gpg.d/ubuntu-keyring-2018-archive.gpg'
        self.assertEqual(m.ns['CANDIDATE_PATHS'], (('root', '/'), ('etc', '/etc'), ('apt', '/etc/apt'),
            ('trusted-directory', '/etc/apt/trusted.gpg.d'), ('keyring', candidate)))
        self.assertEqual(m.ns['KEYRING'], '/usr/share/keyrings/ubuntu-archive-keyring.gpg')
        self.assertEqual(m.ns['PRIMARY'], PRIMARY)
        m.add(candidate, b'test-only-not-a-key', 0, 0o644)
        source, own_file = '/memory/source', '/memory/source/scripts/linux-ubuntu-signed-metadata.py'
        m.add(source + '/.git/HEAD', b'A' * 40)
        m.add(own_file, b'memory source')
        m.add('/tmp/managed/output', b'')
        head, own = m.probe.pin(source + '/.git/HEAD', 256, 1000), m.probe.pin(own_file, 1048576, 1000)
        def forbidden(*args, **kwargs):
            raise AssertionError('candidate mode cannot enter key content, tool preflight or child execution')
        m.probe.preflight = forbidden
        m.probe.preflight_metadata = forbidden
        m.probe.run = forbidden
        values = {'verifier': 'unavailable', 'anchor': 'unavailable', 'anchor_reason': 'not-reported', 'signature': 'not-verified',
                  'metadata': 'not-verified', 'signer': 'unavailable', 'inrelease_sha256': 'unavailable', 'expiry': 'unavailable'}
        m.ns['candidate'](m.probe, values, 1000, source, head, own_file, own)
        self.assertEqual(values['anchor_reason'], 'input-all-attributes-ok')
        self.assertEqual(values['anchor'], 'unavailable')
        self.assertEqual(values['signature'], 'not-verified')
        self.assertEqual(values['signer'], 'unavailable')
        self.assertFalse(m.probe.unknown())
        m.files[candidate]['mode'] = 0o664
        with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_REFUSED'):
            m.ns['candidate'](m.probe, values, 1000, source, head, own_file, own)
        self.assertEqual(values['anchor_reason'], 'input-keyring-unsafe-mode')
        self.assertFalse(m.probe.unknown())
        self.assertFalse(any(event[0] == 'open' and event[1] == candidate for event in m.events))
        self.assertEqual(m.probe.children, [])
        self.assertEqual([json.loads(raw)['scope'] for raw in m.printed], ['candidate-attributes-only'] * 2)
        late = Memory()
        original = late.os.lstat
        def late_stat(path):
            value = original(path)
            late.clock[0] = 71
            return value
        late.os.lstat = late_stat
        with self.assertRaisesRegex(RuntimeError, 'DEADLINE'):
            late.ns['candidate_metadata'](late.probe, 1000)
        self.assertEqual(late.events, [])
        self.assertEqual(late.probe.children, [])

    def test_workflow_unset_outputs_are_not_fabricated_prerequisite_reports(self):
        workflow = SOURCE.parents[1] / '.github/workflows/linux-ubuntu-signed-metadata.yml'
        raw = workflow.read_text()
        fallbacks = re.findall(r"steps\.probe\.outputs\.([a-z_0-9]+)\s*\|\|\s*'([^']+)'", raw)
        self.assertEqual({field for field, _ in fallbacks},
                         {'verifier', 'anchor', 'anchor_reason', 'signature', 'metadata', 'expiry', 'inrelease_sha256', 'signer'})
        self.assertTrue(all(fallback == 'not-reported' for _, fallback in fallbacks))

    def test_phase_privacy_fixed_import_graph_and_original_source_pin(self):
        m = Memory()
        class Private:
            def __str__(self):
                raise AssertionError('no coercion')
        for value in ('private-secret', Private(), None, 1):
            self.assertEqual(m.ns['safe_stage'](value), 'unavailable')
        for value in ('binding', 'preflight', 'download', 'verification', 'readback', 'output'):
            self.assertEqual(m.ns['safe_stage'](value), value)
        self.assertEqual(m.selected, SELECTED)
        self.assertEqual(hashlib.sha256(RAW).hexdigest(), SOURCE_SHA256)
        selected = [node for node in TREE.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in SELECTED]
        self.assertFalse(any(isinstance(child, (ast.Import, ast.ImportFrom)) for node in selected for child in ast.walk(node)))
        self.assertNotIn('main', SELECTED)
        calls = {(node.func.value.id, node.func.attr) for node in ast.walk(TREE) if isinstance(node, ast.Call) and
                 isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)}
        self.assertFalse(calls & {('os', 'kill'), ('os', 'unlink'), ('os', 'remove'), ('subprocess', 'run')})


if __name__ == '__main__':
    unittest.main()
