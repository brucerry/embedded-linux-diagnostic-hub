"""Closed-memory controls for actual packet preparation and reused actor validators.

No whole module, main, loader, filesystem/packet producer, Node or PTY executes.
Only the selected actual definitions run with explicit memory IO below.
"""
import ast
import hashlib
import json
import pathlib
import re
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACTOR = ROOT / 'scripts/linux-owned-second-seal-pty.py'
HELPER = ROOT / 'scripts/prepare-linux-second-seal-request.py'
ACTOR_TREE = ast.parse(ACTOR.read_bytes(), filename=str(ACTOR))
HELPER_TREE = ast.parse(HELPER.read_bytes(), filename=str(HELPER))
SOURCE, HOME, BUILD, COMMIT, UID = '/home/test/source', '/home/test', '/home/test/build', 'a' * 40, 1000


def definitions(tree, constants, functions):
    selected = []
    for name in constants:
        found = [n for n in tree.body if isinstance(n, ast.Assign) and len(n.targets) == 1
                 and isinstance(n.targets[0], ast.Name) and n.targets[0].id == name]
        if len(found) != 1:
            raise AssertionError('One actual constant: ' + name)
        selected.extend(found)
    for name in functions:
        found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name]
        if len(found) != 1:
            raise AssertionError('One actual function: ' + name)
        selected.extend(found)
    return compile(ast.Module(body=selected, type_ignores=[]), '<actual-data-only-memory>', 'exec')


ACTOR_CODE = definitions(ACTOR_TREE, ('A', 'B', 'C', 'SOURCE_NAMES', 'RECORD_NAMES', 'STATE'),
                         ('require', 'fail', 'validate_request', 'read_inputs', 'opened', 'closed', 'identity'))
HELPER_CODE = definitions(HELPER_TREE, (), ('request_from_originals', 'prepare_request', 'unknown_data'))


class Memory:
    O_CLOEXEC, O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW = 1, 2, 4, 8, 16

    def __init__(self):
        self.files, self.inodes, self.fds, self.calls = {}, {}, {}, []
        self.next_ino = 10
        self.open_error = self.write_error = self.sync_error = self.close_error = None
        self.first_write = None
        self.bad_count = False
        self.change_head = False
        self.actor_ns = {'pathlib': pathlib, 'json': json, 're': re, 'hashlib': hashlib, 'os': self}
        exec(ACTOR_CODE, self.actor_ns)
        self.actor = types.SimpleNamespace(**self.actor_ns)
        self.actor.parents = lambda directory, uid: self.calls.append(('parents', directory, uid))
        self.actor_ns['parents'] = self.actor.parents
        self.actor.observed = self.observed
        self.actor_ns['observed'] = self.observed
        self.helper_ns = {'pathlib': pathlib, 'json': json, 'hashlib': hashlib, 'os': self}
        exec(HELPER_CODE, self.helper_ns)
        self.install_inputs()

    def put(self, file, value):
        raw = (json.dumps(value) + '\n').encode() if isinstance(value, dict) else value
        if file not in self.inodes:
            self.inodes[file] = self.next_ino
            self.next_ino += 1
        self.files[file] = raw
        return hashlib.sha256(raw).hexdigest()

    def lstat(self, file):
        if file not in self.files:
            raise FileNotFoundError(file)
        return types.SimpleNamespace(st_dev=1, st_ino=self.inodes[file], st_uid=UID, st_mode=0o100600,
                                     st_nlink=1, st_size=len(self.files[file]), st_mtime_ns=100, st_ctime_ns=101)

    def observed(self, file, cap, uid, retain=True):
        self.calls.append(('read', file))
        raw, info = self.files[file], self.lstat(file)
        assert uid == UID and 0 < len(raw) <= cap
        return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                'identity': self.actor.identity(info), 'raw': raw if retain else None}

    def open(self, file, flags, mode):
        self.calls.append(('open', file, flags))
        assert flags & self.O_EXCL and flags & self.O_NOFOLLOW
        assert self.actor.STATE['opens'][-1]['issued'] and not self.actor.STATE['opens'][-1]['returned']
        if self.open_error is not None:
            raise self.open_error
        if file in self.files:
            raise FileExistsError(file)
        self.put(file, b'')
        self.fds[0] = file
        return 0

    def write(self, fd, raw):
        self.calls.append(('write', fd))
        assert fd in self.actor.STATE['fds']
        owner = self.actor.STATE['returned'][0]
        assert owner['output']['fd'] == fd and owner['pending'] == 'write'
        if self.write_error is not None:
            raise self.write_error
        if self.bad_count:
            return 0
        n = min(len(raw), self.first_write) if self.first_write is not None else len(raw)
        self.first_write = None
        self.files[self.fds[fd]] += raw[:n]
        if self.change_head:
            self.put(SOURCE + '/.git/HEAD', b'f' * 40 + b'\n')
        return n

    def fsync(self, fd):
        self.calls.append(('sync', fd))
        assert self.actor.STATE['returned'][0]['pending'] == 'sync'
        if self.sync_error is not None:
            raise self.sync_error

    def fstat(self, fd):
        return self.lstat(self.fds[fd])

    def close(self, fd):
        self.calls.append(('close', fd))
        assert self.actor.STATE['opens'][-1]['close_issued']
        if self.close_error is not None:
            raise self.close_error
        del self.fds[fd]

    def install_inputs(self):
        for name in self.actor.SOURCE_NAMES:
            self.put(SOURCE + '/' + name, ('closed original source ' + name).encode())
        self.put(SOURCE + '/node_modules/tsx/dist/loader.mjs', b'closed loader bytes')
        self.put(SOURCE + '/.git/HEAD', COMMIT.encode() + b'\n')
        for role, version in (('a', self.actor.A), ('b', self.actor.B), ('c', self.actor.C)):
            archive = BUILD + '/build-' + role + '/Diagnostic-Hub-linux-x64.tar.gz'
            archive_sha = self.put(archive, ('closed archive ' + role).encode())
            info = self.lstat(archive)
            directory = BUILD + '/records-' + role
            descriptor_sha = self.put(directory + '/descriptor.json', {'version': version, 'sourceCommit': COMMIT})
            records = {
                'package.json': {'name': 'embedded-linux-diagnostic-hub', 'version': version},
                'capability.json': {'version': version},
                'census.json': {'compressedBytes': info.st_size, 'compressedSHA256': archive_sha},
                'preparation.json': {'status': 'prepared-install-envelope', 'root': BUILD + '/envelope-' + role,
                                     'descriptorSHA256': descriptor_sha},
                'inputs.json': {'sourceCommit': COMMIT, 'role': role, 'version': version,
                    'sourceRoot': BUILD + '/build-' + role + '/linux-unpacked', 'envelopeRoot': BUILD + '/envelope-' + role,
                    'descriptorSHA256': descriptor_sha, 'archive': {'path': archive, 'bytes': info.st_size, 'sha256': archive_sha,
                    'identity': {k: getattr(info, v) for k, v in (('dev', 'st_dev'), ('ino', 'st_ino'), ('uid', 'st_uid'),
                                                              ('mode', 'st_mode'), ('nlink', 'st_nlink'), ('size', 'st_size'))}}}}
            for name, value in records.items():
                self.put(directory + '/' + name, value)

    def prepare(self):
        return self.helper_ns['prepare_request'](self.actor, SOURCE, BUILD, HOME, UID, COMMIT)

    def unknown(self):
        return self.helper_ns['unknown_data'](self.actor)


class RequestMemoryTests(unittest.TestCase):
    def test_real_definitions_create_only_exact_existing_schema_from_abc_originals(self):
        m = Memory()
        before = dict(m.files)
        result = m.prepare()
        file = BUILD + '/outer-second-seal-request.json'
        self.assertEqual(set(m.files) - set(before), {file})
        self.assertTrue(all(m.files[name] == raw for name, raw in before.items()))
        raw = m.files[file]
        request = json.loads(raw)
        self.assertEqual(set(request), {'schema', 'sourceCommit', 'buildRoot', 'loaderSHA256', 'sourceSHA256', 'recordsSHA256'})
        self.assertEqual(m.actor.validate_request(request, HOME, COMMIT), BUILD)
        m.actor.read_inputs(request, SOURCE, UID)
        self.assertEqual(set(request['recordsSHA256']), {'a', 'b', 'c'})
        self.assertEqual(request['recordsSHA256']['c']['package.json'], hashlib.sha256(before[BUILD + '/records-c/package.json']).hexdigest())
        self.assertEqual(result, {'path': file, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        self.assertFalse(m.unknown())
        self.assertEqual([c for c in m.calls if c[0] == 'close'], [('close', 0)])
        self.assertEqual(len([c for c in m.calls if c == ('read', file)]), 2)

    def test_existing_output_refuses_without_open_overwrite_or_original_mutation(self):
        m = Memory()
        file = BUILD + '/outer-second-seal-request.json'
        m.put(file, b'original retained request')
        before = dict(m.files)
        with self.assertRaises(RuntimeError):
            m.prepare()
        self.assertEqual(m.files, before)
        self.assertFalse(any(c[0] in ('open', 'write', 'close') for c in m.calls))
        self.assertFalse(m.unknown())

    def test_inconsistent_originals_and_outside_home_refuse_before_output(self):
        m = Memory()
        m.put(BUILD + '/records-c/package.json', {'name': 'embedded-linux-diagnostic-hub', 'version': m.actor.B})
        with self.assertRaises(RuntimeError):
            m.prepare()
        self.assertNotIn(BUILD + '/outer-second-seal-request.json', m.files)
        self.assertFalse(any(c[0] == 'open' for c in m.calls))
        m = Memory()
        with self.assertRaises(RuntimeError):
            m.helper_ns['prepare_request'](m.actor, SOURCE, '/foreign/build', HOME, UID, COMMIT)
        self.assertEqual(m.calls, [])

    def test_partial_positive_write_advances_only_acknowledged_bytes_but_zero_freezes(self):
        m = Memory()
        m.first_write = 7
        result = m.prepare()
        self.assertEqual(m.actor.STATE['returned'][0]['returned'][:2], [7, result['bytes'] - 7])
        self.assertEqual(len([c for c in m.calls if c[0] == 'write']), 2)
        m = Memory()
        m.bad_count = True
        with self.assertRaises(RuntimeError):
            m.prepare()
        owner = m.actor.STATE['returned'][0]
        self.assertEqual((owner['pending'], owner['returned']), ('write', [0]))
        self.assertTrue(m.unknown())
        self.assertEqual(len([c for c in m.calls if c[0] == 'write']), 1)
        self.assertFalse(any(c[0] == 'close' for c in m.calls))

    def test_raw_open_sync_close_failures_retain_original_fd_and_never_retry(self):
        for phase in ('open', 'write', 'sync', 'close'):
            m = Memory()
            raw = SystemExit(None)
            setattr(m, phase + '_error', raw)
            with self.subTest(phase=phase), self.assertRaises(SystemExit) as caught:
                m.prepare()
            self.assertIs(caught.exception, raw)
            self.assertIs(m.actor.STATE['first'], raw)
            self.assertTrue(m.actor.STATE['first_set'])
            self.assertTrue(m.unknown())
            self.assertEqual(len([c for c in m.calls if c[0] == phase]), 1)
            if phase == 'open':
                self.assertFalse(m.actor.STATE['opens'][-1]['returned'])
            else:
                self.assertIn(0, m.actor.STATE['fds'])
            if phase == 'close':
                self.assertTrue(m.actor.STATE['opens'][-1]['close_issued'])
                self.assertFalse(m.actor.STATE['opens'][-1]['closed'])

    def test_changed_source_after_write_retains_complete_file_without_publishing_hash(self):
        m = Memory()
        m.change_head = True
        with self.assertRaises(RuntimeError):
            m.prepare()
        owner = m.actor.STATE['returned'][0]
        self.assertIsNone(owner['result'])
        self.assertIn(BUILD + '/outer-second-seal-request.json', m.files)
        self.assertIn(0, m.actor.STATE['fds'])
        self.assertTrue(m.unknown())
        self.assertFalse(any(c[0] == 'close' for c in m.calls))


if __name__ == '__main__':
    unittest.main()
