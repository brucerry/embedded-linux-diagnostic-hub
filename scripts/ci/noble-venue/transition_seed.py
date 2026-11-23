"""Bind a nonce and exact no-product APT witness to the passed Noble seed."""
from hashlib import sha256
import json
from pathlib import Path
import re

from guest import PHASES
from venue_seed import boot_evidence as stock_evidence, seed as stock_seed
from venue_seed import GUEST_STAGES as STOCK_STAGES, need, sha


HERE=Path(__file__).resolve().parent
PROPOSED_BRANCH='refs/heads/ci/v060-noble-qemu-apt-inert-transition-20261123'
GUEST_STAGES=(*STOCK_STAGES,*PHASES)


def seed(nonce):
    files=stock_seed(nonce)
    cloud=json.loads(files['user-data'].split(b'\n',1)[1])
    [shell]=cloud['runcmd']
    guest_sha,tools_sha=(sha256((HERE/name).read_bytes()).hexdigest() for name in ('guest.py','GUEST-TOOLS.json'))
    shell[2]+=('''mkdir -m 0755 /mnt/hub-apt-witness
/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal LABEL=HUB_APT_DEBS /mnt/hub-apt-witness
printf '%s  %s\\n' {guest_sha} /mnt/hub-apt-witness/boot.py | /usr/bin/sha256sum --check --strict --status
exec /usr/bin/python3.12 -I -B /mnt/hub-apt-witness/boot.py {nonce} {tools_sha}
''').format(guest_sha=guest_sha,nonce=nonce,tools_sha=tools_sha)
    files['user-data']=b'#cloud-config\n'+json.dumps(cloud,sort_keys=True,indent=2).encode()+b'\n'
    return files


def apt_evidence(wire,nonce,stock):
    rows=wire.splitlines()
    markers=[(idx,line) for idx,line in enumerate(rows) if b'HUB_APT_WITNESS' in line]
    if not markers:
        return {}
    need(sha(nonce) and stock.get('guest_loopback') and stock.get('guest_nocloud')
         and stock.get('guest_poweroff'),'apt-boot-sequence')
    loop=rows.index(f'HUB_NOBLE_VENUE {nonce} loopback-only'.encode())
    cloud=[idx for idx,row in enumerate(rows) if re.fullmatch(
        rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
        rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',row)]
    need(len(cloud)==1 and len(markers)<=len(PHASES),'apt-receipt-roster')
    outcomes={}
    for (idx,line),name in zip(markers,PHASES):
        prefix=f'HUB_APT_WITNESS {nonce} {name} '.encode()
        need(loop<idx<cloud[0] and all(outcomes.values()) and line in (prefix+b'pass',prefix+b'fail'),
             'apt-receipt-frame')
        outcomes[name]=line.endswith(b' pass')
    return outcomes


def boot_evidence(wire,nonce):
    stock=stock_evidence(wire,nonce)
    return stock|apt_evidence(wire,nonce,stock)
