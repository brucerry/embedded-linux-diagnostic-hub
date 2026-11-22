"""Stage public inputs and launch exactly one isolated, build-only worker."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

import reproduction as providers
import tar_admission as pins


CONTROL = Path(__file__).resolve().parent
BASE = '5e3c66f4a62e3606abdd650972e0f76b71ff5c54'
TEXT_TREE = '502caca5bac9c9c3ac8beb70d7b21aa3041f15f7'
IMAGE = 'docker.io/library/buildpack-deps@sha256:e7fdb09e2aacd2a32875a44be9caa1c18f3098b88620ac6a4bde84c0732c9f87'
CONFIG = 'sha256:f96221e29033048b6f577864f7718af5626d209f80345dde518058c29b6ce2cd'
BRANCH = 'refs/heads/ci/v060-linux-folder-mode-tar-buildonly-20261121'
REPO = 'brucerry/embedded-linux-diagnostic-hub'
WORKFLOW = '.github/workflows/v060-linux-tar-build-only.yml'
FLOOR = 4 * 1024**3
JOB_DISK = 10 * 1024**3
PROVIDER_DISK = 768 * 1024**2
LABEL = 'org.hub.tar-only'
PROC_MASKS = {f'/proc/{name}' for name in ('acpi','asound','interrupts','kcore','keys','latency_stats',
             'scsi','timer_list','timer_stats','sched_debug')}
READ_ONLY_PROC = {'/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'}
ELECTRON_ROOT = 'https://github.com/electron/electron/releases/download/v44.5.1/'
SAFE_ENV = {'PATH':'/usr/bin:/bin', 'LANG':'C.UTF-8', 'GIT_CONFIG_NOSYSTEM':'1',
            'GIT_CONFIG_GLOBAL':'/dev/null', 'GIT_NO_LAZY_FETCH':'1', 'GIT_TERMINAL_PROMPT':'0'}


def need(ok, label):
    if not ok:
        raise ValueError(label)


def control_environment(env):
    needed = {'RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
              'GITHUB_REPOSITORY':REPO,'GITHUB_REF':BRANCH,'GITHUB_RUN_ATTEMPT':'1',
              'GITHUB_EVENT_NAME':'push','GITHUB_WORKFLOW_REF':f'{REPO}/{WORKFLOW}@{BRANCH}','GITHUB_JOB':'tar-only'}
    need(all(env.get(k)==value for k,value in needed.items()),'exact-host-job')
    sha, run = env['GITHUB_SHA'], env['GITHUB_RUN_ID']
    need(re.fullmatch(r'[a-f0-9]{40}',sha) and sha==env['GITHUB_WORKFLOW_SHA'] and sha!=BASE and
         re.fullmatch(r'[1-9][0-9]{0,18}',run), 'head-and-attempt')
    event = json.loads(Path(env['GITHUB_EVENT_PATH']).read_bytes())
    need(event['ref']==BRANCH and event['after']==sha and event['created'] is True and
         event['deleted'] is False and event['forced'] is False, 'first-branch-creation')
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


def command(argv, env, seconds, label, *, cwd=None, data=None):
    done = subprocess.run(argv,env=env,cwd=cwd,input=data,capture_output=True,timeout=seconds)
    need(done.returncode==0 and len(done.stdout)+len(done.stderr)<=1024**2,label)
    return done.stdout


def file_hash(path):
    with path.open('rb') as body:
        return file_digest(body,'sha256').hexdigest()


def download(item, root):
    name,url,size,digest,redirect = item
    destination = root/name
    with destination.open('xb', buffering=0) as out:
        options=['--location','--proto-redir','=https','--max-redirs','2'] if redirect else ['--max-redirs','0']
        result=subprocess.run(['/usr/bin/curl','--disable','--silent','--show-error','--fail',
               '--proto','=https','--retry','0','--connect-timeout','5','--max-time','55','--max-filesize',str(size),
               '--write-out','%{http_code}','--output',f'/proc/self/fd/{out.fileno()}',*options,url],
               env=SAFE_ENV,capture_output=True,pass_fds=(out.fileno(),),timeout=57)
        need(result.returncode==0 and not result.stderr and result.stdout==b'200','public-intake:'+name)
        os.fchmod(out.fileno(),0o400)
    need(destination.stat().st_size==size and file_hash(destination)==digest,'public-input-pin:'+name)


def source_stage(destination, checkout, root):
    git = ['/usr/bin/git','-C',str(checkout),'-c','core.autocrlf=false','-c','core.hooksPath=/dev/null','--no-replace-objects']
    env = {**SAFE_ENV,'HOME':str(root),'GIT_INDEX_FILE':str(root/'private.index')}
    command(git+['fetch','--depth=1','--no-tags','https://github.com/'+REPO+'.git',BASE],env,45,'exact-public-base-fetch')
    need(command(git+['rev-parse','FETCH_HEAD'],env,8,'fetch-head').decode().strip()==BASE,'frozen-base')
    command(git+['read-tree',BASE],env,8,'frozen-tree')
    patch=CONTROL/'patches/LINUX-SOURCE-ONLY.patch'
    need(file_hash(patch)=='028ddb7b909b9425ee0ce0a10fc4b7b204133240d14b4d585137b3d3d9a67630','text-patch-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(patch)],env,8,'exact-text-patch')
    need(command(git+['write-tree'],env,8,'text-tree').decode().strip()==TEXT_TREE,'exact-text-tree')
    test=CONTROL/'patches/TRUE-AFTERPACK-REGRESSION.patch'
    need(file_hash(test)=='9f43f1ed93c67aaa45ad47b0442f2c9d4c858b64df86095b0ac2892f5af83c69','test-overlay-pin')
    command(git+['apply','--cached','--whitespace=nowarn',str(test)],env,8,'test-overlay')
    command(git+['checkout-index','--all','--prefix='+str(destination)+'/'],env,20,'materialized-text-tree')


def stage(root, checkout):
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
    for name in ('provider','registry','media'):
        (sources/name).mkdir(mode=0o700)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda item:download(item,sources),plan))
    return sources


def worker_options(name, root, bound):
    uid,gid=os.getuid(),os.getgid()
    args=['create','--pull=never','--platform=linux/amd64','--name',name,'--label',f'{LABEL}={bound}',
          '--network=none','--read-only','--ipc=none','--cap-drop=ALL','--security-opt=no-new-privileges',
          '--user',f'{uid}:{gid}','--pids-limit=512','--memory=14g','--cpus=4','--log-driver=none','--no-healthcheck']
    for src,dst in [(root,'/inputs'),(CONTROL,'/control')]:
        args.extend(['--mount',f'type=bind,src={src},dst={dst},readonly'])
    for path,size in [('/work',JOB_DISK),('/scratch',PROVIDER_DISK)]:
        args.extend(['--tmpfs',f'{path}:rw,nosuid,nodev,size={size},mode=0700,uid={uid},gid={gid}'])
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
    expected={p:f'rw,nosuid,nodev,size={size},mode=0700,uid={os.getuid()},gid={os.getgid()}'
              for p,size in [('/work',JOB_DISK),('/scratch',PROVIDER_DISK)]}
    need(host['Tmpfs']==expected,'job-write-ceilings')


def main():
    os.umask(0o077)
    run = control_environment(os.environ)
    temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    checkout = Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
    need(CONTROL.is_relative_to(checkout) and temp.stat().st_uid==os.getuid(),'runner-owned-checkout-and-temp')
    root = Path(tempfile.mkdtemp(prefix='hub-tar-' + run + '-',dir=temp))
    before=root.lstat()
    env={**SAFE_ENV,'HOME':str(root),'DOCKER_CONFIG':str(root/'docker')}
    (root/'docker').mkdir(mode=0o700)
    def docker(*args, seconds=9):
        return command(['/usr/bin/docker','--host=unix:///var/run/docker.sock',*args],env,seconds,'docker-'+args[0])
    cid=None
    safe=False
    bound=run+'-1'
    try:
        info=json.loads(docker('info','--format','{{json .}}'))
        need(info['OSType']=='linux' and info['Architecture'] in ('x86_64','amd64') and
             'name=seccomp,profile=builtin' in info['SecurityOptions'] and info['Driver'] in ('overlay2','overlayfs'), 'stock-docker')
        graph=Path(info['DockerRootDir'])
        backs=[graph,root]
        if info['Driver']=='overlayfs':
            backs.append(Path('/var/lib/containerd'))
        need(graph==Path('/var/lib/docker') and min(map(free,backs))>=FLOOR+1536*1024**2,'before-stage-and-pull-space')
        sources=stage(root,checkout)
        docker('pull','--platform','linux/amd64',IMAGE,seconds=140)
        image,=json.loads(docker('image','inspect',IMAGE))
        need((image['Id'],image['Os'],image['Architecture'])==(CONFIG,'linux','amd64') and
             not image['Config'].get('Volumes') and not image['Config'].get('Healthcheck'),'exact-official-build-root')
        need(min(map(free,backs))>=FLOOR,'same-job-post-stage-floor')
        cid=docker(*worker_options('hub-tar-'+bound,sources,bound)).decode().strip()
        need(re.fullmatch(r'[a-f0-9]{64}',cid),'worker-create-id')
        doc,=json.loads(docker('container','inspect',cid))
        isolated(doc,cid,sources,bound)
        try:
            result=docker('start','--attach',cid,seconds=720)
            need(re.fullmatch(rb'HUB_TAR_BUILD_AND_READBACK_OK '+bound.encode()+rb' [0-9a-f]{64}\n',result),
                 'same-job-hash-and-four-original-modes')
        finally:
            doc,=json.loads(docker('container','inspect',cid))
            isolated(doc,cid,sources,bound)
            if doc['State']['Running']:
                docker('stop','--time','5',cid,seconds=12)
                doc,=json.loads(docker('container','inspect',cid))
                isolated(doc,cid,sources,bound)
            need(doc['State']['Pid']==0 and not doc['State']['Running'] and not doc['State']['Restarting'] and
                 doc['State']['Status']=='exited','retired-worker-pid')
            docker('rm',cid)
            need(not docker('ps','--all','--quiet','--no-trunc','--filter',f'label={LABEL}={bound}').strip(),'retired-worker-scope')
            if 'result' in locals():
                need(doc['State']['ExitCode']==0 and not doc['State']['OOMKilled'],'clean-worker-exit')
            safe=True
    finally:
        if cid is None or safe:
            need(identity(root.lstat())==identity(before) and root.resolve()==root,'owned-scratch-identity')
            # A failed create may have registered a container without emitting its ID.
            owned=docker('ps','--all','--quiet','--no-trunc','--filter',f'label={LABEL}={bound}')
            need(not owned.strip() and shutil.rmtree.avoids_symlink_attacks,'owned-scratch-retirement')
            shutil.rmtree(root)
            need(not os.path.lexists(root),'retired-stage-absence')
    print(result.decode('ascii').strip())


if __name__=='__main__':
    main()
