"""NoCloud wiring and strict, nonce-bound native phase receipt parser."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import re

from venue_seed import GUEST_STAGES as STOCK_STAGES, boot_evidence as stock_boot, need, seed as stock_seed
import appimage_inventory as image
import native_guest
import pair_wire as pair
import runtime_gate

BRANCH='ci/v060-jammy-appimage-extract-run-expressions-20261124'
PROPOSED_BRANCH='refs/heads/'+BRANCH
GUEST_STAGES=(*STOCK_STAGES,*native_guest.PHASES)
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
    receipt=product.image_inventory
    pin=sha256(pair.canonical(receipt)).hexdigest()
    bound=image.grant_identity(nonce,receipt,pin,trust['lockSHA256'])
    return {'nonce':nonce,'header':header,'pairSHA256':pair_pin,
            'observerLock':trust['lockSHA256'],'observerGuest4KiB':trust['observerGuest4KiB'],
            'guestCopy':product.guest_copy,'observerOverlay64KiB':trust['observerOverlay64KiB'],
            'imageInventorySHA256':pin,'grant':bound}


def seed(nonce,product):
    initial=stock_seed(nonce)
    cloud=json.loads(initial['user-data'].split(b'\n',1)[1])
    cloud['users']=[{'name':'hub-display','lock_passwd':True,'shell':'/usr/sbin/nologin'}]
    frozen={name:(HERE/name).read_bytes() for name in CONTROL}
    producer=HERE.parent/'linux-two-format'
    for name in ('appimage_inventory.py','read_envelope.py'):
        frozen[name]=(producer/name).read_bytes()
    frozen['inventory.jsn']=pair.canonical(product.image_inventory)
    frozen['plan.json']=pair.canonical(plan_for(nonce,product))
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
    for path,device in native_guest.MOUNTS.items():
        script+=f'/usr/bin/mkdir -m 0755 {path}\n'
        script+=f'/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal {device} {path}\n'
    script+='exec /usr/bin/python3.10 -I -B /run/hub-native-control/native_guest.py\n'
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
    last=True
    for position,((i,raw),name) in enumerate(zip(selected,native_guest.PHASES)):
        prefix=f'HUB_JAMMY_NATIVE {nonce} {name} '.encode()
        proc_unavailable=name=='native_observer_renderer' and raw==prefix+b'fail-proc-unavailable'
        transport=name=='native_observer_launch' and raw==prefix+b'fail-transport'
        need(last and sentinel<i<end[0] and
             (proc_unavailable or transport or raw in (prefix+b'pass',prefix+b'fail')),'native-phase-order')
        last=raw==prefix+b'pass'
        evidence[name]=last
        if proc_unavailable:
            evidence['native_observer_proc_read']=False
        if transport:
            evidence['native_observer_transport']=False
    return evidence
