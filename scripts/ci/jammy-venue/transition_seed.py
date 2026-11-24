"""Bind provisioning-only NoCloud controls and decode fixed normal-poweroff receipts."""
from hashlib import sha256
import json
from pathlib import Path
import re

from wire import PHASES, EXTRA
from transition_media import CONTROL
from venue_seed import boot_evidence as stock_evidence, seed as stock_seed
from venue_seed import GUEST_STAGES as STOCK_STAGES, need, sha


HERE=Path(__file__).resolve().parent
PROPOSED_BRANCH='refs/heads/ci/v060-jammy-qemu-display-cache-preflight-20261124'
GUEST_STAGES=(*STOCK_STAGES,*PHASES)


def seed(nonce):
    files=stock_seed(nonce)
    cloud=json.loads(files['user-data'].split(b'\n',1)[1])
    cloud['users']=[{'name':'hub-display','lock_passwd':True,'shell':'/usr/sbin/nologin'}]
    [shell]=cloud['runcmd']
    values=''.join(f'{sha256((HERE/path).read_bytes()).hexdigest()}  /mnt/hub-apt-witness/{name.lower()}\n'
                   for name,path in sorted(CONTROL.items()))
    shell[2]+=(
        'mkdir -m 0755 /mnt/hub-apt-witness\n'
        '/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal LABEL=HUB_APT_DEBS /mnt/hub-apt-witness\n'
        "/usr/bin/sha256sum --check --strict --status <<'PROVISION_PINS'\n"
        +values+'PROVISION_PINS\n'
        +f'exec /usr/bin/python3.10 -I -B /mnt/hub-apt-witness/boot.py {nonce}\n')
    files['user-data']=b'#cloud-config\n'+json.dumps(cloud,sort_keys=True,indent=2).encode()+b'\n'
    return files


def provisioning_evidence(wire,nonce,stock):
    rows=wire.splitlines()
    found=[(i,row) for i,row in enumerate(rows) if b'HUB_JAMMY_PROVISION' in row]
    if not found:
        return {},{}
    need(sha(nonce) and stock.get('guest_loopback') and stock.get('guest_nocloud')
         and stock.get('guest_poweroff'),'provision-boot-sequence')
    start=rows.index(f'HUB_JAMMY_VENUE {nonce} loopback-only'.encode())
    ends=[i for i,row in enumerate(rows) if re.fullmatch(
        rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
        rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',row)]
    need(len(ends)==1 and len(found)<=len(PHASES)+len(EXTRA),'provision-frame-count')
    states,metrics={},{}
    props=tuple(EXTRA)
    for i,raw in found:
        columns=raw.decode('ascii').split(' ')
        need(start<i<ends[0] and len(columns)==4 and columns[:2]==['HUB_JAMMY_PROVISION',nonce]
             and all(states.values()),'provision-frame')
        _,_,name,value=columns
        next_stage=PHASES[len(states)] if len(states)<len(PHASES) else None
        if name in EXTRA:
            need(next_stage=='prov_apply' and len(metrics)<len(props) and name==props[len(metrics)]
                 and value in EXTRA[name],'provision-metric')
            metrics[name]=value
        else:
            need(next_stage==name and value in ('pass','fail'),'provision-ordered-state')
            if name=='prov_apply':
                need(len(metrics) in (0,len(props)) and (value=='fail' or
                     (metrics.get('prov_exit'),metrics.get('prov_child'))==('zero','closed')),
                     'provision-apply-state')
            if name=='prov_observer' and value=='pass':
                need((metrics.get('prov_status'),metrics.get('prov_progress'),metrics.get('prov_error'),
                      metrics.get('prov_prompt'))==('valid','child-reported','not-seen','not-seen'),
                     'provision-observer-state')
            states[name]=value=='pass'
    need(not metrics or (len(metrics)==len(props) and 'prov_apply' in states),'provision-incomplete-metrics')
    return states,metrics


def boot_evidence(wire,nonce):
    stock=stock_evidence(wire,nonce)
    stages,metrics=provisioning_evidence(wire,nonce,stock)
    return stock|stages,metrics
