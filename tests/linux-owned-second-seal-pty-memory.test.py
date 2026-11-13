"""Actual outer actor definitions under closed memory ports only.

Only selected inert AST bodies execute. No actor imports, main, PTY, child,
filesystem mutation, native helper, application or lifecycle action runs.
"""
import ast
import codecs
import hashlib
import json
import pathlib
import re
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/linux-owned-second-seal-pty.py'
TREE = ast.parse(SOURCE.read_bytes(), filename=str(SOURCE))
NAMES = ('A', 'B', 'C', 'STAGES', 'TAIL', 'NOTICE', 'NODE_SHA256', 'RECORD_NAMES', 'SOURCE_NAMES', 'STATE')
FUNCTIONS = ('require', 'fail', 'expected_review', 'consent_step', 'send_consent',
             'validate_request', 'fixed_argv', 'review_binding', 'read_inputs', 'opened', 'closed', 'opened_stderr_pipe', 'final_readback')
SELECTED = []
for name in NAMES:
    matches = [node for node in TREE.body if isinstance(node, ast.Assign) and len(node.targets) == 1
               and isinstance(node.targets[0], ast.Name) and node.targets[0].id == name]
    if len(matches) != 1:
        raise AssertionError('One actual inert binding: ' + name)
    SELECTED.extend(matches)
for name in (*FUNCTIONS, 'OuterReviewProtocol'):
    matches = [node for node in TREE.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name == name]
    if len(matches) != 1:
        raise AssertionError('One actual inert definition: ' + name)
    SELECTED.extend(matches)
CODE = compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE) + '.closed-memory', 'exec')
UUID = '11111111-1111-4111-8111-111111111111'
FIXTURE = '/home/test/build/second-seal-fixture'
COMMIT = 'a' * 40


def memory():
    ns = {'codecs': codecs, 'hashlib': hashlib, 'json': json, 'pathlib': pathlib, 're': re}
    exec(CODE, ns)
    return ns


def literal(text, beginning):
    # Anchor to the one actual literal prefix; unrelated comment apostrophes
    # cannot shift a whole-file token regex off the real TypeScript strings.
    marker = "'" + beginning.replace('\\', '\\\\').replace('\n', '\\n').replace("'", "\\'")
    starts = [match.start() for match in re.finditer(re.escape(marker), text)]
    if len(starts) != 1:
        raise AssertionError('One real producer prompt literal: ' + beginning)
    token = re.match(r"'(?:\\.|[^'\\])*'", text[starts[0]:])
    if token is None:
        raise AssertionError('Complete actual producer literal required.')
    value = ast.literal_eval(token.group(0))
    if not isinstance(value, str) or not value.startswith(beginning):
        raise AssertionError('Actual producer literal prefix required.')
    return value


DRIVER = (ROOT / 'electron/linux-native-driver.ts').read_text()
CALLER = (ROOT / 'electron/linux-permanent-setup.ts').read_text()
UNINSTALL = (ROOT / 'electron/linux-initial-uninstall.ts').read_text()
PROMPTS = (ROOT / 'electron/linux-setup-prompts.ts').read_text()
COORDINATOR = (ROOT / 'scripts/linux-owned-second-seal-fixture.ts').read_text()


def actual_review(ns, stage, key=UUID, fixture=FIXTURE):
    root = fixture + '/installed'
    profile = fixture + '/config/DiagnosticHub/profiles/' + key
    if stage != 'c-uninstall':
        version = ns['B'] if stage == 'b-finalize' else ns['C']
        detail = (literal(DRIVER, 'Diagnostic Hub Linux setup\nOperation: ') + 'finalize'
                  + literal(DRIVER, '\nApplication: ') + root
                  + literal(DRIVER, '\nCandidate version: ') + version
                  + literal(DRIVER, '\nInstalled version: ') + version
                  + literal(DRIVER, '\nSettings/reports: ') + profile
                  + literal(DRIVER, '\nConfirm the current no-menu app while it is ready, then remove only the previous')
                  + literal(CALLER, '\nOwned fixture: complete the described Finalize'))
    else:
        detail = (literal(UNINSTALL, 'Diagnostic Hub Linux setup\nOperation: uninstall-current\nApplication: ') + root
                  + literal(UNINSTALL, '\nInstalled version: ') + ns['C']
                  + literal(UNINSTALL, '\nSettings/reports retained: ') + profile
                  + literal(UNINSTALL, '\nOnly this current no-menu payload is removed. ')
                  + literal(UNINSTALL, 'Its predecessor cleanup is complete and published.')
                  + literal(UNINSTALL, 'Prior recovery payloads are not removed.'))
    return '\n' + detail + literal(PROMPTS, '\nType "apply menu" or "apply no-menu"')


def ports(ns, protocol, clock):
    calls = []
    def write(fd, raw):
        calls.append((fd, raw))
        assert protocol.issued and not protocol.returned
        assert ns['STATE']['consents'][-1]['issued'] and not ns['STATE']['consents'][-1]['returned']
        return len(raw)
    ns['os'] = types.SimpleNamespace(write=write)
    return calls, lambda raw: ns['send_consent'](0, raw)


def advance(ns, protocol, step, clock, send):
    raw = actual_review(ns, ns['STAGES'][step]).replace('\n', '\r\n').encode()
    ns['consent_step'](protocol, raw, lambda: clock[0], lambda stage: UUID, send)
    ns['consent_step'](protocol, b'apply no-menu\r\n', lambda: clock[0], lambda stage: UUID, send)


class OuterTTYMemoryTests(unittest.TestCase):
    def test_actual_literal_reviews_and_fixed_node_arguments(self):
        ns = memory()
        for stage in ns['STAGES']:
            self.assertEqual(ns['expected_review'](stage, FIXTURE, UUID), actual_review(ns, stage))
        args = ns['fixed_argv']('/home/test/sdk/bin/node', '/home/test/source', '/home/test/build')
        self.assertEqual(args[:4], ['/home/test/sdk/bin/node', '--import', '/home/test/source/node_modules/tsx/dist/loader.mjs',
                                   '/home/test/source/scripts/linux-owned-second-seal-fixture.ts'])
        self.assertEqual(len(args[4:]), 14)
        self.assertEqual(args[args.index('--c-appdir') + 1], '/home/test/build/build-c/linux-unpacked')
        self.assertNotIn('--scenario', args)
        self.assertIn("runLinuxPermanentOwnedFixture(", COORDINATOR)
        self.assertIn("'normal-finalize'", COORDINATOR)

    def test_complete_serial_protocol_and_echo_are_actual_state_only(self):
        ns, clock = memory(), [1.0]
        p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
        calls, send = ports(ns, p, clock)
        for at in range(3):
            advance(ns, p, at, clock, send)
            self.assertEqual(p.stage, at + 1)
        ns['consent_step'](p, ns['NOTICE'].replace('\n', '\r\n').encode(), lambda: clock[0], lambda stage: UUID, send)
        p.finish(clock[0])
        self.assertEqual(calls, [(0, b'apply no-menu\n')] * 3)
        self.assertTrue(all(x['returned'] and x['value'] == 14 for x in ns['STATE']['consents']))

    def test_every_byte_split_waits_for_full_utf8_and_crlf_review(self):
        ns = memory()
        # A non-ASCII HOME exercises actual byte/character boundaries without filesystem access.
        fixture = '/home/測試/build-é-🙂/second-seal-fixture'
        raw = actual_review(ns, 'b-finalize', fixture=fixture).replace('\n', '\r\n').encode()
        for at in range(len(raw) + 1):
            p = ns['OuterReviewProtocol'](fixture, 0, 540)
            calls = []
            send = lambda value: (calls.append(value), len(value))[1]
            ns['consent_step'](p, raw[:at], lambda: 1, lambda stage: UUID, send)
            self.assertEqual(len(calls), int(at == len(raw)))
            ns['consent_step'](p, raw[at:], lambda: 1, lambda stage: UUID, send)
            self.assertEqual(calls, [b'apply no-menu\n'])
        for bad in (b'\xff', raw + b'\xe2\x82\xac', raw + raw, b'prefix' + raw):
            p = ns['OuterReviewProtocol'](fixture, 0, 540)
            calls = []
            with self.assertRaises((RuntimeError, UnicodeDecodeError)):
                ns['consent_step'](p, bad, lambda: 1, lambda stage: UUID, lambda value: calls.append(value))
            self.assertEqual(calls, [])
            self.assertTrue(p.frozen)

    def test_changed_or_misordered_review_identity_never_writes(self):
        ns = memory()
        base = actual_review(ns, 'b-finalize')
        for text in (actual_review(ns, 'c-finalize'), actual_review(ns, 'c-uninstall'),
                     base.replace('Application: ' + FIXTURE, 'Application: /foreign'),
                     base.replace(UUID, '22222222-2222-4222-8222-222222222222'),
                     base.replace('Candidate version: ' + ns['B'], 'Candidate version: 0.5.0'),
                     base.replace('complete the described Finalize', 'pause the described Finalize')):
            p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
            writes = []
            with self.assertRaises(RuntimeError):
                ns['consent_step'](p, text.encode(), lambda: 1, lambda stage: UUID, lambda raw: writes.append(raw))
            self.assertEqual(writes, [])
            with self.assertRaises(RuntimeError):
                ns['consent_step'](p, base.encode(), lambda: 1, lambda stage: UUID, lambda raw: writes.append(raw))
            self.assertEqual(writes, [])

    def test_partial_throwing_and_late_write_keep_actual_issued_return(self):
        ns = memory()
        raw = actual_review(ns, 'b-finalize').encode()
        for count in (0, 13, True):
            p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
            seen = []
            ns['os'] = types.SimpleNamespace(write=lambda fd, value: (seen.append(value), count)[1])
            with self.assertRaises(RuntimeError):
                ns['consent_step'](p, raw, lambda: 1, lambda stage: UUID, lambda value: ns['send_consent'](0, value))
            self.assertEqual(seen, [b'apply no-menu\n'])
            self.assertEqual(p.counts, [count])
            self.assertTrue(p.frozen and p.issued and p.returned)
            self.assertEqual(ns['STATE']['consents'][-1]['value'], count)
        p, clock = ns['OuterReviewProtocol'](FIXTURE, 0, 540), [1]
        def late(fd, value):
            clock[0] = 540
            return 14
        ns['os'] = types.SimpleNamespace(write=late)
        with self.assertRaises(RuntimeError):
            ns['consent_step'](p, raw, lambda: clock[0], lambda stage: UUID, lambda value: ns['send_consent'](0, value))
        self.assertEqual(p.counts, [14])
        self.assertTrue(ns['STATE']['consents'][-1]['returned'])
        error = SystemExit(None)
        ns['os'] = types.SimpleNamespace(write=lambda fd, value: (_ for _ in ()).throw(error))
        p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
        with self.assertRaises(SystemExit) as caught:
            ns['consent_step'](p, raw, lambda: 1, lambda stage: UUID, lambda value: ns['send_consent'](0, value))
        self.assertIs(caught.exception, error)
        self.assertIs(ns['STATE']['consents'][-1]['error'], error)
        self.assertFalse(ns['STATE']['consents'][-1]['returned'])

    def test_echo_completion_and_original_deadline_cannot_be_faked(self):
        ns, clock = memory(), [1]
        for echo in (b'apply menu\r\n', b'apply no-menu\rX', b'apply no-menu\r\napply no-menu\r\n'):
            p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
            calls, send = ports(ns, p, clock)
            ns['consent_step'](p, actual_review(ns, 'b-finalize').encode(), lambda: 1, lambda stage: UUID, send)
            with self.assertRaises(RuntimeError):
                ns['consent_step'](p, echo, lambda: 1, lambda stage: UUID, send)
            self.assertEqual(len(calls), 1)
        p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
        calls, send = ports(ns, p, clock)
        for at in range(3):
            advance(ns, p, at, clock, send)
        with self.assertRaises(RuntimeError):
            p.finish(1)  # Three replies/echoes alone are not a coordinator completion.
        for now in (540, -1, float('nan'), float('inf')):
            p = ns['OuterReviewProtocol'](FIXTURE, 0, 540)
            writes = []
            with self.assertRaises(RuntimeError):
                ns['consent_step'](p, actual_review(ns, 'b-finalize').encode(), lambda: now,
                                   lambda stage: UUID, lambda raw: writes.append(raw))
            self.assertEqual(writes, [])
        ns['fail'](None)
        second = RuntimeError('memory-secondary')
        ns['fail'](second)
        self.assertTrue(ns['STATE']['first_set'])
        self.assertIsNone(ns['STATE']['first'])
        self.assertEqual(ns['STATE']['secondary'], [second])
        for late in ('none', 'revalidation', 'read'):
            p, clock, calls = ns['OuterReviewProtocol'](FIXTURE, 0, 540), [1], []
            p.stage, p.complete, p.counts = 3, True, [14, 14, 14]
            raw = json.dumps({'scenario': 'owned-b-to-c-normal-finalize-and-current-removal',
                             'sourceCommit': COMMIT, 'runId': '123', 'runAttempt': '1', 'releaseAcceptance': False}).encode()
            returned = {'raw': raw, 'sha256': hashlib.sha256(raw).hexdigest()}
            def original(stage):
                calls.append(stage)
                if late == 'revalidation':
                    clock[0] = 540
            def read(file, cap, uid):
                calls.append(file)
                self.assertEqual((file, cap, uid), (FIXTURE + '/records/second-seal-uninstall.json', 16 * 1024 ** 2, 1000))
                if late == 'read':
                    clock[0] = 540
                return returned
            prior_returns = len(ns['STATE']['returned'])
            if late == 'none':
                self.assertIs(ns['final_readback'](p, lambda: clock[0], original, read, FIXTURE, 1000, COMMIT, '123'), returned)
            else:
                with self.assertRaises(RuntimeError):
                    ns['final_readback'](p, lambda: clock[0], original, read, FIXTURE, 1000, COMMIT, '123')
            self.assertEqual(p.deadline, 540)
            if late == 'revalidation':
                self.assertEqual(calls, ['c-uninstall'])
                self.assertEqual(len(ns['STATE']['returned']), prior_returns)
            else:
                self.assertIs(ns['STATE']['returned'][-1], returned)

    def test_request_scope_has_no_arbitrary_command_or_record_slots(self):
        ns = memory()
        value = {'schema': 1, 'sourceCommit': COMMIT, 'buildRoot': '/home/test/build',
                 'loaderSHA256': 'b' * 64, 'sourceSHA256': {n: 'c' * 64 for n in ns['SOURCE_NAMES']},
                 'recordsSHA256': {r: {n: 'd' * 64 for n in ns['RECORD_NAMES']} for r in ('a', 'b', 'c')}}
        self.assertEqual(ns['validate_request'](value, '/home/test', COMMIT), '/home/test/build')
        for key, changed in (('command', '/bin/sh'), ('schema', True), ('buildRoot', '/foreign/build'),
                             ('sourceCommit', 'f' * 40), ('loaderSHA256', 'x'), ('recordsSHA256', {})):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                ns['validate_request']({**value, key: changed}, '/home/test', COMMIT)
        bad = {**value, 'sourceSHA256': {**value['sourceSHA256'], '/arbitrary': 'e' * 64}}
        with self.assertRaises(RuntimeError):
            ns['validate_request'](bad, '/home/test', COMMIT)

    def test_actual_original_record_binding_pins_identity_and_version(self):
        ns = memory()
        manifest = {'version': ns['C'], 'sourceCommit': COMMIT}
        raw = json.dumps(manifest).encode()
        values = {'manifest': manifest, 'installation': {'installationId': UUID, 'profile': 'dedicated',
                  'manifestSHA256': hashlib.sha256(raw).hexdigest()},
                  'journal': {'root': FIXTURE + '/installed', 'uid': 1000, 'installationId': UUID,
                              'profile': FIXTURE + '/config/DiagnosticHub/profiles/' + UUID, 'phase': 'candidate-active'}}
        files = {}
        for name, value in values.items():
            data = raw if name == 'manifest' else json.dumps(value).encode()
            files[FIXTURE + '/records/updated-c-' + name + '.json'] = {'raw': data, 'sha256': hashlib.sha256(data).hexdigest(), 'identity': ('memory', name)}
        ns['observed'] = lambda file, cap, uid: dict(files[file])
        pinned = {}
        self.assertEqual(ns['review_binding']('c-finalize', FIXTURE, COMMIT, 1000, pinned), UUID)
        self.assertEqual(ns['review_binding']('c-uninstall', FIXTURE, COMMIT, 1000, pinned), UUID)
        key = FIXTURE + '/records/updated-c-journal.json'
        files[key] = {**files[key], 'identity': ('foreign', 'same-bytes')}
        with self.assertRaises(RuntimeError):
            ns['review_binding']('c-uninstall', FIXTURE, COMMIT, 1000, pinned)

    def test_actual_fixed_abc_input_record_join_refuses_mismatched_descriptor(self):
        ns = memory()
        source, build = '/home/test/source', '/home/test/build'
        files, stats = {}, {}
        def put(file, value):
            raw = json.dumps(value).encode() if isinstance(value, dict) else value
            files[file] = {'raw': raw, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'identity': ('memory', file)}
            return files[file]
        for name in ns['SOURCE_NAMES']:
            put(source + '/' + name, b'closed source bytes')
        put(source + '/node_modules/tsx/dist/loader.mjs', b'closed loader bytes')
        request = {'sourceCommit': COMMIT, 'buildRoot': build,
                   'sourceSHA256': {n: files[source + '/' + n]['sha256'] for n in ns['SOURCE_NAMES']},
                   'loaderSHA256': files[source + '/node_modules/tsx/dist/loader.mjs']['sha256'], 'recordsSHA256': {}}
        for at, (role, version) in enumerate((('a', ns['A']), ('b', ns['B']), ('c', ns['C']))):
            archive = build + '/build-' + role + '/Diagnostic-Hub-linux-x64.tar.gz'
            original = put(archive, b'archive data as closed memory')
            info = types.SimpleNamespace(st_dev=1, st_ino=10 + at, st_uid=1000, st_mode=0o100600, st_nlink=1, st_size=original['bytes'])
            stats[archive] = info
            directory = build + '/records-' + role
            descriptor = put(directory + '/descriptor.json', {'version': version, 'sourceCommit': COMMIT})
            records = {'package.json': {'name': 'embedded-linux-diagnostic-hub', 'version': version},
                       'capability.json': {'version': version},
                       'census.json': {'compressedBytes': original['bytes'], 'compressedSHA256': original['sha256']},
                       'preparation.json': {'status': 'prepared-install-envelope', 'root': build + '/envelope-' + role, 'descriptorSHA256': descriptor['sha256']},
                       'inputs.json': {'sourceCommit': COMMIT, 'role': role, 'version': version,
                           'sourceRoot': build + '/build-' + role + '/linux-unpacked', 'envelopeRoot': build + '/envelope-' + role,
                           'descriptorSHA256': descriptor['sha256'],
                           'archive': {'path': archive, 'bytes': original['bytes'], 'sha256': original['sha256'],
                                       'identity': {k: getattr(info, v) for k, v in (('dev', 'st_dev'), ('ino', 'st_ino'), ('uid', 'st_uid'), ('mode', 'st_mode'), ('nlink', 'st_nlink'), ('size', 'st_size'))}}}}
            for name, value in records.items():
                put(directory + '/' + name, value)
            request['recordsSHA256'][role] = {name: files[directory + '/' + name]['sha256'] for name in ns['RECORD_NAMES']}
        def observed(file, cap, uid, retain=True):
            value = dict(files[file])
            assert value['bytes'] <= cap and uid == 1000
            if not retain:
                value['raw'] = None
            return value
        ns.update(observed=observed, parents=lambda directory, uid: None, os=types.SimpleNamespace(lstat=lambda file: stats[file]))
        captured = ns['read_inputs'](request, source, 1000)
        self.assertEqual(len(captured), len(ns['SOURCE_NAMES']) + 1 + 18 + 3)
        file = build + '/records-c/preparation.json'
        changed = json.loads(files[file]['raw'])
        changed['descriptorSHA256'] = '0' * 64
        put(file, changed)
        # Even an expected record hash cannot turn inconsistent data into a valid join.
        request['recordsSHA256']['c']['preparation.json'] = files[file]['sha256']
        with self.assertRaises(RuntimeError):
            ns['read_inputs'](request, source, 1000)

    def test_fd_zero_and_unknown_close_pipe_returns_are_retained_once(self):
        ns = memory()
        calls = []
        def open_file(file, flags, mode):
            self.assertTrue(ns['STATE']['opens'][-1]['issued'])
            self.assertFalse(ns['STATE']['opens'][-1]['returned'])
            return 0
        ns['os'] = types.SimpleNamespace(O_CLOEXEC=1, O_NONBLOCK=2, open=open_file, close=lambda fd: calls.append(fd))
        owner = ns['opened']('/memory/one', 4)
        self.assertIn(0, ns['STATE']['fds'])
        ns['closed'](owner)
        self.assertEqual(calls, [0])
        self.assertNotIn(0, ns['STATE']['fds'])
        with self.assertRaises(RuntimeError):
            ns['closed'](owner)
        error = SystemExit(None)
        owner = ns['opened']('/memory/two', 4)
        ns['os'].close = lambda fd: (_ for _ in ()).throw(error)
        with self.assertRaises(SystemExit) as caught:
            ns['closed'](owner)
        self.assertIs(caught.exception, error)
        self.assertTrue(owner['close_issued'])
        self.assertFalse(owner['closed'])
        self.assertIn(0, ns['STATE']['fds'])
        def pipe(flags):
            self.assertEqual(flags, ns['os'].O_CLOEXEC)
            self.assertTrue(all(o['issued'] and not o['returned'] for o in ns['STATE']['opens'][-2:]))
            return 10, 11
        ns['os'].pipe2 = pipe
        modes = []
        def mode(fd, blocking):
            self.assertTrue({10, 11} <= ns['STATE']['fds'])
            self.assertTrue(all(o['returned'] for o in ns['STATE']['opens'][-2:]))
            modes.append((fd, blocking))
        ns['os'].set_blocking = mode
        readers = ns['opened_stderr_pipe']()
        self.assertEqual([o['fd'] for o in readers], [10, 11])
        self.assertTrue({10, 11} <= ns['STATE']['fds'])
        self.assertEqual(modes, [(10, False)])
        ns['os'].pipe2 = lambda flags: (12, 13)
        def failed_mode(fd, blocking):
            self.assertEqual((fd, blocking), (12, False))
            self.assertTrue({12, 13} <= ns['STATE']['fds'])
            raise error
        ns['os'].set_blocking = failed_mode
        with self.assertRaises(SystemExit) as caught:
            ns['opened_stderr_pipe']()
        self.assertIs(caught.exception, error)
        self.assertEqual([o['fd'] for o in ns['STATE']['opens'][-2:]], [12, 13])
        self.assertTrue(all(o['returned'] and not o['closed'] for o in ns['STATE']['opens'][-2:]))

    def test_main_is_excluded_and_contains_no_kill_cleanup_or_terminal_reconfiguration(self):
        self.assertFalse(any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in SELECTED))
        self.assertFalse(any(isinstance(node, ast.FunctionDef) and node.name == 'main' for node in SELECTED))
        calls = {node.func.attr for node in ast.walk(TREE) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(calls & {'kill', 'killpg', 'tcsetattr', 'unlink', 'rmdir', 'system', 'Popen', 'spawn'})
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and
                             isinstance(node.func.value, ast.Name) and node.func.value.id == 'os' and
                             node.func.attr == 'remove' for node in ast.walk(TREE)))
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        execs = [node for node in ast.walk(main) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'execve']
        self.assertEqual(len(execs), 1)
        self.assertEqual(ast.unparse(execs[0].args[0]), 'node')
        self.assertEqual(ast.unparse(execs[0].args[1]), 'argv')


if __name__ == '__main__':
    unittest.main()
