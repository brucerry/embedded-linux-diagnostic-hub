"""No-product Noble witness. The APT child can execute only pinned tools and the inert stand-in."""
from base64 import b64decode
import ctypes as c
import errno
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import sys
from urllib.parse import unquote_to_bytes


MEDIA=Path('/mnt/hub-apt-witness')
ROOT=Path('/run/hub-apt-witness')
STATE=ROOT/'private'
STATUS=Path('/var/lib/dpkg/status')
STAND_IN=ROOT/'dpkg-stand-in'
APT=Path('/usr/bin/apt-get')
CONFIG=Path('/usr/bin/apt-config')
UID,GID=42,65534
LOCK_SHA='bab31cbbe0e4b4cf8c2cb976571147be182d5ebda2fea9afbe03635debf61fb3'
STAND_IN_SHA='0ddd063c64a47cfaedfa9dd2728678025414e1efca883e0ccb229bbb94f6ec1e'
IMAGE='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
LIMIT=1024**2
PHASES=('apt_media','apt_signed_baseline','apt_exec_exclusion','apt_configuration',
        'apt_private_locks','apt_local_acquisition','apt_standin_transition','apt_databases_unchanged')
ENV={'PATH':'/nonexistent','HOME':'/nonexistent','LC_ALL':'C','DEBIAN_FRONTEND':'noninteractive',
     'TMPDIR':str(STATE/'tmp'),'APT_CONFIG':str(ROOT/'apt.conf')}
RFLAGS=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
EXEC,WRITE,READ,LIST=1,2,4,8
# Handle through TRUNCATE, including the types of node APT must never create.
FS_RIGHTS=(1<<15)-1
WORK_RIGHTS=READ|LIST|WRITE|sum(1<<bit for bit in (4,5,7,8,12,13,14))


def need(condition,label):
    if not condition:
        raise ValueError(label)


def digest(value):
    return sha256(value).hexdigest()


def pinned(path,max_bytes,pin=None,size=None):
    with os.fdopen(os.open(path,RFLAGS),'rb') as source:
        first=os.fstat(source.fileno())
        need(stat.S_ISREG(first.st_mode) and 0<first.st_size<=max_bytes and
             (size is None or size==first.st_size),'file-size')
        raw=source.read(first.st_size+1)
        last=os.fstat(source.fileno())
        need((first.st_size,first.st_mtime_ns,first.st_ctime_ns)==
             (last.st_size,last.st_mtime_ns,last.st_ctime_ns) and len(raw)==first.st_size
             and (pin is None or pin==digest(raw)),'file-pin')
        return raw


def put(path,raw,mode,private=False):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as out:
        out.write(raw)
        if private:
            os.fchown(out.fileno(),UID,GID)
        os.fchmod(out.fileno(),mode)


def media(lock):
    need(len(lock['entries'])==67 and sum(x['compressed_bytes'] for x in lock['entries'])==55561760,
         'signed-package-roster')
    children={p.name for p in MEDIA.iterdir()}
    names=[f'p{n:03}.deb' for n in range(67)]
    need(children=={'boot.py','lock.jsn','tools.jsn','actor.b64',*names},'flat-media-roster')
    found=[]
    for raw in Path('/proc/self/mountinfo').read_text().splitlines():
        left,_,right=raw.partition(' - ')
        fields,fs=left.split(),right.split()
        if len(fields)>5 and fields[4]==str(MEDIA):
            found.append(fields[3]=='/' and {'ro','nosuid','nodev','noexec'}<=set(fields[5].split(','))
                         and len(fs)==3 and fs[0]=='iso9660' and fs[1]=='/dev/sr1'
                         and 'ro' in fs[2].split(','))
        need(len(fields)<=4 or not fields[4].startswith(str(MEDIA)+'/'),'nested-media')
    need(found==[True] and all(p.lstat().st_mode&1 for p in (MEDIA,*MEDIA.parents)),'optical-boundary')
    for name,row in zip(names,lock['entries'],strict=True):
        path=MEDIA/name
        need(path.lstat().st_mode&4,'ordinary-user-readable-media')
        pinned(path,30_574_382,row['sha256'],row['compressed_bytes'])


def settings():
    empty=str(ROOT/'empty.conf')
    dirs=str(ROOT/'empty')
    return {
        'APT::Architecture':'amd64','APT::Sandbox::User':'_apt','APT::Install-Recommends':'false',
        'APT::Install-Suggests':'false','APT::Get::AllowUnauthenticated':'false',
        'Acquire::AllowInsecureRepositories':'false','Acquire::AllowDowngradeToInsecureRepositories':'false',
        'Acquire::Check-Valid-Until':'true','Acquire::Retries':'0','Debug::pkgAcquire::Worker':'true',
        'Dir::Etc::main':empty,'Dir::Etc::parts':dirs,'Dir::Etc::sourcelist':empty,'Dir::Etc::sourceparts':dirs,
        'Dir::Etc::preferences':empty,'Dir::Etc::preferencesparts':dirs,
        'Dir::Etc::trusted':empty,'Dir::Etc::trustedparts':dirs,
        'Dir::State':str(STATE),'Dir::State::status':str(STATE/'dpkg/status'),
        'Dir::State::extended_states':str(STATE/'extended_states'),'Dir::State::lists':str(STATE/'lists'),
        'Dir::Cache':str(STATE/'cache'),'Dir::Cache::archives':str(STATE/'cache/archives'),
        'Dir::Cache::pkgcache':'','Dir::Cache::srcpkgcache':'','Dir::Log':str(STATE/'log'),
        'Dir::Bin::dpkg':str(STAND_IN),'Dir::Bin::Methods':'/usr/lib/apt/methods',
        'DPkg::Run-Directory':str(STATE),'DPkg::Use-Pty':'false','DPkg::Lock::Timeout':'0',
        'binary::apt-get::Debug::NoLocking':'false',
    }


def config_bytes():
    return (''.join(f'{key} "{value}";\n' for key,value in settings().items())+
            'APT::Architectures { "amd64"; };\n').encode('ascii')


def verify_config(raw):
    expected={k.lower():v for k,v in settings().items()}
    observed={}
    arches=[]
    for line in raw.decode('ascii').splitlines():
        row=re.fullmatch(r'(\S+) "(.*)";',line)
        need(row is not None,'apt-configuration-framing')
        key,value=row.groups()
        key=key.lower()
        need(not re.search(r'(?:^|::)(?:[^:]*invoke[^:]*|[^:]*install-pkgs[^:]*|hooks?)(?:::|$)',key),
             'apt-ambient-hook')
        if key=='apt::architectures::':
            arches.append(value)
        elif key in expected:
            need(key not in observed,'apt-configuration-duplicate')
            observed[key]=value
    need(observed==expected and arches==['amd64'],'apt-configuration-identity')


def tool_roster(tools):
    executables={'/usr/bin/apt-get','/usr/bin/apt-config','/usr/lib/apt/methods/file',
                 '/usr/lib/apt/methods/copy','/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'}
    need(tools['image']==IMAGE and tools['kernel']==os.uname().release and
         len(tools['members'])==23 and set(tools['executables'])==executables,'stock-tool-roster')
    read=set()
    for name,pin in (tools['members']|tools['config']).items():
        path=Path(name)
        need(name in executables or name in ('/etc/passwd','/etc/group','/etc/nsswitch.conf')
             or re.fullmatch(r'/usr/lib/x86_64-linux-gnu/[A-Za-z0-9_.+\-]+\.so(?:\.[0-9.]+)?',name),
             'stock-read-object-roster')
        need(path.resolve(strict=True)==path,'stock-object-alias')
        meta=path.lstat()
        need((meta.st_uid,meta.st_gid,stat.S_IMODE(meta.st_mode))==(0,0,pin['mode']),'stock-object-mode')
        pinned(path,16*LIMIT,pin['sha256'],pin['size'])
        read.add(path)
    for name,destination in tools['aliases'].items():
        need(Path(name).resolve(strict=True)==Path(destination) and Path(destination) in read,'stock-library-alias')
    need(Path('/lib64/ld-linux-x86-64.so.2').resolve(strict=True)==
         Path('/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'),'stock-interpreter')
    pin=tools['negative']
    pinned(Path('/usr/bin/true'),LIMIT,pin['sha256'],pin['size'])
    return read,{Path(path) for path in executables}


class Rules(c.Structure):
    _fields_=[('fs',c.c_uint64),('net',c.c_uint64)]


class Rule(c.Structure):
    _pack_=1
    _fields_=[('allow',c.c_uint64),('parent',c.c_int32)]


def permission_plan(read,execute):
    objects={p:READ|(EXEC if p in execute else 0) for p in read}
    objects|={STAND_IN:READ|EXEC,MEDIA:READ|LIST,ROOT/'empty':LIST,
              ROOT/'empty.conf':READ,ROOT/'apt.conf':READ,STATE:WORK_RIGHTS,
              Path('/dev/null'):READ|WRITE}
    need({p for p,rights in objects.items() if rights&EXEC}==execute|{STAND_IN}
         and all(path.is_absolute() for path in objects),'landlock-closed-exec-roster')
    return objects


def policy(read,execute):
    libc=c.CDLL(None,use_errno=True)
    call=libc.syscall
    call.restype=c.c_long
    # x86_64 Linux UAPI. An absent or disabled ABI is a refusal, with no fallback.
    need(os.uname().machine=='x86_64' and call(444,0,0,1)>=4,'landlock-abi')
    rules=Rules(FS_RIGHTS,3)  # deny TCP connect and bind in addition to no NIC
    fd=call(444,c.byref(rules),c.sizeof(rules),0)
    need(fd>=0,'landlock-create')
    try:
        for path,access in permission_plan(read,execute).items():
            parent=os.open(path,os.O_PATH|os.O_CLOEXEC|os.O_NOFOLLOW)
            try:
                need(stat.S_IFMT(os.fstat(parent).st_mode) in (stat.S_IFDIR,stat.S_IFREG,stat.S_IFCHR),
                     'landlock-object-kind')
                rule=Rule(access,parent)
                need(call(445,fd,1,c.byref(rule),0)==0,'landlock-add')
            finally:
                os.close(parent)
        need(call(446,fd,0)==0,'landlock-enforce')
    finally:
        os.close(fd)


def assert_exclusion():
    for path in ('/usr/bin/dpkg','/bin/dpkg','/usr/bin/dpkg-deb','/usr/bin/dash',
                 '/usr/bin/python3.12',str(STATUS)):
        try:
            fd=os.open(path,RFLAGS)
        except PermissionError as error:
            need(error.errno==errno.EACCES,'exclusion-read-error')
        else:
            os.close(fd)
            raise ValueError('excluded-input-readable')
    # A harmless real binary must fail to execute inside the same inherited domain.
    pid=os.fork()
    if pid==0:
        try:
            os.execve('/usr/bin/true',['/usr/bin/true'],ENV)
        except OSError as error:
            os._exit(71 if error.errno==errno.EACCES else 72)
    _,status=os.waitpid(pid,0)
    need(os.waitstatus_to_exitcode(status)==71,'exclusion-kernel-execution')
    code,out,err=capture([str(STAND_IN),'--unpack','/nonexistent/inert.deb'],4)
    need((code,out,err)==(73,b'',b'HUB_STANDIN_UNPACK_REFUSED\n'),'exact-stand-in')


def capture(argv,timeout):
    # Bounded ordinary files avoid unbounded RAM growth and keep raw streams private.
    output=STATE/'output'
    error=STATE/'error'
    with output.open('wb') as out,error.open('wb') as err:
        child=subprocess.run(argv,env=ENV,stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=timeout,
                             close_fds=True)
    raw,stderr=output.read_bytes(),error.read_bytes()
    need(len(raw)+len(stderr)<LIMIT,'apt-output-limit')
    return child.returncode,raw,stderr


def acquisition(stderr):
    done=[]
    for line in stderr.splitlines():
        if not line.startswith(b' <- ') or b'201 URI Done' not in line:
            continue
        decoded=unquote_to_bytes(line)
        mt=re.search(rb'(?:^|\n)URI: file:/mnt/hub-apt-witness/(p[0-9]{3}\.deb)(?:\n|$)',decoded)
        need(decoded.startswith(b' <- file:201 URI Done\n') and mt is not None,'apt-foreign-acquisition')
        done.append(mt[1])
    expected={f'p{i:03}.deb'.encode() for i in range(67)}
    need(len(done)==67 and set(done)==expected,'apt-incomplete-acquisition')


def worker(toolsha):
    def mark(name,result):
        print(name+' '+result,flush=True)
    def checked(name,action):
        try:
            result=action()
        except Exception:
            mark(name,'fail')
            raise
        mark(name,'pass')
        return result
    proc=Path('/proc/self/status').read_text()
    identity=all(re.search(pattern,proc,re.M) for pattern in (
       r'^CapEff:\s+0+$',r'^CapPrm:\s+0+$',r'^CapAmb:\s+0+$',r'^NoNewPrivs:\s+1$'))
    need(identity and os.getuid()==os.geteuid()==UID and os.getgid()==os.getegid()==GID
         and not os.getgroups(),'guest-unprivileged-worker')
    tools=json.loads(pinned(MEDIA/'tools.jsn',32768,toolsha))
    def confine():
        read,execute=tool_roster(tools)
        resource.setrlimit(resource.RLIMIT_FSIZE,(LIMIT,LIMIT))
        policy(read,execute)
        assert_exclusion()
    checked('apt_exec_exclusion',confine)
    def check_cfg():
        code,out,err=capture([str(CONFIG),'dump'],6)
        need(code==0 and not err,'apt-config-dump')
        verify_config(out)
    checked('apt_configuration',check_cfg)
    def lock_check():
        need(not any((STATE/'dpkg/updates').iterdir()) and not any((STATE/'cache/archives/partial').iterdir()),
             'private-journal-or-cache')
        for name in ('dpkg/lock','dpkg/lock-frontend','cache/archives/lock'):
            with (STATE/name).open('a+b') as lock:
                fcntl.lockf(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    checked('apt_private_locks',lock_check)
    try:
        code,out,err=capture([str(APT),'--no-download','--no-remove','--no-install-recommends',
            '--assume-yes','install',*(str(MEDIA/f'p{i:03}.deb') for i in range(67))],85)
    except Exception:
        mark('apt_local_acquisition','fail')
        raise
    checked('apt_local_acquisition',lambda:acquisition(err))
    checked('apt_standin_transition',lambda:need(
        code==100 and (out+err).splitlines().count(b'HUB_STANDIN_UNPACK_REFUSED')==1
        and b'HUB_STANDIN_OTHER_REFUSED' not in out+err
        and f'Sub-process {STAND_IN} returned an error code (73)'.encode() in err,
        'apt-did-not-reach-exact-stand-in'))


def configure(baseline):
    ROOT.mkdir(mode=0o755)
    ROOT.chmod(0o755)
    (ROOT/'empty').mkdir(mode=0o555)
    (ROOT/'empty').chmod(0o555)
    put(ROOT/'empty.conf',b'',0o444)
    put(ROOT/'apt.conf',config_bytes(),0o444)
    raw=b64decode(pinned(MEDIA/'actor.b64',4096).strip(),validate=True)
    need(digest(raw)==STAND_IN_SHA,'stand-in-publisher-bytes')
    put(STAND_IN,raw,0o555)
    for part in ('','dpkg','dpkg/updates','cache','cache/archives','cache/archives/partial',
                 'lists','log','tmp'):
        path=STATE/part
        path.mkdir(mode=0o700)
        os.chown(path,UID,GID)
    put(STATE/'dpkg/status',baseline,0o400,private=True)


def supervisor(nonce,toolsha):
    need(os.getuid()==os.geteuid()==0 and re.fullmatch('[a-f0-9]{64}',nonce),'stock-cloud-init')
    def mark(name,result):
        with open('/dev/ttyS0','w') as tty:
            print(f'HUB_APT_WITNESS {nonce} {name} {result}',file=tty,flush=True)
    try:
        lock=json.loads(pinned(MEDIA/'lock.jsn',65536,LOCK_SHA))
        media(lock)
    except Exception:
        mark('apt_media','fail')
        raise
    mark('apt_media','pass')
    try:
        need(not ROOT.exists() and sorted(os.listdir('/sys/class/net'))==['lo'],'guest-loopback-state')
        baseline=pinned(STATUS,2*LIMIT,lock['guestStatusSHA256'])
        configure(baseline)
    except Exception:
        mark('apt_signed_baseline','fail')
        raise
    mark('apt_signed_baseline','pass')
    args=['/usr/bin/setpriv',f'--reuid={UID}',f'--regid={GID}','--clear-groups','--no-new-privs',
          '/usr/bin/python3.12','-I','-B',str(MEDIA/'boot.py'),'worker',toolsha]
    child=subprocess.Popen(args,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'},
                           stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                           start_new_session=True,close_fds=True)
    try:
        wire,_=child.communicate(timeout=115)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid,signal.SIGKILL)
        child.communicate(timeout=5)
        raise
    stages=PHASES[2:-1]
    need(len(wire)<=2048,'worker-wire-limit')
    rows=wire.decode('ascii').splitlines()
    need(len(rows)<=len(stages),'worker-wire-length')
    for index,line in enumerate(rows):
        name,verdict=line.split(' ',1)
        need(name==stages[index] and verdict in ('pass','fail') and
             (verdict=='pass' or index==len(rows)-1),'worker-wire-frame')
        mark(name,verdict)
    try:
        need(pinned(STATUS,2*LIMIT,lock['guestStatusSHA256'])==baseline and
             pinned(STATE/'dpkg/status',2*LIMIT,lock['guestStatusSHA256'])==baseline and
             not any((STATE/'dpkg/updates').iterdir()),'database-state-preservation')
    except Exception:
        if child.returncode==0:
            mark('apt_databases_unchanged','fail')
        raise
    need(child.returncode==0 and rows==[name+' pass' for name in stages],'apt-inert-transition')
    mark('apt_databases_unchanged','pass')


if __name__=='__main__':
    try:
        if len(sys.argv)==3 and sys.argv[1]=='worker':
            worker(sys.argv[2])
        else:
            supervisor(*sys.argv[1:])
    except Exception:
        raise SystemExit(78) from None
