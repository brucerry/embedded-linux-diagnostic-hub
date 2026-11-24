"""Data-only verification of the product optical import before any consumer is admitted."""
from hashlib import sha256
import json
import os
from pathlib import Path
import stat

import pair_wire as pair

def optical(mountinfo,path):
    matches=[]
    for row in mountinfo.splitlines():
        front,sep,back=row.partition(' - ')
        left,right=front.split(),back.split()
        pair.need(sep and len(left)>=6 and len(right)==3,'pair-optical-mountinfo')
        if left[4]==str(path):
            matches.append(left[3]=='/' and {'ro','nodev','nosuid','noexec'}<=set(left[5].split(','))
                           and right[:2]==['iso9660','/dev/sr1'] and 'ro' in right[2].split(','))
        else:
            pair.need(not left[4].startswith(str(path)+'/'),'pair-optical-nested')
    pair.need(matches==[True],'pair-optical-identity')

def read_live_originals(expect,header_sha,deadline):
    mount=Path('/mnt/hub-product')
    return _read_originals(mount,expect,header_sha,deadline,Path('/proc/self/mountinfo').read_text())

def _read_originals(mount,expect,header_sha,deadline,mountinfo):
    optical(mountinfo,mount)
    fd=os.open(mount,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_DIRECTORY)
    try:
        info=os.fstat(fd)
        stamp=pair.directory_stamp(info)
        pair.same_directory(mount,fd,stamp)
        if mount==Path('/mnt/hub-product'):
            pair.need(info.st_uid==info.st_gid==0 and os.fstatvfs(fd).f_flag&os.ST_RDONLY,
                      'pair-optical-owner-and-readonly')
        allnames={'pair.jsn',*(name.lower() for name in pair.OPTICAL_NAMES)}
        pair.need(set(os.listdir(fd))==allnames,'pair-guest-roster')
        def observed(name,count,pin,capture=False):
            descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
            with os.fdopen(descriptor,'rb') as wire:
                state=os.fstat(wire.fileno())
                pair.need(stat.S_ISREG(state.st_mode) and not state.st_mode&0o222
                          and state.st_dev==info.st_dev and state.st_nlink==1
                          and pair.stamp(state)==pair.stamp(os.stat(name,dir_fd=fd,follow_symlinks=False))
                          and (count is None and 0<state.st_size<=pair.MAX_HEADER or
                               count is not None and state.st_size==count),'pair-guest-file')
                capture_bytes=bytearray()
                measured=sha256()
                count=state.st_size
                while count:
                    part=pair.exact(wire,min(pair.BLOCK,count),deadline)
                    measured.update(part)
                    if capture:
                        capture_bytes.extend(part)
                    count-=len(part)
                pair.need(not wire.read(1) and measured.hexdigest()==pin and pair.stamp(state)==
                          pair.stamp(os.fstat(wire.fileno()))==
                          pair.stamp(os.stat(name,dir_fd=fd,follow_symlinks=False)),'pair-guest-original-pin')
                return bytes(capture_bytes)
        body=observed('pair.jsn',None,header_sha,capture=True)
        header=json.loads(body,object_pairs_hook=pair.closed_object)
        pair.need(pair.canonical(header)==body,'pair-guest-header-shape')
        pairs=pair.valid_header(header,expect)
        for system,(_,size,pin) in zip(pair.OPTICAL_NAMES,pairs,strict=True):
            observed(system.lower(),size,pin)
        pair.same_directory(mount,fd,stamp)
        pair.need(set(os.listdir(fd))==allnames,'pair-guest-retained-roster')
    finally:
        os.close(fd)
    return {'pairManifestSHA256':header_sha,'originals':len(pairs),'execution':False}
