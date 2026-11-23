"""Private folder setup reached by the sealed boot command only after verified provisioning."""
from contextlib import contextmanager
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import pwd
import grp
import re
import selectors
import stat
import subprocess
import sys
import tarfile
from time import monotonic

UID=GID=1000
BASE=Path('/run/hub-folder-qualification')
BIND=Path('/mnt/hub-deps')
DATA=Path('/mnt/hub-payload')
USER_HOME=Path('/home/ubuntu')
HOME=USER_HOME/'.hub-folder-qualification'
NODE=126_881_248
NODE_SHA='904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52'
LOCK_SHA='bab31cbbe0e4b4cf8c2cb976571147be182d5ebda2fea9afbe03635debf61fb3'
GIB=2**30
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','DEBIAN_FRONTEND':'noninteractive'}
INITIAL_STAGES=('guest_identity','readonly_media','guest_product_capacity')
NATIVE_STAGES=('guest_account','realized_helpers','native_install_removal')
ACTOR='original-custody loader-closure install-pty installed-readback uninstall-pty removal-and-preservation'
CONTROL_FILES=('LOADER-REFERENCE.json','archive_inventory.py','consent.py','controller.py',
               'envelope_stage.py','filesystem.py','folder_actor.py','folder_record.py','guest_backend.py','guest_entry.py',
               'guest_install_gate.py','kit_media.py','loader_gate.py','pty_actor.py','readonly_iso.py')
FLAGS=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC


def need(value,label):
    if not value:
        raise ValueError(label)


def file_hash(raw):
    return sha256(raw).hexdigest()


def read(path,maximum,digest=None):
    with os.fdopen(os.open(path,FLAGS),'rb') as stream:
        metadata=os.fstat(stream.fileno())
        need(stat.S_ISREG(metadata.st_mode) and 0<metadata.st_size<=maximum,'guest-input-length')
        value=stream.read(maximum+1)
        need(len(value)==metadata.st_size and (digest is None or file_hash(value)==digest),'guest-input-pin')
        return value


def write(path,raw,mode,*,guest=False):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC
    with os.fdopen(os.open(path,flags,0o600),'wb') as target:
        target.write(raw)
        target.flush()
        if guest:
            os.fchown(target.fileno(),UID,GID)
        os.fchmod(target.fileno(),mode)


class CommandRefusal(ValueError):
    def __init__(self,label,verdict):
        super().__init__(label)
        self.verdict=verdict


def command(argv,deadline,seconds,*,cap=131072,env=ENV):
    end=min(deadline,monotonic()+seconds)
    if monotonic()>=end:
        raise CommandRefusal('guest-command-deadline','fail-timeout')
    try:
        child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE,env=env,start_new_session=True)
    except OSError as error:
        raise CommandRefusal('guest-command-launch','fail-launch') from error
    # The guest and its whole worker remain the owned retirement boundary on timeout.
    with selectors.DefaultSelector() as wait:
        out,err=bytearray(),bytearray()
        wait.register(child.stdout,selectors.EVENT_READ,out)
        wait.register(child.stderr,selectors.EVENT_READ,err)
        while wait.get_map():
            remaining=end-monotonic()
            if remaining<=0:
                raise CommandRefusal('guest-command-timeout','fail-timeout')
            events=wait.select(remaining)
            if not events:
                raise CommandRefusal('guest-command-timeout','fail-timeout')
            for event,_ in events:
                part=os.read(event.fd,8192)
                if part:
                    event.data.extend(part)
                    if len(out)+len(err)>cap:
                        raise CommandRefusal('guest-command-output-cap','fail-output-cap')
                else:
                    wait.unregister(event.fileobj)
    code=child.wait(timeout=max(0,end-monotonic()))
    child.stdout.close()
    child.stderr.close()
    return code,bytes(out),bytes(err)


class Guest:
    def __init__(self,args):
        self.nonce,self.bind_sha=args
        need(all(re.fullmatch(r'[a-f0-9]{64}',item) for item in args),'guest-config-digest')
        uptime=float(Path('/proc/uptime').read_text().split()[0])
        self.until=monotonic()+1150-uptime
        self.started=False

    @contextmanager
    def phase(self,name):
        try:
            yield
        except BaseException:
            self.mark(name,'fail')
            raise
        else:
            self.mark(name,'pass')

    def mark(self,name,verdict):
        with open('/dev/ttyS0','w') as port:
            print(f'HUB_NOBLE_FOLDER {self.nonce} {name} {verdict}',file=port,flush=True)

    def run(self,*argv,seconds=10):
        code,out,err=command(argv,self.until,seconds)
        need(code==0 and not err,'guest-stock-command')
        return out

    def network(self):
        interfaces=sorted(os.listdir('/sys/class/net'))
        routes=[json.loads(self.run('/usr/sbin/ip','-j',flag,'route','show','table','all'))
                for flag in ('-4','-6')]
        need(interfaces==['lo'] and all(type(rows) is list and all(
             row.get('dev')=='lo' and row.get('dst') not in (None,'default','0.0.0.0/0','::/0') and
             not {'gateway','via','nexthops'}&row.keys() for row in rows) for rows in routes),
             'guest-isolation-loopback')
        return interfaces,routes

    def identity(self):
        need(os.getuid()==os.geteuid()==0 and os.uname().machine=='x86_64' and
             not os.path.lexists(BASE) and not os.path.lexists(USER_HOME), 'guest-root-setup-scope')
        for lookup,key in ((pwd.getpwnam,'ubuntu'),(pwd.getpwuid,UID),(grp.getgrnam,'ubuntu'),(grp.getgrgid,GID)):
            try:
                lookup(key)
            except KeyError:
                continue
            raise ValueError('guest-account-preexisting')
        self.network()
        self.root_disk()

    def open_media(self):
        interfaces,routes=self.network()
        mounts=Path('/proc/self/mountinfo').read_text()
        devices={}
        for line in mounts.splitlines():
            prefix,sep,detail=line.partition(' - ')
            row,witness=prefix.split(),detail.split()
            need(sep and len(row)>=6 and len(witness)==3,'guest-mounted-medialine')
            if row[4] in (str(BIND),str(DATA)):
                need(row[4] not in devices and row[3]=='/' and
                     {'ro','nosuid','nodev','noexec'}<=set(row[5].split(',')) and witness[0]=='iso9660'
                     and re.fullmatch(r'/dev/sr[0-9]+',witness[1]) and 'ro' in witness[2].split(','),
                     'guest-mounted-media-identity')
                devices[row[4]]=witness[1]
            else:
                need(not row[4].startswith((str(BIND)+'/',str(DATA)+'/')),'guest-mounted-media-nesting')
        need(set(devices)=={str(BIND),str(DATA)} and len(set(devices.values()))==2,'guest-media-device-roster')
        self.raw=read(BIND/'qualify.jsn',32768,self.bind_sha)
        self.bound=json.loads(self.raw)
        need(self.bound['nonce']==self.nonce and self.bound['transactionSHA256']==LOCK_SHA and
             self.bound['virtualBytes']==10*GIB and self.bound['overlayCapBytes']==4*GIB,
             'guest-private-attempt-binding')
        control=read(BIND/'actor.tar',4*2**20,self.bound['actorSHA256'])
        package=read(BIND/'project.tar',4*2**20,self.bound['projectSHA256'])
        expected={'boot.py','qualify.jsn','project.tar','proj.jsn','actor.tar','node.bin'}
        need({entry.name for entry in BIND.iterdir()}==expected,'guest-optical-level-roster')
        BASE.mkdir(mode=0o755)
        os.chmod(BASE,0o755)
        with tarfile.open(fileobj=BytesIO(control),mode='r:') as archive:
            remaining=set(CONTROL_FILES)
            for item in archive:
                need(item.name in remaining and item.isfile() and not item.sparse and
                     item.mode==0o644 and 0<item.size<=2**20,'guest-closed-control-member')
                raw=archive.extractfile(item).read(item.size+1)
                need(len(raw)==item.size,'guest-control-length')
                write(BASE/item.name,raw,0o644)
                remaining.remove(item.name)
            need(not remaining,'guest-closed-control-roster')
        write(BASE/'attempt.json',self.raw,0o644)
        sys.path.insert(0,str(BASE))
        from guest_install_gate import media_and_network
        from folder_actor import selected_original
        media_and_network(mounts,interfaces,*routes)
        selected_original(DATA,self.bound['productBindingSHA256'],self.bound['attempt'],self.nonce,LOCK_SHA)
        self.project=package

    def root_disk(self):
        need(self.run('/usr/bin/findmnt','-n','-o','SOURCE','/')==b'/dev/vda1\n' and
             self.run('/usr/sbin/blockdev','--getsize64','/dev/vda')==b'10737418240\n',
             'guest-virtual-root-disk')

    def product_capacity(self):
        fs=os.statvfs('/')
        # Preserve the old post-APT reserve for the private Node/helper and product work.
        need(not fs.f_flag&os.ST_RDONLY and fs.f_bavail*fs.f_frsize>=6*GIB+NODE+4*2**20
             and fs.f_favail>=12000,'guest-product-capacity')
        need(self.until-monotonic()>=575,'guest-full-product-window')

    def account(self):
        self.network()
        self.run('/usr/sbin/useradd','--uid','1000','--user-group','--no-create-home',
                 '--home-dir',str(USER_HOME),'--shell','/usr/sbin/nologin','ubuntu')
        user=pwd.getpwnam('ubuntu')
        need((user.pw_uid,user.pw_gid,user.pw_dir,user.pw_shell)==(UID,GID,str(USER_HOME),'/usr/sbin/nologin')
             and os.getgrouplist('ubuntu',GID)==[GID],'guest-locked-account-identity')
        shadow = [line.split(':')[1] for line in Path('/etc/shadow').read_text().splitlines()
                  if line.startswith('ubuntu:')]
        need(len(shadow)==1 and shadow[0].startswith(('!','*')),'guest-locked-account')
        for path in (USER_HOME,HOME,*(HOME/name for name in ('tools','project','tmp','data','config'))):
            path.mkdir(mode=0o700)
            os.chown(path,UID,GID,follow_symlinks=False)

    def helpers(self):
        from kit_media import check,write_owned
        expected=json.loads(read(BIND/'proj.jsn',65536,self.bound['projectManifestSHA256']))
        entries=check(self.project,expected)
        write_owned(HOME/'project',entries,UID,GID)
        node=read(BIND/'node.bin',NODE,NODE_SHA)
        need(len(node)==NODE,'guest-exact-node')
        write(HOME/'tools'/'node',node,0o755,guest=True)

    def actor(self):
        self.network()
        need(not self.started and self.until-monotonic()>=545,'guest-native-time-and-once')
        self.started=True
        argv=['/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups','--no-new-privs',
              '/usr/bin/python3.12','-I','-B',str(BASE/'guest_entry.py'),str(BASE/'attempt.json'),self.bind_sha]
        code,out,err=command(argv,self.until,545)
        need(code==0 and not err and out==f'HUB_GUEST_ACTOR {self.nonce} {ACTOR}\n'.encode('ascii'),
             'guest-native-actor-result')
        self.network()

    def execute(self):
        for name,fn in zip(INITIAL_STAGES,(self.identity,self.open_media,self.product_capacity),strict=True):
            with self.phase(name):
                fn()
        for name,fn in zip(NATIVE_STAGES,(self.account,self.helpers,self.actor),strict=True):
            with self.phase(name):
                fn()


if __name__=='__main__':
    try:
        Guest(sys.argv[1:]).execute()
    except Exception:
        raise SystemExit(78) from None
