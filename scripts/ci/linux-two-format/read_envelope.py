"""Data-only AppImage prefix, superblock, and embedded blockmap verification."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import zlib

RUNTIME_BYTES = 944632
RUNTIME_SHA = "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
IMAGE_LIMIT = 2 << 30
MAP_LIMIT = 16 << 20
MIN_RABIN = 8 << 10
MAX_RABIN = 32 << 10

def need(ok,label):
    if not ok:
        raise ValueError(label)

def unique_json(pairs):
    obj = {}
    for key,value in pairs:
        need(key not in obj,"duplicate blockmap key")
        obj[key] = value
    return obj

def stable_read(file):
    with os.fdopen(os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),"rb") as handle:
        start=os.fstat(handle.fileno())
        key=lambda p:(p.st_dev,p.st_ino,p.st_mode,p.st_size,p.st_nlink,p.st_uid,p.st_mtime_ns,p.st_ctime_ns)
        need(file == file.resolve(strict=True) and key(start)==key(file.lstat()) and stat.S_ISREG(start.st_mode)
             and start.st_nlink == 1 and start.st_uid in (0,os.getuid()) and not start.st_mode & 0o7022,
             "artifact handle")
        size=start.st_size
        need(RUNTIME_BYTES+100<=size<=IMAGE_LIMIT,"image size")
        def at(offset,n):
            need(0<=offset<=offset+n<=size,"read boundary")
            handle.seek(offset)
            b=handle.read(n)
            need(len(b)==n,"short read")
            return b
        prefix=at(0,RUNTIME_BYTES)
        need(prefix[:6]==b"\x7fELF\x02\x01" and prefix[8:11]==b"AI\x02" and
             int.from_bytes(prefix[18:20],"little")==62 and
             hashlib.sha256(prefix).hexdigest()==RUNTIME_SHA,"runtime pin")
        sb=at(RUNTIME_BYTES,96)
        magic,inodes,_,block_size,_,compressor,_,_,_,major,minor,_,sq_bytes=struct.unpack_from("<5I6H2Q",sb)
        need(magic==0x73717368 and 0<inodes<=40000 and block_size==131072 and
             (compressor,major,minor)==(6,4,0) and sq_bytes>=96,"squashfs superblock")
        packed_bytes=int.from_bytes(at(size-4,4),"big")
        need(0<packed_bytes<=MAP_LIMIT,"blockmap footer")
        stop=size-4-packed_bytes
        end=RUNTIME_BYTES+sq_bytes
        need(0<=stop-end<=4095 and not any(at(end,stop-end)),"squashfs padding")
        packed=at(stop,packed_bytes)
        d=zlib.decompressobj(-15)
        decoded=d.decompress(packed,MAP_LIMIT+1)
        need(d.eof and not d.unconsumed_tail and not d.unused_data and 0<len(decoded)<=MAP_LIMIT,
             "bounded blockmap deflate")
        blockmap=json.loads(decoded,object_pairs_hook=unique_json)
        need(set(blockmap)=={"version","files"} and blockmap["version"]=="2" and
             isinstance(blockmap["files"],list) and len(blockmap["files"])==1,"blockmap shape")
        entry=blockmap["files"][0]
        need(set(entry)=={"name","offset","sizes","checksums"} and entry["name"]=="file" and
             type(entry["offset"]) is int and entry["offset"]==0 and
             isinstance(entry["sizes"],list) and isinstance(entry["checksums"],list) and
             0<len(entry["sizes"])==len(entry["checksums"])<=IMAGE_LIMIT//MIN_RABIN+1,
             "blockmap entry")
        offset=0
        digest=hashlib.sha256()
        for i,(length,wanted) in enumerate(zip(entry["sizes"],entry["checksums"])):
            lower=1 if i+1==len(entry["sizes"]) else MIN_RABIN
            need(type(length) is int and lower<=length<=MAX_RABIN and offset+length<=stop,"blockmap chunk")
            data=at(offset,length)
            got=base64.b64encode(hashlib.blake2b(data,digest_size=18).digest()).decode()
            need(got==wanted,"blockmap checksum")
            digest.update(data)
            offset+=length
        need(offset==stop,"blockmap coverage")
        digest.update(packed)
        digest.update(at(size-4,4))
        need(key(start)==key(os.fstat(handle.fileno()))==key(file.lstat()),"artifact changed")
        return {"artifactSHA256":digest.hexdigest(),"bytes":size,"mode":oct(stat.S_IMODE(start.st_mode)),
                "squashfsOffset":RUNTIME_BYTES,"squashfsBytes":sq_bytes,"squashfsInodes":inodes,
                "blockmapEntries":len(entry["sizes"]),"blockmapBytes":packed_bytes,
                "filesystemInventoryVerified":False,"artifactExecuted":False}

if __name__=="__main__":
    print(json.dumps(stable_read(Path(sys.argv[1])),indent=2))
