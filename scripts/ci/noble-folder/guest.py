"""Provisioning only. Loaded by cloud-init from fixed, hash-checked optical data."""
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
from time import monotonic

MEDIA=Path('/mnt/hub-apt-witness')
if __name__=='__main__':
    sys.path.insert(0,str(MEDIA))

from apply import apply, APT, FLAGS, PIPE_KEY
from cache import stage_cache, check_cache
from contract import need, closed, apt_config_options, apt_config_text, config_matches, plan_matches, provisioned_state
from wire import PHASES, EXTRA

ROOT=Path('/run/hub-noble-provisioning')
STATUS=Path('/var/lib/dpkg/status')
DISK=10*2**30
MIN_FREE=6_573_526_496
LOCK_SHA='bab31cbbe0e4b4cf8c2cb976571147be182d5ebda2fea9afbe03635debf61fb3'
TOOLS={
    APT: (51680,'eb53b3b66cbb7a90a370e26439e941b7cf146ddd91a5422063c761ce9e59c53b'),
    '/usr/bin/apt-config': (31120,'44ec8b9197670a2c12ed2c6b837dd623c23b641e8c491be03ccefc23dd0fba8c'),
    '/usr/bin/dpkg': (318176,'567180a568ad6af680314fdcb4d963246985e682b28a9e8fafed8b09abbd50af'),
}
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','DEBIAN_FRONTEND':'noninteractive'}
ROSTER={'boot.py','lock.jsn','apply.py','cache.py','contract.py','observe.py','wire.py',
        *(f'p{i:03}.deb' for i in range(67))}


def read(path,limit,pin=None,size=None):
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK|os.O_NOFOLLOW),'rb') as source:
        first=os.fstat(source.fileno())
        need(stat.S_ISREG(first.st_mode) and 0<first.st_size<=limit and
             (size is None or first.st_size==size),'read-size')
        raw=source.read(first.st_size+1)
        last=os.fstat(source.fileno())
        need(len(raw)==first.st_size and (pin is None or sha256(raw).hexdigest()==pin) and
             (first.st_size,first.st_mtime_ns,first.st_ctime_ns)==
             (last.st_size,last.st_mtime_ns,last.st_ctime_ns),'read-pin')
        return raw


def control(argv, env, deadline, seconds):
    end=min(deadline,monotonic()+seconds)
    need(monotonic()<end,'control-deadline')
    child=subprocess.Popen(argv,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE,start_new_session=True,close_fds=True)
    streams={child.stdout:bytearray(),child.stderr:bytearray()}
    total=0
    try:
        with selectors.DefaultSelector() as events:
            for stream in streams:
                events.register(stream,selectors.EVENT_READ)
            while events.get_map():
                left=end-monotonic()
                need(left>0,'control-deadline')
                ready=events.select(left)
                need(ready,'control-timeout')
                for key,_ in ready:
                    data=os.read(key.fd,8192)
                    if data:
                        total+=len(data)
                        need(total<=131072,'control-output-limit')
                        streams[key.fileobj].extend(data)
                    else:
                        events.unregister(key.fileobj)
        code=child.wait(timeout=max(0,end-monotonic()))
        return code,bytes(streams[child.stdout]),bytes(streams[child.stderr])
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        for stream in streams:
            stream.close()


def optical(mountinfo):
    entries=[]
    for row in mountinfo.splitlines():
        front,sep,back=row.partition(' - ')
        fields,storage=front.split(),back.split()
        need(sep and len(fields)>=6 and len(storage)==3,'mountinfo-shape')
        target=fields[4]
        if target==str(MEDIA):
            entries.append(fields[3]=='/' and {'ro','nodev','nosuid','noexec'}<=set(fields[5].split(','))
                           and storage[:2]==['iso9660','/dev/sr1'] and 'ro' in storage[2].split(','))
        else:
            need(not target.startswith(str(MEDIA)+'/'),'optical-nested')
    need(entries==[True],'optical-identity')


class Provision:
    def __init__(self,nonce):
        need(re.fullmatch('[a-f0-9]{64}',nonce),'receipt-nonce')
        self.nonce=nonce
        self.deadline=monotonic()+910-float(Path('/proc/uptime').read_text().split()[0])
        self.inputs=tuple(str(MEDIA/f'p{i:03}.deb') for i in range(67))
        self.attempted=False

    def mark(self,stage,value):
        with open('/dev/ttyS0','w') as port:
            print(f'HUB_NOBLE_PROVISION {self.nonce} {stage} {value}',file=port,flush=True)

    @contextmanager
    def phase(self,name):
        try:
            yield
        except BaseException:
            self.mark(name,'fail')
            raise
        self.mark(name,'pass')

    def command(self,argv,seconds):
        code,out,err=control(argv,ENV,self.deadline,seconds)
        need(code==0 and not err,'stock-control-exit')
        return out

    def network(self):
        need(sorted(os.listdir('/sys/class/net'))==['lo'],'guest-loopback')
        for family in ('-4','-6'):
            routes=json.loads(self.command(['/usr/sbin/ip','-j',family,'route','show','table','all'],5))
            need(type(routes) is list and all(type(row) is dict and row.get('dev')=='lo'
                 and row.get('dst') not in (None,'default','0.0.0.0/0','::/0')
                 and not {'gateway','via','nexthops'}&row.keys() for row in routes),'guest-routes')

    def identity(self):
        need(os.getuid()==os.geteuid()==0 and os.getgid()==os.getegid()==0 and
             os.uname().machine=='x86_64' and not os.path.lexists(ROOT),'guest-root-scope')
        self.network()

    def media(self):
        optical(Path('/proc/self/mountinfo').read_text())
        need({entry.name for entry in MEDIA.iterdir()}==ROSTER and
             all(p.lstat().st_mode&1 for p in (MEDIA,*MEDIA.parents)),'optical-roster')
        self.lock=json.loads(read(MEDIA/'lock.jsn',65536,LOCK_SHA),object_pairs_hook=closed)
        self.rows=self.lock['entries']
        need(self.lock['snapshot']=='https://snapshot.ubuntu.com/ubuntu/20261120T060000Z/' and
             len(self.rows)==67 and sum(row['compressed_bytes'] for row in self.rows)==55_561_760 and
             self.lock['transaction']=={'adds':62,'upgrades':5,'removals':0} and
             (self.lock['guestBeforePackageCount'],self.lock['guestAfterPackageCount'])==(664,726),'lock-roster')
        self.before=read(STATUS,4*2**20,self.lock['guestStatusSHA256'])

    def space(self,required):
        fs=os.statvfs('/')
        need(not fs.f_flag&os.ST_RDONLY and fs.f_bavail*fs.f_frsize>=required and
             fs.f_favail>=12000,'guest-provision-capacity')

    def grow(self):
        need(self.command(['/usr/bin/findmnt','-n','-o','SOURCE','/'],8)==b'/dev/vda1\n' and
             self.command(['/usr/sbin/blockdev','--getsize64','/dev/vda'],8)==f'{DISK}\n'.encode(),'guest-disk')
        sectors=Path('/sys/class/block/vda1/size')
        old=sectors.read_text()
        self.command(['/usr/bin/growpart','/dev/vda','1'],30)
        now=sectors.read_text()
        need(old.strip().isdecimal() and now.strip().isdecimal() and int(now)>int(old),'guest-growpart')
        code,_,_=control(['/usr/sbin/resize2fs','/dev/vda1'],ENV,self.deadline,75)
        need(code==0,'guest-resize')
        self.space(MIN_FREE+sum(row['installed_kib']*1024 for row in self.rows))

    def tools(self):
        for path,(size,pin) in TOOLS.items():
            target=Path(path)
            meta=target.lstat()
            need(target.resolve(strict=True)==target and meta.st_mode==0o100755
                 and (meta.st_uid,meta.st_gid)==(0,0),'guest-tool-mode')
            read(target,size,pin,size)

    def cache(self):
        ROOT.mkdir(mode=0o700)
        ROOT.chmod(0o755)
        stage_cache(ROOT/'archives',MEDIA,self.rows,self.deadline)

    def config(self):
        scratch=ROOT/'apt'
        scratch.mkdir(mode=0o700)
        for leaf in ('parts','lists'):
            (scratch/leaf).mkdir(mode=0o700)
        (scratch/'empty.conf').touch(exist_ok=False,mode=0o600)
        self.settings=apt_config_options(scratch)|{
            'Dir::Cache::archives':str(ROOT/'archives'),'Dir::Bin::dpkg':'/usr/bin/dpkg',
            'APT::Status-Fd':'-1',PIPE_KEY:'-1'}
        self.config_path=scratch/'apt.conf'
        self.config_bytes=apt_config_text(self.settings)
        with self.config_path.open('xb') as out:
            out.write(self.config_bytes)
        self.config_path.chmod(0o400)
        self.env=ENV|{'APT_CONFIG':str(self.config_path)}
        self.verify_config()

    def verify_config(self,option=None,deadline=None):
        need(read(self.config_path,8192)==self.config_bytes and not any((ROOT/'apt/parts').iterdir())
             and not any((ROOT/'apt/lists').iterdir()) and (ROOT/'apt/empty.conf').lstat().st_size==0,'config-seal')
        argv=['/usr/bin/apt-config']
        expected=self.settings
        if option is not None:
            need(re.fullmatch(re.escape(PIPE_KEY)+r'=[1-9][0-9]{0,5}',option),'status-descriptor')
            argv+=['-o',option]
            expected=expected|{PIPE_KEY:option.split('=',1)[1]}
        code,out,err=control([*argv,'dump'],self.env,deadline or self.deadline,6)
        need(code==0 and not err,'apt-config-exit')
        config_matches(out,expected)

    def simulate(self):
        code,out,err=control([APT,*FLAGS,'--simulate','install',*self.inputs],self.env,self.deadline,45)
        need(code==0 and not err,'simulation-exit')
        plan_matches(out,self.lock)
        self.baseline()

    def baseline(self):
        self.network()
        need(read(STATUS,4*2**20,self.lock['guestStatusSHA256'])==self.before,'baseline-drift')
        self.verify_config()

    def transaction(self):
        need(not self.attempted,'single-apply')
        self.attempted=True
        self.baseline()
        self.tools()
        check_cache(ROOT/'archives',self.rows,self.deadline)
        result=apply(self.inputs,self.env,self.deadline,self.verify_config)
        for (stage,allowed),value in zip(EXTRA.items(),result.fields(),strict=True):
            need(value in allowed,'receipt-telemetry')
            self.mark(stage,value)
        need(result.exit=='zero' and result.child_closed,'apply-exit')
        self.observation=result.observation

    def database(self):
        provisioned_state(self.before,read(STATUS,4*2**20),self.lock)

    def observer(self):
        result=self.observation
        need(result.stream=='valid' and result.progress=='child-reported' and not result.package_error
             and not result.conffile_prompt,'apply-status')

    def capacity(self):
        self.network()
        self.space(MIN_FREE)

    def run(self):
        for stage,action in zip(PHASES,(self.identity,self.media,self.grow,self.tools,self.cache,self.config,
                self.simulate,self.transaction,self.database,self.observer,self.capacity),strict=True):
            with self.phase(stage):
                action()


def interrupted(_signum,_frame):
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    signal.signal(signal.SIGINT,signal.SIG_IGN)
    raise InterruptedError('guest-cancelled')


if __name__=='__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM,interrupted)
    signal.signal(signal.SIGINT,interrupted)
    try:
        Provision(*sys.argv[1:]).run()
    except Exception:
        raise SystemExit(78) from None
