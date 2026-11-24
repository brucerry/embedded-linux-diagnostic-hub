"""Pure admission and teardown checks for a held provider-only worker."""
from base64 import b64encode
from hashlib import sha256, sha512
import re
from pathlib import Path
import json

D=Path(__file__).resolve().parent
PIN='efa8e055a5b49a307c92a756c55a1cfb22fad1578ec4f0e7efe964540cb3dcd5'
TREE='30182b73211d809a7b2ef57f3ffe0ee9d87a5c33'
LOCK='6eda133d8af11aae5e896876515130792e781f2054d071e2f68a9bcc4272b64c'
FLOOR=4*1024**3
MIB=1024**2
OUTPUT_CAP=16*MIB

class Refused(ValueError):
    pass

def need(value, label):
    if not value:
        raise Refused(label)

def pinned():
    data=(D/'provider-contract.json').read_bytes()
    need(sha256(data).hexdigest()==PIN,'review-manifest')
    p=json.loads(data)
    need((p['tree'],p['lockSHA256'],p['placements'],p['registryCount'])==(TREE,LOCK,314,299),'successor-binding')
    need(len(p['successorProviders'])==8,'provider-census')
    return p

def absolute_path(path):
    return (isinstance(path,str) and path.startswith('/') and len(path)<=512 and
            not {'','.','..'} & set(path[1:].split('/')) and bool(re.fullmatch(r'/[A-Za-z0-9_./-]+',path)))

def nonce(run):
    need(isinstance(run,str) and re.fullmatch(r'[1-9][0-9]{0,18}',run),'run-id')
    return 'hub-linux-provider-'+run+'-1'

def worker_identity(uid,gid):
    need(type(uid)==type(gid)==int and 0<uid<2**31 and 0<gid<2**31,'nonroot-worker')
    return f'{uid}:{gid}'

def scratch_option(uid,gid):
    return f'rw,nosuid,nodev,size=768m,mode=0700,uid={uid},gid={gid}'

def create_argv(p, stage, run, uid, gid):
    """Argument design only. There is no launch wrapper for the candidate worker."""
    user=worker_identity(uid,gid)
    need(absolute_path(stage),'stage-path')
    name=nonce(run)
    image='docker.io/library/ubuntu@'+p['noble']['manifest']
    return ('container','create','--pull=never','--platform=linux/amd64','--name',name,
            '--label','org.hub.provider-run='+run,'--network=none','--read-only','--ipc=none',
            '--cap-drop=ALL','--security-opt=no-new-privileges','--user',user,
            '--pids-limit=256','--memory=1536m','--cpus=2','--log-driver=none','--no-healthcheck',
            '--mount',f'type=bind,src={stage},dst=/inputs,readonly',
            '--tmpfs','/scratch:'+scratch_option(uid,gid),
            '--workdir=/scratch','--env','PATH=/usr/bin:/bin','--env','HOME=/scratch/home',
            '--env','TMPDIR=/scratch/tmp','--env','LANG=C.UTF-8','--entrypoint=/bin/sh',
            image,'/inputs/reviewed-worker.sh')

def image(row,p):
    n=p['noble']
    need((row.get('Id'),row.get('Os'),row.get('Architecture'),row.get('RootFS',{}).get('Layers'))
         ==(n['config'],'linux','amd64',n['layers']),'image-identity')
    need('ubuntu@'+n['manifest'] in row.get('RepoDigests',[]) or
         'docker.io/library/ubuntu@'+n['manifest'] in row.get('RepoDigests',[]),'image-manifest-pin')
    config=row.get('Config',{})
    need(not config.get('Volumes') and not config.get('Healthcheck'),'unexpected-image-activity')

def capacity(stage, graph):
    """Require actual post-staging descriptor observations from both backing stores."""
    need(all(type(r.get('available')) is int and r['available']>=FLOOR and
             r.get('postStaging') is True and r.get('canonicalReadback') is True for r in (stage,graph)),
         'post-staging-capacity')

def isolation(row, cid, p, stage, run, uid, gid):
    need(re.fullmatch(r'[a-f0-9]{64}',cid) and absolute_path(stage),'inspect-context')
    host=row['HostConfig']
    config=row['Config']
    allowed_env={'PATH=/usr/bin:/bin','HOME=/scratch/home','TMPDIR=/scratch/tmp','LANG=C.UTF-8'}
    need(row['Id']==cid and row['Image']==p['noble']['config'] and row['Name']=='/'+nonce(run) and
         config['User']==worker_identity(uid,gid) and config['Entrypoint']==['/bin/sh'] and
         config['Cmd']==['/inputs/reviewed-worker.sh'] and config['WorkingDir']=='/scratch' and
         config['Labels']=={'org.hub.provider-run':run} and
         len(config['Env'])==len(allowed_env) and set(config['Env'])==allowed_env and
         not config.get('Tty') and not config.get('OpenStdin'),'exact-worker-identity')
    need(host['NetworkMode']=='none' and host['IpcMode']=='none' and host['PidMode'] in ('','private')
         and host['ReadonlyRootfs'] is True and host['Privileged'] is False and host['CapDrop']==['ALL']
         and not any(host.get(k) for k in ('CapAdd','Devices','DeviceRequests','PortBindings','VolumesFrom',
                                          'Binds','GroupAdd','ExtraHosts','Sysctls'))
         and host['SecurityOpt'] in (['no-new-privileges'],['no-new-privileges:true'])
         and host['PidsLimit']==256 and host['Memory']==1536*MIB and host['NanoCpus']==2_000_000_000
         and host['LogConfig']['Type']=='none' and host['RestartPolicy']['Name']=='no'
         and host.get('AutoRemove') is False and config.get('Healthcheck') in (None,{'Test':['NONE']})
         and set(row['NetworkSettings']['Networks']) in (set(),{'none'}),'exact-container-isolation')
    need(host['Tmpfs']=={'/scratch':scratch_option(uid,gid)},'bounded-private-writes')
    records=row['Mounts']
    binds=[m for m in records if m['Type']=='bind']
    need(len(binds)==1 and (binds[0]['Source'],binds[0]['Destination'],binds[0]['RW'],binds[0]['Propagation'])
         ==(stage,'/inputs',False,'rprivate') and
         all(m['Type']=='bind' or (m['Type']=='tmpfs' and m['Destination']=='/scratch') for m in records)
         and len(records)<=2,'exact-mount-census')

def worker_witness(row, uid, gid):
    """Accept fixed facts only after a future isolated live supervisor observes them."""
    worker_identity(uid,gid)
    need(row=={'uid':uid,'euid':uid,'gid':gid,'egid':gid,'interfaces':['lo'],
               'nonlocalIPv4Routes':0,'nonlocalIPv6Routes':0,'capEff':'0','capPrm':'0','capBnd':'0',
               'seccomp':2,'noNewPrivs':1,'privatePIDNamespace':True,'boundedScratch':True,
               'scratchOwnershipMatches':True,'scratchNormallyExecutable':True,
               'immutableInputs':True,'noUnexpectedWritableMounts':True},'effective-worker-isolation')

def verify_output_rows(p, objects):
    """Independently read exact files rather than accepting self-reported digest summary rows."""
    expected=p['successorProviders']
    need(set(objects)==set(expected),'output-census')
    need(sum(len(blob) for blob in objects.values())<=OUTPUT_CAP,'output-cap')
    for name,blob in objects.items():
        row=expected[name]
        sri='sha512-'+b64encode(sha512(blob).digest()).decode()
        need((len(blob),sha256(blob).hexdigest(),sri)==(row['size'],row['sha256'],row['integrity']),
             'output-byte-identity')

def teardown(inspection, cid, removal_id, remaining_ids, eof, timed_out):
    state=inspection['State']
    need(inspection['Id']==cid and state['Status']=='exited' and state['Pid']==0
         and state['ExitCode']==0 and state['OOMKilled'] is False and state['Running'] is False
         and eof is True and timed_out is False,'process-closure')
    need(removal_id==cid and remaining_ids==[],'exact-container-retirement')
