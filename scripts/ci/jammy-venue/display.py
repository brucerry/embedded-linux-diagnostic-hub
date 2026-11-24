"""Fixed stock Jammy desktop-admission witness. It has no product inputs."""
from hashlib import sha256
import json
import os
from pathlib import Path
import pwd
import secrets
import stat
import subprocess
import sys
import tempfile
from time import monotonic, sleep

NAME = 'hub-display'
PYTHON = '/usr/bin/python3.10'
MEDIA = Path('/mnt/hub-apt-witness')
XAUTH = '/usr/bin/xauth'
XVFB = '/usr/bin/Xvfb'
XDPYINFO = '/usr/bin/xdpyinfo'
UNSHARE = '/usr/bin/unshare'
DISPLAY = ':91'
SOCKET = Path('/tmp/.X11-unix/X91')
PID_LOCK = Path('/tmp/.X91-lock')
STAGES = ('xvfb','cookie-refusal','cookie-acceptance','retired')
ENV = {'PATH':'/usr/bin:/bin','LC_ALL':'C'}


def need(value, label):
    if not value:
        raise ValueError(label)


def credentials():
    account = pwd.getpwnam(NAME)
    need(0 < account.pw_uid < 60000 and account.pw_uid==account.pw_gid
         and account.pw_passwd in ('x','*','!') and account.pw_shell=='/usr/sbin/nologin',
         'guest-dedicated-account')
    home = Path(account.pw_dir)
    meta = home.lstat()
    need(home==Path('/home/hub-display') and home.resolve()==home and stat.S_ISDIR(meta.st_mode)
         and meta.st_uid==account.pw_uid and not meta.st_mode&0o022,'guest-dedicated-home')
    return account


def parent():
    account=credentials()
    needle={b'Uid',b'Gid',b'CapEff',b'CapPrm',b'CapAmb',b'Seccomp'}
    with Path('/proc/self/status').open('rb') as status:
        lines=status.read(16385)
    need(len(lines)<=16384,'ordinary-status-bound')
    selected={line.split(b':',1)[0]:line.split(b':',1)[1].split()
              for line in lines.splitlines() if line.split(b':',1)[0] in needle}
    uid=str(account.pw_uid).encode()
    need(selected[b'Uid']==selected[b'Gid']==[uid]*4 and os.getgroups()==[]
         and selected[b'Seccomp']==[b'0'] and
         all(selected[key]==[b'0000000000000000'] for key in (b'CapEff',b'CapPrm',b'CapAmb')),
         'ordinary-stock-parent')
    for path in ('/proc/sys/kernel/unprivileged_userns_clone',):
        switch=Path(path)
        if switch.is_file():
            need(switch.read_text().strip()=='1','stock-unprivileged-userns')
    switch=Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    if switch.is_file():
        need(switch.read_text().strip()=='0','stock-apparmor-userns')
    need(int(Path('/proc/sys/user/max_user_namespaces').read_text())>0,'stock-userns-limit')
    need(sorted(os.listdir('/sys/class/net'))==['lo'],'ordinary-loopback')
    for fd in Path('/proc/self/fd').iterdir():
        try:
            link=os.readlink(fd)
        except FileNotFoundError:
            continue
        need(not link.startswith('socket:'),'inherited-socket')


def userns():
    parent()
    original=os.readlink('/proc/self/ns/user')
    obtained=subprocess.run([UNSHARE,'--user','--map-root-user','--pid','--fork','--',
                             '/usr/bin/readlink','/proc/self/ns/user'],env=ENV,stdin=subprocess.DEVNULL,
                            capture_output=True,check=True,timeout=8)
    selected=obtained.stdout.decode('ascii').strip()
    need(not obtained.stderr and selected.startswith('user:[') and selected.endswith(']') and
         selected[6:-1].isdecimal() and selected!=original,'live-distinct-user-pid-namespace')


def executable_pins():
    pins=json.loads((MEDIA/'disp.jsn').read_bytes())
    need(set(pins)=={XAUTH,XVFB,XDPYINFO,UNSHARE},'display-pinned-roster')
    for name,(size,digest) in pins.items():
        path=Path(name)
        need(path.resolve()==path,'display-tool-canonical')
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC),'rb') as source:
            meta=os.fstat(source.fileno())
            need(meta.st_mode==0o100755 and meta.st_uid==meta.st_gid==0 and meta.st_size==size
                 ,'display-tool-shape')
            selected=source.read(size+1)
            need(len(selected)==size and sha256(selected).hexdigest()==digest,'display-tool-provenance')
            after=os.fstat(source.fileno())
            need((meta.st_size,meta.st_ctime_ns,meta.st_mtime_ns)==
                 (after.st_size,after.st_ctime_ns,after.st_mtime_ns),'display-tool-stability')


def authorize(file,cookie,env):
    file.touch(mode=0o600,exist_ok=False)
    result=subprocess.run([XAUTH,'-q','-f',str(file)],env=env,
                         input=f'add {DISPLAY} MIT-MAGIC-COOKIE-1 {cookie}\n'.encode('ascii'),
                         stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=4)
    meta=file.lstat()
    need(result.returncode==0 and meta.st_mode==0o100600 and meta.st_uid==os.getuid()
         and 0<meta.st_size<=4096,'owned-xauth')


def local_client(auth,env):
    return subprocess.run([XDPYINFO,'-display',DISPLAY],env=env|{'XAUTHORITY':str(auth)},
                          stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                          timeout=5).returncode


def no_tcp_listener():
    port=f'{6000+int(DISPLAY[1:]):04X}'
    for path in ('/proc/net/tcp','/proc/net/tcp6'):
        table=Path(path)
        if table.exists():
            need(all(row.split()[1].rsplit(':',1)[-1].upper()!=port
                     for row in table.read_text().splitlines()[1:]),'display-no-tcp')


def run_display():
    parent()
    executable_pins()
    need(not os.path.lexists(SOCKET) and not os.path.lexists(PID_LOCK),'display-fresh-slot')
    stages=[]
    with tempfile.TemporaryDirectory(prefix='display-',dir=str(Path.home())) as scratch:
        work=Path(scratch)
        correct,wrong=work/'good',work/'wrong'
        env=ENV|{'HOME':str(Path.home()),'TMPDIR':str(work),'DISPLAY':DISPLAY}
        good,bad=secrets.token_hex(16),secrets.token_hex(16)
        need(good!=bad,'independent-cookie')
        authorize(correct,good,env)
        authorize(wrong,bad,env)
        child=subprocess.Popen([XVFB,DISPLAY,'-screen','0','800x600x24','-auth',str(correct),
                               '-nolisten','tcp','-noreset'],env=env,stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                               start_new_session=True,close_fds=True)
        try:
            limit=monotonic()+8
            while not os.path.lexists(SOCKET) and monotonic()<limit and child.poll() is None:
                sleep(.05)
            meta=SOCKET.lstat()
            need(child.poll() is None and stat.S_ISSOCK(meta.st_mode) and meta.st_uid==os.getuid()
                 and os.readlink(f'/proc/{child.pid}/exe')==XVFB,'owned-private-xvfb')
            no_tcp_listener()
            need(local_client(correct,env)==0 and child.poll() is None,'authenticated-display-ready')
            stages.append('xvfb')
            need(local_client(wrong,env)>0 and child.poll() is None,'wrong-cookie-refused')
            stages.append('cookie-refusal')
            need(local_client(correct,env)==0 and child.poll() is None,'right-cookie-accepted')
            stages.append('cookie-acceptance')
            no_tcp_listener()
        except (OSError,ValueError,subprocess.SubprocessError):
            pass
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    code=child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
                    code=None
                if (code==0 and not os.path.lexists(SOCKET) and not os.path.lexists(PID_LOCK)
                    and not Path(f'/proc/{child.pid}').exists()):
                    stages.append('retired')
    print(' '.join(stages))


class Display:
    def __init__(self,deadline):
        self.deadline=deadline
        self.results=()

    def run(self,phase,seconds):
        account=credentials()
        maximum=min(self.deadline-monotonic(),seconds)
        need(maximum>0,'display-deadline')
        raw=subprocess.run([PYTHON,'-B','-I',__file__,phase],env=ENV|{'HOME':account.pw_dir},
                            cwd=account.pw_dir,user=account.pw_uid,group=account.pw_gid,extra_groups=[],
                            stdin=subprocess.DEVNULL,capture_output=True,timeout=maximum)
        need(raw.returncode==0 and not raw.stderr and len(raw.stdout)<=128,'owned-display-probe')
        return raw.stdout

    def parent(self):
        need(not self.run('parent',8),'parent-fixed-output')

    def userns(self):
        need(not self.run('userns',12),'userns-fixed-output')

    def tools(self):
        executable_pins()

    def exercise(self):
        self.results=tuple(self.run('display',35).decode('ascii').split())
        need(tuple(stage for stage in STAGES if stage in self.results)==self.results and 'xvfb' in self.results,
             'display-start')

    def wrong(self):
        need('cookie-refusal' in self.results,'display-wrong-cookie')

    def right(self):
        need('cookie-acceptance' in self.results,'display-right-cookie')

    def retired(self):
        need(self.results==STAGES,'display-normal-exit')


if __name__=='__main__':
    try:
        need(len(sys.argv)==2,'display-operation')
        {'parent':parent,'userns':userns,'display':run_display}[sys.argv[1]]()
    except Exception:
        raise SystemExit(78) from None
