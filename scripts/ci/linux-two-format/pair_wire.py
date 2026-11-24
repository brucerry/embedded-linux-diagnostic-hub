"""Fixed pair protocol shared by the producer and stock Jammy Python 3.10."""
import json
import os
import re
from time import monotonic

TAR="Diagnostic-Hub-linux-x64.tar.gz"
APP="Diagnostic-Hub-linux-x64.AppImage"
RECORD="linux-build-info.json"
NAMES=(TAR,TAR+'.sha256',APP,APP+'.sha256',RECORD)
OPTICAL_NAMES=('TAR.TGZ','TAR.SHA','APP.BIN','APP.SHA','BUILD.JSN')
LIMITS=(256*2**20,256,256*2**20,256,65536)
CAP=288*2**20
FLOOR=6*2**30
MAGIC=b'HUB-LINUX-PAIR-1\n'
TRAILER=b'\nHUB-LINUX-PAIR-END\n'
BLOCK=65536
MAX_HEADER=8192

def need(ok,label):
    if not ok:
        raise ValueError(label)

def tick(deadline):
    need(monotonic()<deadline,'pair-deadline')

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')

def exact(source, count,deadline):
    out=bytearray()
    while len(out)<count:
        tick(deadline)
        chunk=source.read(count-len(out))
        need(chunk and len(chunk)<=count-len(out),'pair-truncated')
        out.extend(chunk)
    return bytes(out)

def iso_bytes(head):
    # The six short names plus . and .. fit in one ISO directory sector.
    block=2048
    parts=[r[1] for r in head['members']]+[len(canonical(head))]
    return (20+1+sum((size+block-1)//block for size in parts))*block

def valid_header(head, expected):
    need(type(head) is dict and set(head)=={'attempt','members'} and type(head['members']) is list,
         'pair-header-shape')
    need(head['attempt']==expected['attempt'],'pair-attempt')
    need(len(head['members'])==len(NAMES),'pair-roster')
    for row,bound,name,limit in zip(head['members'],expected['members'],NAMES,LIMITS,strict=True):
        need(type(row) is list and len(row)==3 and row[0]==name==bound[0] and
             type(row[1]) is int and 0<row[1]<=limit and
             type(row[2]) is str and re.fullmatch('[0-9a-f]{64}',row[2]),'pair-member')
        need((row[1]==bound[1] or (bound[1] is None and name in (TAR,APP,RECORD))) and row[2]==bound[2],
             'pair-member-binding')
    need(iso_bytes(head)<=CAP,'pair-media-total')
    return head['members']

def directory_stamp(st):
    return st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode

def same_directory(path,fd,identity):
    need(path.is_absolute() and path.resolve(strict=True)==path and
         directory_stamp(os.fstat(fd))==identity==directory_stamp(path.lstat()),'pair-receive-directory')

def closed_object(pairs):
    result=dict(pairs)
    need(len(result)==len(pairs),'pair-duplicate-json-key')
    return result

def stamp(st):
    return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode,
            st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
