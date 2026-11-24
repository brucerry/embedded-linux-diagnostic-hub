"""Stage exactly the signed archive roster into a private APT cache."""
from hashlib import sha256
import os
from pathlib import Path
import re
import stat
from time import monotonic

from runtime_contract import need, locked_file

TOTAL = 38_586_094
CAP = 64 * 2**20


def quoted(value, reserved):
    return ''.join(f'%{ord(ch):02x}' if ch in reserved or ch == '%' else ch for ch in value)


def cache_names(rows):
    names = []
    for row in rows:
        name, version, arch = (row[k] for k in ('name','version','architecture'))
        need(re.fullmatch('[a-z0-9+.-]+',name) and re.fullmatch('[0-9][a-zA-Z0-9.+~:-]+',version)
             and arch in ('all','amd64'),'cache-name-components')
        rendered = '_'.join((quoted(name,'_:'),quoted(version,'_:'),quoted(arch,'_:.'))) + '.deb'
        need(rendered == row.get('cacheName') and Path(rendered).name == rendered,'cache-name-lock')
        names.append(rendered)
    need(len(names) == len(set(names)),'cache-name-duplicate')
    return names


def stage_cache(directory, media, rows, deadline):
    names = cache_names(rows)
    profiles={'/mnt/hub-apt-witness':(54,TOTAL),'/mnt/hub-apt-runtime':(51,12_642_274)}
    need((len(rows),sum(x['compressed_bytes'] for x in rows))==profiles.get(str(media))
         and sum(x['compressed_bytes'] for x in rows)<CAP,'cache-size-lock')
    space=os.statvfs(directory.parent)
    need(not space.f_flag&os.ST_RDONLY and space.f_bavail*space.f_frsize>=TOTAL+16*2**20
         and space.f_favail>=128,'cache-backing')
    directory.mkdir(mode=0o755)
    directory.chmod(0o755)
    (directory/'partial').mkdir(mode=0o700)
    for index,(name,row) in enumerate(zip(names,rows,strict=True)):
        source=media/f'p{index:03}.deb'
        flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK
        target=directory/name
        with os.fdopen(os.open(source,flags),'rb') as body:
            first=os.fstat(body.fileno())
            need(stat.S_ISREG(first.st_mode) and first.st_size==row['compressed_bytes'],'cache-source')
            with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as out:
                expected=first.st_size
                digest=sha256()
                while expected:
                    need(monotonic()<deadline,'cache-stage-deadline')
                    chunk=body.read(min(expected,2**20))
                    need(chunk,'cache-copy-short')
                    out.write(chunk)
                    digest.update(chunk)
                    expected-=len(chunk)
                last=os.fstat(body.fileno())
                need(not body.read(1) and digest.hexdigest()==row['sha256']
                     and (first.st_size,first.st_mtime_ns,first.st_ctime_ns)==
                     (last.st_size,last.st_mtime_ns,last.st_ctime_ns),'cache-copy-digest')
                os.fchmod(out.fileno(),0o444)
    check_cache(directory,rows,deadline)


def check_cache(directory, rows, deadline):
    names=cache_names(rows)
    for path,mode in ((directory,0o40755),(directory/'partial',0o40700)):
        meta=path.lstat()
        need(meta.st_mode==mode and (meta.st_uid,meta.st_gid)==(os.getuid(),os.getgid()),'cache-directory-mode')
    need({x.name for x in directory.iterdir()}=={'partial',*names} and not any((directory/'partial').iterdir()),
         'cache-closed-roster')
    for name,row in zip(names,rows,strict=True):
        need(monotonic()<deadline,'cache-read-deadline')
        path=directory/name
        meta=path.lstat()
        need(stat.S_ISREG(meta.st_mode) and stat.S_IMODE(meta.st_mode)==0o444 and
             (meta.st_uid,meta.st_gid)==(os.getuid(),os.getgid()) and meta.st_nlink==1,'cache-realized-mode')
        locked_file(path,row['compressed_bytes'],row['sha256'])
