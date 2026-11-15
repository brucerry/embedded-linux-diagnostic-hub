"""Literal memory-only controls; no host/package/trigger/cleanup invocation."""
import ast
import copy
import hashlib
import json
import pathlib
import re
import stat
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/linux-ubuntu-provisioning-metadata.py'
TREE = ast.parse(SOURCE.read_bytes(), filename=str(SOURCE))
DATA = json.loads((ROOT / 'scripts/linux-ubuntu-provisioning-manifest.json').read_bytes())
NS = {'hashlib': hashlib, 'json': json, 'pathlib': pathlib, 're': re, 'stat': stat, 'types': types}
selected = [n for n in TREE.body if isinstance(n, ast.Assign) or
            isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name != 'main']
exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), NS)


def info(mode, size=0, uid=0, links=1, inode=17):
    return types.SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=0, st_nlink=links,
        st_ino=inode, st_dev=1, st_size=size, st_mtime_ns=10, st_ctime_ns=10)


class Memory:
    def __init__(self):
        self.fds, self.events, self.links, self.overrides = [], [], {}, {}
        self.contents = {
            '/var/lib/dpkg/status': b'\n'.join(
                ('Package: ' + n + '\nStatus: install ok installed\nArchitecture: amd64\nVersion: 2:999.0\n').encode()
                for n in DATA['observedPackages'] if n not in
                ('x11-utils', 'libxcb-shape0', 'libxv1', 'libxxf86dga1')),
            '/etc/dpkg/dpkg.cfg': b'log=/var/log/dpkg.log\n',
            '/var/lib/dpkg/triggers/Unincorp': b'',
            '/var/lib/dpkg/triggers/ldconfig': b'libc-bin\n',
            '/var/lib/dpkg/triggers/File': b'/usr/share/man man-db/noawait\n/usr/lib/x86_64-linux-gnu libc-bin/noawait\n',
        }
        for path in NS['HANDLERS'].values():
            self.contents[path] = b'private-handler-canary\n'
        fixed = set(self.contents) | {'/' + row['path'] for row in DATA['files']}
        fixed |= {'/etc/dpkg/dpkg.cfg.d/entry', '/var/lib/dpkg/updates/entry',
                  '/var/lib/dpkg/diversions', '/var/lib/dpkg/statoverride',
                  '/usr/bin/update-menus', '/usr/sbin/update-menus'}
        self.dirs = {str(p) for path in fixed for p in pathlib.PurePosixPath(path).parents}

    def lstat(self, path):
        self.events.append(('lstat', path))
        if path in self.overrides:
            return self.overrides[path]
        if path in self.links:
            return info(stat.S_IFLNK | 0o777, len(self.links[path]))
        if path in self.contents:
            return info(stat.S_IFREG | 0o644, len(self.contents[path]))
        if path in self.dirs:
            return info(stat.S_IFDIR | 0o755)
        raise FileNotFoundError()

    def read(self, path, cap):
        self.events.append(('read', path))
        value = self.contents[path]
        assert len(value) <= cap
        self.fds.append({'closed': True})
        return value

    def listdir(self, path):
        self.events.append(('listdir', path))
        assert path in ('/etc/dpkg/dpkg.cfg.d', '/var/lib/dpkg/updates')
        return []

    def realpath(self, path):
        return path

    def readlink(self, path):
        self.events.append(('readlink', path))
        return self.links[path]


def report():
    value = dict.fromkeys(NS['FIELDS'], 'not-checked')
    value.update(result='incomplete', stage='context')
    return value


class Controls(unittest.TestCase):
    def test_01_manifest_is_exactly_bound_and_complete(self):
        self.assertEqual(hashlib.sha256((ROOT / 'scripts/linux-ubuntu-provisioning-manifest.json').read_bytes()).hexdigest(), NS['INPUT_SHA'])
        self.assertEqual(len(DATA['files']), 57)
        self.assertEqual(len(set(r['path'] for r in DATA['files'])), 57)
        self.assertEqual(sum(r['kind'] == 'symlink' for r in DATA['files']), 4)
        self.assertEqual(len(DATA['observedPackages']), 27)

    def test_02_actual_orchestration_on_closed_memory_ports(self):
        port, out = Memory(), report()
        NS['assess'](port, DATA, out)
        self.assertEqual(out['result'], 'metadata-only-complete')
        self.assertEqual(out['filemap'], 'a' * 57)
        self.assertIn('absent57', out['files'])
        self.assertIn('namedLibc1-namedOther0-man1-libc1-other0', out['registrations'])
        self.assertIn('states0-triggers0-awaited0', out['pending'])
        self.assertEqual(out['custody'], 'all-recorded-read-handles-closed')
        self.assertNotIn('private-handler', repr(out))
        self.assertIn(b'result=metadata-only-complete\n', NS['encode'](out))
        self.assertTrue(all(x['closed'] for x in port.fds))

    def test_03_prior_libx11_version_is_not_misreported_absent(self):
        port, out = Memory(), report()
        port.contents['/var/lib/dpkg/status'] = port.contents['/var/lib/dpkg/status'].replace(
            b'Package: libx11-6\nStatus: install ok installed\nArchitecture: amd64\nVersion: 2:999.0',
            b'Package: libx11-6\nStatus: install ok installed\nArchitecture: amd64\nVersion: 2:1.8.7-1ubuntu0.1')
        NS['assess'](port, DATA, out)
        self.assertIn('libx11-6=2:1.8.7-1ubuntu0.1:installed', out['versions0'])

    def test_04_control_records_preserve_continuations_and_foreign_arch(self):
        raw = b'Package: libc6\nStatus: install ok installed\nVersion: 2.39\nArchitecture: arm64\nDescription: first\n second\n'
        row = NS['control_records'](raw)[0]
        self.assertEqual(row['Description'], 'first\n second')
        self.assertEqual(row['Architecture'], 'arm64')

    def test_05_malformed_empty_duplicate_or_nul_status_refused(self):
        for raw in (b'', b'Package: libc6\n', b'Package: libc6\nStatus: x\nStatus: y\n',
                    b'Package: libc6\x00\nStatus: x\n', b' continuation\n'):
            with self.assertRaises(NS['Refused']): NS['control_records'](raw)

    def test_06_unknown_status_does_not_become_complete(self):
        port, out = Memory(), report()
        port.contents['/var/lib/dpkg/status'] = port.contents['/var/lib/dpkg/status'].replace(b'install ok installed', b'install private unknown-state', 1)
        with self.assertRaises(NS['Refused']): NS['assess'](port, DATA, out)
        self.assertEqual(out['result'], 'incomplete')
        self.assertFalse(any(p == '/etc/dpkg/dpkg.cfg' for action, p in port.events))

    def test_07_all_global_pending_states_are_reported(self):
        port, out = Memory(), report()
        port.contents['/var/lib/dpkg/status'] = port.contents['/var/lib/dpkg/status'].replace(b'install ok installed', b'install ok unpacked', 1)
        port.contents['/var/lib/dpkg/status'] = port.contents['/var/lib/dpkg/status'].rstrip(b'\n') + b'\n\nPackage: unrelated\nStatus: install ok triggers-pending\nArchitecture: amd64\nVersion: 1\nTriggers-Pending: private-token\n'
        NS['assess'](port, DATA, out)
        self.assertIn('states2-triggers1-awaited0', out['pending'])
        self.assertNotIn('private-token', repr(out))

    def test_08_unsafe_parent_stops_before_target_read(self):
        port, out = Memory(), report()
        port.overrides['/usr/lib'] = info(stat.S_IFDIR | 0o777)
        with self.assertRaises(NS['Refused']): NS['assess'](port, DATA, out)
        self.assertEqual(out['stage'], 'parents')
        self.assertFalse(any(action == 'read' and p.startswith('/usr/lib/') for action, p in port.events))

    def test_09_existing_conffile_is_counted_never_read(self):
        port, out = Memory(), report()
        path = next('/' + r['path'] for r in DATA['files'] if r['path'].startswith('etc/'))
        port.contents[path] = b'private-user-conffile'
        NS['assess'](port, DATA, out)
        self.assertIn('conffile1', out['files'])
        self.assertNotIn(('read', path), port.events)
        self.assertNotIn('private-user-conffile', repr(out))

    def test_10_soname_and_cross_package_links_stay_metadata(self):
        port, out = Memory(), report()
        links = [r for r in DATA['files'] if r['kind'] == 'symlink']
        for row in links: port.links['/' + row['path']] = row['linkTarget']
        NS['assess'](port, DATA, out)
        self.assertIn('matching4', out['files'])
        self.assertFalse(any(action == 'read' and p in port.links for action, p in port.events))
        port, out = Memory(), report()
        port.links['/' + links[0]['path']] = '/private/wrong-target'
        NS['assess'](port, DATA, out)
        self.assertIn('conflict1', out['files'])
        self.assertNotIn('/private', repr(out))

    def test_11_issued_read_failure_keeps_primary_and_uncertain_custody(self):
        port, out = Memory(), report()
        primary = OSError('private-primary')
        def fail(path, cap):
            port.fds.append({'closed': False})
            raise primary
        port.read = fail
        with self.assertRaises(OSError) as caught: NS['assess'](port, DATA, out)
        self.assertIs(caught.exception, primary)
        self.assertEqual(out['result'], 'incomplete')
        self.assertFalse(port.fds[0]['closed'])
        self.assertNotIn('complete', out['stage'])

    def test_12_changed_identity_after_read_refused(self):
        port = Memory()
        read = port.read
        def changed(path, cap):
            value = read(path, cap)
            port.overrides[path] = info(stat.S_IFREG | 0o644, len(value), inode=99)
            return value
        port.read = changed
        with self.assertRaises(NS['Refused']): NS['checked_read'](port, '/var/lib/dpkg/status', 16 * 1024 ** 2)

    def test_13_hook_configuration_counts_never_publish_commands(self):
        raw = b'pre-invoke=private-command\npost-invoke private-secret\npath-exclude=/private\nforce-unsafe-io\nstatus-logger=private\nroot=/private\nunknown=private\n'
        counts = NS['configuration_counts'](raw)
        self.assertEqual(counts, dict.fromkeys(('pre', 'post', 'filters', 'force', 'logger', 'root', 'other'), 1))
        self.assertNotIn('private', repr(counts))

    def test_14_trigger_metadata_does_not_infer_handler_execution(self):
        port, out = Memory(), report()
        port.contents['/var/lib/dpkg/triggers/ldconfig'] += b'private-handler/noawait\n'
        NS['assess'](port, DATA, out)
        self.assertIn('namedOther1', out['registrations'])
        self.assertNotIn('private-handler', repr(out))
        self.assertEqual({a for a, p in port.events}, {'lstat', 'read', 'listdir'})

    def test_15_diversion_and_override_targets_are_counted_without_values(self):
        port, out = Memory(), report()
        path = '/' + DATA['files'][0]['path']
        port.contents['/var/lib/dpkg/diversions'] = (path + '\n/private/destination\nprivate-owner\n').encode()
        port.contents['/var/lib/dpkg/statoverride'] = ('private private 600 ' + path + '\n').encode()
        NS['assess'](port, DATA, out)
        self.assertTrue(out['diversions'].startswith('records1-targetmatches1-'))
        self.assertTrue(out['overrides'].startswith('records1-targetmatches1-'))
        self.assertNotIn('private', repr(out))

    def test_16_output_rejects_paths_error_strings_unknown_fields_and_objects(self):
        port, out = Memory(), report(); NS['assess'](port, DATA, out)
        for value in ('/private/path', 'private\nsecret=1', 'a' * 481, object()):
            bad = dict(out);bad['menu'] = value
            with self.assertRaises(NS['Refused']): NS['encode'](bad)
        bad = dict(out);bad['private'] = 'secret'
        with self.assertRaises(NS['Refused']): NS['encode'](bad)

    def test_17_manifest_traversal_or_wrong_cohort_refused(self):
        for change in ('traversal', 'duplicate', 'missing'):
            data = copy.deepcopy(DATA)
            if change == 'traversal': data['files'][0]['path'] = 'usr/../private'
            elif change == 'duplicate': data['files'][0] = data['files'][1]
            else: data['files'].pop()
            with self.assertRaises(NS['Refused']): NS['assess'](Memory(), data, report())

    def test_18_no_package_process_network_cleanup_or_privilege_authority(self):
        imports = {a.name for n in TREE.body if isinstance(n, ast.Import) for a in n.names}
        self.assertFalse(imports & {'subprocess', 'socket', 'urllib', 'pty', 'ctypes'})
        attrs = {n.func.attr for n in ast.walk(TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertFalse(attrs & {'run', 'Popen', 'system', 'kill', 'unlink', 'remove', 'rmdir',
                                 'chmod', 'chown', 'connect', 'extractall'})
        self.assertEqual(sum(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and
                             n.func.attr == 'open' for n in ast.walk(TREE)), 1)

    def test_19_handler_mode_and_hash_share_the_verified_snapshot(self):
        port, out = Memory(), report()
        file = NS['HANDLERS']['libcpostinst']
        original = port.lstat
        calls = []
        def replace_later(path):
            if path == file:
                calls.append(path)
                if len(calls) > 2:
                    return info(stat.S_IFREG | 0o777, 1, uid=1000, inode=99)
            return original(path)
        port.lstat = replace_later
        NS['assess'](port, DATA, out)
        self.assertEqual(len(calls), 2)
        self.assertIn('root-regular-mode644-', out['libcpostinst'])
        self.assertIn(hashlib.sha256(port.contents[file]).hexdigest(), out['libcpostinst'])

    def test_20_reader_executes_only_the_captured_pinned_bytes_without_main(self):
        raw = b"CAPTURED = 'fixed-bytes'\nif __name__ == '__main__':\n    raise AssertionError('main must remain inert')\n"
        old = NS['BASE_SHA']
        NS['BASE_SHA'] = hashlib.sha256(raw).hexdigest()
        try:
            loaded = NS['load_reader'](raw, '/inert/captured-input.py')
            self.assertEqual(loaded.CAPTURED, 'fixed-bytes')
            self.assertEqual(loaded.__file__, '/inert/captured-input.py')
            self.assertNotEqual(loaded.__name__, '__main__')
            with self.assertRaises(NS['Refused']): NS['load_reader'](raw + b'\n', '/inert/captured-input.py')
        finally:
            NS['BASE_SHA'] = old


if __name__ == '__main__':
    unittest.main()
