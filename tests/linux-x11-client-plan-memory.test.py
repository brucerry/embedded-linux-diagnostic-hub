"""Literal closed-memory controls; no package command, client or probe main runs."""
import ast
import errno
import hashlib
import pathlib
import re
import stat
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/linux-x11-client-plan.py'
SOURCE_SHA256 = '45a9c173babb0e13f84cb85fd02c99433733bd49298ea69a1a88226dfd1e40c0'
RAW = SOURCE.read_bytes()
TREE = ast.parse(RAW, filename=str(SOURCE))
SELECTED = {'need', 'safe_phase', 'identity', 'client_reason', 'package_reason', 'Probe'}


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
        self.next_fd, self.queues, self.on_popen, self.on_poll, self.on_close = 100, {}, None, None, None
        self.on_mode = None
        self.os = types.SimpleNamespace(O_CLOEXEC=1, O_RDONLY=2, O_NOFOLLOW=4, O_NONBLOCK=8,
            O_RDWR=16, O_CREAT=32, O_EXCL=64, O_WRONLY=128, O_APPEND=256, X_OK=1,
            open=self.open, close=self.close, read=self.read, write=self.write,
            fstat=lambda fd: self.info(self.fds[fd]), lstat=lambda p: self.info(str(p)),
            path=types.SimpleNamespace(realpath=lambda p: str(p)), getuid=lambda: 1000,
            access=lambda p, mode: str(p) in self.files, set_blocking=self.mode,
            pread=lambda fd, count, offset: self.files[self.fds[fd]]['raw'][offset:offset + count], fsync=lambda fd: None)
        self.subprocess = types.SimpleNamespace(DEVNULL=-3, PIPE=-1, Popen=self.popen)
        namespace = {'__builtins__': __builtins__, 'errno': errno, 'hashlib': hashlib, 'pathlib': pathlib,
            're': re, 'stat': stat, 'os': self.os, 'subprocess': self.subprocess,
            'select': types.SimpleNamespace(select=self.select), 'time': types.SimpleNamespace(monotonic=lambda: self.clock[0])}
        selected = []
        for node in TREE.body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in
                    {'CLIENT', 'DPKG', 'ARGV', 'CHILD_ENV', 'CLIENT_REASONS', 'PACKAGE_REASONS'} for target in node.targets):
                selected.append(node)
            elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in SELECTED:
                selected.append(node)
        self.selected = {node.name for node in selected if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), namespace)
        self.ns = namespace
        self.probe = namespace['Probe'](0)

    def add(self, path, raw, uid=1000, mode=0o600):
        self.files[path] = {'raw': raw, 'uid': uid, 'mode': mode, 'ino': len(self.files) + 10}

    def info(self, path):
        if path not in self.files:
            return types.SimpleNamespace(st_dev=1, st_ino=2, st_uid=0, st_mode=stat.S_IFDIR | 0o755,
                st_nlink=2, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
        row = self.files[path]
        return types.SimpleNamespace(st_dev=1, st_ino=row['ino'], st_uid=row['uid'],
            st_mode=stat.S_IFREG | row['mode'], st_nlink=1, st_size=len(row['raw']), st_mtime_ns=1, st_ctime_ns=1)

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
        assert self.probe.fds[-1]['close_issued'] or any(owner['fd'] == fd and owner['close_issued'] for owner in self.probe.fds)
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

    def mode(self, fd, value):
        self.events.append(('mode', fd, value))
        if self.on_mode:
            self.on_mode()

    def popen(self, args, **kwargs):
        assert self.probe.child['issued'] and not self.probe.child['returned']
        self.events.append(('popen', args, kwargs))
        child = types.SimpleNamespace(stdout=Pipe(10), stderr=Pipe(11), status=0)
        self.queues[10], self.queues[11] = [b'ii \t7.7+6build2\tamd64\n', b''], [b'']
        def poll():
            if self.on_poll:
                self.on_poll()
            return child.status
        child.poll = poll
        if self.on_popen:
            self.on_popen(child)
        return child

    def select(self, readable, writeable, exceptional, delay):
        return [fd for fd in readable if self.queues.get(fd)], [], []


class ClientPlanMemory(unittest.TestCase):
    def test_guard_reason_census_and_stable_source_identity(self):
        m = Memory()
        reason = m.ns['client_reason']
        good = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=0, st_nlink=1, st_size=123)
        self.assertEqual(reason(good, True, True, True), 'accepted')
        for attr, value, expected in (('st_mode', stat.S_IFDIR | 0o755, 'type'), ('st_uid', 1000, 'owner'),
                                      ('st_mode', stat.S_IFREG | 0o777, 'mode'), ('st_nlink', 2, 'nlink'),
                                      ('st_size', 16 * 1024 ** 2 + 1, 'bound')):
            changed = types.SimpleNamespace(**vars(good))
            setattr(changed, attr, value)
            self.assertEqual(reason(changed, True, True, True), expected)
        for args, expected in (((False, True, True), 'canonical'), ((True, False, True), 'executable'),
                               ((True, True, False), 'parent')):
            self.assertEqual(reason(good, *args), expected)
        m.add('/usr/bin/xdpyinfo', b'read-only-tool', 0, 0o755)
        self.assertEqual(m.probe.tool('/usr/bin/xdpyinfo', 1000), 'accepted')
        self.assertFalse(m.probe.unknown())
        self.assertFalse(any(event[0] == 'popen' for event in m.events))

    def test_exact_package_classification_and_honest_unknowns(self):
        classify = Memory().ns['package_reason']
        self.assertEqual(classify(0, b'ii \t7.7+6build2\tamd64\n', b''), 'expected')
        self.assertEqual(classify(0, b'ii \t7.7+6build3\tamd64\n', b''), 'other')
        self.assertEqual(classify(1, b'', b'dpkg-query: no packages found matching x11-utils:amd64\n'), 'absent')
        for args in ((0, b'ii \t7.7+6build2\tarm64\n', b''), (0, b'rc \t7.7+6build2\tamd64\n', b''),
                     (0, b'ii \t7.7+6build2\tamd64\nextra', b''), (2, b'', b'private-error'),
                     (0, b'ii \t7.7+6build2\tamd64\n', b'private-warning')):
            self.assertEqual(classify(*args), 'unavailable')

    def test_one_fixed_command_empty_inherited_environment_and_closed_outputs(self):
        m = Memory()
        self.assertEqual(m.probe.package('/private'), 'expected')
        events = [event for event in m.events if event[0] == 'popen']
        self.assertEqual(len(events), 1)
        args, kwargs = events[0][1:]
        self.assertEqual(args, ('/usr/bin/dpkg-query', '--admindir=/var/lib/dpkg', '--no-pager', '-W',
                         '-f=${db:Status-Abbrev}\t${Version}\t${Architecture}\n', 'x11-utils:amd64'))
        self.assertEqual(kwargs['env'], m.ns['CHILD_ENV'])
        self.assertFalse(any(name in kwargs['env'] for name in ('APT_CONFIG', 'LD_PRELOAD', 'HOME', 'GITHUB_TOKEN')))
        self.assertTrue(all(pipe['closed'] and pipe['eof'] for pipe in m.probe.child['pipes'].values()))
        self.assertEqual(m.files['/private/stdout.bin']['raw'], b'ii \t7.7+6build2\tamd64\n')
        self.assertFalse(m.probe.unknown())
        with self.assertRaisesRegex(RuntimeError, 'ONE_COMMAND'):
            m.probe.package('/another-private')

    def test_late_factory_and_mode_failure_adopt_child_and_both_pipe_objects(self):
        for kind in ('late', 'factory', 'mode'):
            m, primary = Memory(), RuntimeError('private-primary')
            def throwing(*args):
                raise primary
            if kind == 'late':
                m.on_popen = lambda child: m.clock.__setitem__(0, 71)
            elif kind == 'factory':
                m.on_popen = throwing
            else:
                m.on_mode = throwing
            with self.assertRaises(RuntimeError) as caught:
                m.probe.package('/private')
            m.probe.fail(caught.exception)
            m.probe.fail(None)
            self.assertIs(m.probe.first, caught.exception)
            self.assertEqual(m.probe.secondary, [None])
            self.assertTrue(m.probe.unknown())
            self.assertEqual(len([event for event in m.events if event[0] == 'popen']), 1)
            if kind == 'late':
                self.assertTrue(m.probe.child['returned'])
                self.assertEqual(len(m.probe.child['pipes']), 2)
                self.assertIn(m.probe.child['object'], m.probe.returned)
                self.assertFalse(any(event[0] == 'mode' for event in m.events))

    def test_soft_deadline_observes_only_existing_child_without_pass_or_retry(self):
        m = Memory()
        m.on_poll = lambda: m.clock.__setitem__(0, 21)
        with self.assertRaisesRegex(RuntimeError, 'SOFT_DEADLINE'):
            m.probe.package('/private')
        self.assertTrue(m.probe.child['soft_expired'])
        self.assertEqual(m.probe.child['exit'], 0)
        self.assertFalse(m.probe.unknown())
        self.assertEqual(len([event for event in m.events if event[0] == 'popen']), 1)

    def test_output_overflow_stops_with_real_return_retained(self):
        m = Memory()
        original = m.popen
        def factory(*args, **kwargs):
            child = original(*args, **kwargs)
            m.queues[10] = [b'x' * 4096] * 17
            return child
        m.subprocess.Popen = factory
        with self.assertRaisesRegex(RuntimeError, 'OUTPUT_BOUND'):
            m.probe.package('/private')
        self.assertEqual(len(m.probe.child['stdout']), 65536)
        self.assertEqual(m.probe.returned[-1], b'x' * 4096)
        self.assertTrue(m.probe.unknown())
        self.assertEqual(len([event for event in m.events if event[0] == 'popen']), 1)

    def test_tool_close_failure_propagates_and_never_becomes_unavailable_then_child(self):
        m, error = Memory(), OSError('private-close-unknown')
        m.add('/usr/bin/xdpyinfo', b'read-only-tool', 0, 0o755)
        def throwing():
            raise error
        m.on_close = throwing
        with self.assertRaises(OSError) as caught:
            m.probe.tool('/usr/bin/xdpyinfo', 1000)
        self.assertIs(caught.exception, error)
        self.assertTrue(m.probe.fds[-1]['close_issued'])
        self.assertFalse(m.probe.fds[-1]['closed'])
        self.assertTrue(m.probe.unknown())
        self.assertFalse(any(event[0] == 'popen' for event in m.events))

    def test_managed_finite_output_phase_privacy_and_actual_ast_boundary(self):
        m = Memory()
        values = {'binding': 'verified', 'client': 'absent', 'package': 'absent', 'plan': 'not-run', 'child': 'joined'}
        m.add('/tmp/managed/output', b'')
        m.probe.managed_output('/tmp/managed/output', '/tmp/managed', 1000, values)
        self.assertEqual(m.files['/tmp/managed/output']['raw'], b'binding=verified\nclient=absent\npackage=absent\nplan=not-run\nchild=joined\n')
        self.assertFalse(m.probe.unknown())
        with self.assertRaisesRegex(RuntimeError, 'ENUMS'):
            m.probe.managed_output('/tmp/managed/output', '/tmp/managed', 1000, {**values, 'client': 'private-secret'})
        class Private:
            def __str__(self):
                raise AssertionError('no coercion')
        for private in ('private-secret', Private(), None, 1):
            self.assertEqual(m.ns['safe_phase'](private), 'binding')
        for allowed in ('binding', 'client', 'package', 'readback', 'output'):
            self.assertEqual(m.ns['safe_phase'](allowed), allowed)
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
