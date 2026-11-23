"""Stage the sealed original tar and join the source-owned envelope's result to it."""
from hashlib import file_digest, sha256
import os
from pathlib import PurePosixPath
import stat
import tarfile

from archive_inventory import TAR_ROOT, TEMP_BYTES_MARGIN, budget, tar_inventory
from filesystem import decode, directory, stamp
from folder_actor import ORIGINAL_TAR, Original, Prepared
from loader_gate import FilePin, need


FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
FLOOR = 4*2**30
MAX_CHUNK = 65536
INSTALLED_APP_RUN = 'resources/linux-installed-AppRun'


def original_copy(root, original):
    """Inventory the same open original prior to allocating any product path."""
    need(isinstance(original,Original),'stage-original-seal')
    media = original.directory/'payload.tgz'
    target = root/ORIGINAL_TAR
    with os.fdopen(os.open(media,FLAGS),'rb') as payload:
        before = os.fstat(payload.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_size==original.size and
             file_digest(payload,'sha256').hexdigest()==original.sha256,'stage-original-tar')
        payload.seek(0)
        rows = tar_inventory(payload)
        space = os.statvfs(root)
        plan = budget(rows,{},space.f_frsize)
        required = FLOOR + original.size + 3*plan['tar']['budgetBytes'] + TEMP_BYTES_MARGIN
        need(not space.f_flag & os.ST_RDONLY and space.f_bavail*space.f_frsize >= required and
             space.f_favail >=3*len(rows)+64, 'stage-actual-guest-capacity')
        payload.seek(0)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        with os.fdopen(os.open(target,flags,0o400),'wb') as copy:
            size, hash_copy = 0, sha256()
            while packet := payload.read(MAX_CHUNK):
                size += len(packet)
                need(size <= original.size,'stage-copy-limit')
                hash_copy.update(packet)
                copy.write(packet)
            need((size,hash_copy.hexdigest())==(original.size,original.sha256) and
                 stamp(before)==stamp(os.fstat(payload.fileno()))==stamp(media.lstat()),
                 'stage-copy-identity')
    return target, rows


def source_tree(tar, root, original, inventory, uid):
    """Create exact tar members under an empty owned path. Return file pins from those reads."""
    need(os.getuid()==os.geteuid()==uid>0 and uid==directory(root,uid).st_uid and
         not os.path.lexists(root/TAR_ROOT),'stage-fresh-source-tree')
    sourced = {}
    seen = set()
    for name,target in sorted(inventory.items(),key=lambda row:len(row[0].parts)):
        if target.kind == 'directory':
            (root/name).mkdir(mode=0o700)
    with os.fdopen(os.open(tar,FLAGS),'rb') as checked:
        before = os.fstat(checked.fileno())
        need(stat.S_IMODE(before.st_mode)==0o400 and before.st_uid==uid and before.st_nlink==1
             and before.st_size==original.size and
             file_digest(checked,'sha256').hexdigest()==original.sha256,'stage-protected-original-copy')
        checked.seek(0)
        with tarfile.open(fileobj=checked,mode='r|gz') as archive:
            for member in archive:
                name = PurePosixPath(member.name)
                expected = inventory.get(name)
                need(name not in seen and expected is not None and
                     (member.size,member.mode)==(expected.size,expected.mode),'stage-inventory-agreement')
                seen.add(name)
                if expected.kind=='directory':
                    need(member.isdir(),'stage-directory-type')
                    continue
                need(member.isfile() and not member.sparse,'stage-regular-member')
                size, hasher = 0, sha256()
                flags = os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC
                with archive.extractfile(member) as content, os.fdopen(os.open(root/name,flags,0o600),'wb') as file:
                    while part := content.read(MAX_CHUNK):
                        size+=len(part)
                        need(size<=expected.size,'stage-member-size')
                        hasher.update(part)
                        file.write(part)
                    need(size==expected.size,'stage-member-size')
                    os.fchmod(file.fileno(),expected.mode)
                key = PurePosixPath(*name.parts[1:]).as_posix()
                sourced[key] = FilePin(size,hasher.hexdigest(),expected.mode)
        need(seen==inventory.keys() and stamp(before)==stamp(os.fstat(checked.fileno()))==stamp(tar.lstat()),
             'stage-original-copy-changed')
    need('AppRun' in sourced and INSTALLED_APP_RUN in sourced and sourced[INSTALLED_APP_RUN].mode==0o755,
         'stage-original-launcher-map')
    return sourced | {'AppRun':sourced[INSTALLED_APP_RUN]}


def prepare(root, uid, original, prepare_verified_envelope):
    """The future owner supplies the pinned, bounded source-owned helper, after Node admission."""
    checked, inventory = original_copy(root,original)
    files = source_tree(checked,root,original,inventory,uid)
    raw = prepare_verified_envelope(original)
    need(type(raw) is bytes and 0<len(raw)<=512 and raw.endswith(b'\n'),'stage-envelope-receipt-bound')
    result = decode(raw)
    need(type(result) is dict and set(result)=={'status','descriptorSHA256','appRunSHA256'}
         and result['status']=='prepared-install-envelope' and result['appRunSHA256']==files['AppRun'].sha256,
         'stage-envelope-source-bound')
    return Prepared(files,result['descriptorSHA256'])
