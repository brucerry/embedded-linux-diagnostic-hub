"""Stock Jammy guest controller. All application effects cross the measured grant."""

from contextlib import contextmanager
from dataclasses import asdict
from hashlib import sha256
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
from time import monotonic,sleep

sys.path.insert(0,str(Path(__file__).resolve().parent))
import appimage_inventory as image
import archive_inventory
import runtime_display as x
import runtime_provision as stock
import guest_closure
import handoff
import native_control
import native_preflight as native
import observer_stage
import pair_wire as pair
import portable_stage
import runtime_gate as gate

ROOT=Path('/run/hub-native-control')
PORTABLE=Path('/mnt/hub-product')
OBSERVER=Path('/mnt/hub-observer')
MOUNTS={
    '/mnt/hub-product':'/dev/sr1','/mnt/hub-apt-witness':'/dev/sr2',
    '/mnt/hub-apt-runtime':'/dev/sr3','/mnt/hub-observer':'/dev/sr4',
}
PHASES=('native_stock','native_custody','native_guest_storage','native_display_apt',
        'native_runtime_apt','native_display_capability','native_ready','native_prelaunch_grant',
        'native_files','native_post_staging_floor','native_observer_actor_frame','native_observer_display',
        'native_observer_launch','native_observer_window','native_observer_renderer',
        'native_observer_quit','native_observer_extraction','native_observer_record',
        'native_observer_display_retirement','native_window_renderer_quit',
        'native_process_retirement','native_owned_retirement')
need=pair.need

def mark(plan,stage,what):
    need(stage in PHASES and (what in ('pass','fail') or
         (stage=='native_observer_renderer' and what=='fail-proc-unavailable') or
         (stage=='native_observer_launch' and what=='fail-transport')),'native-fixed-phase')
    with open('/dev/ttyS0','w',encoding='ascii') as console:
        print(f"HUB_JAMMY_NATIVE {plan['nonce']} {stage} {what}",file=console,flush=True)


@contextmanager
def phase(plan,stage):
    try:
        yield
    except BaseException:
        mark(plan,stage,'fail')
        raise
    mark(plan,stage,'pass')


def read_doc(path,cap):
    return json.loads(stock.read(path,cap),object_pairs_hook=pair.closed_object)


def mounted():
    source=Path('/proc/self/mountinfo').read_text()
    for path,dev in MOUNTS.items():
        rows=[]
        for line in source.splitlines():
            front,sep,back=line.partition(' - ')
            left,right=front.split(),back.split()
            need(sep and len(left)>=6 and len(right)==3,'native-mountinfo')
            need(not left[4].startswith(path+'/'),'native-optical-nested')
            if left[4]==path:
                rows.append(left[3]=='/' and right[:2]==['iso9660',dev]
                            and {'ro','nosuid','nodev','noexec'}<=set(left[5].split(','))
                            and 'ro' in right[2].split(','))
        need(rows==[True] and os.statvfs(path).f_flag&os.ST_RDONLY,'native-optical-roster')


class Provision(stock.Provision):
    def __init__(self,plan,index,deadline):
        super().__init__(plan['nonce'])
        self.deadline=min(self.deadline,deadline)
        self.index=index
        self.medium=Path(('/mnt/hub-apt-witness','/mnt/hub-apt-runtime')[index])
        self.doc=native.runtime_locks()[index][1]
        lock=stock.read(self.medium/'lock.jsn',65536,
                (native.DISPLAY_PIN,native.RUNTIME_PIN)[index])
        need(json.loads(lock,object_pairs_hook=pair.closed_object)==self.doc,'native-apt-lock')
        self.rows=self.doc['entries']
        self.lock=self.doc
        self.inputs=tuple(str(self.medium/f'p{i:03}.deb') for i in range(len(self.rows)))
        names={'lock.jsn',*(Path(name).name for name in self.inputs)}
        if index==0:
            names.add('disp.jsn')
        need({entry.name for entry in self.medium.iterdir()}==names,'native-apt-optical-roster')
        self.before=stock.read(stock.STATUS,4*2**20)
        if index==0:
            need(sha256(self.before).hexdigest()==self.doc['guestStatusSHA256'],'native-apt-stock-db')
        else:
            need(native.package_digest(native.contract.database(self.before))==
                 self.doc['beforeInventorySHA256'],'native-apt-display-db')

    def baseline(self):
        self.network()
        need(stock.read(stock.STATUS,4*2**20)==self.before,'native-apt-baseline')
        self.verify_config()

    def cache(self):
        stock.ROOT.mkdir(mode=0o755)
        stock.ROOT.chmod(0o755)
        stock.stage_cache(stock.ROOT/'archives', self.medium, self.rows, self.deadline)

    def mark(self,stage,value):
        # Existing APT observer emits only fixed outcomes. This job projects the terminal
        # transaction and exact database as named steps, through the owning root controller.
        need(stage in stock.EXTRA and value in stock.EXTRA[stage],'native-apt-coarse-observation')

    def run_exact(self):
        self.tools()
        need(self.command(['/usr/bin/findmnt','-n','-o','FSTYPE','--target','/run'],5)==b'tmpfs\n',
             'native-apt-tmpfs-cache')
        need(os.statvfs('/run').f_bavail*os.statvfs('/run').f_frsize>=68_005_584,'native-apt-cache-space')
        self.cache()
        try:
            self.config()
            self.simulate()
            self.transaction()
            self.database()
            self.observer()
            self.capacity()
            result=stock.read(stock.STATUS,4*2**20)
            if self.index==1:
                need(native.package_digest(native.contract.database(result))==
                     self.doc['afterInventorySHA256'],'native-apt-runtime-db')
        except BaseException:
            # Leave uncertain package state to whole-guest retirement.
            raise
        need(stock.ROOT==Path('/run/hub-jammy-provisioning') and
             stock.ROOT.resolve()==stock.ROOT and stock.ROOT.lstat().st_uid==0
             and shutil.rmtree.avoids_symlink_attacks,'native-apt-private-cache')
        shutil.rmtree(stock.ROOT)


def run_as(account,plan,step,seconds,end):
    argv=['/usr/bin/python3.10','-I','-B',__file__,step]
    timeout=min(seconds,end-monotonic())
    need(timeout>0,'native-user-phase-time')
    child=subprocess.Popen(argv,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','HOME':account.pw_dir},
             cwd=account.pw_dir,user=account.pw_uid,group=account.pw_gid,extra_groups=[],
             stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
             start_new_session=True,close_fds=True)
    # The worker/VM have their own hard lifetime. No raw stdout is emitted.
    try:
        import selectors
        out=bytearray()
        with selectors.DefaultSelector() as sel:
            sel.register(child.stdout,selectors.EVENT_READ,True)
            sel.register(child.stderr,selectors.EVENT_READ,False)
            deadline=monotonic()+timeout
            while sel.get_map():
                need(deadline>monotonic(),'native-user-output-deadline')
                events=sel.select(max(0,deadline-monotonic()))
                need(events,'native-user-output-timeout')
                for key,_ in events:
                    part=os.read(key.fd,4096)
                    if not part:
                        sel.unregister(key.fileobj)
                    else:
                        need(key.data and len(out)+len(part)<=4096,'native-user-output-shape')
                        out.extend(part)
        code=child.wait(timeout=max(0,deadline-monotonic()))
        need(code==0 and monotonic()<end,'native-user-exit')
        return bytes(out)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        child.stdout.close()
        child.stderr.close()


def protected_output(where,body):
    with where.open('xb') as wire:
        wire.write(body)
    where.chmod(0o444)


def base_dir():
    return Path.home()/'case'


def actor_stage(plan):
    x.parent()
    work=base_dir()
    work.mkdir(mode=0o700)
    staged, tools=work/'original',work/'observer'
    for p in (staged,tools):
        p.mkdir(mode=0o700)
    until=monotonic()+75
    artifact=plan['header']['members'][2]
    need(artifact[0]==handoff.APPIMAGE,'native-appimage-artifact')
    target=staged/handoff.APPIMAGE
    def copy_original(source):
        handoff.appimage_prefix(source)
        need(observer_stage.write_regular(target,source,artifact[1],until)==(artifact[1],artifact[2]),
             'native-appimage-immutable-copy')
    native.by_descriptor(PORTABLE,'app.bin',artifact[2],artifact[1],copy_original)
    target.chmod(0o500)
    actual=observer_stage.materialize(OBSERVER,tools,plan['observerLock'],until)
    need(actual['execution'] is False,'native-observer-data-staging')
    return {'sha256':artifact[2], 'bytes':artifact[1]}


def actor_launch(plan):
    x.parent()
    x.executable_pins()
    work=base_dir()
    app=work/'original'/handoff.APPIMAGE
    tools=work/'observer'
    child_env={'PATH':'/usr/bin:/bin','LC_ALL':'C','HOME':str(Path.home()),'TMPDIR':str(work/'temp'),
               'DISPLAY':x.DISPLAY,'XDG_CONFIG_HOME':str(work/'config'),'XDG_CACHE_HOME':str(work/'cache'),
               'HUB_TEST_EXECUTABLE':str(app),'HUB_STAGED_ASSET':handoff.APPIMAGE,
               'HUB_APPIMAGE_TMP':str(work/'runtime-extraction'),
               'HUB_STAGED_IDENTITY':str(work/'observation.json'),'HUB_RT_BINDING':str(ROOT/'binding.json')}
    for p in (work/'temp',work/'config',work/'cache',work/'runtime-extraction'):
        p.mkdir(mode=0o700)
    gate.check_guest_space(os.statvfs(work),0,12000)
    full_ro=ROOT/'binding.json'
    expected=read_doc(full_ro,4096)
    need(expected['archive']['path']==str(app) and expected['asset']==handoff.APPIMAGE,
         'native-actor-binding')
    needed=image_budget(plan)
    gate.check_guest_space(os.statvfs(work),needed['guestCopy']-
                           plan['observerGuest4KiB']-image.archive.round_to(expected['archive']['size'],4096),
                           12000)
    binary=tools/'node'
    mode=binary.lstat()
    need(stat.S_IMODE(mode.st_mode)==0o400 and mode.st_uid==os.getuid(),'native-observer-binary-mode')
    stock.read(binary,observer_stage.NODE_BINARY_SIZE,observer_stage.NODE_BINARY_PIN,
               observer_stage.NODE_BINARY_SIZE)
    binary.chmod(0o500)
    tool=subprocess.run([str(binary),'--version'],cwd=tools,env=child_env,
               stdin=subprocess.DEVNULL,capture_output=True,timeout=5)
    need(tool.returncode==0 and not tool.stderr and tool.stdout==b'v24.22.2\n','native-node-loader-version')
    need(not os.path.lexists(x.SOCKET) and not os.path.lexists(x.PID_LOCK),'native-fresh-display')
    good,bad=work/'display-cookie',work/'incorrect-cookie'
    secrets_pair=(secrets.token_hex(16),secrets.token_hex(16))
    need(secrets_pair[0]!=secrets_pair[1],'native-two-cookies')
    x.authorize(good,secrets_pair[0],child_env)
    x.authorize(bad,secrets_pair[1],child_env)
    server=subprocess.Popen([x.XVFB,x.DISPLAY,'-screen','0','800x600x24','-auth',str(good),
                        '-nolisten','tcp','-noreset'],env=child_env,stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    verdict='display'
    quit=extraction='unreached'
    retired=False
    try:
        until=monotonic()+8
        while not os.path.lexists(x.SOCKET) and server.poll() is None and monotonic()<until:
            sleep(.05)
        need(server.poll() is None and stat.S_ISSOCK(x.SOCKET.lstat().st_mode) and
             x.SOCKET.lstat().st_uid==os.getuid() and os.readlink(f'/proc/{server.pid}/exe')==x.XVFB,
             'native-owned-xvfb')
        x.no_tcp_listener()
        need(x.local_client(bad,child_env)>0 and x.local_client(good,child_env)==0,'native-cookie-contrast')
        verdict='transport'
        code,out,_=capture_observer(binary,tools,child_env|{'XAUTHORITY':str(good)})
        verdict,quit,extraction=parse_observer(code,out)
        if verdict=='pass':
            verdict='record'
            record=read_doc(work/'observation.json',65536)
            need(record=={'asset':handoff.APPIMAGE,'artifactSHA256':expected['archive']['sha256'],
                 'freshRenderer':{'window':'portable-overview','renderer':'artifact-descendant',
                  'sandbox':'distinct-user-pid-seccomp-nonewprivs'},'extractionRetired':True},
                 'native-exact-appimage-renderer')
            need(not any((work/'runtime-extraction').iterdir()),'native-appimage-extraction-retired')
            gate.check_guest_space(os.statvfs(work),0,12000)
            x.no_tcp_listener()
            verdict='pass'
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # Fixed result only. Never forward observer stderr or exception details.
        pass
    finally:
        if server.poll() is None:
            server.terminate()
        try:
            closed=server.wait(timeout=7)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=3)
        else:
            retired=(closed==0 and not os.path.lexists(x.SOCKET) and
                     not os.path.lexists(x.PID_LOCK))
    return actor_frame(verdict,retired,quit,extraction)


OBSERVER_CODES=('launch','window','renderer','renderer-proc-unavailable','quit','extraction','record','pass')
ACTOR_CODES=('display','transport',*OBSERVER_CODES)


READBACK_STATES=('pass','fail','unreached')
LIFECYCLE_KEYS=('quit','extraction','xvfb','processes')
LIFECYCLE_STAGES=tuple('native_independent_'+key for key in LIFECYCLE_KEYS)


def check_retirement(quit,extraction):
    need(quit in READBACK_STATES and extraction in READBACK_STATES and
         ((extraction!='unreached')==(quit=='pass')),'native-retirement-order')


def check_outcome(value,quit,extraction):
    check_retirement(quit,extraction)
    if value in ('display','transport'):
        need(quit==extraction=='unreached','native-retirement-before-observer')
    if value in ('record','pass'):
        need(quit==extraction=='pass','native-retirement-before-record')
    if value=='quit':
        need((quit,extraction)==('fail','unreached'),'native-quit-refusal-shape')
    if value=='extraction':
        need((quit,extraction)==('pass','fail'),'native-extraction-refusal-shape')


def parse_observer(code,out):
    found=re.fullmatch(rb'HUB_OBSERVER ([a-z-]+) (pass|fail|unreached) (pass|fail|unreached)\n',out)
    need(found is not None,'native-observer-frame')
    value,quit,extraction=(part.decode('ascii') for part in found.groups())
    need(value in OBSERVER_CODES and code==(0 if value=='pass' else 78),'native-observer-exit-and-frame')
    check_outcome(value,quit,extraction)
    return value,quit,extraction


def actor_frame(verdict,retired,quit,extraction):
    need(verdict in ACTOR_CODES and type(retired) is bool,'native-actor-result')
    check_outcome(verdict,quit,extraction)
    flag='retired' if retired else 'retirement-failed'
    return f'HUB_PORTABLE_OBSERVER {verdict} {flag} {quit} {extraction}\n'.encode('ascii')


def parse_actor(response):
    found=re.fullmatch(rb'HUB_PORTABLE_OBSERVER ([a-z-]+) (retired|retirement-failed) '
                       rb'(pass|fail|unreached) (pass|fail|unreached)\n',response)
    need(found is not None,'native-observer-actor-frame')
    value,flag,quit,extraction=(part.decode('ascii') for part in found.groups())
    retired=flag=='retired'
    need(actor_frame(value,retired,quit,extraction)==response,'native-observer-actor-frame')
    return value,retired,quit,extraction


def process_retirement(uid):
    try:
        # The caller has already reaped the nonroot actor with both streams closed.
        guest_closure.closed((),exact_zero_exit=True,output_and_stderr_eof=True,
                             sample_owned=lambda:guest_closure.sample(uid))
    except (OSError,ValueError):
        return 'fail'
    return 'pass'


def lifecycle_frame(nonce,quit,extraction,xvfb,processes):
    check_retirement(quit,extraction)
    need(re.fullmatch('[a-f0-9]{64}',nonce) and
         xvfb in ('pass','fail') and processes in ('pass','fail'),'native-lifecycle-frame')
    return f'HUB_JAMMY_LIFECYCLE {nonce} {quit} {extraction} {xvfb} {processes}'


def report_actor(plan,result):
    # Derive the reached prefix from the producer's fixed first failure.
    value,retired,_,_=result
    failed={'display':'display','transport':'launch','launch':'launch','window':'window',
            'renderer':'renderer','renderer-proc-unavailable':'renderer',
            'quit':'quit','extraction':'extraction','record':'record','pass':None}[value]
    for name in ('display','launch','window','renderer','quit','extraction','record','display_retirement'):
        stage='native_observer_'+name
        success=name!=failed and (name!='display_retirement' or retired)
        refusal={'renderer-proc-unavailable':'fail-proc-unavailable',
                 'transport':'fail-transport'}.get(value,'fail')
        mark(plan,stage,'pass' if success else refusal)
        need(success,'native-observer-'+name)

def capture_observer(node,tools,env):
    # Use the exact bounded subprocess helper from the stock witness, with isolated cwd.
    import runtime_provision as g
    return g.control([str(node),str(tools/'runtime-observer.mts')],env,monotonic()+90,90,cwd=tools)


def read_inventory(plan):
    return json.loads(stock.read(ROOT/'inventory.jsn',image.METADATA_LIMIT,plan['imageInventorySHA256']),
                      object_pairs_hook=pair.closed_object)


def image_budget(plan):
    receipt=read_inventory(plan)
    authority=handoff.Attempt(**plan['header']['attempt'])
    entries=image.verify(authority,plan['header'],receipt,plan['imageInventorySHA256'])
    need(plan['grant']==image.grant_identity(plan['nonce'],receipt,plan['imageInventorySHA256'],
                                            plan['observerLock']),'native-appimage-grant')
    return image.budget(receipt['artifact'][1],entries,plan,provisioned=1)


def supervisor(plan):
    authority=handoff.Attempt(**plan['header']['attempt'])
    deadlines=monotonic()+375-float(Path('/proc/uptime').read_text().split()[0])
    phases=plan
    with phase(phases,'native_stock'):
        mounted()
        first=Provision(plan,0,deadlines-120)
        first.identity()
        account=x.credentials()
        need(not guest_closure.sample(account.pw_uid),'native-empty-dedicated-user')
    with phase(phases,'native_custody'):
        proof=native.original_tar(PORTABLE,authority,plan['header'],plan['pairSHA256'],
            deadlines,Path('/proc/self/mountinfo').read_text())
        needed=image_budget(plan)
        need(needed['guestCopy']==plan['guestCopy'] and proof['recordSHA256']==plan['header']['members'][4][2],
             'native-appimage-census-binding')
    with phase(phases,'native_guest_storage'):
        first.grow()
        first.space(gate.DISK_FLOOR+plan['guestCopy']+212*2**20)
    with phase(phases,'native_display_apt'):
        first.run_exact()
    with phase(phases,'native_runtime_apt'):
        extra=Provision(plan,1,deadlines-115)
        extra.run_exact()
    with phase(phases,'native_display_capability'):
        helper=x.Display(deadlines-105)
        for action in (helper.parent,helper.userns,helper.tools):
            action()
        extra.network()
    with phase(phases,'native_ready'):
        gate.check_guest_space(os.statvfs('/'),plan['guestCopy'],12000)
        extra.command(['/usr/bin/sync','-f','/'],8)
    with phase(phases,'native_prelaunch_grant'):
        native_control.guest_control(plan['grant'],min(deadlines-100,monotonic()+30))
    with phase(phases,'native_files'):
        facts=run_as(account,plan,'stage',75,deadlines-80)
        facts=json.loads(facts,object_pairs_hook=pair.closed_object)
        original=plan['header']['members'][2]
        need(facts=={'sha256':original[2],'bytes':original[1]},'native-staged-appimage-digest')
        archive=Path(account.pw_dir)/'case/original'/handoff.APPIMAGE
        receipt=read_inventory(plan)
        record={'asset':handoff.APPIMAGE,'archive':{'path':str(archive),'size':original[1],'sha256':original[2]},
                'roles':receipt['roles']}
        protected_output(ROOT/'binding.json',pair.canonical(record))
    with phase(phases,'native_post_staging_floor'):
        gate.check_guest_space(os.statvfs('/'),0,12000)
        need(not guest_closure.sample(account.pw_uid),'native-no-stage-processes')
    with phase(phases,'native_observer_actor_frame'):
        response=run_as(account,plan,'launch',105,deadlines)
        result=parse_actor(response)
    _,retired,quit,extraction=result
    processes=process_retirement(account.pw_uid)
    report=lifecycle_frame(plan['nonce'],quit,extraction,'pass' if retired else 'fail',processes)
    with open('/dev/ttyS0','w',encoding='ascii') as console:
        print(report,file=console,flush=True)
    report_actor(phases,result)
    mark(phases,'native_window_renderer_quit','pass')
    with phase(phases,'native_process_retirement'):
        need(processes=='pass','native-owned-processes-retained')
    with phase(phases,'native_owned_retirement'):
        destination=Path(account.pw_dir)/'case'
        need(destination==destination.resolve() and destination.lstat().st_uid==account.pw_uid and
             stat.S_IMODE(destination.lstat().st_mode)==0o700 and shutil.rmtree.avoids_symlink_attacks,
             'native-private-user-retirement')
        shutil.rmtree(destination)
        need(not os.path.lexists(destination),'native-owned-removal')
        extra.network()


def main():
    os.umask(0o077)
    plan=read_doc(ROOT/'plan.json',16384)
    if sys.argv[1:]==['stage']:
        print(json.dumps(actor_stage(plan),sort_keys=True))
    elif sys.argv[1:]==['launch']:
        os.write(1,actor_launch(plan))
    else:
        need(sys.argv[1:]==[],'native-guest-mode')
        supervisor(plan)


if __name__=='__main__':
    try:
        main()
    except BaseException:
        raise SystemExit(78) from None
