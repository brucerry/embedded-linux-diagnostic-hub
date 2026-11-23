"""Read actual backing specific to each phase. This tool allocates no storage."""

from collections import defaultdict
import os
from pathlib import Path
import stat


MIB = 2**20
GIB = 2**30
EXPORT_CAP = 256*MIB + 65536 + 256
MEDIA_LIMITS = {
    'intake':896*MIB, 'qemu_root':512*MIB, 'product_iso':288*MIB, 'support_iso':128*MIB, 'apt_iso':64*MIB, 'seed':4*MIB,
}
# The trio is already sealed when the media phase starts. It is retired after readback.
PHASES = {
    'host-export': (4*GIB, {'export':EXPORT_CAP+256*MIB}),
    'host-media': (6*GIB, {**MEDIA_LIMITS, 'aux':64*MIB+256*MIB}),
    # Count only new writes here. All read-only inputs already occupy their own blocks.
    'host-guest-start': (6*GIB, {'overlay':4*GIB,'aux':64*MIB+256*MIB}),
}


def opened_backing(path):
    path = Path(path)
    if path != path.resolve(strict=True):
        raise ValueError('storage-canonical')
    fd = os.open(path,os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        first = os.fstat(fd)
        space = os.fstatvfs(fd)
        last = path.lstat()
        if not stat.S_ISDIR(first.st_mode) or (first.st_dev,first.st_ino) != (last.st_dev,last.st_ino) or (
                space.f_flag & os.ST_RDONLY or not 4096 <= space.f_frsize <= 65536):
            raise ValueError('storage-readback')
        return first.st_dev, space.f_bavail * space.f_frsize, space.f_favail
    finally:
        os.close(fd)


def measure(phase, paths):
    reserve, charges = PHASES[phase]
    if set(charges) != set(paths):
        raise ValueError('storage-phase-roster')
    grouped = defaultdict(list)
    for role, path in paths.items():
        dev, free, free_inodes = opened_backing(path)
        grouped[dev].append((role, free, free_inodes))
    results = []
    for rows in grouped.values():
        roles = sorted(row[0] for row in rows)
        free = min(row[1] for row in rows)
        required = reserve + sum(charges[role] for role in roles)
        # Directory and file allocations are also accounted by the closed input rosters.
        inodes = min(row[2] for row in rows)
        results.append({'roles':roles,'availableBytes':free,'requiredBytes':required,
                        'availableInodes':inodes,'requiredInodes':4096,
                        'admitted':free>=required and inodes>=4096})
    return {'phase':phase,'backings':results,'admitted':all(row['admitted'] for row in results)}
