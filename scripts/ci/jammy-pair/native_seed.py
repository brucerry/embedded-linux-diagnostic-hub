"""NoCloud wiring and strict, nonce-bound native phase receipt parser."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import re

from venue_seed import GUEST_STAGES as STOCK_STAGES, boot_evidence as stock_boot, need, seed as stock_seed
import native_guest
import pair_wire as pair
import runtime_gate

BRANCH='ci/v060-jammy-tar-retirement-clock-20261124'
PROPOSED_BRANCH='refs/heads/'+BRANCH
GUEST_STAGES=(*STOCK_STAGES,*native_guest.PHASES)
LIFECYCLE_STAGES=native_guest.LIFECYCLE_STAGES
HERE=Path(__file__).resolve().parent
CONTROL=(
    'native_guest.py','native_hash.py','runtime_gate.py','native_control.py','guest_closure.py',
    'portable_stage.py','observer_stage.py','observer_media.py','archive_inventory.py',
    'native_preflight.py','pair_guest.py','pair_wire.py','handoff.py','readonly_iso.py',
    'runtime_provision.py','runtime_display.py','runtime_apply.py','runtime_apply_observer.py','runtime_cache.py','runtime_contract.py','runtime_wire.py',
    'GUEST-TRANSACTION.json','RUNTIME-51-LOCK.json',
)


def plan_for(nonce,product):
    header=product.header
    pair_pin=sha256(pair.canonical(header)).hexdigest()
    trust=product.observer
    bound=runtime_gate.binding(nonce,pair_pin,trust['receipt']['sha256'],'archive-runtime-identity')
    return {'nonce':nonce,'header':header,'pairSHA256':pair_pin,
            'observerLock':trust['lockSHA256'],'observerGuest4KiB':trust['observerGuest4KiB'],
            'guestCopy':product.guest_copy,'grant':bound}


def seed(nonce,product):
    return guest_seed(nonce,plan_for(nonce,product),native_guest.MOUNTS,'native_guest.py')


def guest_seed(nonce,plan,mounts,entry,*,controls=CONTROL):
    initial=stock_seed(nonce)
    cloud=json.loads(initial['user-data'].split(b'\n',1)[1])
    cloud['users']=[{'name':'hub-display','lock_passwd':True,'shell':'/usr/sbin/nologin'}]
    frozen={name:(HERE/name).read_bytes() for name in controls}
    frozen['plan.json']=pair.canonical(plan)
    # Place the pinned files through cloud-init's per-file writer. The runcmd command
    # argument stays well below Linux MAX_ARG_STRLEN even with both full APT locks.
    script='/usr/bin/test -d /run/hub-native-control\n'
    cloud['write_files']=[]
    for name,data in frozen.items():
        need(0<len(data)<=64*1024,'native-seed-input-cap')
        path='/run/hub-native-control/'+name
        cloud['write_files'].append({'path':path,'encoding':'b64','permissions':'0444',
                                     'owner':'root:root','content':base64.b64encode(data).decode()})
        script+=f"printf '%s\\n' '{sha256(data).hexdigest()}  {path}' | /usr/bin/sha256sum -c --strict --status\n"
    for path,device in mounts.items():
        script+=f'/usr/bin/mkdir -m 0755 {path}\n'
        script+=f'/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal {device} {path}\n'
    script+=f'exec /usr/bin/python3.10 -I -B /run/hub-native-control/{entry}\n'
    cloud['runcmd'][0][2]+=script
    need(len(cloud['runcmd'][0][2].encode())<=16*1024,'bounded-cloud-init-command-argument')
    raw=b'#cloud-config\n'+json.dumps(cloud,sort_keys=True,indent=2).encode()+b'\n'
    need(len(raw)<=512*1024,'closed-seed-bound')
    initial['user-data']=raw
    return initial


def boot_evidence(wire,nonce,header):
    evidence=stock_boot(wire,nonce)
    if not all(evidence.get(name) for name in STOCK_STAGES):
        return evidence
    lines=wire.splitlines()
    sentinel=lines.index(f'HUB_JAMMY_VENUE {nonce} loopback-only'.encode())
    end=[i for i,line in enumerate(lines) if re.fullmatch(
        rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
        rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',line)]
    need(len(end)==1,'native-final-guest-boundary')
    selected=[(i,line) for i,line in enumerate(lines) if b'HUB_JAMMY_NATIVE ' in line]
    need(len(selected)<=len(native_guest.PHASES),'native-phase-count')
    anchors={}
    last=True
    for position,((i,raw),name) in enumerate(zip(selected,native_guest.PHASES)):
        prefix=f'HUB_JAMMY_NATIVE {nonce} {name} '.encode()
        transport=name=='native_observer_launch' and raw==prefix+b'fail-transport'
        need(last and sentinel<i<end[0] and
             (transport or raw in (prefix+b'pass',prefix+b'fail')),'native-phase-order')
        last=raw==prefix+b'pass'
        evidence[name]=last
        anchors[name]=i
        if transport:
            evidence['native_observer_transport']=False
    lifecycle=[(i,line) for i,line in enumerate(lines) if b'HUB_JAMMY_TAR_LIFECYCLE ' in line]
    actor='native_observer_actor_frame'
    need(len(lifecycle)==int(evidence.get(actor) is True),'native-lifecycle-count')
    if lifecycle:
        (position,frame),=lifecycle
        need(anchors[actor]<position<anchors.get('native_observer_display',end[0]),'native-lifecycle-order')
        parts=frame.decode('ascii').split(' ')
        need(len(parts)==6 and parts[:2]==['HUB_JAMMY_TAR_LIFECYCLE',nonce] and
             native_guest.lifecycle_frame(nonce,*parts[2:]).encode('ascii')==frame,'native-lifecycle-wire')
        for key,result in zip(LIFECYCLE_STAGES,parts[2:],strict=True):
            if result!='unreached':
                evidence[key]=result=='pass'
        for primary,value in zip(('native_observer_quit','native_observer_post_quit_floor',
                                  'native_observer_display_retirement','native_process_retirement'),
                                  parts[2:],strict=True):
            if primary in evidence:
                need(value!='unreached' and evidence[primary]==(value=='pass'),
                     'native-lifecycle-primary-consistency')
    return evidence
