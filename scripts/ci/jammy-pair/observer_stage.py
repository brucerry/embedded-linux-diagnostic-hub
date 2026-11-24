"""Materialize closed observer input bytes. This program has no launch entry point."""
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

from observer_media import NODE_MEMBER,NODE_BINARY_SIZE,NODE_BINARY_PIN,PLAN_SHA,MiB,npm_sizes
from readonly_iso import Member
from pair_wire import canonical, closed_object, stamp, tick, need

SLOTS={
    'p000.tgz':'node_modules/@playwright/test',
    'p001.tgz':'node_modules/playwright',
    'p002.tgz':'node_modules/playwright-core',
}
CONTROLS={'run.mts':'runtime-observer.mts','extra.mjs':'runtime-observation.mjs','pkg.jsn':'package.json'}
LIMIT=180*MiB


def write_regular(target,wire,size,deadline):
    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    digest=sha256()
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o400)
    with os.fdopen(descriptor,'wb') as out:
        remain=size
        while remain:
            tick(deadline)
            chunk=wire.read(min(remain,65536))
            need(bool(chunk),'observer-stage-short-member')
            remain-=len(chunk)
            digest.update(chunk)
            out.write(chunk)
        need(not wire.read(1),'observer-stage-extra-input')
    with target.open('rb') as checked:
        need(os.fstat(checked.fileno()).st_size==size and
             file_digest(checked,'sha256').hexdigest()==digest.hexdigest(),'observer-stage-file-readback')
    return size,digest.hexdigest()


def checked(path,size,pin):
    mode=path.lstat()
    need(stat.S_ISREG(mode.st_mode) and not mode.st_mode & 0o222 and mode.st_nlink==1
         and mode.st_size==size, 'observer-stage-source-identity')
    fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as wire:
        need(stamp(os.fstat(fd))==stamp(mode) and file_digest(wire,'sha256').hexdigest()==pin
             and stamp(os.fstat(fd))==stamp(path.lstat()),'observer-stage-source-pin')


def materialize(media, root, known_lock, deadline):
    need(media==media.resolve(strict=True) and root==root.resolve(strict=True),
         'observer-stage-canonical-path')
    base=root.lstat()
    need(stat.S_ISDIR(base.st_mode) and base.st_uid==os.getuid()>0 and
         stat.S_IMODE(base.st_mode)==0o700 and not list(root.iterdir()), 'observer-stage-private-root')
    raw=(media/'lock.jsn').read_bytes()
    need(0<len(raw)<=4096 and sha256(raw).hexdigest()==known_lock,'observer-stage-lock')
    record=json.loads(raw,object_pairs_hook=closed_object)
    need(canonical(record)==raw and record['member']==NODE_MEMBER and record['sourcePlanSHA256']==PLAN_SHA
         and record['nodeBinarySHA256']==NODE_BINARY_PIN and record['schema']==1,
         'observer-stage-closed-lock')
    files={key.lower():value for key,value in record['files'].items()}
    need(set(files)=={'node.tgz',*SLOTS,*CONTROLS} and
         {p.name for p in media.iterdir()}=={'lock.jsn',*files},
         'observer-stage-optical-roster')
    need({name.lower():v[0] for name,v in record['slots'].items()}==SLOTS,'observer-stage-library-slots')
    for name,(size,pin) in files.items():
        limit=64*MiB if name=='node.tgz' else 4*MiB
        need(type(size) is int and 0<size<=limit and re.fullmatch(r'[a-f0-9]{64}',pin),
             'observer-stage-input-range')
        checked(media/name,size,pin)

    receipts={}
    total=0
    with tarfile.open(media/'node.tgz','r|gz') as archive:
        for member in archive:
            tick(deadline)
            if member.name==NODE_MEMBER:
                need('node' not in receipts and member.isfile() and member.size==NODE_BINARY_SIZE
                     and member.mode==0o755,'observer-stage-node-member')
                with archive.extractfile(member) as wire:
                    row=write_regular(root/'node',wire,member.size,deadline)
                need(row==(NODE_BINARY_SIZE,NODE_BINARY_PIN),'observer-stage-node-pin')
                receipts['node']=row
                total+=member.size
    need('node' in receipts,'observer-stage-node-missing')
    for name,slot in SLOTS.items():
        size,pin=files[name]
        npm_sizes(Member(name.upper(),media/name,size,pin),deadline)
        place=root/slot
        with tarfile.open(media/name,'r|gz') as archive:
            for member in archive:
                tick(deadline)
                suffix=PurePosixPath(member.name).relative_to('package')
                if member.isdir():
                    (place/suffix).mkdir(mode=0o700,parents=True,exist_ok=True)
                else:
                    with archive.extractfile(member) as wire:
                        total+=member.size
                        need(total<LIMIT,'observer-stage-realized-byte-cap')
                        receipts[slot+'/'+suffix.as_posix()]=write_regular(place/suffix,wire,member.size,deadline)
        row=json.loads((place/'package.json').read_bytes())
        need(row['name']==slot.removeprefix('node_modules/') and row['version']=='1.63.0',
             'observer-stage-library-version')
    for name,leaf in CONTROLS.items():
        size,pin=files[name]
        with (media/name).open('rb') as wire:
            receipts[leaf]=write_regular(root/leaf,wire,size,deadline)
        need(receipts[leaf]==(size,pin),'observer-stage-control-pin')
        total+=size
    need(total<LIMIT and all(not os.access(root/leaf,os.X_OK) for leaf in receipts),
         'observer-stage-inert-output')
    return {'files':len(receipts),'bytes':total,'nodeSHA256':receipts['node'][1], 'execution':False}
