"""Review-only in-job export of the original two-format producer evidence."""
from dataclasses import asdict
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import struct
import sys

import handoff
import readonly_iso
from pair_wire import (APP, BLOCK, CAP, FLOOR, LIMITS, MAGIC, MAX_HEADER, NAMES, OPTICAL_NAMES,
                       RECORD, TAR, TRAILER, canonical, directory_stamp, exact, iso_bytes, need,
                       same_directory, tick, valid_header)

assert (TAR,APP,RECORD,LIMITS[0])==(handoff.TARBALL,handoff.APPIMAGE,handoff.RECORD,handoff.ARCHIVE_CAP)

def proof(attempt, artifacts, evidence):
    """Accept only the existing producer's sealed artifacts and original-evidence checks."""
    handoff.validate_attempt(attempt)
    need(attempt.job=='two-format' and tuple(item.name for item in artifacts)==handoff.ARTIFACTS,
         'pair-original-roster')
    lookup={row.name:row for row in artifacts}
    need(set(evidence)=={APP+'.sha256',TAR+'.sha256',RECORD},'pair-original-evidence')
    members=[]
    for name in NAMES:
        if name in lookup:
            row=lookup[name]
            members.append([name,row.size,row.sha256])
        elif name==RECORD:
            members.append([name,None,evidence[name]])
        else:
            asset=lookup[name.removesuffix('.sha256')]
            expected=f'{asset.sha256}  {asset.name}\n'.encode('ascii')
            need(sha256(expected).hexdigest()==evidence[name],'pair-original-sidecar')
            members.append([name,len(expected),evidence[name]])
    return {'attempt':asdict(attempt),'members':members}

def sender(path,attempt,seal,out,deadline):
    """Run this in the producer before dropping its original directory; no scratch writes."""
    tick(deadline)
    evidence=handoff.read_official_evidence(path,attempt,seal)
    expected=proof(attempt,seal.artifacts,evidence)
    with handoff.release_directory(path) as (fd,owner):
        need(owner==seal.directory,'pair-original-directory')
        with handoff.open_original(fd,RECORD,65536,False) as (record,count,_):
            need(sha256(record.read()).hexdigest()==evidence[RECORD],'pair-recheck-record')
        actual={'attempt':expected['attempt'],'members':[
                [name,count if name==RECORD else size,digest] for name,size,digest in expected['members']]}
        encoded=canonical(actual)
        valid_header(actual,expected)
        need(len(encoded)<=MAX_HEADER,'pair-header-bound')
        out.write(MAGIC+struct.pack('>I',len(encoded))+encoded)
        identities={item.name:item.identity for item in seal.artifacts}
        for (name,size,pin),limit in zip(actual['members'],LIMITS,strict=True):
            with handoff.open_original(fd,name,limit,name==APP) as (body,actual_size,identity):
                need(actual_size==size and (name not in identities or identity==identities[name]),
                     'pair-original-member')
                digest=sha256()
                count=0
                while part:=body.read(BLOCK):
                    tick(deadline)
                    count+=len(part)
                    need(count<=size,'pair-sender-size')
                    digest.update(part)
                    out.write(part)
                need(count==size and digest.hexdigest()==pin,'pair-sender-pin')
        # In particular a replacement mid-stream cannot leave a valid terminal frame.
        need(handoff.read_official_evidence(path,attempt,seal)==evidence,'pair-producer-final-recheck')
    out.write(TRAILER)
    out.flush()
    return actual

def space(fd,charge,reserve,inodes):
    now=os.fstatvfs(fd)
    need(not now.f_flag&os.ST_RDONLY and now.f_favail>=inodes and
         now.f_bavail*now.f_frsize>=reserve+charge,'pair-receive-space')

def receive(incoming, directory, expected, deadline, *, reserve=FLOOR):
    """Run from the attempt owner on an already bounded worker stream."""
    need(exact(incoming,len(MAGIC),deadline)==MAGIC,'pair-magic')
    length,=struct.unpack('>I',exact(incoming,4,deadline))
    need(0<length<=MAX_HEADER,'pair-header-bound')
    body=exact(incoming,length,deadline)
    header=json.loads(body,object_pairs_hook=handoff.closed_object)
    need(canonical(header)==body,'pair-canonical-header')
    members=valid_header(header,expected)
    fd=os.open(directory,os.O_RDONLY|os.O_NOFOLLOW|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        identity=directory_stamp(info)
        need(os.getuid()==os.geteuid()==info.st_uid>0 and stat.S_IMODE(info.st_mode)==0o700
             and not os.listdir(fd),'pair-private-empty-stage')
        same_directory(directory,fd,identity)
        fs=os.fstatvfs(fd)
        needed=sum((size+fs.f_frsize-1)//fs.f_frsize*fs.f_frsize for _,size,_ in members)
        # The future ISO will coexist with this export. Count it before materialization.
        medium=iso_bytes(header)
        rounded=(medium+fs.f_frsize-1)//fs.f_frsize*fs.f_frsize
        space(fd,needed+rounded,reserve,len(NAMES)+1)
        for name,size,pin in members:
            out=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,
                        0o400,dir_fd=fd)
            with os.fdopen(out,'wb') as stream:
                digest=sha256()
                remaining=size
                while remaining:
                    part=exact(incoming,min(remaining,BLOCK),deadline)
                    stream.write(part)
                    digest.update(part)
                    remaining-=len(part)
                stream.flush()
                need(digest.hexdigest()==pin and os.fstat(stream.fileno()).st_size==size,'pair-received-pin')
        need(exact(incoming,len(TRAILER),deadline)==TRAILER and incoming.read(1)==b'','pair-trailer-eof')
        same_directory(directory,fd,identity)
        need(set(os.listdir(fd))==set(NAMES),'pair-received-roster')
        space(fd,0,reserve,1)
    finally:
        os.close(fd)
    return header

def seal_medium(directory,path,header,expected,deadline):
    members=valid_header(header,expected)
    entries=[readonly_iso.memory('PAIR.JSN',canonical(header))]
    entries.extend(readonly_iso.Member(mapped,directory/name,size,digest)
                   for mapped,(name,size,digest) in zip(OPTICAL_NAMES,members,strict=True))
    check=lambda:tick(deadline)
    value=readonly_iso.build(path,'HUB_PRODUCT_ORIG',entries,CAP,check=check)
    need(value['bytes']==iso_bytes(header) and
         readonly_iso.verify(path,'HUB_PRODUCT_ORIG',entries,CAP,check=check)==value,'pair-sealed-readback')
    return value
