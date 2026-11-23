"""Build and verify the private envelope project as inert data. No npm or hooks."""
from base64 import b64decode
from hashlib import sha256, sha512
from io import BytesIO
import json
import os
from pathlib import PurePosixPath
import re
import stat
import tarfile


KIT_LIMIT = 4*2**20
FILE_LIMIT = 2*2**20
MAX_FILES = 512
HELPER_PIN = 'becd0f1fe13f686353b23b3b568aa5ac7c9434ebc620df83bcd46679896016de'
MEMBER = re.compile(r'[A-Za-z0-9_.@+ /-]{1,240}')
FLAGS = os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC


def need(condition,label):
    if not condition:
        raise ValueError(label)


def json_closed(data):
    def unique(pairs):
        row = dict(pairs)
        need(len(row)==len(pairs),'kit-duplicate-key')
        return row
    return json.loads(data,object_pairs_hook=unique)


def sha(body):
    return sha256(body).hexdigest()


def file_stamp(row):
    return row.st_dev,row.st_ino,row.st_uid,row.st_gid,row.st_mode,row.st_nlink,row.st_size,row.st_mtime_ns,row.st_ctime_ns


def pinned(path, cap, size=None, digest=None):
    with os.fdopen(os.open(path,FLAGS),'rb') as source:
        first=os.fstat(source.fileno())
        need(stat.S_ISREG(first.st_mode) and first.st_nlink==1 and 0<first.st_size<=cap and
             (size is None or first.st_size==size), 'kit-pinned-file')
        value=source.read(cap+1)
        need(len(value)==first.st_size and (digest is None or sha(value)==digest) and
             file_stamp(first)==file_stamp(os.fstat(source.fileno()))==file_stamp(path.lstat()),
             'kit-pinned-readback')
    return value


def path_name(text):
    need(type(text) is str and MEMBER.fullmatch(text) and
         all(part not in ('','.','..','.git','.bin') for part in text.split('/')) and
         PurePosixPath(text).as_posix()==text, 'kit-member-path')
    return text


def select_registry_row(placement, archive_row):
    need(path_name(placement).startswith('node_modules/') and
         archive_row['url'].startswith('https://registry.npmjs.org/') and
         archive_row['sri'].startswith('sha512-'), 'kit-exact-registry-route')
    digest=b64decode(archive_row['sri'][7:],validate=True)
    need(len(digest)==64,'kit-lock-integrity')
    return digest


def package_members(raw, row, digest):
    need(len(raw)==row['archiveBytes'] and sha(raw)==row['archiveSHA256'] and
         sha512(raw).digest()==digest,'kit-archive-digest')
    data = {}
    expanded = 0
    with tarfile.open(fileobj=BytesIO(raw),mode='r:gz') as archive:
        for item in archive:
            name=path_name(item.name.removeprefix('./'))
            if item.isdir():
                need(name=='package' or name.startswith('package/'),'kit-package-root')
                continue
            need(name.startswith('package/') and item.isfile() and not item.sparse and
                 item.mode in (0o644,0o755) and 0<=item.size<=FILE_LIMIT,
                 'kit-package-mode-or-type')
            leaf=name[len('package/'):]
            need(leaf not in data and len(data)<MAX_FILES and
                 (expanded:=expanded+item.size)<=KIT_LIMIT,'kit-package-roster')
            with archive.extractfile(item) as member:
                body=member.read(item.size+1)
            need(len(body)==item.size,'kit-package-member-length')
            data[leaf]=(item.mode,body)
    metadata=json_closed(data['package.json'][1])
    need(metadata['version']==row['version'] and set(metadata.get('dependencies',{}))==set(row['dependencies'])
         and not set(metadata.get('scripts',{}))&{'preinstall','install','postinstall','dependencies'},
         'kit-no-lifecycle-and-runtime-closure')
    return data


def assemble(helper_bytes, source, registry):
    need(sha(helper_bytes)==HELPER_PIN,'kit-reviewed-helper-plan')
    plan=json_closed(helper_bytes)
    realized={}
    for path,pin in plan['source'].items():
        realized[path_name(path)]=(0o644,source(path,pin))
    archives={}
    for slot,row in sorted(plan['packages'].items()):
        digest=select_registry_row(slot,row)
        if digest not in archives:
            archives[digest]=pinned(registry/(digest.hex()+'.tgz'),FILE_LIMIT,row['archiveBytes'],row['archiveSHA256'])
        for name,value in package_members(archives[digest],row,digest).items():
            key=path_name(slot+'/'+name)
            need(key not in realized,'kit-package-placement-overlap')
            realized[key]=value
    need(len(archives)==14 and len(plan['packages'])==17 and len(plan['source'])==9,'kit-closed-plan')
    need(all(len(realized[path][1])==pin['bytes'] and sha(realized[path][1])==pin['sha256']
             for path,pin in plan['source'].items()), 'kit-source-projection')
    return realized


def manifest(entries):
    need(0<len(entries)<=MAX_FILES and sum(len(body) for _,body in entries.values())<=KIT_LIMIT,
         'kit-total-bound')
    return {path:{'mode':mode,'size':len(body),'sha256':sha(body)} for path,(mode,body) in sorted(entries.items())}


def seal(entries):
    expected=manifest(entries)
    out=BytesIO()
    with tarfile.open(fileobj=out,mode='w:',format=tarfile.USTAR_FORMAT) as archive:
        for name,(mode,body) in sorted(entries.items()):
            need(path_name(name)==name and mode in (0o644,0o755),'kit-file-roster')
            row=tarfile.TarInfo(name)
            row.mode,row.size=mode,len(body)
            archive.addfile(row,BytesIO(body))
    raw=out.getvalue()
    check(raw,expected)
    return raw,expected


def check(raw, expected):
    need(0<len(raw)<=KIT_LIMIT and 0<len(expected)<=MAX_FILES,'kit-sealed-bound')
    realized={}
    with tarfile.open(fileobj=BytesIO(raw),mode='r:') as archive:
        for item in archive:
            name=path_name(item.name)
            need(name in expected and name not in realized and item.isfile() and not item.sparse and
                 item.uid==item.gid==item.mtime==0 and item.mode in (0o644,0o755) and
                 0<=item.size<=FILE_LIMIT and not item.pax_headers, 'kit-sealed-file')
            with archive.extractfile(item) as member:
                body=member.read(item.size+1)
            pin={'mode':item.mode,'size':len(body),'sha256':sha(body)}
            need(item.size==len(body) and pin==expected[name],'kit-sealed-entry-digest-or-mode')
            realized[name]=item.mode,body
    need(manifest(realized)==expected,'kit-complete-file-roster')
    return realized


def write_owned(root, entries, uid, gid):
    owner=root.lstat()
    need(root.resolve(strict=True)==root and stat.S_ISDIR(owner.st_mode) and
         stat.S_IMODE(owner.st_mode)==0o700 and owner.st_uid==uid and not any(root.iterdir()),
         'kit-owned-empty-target')
    for name,(mode,body) in sorted(entries.items()):
        parent=root
        for part in path_name(name).split('/')[:-1]:
            parent/=part
            if not os.path.lexists(parent):
                parent.mkdir(mode=0o700)
                os.chown(parent,uid,gid,follow_symlinks=False)
            row=parent.lstat()
            need(stat.S_ISDIR(row.st_mode) and (row.st_uid,row.st_gid)==(uid,gid)
                 and stat.S_IMODE(row.st_mode)==0o700,'kit-parent-ownership')
        path=root/name
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600),'wb') as target:
            target.write(body)
            target.flush()
            os.fchown(target.fileno(),uid,gid)
            os.fchmod(target.fileno(),mode)
        need(stat.S_IMODE(path.lstat().st_mode)==mode and pinned(path,max(len(body),1),len(body),sha(body))==body,
             'kit-realized-readback')
