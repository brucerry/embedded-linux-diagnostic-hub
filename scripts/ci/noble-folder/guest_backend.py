"""Held direct guest backend. No entry point, provisioning or envelope writer."""
from hashlib import sha256
import json
import os
from pathlib import Path
import selectors
import stat
from struct import unpack_from
import subprocess
from time import monotonic

import consent
from filesystem import Tree, directory, stamp, tree
from folder_actor import LoaderReference
from guest_install_gate import media_and_network
from loader_gate import ALIAS, LOADER, APPLICATION, ROLE_PATHS, FilePin, LoaderRead, elf_interpreter, loader_map, need
from pty_actor import EXEC, PrivatePTY, only_uid_owners


REFERENCE_SHA = 'b16328b9d91ee32c2be410a06624427b4d3b1001afac43f97043ab6cfe9a8ce5'
ACCOUNT_UID = 1000
HOME = Path(consent.HOME)
GUEST_FREE = 4*2**30
LIBDIR = Path('/usr/lib/x86_64-linux-gnu')
PRELOAD = Path('/etc/ld.so.preload')
ENV = {'PATH':'/usr/bin:/bin','LC_ALL':'C','HOME':consent.HOME}
MEMBER_LIMIT = 256*2**20


def refs(raw):
    need(type(raw) is bytes and len(raw) <= 65536 and sha256(raw).hexdigest() == REFERENCE_SHA,
         'guest-exact-loader-reference')
    received = json.loads(raw)
    return LoaderReference(
        FilePin(**received['loader']),FilePin(**received['targets']['node']),
        {role:{name:(row['path'], FilePin(**row['pin'])) for name,row in providers.items()}
         for role,providers in received['providers'].items()},
    ), FilePin(**received['targets']['installer'])


def bounded_file(path, owner, *, exact=None, extras=False):
    canonical = path.resolve(strict=True)
    need(canonical == path and all(part.lstat().st_uid in (0,owner) and
         stat.S_ISDIR(part.lstat().st_mode) and not part.lstat().st_mode & 0o7022 for part in path.parents),
         'guest-member-protected-path')
    flags = os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
    with os.fdopen(os.open(path,flags),'rb') as body:
        fd = body.fileno()
        first = os.fstat(fd)
        need(stat.S_ISREG(first.st_mode) and first.st_uid==owner and first.st_nlink==1
             and 0<first.st_size<=MEMBER_LIMIT and not first.st_mode & 0o7022,
             'guest-member-protected-file')
        digest = sha256()
        count = 0
        while chunk := body.read(65536):
            count += len(chunk)
            need(count <= first.st_size,'guest-member-bounded-read')
            digest.update(chunk)
        pin = FilePin(count,digest.hexdigest(),stat.S_IMODE(first.st_mode))
        need(count == first.st_size and (exact is None or pin == exact),'guest-member-digest')
        header = os.pread(fd,65536,0) if extras else b''
        if extras == 'addon':
            addon_dynamic(fd,header,first.st_size)
        last = os.fstat(fd)
        need(stamp(first)==stamp(last)==stamp(path.lstat()),'guest-member-changed')
    return pin,header,(first.st_dev,first.st_ino)


def addon_dynamic(fd,header,size):
    """Limit the just-produced addon before passing it to the fixed stock linker."""
    elf_interpreter(header,'addon',size)
    offset = unpack_from('<Q',header,32)[0]
    width,count = unpack_from('<HH',header,54)
    load, dynamic = [], []
    for index in range(count):
        kind,_,start,virt,_,length,_,_ = unpack_from('<IIQQQQQQ',header,offset + index*width)
        need(start + length <= size, 'addon-segment-range')
        if kind==1:
            load.append((start,virt,length))
        if kind==2:
            dynamic.append((start,length))
    need(len(dynamic)==1 and 0<dynamic[0][1]<=65536 and dynamic[0][1]%16==0,
         'addon-dynamic-table')
    raw = os.pread(fd,dynamic[0][1],dynamic[0][0])
    needed, strings, size_rows = [], [], []
    ended = False
    for index in range(0,len(raw),16):
        tag,val = unpack_from('<QQ',raw,index)
        if tag==0:
            ended = True
            break
        need(tag not in (15,29,0x6ffffefa,0x6ffffefb,0x6ffffefc,0x7ffffffd,0x7fffffff)
             and (tag != 0x6ffffffb or not val & 0x800),'addon-dynamic-search')
        if tag==1:
            needed.append(val)
        elif tag==5:
            strings.append(val)
        elif tag==10:
            size_rows.append(val)
    need(ended and len(needed)==len(strings)==len(size_rows)==1 and
         0<=needed[0]<size_rows[0]<=65536,'addon-dynamic-closure')
    candidates = [start+strings[0]-virt for start,virt,length in load
                  if virt<=strings[0] and strings[0]+size_rows[0]<=virt+length]
    need(len(candidates)==1,'addon-string-segment')
    table = os.pread(fd,size_rows[0],candidates[0])
    need(len(table)==size_rows[0] and table[needed[0]:].split(b'\0',1)[0]==b'libc.so.6' and
         b'\0' in table[needed[0]:],'addon-exact-needed')


class GuestBackend:
    """Requires a future reviewed owner to retain each adopted child through worker retirement."""

    def __init__(self,reference,kit,deadline):
        self.reference,self.expected_installer = refs(reference)
        self.deadline = deadline
        need(isinstance(kit,Tree) and kit.files.get('folder-envelope.mjs') is not None and
             kit.files['folder-envelope.mjs'].sha256 ==
             'a7eb7ac62363015c8ef9ba7e3d6555fb230b635c458e20afaa8810f53e45c3c8',
             'guest-envelope-helper-pin')
        self.kit = kit
        self.ports = []
        self.commands = []
        self.prepared = None
        self.executable_inode = None

    def bounded(self,argv,seconds,*,env=ENV):
        limit = min(self.deadline,monotonic()+seconds)
        need(monotonic()<limit,'guest-observer-deadline')
        only_uid_owners(ACCOUNT_UID,[os.getpid()])
        child = subprocess.Popen(argv,env=env,stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        self.commands.append(child)
        with selectors.DefaultSelector() as select:
            for stream in (child.stdout,child.stderr):
                select.register(stream,selectors.EVENT_READ,bytearray())
            output,error = [item.data for item in select.get_map().values()]
            while select.get_map():
                remaining = limit-monotonic()
                need(remaining>0,'guest-observer-timeout-retained')
                ready = select.select(remaining)
                need(ready,'guest-observer-timeout-retained')
                for watch,_ in ready:
                    chunk=os.read(watch.fd,4096)
                    if chunk:
                        watch.data.extend(chunk)
                        need(len(output)<=32768 and len(error)<=8192,'guest-observer-output-retained')
                    else:
                        select.unregister(watch.fileobj)
        code=child.wait(timeout=max(0,limit-monotonic()))
        only_uid_owners(ACCOUNT_UID,[os.getpid()])
        child.stdout.close()
        child.stderr.close()
        need(code==0 and not error,'guest-observer-exit')
        return bytes(output)

    def preflight(self):
        need(os.getuid()==os.geteuid()==os.getgid()==os.getegid()==ACCOUNT_UID
             and os.uname().machine=='x86_64' and not os.path.lexists(PRELOAD),
             'guest-dedicated-no-preload-identity')
        status = {}
        for line in Path('/proc/self/status').read_text().splitlines():
            key,_,value = line.partition(':')
            if key in ('NoNewPrivs','CapEff','CapPrm','CapAmb','Uid','Gid'):
                need(key not in status,'guest-process-status-duplicate')
                status[key] = value.strip()
        zero = '0000000000000000'
        need(os.getgroups() in ([],[ACCOUNT_UID]) and status.get('NoNewPrivs')=='1' and
             all(status.get(key)==zero for key in ('CapEff','CapPrm','CapAmb')) and
             all(status.get(key,'').split()==[str(ACCOUNT_UID)]*4 for key in ('Uid','Gid')),
             'guest-actor-privilege-drop')
        own = directory(HOME,ACCOUNT_UID)
        space = os.statvfs(HOME)
        need(stat.S_IMODE(own.st_mode)==0o700 and space.f_bavail*space.f_frsize >= GUEST_FREE and
             not space.f_flag & os.ST_RDONLY, 'guest-actual-free-reserve')
        routes = [json.loads(self.bounded(['/usr/sbin/ip','-json',flag,'route','show','table','all'],5))
                  for flag in ('-4','-6')]
        mount = Path('/proc/self/mountinfo').read_bytes()
        need(len(mount)<=131072,'guest-mountinfo-bound')
        media_and_network(mount.decode('utf-8'),sorted(os.listdir('/sys/class/net')),*routes)

    def stage(self,original):
        from envelope_stage import prepare
        project = HOME/'project'

        def envelope(selected):
            need(tree(project,ACCOUNT_UID)==self.kit,'guest-envelope-helper-kit')
            self.attested_target('node')
            result = self.bounded(
                [ROLE_PATHS['node'],project/'folder-envelope.mjs','prepare',project,
                 HOME,str(selected.size),selected.sha256,selected.commit],90,
                env=ENV|{'LANG':'C.UTF-8','TMPDIR':str(HOME/'tmp'),
                         'NODE_DISABLE_COMPILE_CACHE':'1','NODE_NO_WARNINGS':'1'},
            )
            self.attested_target('node')
            need(tree(project,ACCOUNT_UID)==self.kit,'guest-envelope-helper-kit')
            return result

        self.prepared = prepare(HOME,ACCOUNT_UID,original,envelope)
        return self.prepared

    def target(self,role):
        if role=='node':
            return self.reference.node
        if role=='installer':
            need(self.prepared.app_files['diagnostic-hub']==self.expected_installer,
                 'guest-same-attempt-publisher-installer')
            return self.expected_installer
        return self.prepared.app_files['resources/diagnostic_hub_rename_noreplace.node']

    def attested_target(self,role):
        pin,header,inode = bounded_file(Path(ROLE_PATHS[role]),ACCOUNT_UID,
                                        exact=self.target(role),extras=role)
        elf_interpreter(header,role,pin.size)
        return pin,header,inode

    def loader(self,role):
        need(role in ROLE_PATHS and not os.path.lexists(PRELOAD),'guest-loader-role')
        pin,header,inode = self.attested_target(role)
        if role=='installer':
            self.executable_inode = inode
        alias = str(Path(ALIAS).resolve(strict=True))
        need(alias==LOADER,'guest-actual-loader-path')
        loader = bounded_file(Path(alias),0,exact=self.reference.loader)[0]
        reference = self.reference.providers[role]
        bundle, app_lib = Path(APPLICATION), Path(APPLICATION)/'usr/lib'
        for name,(path,provider) in reference.items():
            if path.startswith(APPLICATION+'/'):
                bounded_file(Path(path),ACCOUNT_UID,exact=provider)
                need(not os.path.lexists(app_lib/name),'guest-bundled-lookup-shadow')
            else:
                need(not os.path.lexists(bundle/name) and not os.path.lexists(app_lib/name) and
                     Path(LIBDIR/name).resolve(strict=True)==Path(path),'guest-system-lookup-shadow')
                bounded_file(Path(path),0,exact=provider)
        need(not os.path.lexists(bundle/'glibc-hwcaps') and not os.path.lexists(app_lib/'glibc-hwcaps'),
             'guest-private-hwcaps-shadow')
        args = ['--list',ROLE_PATHS[role]]
        if role != 'node':
            args = ['--library-path',str(app_lib),*args]
        reports = [self.bounded([LOADER,*extra,*args],8) for extra in ([],['--inhibit-cache'])]
        actual = {}
        for raw in reports:
            mapped = loader_map(raw, role=role)
            need(mapped.keys()==reference.keys(),'guest-actual-loader-roster')
            for name,loaded in mapped.items():
                target,provider = reference[name]
                resolved = Path(loaded).resolve(strict=True)
                need(str(resolved)==target,'guest-actual-resolved-file')
                observed = bounded_file(resolved,ACCOUNT_UID if target.startswith(APPLICATION+'/') else 0,
                                        exact=provider)[0]
                need(name not in actual or actual[name]==(target,observed),'guest-resolved-file-changed')
                actual[name] = target,observed
        need(self.attested_target(role)==(pin,header,inode),'guest-loader-target-changed')
        return LoaderRead(pin,header,alias,loader,*reports,actual)

    def start(self,operation):
        need(self.executable_inode is not None and
             all(port.master is None and port.pidfd is None for port in self.ports), 'guest-pty-owner-open')

        def check(active):
            need(operation==active and not os.path.lexists(PRELOAD)
                 and sorted(os.listdir('/sys/class/net'))==['lo'],'guest-pty-boundary')
            need(self.attested_target('installer')[2]==self.executable_inode,'guest-pty-target-changed')
            self.attested_target('addon')

        session = PrivatePTY(self.executable_inode,check)
        self.ports.append(session)
        session.spawn(operation)
        return session
