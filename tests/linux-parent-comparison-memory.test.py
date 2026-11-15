"""Literal closed-memory traversal/custody controls; no host or fixture main."""
import ast
import hashlib
import pathlib
import re
import stat
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/linux-parent-comparison.py'
HELPER = ROOT / 'scripts/linux-parent-classifier.py'
TREE = ast.parse(SOURCE.read_bytes(), filename=str(SOURCE))
NS = {'hashlib': hashlib, 're': re, 'stat': stat}
selected = [n for n in TREE.body if isinstance(n, ast.Assign) or
            isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name != 'main']
exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), NS)
PURE = {'__name__': '_inert_classifier'}
raw = HELPER.read_bytes()
assert hashlib.sha256(raw).hexdigest() == NS['CLASSIFIER_SHA']
exec(compile(raw, str(HELPER), 'exec'), PURE)
classify = PURE['classify']


def info(inode, mode=0o755, uid=0, gid=0, kind=stat.S_IFDIR):
    return types.SimpleNamespace(st_dev=1, st_ino=inode, st_mode=kind | mode, st_uid=uid,
        st_gid=gid, st_nlink=1, st_size=0, st_mtime_ns=10, st_ctime_ns=10)


class Memory:
    def __init__(self):
        self.uid, self.first, self.owners = 1000, None, []
        self.events, self.closed_fds = [], []
        self.specs = {p: info(i+1) for i, p in enumerate(('/', '/usr', '/usr/share',
            '/usr/share/doc', '/usr/share/man', '/usr/share/man/man1', '/usr/share/menu'))}
        self.hook = None

    def root_stat(self):
        self.events.append(('stat', '/'))
        return self.specs['/']

    def gate(self):
        self.events.append(('gate', 'budget'))

    def entry(self, owner, name):
        assert name in ('usr', 'share', 'doc', 'man', 'man1', 'menu') and '/' not in name
        assert any(owner is o for o in self.owners) and not owner['closed']
        path = str(pathlib.PurePosixPath(owner['path']) / name)
        self.events.append(('stat', path))
        if self.hook: self.hook(path)
        if path not in self.specs: raise FileNotFoundError()
        return self.specs[path]

    def open_directory(self, parent, name):
        path = '/' if parent is None else str(pathlib.PurePosixPath(parent['path']) / name)
        assert path in ('/', '/usr', '/usr/share', '/usr/share/man')
        self.events.append(('open', path))
        owner = {'fd': 10+len(self.owners), 'returned': True, 'issued': True,
                 'close_issued': False, 'closed': False, 'path': path, 'snapshot': self.specs[path]}
        self.owners.append(owner)
        return owner

    def fstat(self, owner):
        self.events.append(('fstat', owner['path']))
        return owner['snapshot']

    def close_directories(self):
        previous = NS.get('os')
        def close(fd): self.closed_fds.append(fd)
        NS['os'] = types.SimpleNamespace(close=close)
        try: return NS['Host'].close_directories(self)
        finally:
            if previous is None: NS.pop('os', None)
            else: NS['os'] = previous


def compare(port):
    return NS['run_comparison'](port, classify)


class Controls(unittest.TestCase):
    def test_01_exact_unchanged_classifier_and_declared_targets(self):
        self.assertEqual(hashlib.sha256(HELPER.read_bytes()).hexdigest(), 'aafd058da58f4798112928010e74f7dd96f627efbadfe09d7608a789203060cb')
        self.assertEqual(NS['TARGETS'], (('share','usr','share'),('doc','share','doc'),
            ('man','share','man'),('man1','man','man1'),('menu','share','menu')))

    def test_02_all_reachable_fixed_snapshots_and_reverse_close(self):
        port = Memory();report, closed = compare(port)
        self.assertTrue(closed)
        self.assertEqual(report['result'], 'comparison-complete')
        self.assertTrue(all(r['state']=='observed' for r in report['rows'].values()))
        self.assertTrue(all(NS['both_pass'](r['attributes']) for r in report['rows'].values()))
        self.assertEqual([p for a,p in port.events if a=='open'], ['/', '/usr', '/usr/share', '/usr/share/man'])
        self.assertEqual(port.closed_fds, [13,12,11,10])
        self.assertTrue(all(o['closed'] for o in port.owners))
        raw=NS['encode'](report)
        self.assertLessEqual(len(raw),4096)
        self.assertIn(b'native=false provisioning=false',raw)

    def test_03_runner_owned_share_is_observed_but_never_traversed(self):
        port=Memory();port.specs['/usr/share']=info(3,uid=1000,gid=1000)
        report,closed=compare(port)
        self.assertTrue(closed)
        row=report['rows']['share']['attributes']
        self.assertEqual(row['production_parent_predicate'],'pass')
        self.assertEqual(row['preflight579_parent_predicate'],'refuse')
        self.assertNotIn(('open','/usr/share'),port.events)
        for key in ('doc','man','man1','menu'):
            self.assertEqual(report['rows'][key]['state'],'blocked-ancestor')
            self.assertEqual(report['rows'][key]['attributes']['production_parent_predicate'],'unknown')
            self.assertEqual(report['rows'][key]['attributes']['preflight579_parent_predicate'],'unknown')
        self.assertFalse(any(a=='stat' and p.startswith('/usr/share/') for a,p in port.events))

    def test_04_shared_mode_refusal_is_not_relaxed(self):
        port=Memory();port.specs['/usr/share']=info(3,mode=0o775)
        report,closed=compare(port)
        row=report['rows']['share']['attributes']
        self.assertEqual(row['group_write'],'yes')
        self.assertEqual(row['production_parent_predicate'],'refuse')
        self.assertEqual(row['preflight579_parent_predicate'],'refuse')
        self.assertTrue(closed)
        self.assertFalse(any(a=='stat' and p.startswith('/usr/share/') for a,p in port.events))

    def test_05_gid_only_refusal_does_not_open_share(self):
        port=Memory();port.specs['/usr/share']=info(3,gid=1000)
        report,_=compare(port)
        self.assertEqual(report['rows']['share']['attributes']['difference'],'stricter-579-only')
        self.assertNotIn(('open','/usr/share'),port.events)

    def test_06_refused_man_blocks_man1_but_not_sibling_metadata(self):
        port=Memory();port.specs['/usr/share/man']=info(5,uid=2000)
        report,_=compare(port)
        self.assertEqual(report['rows']['man1']['state'],'blocked-ancestor')
        self.assertNotIn(('open','/usr/share/man'),port.events)
        self.assertNotIn(('stat','/usr/share/man/man1'),port.events)
        self.assertEqual(report['rows']['menu']['state'],'observed')

    def test_07_symlink_is_not_followed_or_opened(self):
        port=Memory();port.specs['/usr/share']=info(3,kind=stat.S_IFLNK)
        report,_=compare(port)
        row=report['rows']['share']['attributes']
        self.assertEqual(row['kind'],'symlink')
        self.assertEqual(row['canonical'],'unknown')
        self.assertEqual(row['production_parent_predicate'],'refuse')
        self.assertNotIn(('open','/usr/share'),port.events)

    def test_08_missing_leaf_does_not_invent_metadata_or_traverse(self):
        port=Memory();del port.specs['/usr/share/man']
        report,_=compare(port)
        self.assertEqual(report['rows']['man']['state'],'missing')
        self.assertEqual(report['rows']['man']['attributes']['present'],'no')
        self.assertEqual(report['rows']['man1']['state'],'blocked-ancestor')

    def test_09_detached_ancestor_fstat_alone_cannot_validate_path(self):
        port=Memory()
        def detach(path):
            if path=='/usr/share/doc':port.specs['/usr/share']=info(99)
        port.hook=detach
        report,closed=compare(port)
        self.assertTrue(closed)
        self.assertEqual(report['result'],'incomplete')
        self.assertEqual(report['reason'],'changed')
        self.assertEqual(report['bootstrap'],'invalidated')
        self.assertTrue(all(r['state']=='changed' for r in report['rows'].values()))
        self.assertTrue(all(r['attributes']['production_parent_predicate']=='unknown' for r in report['rows'].values()))
        self.assertNotIn(('open','/usr/share/man'),port.events)

    def test_10_leaf_replacement_before_open_invalidates_all_rows(self):
        port=Memory();calls=[]
        def replace(path):
            if path=='/usr/share':
                calls.append(path)
                if len(calls)==2:port.specs[path]=info(99)
        port.hook=replace
        report,_=compare(port)
        self.assertEqual(report['reason'],'changed')
        self.assertNotIn(('open','/usr/share'),port.events)
        self.assertTrue(all(r['attributes']['canonical']=='unknown' for r in report['rows'].values()))

    def test_11_primary_metadata_failure_and_close_failure_remain_distinct(self):
        port=Memory();primary=OSError('private-primary');secondary=OSError('private-close')
        def fail(path):
            if path=='/usr/share':raise primary
        port.hook=fail
        def unknown_close():
            if port.first is None:port.first=secondary
            return False
        port.close_directories=unknown_close
        report,closed=compare(port)
        self.assertFalse(closed)
        self.assertIs(port.first,primary)
        self.assertEqual(report['reason'],'access')
        self.assertEqual(report['dirs'],'unknown')
        self.assertNotIn('private',NS['encode'](report).decode())

    def test_12_actual_host_ports_use_nofollow_single_components_and_identity_custody(self):
        calls=[];owner={'returned':True,'closed':False,'fd':7};host=types.SimpleNamespace(
            owners=[owner],gate=lambda:None,owned=lambda o:o is owner)
        previous=NS.get('os')
        fake=types.SimpleNamespace(O_RDONLY=0,O_DIRECTORY=0o200000,O_NOFOLLOW=0o400000,
            O_CLOEXEC=0o2000000,stat=lambda *a,**k:calls.append(('stat',a,k)) or info(1),
            open=lambda *a,**k:calls.append(('open',a,k)) or 8,
            fstat=lambda fd:info(1))
        NS['os']=fake
        try:
            NS['Host'].entry(host,owner,'share')
            NS['Host'].open_directory(host,owner,'share')
            with self.assertRaises(NS['Refused']):NS['Host'].entry(host,owner,'share/doc')
            with self.assertRaises(NS['Refused']):NS['Host'].entry(host,dict(owner),'doc')
        finally:
            if previous is None:NS.pop('os',None)
            else:NS['os']=previous
        self.assertEqual(calls[0],('stat',('share',),{'dir_fd':7,'follow_symlinks':False}))
        self.assertTrue(calls[1][1][1] & fake.O_NOFOLLOW)
        self.assertTrue(calls[1][1][1] & fake.O_DIRECTORY)
        self.assertEqual(calls[1][2],{'dir_fd':7})

    def test_13_failed_close_is_never_retried(self):
        owner={'returned':True,'closed':False,'close_issued':False,'fd':7}
        host=types.SimpleNamespace(owners=[owner],first=None);calls=[]
        error=OSError('private-close')
        def fail(fd):calls.append(fd);raise error
        previous=NS.get('os');NS['os']=types.SimpleNamespace(close=fail)
        try:
            self.assertFalse(NS['Host'].close_directories(host))
            self.assertFalse(NS['Host'].close_directories(host))
        finally:
            if previous is None:NS.pop('os',None)
            else:NS['os']=previous
        self.assertEqual(calls,[7]);self.assertIs(host.first,error)
        self.assertFalse(owner['closed'])

    def test_14_publisher_preserves_primary_and_unknown_output_handle(self):
        primary=OSError('private-primary');secondary=OSError('private-close')
        host=types.SimpleNamespace(uid=1000,first=primary,output_owner=None)
        calls=[]
        def close(fd):calls.append(fd);raise secondary
        previous=NS.get('os');NS['os']=types.SimpleNamespace(environ={'GITHUB_OUTPUT':'/owned/out','RUNNER_TEMP':'/owned'},
            path=types.SimpleNamespace(realpath=lambda p:p),O_WRONLY=1,O_APPEND=2,O_NOFOLLOW=4,O_CLOEXEC=8,
            open=lambda *a,**k:7,fstat=lambda fd:types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=1000,st_nlink=1),
            write=lambda fd,data:len(data),close=close)
        try:self.assertFalse(NS['publish'](host,b'fixed=classification\n'))
        finally:
            if previous is None:NS.pop('os',None)
            else:NS['os']=previous
        self.assertIs(host.first,primary);self.assertEqual(calls,[7])
        self.assertTrue(host.output_owner['close_issued']);self.assertFalse(host.output_owner['closed'])

    def test_15_bound_and_output_privacy_do_not_grant_acceptance(self):
        fake=types.SimpleNamespace(calls=160,started=0)
        previous=NS.get('time');NS['time']=types.SimpleNamespace(monotonic=lambda:0)
        try:
            with self.assertRaises(NS['Refused']):NS['Host'].gate(fake)
        finally:
            if previous is None:NS.pop('time',None)
            else:NS['time']=previous
        port=Memory();report,_=compare(port)
        row=report['rows']['share'];row['attributes']['owner']='/private/identity'
        with self.assertRaises(NS['Refused']):NS['encode'](report)
        row['attributes']['owner']='root';row['attributes']['native_qualification']=True
        with self.assertRaises(NS['Refused']):NS['encode'](report)

    def test_16_no_discovery_package_network_permission_or_cleanup_authority(self):
        imports={a.name for n in TREE.body if isinstance(n,ast.Import) for a in n.names}
        self.assertFalse(imports & {'subprocess','socket','urllib','ctypes','pty'})
        calls={n.func.attr for n in ast.walk(TREE) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)}
        self.assertFalse(calls & {'listdir','scandir','walk','readlink','system','Popen','run',
            'unlink','remove','rmdir','chmod','chown','connect','kill','extractall'})

    def test_17_missing_ancestor_binding_invalidates_without_inventing_change(self):
        port=Memory();missing=FileNotFoundError('private-missing-binding');trigger=[]
        def unavailable(path):
            if path=='/usr/share/doc':trigger.append(True)
            if path=='/usr/share' and trigger:raise missing
        port.hook=unavailable
        report,closed=compare(port)
        self.assertTrue(closed)
        self.assertIs(port.first,missing)
        self.assertEqual(report['reason'],'binding-unavailable')
        self.assertEqual(report['result'],'incomplete')
        self.assertTrue(all(r['state']=='unverified' for r in report['rows'].values()))
        self.assertTrue(all(r['attributes']['canonical']=='unknown' for r in report['rows'].values()))
        self.assertTrue(all(r['attributes']['production_parent_predicate']=='unknown' for r in report['rows'].values()))

    def test_18_late_final_snapshot_cannot_produce_complete(self):
        port=Memory()
        def late():raise NS['Refused']('bound')
        port.gate=late
        report,closed=compare(port)
        self.assertTrue(closed)
        self.assertEqual(report['result'],'incomplete')
        self.assertEqual(report['reason'],'bound')
        self.assertTrue(all(r['state']=='unverified' for r in report['rows'].values()))
        self.assertTrue(all(r['attributes']['preflight579_parent_predicate']=='unknown' for r in report['rows'].values()))

    def test_19_unverifiable_fd_is_retained_without_close_or_retry(self):
        owner={'returned':True,'closed':False,'close_issued':False,'fd':7}
        host=types.SimpleNamespace(owners=[owner],first=None,gate=lambda:None,owned=lambda x:x is owner)
        error=OSError('private-fstat');calls=[]
        def fail(fd):calls.append(('fstat',fd));raise error
        previous=NS.get('os');NS['os']=types.SimpleNamespace(fstat=fail,close=lambda fd:calls.append(('close',fd)))
        try:
            with self.assertRaises(OSError) as caught:NS['Host'].fstat(host,owner)
            self.assertIs(caught.exception,error)
            self.assertFalse(NS['Host'].close_directories(host))
        finally:
            if previous is None:NS.pop('os',None)
            else:NS['os']=previous
        self.assertEqual(calls,[('fstat',7)])
        self.assertTrue(owner['uncertain']);self.assertFalse(owner['close_issued'])


if __name__ == '__main__':
    unittest.main()
