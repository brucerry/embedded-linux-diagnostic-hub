"""Seal only the exact signed package lock and inert controls on read-only optical media."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
import shutil
from time import monotonic
from urllib.parse import quote

from cache import cache_names
from readonly_iso import Member, build, memory, need, verify


HERE=Path(__file__).resolve().parent
LOCK_SHA='5db26dee779a0b380a81395a6dccc65adaca81424fea597744e3a22a7dd2f701'
SNAPSHOT='https://snapshot.ubuntu.com/ubuntu/20261120T060000Z/'
CAP=48*2**20
CONTROL={'LOCK.JSN':'GUEST-TRANSACTION.json','BOOT.PY':'guest.py','APPLY.PY':'apply.py',
         'CACHE.PY':'cache.py','CONTRACT.PY':'contract.py','OBSERVE.PY':'observe.py','WIRE.PY':'wire.py','DISPLAY.PY':'display.py','DISP.JSN':'display-pins.json'}


def manifest():
    raw=(HERE/CONTROL['LOCK.JSN']).read_bytes()
    need(len(raw)<=65536 and sha256(raw).hexdigest()==LOCK_SHA,'signed-transaction-lock')
    doc=json.loads(raw)
    rows=doc['entries']
    need(doc['snapshot']==SNAPSHOT and doc['transaction']=={'adds':54,'upgrades':0,'removals':0}
         and len(rows)==54 and sum(r['compressed_bytes'] for r in rows)==38_586_094,
         'signed-transaction-roster')
    cache_names(rows)
    return rows


def inputs(rows,directory):
    for i,row in enumerate(rows):
        path=row['filename']
        need(re.fullmatch(r'pool/[a-z0-9+/._~%-]+\.deb',path,re.ASCII|re.IGNORECASE)
             and PurePosixPath(path).as_posix()==path and '..' not in PurePosixPath(path).parts
             and 0<row['compressed_bytes']<=30_574_382 and re.fullmatch('[a-f0-9]{64}',row['sha256']),
             'signed-transaction-row')
        name=f'P{i:03}.DEB'
        yield SNAPSHOT+quote(path,safe='/._-~+%'),Member(
            name,directory/name,row['compressed_bytes'],row['sha256'])


def seal(stage, fetch, write_new, deadline, phase):
    folder=stage/'apt-archives'
    folder.mkdir(mode=0o700)
    with phase('apt_fixed_signed_package_intake'):
        targets=list(inputs(manifest(),folder))
        def acquire(pair):
            url,pin=pair
            fetch(url,pin.source,pin.size,pin.sha256,deadline)
        with ThreadPoolExecutor(max_workers=6) as executor:
            for offset in range(0,len(targets),6):
                list(executor.map(acquire,targets[offset:offset+6]))
    with phase('apt_readonly_media_sealed'):
        members=[member for _,member in targets]
        for key,name in CONTROL.items():
            payload=(HERE/name).read_bytes()
            need(0<len(payload)<=65536,'support-control-size')
            members.append(memory(key,payload))
        def check():
            need(monotonic()<deadline,'apt-media-deadline')
        output=stage/'input'/'apt-debs.iso'
        seen=build(output,'HUB_APT_DEBS',members,CAP,check=check)
        need(seen==verify(output,'HUB_APT_DEBS',members,CAP,check=check),'closed-apt-optical-media')
        record=stage/'input'/'SHA256SUMS'
        saved=record.read_bytes()+f"{seen['sha256']}  /input/apt-debs.iso\n".encode()
        record.unlink()
        write_new(record,saved)
        shutil.rmtree(folder)
        return seen
