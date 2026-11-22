"""Observe identities only in the pinned, network-none Noble worker."""
from collections import deque
from contextlib import contextmanager
import ctypes
import os
from pathlib import Path
import re
import stat
import sys

import compiler_gate as compiler
import tar_admission as pins
from host import capture
from worker_protocol import LOADER_TARGETS, MASK_TARGETS, MOUNT_TARGETS, READ_TARGETS


INPUTS = Path('/inputs')
WORK = Path('/work')
SCRATCH = Path('/scratch')
GNU_LOADER = Path(compiler.INTERPRETER)
CAPS = {WORK:10*1024**3,SCRATCH:768*1024**2}
PROC_FILE_MASKS = set(MASK_TARGETS)

def need(ok, reason):
    if not ok:
        raise ValueError(reason)


class MountFailure(Exception):
    def __init__(self, clause, target=0):
        self.clause = clause
        self.target = target


def mount_target(path):
    return MOUNT_TARGETS.index(path) + 1 if path in MOUNT_TARGETS else 0


def mount_readback(body, device):
    mounts = {}
    masks = {}
    pseudo = {'/proc':'proc','/dev':'tmpfs','/dev/pts':'devpts','/dev/mqueue':'mqueue'}
    for line in body.splitlines():
        first, sep, last = line.partition(' - ')
        fields, tail = first.split(), last.split()
        if not sep or len(fields) < 6 or len(tail) < 3:
            raise MountFailure('frame')
        number, root, dest, flags = fields[2], fields[3], fields[4], set(fields[5].split(','))
        fs = tail[0]
        if dest in mounts:
            raise MountFailure('duplicate', mount_target(dest))
        mounts[dest] = (flags, fs)
        if dest in PROC_FILE_MASKS:
            if fs != 'tmpfs' or root != '/null':
                raise MountFailure('mask_form', mount_target(dest))
            masks[dest] = number
            continue
        if 'rw' in flags:
            if dest in READ_TARGETS:
                raise MountFailure('read_only', mount_target(dest))
            if dest in {str(root) for root in CAPS}:
                if fs != 'tmpfs' or not {'rw','nosuid','nodev'} <= flags or 'noexec' in flags:
                    raise MountFailure('tmpfs_options', mount_target(dest))
            elif pseudo.get(dest) != fs:
                raise MountFailure('unexpected_write')
    try:
        null = device('/dev/null')
    except OSError:
        raise MountFailure('null_device', mount_target('/dev/null')) from None
    if not stat.S_ISCHR(null.st_mode) or (os.major(null.st_rdev), os.minor(null.st_rdev)) != (1, 3):
        raise MountFailure('null_device', mount_target('/dev/null'))
    for path, number in masks.items():
        try:
            observed = device(path)
        except OSError:
            raise MountFailure('mask_stat', mount_target(path)) from None
        if (number != f'{os.major(null.st_dev)}:{os.minor(null.st_dev)}'
                or (observed.st_mode,observed.st_rdev,observed.st_dev,observed.st_ino)
                != (null.st_mode,null.st_rdev,null.st_dev,null.st_ino)):
            raise MountFailure('mask_identity', mount_target(path))
    for place in READ_TARGETS:
        if place not in mounts or 'ro' not in mounts[place][0]:
            raise MountFailure('read_only', mount_target(place))
    return mounts


def require_masks_or_absence(mounts):
    for place in sorted(PROC_FILE_MASKS - mounts.keys()):
        try:
            os.lstat(place)
        except FileNotFoundError:
            continue
        except OSError:
            raise MountFailure('mask_absence_stat', mount_target(place)) from None
        raise MountFailure('mask_uncovered', mount_target(place))


def effective_worker():
    with phase('runtime_account'):
        uid,gid=os.geteuid(),os.getegid()
        need(os.getuid()==uid!=0 and os.getgid()==gid!=0 and os.uname().machine=='x86_64','nonroot-worker')
    with phase('runtime_sandbox'):
        status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines())
        need(status['Seccomp'].strip()=='2' and status['NoNewPrivs'].strip()=='1' and
             all(int(status[key].strip(),16)==0 for key in ('CapEff','CapPrm','CapBnd','CapAmb')),'stock-sandbox-security')
    with phase('runtime_network'):
        need({entry.name for entry in Path('/sys/class/net').iterdir()}=={'lo'} and
             all(line.split()[0]=='lo' for line in Path('/proc/net/route').read_text().splitlines()[1:] if line.split()) and
             all(line.split()[-1]=='lo' for line in Path('/proc/net/ipv6_route').read_text().splitlines() if line.split()),'loopback-only')
    with phase('runtime_mounts'):
        try:
            body = Path('/proc/self/mountinfo').read_text()
        except (OSError, UnicodeError):
            raise MountFailure('read') from None
        mounts = mount_readback(body, os.lstat)
        require_masks_or_absence(mounts)
    with phase('runtime_write_caps'):
        for root,size in CAPS.items():
            need(root.resolve()==root and not any(root.iterdir()),'fresh-private-tmpfs')
            row=root.lstat()
            fs=os.statvfs(root)
            need(mounts[str(root)][1]=='tmpfs' and (row.st_uid,row.st_gid,stat.S_IMODE(row.st_mode))==(uid,gid,0o700)
                 and fs.f_blocks*fs.f_frsize==size,'actual-tmpfs-ceiling-and-owner')
    with phase('runtime_pid'):
        need(os.readlink('/proc/self/ns/pid')==os.readlink('/proc/1/ns/pid') and os.getpid()==1,'job-private-pid-one')


def loader_map(body, resolve=lambda value: str(Path(value).resolve(strict=True))):
    result={}
    vdso_seen = False
    need(body.endswith(b'\n'), 'stock-loader-framing')
    for line in body.decode('ascii').splitlines():
        entry=re.fullmatch(r'\s*(\S+)(?: => (/\S+))? \(0x[0-9a-f]+\)',line)
        need(entry,'stock-loader-framing')
        name,path=entry.groups()
        if name=='linux-vdso.so.1':
            need(path is None and not vdso_seen,'vdso-form')
            vdso_seen = True
            continue
        if name.startswith('/'):
            need(name==str(GNU_LOADER),'loader-path-form')
            name,path=GNU_LOADER.name,path or name
        need(path is not None,'loader-library-path')
        need(name not in result,'unique-live-libraries')
        result[name]=resolve(path)
    need(vdso_seen, 'vdso-form')
    return result


def closure(seed, roles):
    found={}
    queue=deque(seed)
    while queue:
        name=queue.popleft()
        if name in found:
            continue
        row=roles[name]
        found[name]=row['canonical']
        queue.extend(row['directNeeded'])
    return found


def compiled_root(configuration):
    reference = configuration['NOBLE-COMPILER-REFERENCE.json']
    with phase('compiler_packages'):
        pins.stock_packages(reference)
    with phase('compiler_package_members'):
        pins.stock_members(reference)
    with phase('compiler_plan'):
        pins.stock_compiler_alias()
        abi = compiler.load_plan()
    compiler.readback(abi, checkpoint=phase)
    with phase('compiler_no_preload'):
        need(not os.path.lexists('/etc/ld.so.preload'),'no-loader-preload')
    with phase('compiler_loader_trace'):
        live_compiler_resolution(abi)


def live_compiler_resolution(abi):
    try:
        roles = {Path(p).name: row for p, row in abi['elfMembersAndDirectResolution'].items()}
        targets = {row['canonical']: list(row['directNeeded']) for row in roles.values()
                   if row['interpreter'] and row['canonical'].startswith(('/usr/bin/', '/usr/libexec/gcc/'))}
        plugin = abi['possibleLinkerPlugin']
        plugin_path = plugin['canonical']
    except Exception:
        raise LoaderPrecheckFailure('target_roster') from None
    try:
        plugin_bytes = compiler.read_member(Path(plugin_path), plugin['pin'], capture=True)
    except Exception:
        raise LoaderPrecheckFailure('plugin_readback') from None
    try:
        _, linked = compiler.elf_identity(plugin_bytes)
    except Exception:
        raise LoaderPrecheckFailure('plugin_elf') from None
    try:
        targets[plugin_path] = linked
        need(set(targets) == set(LOADER_TARGETS), 'exact-loader-targets')
    except Exception:
        raise LoaderPrecheckFailure('target_roster') from None
    for index, exe in enumerate(LOADER_TARGETS, 1):
        dependencies = targets[exe]
        env = {'LANG': 'C', 'PATH': '/usr/bin:/bin'}
        try:
            reason, stdout, stderr = capture([GNU_LOADER, '--list', exe], env, 5, limit=8192)
        except Exception:
            raise LoaderFailure(index, 'command') from None
        if reason != 'ok' or stderr or not stdout:
            raise LoaderFailure(index, 'command')
        try:
            observed = loader_map(stdout)
        except Exception:
            raise LoaderFailure(index, 'framing') from None
        try:
            expected = closure([*dependencies, GNU_LOADER.name], roles)
        except Exception:
            raise LoaderFailure(index, 'dependency_plan') from None
        if observed != expected:
            raise LoaderFailure(index, 'map')


class LoaderPrecheckFailure(Exception):
    def __init__(self, kind):
        self.kind = kind


class LoaderFailure(Exception):
    def __init__(self, index, kind):
        self.index = index
        self.kind = kind


@contextmanager
def phase(name):
    try:
        yield
    except Exception:
        print(f'HUB_TAR_PHASE {name} fail', flush=True)
        raise
    print(f'HUB_TAR_PHASE {name} pass', flush=True)


def entry(argv):
    try:
        bound, = argv
        need(re.fullmatch(r'[1-9][0-9]{0,18}-1', bound), 'run-identity')
        os.umask(0o077)
        effective_worker()
        with phase('runtime_manifests'):
            config = pins.pins()
        compiled_root(config)
        with phase('runtime_subreaper'):
            need(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'worker-subreaper')
    except MountFailure as failure:
        print(f'HUB_IDENTITY_MOUNT_FAILURE {failure.clause} {failure.target}', flush=True)
        return 1
    except LoaderPrecheckFailure as failure:
        print(f'HUB_IDENTITY_LOADER_PRECHECK_FAILURE {failure.kind}', flush=True)
        return 1
    except LoaderFailure as failure:
        print(f'HUB_IDENTITY_LOADER_FAILURE {failure.index} {failure.kind}', flush=True)
        return 1
    except Exception:
        return 1
    print(f'HUB_IDENTITY_ONLY_OK {bound}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(entry(sys.argv[1:]))
