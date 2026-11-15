"""Closed fake-port controls; no real package query, hooks, native action or deletion."""
import ast
import copy
import hashlib
import json
import os
import pathlib
import re
import stat
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/linux-ubuntu-provisioning-assessment.py'
TREE = ast.parse(SOURCE.read_bytes(), filename=str(SOURCE))
DATA = json.loads((ROOT / 'scripts/linux-ubuntu-x11-audited-metadata.json').read_bytes())
NS = {'hashlib': hashlib, 'json': json, 'os': os, 'pathlib': pathlib, 're': re, 'stat': stat}
selected = [n for n in TREE.body if isinstance(n, ast.Assign) or
            isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in
            ('Refused', 'need', 'dependencies', 'package_rows', 'hook_rows',
             'dpkg_config_rows', 'trigger_rows', 'encoded', 'custody_closed', 'Host', 'assess')]
exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), NS)


def line(name, version='99:999.0', state='ii ', pending='', awaited=''):
    return ('\t'.join((name + ':amd64', version, state, pending, awaited)) + '\n').encode()


class StopPopen(BaseException):
    pass


class Controls(unittest.TestCase):
    def test_01_exact_authenticated_static_input(self):
        raw = (ROOT / 'scripts/linux-ubuntu-x11-audited-metadata.json').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), NS['INPUT_SHA'])
        self.assertEqual(len(NS['dependencies'](DATA)), 23)
        self.assertEqual(len(DATA['files']), 45)
        bad = copy.deepcopy(DATA); bad['package']['sha256'] = '0' * 64
        with self.assertRaises(NS['Refused']): NS['dependencies'](bad)

    def test_02_dependency_grammar_and_uniqueness(self):
        for value in ('libx11-6;private', 'libx11-6 | other', 'libx11-6 (>= 1)\nsecret'):
            bad = copy.deepcopy(DATA); bad['depends'][0] = value
            with self.assertRaises(NS['Refused']): NS['dependencies'](bad)
        bad = copy.deepcopy(DATA); bad['depends'][0] = bad['depends'][1]
        with self.assertRaises(NS['Refused']): NS['dependencies'](bad)

    def test_03_installed_versions_status_and_pending(self):
        r = NS['package_rows'](line('libc6', '2.39-0ubuntu8.6') + line('menu', state='hi ', pending='menu'),
                               b'', 0, ['libc6', 'menu'])
        self.assertEqual(r['libc6']['version'], '2.39-0ubuntu8.6')
        self.assertEqual(r['menu']['state'], 'held-installed')
        self.assertTrue(r['menu']['pending'])

    def test_04_missing_is_only_admitted_from_exact_query_outcome(self):
        r = NS['package_rows'](line('libc6'), b'dpkg-query: no packages found matching menu:amd64\n',
                               1, ['libc6', 'menu'])
        self.assertNotIn('menu', r)
        for status, error in ((0, b''), (2, b'private-error'), (1, b'database inaccessible')):
            with self.assertRaises(NS['Refused']): NS['package_rows'](line('libc6'), error, status, ['libc6', 'menu'])

    def test_05_foreign_duplicate_or_injected_query_fields_refused(self):
        for raw in (line('foreign'), line('libc6') * 2, line('libc6', '1/secret'), line('libc6', '-i'), b'libc6\t1\tii \n'):
            with self.assertRaises(NS['Refused']): NS['package_rows'](raw, b'', 0, ['libc6'])

    def test_06_hook_counts_are_scoped_and_values_never_returned(self):
        raw = (b'DPkg::Post-Invoke::\tprivate-endpoint needrestart\n'
               b'APT::Install::Pre-Invoke::\tprivate-token update-menus\n')
        counts, refs, digest = NS['hook_rows'](raw)
        self.assertEqual((counts[1], counts[3]), (1, 1))
        self.assertEqual((refs['needrestart'], refs['update-menus']), (1, 1))
        self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
        self.assertNotIn('private', repr((counts, refs, digest)))

    def test_07_unknown_hook_roots_or_malformed_frames_refused(self):
        for raw in (b'Acquire::Proxy\tprivate-secret\n', b'DPkg::Post-Invoke:: secret\n',
                    b'DPkg::Post-Invoke::\tcommand\nprivate-line\n'):
            with self.assertRaises(NS['Refused']): NS['hook_rows'](raw)
        self.assertEqual(NS['hook_rows'](b'')[0], [0] * 8)

    def test_08_dpkg_native_hooks_filters_and_other_options_separate(self):
        raw = b'# ignored\npre-invoke=private\npost-invoke private\npath-exclude=/private\nforce-confold\n'
        r = NS['dpkg_config_rows'](raw)
        self.assertEqual(r, {'pre': 1, 'post': 1, 'filters': 1, 'other': 1})
        self.assertNotIn('private', repr(r))

    def test_09_trigger_interests_match_only_selected_payload(self):
        r = NS['trigger_rows'](b'/usr/share/man man-db/noawait\n/unrelated private-package\n/usr/share/menu menu\n',
                               ['/usr/share/man/man1/xdpyinfo.1.gz', '/usr/share/menu/x11-utils'])
        self.assertEqual(r, {'man-db': 1, 'menu': 1, 'other': 0})
        r = NS['trigger_rows'](b'/usr/share/man private-package\n', ['/usr/share/man/man1/xdpyinfo.1.gz'])
        self.assertEqual(r['other'], 1)
        self.assertNotIn('private', repr(r))

    def test_10_query_command_has_no_pager_and_fixed_database(self):
        argv = self.capture('query', names=['libc6'])
        self.assertEqual(argv[0], '/usr/bin/dpkg-query')
        self.assertIn('--no-pager', argv)
        self.assertIn('--admindir=/var/lib/dpkg', argv)
        self.assertEqual(argv[-1], 'libc6:amd64')

    def test_11_compare_command_is_data_only_fixed_relation(self):
        self.assertEqual(self.capture('compare', comparison=('2.39', 'ge', '2.38')),
                         ['/usr/bin/dpkg', '--compare-versions', '2.39', 'ge', '2.38'])

    def test_12_hook_command_has_only_literal_subtrees(self):
        argv = self.capture('hooks')
        self.assertEqual(argv, ['/usr/bin/apt-config', '--no-empty', '--format', '%F%N%V%n', 'dump', *NS['HOOKS']])

    def test_13_no_arbitrary_role_command_or_relation(self):
        for role, kwargs in (('install', {}), ('query', {'names': ['libc6;sh']}),
                              ('compare', {'comparison': ('1', 'install', '0')}),
                              ('compare', {'comparison': ('--list', 'ge', '0')})):
            with self.assertRaises(NS['Refused']): self.capture(role, **kwargs)

    def capture(self, role, **kwargs):
        got = []
        def popen(argv, **opts):
            self.assertTrue(opts['close_fds'])
            self.assertNotIn('shell', opts)
            got.append(argv)
            raise StopPopen()
        old = NS.get('subprocess')
        NS['subprocess'] = types.SimpleNamespace(Popen=popen, DEVNULL=-3, PIPE=-1)
        fake = types.SimpleNamespace(gate=lambda: None, children=[], env={})
        try:
            with self.assertRaises(StopPopen): NS['Host'].run(fake, role, **kwargs)
        finally:
            if old is None: NS.pop('subprocess', None)
            else: NS['subprocess'] = old
        self.assertEqual(len(got), 1)
        return got[0]

    def test_14_actual_orchestration_uses_only_closed_ports(self):
        names = [r[0] for r in NS['dependencies'](DATA)] + ['x11-utils', 'menu', 'man-db', 'apt', 'dpkg']
        rows = b''.join(line(n) for n in names if n not in ('x11-utils', 'menu'))
        err = b''.join(('dpkg-query: no packages found matching ' + n + ':amd64\n').encode() for n in ('x11-utils', 'menu'))
        events = []
        def run(role, **kwargs):
            events.append(role)
            if role == 'query': return rows, err, 1
            if role == 'compare': return b'', b'', 0
            if role == 'hooks': return b'DPkg::Post-Invoke::\tprivate needrestart\n', b'', 0
            raise AssertionError(role)
        fixed = {'/etc/dpkg/dpkg.cfg': b'# empty\n', '/var/lib/dpkg/triggers/File': b'/usr/share/man man-db/noawait\n',
                 '/var/lib/dpkg/triggers/Unincorp': b''}
        fake = types.SimpleNamespace(run=run, read=lambda p, cap, missing=False: fixed[p], fds=[], children=[])
        def absent(p): raise FileNotFoundError()
        old = NS['os']; NS['os'] = types.SimpleNamespace(lstat=absent, listdir=lambda p: [], path=types.SimpleNamespace(realpath=lambda p: p))
        report = dict.fromkeys(NS['FIELDS'], 'not-checked')
        try: NS['assess'](fake, DATA, report)
        finally: NS['os'] = old
        self.assertEqual(report['result'], 'read-only-assessment-complete')
        self.assertEqual(report['dependencies'], '23-of-23')
        self.assertIn('absent45', report['files'])
        self.assertEqual(report['simulation'], 'not-run-hook-execution-boundary')
        self.assertEqual(set(events), {'query', 'compare', 'hooks'})
        self.assertNotIn('private', repr(report))
        encoded = NS['encoded'](report)
        self.assertIn(b'versions0=libc6=99:999.0:satisfied', encoded)
        self.assertNotIn(b'private', encoded)
        self.assertLessEqual(len(encoded), 6144)

    def test_15_failures_never_relabelled_complete(self):
        def fail(*a, **kw): raise NS['Refused']('query')
        report = {}
        with self.assertRaises(NS['Refused']): NS['assess'](types.SimpleNamespace(run=fail), DATA, report)
        self.assertNotIn('result', report)

    def test_16_static_no_install_simulation_network_or_target_authority(self):
        imports = {a.name for n in TREE.body if isinstance(n, ast.Import) for a in n.names}
        self.assertFalse(imports & {'urllib', 'socket', 'pty', 'ctypes'})
        strings = {n.value for n in ast.walk(TREE) if isinstance(n, ast.Constant) and type(n.value) is str}
        self.assertFalse(strings & {'/usr/bin/apt-get', '/usr/bin/sudo', '--install', '--simulate', '--fsys-tarfile'})
        calls = {n.func.attr for n in ast.walk(TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertFalse(calls & {'system', 'kill', 'chmod', 'chown', 'unlink', 'remove', 'rmdir', 'mkdir', 'connect', 'extractall'})

    def test_17_encoder_rejects_extra_fields_newlines_or_raw_paths(self):
        r = dict.fromkeys(NS['FIELDS'], 'not-checked');r.update(result='incomplete', stage='hooks')
        self.assertIn(b'result=incomplete\n', NS['encoded'](r))
        for value in ('private\nsecret=value', '/private/endpoint', 'x' * 481):
            bad = dict(r);bad['hookrefs'] = value
            with self.assertRaises(NS['Refused']): NS['encoded'](bad)
        r['private'] = 'secret'
        with self.assertRaises(NS['Refused']): NS['encoded'](r)

    def test_18_issued_content_read_error_stops_before_hooks_and_retains_owner(self):
        names = [r[0] for r in NS['dependencies'](DATA)] + ['x11-utils', 'menu', 'man-db', 'apt', 'dpkg']
        events, owners = [], []
        def run(role, **kw):
            events.append(role)
            if role == 'query': return b''.join(line(n) for n in names), b'', 0
            if role == 'compare': return b'', b'', 0
            raise AssertionError('later command must not execute')
        primary = OSError('private-read-error')
        def read(*a, **kw):
            owners.append({'closed': False, 'fd': 'fake-owned'})
            raise primary
        row = next(r for r in DATA['files'] if r['path'].startswith('usr/bin/'))
        def metadata(p):
            if p != '/' + row['path']: raise FileNotFoundError()
            return types.SimpleNamespace(st_mode=stat.S_IFREG | int(row['mode'], 8),
                st_uid=0, st_nlink=1, st_size=row['bytes'])
        fake = types.SimpleNamespace(run=run, read=read, fds=owners, children=[])
        old = NS['os'];NS['os'] = types.SimpleNamespace(lstat=metadata, path=types.SimpleNamespace(realpath=lambda p: p))
        report = dict.fromkeys(NS['FIELDS'], 'not-checked')
        try:
            with self.assertRaises(OSError) as caught: NS['assess'](fake, DATA, report)
        finally: NS['os'] = old
        self.assertNotIn('hooks', events)
        self.assertIs(caught.exception, primary)
        self.assertNotEqual(report['result'], 'read-only-assessment-complete')
        self.assertFalse(NS['custody_closed'](fake))


if __name__ == '__main__':
    unittest.main()
