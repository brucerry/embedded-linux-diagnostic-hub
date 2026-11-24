"""Fixed NoCloud callback for read-only Jammy product-import evidence."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import re

from venue_seed import GUEST_STAGES as STOCK_STAGES, boot_evidence as stock_boot, need, seed as stock_seed, sha

PROPOSED_BRANCH='refs/heads/ci/v060-linux-jammy-pair-sparse-readback-20261124'
GUEST_STAGES=(*STOCK_STAGES,'guest_product_import')
HERE=Path(__file__).resolve().parent

def canonical(data):
    return json.dumps(data,sort_keys=True,separators=(',',':')).encode('ascii')

def seed(nonce,header):
    files=stock_seed(nonce)
    wire=canonical(header)
    pin=sha256(wire).hexdigest()
    need(len(wire)<=8192,'bounded-pair-header')
    conf=json.loads(files['user-data'].split(b'\n',1)[1])
    callback=('import sys\nfrom pathlib import Path\nfrom time import monotonic\n'
              'sys.path.insert(0,"/run/hub-pair")\nfrom pair_guest import read_live_originals\n'
              'import json\ntry:\n'
              '    expected=json.loads(Path("/run/hub-pair/expected.json").read_bytes())\n'
              f'    receipt=read_live_originals(expected,{pin!r},monotonic()+90)\n'
              '    if receipt["originals"] != 5: raise ValueError()\n'
              'except Exception:\n'
              '    raise SystemExit(78) from None\n').encode()
    controls={'expected.json':wire,'reader.py':callback,
              'pair_guest.py':(HERE/'pair_guest.py').read_bytes(),
              'pair_wire.py':(HERE.parent/'linux-two-format/pair_wire.py').read_bytes()}
    setup='mkdir -m 0700 /run/hub-pair\nmkdir -m 0755 /mnt/hub-product\n'
    for name,data in controls.items():
        need(0<len(data)<=16384,'custody-control-cap')
        encoded=base64.b64encode(data).decode('ascii')
        setup+=f"printf '%s' '{encoded}' | /usr/bin/base64 -d > /run/hub-pair/{name}\n"
        setup+=f"printf '%s\\n' '{sha256(data).hexdigest()}  /run/hub-pair/{name}' | /usr/bin/sha256sum -c --strict --status\n"
    setup+=(
        "/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal /dev/sr1 /mnt/hub-product\n"
        "if /usr/bin/python3.10 -I -B /run/hub-pair/reader.py; then\n"
        "    printf '%s\\n' 'HUB_JAMMY_PAIR "+nonce+" "+pin+" pass' > /dev/ttyS0\n"
        "else\n"
        "    printf '%s\\n' 'HUB_JAMMY_PAIR "+nonce+" "+pin+" fail' > /dev/ttyS0\n"
        "    exit 78\nfi\n")
    conf['runcmd'][0][2]+=setup
    files['user-data']=b'#cloud-config\n'+json.dumps(conf,sort_keys=True,indent=2).encode()+b'\n'
    return files

def boot_evidence(wire,nonce,header):
    evidence=stock_boot(wire,nonce)
    rows=wire.splitlines()
    target=[(i,row) for i,row in enumerate(rows) if b'HUB_JAMMY_PAIR ' in row]
    evidence['guest_product_import']=False
    if not all(evidence.get(name) for name in STOCK_STAGES) or len(target)!=1:
        return evidence
    pos,row=target[0]
    pin=sha256(canonical(header)).hexdigest()
    start=rows.index(f'HUB_JAMMY_VENUE {nonce} loopback-only'.encode())
    tail=[i for i,line in enumerate(rows) if re.fullmatch(
        rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
        rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',line)]
    evidence['guest_product_import']=(len(tail)==1 and start<pos<tail[0] and
        row==f'HUB_JAMMY_PAIR {nonce} {pin} pass'.encode())
    return evidence
