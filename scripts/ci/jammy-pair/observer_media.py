"""Realize the exact observer inputs as private, read-only archive data."""

from base64 import b64decode
from hashlib import sha256
from native_hash import sha256_stream
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
from time import monotonic

import readonly_iso
from pair_wire import canonical, tick, need

MiB = 2**20
HERE = Path(__file__).resolve().parent
SOURCE = Path('/workspace/linux-outer-tty555/source')
NODE_SOURCE = Path('/workspace/node-release-provenance622-b_rns264/node-v24.22.2-linux-x64.tar.gz')
REGISTRY = Path('/workspace/hub-linux-stage-custody.fTO4jLtZ/private-data/registry')
NODE_ARCHIVE_PIN = '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9'
NODE_MEMBER = 'node-v24.22.2-linux-x64/bin/node'
NODE_BINARY_PIN = '904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52'
NODE_BINARY_SIZE = 126881248
PLAN_SHA = '051611a1443b28678c8bf7b6c19eef93f03ae2131cbca2da4ef5037c7dff3850'
MEDIA_BOUND = 64*MiB
MEDIA_LABEL = 'HUB_RT_OBSERVER'


def hash_fd(path,length,pin):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd,'rb') as wire:
        observed=os.fstat(fd)
        need(observed.st_size==length,'observer-source-size')
        need(sha256_stream(wire).hexdigest()==pin,'observer-source-pin')


def archive_paths(inputs=None):
    raw=(HERE/'OBSERVER-INPUTS.json').read_bytes()
    need(sha256(raw).hexdigest()==PLAN_SHA,'observer-inputs-plan-authority')
    plan=json.loads(raw)['observer']
    node=NODE_SOURCE if inputs is None else inputs/'provider/node'
    archives=[readonly_iso.Member('NODE.TGZ',node,58299872,NODE_ARCHIVE_PIN)]
    slots={}
    roots=('node_modules/@playwright/test','node_modules/playwright','node_modules/playwright-core')
    for number,slot in enumerate(roots):
        row=plan['placements'][slot]
        store=REGISTRY if inputs is None else inputs/'registry'
        filename=store/(b64decode(row['sri'].removeprefix('sha512-'),validate=True).hex()+'.tgz')
        name=f'P{number:03}.TGZ'
        archives.append(readonly_iso.Member(name,filename,row['bytes'],row['sha256']))
        slots[name]=[slot,row['version']]
    need(len(archives)==4,'observer-archive-roster')
    return archives,slots


def npm_sizes(item,deadline):
    files={}
    folders=set()
    seen=set()
    with tarfile.open(item.source,'r|gz') as wire:
        for member in wire:
            tick(deadline)
            name=PurePosixPath(member.name)
            need(not name.is_absolute() and len(name.parts)>=2 and name.parts[0]=='package' and
                 all(re.fullmatch(r'[A-Za-z0-9@_.+ -]+',part) and part not in ('.','..','.git')
                     for part in name.parts) and
                 name not in seen and len(seen)<3000,'observer-npm-archive-path')
            seen.add(name)
            parents=[folder for folder in name.parents if folder.as_posix().startswith('package/')]
            need(not any(folder in files for folder in parents),'observer-npm-parent-file')
            folders.update(parents)
            if member.isdir():
                need(member.size==0 and name not in files,'observer-npm-directory')
                folders.add(name)
            else:
                need(member.isfile() and name not in folders and
                     0<=member.size<=8*MiB and not member.mode & 0o7022,
                     'observer-npm-member')
                files[name]=member.size
            need(sum(files.values())<32*MiB,'observer-npm-total')
    return list(files.values()),len(folders)


def closure(archives,deadline):
    sizes=[NODE_BINARY_SIZE]
    directory_count=0
    node=archives[0]
    hash_fd(node.source,node.size,node.sha256)
    seen=False
    with tarfile.open(node.source,'r|gz') as wire:
        for member in wire:
            tick(deadline)
            if member.name==NODE_MEMBER:
                need(not seen and member.isfile() and member.size==NODE_BINARY_SIZE and
                     member.mode==0o755,'observer-node-member-shape')
                seen=True
                with wire.extractfile(member) as binary:
                    need(sha256_stream(binary).hexdigest()==NODE_BINARY_PIN,'observer-node-member-pin')
    need(seen,'observer-node-member-missing')
    for item in archives[1:]:
        hash_fd(item.source,item.size,item.sha256)
        regular,dirs=npm_sizes(item,deadline)
        sizes.extend(regular)
        directory_count+=dirs
    return sizes,directory_count


def build(directory,deadline, inputs=None):
    archives, slots=archive_paths(inputs)
    sizes,dirs=closure(archives,deadline)
    for physical,origin in (
        ('RUN.MTS','runtime-observer.mts'), ('EXTRA.MJS','runtime-observation.mjs'),
        ('PKG.JSN','package.json'),
    ):
        body=(HERE/origin).read_bytes()
        need(0<len(body)<=16384,'observer-source-member-cap')
        if physical=='PKG.JSN':
            need(json.loads(body)['version']=='0.6.0','observer-source-version')
        archives.append(readonly_iso.memory(physical,body))
    roster = {'schema':1,'nodeBinarySHA256':NODE_BINARY_PIN, 'slots':slots,
              'sourcePlanSHA256':PLAN_SHA, 'member':NODE_MEMBER,
              'files': {item.name:[item.size,item.sha256] for item in archives}}
    archives.append(readonly_iso.memory('LOCK.JSN',canonical(roster)))
    output=directory/'observer.iso'
    receipt=readonly_iso.build(output,MEDIA_LABEL,archives,MEDIA_BOUND,check=lambda:tick(deadline))
    need(receipt==readonly_iso.verify(output,MEDIA_LABEL,archives,MEDIA_BOUND,check=lambda:tick(deadline)),
         'observer-media-readback')
    cluster=65536
    rounded=lambda a,b:(a+b-1)//b*b
    actual_sizes=sizes+[a.size for a in archives if isinstance(a.source,bytes)]
    return {
        'receipt':receipt,'lockSHA256':archives[-1].sha256,'entries':len(archives),'regularMembersSelected':len(actual_sizes),
        'observerFileLogicalBytes':sum(actual_sizes),
        'observerGuest4KiB':sum(rounded(n,4096) for n in actual_sizes),
        'observerOverlay64KiB':sum(rounded(n,cluster)+cluster for n in actual_sizes if n),
        'directories':dirs, 'executed':False,
    }
