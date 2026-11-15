"""Literal fake-port cohort. No native/OS fixture, discovery, deletion or subprocess."""
import ast
import os
import pathlib
import signal
import stat
import sys
import time
import re
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/linux-ubuntu-native-metadata.py'
TREE = ast.parse(SOURCE.read_bytes(), filename=str(SOURCE))
NS = {'os': os, 'pathlib': pathlib, 're': re, 'signal': signal, 'stat': stat,
      'sys': sys, 'time': time}
SELECT = {'Refusal', 'require', 'attributes', 'observed', 'checked', 'parents', 'probe', 'encoded', 'publish'}
NODES = [n for n in TREE.body if isinstance(n, ast.Assign) or
         isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in SELECT]
exec(compile(ast.Module(body=NODES, type_ignores=[]), str(SOURCE), 'exec'), NS)


def info(kind=stat.S_IFDIR, uid=0, mode=0o755, ino=9, dev=1, nlink=1, size=1024):
    return types.SimpleNamespace(st_mode=kind | mode, st_uid=uid, st_ino=ino,
                                 st_dev=dev, st_nlink=nlink, st_size=size)


class Fake:
    platform, machine = 'linux', 'x86_64'
    python, pidfd_api, sigchld_default = '/usr/bin/python3.12', True, True

    def __init__(self):
        self.env = {'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
            'RUNNER_ENVIRONMENT': 'github-hosted', 'GITHUB_REF': NS['BRANCH'],
            'GITHUB_REPOSITORY': 'brucerry/embedded-linux-diagnostic-hub',
            'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_EVENT_NAME': 'push',
            'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKFLOW_SHA': 'a' * 40,
            'GITHUB_RUN_ID': '12345', 'HOME': '/home/runner',
            'GITHUB_WORKSPACE': '/home/runner/work/hub/hub'}
        self.files = {p: info() for p in ('/', '/home', '/home/runner/work',
                     '/home/runner/work/hub', '/usr', '/usr/bin')}
        self.files.update({p: info(uid=1000) for p in ('/home/runner', '/home/runner/work/hub/hub')})
        self.files.update({p: info(stat.S_IFREG) for p in
                          ('/usr/bin/Xvfb', '/usr/bin/xauth', '/usr/bin/xdpyinfo', self.python)})
        self.events, self.aliases, self.failures = [], {}, {}
        self.tick, self.after = 0.0, None
        self.real_uid = self.effective_uid = 1000
        self.device, self.accessible, self.mounted, self.attached = True, True, True, False

    def now(self):
        return self.tick

    def uid(self):
        return self.real_uid

    def euid(self):
        return self.effective_uid

    def lstat(self, p):
        self.events.append(p)
        if self.after:
            self.after(p)
        if p in self.failures:
            raise self.failures[p]
        if p not in self.files:
            raise FileNotFoundError()
        return self.files[p]

    def realpath(self, p):
        return self.aliases.get(p, '/dev/pts/ptmx' if p == '/dev/ptmx' else p)

    def stat(self, p):
        assert p == '/dev/ptmx'
        return info(stat.S_IFCHR if self.device else stat.S_IFREG)

    def access(self, p, flags):
        assert p == '/dev/ptmx' and flags == os.R_OK | os.W_OK
        return self.accessible

    def devpts(self):
        return self.mounted

    def isatty(self, fd):
        assert fd == 0
        return self.attached


class Controls(unittest.TestCase):
    def result(self, fake, stage=None, reason=None):
        r = NS['probe'](fake)
        if stage:
            self.assertEqual((r['result'], r['stage'], r['reason']), ('refused', stage, reason))
        return r

    def test_01_success_is_only_metadata_and_no_attached_gui_claim(self):
        r = self.result(Fake())
        self.assertEqual((r['result'], r['stage'], r['reason']), ('metadata-only-pass', 'complete', 'ok'))
        self.assertEqual((r['tty'], r['display'], r['auth']), ('not-attached', 'unset', 'unset'))
        self.assertEqual(r['pidfd'], 'api-present-untested')

    def test_02_context_refuses_before_metadata(self):
        for key, value in (('GITHUB_REF', 'refs/heads/main'), ('GITHUB_RUN_ATTEMPT', '2'),
                           ('RUNNER_ARCH', 'ARM64'), ('GITHUB_WORKFLOW_SHA', 'b' * 40)):
            f = Fake(); f.env[key] = value
            self.result(f, 'context', 'context')
            self.assertEqual(f.events, [])
        f = Fake(); f.machine = 'aarch64'
        self.result(f, 'context', 'context')

    def test_03_root_and_mismatched_identity_stop(self):
        f = Fake(); f.real_uid = 0
        self.result(f, 'identity', 'non_root')
        f = Fake(); f.effective_uid = 0
        self.result(f, 'identity', 'uid_mismatch')

    def test_04_unsafe_workspace_or_ancestor_numbers(self):
        for p in ('/', '/home', '/home/runner/work/hub/hub'):
            for field in ('st_ino', 'st_dev', 'st_nlink'):
                f = Fake(); setattr(f.files[p], field, NS['MAX_SAFE'] + 1)
                self.result(f, 'filesystem', 'unsafe_number')

    def test_05_workspace_home_must_be_current_user_owned(self):
        f = Fake(); f.files['/home/runner'] = info(uid=0)
        self.result(f, 'filesystem', 'owner')
        f = Fake(); f.aliases['/home/runner'] = '/other'
        self.result(f, 'filesystem', 'canonical')

    def test_06_missing_xvfb_stops_before_later_tools(self):
        f = Fake(); f.files.pop('/usr/bin/Xvfb')
        r = self.result(f, 'xvfb', 'missing')
        self.assertEqual(r['xdpyinfo'], 'not-checked')
        self.assertNotIn('/usr/bin/xauth', f.events)

    def test_07_exact_tool_and_parent_refusals(self):
        changes = (('st_uid', 1000, 'owner'), ('st_mode', stat.S_IFLNK | 0o755, 'kind'),
                   ('st_mode', stat.S_IFREG | 0o4755, 'mode_special'),
                   ('st_mode', stat.S_IFREG | 0o775, 'mode_group_write'),
                   ('st_mode', stat.S_IFREG | 0o757, 'mode_other_write'),
                   ('st_nlink', 2, 'nlink'), ('st_mode', stat.S_IFREG | 0o644, 'executable'))
        for key, value, reason in changes:
            f = Fake(); setattr(f.files['/usr/bin/xdpyinfo'], key, value)
            self.result(f, 'xdpyinfo', reason)
        f = Fake(); f.files['/usr'].st_uid = 99
        self.result(f, 'xvfb', 'owner')

    def test_08_occupied_fixed_slots_stop_without_removal(self):
        for p in ('/tmp/.X11-unix/X97', '/tmp/.X97-lock', '/home/runner/.hub-owned-x11-12345-attempt-1'):
            f = Fake(); f.files[p] = info()
            self.result(f, 'slots', 'occupied')

    def test_09_device_and_mount_presence_is_not_allocation(self):
        f = Fake(); f.device = False
        self.result(f, 'ptmx', 'device')
        f = Fake(); f.accessible = False
        self.result(f, 'ptmx', 'device')
        f = Fake(); f.mounted = False
        self.result(f, 'devpts', 'mount')

    def test_10_advertised_display_and_tty_are_not_authentication(self):
        f = Fake(); f.env.update(DISPLAY='private-endpoint', XAUTHORITY='/private/path')
        f.attached = True
        r = self.result(f)
        self.assertEqual((r['tty'], r['display'], r['auth']), ('attached', 'advertised', 'advertised'))
        self.assertNotIn(b'private', NS['encoded'](r))

    def test_11_no_pidfd_or_signal_function_is_invoked(self):
        f = Fake(); f.pidfd_api = False
        self.result(f, 'pidfd', 'api')
        f = Fake(); f.sigchld_default = False
        self.result(f, 'sigchld', 'signal')

    def test_12_access_and_unknown_errors_are_fixed_codes(self):
        for error, reason in ((PermissionError('private-secret'), 'access_error'),
                              (RuntimeError('private-secret'), 'unexpected')):
            f = Fake(); f.failures['/usr/bin/Xvfb'] = error
            r = self.result(f, 'xvfb', reason)
            self.assertNotIn(b'private-secret', NS['encoded'](r))

    def test_13_late_result_never_becomes_success(self):
        f = Fake()
        f.after = lambda p: setattr(f, 'tick', 16.0) if p == '/usr/bin/Xvfb' else None
        self.result(f, 'xauth', 'deadline')

    def test_14_encoded_output_is_bounded_and_has_exact_keys(self):
        r = self.result(Fake())
        self.assertLessEqual(len(NS['encoded'](r)), 1536)
        r['unknown'] = 'private'
        with self.assertRaises(NS['Refusal']): NS['encoded'](r)
        r = self.result(Fake()); r['display'] = 'private'
        with self.assertRaises(NS['Refusal']): NS['encoded'](r)
        r['display'] = 'unset\nsecret=value'
        with self.assertRaises(NS['Refusal']): NS['encoded'](r)

    def test_15_static_no_native_or_network_command_authority(self):
        imports = {alias.name for n in TREE.body if isinstance(n, ast.Import) for alias in n.names}
        self.assertFalse(imports & {'subprocess', 'socket', 'pty', 'ctypes', 'fcntl', 'urllib'})
        names = {n.func.attr for n in ast.walk(TREE) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertFalse(names & {'system', 'popen', 'spawn', 'fork', 'execv', 'kill', 'pidfd_open',
                                 'pidfd_send_signal', 'chmod', 'chown', 'unlink', 'remove', 'rmdir', 'mkdir'})
        self.assertEqual(set(NS['FIELDS']), set(self.result(Fake())))

    def test_16_all_finite_refusals_are_reportable(self):
        for reason in NS['REASONS']:
            r = self.result(Fake()); r['result'] = 'refused'; r['reason'] = reason
            self.assertIn(('reason=' + reason + '\n').encode(), NS['encoded'](r))

    def test_17_only_managed_output_is_opened_and_closed_once(self):
        events = []
        fake_os = types.SimpleNamespace(environ={'GITHUB_OUTPUT': '/output'},
            path=types.SimpleNamespace(realpath=lambda p: p), O_WRONLY=1, O_APPEND=2,
            O_NOFOLLOW=4, O_CLOEXEC=8, getuid=lambda: 1000,
            open=lambda p, f: events.append(('open', p, f)) or 3,
            fstat=lambda fd: info(stat.S_IFREG, uid=1000),
            write=lambda fd, raw: events.append(('write', fd, raw)) or len(raw),
            close=lambda fd: events.append(('close', fd)))
        old = NS['os']; NS['os'] = fake_os
        try:
            NS['publish'](b'result=refused\n')
        finally:
            NS['os'] = old
        self.assertEqual(events, [('open', '/output', 15), ('write', 3, b'result=refused\n'), ('close', 3)])
        self.assertTrue(NS['OUTPUT'][-1]['closed'])

    def test_18_primary_write_error_and_uncertain_close_custody_preserved(self):
        primary, secondary = RuntimeError('private-write'), RuntimeError('private-close')
        closes = []
        def write(fd, raw): raise primary
        def close(fd): closes.append(fd); raise secondary
        fake_os = types.SimpleNamespace(environ={'GITHUB_OUTPUT': '/output'},
            path=types.SimpleNamespace(realpath=lambda p: p), O_WRONLY=1, O_APPEND=2,
            O_NOFOLLOW=4, O_CLOEXEC=8, getuid=lambda: 1000,
            open=lambda p, f: 7, fstat=lambda fd: info(stat.S_IFREG, uid=1000),
            write=write, close=close)
        old = NS['os']; NS['os'] = fake_os
        try:
            with self.assertRaises(RuntimeError) as caught: NS['publish'](b'result=refused\n')
        finally:
            NS['os'] = old
        self.assertIs(caught.exception, primary)
        owner = NS['OUTPUT'][-1]
        self.assertIs(owner['primary'], primary)
        self.assertIs(owner['secondary'], secondary)
        self.assertFalse(owner['closed'])
        self.assertEqual(closes, [7])


if __name__ == '__main__':
    unittest.main()
