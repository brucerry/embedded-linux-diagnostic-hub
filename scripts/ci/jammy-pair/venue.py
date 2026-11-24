"""One public-input, no-product QEMU TCG venue witness for the exact first branch push."""

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from hashlib import file_digest
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import tarfile
from threading import Event, Thread
from time import monotonic, sleep, time
from urllib.parse import urlsplit

from native_seed import GUEST_STAGES, PROPOSED_BRANCH, boot_evidence, need, seed, plan_for
import native_control
from runtime_gate import MODEL_CAP, inode
from runtime_intake import prepare_runtime


REPO = 'brucerry/embedded-linux-diagnostic-hub'
WORKFLOW = '.github/workflows/v060-jammy-portable-archive-runtime.yml'
HERE = Path(__file__).resolve().parent
INPUTS_SHA = '40191a0314b7be4863fc3c552dff7ed6155d89ff9290186687eb5354f677e736'
DOCKER = '/usr/bin/docker'
DAEMON = (DOCKER,'--host=unix:///var/run/docker.sock')
MIB = 2**20
FLOOR = 6*2**30
OVERLAY_LIMIT = MODEL_CAP
GUEST_SIZE = 2361393152
EXPANDED_SIZE = 7*2**30
INTAKE_STAGES = ('public_intake','members','guest_signature','guest_signed_row','sealed_inputs')
PREPARE_TOOLS = ('genisoimage','isoinfo','qemu-img','qemu-system-x86_64')
PREPARE_FRAMES = (
    ('prepare_shell',b'WORKER_STARTED'),
    ('prepare_identity',b'WORKER_IDENTITY'),
    ('prepare_isolation',b'WORKER_ISOLATION'),
    ('prepare_seals',b'WORKER_SEALS'),
    ('prepare_ready',b'WORKER_READY'),
    *((f'tool_{index}_{stage}',f'TOOL_{tool}_{token}'.encode())
      for index,tool in enumerate(PREPARE_TOOLS,1)
      for stage,token in (('list','LISTED'),('map','MAPPED'))),
    ('seed',b'SEED_PASS'),
    ('overlay_worker',b'OVERLAY_PASS'),
)
BOOT_RESULTS = (*GUEST_STAGES,'boot_exit','boot_stderr','boot_retired')
BOOT_ATTACH_REFUSALS = ('boot_attach_deadline','boot_attach_output_bound')
STAGES = ('context','pre_intake','oci_pull','oci_identity',*INTAKE_STAGES,'post_intake',
          'prepare_create','prepare_config','prepare_mounts','prepare_attach',
          *(stage for stage,_ in PREPARE_FRAMES),'prepare_exit','prepare_retired','overlay',
          'product_readonly_media_sealed','runtime_media_sealed','host_runtime_grant',
          'pre_boot','boot_create','boot_config','boot_mounts','boot_attach',
          *BOOT_RESULTS,'post_boot','retirement')
OPT = {'PATH':'/usr/bin:/bin','LC_ALL':'C'}


def remaining(deadline, maximum):
    left = min(deadline-monotonic(),maximum)
    need(left > 0,'deadline')
    return left


def capture(argv, env, deadline, maximum, stdout_cap=32768, stderr_cap=8192):
    end = monotonic()+remaining(deadline,maximum)
    child = subprocess.Popen(argv,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE,start_new_session=True)
    buffers = {child.stdout:bytearray(),child.stderr:bytearray()}
    caps = {child.stdout:stdout_cap,child.stderr:stderr_cap}
    try:
        with selectors.DefaultSelector() as reader:
            for pipe in buffers:
                os.set_blocking(pipe.fileno(),False)
                reader.register(pipe,selectors.EVENT_READ)
            while reader.get_map():
                ready = reader.select(remaining(end,maximum))
                need(ready,'pipe-timeout')
                for key, _ in ready:
                    pipe = key.fileobj
                    block = os.read(key.fd,min(65536,caps[pipe]-len(buffers[pipe])+1))
                    if block:
                        buffers[pipe].extend(block)
                        need(len(buffers[pipe]) <= caps[pipe],'pipe-bound')
                    else:
                        reader.unregister(pipe)
        code = child.wait(timeout=remaining(end,maximum))
        return code,bytes(buffers[child.stdout]),bytes(buffers[child.stderr])
    finally:
        if child.returncode is None:
            try:
                os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=3)
        for pipe in buffers:
            pipe.close()


def command(argv, env, deadline, maximum, **kwargs):
    code,out,err = capture(argv,env,deadline,maximum,**kwargs)
    need(code == 0 and not err,'command-status')
    return out


def pinned(path, maximum, pin=None, size=None):
    flags = os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
    with os.fdopen(os.open(path,flags),'rb') as body:
        first = os.fstat(body.fileno())
        need(stat.S_ISREG(first.st_mode) and 0 < first.st_size <= maximum and first.st_nlink == 1
             and first.st_uid == os.getuid() and (size is None or first.st_size == size)
             and not first.st_mode & 0o7022,'file-properties')
        digest = file_digest(body,'sha256').hexdigest()
        after = os.fstat(body.fileno())
        signature = (first.st_dev,first.st_ino,first.st_size,first.st_mtime_ns,first.st_ctime_ns)
        need(signature == (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
             and (pin is None or pin == digest),'file-digest')
        return (first.st_size,digest)


def write_new(path, data):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_NOFOLLOW|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC,0o400),'wb') as body:
        body.write(data)


HTTP_STATUS_REFUSALS = {
    b'401':'http_401', b'403':'http_403', b'404':'http_404',
    b'407':'http_407', b'429':'http_429', b'451':'http_451',
}
HTTP_CLASS_REFUSALS = {
    b'2':'http_other_2xx', b'3':'http_3xx', b'4':'http_other_4xx', b'5':'http_5xx',
}
INPUT_REFUSALS = frozenset({
    *HTTP_STATUS_REFUSALS.values(), *HTTP_CLASS_REFUSALS.values(),
    'byte_ceiling','transport_timeout','transport','http_framing',
    'url_pin','wrong_length','pinned_bytes','tool_or_deadline','archive_members',
})


class InputRefusal(ValueError):
    def __init__(self, label):
        super().__init__(label if label in INPUT_REFUSALS else 'tool_or_deadline')


def fetch(url, path, size, digest, deadline):
    address = urlsplit(url)
    if not (address.scheme == 'https' and not address.query and not address.fragment and
            address.netloc in ('cloud-images.ubuntu.com','snapshot.ubuntu.com') and
            re.fullmatch(r'/[A-Za-z0-9_.+/~%-]+',address.path) and '..' not in PurePosixPath(address.path).parts):
        raise InputRefusal('url_pin')
    secs = max(1,int(remaining(deadline,100)))
    code, out, err = capture(['/usr/bin/curl','-q','--silent','--show-error','--fail','--proto','=https',
                   '--retry','0','--connect-timeout','6','--max-time',str(secs),'--max-filesize',str(size),
                   '--output',str(path),'--write-out','%{http_code}',url],
                  OPT,deadline,secs+1,stdout_cap=16)
    # Publish only a fixed label for a known status. Response headers and body stay private.
    if re.fullmatch(rb'[2345][0-9]{2}',out) and out != b'200':
        raise InputRefusal(HTTP_STATUS_REFUSALS.get(out,HTTP_CLASS_REFUSALS[out[:1]]))
    if code == 63:
        raise InputRefusal('byte_ceiling')
    if code == 28:
        raise InputRefusal('transport_timeout')
    if code != 0 or err:
        raise InputRefusal('transport')
    if out != b'200':
        raise InputRefusal('http_framing')
    if path.lstat().st_size != size:
        raise InputRefusal('wrong_length')
    try:
        pinned(path,size,digest,size)
    except ValueError as failure:
        raise InputRefusal('pinned_bytes') from failure


def extract_roles(pins, stage, fixture, deadline, archive_phase=None):
    requested = defaultdict(dict)
    for target,row in pins['members'].items():
        path = PurePosixPath(target)
        need(path.is_absolute() and path.parts[1]=='fixture' and 3 <= len(path.parts) <= 4 and
             '..' not in path.parts,'fixture-role-name')
        requested[row['archive']].setdefault(row['member'],[]).append((path,row))
    total = 0
    for archive, members in requested.items():
        with archive_phase(archive) if archive_phase is not None else nullcontext():
            total = extract_archive_members(stage,fixture,archive,members,total,deadline)


def extract_archive_members(stage, fixture, archive, members, total, deadline):
    raw = command(['/usr/bin/dpkg-deb','--fsys-tarfile',str(stage/(archive+'.deb'))],
                  OPT,deadline,14,stdout_cap=96*MIB)
    found = set()
    with tarfile.open(fileobj=BytesIO(raw),mode='r:') as stream:
        for item in stream:
            name = item.name.removeprefix('./')
            if name not in members:
                continue
            need(name not in found and item.isreg() and item.uid == item.gid == 0 and
                 item.mode in (0o644,0o755) and 0 < item.size <= 48*MIB,'archive-member')
            found.add(name)
            with stream.extractfile(item) as body:
                data = body.read(item.size+1)
            for target,row in members[name]:
                need(row['size'] is None or item.size == row['size'],'archive-member-size')
                total += item.size
                need(total <= 256*MIB,'fixture-volume-cap')
                dst = fixture.joinpath(*target.parts[2:])
                dst.parent.mkdir(mode=0o700,exist_ok=True)
                write_new(dst,data)
                pinned(dst,item.size,row['sha256'],item.size)
                if target.parts[2] in ('bin','lib'):
                    dst.chmod(0o500)
    need(found == set(members),'archive-roster')
    return total


def context():
    env = os.environ
    need(os.getuid() == os.geteuid() != 0 and os.getgid() != 0 and os.uname().machine == 'x86_64' and
         env.get('RUNNER_ENVIRONMENT')=='github-hosted' and env.get('RUNNER_OS')=='Linux' and
         env.get('RUNNER_ARCH')=='X64' and env.get('GITHUB_REPOSITORY')==REPO and
         env.get('GITHUB_REF')==PROPOSED_BRANCH and env.get('GITHUB_EVENT_NAME')=='push' and
         env.get('GITHUB_RUN_ATTEMPT')=='1' and env.get('GITHUB_JOB')=='two-format' and
         env.get('GITHUB_WORKFLOW_REF')==f'{REPO}/{WORKFLOW}@{PROPOSED_BRANCH}' and
         re.fullmatch(r'[a-f0-9]{40}',env.get('GITHUB_SHA','')) and
         env['GITHUB_SHA']==env.get('GITHUB_WORKFLOW_SHA'),'venue-context')
    event_file = Path(env['GITHUB_EVENT_PATH'])
    event = json.loads(event_file.read_bytes())
    need(event.get('after')==env['GITHUB_SHA'] and event.get('ref')==PROPOSED_BRANCH and
         event.get('created') is True and event.get('forced') is False and event.get('deleted') is False and
         event.get('repository',{}).get('private') is False,'first-branch-creation')
    run = env['GITHUB_RUN_ID']
    need(re.fullmatch(r'[1-9][0-9]{0,18}',run),'run-id')
    temp = Path(env['RUNNER_TEMP'])
    need(temp == temp.resolve(strict=True) and temp.stat().st_uid == os.getuid(),'runner-temp')
    for binary in (DOCKER,'/usr/bin/curl','/usr/bin/gpgv','/usr/bin/dpkg-deb'):
        item = Path(binary).resolve(strict=True).stat()
        need(stat.S_ISREG(item.st_mode) and item.st_uid==0 and not item.st_mode&0o7022,'stock-host-tool')
    return temp,run


def capacity(roles):
    devices = defaultdict(list)
    for path,cost in roles:
        need(path == path.resolve(strict=True),'backing-path')
        info = path.stat()
        fs = os.statvfs(path)
        need(not fs.f_flag & os.ST_RDONLY and fs.f_favail >= 4096,'backing-attributes')
        devices[info.st_dev].append((fs.f_bavail*fs.f_frsize,cost))
    need(all(min(free for free,_ in rows) >= FLOOR+sum(cost for _,cost in rows)
             for rows in devices.values()),'phase-backing')


class OwnedWorker:
    def __init__(self, identifier, phase, stage, image, cfg_digest, env):
        self.name = 'hub-jammy-venue-'+identifier+'-'+phase
        self.phase, self.stage, self.image, self.cfg_digest, self.env = phase,stage,image,cfg_digest,env
        self.pending = False
        self.cid = None

    def docker(self, *args, deadline, seconds=8):
        return command([*DAEMON,*args],self.env,deadline,seconds)

    def find(self, deadline):
        raw = self.docker('ps','-aq','--no-trunc','--filter',f'name=^/{self.name}$',deadline=deadline)
        rows = raw.decode('ascii').splitlines()
        need(len(rows) <= 1 and all(re.fullmatch(r'[a-f0-9]{64}',row) for row in rows),'worker-name')
        return rows[0] if rows else None

    def inspect(self, cid, deadline):
        row, = json.loads(self.docker('container','inspect',cid,deadline=deadline))
        need(row['Id']==cid and row['Name']=='/'+self.name and row['Image']==self.cfg_digest and
             row['Config']['Labels'].get('hub-jammy-venue-owner')==self.name,'worker-identity')
        return row

    def launch(self, deadline, maximum, phase=None, grant=None):
        if phase is None:
            phase = lambda _stage: nullcontext()
        with phase(self.phase+'_create'):
            self.create(deadline)
        with phase(self.phase+'_config'):
            row = self.check_config(deadline)
        with phase(self.phase+'_mounts'):
            self.check_mounts(row)
        with phase(self.phase+'_attach'):
            if grant is None:
                return capture([*DAEMON,'start','--attach',self.cid],self.env,deadline,maximum,
                               stdout_cap=256*1024,stderr_cap=8192)
            return self.attach_with_grant(deadline,maximum,phase,*grant)

    def attach_with_grant(self,deadline,maximum,phase,bound,required):
        need(self.phase=='boot','native-only-boot-grant')
        work=self.stage/'work'
        identity=inode((work/'disk.qcow2').lstat())
        stopped=Event()
        result=[]
        def grant_when_owned():
            try:
                with phase('host_runtime_grant'):
                    while not os.path.lexists(work/native_control.SOCK_LEAF):
                        need(not stopped.is_set() and monotonic()<deadline,'native-socket-unreached')
                        sleep(.05)
                    actual=self.inspect(self.cid,deadline)
                    state=actual['State']
                    need(state['Running'] is True and state['Status']=='running' and
                         type(state['Pid']) is int and state['Pid']>1,'native-live-worker')
                    pid=state['Pid']
                    owner=native_control.Worker(pid,native_control.start_readback(pid),os.getuid(),os.getgid())
                    native_control.host_work(work,identity,OVERLAY_LIMIT,required,owner,bound,deadline,
                                              cancelled=stopped.is_set)
                result.append(True)
            except BaseException:
                result.append(False)
        monitor=Thread(target=grant_when_owned,daemon=True)
        monitor.start()
        try:
            capture_result=capture([*DAEMON,'start','--attach',self.cid],self.env,deadline,maximum,
                                   stdout_cap=256*1024,stderr_cap=8192)
        finally:
            stopped.set()
            monitor.join(timeout=10)
            need(not monitor.is_alive() and len(result)==1,'native-grant-thread-closure')
        return capture_result

    def create(self, deadline):
        need(self.find(deadline) is None,'worker-preexisting')
        uid,gid = os.getuid(),os.getgid()
        args = ['create','--pull=never','--platform=linux/amd64','--name',self.name,
                '--label','hub-jammy-venue-owner='+self.name,'--network=none','--read-only',
                '--ipc=none','--cap-drop=ALL','--security-opt=no-new-privileges',
                '--user',f'{uid}:{gid}','--log-driver=none','--no-healthcheck','--pids-limit=128',
                '--ulimit',f'fsize={OVERLAY_LIMIT}:{OVERLAY_LIMIT}','--cpus=2','--memory=3g']
        for leaf in ('fixture','input','work'):
            args += ['--mount',f'type=bind,source={self.stage/leaf},target=/{leaf}'+
                     (',readonly' if leaf!='work' else '')]
        self.pending = True
        cid = self.docker(*args,'--entrypoint','/bin/bash',self.image,'--noprofile','--norc',
                          '/fixture/venue-worker.sh',self.phase,deadline=deadline).decode().strip()
        need(re.fullmatch(r'[a-f0-9]{64}',cid),'worker-create')
        self.cid = cid

    def check_config(self, deadline):
        row = self.inspect(self.cid,deadline)
        host,config = row['HostConfig'],row['Config']
        uid,gid = os.getuid(),os.getgid()
        limits = {item['Name']:(item['Soft'],item['Hard']) for item in host['Ulimits']}
        need(host['NetworkMode']=='none' and host['IpcMode']=='none' and host['ReadonlyRootfs'] is True
             and host['Privileged'] is False and not host['CapAdd'] and host['CapDrop']==['ALL']
             and set(host['SecurityOpt']) in ({'no-new-privileges'},{'no-new-privileges=true'})
             and not host['Devices'] and not host['DeviceRequests'] and host['LogConfig']['Type']=='none'
             and host['PidMode']=='' and host['AutoRemove'] is False and not host['PortBindings']
             and limits.get('fsize')==(OVERLAY_LIMIT,OVERLAY_LIMIT) and config['User']==f'{uid}:{gid}'
             and host['PidsLimit']==128 and host['Memory']==3*2**30 and host['NanoCpus']==2*10**9
             and config['Entrypoint']==['/bin/bash'] and
             config['Cmd']==['--noprofile','--norc','/fixture/venue-worker.sh',self.phase]
             and config['Tty'] is False and config['OpenStdin'] is False and row['State']['Status']=='created',
             'worker-isolation')
        return row

    def check_mounts(self, row):
        actual = {(m['Type'],m['Source'],m['Destination'],m['RW']) for m in row['Mounts']}
        expected = {('bind',str(self.stage/leaf),'/'+leaf,leaf=='work') for leaf in ('fixture','input','work')}
        need(actual == expected and len(row['Mounts']) == 3,'worker-mounts')

    def retire(self, deadline):
        if not self.pending:
            return
        cid = self.find(deadline)
        need(cid is not None and (self.cid is None or cid==self.cid),'worker-ownership-uncertain')
        state = self.inspect(cid,deadline)['State']
        if state['Running']:
            self.docker('stop','--time','2',cid,deadline=deadline,seconds=10)
        state = self.inspect(cid,deadline)['State']
        need(state['Status'] in ('exited','created') and state['Running'] is False and state['Pid']==0,
             'worker-not-stopped')
        self.docker('rm',cid,deadline=deadline)
        need(self.find(deadline) is None,'worker-not-retired')
        self.pending = False

    def normal_terminal(self, deadline):
        state = self.inspect(self.cid,deadline)['State']
        return (state['Status']=='exited' and state['Running'] is False and state['Pid']==0
                and type(state['ExitCode']) is int and state['ExitCode']==0
                and state['OOMKilled'] is False and state['Error']=='')


def overlay_and_seed(stage):
    work, source = stage/'work',stage/'input'
    expected = {'seed.iso','disk.qcow2','vars.fd','chain.json'}
    need({p.name for p in work.iterdir()} == expected,'workspace-roster')
    seed_file = work/'seed.iso'
    seed_pin = pinned(seed_file,MIB)[1]
    with seed_file.open('rb') as medium:
        medium.seek(16*2048)
        header = medium.read(2048)
    need(header[:7]==b'\1CD001\1' and header[40:72].strip()==b'CIDATA','cidata-volume')
    pinned(work/'chain.json',24*1024)
    pinned(work/'disk.qcow2',OVERLAY_LIMIT)
    disk, base = json.loads((work/'chain.json').read_bytes())
    need(disk['filename']=='/work/disk.qcow2' and disk['backing-filename']=='/input/jammy.qcow2'
         and disk['full-backing-filename']=='/input/jammy.qcow2' and disk['backing-filename-format']=='qcow2'
         and base['filename']=='/input/jammy.qcow2' and 'backing-filename' not in base
         and (disk['virtual-size'],base['virtual-size'])==(EXPANDED_SIZE,GUEST_SIZE)
         and all(row['format']=='qcow2'
                 and 'data-file' not in row.get('format-specific',{}).get('data',{}) for row in (disk,base)),
         'qcow-backing-chain')
    with (work/'disk.qcow2').open('rb') as image:
        header = image.read(112)
        magic,version,offset,size,_,virtual = struct.unpack_from('>4sIQIIQ',header)
        need((magic,version,virtual)==(b'QFI\xfb',3,EXPANDED_SIZE) and 104 <= offset <= MIB
             and size==len(b'/input/jammy.qcow2') and int.from_bytes(header[72:80],'big')==0,
             'qcow-backing-header')
        image.seek(offset)
        need(image.read(size)==b'/input/jammy.qcow2','qcow-backing-path')
    vars_path = work/'vars.fd'
    need(stat.S_IMODE(vars_path.lstat().st_mode)==0o600,'private-writable-firmware-variables')
    vars_pin = pinned(vars_path,8*MIB)[1]
    need(vars_pin==pinned(stage/'fixture/firmware/OVMF_VARS_4M.fd',8*MIB)[1],'fresh-firmware-variables')
    seed_file.chmod(0o400)
    seed_file.rename(source/'seed.iso')
    old = source/'SHA256SUMS'
    content = old.read_bytes()+f'{seed_pin}  /input/seed.iso\n'.encode()
    old.unlink()
    write_new(old,content)
    write_new(work/'READONLY.SHA256',f'{vars_pin}  /work/vars.fd\n'.encode())
    return seed_pin


def assemble(pins, stage, env, deadline, phase, results, product):
    download, fixture, inputs = (stage/part for part in ('download','fixture','input'))
    products = []
    archive_id = {}
    for name,row in sorted(pins['archives'].items()):
        need(re.fullmatch(r'[a-z0-9.+-]+',name),'package-key')
        archive_id[name] = f'input_{len(products)+1:02}'
        products.append((archive_id[name],row['url'],download/(name+'.deb'),
                         row['compressed_bytes'],row['sha256']))
    guest = pins['guest']
    prefix = guest['url'].rsplit('/',1)[0]+'/'
    need(set(guest['metadata'])=={'SHA256SUMS','SHA256SUMS.gpg'},'signature-input')
    for name, item in sorted(guest['metadata'].items()):
        products.append((f'input_{len(products)+1:02}',prefix+name,download/name,item['bytes'],item['sha256']))
    products.append((f'input_{len(products)+1:02}',guest['url'],inputs/'jammy.qcow2',guest['size'],guest['sha256']))
    need(len(products)==55,'input-census')

    def checked(product):
        index, *fetch_args = product
        results[index] = 'fail_tool_or_deadline'
        try:
            fetch(*fetch_args,deadline)
        except InputRefusal as failure:
            results[index] = 'fail_'+str(failure)
            raise
        results[index] = 'pass'

    with phase('public_intake'):
        # Never restart or follow a rejected transfer. Only the current bounded batch can be in flight.
        with ThreadPoolExecutor(max_workers=8) as executor:
            for offset in range(0,len(products),8):
                list(executor.map(checked,products[offset:offset+8]))

    @contextmanager
    def archive_phase(name):
        index = archive_id[name]
        results[index] = 'fail_archive_members'
        row = pins['archives'][name]
        pinned(download/(name+'.deb'),row['compressed_bytes'],row['sha256'],row['compressed_bytes'])
        yield
        results[index] = 'pass'

    with phase('members'):
        extract_roles(pins,download,fixture,deadline,archive_phase)
    with phase('guest_signature'):
        verify_guest_signature(guest,stage,env,deadline)
    with phase('guest_signed_row'):
        verify_guest_row(guest,download)
    with phase('sealed_inputs'):
        return seal_fixture(pins,fixture,inputs,download,product)


def verify_guest_signature(guest, stage, env, deadline):
    download = stage/'download'
    code, sig, _ = capture(['/usr/bin/gpgv','--homedir',str(stage/'gpg-empty'),'--status-fd','1','--keyring',
                           str(stage/'fixture/data/ubuntu-cloudimage-keyring.gpg'),str(download/'SHA256SUMS.gpg'),
                           str(download/'SHA256SUMS')],env,deadline,8)
    need(code==0 and re.findall(rb'(?m)^\[GNUPG:\] VALIDSIG ([A-F0-9]{40}) (\S+) ',sig)==[
        (guest['publisherSignatureFromPriorReceipt'].encode(),b'2026-11-14')]
        and not re.search(rb'(?m)^\[GNUPG:\] (BADSIG|ERRSIG|EXPKEYSIG|EXPSIG|REVKEYSIG|KEYREVOKED|NO_PUBKEY)\b',sig),
        'guest-detached-signature')


def verify_guest_row(guest, download):
    rows = re.findall(rb'(?m)^([a-f0-9]{64}) \*'+re.escape(guest['name'].encode())+rb'$',(download/'SHA256SUMS').read_bytes())
    need(rows==[guest['sha256'].encode()],'guest-signed-checksum')


def seal_fixture(pins, fixture, inputs, download, product):
    nonce = secrets.token_hex(32)
    for name, value in seed(nonce,product).items():
        write_new(inputs/name,value)
    for script in ('venue-worker.sh','venue-loader.sh'):
        write_new(fixture/script,(HERE/script).read_bytes())
    for name, maps in pins['loaderMaps'].items():
        write_new(fixture/(name+'.map'),''.join(f'{soname} {path} {pin}\n'
                  for soname,(path,pin) in sorted(maps.items())).encode())
    for folder in (fixture,inputs):
        records = []
        for path in sorted(folder.rglob('*')):
            if path.is_file():
                records.append(f'{pinned(path,768*MIB)[1]}  /{folder.name}/{path.relative_to(folder)}\n')
        write_new(folder/'SHA256SUMS',''.join(records).encode())
    shutil.rmtree(download)
    return nonce


def prepare_receipt(out,phase):
    for name,token in PREPARE_FRAMES:
        with phase(name):
            line, separator, out = out.partition(b'\n')
            need(separator and line==token,'prepare-ordered-receipt')
    return out


def main(stages,product):
    os.umask(0o077)
    scratch, owner = None,None
    workers = []

    @contextmanager
    def phase(name):
        stages[name] = 'fail'
        yield
        stages[name] = 'pass'

    try:
        with phase('context'):
            temp, run = context()
            started = monotonic()
            prepare_end, boot_stop, retire_end = started+240,started+640,started+710
            source = HERE/'venue-inputs.json'
            pinned(source,256*1024,INPUTS_SHA)
            pins = json.loads(source.read_bytes())
            need(len(pins['archives'])==52 and len(pins['members'])==64,'pinned-input-census')
            import tempfile
            scratch = Path(tempfile.mkdtemp(dir=temp,prefix='hjr-'))
            stamp = scratch.stat()
            owner = stamp.st_dev,stamp.st_ino,stamp.st_uid
            for part in ('fixture','input','work','download','gpg-empty','docker'):
                (scratch/part).mkdir(mode=0o700)
            env = OPT|{'HOME':str(scratch),'DOCKER_CONFIG':str(scratch/'docker')}
        worker_id = run+'-'+secrets.token_hex(5)
        with phase('pre_intake'):
            info = json.loads(command([*DAEMON,'info','--format','{{json .}}'],env,prepare_end,10))
            need(info['Architecture'] in ('amd64','x86_64') and info['OSType']=='linux' and
                 'name=seccomp,profile=builtin' in info['SecurityOptions'] and
                 info['Driver'] in ('overlay2','overlayfs') and info['DockerRootDir']=='/var/lib/docker',
                 'stock-docker')
            docker_backing = [Path('/var/lib/docker')]
            if info['Driver']=='overlayfs':
                docker_backing.append(Path('/var/lib/containerd'))
            stage_bytes = pins['guest']['size']+(96+256+136+128+64)*MIB+OVERLAY_LIMIT+product.medium_bytes
            image_cost = pins['stockLayerBytes']+pins['stockLayerExpandedBytes']+64*MIB
            capacity([(scratch,stage_bytes),*((p,image_cost) for p in docker_backing)])
        image = pins['stockImage']
        with phase('oci_pull'):
            command([*DAEMON,'pull','--platform=linux/amd64',image],env,prepare_end,65)
        with phase('oci_identity'):
            actual, = json.loads(command([*DAEMON,'image','inspect',image],env,prepare_end,8))
            need((actual['Id'],actual['Os'],actual['Architecture'])==(pins['stockConfig'],'linux','amd64')
                 and not actual['Config'].get('Volumes') and not actual['Config'].get('Healthcheck'),'stock-oci-digest')
        with phase('runtime_media_sealed'):
            supplemental=prepare_runtime(scratch,fetch,prepare_end)
            transfer=pinned(product.directory.parent/'observer.iso',64*MIB,
                            product.observer['receipt']['sha256'],product.observer['receipt']['bytes'])
            need(transfer==(product.observer['receipt']['bytes'],product.observer['receipt']['sha256']),
                 'observer-parent-media')
            destination=scratch/'input'/'observer.iso'
            need(not os.path.lexists(destination),'observer-custody-destination')
            (product.directory.parent/'observer.iso').rename(destination)
            supplemental['observer.iso']=product.observer['receipt']
        nonce = assemble(pins,scratch,env,prepare_end,phase,stages,product)
        with phase('product_readonly_media_sealed'):
            product_media=product.seal(scratch/'input'/'product.iso',prepare_end)
            file=scratch/'input'/'SHA256SUMS'
            content=file.read_bytes()+f"{product_media['sha256']}  /input/product.iso\n".encode()
            file.unlink()
            write_new(file,content)
        with phase('post_intake'):
            capacity([(scratch,OVERLAY_LIMIT+16*MIB),*((p,0) for p in docker_backing)])
            need(int(re.search(r'(?m)^MemAvailable:\s+(\d+) kB$',Path('/proc/meminfo').read_text())[1])
                 >=4*1024**2,'stock-memory')
        preparer = OwnedWorker(worker_id,'prepare',scratch,image,pins['stockConfig'],env)
        workers.append(preparer)
        code,out,err = preparer.launch(prepare_end,100,phase)
        remainder = prepare_receipt(out,phase)
        with phase('prepare_exit'):
            need(code==0 and not err and not remainder and preparer.normal_terminal(prepare_end),'prepare-exit')
        with phase('prepare_retired'):
            preparer.retire(prepare_end)
        with phase('overlay'):
            seed_hash = overlay_and_seed(scratch)
        with phase('pre_boot'):
            capacity([(scratch,OVERLAY_LIMIT+320*MIB),*((p,0) for p in docker_backing)])
        boot_deadline = min(monotonic()+400,boot_stop)
        guest = OwnedWorker(worker_id,'boot',scratch,image,pins['stockConfig'],env)
        workers.append(guest)
        try:
            code, out, err = guest.launch(boot_deadline,400,phase,
                grant=(plan_for(nonce,product)['grant'],product.required_overlay))
        except (ValueError,subprocess.TimeoutExpired) as failure:
            if stages.get('boot_attach')=='fail':
                if isinstance(failure,subprocess.TimeoutExpired) or str(failure) in ('deadline','pipe-timeout'):
                    stages['boot_attach_deadline']='fail'
                elif str(failure)=='pipe-bound':
                    stages['boot_attach_output_bound']='fail'
            raise
        stages['boot_stderr']='pass' if not err else 'fail'
        stages['boot_exit']='fail'
        if code==0 and guest.normal_terminal(retire_end):
            stages['boot_exit']='pass'
        with phase('boot_retired'):
            guest.retire(retire_end)
        evidence_error = None
        try:
            evidence = boot_evidence(out,nonce,product.header)
            stages.update({key:'pass' if value else 'fail' for key,value in evidence.items()})
        except (TypeError,ValueError) as error:
            evidence_error = error
        need(stages.get('boot_exit')=='pass' and not guest.pending,'guest-terminal')
        with phase('post_boot'):
            pinned(scratch/'input/seed.iso',MIB,seed_hash)
            pinned(scratch/'input/product.iso',product.medium_bytes,product_media['sha256'],product_media['bytes'])
            for item,receipt in supplemental.items():
                pinned(scratch/'input'/item,64*MIB,receipt['sha256'],receipt['bytes'])
            pinned(scratch/'input/jammy.qcow2',pins['guest']['size'],pins['guest']['sha256'],pins['guest']['size'])
            work = scratch/'work'
            path=work/native_control.SOCK_LEAF
            if os.path.lexists(path):
                meta=path.lstat()
                need(stat.S_ISSOCK(meta.st_mode) and meta.st_uid==os.getuid() and not meta.st_mode&0o077,
                     'closed-runtime-socket')
                path.unlink()
            need({p.name for p in work.iterdir()} ==
                 {'disk.qcow2','vars.fd','chain.json','READONLY.SHA256'},'boot-output-roster')
            pinned(work/'disk.qcow2',OVERLAY_LIMIT)
            pinned(work/'vars.fd',8*MIB,size=(scratch/'fixture/firmware/OVMF_VARS_4M.fd').stat().st_size)
            capacity([(scratch,0),*((p,0) for p in docker_backing)])
        need(evidence_error is None and stages.get('host_runtime_grant')=='pass' and all(stages.get(n)=='pass' for n in BOOT_RESULTS),'guest-provisioning-evidence')
    finally:
        if scratch is not None:
            with phase('retirement'):
                failures = []
                for worker in reversed(workers):
                    try:
                        worker.retire(retire_end)
                    except Exception as error:
                        failures.append(error)
                need(not failures,'worker-retirement-uncertain')
                stamp = scratch.lstat()
                need(owner==(stamp.st_dev,stamp.st_ino,stamp.st_uid) and scratch==scratch.resolve()
                     and shutil.rmtree.avoids_symlink_attacks,'scratch-ownership')
                shutil.rmtree(scratch)
                need(not os.path.lexists(scratch),'scratch-retirement')


def interrupted(signum, _frame):
    # A cancellation must unwind into the same bounded ownership checks as a timeout.
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    signal.signal(signal.SIGINT,signal.SIG_IGN)
    raise InterruptedError('venue-interrupted')


