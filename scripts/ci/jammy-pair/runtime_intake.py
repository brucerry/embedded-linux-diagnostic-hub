"""Host-only acquisition into task-owned optical media, using the stock bounded fetcher."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path, PurePosixPath
import re
from urllib.parse import quote
import shutil

import native_preflight as native
import readonly_iso
from pair_wire import need, tick

HERE=Path(__file__).resolve().parent
LEAVES=('apt-display.iso','apt-runtime.iso')
LABELS=('HUB_APT_DEBS','HUB_RUNTIME_DEBS')


def prepare_runtime(stage,fetch,deadline):
    root=stage/'apt-intake'
    root.mkdir(mode=0o700)
    results={}
    try:
        for index, ((raw,doc,*_),cap) in enumerate(zip(native.runtime_locks(),native.CAPS,strict=True)):
            opened=root/str(index)
            opened.mkdir(mode=0o700)
            pending=[]
            records=[readonly_iso.memory('LOCK.JSN',raw)]
            if index==0:
                records.append(readonly_iso.memory('DISP.JSN',(HERE/'disp.jsn').read_bytes()))
            for number,row in enumerate(doc['entries']):
                relative=row['filename']
                need(re.fullmatch(r'pool/[a-z0-9+/._~%-]+\.deb',relative,re.ASCII|re.IGNORECASE)
                     and PurePosixPath(relative).as_posix()==relative and '..' not in PurePosixPath(relative).parts
                     and 0<row['compressed_bytes']<=30_574_382,'locked-runtime-url')
                name=f'P{number:03}.DEB'
                selected=readonly_iso.Member(name,opened/name,row['compressed_bytes'],row['sha256'])
                pending.append((native.SNAPSHOT+quote(relative,safe='/._-~+%'),selected))
                records.append(selected)
            def acquire(item):
                url,row=item
                fetch(url,row.source,row.size,row.sha256,deadline)
            with ThreadPoolExecutor(max_workers=8) as pool:
                for offset in range(0,len(pending),8):
                    list(pool.map(acquire,pending[offset:offset+8]))
            output=stage/'input'/LEAVES[index]
            value=readonly_iso.build(output,LABELS[index],records,cap,check=lambda:tick(deadline))
            need(value==readonly_iso.verify(output,LABELS[index],records,cap,check=lambda:tick(deadline)),
                 'guest-private-runtime-media-recheck')
            results[LEAVES[index]]=value
    finally:
        shutil.rmtree(root)
    return results
