"""Stage public inputs and launch exactly one isolated, build-only worker."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import sys
from time import monotonic
import shutil
import stat
import subprocess
import tempfile

import build_layout
import compiler_gate
import reader_input
import reproduction as providers
import tar_admission as pins
import runtime_input
import runtime_rebuild
from worker_protocol import (
    CLOSURE_STAGES, WORKER_STAGES, DIGEST_KEYS, EXTRACTION_POLICY_REVIEWED, VERIFIER_CONDITIONS,
)


CONTROL = Path(__file__).resolve().parent
BASE = '5e3c66f4a62e3606abdd650972e0f76b71ff5c54'
TEXT_TREE = '502caca5bac9c9c3ac8beb70d7b21aa3041f15f7'
IMAGE = 'docker.io/library/buildpack-deps@sha256:e7fdb09e2aacd2a32875a44be9caa1c18f3098b88620ac6a4bde84c0732c9f87'
CONFIG = 'sha256:f96221e29033048b6f577864f7718af5626d209f80345dde518058c29b6ce2cd'
BRANCH = 'refs/heads/ci/v060-jammy-corrected-appimage-originals-20261124'
REPO = 'brucerry/embedded-linux-diagnostic-hub'
WORKFLOW = '.github/workflows/v060-jammy-appimage-runtime.yml'
FLOOR = 4 * 1024**3
LABEL = 'org.hub.two-format'
OWNER_LABEL = 'org.hub.two-format-owner'
DOCKER = ['/usr/bin/docker', '--host=unix:///var/run/docker.sock']
CID = re.compile(r'[a-f0-9]{64}')
PRESTAGE_STAGES = (
    'host_docker_info', 'host_docker_platform', 'host_docker_seccomp', 'host_docker_driver',
    'host_docker_graph', 'host_docker_readback', 'host_scratch_readback', 'host_containerd_readback',
    'host_docker_floor', 'host_scratch_floor', 'host_containerd_floor',
)
VERIFIER_OUTPUTS = tuple('verifier_' + item for item in VERIFIER_CONDITIONS)
STAGES = ('context', *PRESTAGE_STAGES, 'host_space', 'inputs', 'runtime_rebuild', 'image_space', 'created',
          'isolation', *WORKER_STAGES, *VERIFIER_OUTPUTS, 'extraction', 'attach', 'worker_retired', 'scratch_retired')

class Refused(Exception):
    pass
PROC_MASKS = {f'/proc/{name}' for name in ('acpi','asound','interrupts','kcore','keys','latency_stats',
             'scsi','timer_list','timer_stats','sched_debug')}
READ_ONLY_PROC = {'/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'}
ELECTRON_ROOT = 'https://github.com/electron/electron/releases/download/v44.5.1/'
SAFE_ENV = {'PATH':'/usr/bin:/bin', 'LANG':'C.UTF-8', 'GIT_CONFIG_NOSYSTEM':'1',
            'GIT_CONFIG_GLOBAL':'/dev/null', 'GIT_NO_LAZY_FETCH':'1', 'GIT_TERMINAL_PROMPT':'0'}


def need(ok, label):
    if not ok:
        raise Refused(label)


def control_environment(env):
    needed = {'RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
              'GITHUB_REPOSITORY':REPO,'GITHUB_REF':BRANCH,'GITHUB_RUN_ATTEMPT':'1',
              'GITHUB_EVENT_NAME':'push','GITHUB_WORKFLOW_REF':f'{REPO}/{WORKFLOW}@{BRANCH}','GITHUB_JOB':'two-format'}
    need(all(env.get(k)==value for k,value in needed.items()),'exact-host-job')
    sha, run = env['GITHUB_SHA'], env['GITHUB_RUN_ID']
    need(re.fullmatch(r'[a-f0-9]{40}',sha) and sha==env['GITHUB_WORKFLOW_SHA'] and sha!=BASE and
         re.fullmatch(r'[1-9][0-9]{0,18}',run), 'head-and-attempt')
    event = json.loads(Path(env['GITHUB_EVENT_PATH']).read_bytes())
    need(event['ref']==BRANCH and event['after']==sha and event['created'] is True and
         event['deleted'] is False and event['forced'] is False and
         event['repository']['full_name']==REPO and event['repository']['private'] is False, 'first-branch-creation')
    os_release = Path('/usr/lib/os-release').read_text().splitlines()
    need(os.getuid()==os.geteuid()!=0 and os.getgid()!=0 and os.uname().machine=='x86_64'
         and 'ID=ubuntu' in os_release and 'VERSION_ID="24.04"' in os_release,'nonroot-noble-x64')
    return run


def identity(row):
    return row.st_dev,row.st_ino,row.st_uid,row.st_gid,row.st_mode


def free(path):
    need(path==path.resolve(strict=True),'canonical-backing')
    fd = os.open(path,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        fs = os.fstatvfs(fd)
        need(identity(os.fstat(fd))==identity(path.lstat()) and not fs.f_flag & os.ST_RDONLY,'backing-readback')
        return fs.f_bavail*fs.f_frsize
    finally:
        os.close(fd)


def capture(argv, env, seconds, *, limit=1024**2, cwd=None, pass_fds=()):
    """Read both streams under one hard cap, with no terminal or raw output."""
    try:
        process = subprocess.Popen(argv, env=env, cwd=cwd, pass_fds=pass_fds,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
    except OSError:
        return 'start-failed', b'', b''
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    remaining_bytes = limit
    deadline = monotonic() + seconds
    complete = False
    try:
        with selectors.DefaultSelector() as monitor:
            for pipe in streams:
                os.set_blocking(pipe.fileno(), False)
                monitor.register(pipe, selectors.EVENT_READ)
            while monitor.get_map():
                remaining = deadline - monotonic()
                events = monitor.select(remaining) if remaining > 0 else []
                if not events:
                    return 'timeout', b'', b''
                for event, _ in events:
                    chunk = os.read(event.fd, min(65536, remaining_bytes + 1))
                    if not chunk:
                        monitor.unregister(event.fileobj)
                        continue
                    remaining_bytes -= len(chunk)
                    if remaining_bytes < 0:
                        return 'output-limit', b'', b''
                    streams[event.fileobj].extend(chunk)
        code = process.wait(timeout=max(0, deadline - monotonic()))
        complete = True
        return ('ok' if code == 0 else 'nonzero-exit',
                bytes(streams[process.stdout]), bytes(streams[process.stderr]))
    except subprocess.TimeoutExpired:
        return 'timeout', b'', b''
    finally:
        # This session is only the CLI. The container has a separate retirement gate.
        if not complete:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for pipe in streams:
            pipe.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            raise Refused('client-retirement-unverified') from None


def command(argv, env, seconds, label, *, cwd=None):
    reason, stdout, _ = capture(argv, env, seconds, cwd=cwd)
    need(reason == 'ok', label)
    return stdout


def file_hash(path):
    with path.open('rb') as body:
        return file_digest(body,'sha256').hexdigest()


def download(item, root, *, seconds=57):
    name,url,size,digest,redirect = item
    destination = root/name
    with destination.open('xb', buffering=0) as out:
        options=['--location','--proto-redir','=https','--max-redirs','2'] if redirect else ['--max-redirs','0']
        reason, status, stderr = capture(['/usr/bin/curl','--disable','--silent','--show-error','--fail',
               '--proto','=https','--retry','0','--connect-timeout','5','--max-time',str(min(55, seconds)),'--max-filesize',str(size),
               '--write-out','%{http_code}','--output',f'/proc/self/fd/{out.fileno()}',*options,url],
               SAFE_ENV, seconds, limit=4096, pass_fds=(out.fileno(),))
        need(reason == 'ok' and not stderr and status == b'200', 'public-intake')
        os.fchmod(out.fileno(),0o400)
    need(destination.stat().st_size==size and file_hash(destination)==digest,'public-input-pin:'+name)


def stage_reader(root, media, receipt):
    # Keep the DEB in host scratch outside the read-only worker input bind.
    archive = root/reader_input.DEB
    download((archive.name, reader_input.URL, reader_input.DEB_BYTES, reader_input.DEB_SHA256, False), root)
    before = reader_input.archive_stamp(archive)
    unpacker = Path('/usr/bin/dpkg-deb')
    compiler_gate.protected_ancestors(unpacker)
    info, _, _ = pins.file_data(unpacker, 'stock-data-decoder', owned=False)
    need(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o755, 'stock-data-decoder')
    reason, payload, stderr = capture([unpacker, '--fsys-tarfile', archive],
                                     {**SAFE_ENV, 'HOME':str(root)}, 12,
                                     limit=reader_input.PAYLOAD_CAP)
    need(reason == 'ok' and not stderr and reader_input.archive_stamp(archive) == before,
         'reader-deb-data-only-decode')
    body = reader_input.read_payload(payload, receipt['projectedRoles'][reader_input.MEMBER]['expected'])
    with (media/reader_input.LEAF).open('xb') as out:
        out.write(body)
        os.fchmod(out.fileno(), 0o400)


def source_stage(destination, checkout, root):
    git = ['/usr/bin/git','-C',str(checkout),'-c','core.autocrlf=false','-c','core.hooksPath=/dev/null','--no-replace-objects']
    env = {**SAFE_ENV,'HOME':str(root),'GIT_INDEX_FILE':str(root/'private.index')}
    command(git+['fetch','--depth=1','--no-tags','https://github.com/'+REPO+'.git',BASE],env,45,'exact-public-base-fetch')
    need(command(git+['rev-parse','FETCH_HEAD'],env,8,'fetch-head').decode().strip()==BASE,'frozen-base')
    # Bind the actual workflow checkout, then reconstruct the separately reviewed shared source.
    sha=os.environ['GITHUB_SHA']
    command(git+['read-tree',sha],env,8,'workflow-index')
    need(command(git+['rev-parse','HEAD'],env,8,'source-head').decode().strip()==sha and
         command(git+['diff','--no-ext-diff',sha,'--','.github/workflows','scripts/ci/linux-two-format'],env,8,'control-worktree')==b'' and
         command(git+['ls-files','--others','--','scripts/ci/linux-two-format'],env,8,'closed-control-paths')==b'',
         'exact-control-checkout')
    command(git+['read-tree',BASE],env,8,'frozen-tree')
    shared=CONTROL/'patches/SHARED-FORMAT-GATE.patch'
    need(file_hash(shared)=='32abf32c8a20c7b108bc8a18135cdb4925a59eb80541a34ec34af9e9203b31d2','shared-patch-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(shared)],env,8,'shared-source-patch')
    need(command(git+['write-tree'],env,8,'shared-source-tree').decode().strip()==
         '04750dde7d6a027568f0aa855795c1efaa80d6a5','exact-shared-source-tree')
    command(git+['read-tree',BASE],env,8,'frozen-projection-base')
    patch=CONTROL/'patches/LINUX-SOURCE-ONLY.patch'
    need(file_hash(patch)=='028ddb7b909b9425ee0ce0a10fc4b7b204133240d14b4d585137b3d3d9a67630','text-patch-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(patch)],env,8,'exact-text-patch')
    need(command(git+['write-tree'],env,8,'text-tree').decode().strip()==TEXT_TREE,'exact-text-tree')
    test=CONTROL/'patches/TRUE-AFTERPACK-REGRESSION.patch'
    need(file_hash(test)=='9f43f1ed93c67aaa45ad47b0442f2c9d4c858b64df86095b0ac2892f5af83c69','test-overlay-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(test)],env,8,'test-overlay')
    projection=CONTROL/'patches/EXACT-PROJECTION.patch'
    need(file_hash(projection)=='23ceea737ab85140859f56c52f62256a31d9121c816aa0a6fd817de8e0762e7b','projection-patch-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(projection)],env,8,'exact-projection')
    need(command(git+['write-tree'],env,8,'projection-text-tree').decode().strip()==
         '90d0b2d05a78107be8c6f79a5d751a41767f5108','exact-projected-text-tree')
    verifier_source=CONTROL/'patches/PRODUCT-ESM.patch'
    need(file_hash(verifier_source)=='aaedf7b8b1c7293c8565aeffd9ef0c25f2ec5a746e00e6dfcfa7f78287453895','verifier-source-patch-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(verifier_source)],env,8,'verifier-source-patch')
    need(command(git+['write-tree'],env,8,'verifier-source-tree').decode().strip()==
         '82d81d1f241727ada9561386d34dfa72d5f10c20','exact-verifier-source-tree')
    launcher=CONTROL/'patches/PORTABLE-APPRUN.patch'
    need(file_hash(launcher)=='a655fbf3d7a3547eb1c4b8ea8057d3fcf194478ffe975efcfb117f76ea9d874c',
         'portable-apprun-patch-pin')
    command(git+['apply','--cached','--whitespace=error-all',str(launcher)],env,8,'portable-apprun-patch')
    need(command(git+['write-tree'],env,8,'portable-source-tree').decode().strip()==
         '0207837c98b4b22b277549ec0784cc6a3879e138','exact-portable-source-tree')
    command(git+['checkout-index','--all','--prefix='+str(destination)+'/'],env,20,'materialized-text-tree')


def stage(root, checkout, worker):
    cfg = pins.pins()
    sources=root/'inputs'
    sources.mkdir(mode=0o700)
    source_stage(sources/'base', checkout, root)
    plan=[('provider/'+p.name,p.url,p.size,p.sha256,False) for p in providers.load_plan()]
    plan.extend(('registry/'+name+'.tgz',row['url'],row['bytes'],row['sha256'],False)
                for name,row in cfg['REGISTRY-PLAN.json'].items())
    for name,leaf,url in [('node','node.tar.gz','https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz'),
                          ('electron','electron.zip',ELECTRON_ROOT+'electron-v44.5.1-linux-x64.zip')]:
        row=cfg['CUSTODY.json']['officialMediaReadback'][name]
        if name=='node':
            # Reuse the same admission-verified provider body, with no second request.
            continue
        plan.append(('media/'+leaf,url,row['bytes'],row['sha256'],True))
    plan.append(('media/electron.d.ts',ELECTRON_ROOT+'electron.d.ts',1146298,
                 cfg['BUILD-ADMISSION.json']['electronDeclarationSHA256'],True))
    toolset=cfg['APPIMAGE-TOOLS.json']
    plan.append(('media/appimage-tools.tar.gz',toolset['url'],toolset['bytes'],toolset['sha256'],True))
    attempt = {'source_commit': os.environ['GITHUB_SHA'],
               'workflow_sha256': file_hash(checkout / WORKFLOW),
               'worker_binding': worker.binding,
               'run_id': os.environ['GITHUB_RUN_ID']}
    with (sources/'attempt.json').open('x',encoding='ascii') as body:
        json.dump(attempt,body,sort_keys=True)
    for name in ('provider','registry','media'):
        (sources/name).mkdir(mode=0o700)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda item:download(item,sources),plan))
    if EXTRACTION_POLICY_REVIEWED or WORKFLOW.endswith("jammy-appimage-runtime.yml"):
        stage_reader(root, sources/'media', cfg['READER-DATA-RECEIPT.json'])
    return sources


def stage_runtime(root, sources):
    runtime_rebuild.rebuild(root, sources/'media'/runtime_input.INPUT, download, command,
                            free=free, deadline=monotonic()+220)


def worker_options(name, root, bound, ownership):
    uid,gid=os.getuid(),os.getgid()
    args=['create','--pull=never','--platform=linux/amd64','--name',name,'--label',f'{LABEL}={bound}',
          '--label',f'{OWNER_LABEL}={ownership}',
          '--network=none','--read-only','--ipc=none','--cap-drop=ALL','--security-opt=no-new-privileges',
          '--user',f'{uid}:{gid}','--pids-limit=512','--memory=14g','--cpus=4','--log-driver=none','--no-healthcheck']
    for src,dst in [(root,'/inputs'),(CONTROL,'/control')]:
        args.extend(['--mount',f'type=bind,src={src},dst={dst},readonly'])
    for path in build_layout.MOUNTS:
        args.extend(['--tmpfs',f'{path}:{build_layout.tmpfs_options(path, uid, gid)}'])
    return args+['--workdir=/work','--env=PATH=/usr/bin:/bin','--env=HOME=/work/home','--env=TMPDIR=/work/temp',
                 '--entrypoint=/usr/bin/python3',IMAGE,'-E','-B','/control/worker.py',bound]


def isolated(doc, cid, source, bound):
    host, config = doc['HostConfig'], doc['Config']
    need(doc['Id']==cid and doc['Image']==CONFIG and config['Labels'].get(LABEL)==bound and
         config['User']==f'{os.getuid()}:{os.getgid()}' and config['Entrypoint']==['/usr/bin/python3'] and
         config['Cmd']==['-E','-B','/control/worker.py',bound] and config['WorkingDir']=='/work', 'worker-id-readback')
    need(host['NetworkMode']=='none' and host['IpcMode']=='none' and host['PidMode'] in ('','private') and
         host['ReadonlyRootfs'] is True and host['Privileged'] is False and host['CapDrop']==['ALL'] and
         not any(host.get(key) for key in ('CapAdd','Devices','DeviceRequests','Binds','ExtraHosts','PortBindings',
                                          'GroupAdd','Sysctls','VolumesFrom','PublishAllPorts','Init')) and
         host['SecurityOpt'] in (['no-new-privileges'],['no-new-privileges:true']) and
         host['PidsLimit']==512 and host['Memory']==14*1024**3 and host['NanoCpus']==4_000_000_000 and
         host['LogConfig']['Type']=='none' and host['RestartPolicy']['Name']=='no' and host['AutoRemove'] is False and
         host['Runtime']=='runc' and set(doc['NetworkSettings']['Networks']) in (set(),{'none'}),
         'isolation-readback')
    masks=host['MaskedPaths']
    need(len(masks)==len(set(masks)) and '/proc/keys' in masks and all(
         mask in PROC_MASKS|{'/sys/firmware','/sys/devices/virtual/powercap'} or
         re.fullmatch(r'/sys/devices/system/cpu/cpu[0-9]+/thermal_throttle',mask) for mask in masks)
         and set(host['ReadonlyPaths'])==READ_ONLY_PROC,'stock-runc-masks')
    binds = [(m['Source'],m['Destination'],m['RW'],m['Propagation']) for m in doc['Mounts'] if m['Type']=='bind']
    need(set(binds)=={(str(source),'/inputs',False,'rprivate'),(str(CONTROL),'/control',False,'rprivate')} and len(binds)==2 and
         not any(m['Type'] not in ('bind','tmpfs') for m in doc['Mounts']) and
         all(m['Destination'] in ('/work','/scratch') for m in doc['Mounts'] if m['Type']=='tmpfs'), 'mount-readback')
    expected={p:build_layout.tmpfs_options(p,os.getuid(),os.getgid()) for p in build_layout.MOUNTS}
    need(host['Tmpfs']==expected,'job-write-ceilings')


def step(verdicts, name, operation):
    verdicts[name] = 'fail'
    result = operation()
    verdicts[name] = 'pass'
    return result


class Worker:
    """Track one attempt label and confirm immutable identity before using a resource."""

    def __init__(self, env, bound):
        self.env = env
        self.bound = bound
        self.name = 'hub-two-format-' + bound
        self.ownership = secrets.token_hex(16)
        self.binding = sha256(self.ownership.encode('ascii')).hexdigest()
        self.cid = None
        self.creation = None
        self.attaching = False

    def call(self, *args, seconds=9):
        return command([*DOCKER, *args], self.env, seconds, 'docker-command')

    def scope(self):
        rows = self.call('ps', '--all', '--quiet', '--no-trunc', '--filter',
                         f'label={LABEL}={self.bound}').decode('ascii').splitlines()
        need(len(rows) <= 1 and all(CID.fullmatch(row) for row in rows), 'worker-scope')
        return rows

    def inspect(self):
        need(self.cid is not None and self.scope() == [self.cid], 'worker-scope-identity')
        doc, = json.loads(self.call('container', 'inspect', self.cid))
        cfg = doc['Config']
        need(doc['Id'] == self.cid and doc['Name'] == '/' + self.name
             and doc['Image'] == CONFIG and cfg['Labels'].get(LABEL) == self.bound
             and cfg['Labels'].get(OWNER_LABEL) == self.ownership
             and cfg['User'] == f'{os.getuid()}:{os.getgid()}'
             and cfg['Entrypoint'] == ['/usr/bin/python3']
             and cfg['Cmd'] == ['-E', '-B', '/control/worker.py', self.bound],
             'worker-ownership')
        return doc

    def create(self, source):
        need(not self.scope(), 'worker-attempt-already-present')
        # Set before the CLI call. A later cleanup must account for a lost reply.
        self.creation = 'pending'
        self.creation, raw, stderr = capture(
            [*DOCKER, *worker_options(self.name, source, self.bound, self.ownership)], self.env, 9, limit=4096)
        if self.creation == 'ok':
            match = re.fullmatch(rb'([a-f0-9]{64})\n', raw)
            if match is not None:
                self.cid = match[1].decode('ascii')
        need(self.cid is not None and not stderr, 'worker-create')
        doc = self.inspect()
        need(inactive(doc['State']) and doc['State']['Status'] == 'created', 'worker-initial-state')
        return doc

    def attach(self, verdicts):
        self.attaching = True
        verdicts.update(dict.fromkeys(WORKER_STAGES, 'unobserved'))
        if EXTRACTION_POLICY_REVIEWED:
            verdicts.update(dict.fromkeys(VERIFIER_OUTPUTS, 'unobserved'))
        reason, stdout, stderr = capture([*DOCKER, 'start', '--attach', self.cid],
                                         self.env, 720, limit=4096)
        frame = worker_frame(stdout, self.bound, verdicts, self.binding)
        verdicts['attach'] = reason if reason != 'ok' else 'fail'
        need(reason == 'ok' and not stderr and frame is not None, 'worker-attach')
        verdicts['attach'] = 'pass'
        return frame

    def retire(self):
        rows = self.scope()
        if self.cid is None:
            if not rows:
                need(self.creation in (None, 'start-failed'), 'worker-creation-unresolved')
                return False
            need(self.creation not in (None, 'start-failed'), 'unowned-worker')
            self.cid, = rows
        doc = self.inspect()
        state = doc['State']
        if state['Running'] is True:
            need(self.attaching and state['Status'] == 'running'
                 and state['Paused'] is False and state['Restarting'] is False,
                 'unexpected-active-worker')
            self.call('stop', '--time', '5', self.cid, seconds=12)
            doc = self.inspect()
            state = doc['State']
            stopped = True
        else:
            stopped = False
        need(inactive(state), 'worker-still-active')
        clean = (not stopped and state['Status'] == 'exited' and type(state['ExitCode']) is int
                 and state['ExitCode'] == 0 and state['OOMKilled'] is False and state['Error'] == '')
        # Do not force removal. Require the same immutable ID and no remaining attempt labels.
        self.call('rm', self.cid)
        need(not self.scope(), 'worker-scope-not-empty')
        return clean


def inactive(state):
    return (state['Status'] in ('created', 'exited') and type(state['Pid']) is int and state['Pid'] == 0
            and state['Running'] is False and state['Paused'] is False and state['Restarting'] is False)


def worker_frame(stdout, bound, verdicts, binding):
    rows = stdout.splitlines(keepends=True)
    updates = {}
    for name in WORKER_STAGES:
        if not rows:
            break
        row = rows.pop(0)
        if EXTRACTION_POLICY_REVIEWED and name == 'archive_verification':
            details = re.fullmatch(
                rb'HUB_PAIR_PHASE archive_verification fail verifier ([a-z_]+) (pass|fail|unreached)\n', row)
            if details:
                condition, retirement = (part.decode('ascii') for part in details.groups())
                if (rows or condition not in VERIFIER_CONDITIONS
                        or (condition == 'temp_retirement' and retirement != 'fail')
                        or (retirement == 'unreached' and condition != 'temp_allocate')):
                    return None
                updates['archive_verification'] = 'fail'
                verdicts.update({later: updates.get(later, 'unreached') for later in WORKER_STAGES})
                verdicts['verifier_' + condition] = 'fail'
                verdicts['verifier_temp_retirement'] = retirement
                return None
        match = re.fullmatch(rb'HUB_PAIR_PHASE ' + name.encode() + rb' (pass|fail)( closure)?\n', row)
        if match is None or (match[2] and (match[1] != b'fail' or name not in CLOSURE_STAGES)):
            return None
        updates[name] = match[1].decode('ascii')
        if updates[name] == 'fail':
            if not rows:
                if match[2]:
                    updates['provider_process_closure'] = 'fail'
                verdicts.update({later: updates.get(later, 'unreached') for later in WORKER_STAGES})
                if EXTRACTION_POLICY_REVIEWED and updates.get('archive_verification') == 'pass':
                    verdicts.update(dict.fromkeys(VERIFIER_OUTPUTS, 'pass'))
                elif EXTRACTION_POLICY_REVIEWED and name != 'archive_verification':
                    verdicts.update(dict.fromkeys(VERIFIER_OUTPUTS, 'unreached'))
            return None
    if not rows:
        verdicts.update(updates)
        if EXTRACTION_POLICY_REVIEWED and updates.get('archive_verification') == 'pass':
            verdicts.update(dict.fromkeys(VERIFIER_OUTPUTS, 'pass'))
        return None
    if len(rows) != 1 or len(updates) != len(WORKER_STAGES):
        return None
    match = re.fullmatch(rb'HUB_PAIR_DATA_OK ' + bound.encode() + b' ' + binding.encode()
                         + (b' verified' if EXTRACTION_POLICY_REVIEWED else b' held')
                         + rb' ([a-f0-9]{64}) ([a-f0-9]{64}) ([a-f0-9]{64}) ([a-f0-9]{64})\n', rows[0])
    if match is None or any(value != 'pass' for value in updates.values()):
        return None
    verdicts.update(updates)
    if EXTRACTION_POLICY_REVIEWED:
        verdicts.update(dict.fromkeys(VERIFIER_OUTPUTS, 'pass'))
    verdicts['extraction'] = 'verified' if EXTRACTION_POLICY_REVIEWED else 'held'
    return dict(zip(DIGEST_KEYS,(part.decode('ascii') for part in match.groups()),strict=True))



def check_host(worker, root, verdicts):
    info = step(verdicts, 'host_docker_info',
                lambda: json.loads(worker.call('info', '--format', '{{json .}}')))
    step(verdicts, 'host_docker_platform',
         lambda: need(info['OSType'] == 'linux' and info['Architecture'] in ('x86_64', 'amd64'),
                      'stock-docker-platform'))
    step(verdicts, 'host_docker_seccomp',
         lambda: need('name=seccomp,profile=builtin' in info['SecurityOptions'], 'stock-docker-seccomp'))
    step(verdicts, 'host_docker_driver',
         lambda: need(info['Driver'] in ('overlay2', 'overlayfs'), 'stock-docker-driver'))

    def stock_graph():
        graph = Path(info['DockerRootDir'])
        need(graph == Path('/var/lib/docker'), 'stock-docker-graph')
        return graph

    graph = step(verdicts, 'host_docker_graph', stock_graph)
    backs = [('docker', graph), ('scratch', root)]
    if info['Driver'] == 'overlayfs':
        backs.append(('containerd', Path('/var/lib/containerd')))
    readbacks = [(role, step(verdicts, f'host_{role}_readback', lambda: free(path)))
                 for role, path in backs]
    for role, free_bytes in readbacks:
        step(verdicts, f'host_{role}_floor',
             lambda: need(free_bytes >= FLOOR + 1536*1024**2, 'before-stage-and-pull-space'))
    return [path for _, path in backs]


def check_image(worker, backs):
    worker.call('pull', '--platform', 'linux/amd64', IMAGE, seconds=140)
    image, = json.loads(worker.call('image', 'inspect', IMAGE))
    need((image['Id'], image['Os'], image['Architecture']) == (CONFIG, 'linux', 'amd64')
         and not image['Config'].get('Volumes') and not image['Config'].get('Healthcheck'),
         'exact-official-build-root')
    need(min(map(free, backs)) >= FLOOR, 'same-job-post-stage-floor')


def main(verdicts):
    os.umask(0o077)
    def context():
        run = control_environment(os.environ)
        temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        checkout = Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
        need(CONTROL.is_relative_to(checkout) and temp.stat().st_uid == os.getuid(),
             'runner-owned-checkout-and-temp')
        return run, temp, checkout
    run, temp, checkout = step(verdicts, 'context', context)
    root = Path(tempfile.mkdtemp(prefix='hub-two-format-' + run + '-', dir=temp))
    before = root.lstat()
    env = {**SAFE_ENV, 'HOME': str(root), 'DOCKER_CONFIG': str(root/'docker')}
    worker = Worker(env, run + '-1')
    try:
        (root/'docker').mkdir(mode=0o700)
        backs = step(verdicts, 'host_space', lambda: check_host(worker, root, verdicts))
        source = step(verdicts, 'inputs', lambda: stage(root, checkout, worker))
        step(verdicts, 'runtime_rebuild', lambda: stage_runtime(root, source))
        step(verdicts, 'image_space', lambda: check_image(worker, backs))
        doc = step(verdicts, 'created', lambda: worker.create(source))
        step(verdicts, 'isolation', lambda: isolated(doc, worker.cid, source, worker.bound))
        verdicts['attach'] = 'fail'
        digest = worker.attach(verdicts)
    finally:
        # No worker was requested before create. A replaced or unverified resource is preserved.
        clean = (step(verdicts, 'worker_retired', worker.retire)
                 if worker.creation is not None else False)
        def retire_scratch():
            need(identity(root.lstat()) == identity(before) and root.resolve() == root
                 and shutil.rmtree.avoids_symlink_attacks, 'owned-scratch-identity')
            shutil.rmtree(root)
            need(not os.path.lexists(root), 'retired-stage-absence')
        step(verdicts, 'scratch_retired', retire_scratch)
    if not clean:
        verdicts['attach'] = 'fail'
        raise Refused('unclean-worker-exit')
    return digest


def entry():
    verdicts = dict.fromkeys(STAGES, 'unreached')
    digest = None
    try:
        digest = main(verdicts)
    except (Exception, KeyboardInterrupt):
        # Suppress raw exceptions, paths, payloads and output until all retirement checks pass.
        if verdicts['worker_retired'] == 'fail':
            verdicts['scratch_retired'] = 'preserved'
    for name, result in verdicts.items():
        print(f'HUB_PAIR_STAGE {name} {result}')
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a', encoding='ascii') as stream:
            for name, result in verdicts.items():
                stream.write(f'{name}={result}\n')
    if digest is None:
        return 1
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a', encoding='ascii') as stream:
            for key in DIGEST_KEYS:
                stream.write(f'{key}={digest[key]}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(entry())
