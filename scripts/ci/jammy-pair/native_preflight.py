"""Disabled, data-only admission for a same-attempt Jammy tar runtime check."""

from dataclasses import asdict, dataclass
from hashlib import sha256
from native_hash import sha256_stream
import json
import os
from pathlib import Path
import re
import stat
from time import monotonic

import archive_inventory
import runtime_cache as cache
import runtime_contract as contract
import handoff
import pair_guest
import pair_wire
import readonly_iso

HERE = Path(__file__).resolve().parent
MIB = 2**20
GIB = 2**30
CLUSTER = 64 * 1024
BASE_IMAGE = '77d19e53656f87c95f1f6c6be59c789083b3f77fa08f9d88011ee04085c61f87'
DISPLAY_PIN = '5db26dee779a0b380a81395a6dccc65adaca81424fea597744e3a22a7dd2f701'
RUNTIME_PIN = '1ef47408fb6ecc64a8e6460ad713aa74ca91dd7a0e6768a65866b9ee773ebd1c'
SNAPSHOT = 'https://snapshot.ubuntu.com/ubuntu/20261120T060000Z/'
HOST_FLOOR = 6 * GIB
GUEST_FLOOR = 4 * GIB
CURRENT_CUSTODY_CAP = 512 * MIB
NATIVE_PLANNING_CAP = 2 * GIB
NATIVE_SENSITIVITY_CAP = 5 * GIB // 2
GUEST_IMAGE_ARCHIVE_BYTES = 717777408
HOST_MEDIA_INTAKE_AND_OUTPUT_CAP = 2 * (48 + 16) * MIB
EPHEMERAL_PRE_BOOT_BUDGET = 320 * MIB
GUEST_DISK = 7 * GIB
CAPS = (48 * MIB, 16 * MIB)
OBSERVED_RUNTIME_CLUSTERS = 1164378112
RUNTIME_EXTRA_CLUSTER_SENSITIVITY = 7518 * CLUSTER
BOOT_GROW_RESERVE = 64 * MIB
RUNTIME_WRITE_RESERVE = 64 * MIB
CLEANUP_RESERVE = 128 * MIB
PAST_CUSTODY_RUNS = frozenset(('45316897041', '45318116305'))
NEEDED_ROLES = (
    'producer-inputs', 'source-and-package-provenance', 'pre-boot-retirement',
    'guest-stock-security', 'guest-loopback-only', 'guest-no-nic',
    'offline-apt-plan', 'native-loader-and-providers',
    'standard-user-and-private-home', 'authenticated-display-and-cookie-refusal',
    'user-and-pid-namespace',
)
need = pair_wire.need


def read_lock(name, pin):
    body = (HERE / name).read_bytes()
    need(0 < len(body) <= 65536 and sha256(body).hexdigest() == pin, 'runtime-lock-digest')
    return body, json.loads(body, object_pairs_hook=pair_wire.closed_object)


def package_digest(packages):
    return sha256(pair_wire.canonical(packages)).hexdigest()


def runtime_locks():
    display_raw, display = read_lock('GUEST-TRANSACTION.json', DISPLAY_PIN)
    extra_raw, extra = read_lock('RUNTIME-51-LOCK.json', RUNTIME_PIN)
    need(display['snapshot'] == SNAPSHOT and extra['signedSnapshot'] == '20261120T060000Z'
         and extra['prerequisiteDisplayLockSHA256'] == sha256(display_raw).hexdigest(),
         'runtime-snapshot-and-display-parent')
    roles = tuple((raw, obj, count, size, before, after)
                  for raw, obj, count, size, before, after in (
        (display_raw, display, 54, 38586094, 597, 651),
        (extra_raw, extra, 51, 12642274, 651, 702),
    ))
    used = set()
    for _, doc, count, size, before, after in roles:
        rows = doc['entries']
        need(type(rows) is list and len(rows) == count and
             doc['transaction'] == {'adds': count, 'upgrades': 0, 'removals': 0} and
             (doc['guestBeforePackageCount'], doc['guestAfterPackageCount']) == (before, after) and
             sum(row['compressed_bytes'] for row in rows) == size, 'runtime-exact-transaction-roster')
        cache.cache_names(rows)
        for row in rows:
            name = row['name']
            need(name not in {*used, 'libfuse2', 'fuse', 'fuse3'} and
                 row['beforeVersion'] is None and row['architecture'] in ('amd64', 'all') and
                 re.fullmatch('[a-f0-9]{64}', row['sha256']) and
                 len(row['sources']) > 0 and type(row['installed_kib']) is int and
                 row['installed_kib'] > 0, 'runtime-exact-signed-row')
            used.add(name)
    return roles


def check_runtime_solver(display_output, extra_output):
    for output, (_, doc, *_) in zip((display_output, extra_output), runtime_locks(), strict=True):
        contract.plan_matches(output, doc)


def check_runtime_database(stock, display, final):
    (_, display_doc, *_), (_, extra_doc, *_) = runtime_locks()
    need(sha256(stock).hexdigest() == display_doc['guestStatusSHA256'], 'runtime-stock-database')
    contract.provisioned_state(stock, display, display_doc)
    need(package_digest(contract.database(display)) == extra_doc['beforeInventorySHA256'],
         'runtime-post-display-database')
    contract.provisioned_state(display, final, extra_doc)
    need(package_digest(contract.database(final)) == extra_doc['afterInventorySHA256'],
         'runtime-post-supplement-database')


def runtime_media(directory, archives, deadline):
    receipts = []
    for index, ((raw, doc, *_), maximum) in enumerate(zip(runtime_locks(), CAPS, strict=True)):
        label = ('HUB_APT_DEBS', 'HUB_RUNTIME_DEBS')[index]
        target = directory / f'apt-{index}.iso'
        names = [readonly_iso.memory('LOCK.JSN', raw)]
        names.extend(readonly_iso.Member(f'P{num:03}.DEB', archives / (r['sha256'] + '.deb'),
                    r['compressed_bytes'], r['sha256'])
                   for num, r in enumerate(doc['entries']))
        tick = lambda: pair_wire.tick(deadline)
        receipt = readonly_iso.build(target, label, names, maximum, check=tick)
        need(readonly_iso.verify(target, label, names, maximum, check=tick) == receipt,
             'runtime-private-optical-recheck')
        receipts.append(receipt)
    return receipts


def accept_runtime_media(directory, archives, deadline):
    """Recheck the sealed media after handoff. This does not mount or execute it."""
    result = []
    for index, ((raw, doc, *_), cap) in enumerate(zip(runtime_locks(), CAPS, strict=True)):
        members = [readonly_iso.memory('LOCK.JSN', raw)]
        members.extend(readonly_iso.Member(f'P{num:03}.DEB', archives / (r['sha256'] + '.deb'),
                       r['compressed_bytes'], r['sha256'])
                       for num, r in enumerate(doc['entries']))
        result.append(readonly_iso.verify(directory / f'apt-{index}.iso',
                      ('HUB_APT_DEBS', 'HUB_RUNTIME_DEBS')[index], members, cap,
                      check=lambda: pair_wire.tick(deadline)))
    return result


def by_descriptor(mount, name, pin, size, callback):
    directory = os.open(mount, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        stamp = pair_wire.directory_stamp(os.fstat(directory))
        pair_wire.same_directory(mount, directory, stamp)
        flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
        with os.fdopen(os.open(name, flags, dir_fd=directory), 'rb') as stream:
            before = os.fstat(stream.fileno())
            need(stat.S_ISREG(before.st_mode) and before.st_size == size and before.st_nlink == 1
                 and before.st_dev == stamp[0] and not (before.st_mode & 0o222)
                 and sha256_stream(stream).hexdigest() == pin, 'exact-original-reopen')
            stream.seek(0)
            result = callback(stream)
            need(pair_wire.stamp(before) == pair_wire.stamp(os.fstat(stream.fileno())) ==
                 pair_wire.stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)),
                 'exact-original-reopen-changed')
        pair_wire.same_directory(mount, directory, stamp)
    finally:
        os.close(directory)
    return result


def original_tar(mount, authority, expected, manifest_pin, deadline, mountinfo):
    handoff.validate_attempt(authority)
    need(authority.job == 'two-format' and authority.run_id not in PAST_CUSTODY_RUNS
         and expected['attempt'] == asdict(authority), 'fresh-controller-attempt')
    receipt = pair_guest._read_originals(mount, expected, manifest_pin, deadline, mountinfo)
    need(receipt == {'pairManifestSHA256': manifest_pin, 'originals': 5, 'execution': False},
         'guest-originals-readback')
    # Bind the independently generated producer record and canonical sidecars to both original
    # filenames, even after the pair's optical-sector and whole-file hashes passed.
    items = dict((name, (count, pin, physical.lower()))
                 for (name, count, pin), physical in zip(expected['members'],
                 pair_wire.OPTICAL_NAMES, strict=True))
    for item in handoff.ARTIFACTS:
        data = by_descriptor(mount, *pick(items[item + '.sha256']), read_small)
        need(data == f'{items[item][1]}  {item}\n'.encode('ascii'), 'original-checksum-format')
    original = by_descriptor(mount, *pick(items[handoff.RECORD]), read_small)
    document = json.loads(original, object_pairs_hook=pair_wire.closed_object)
    need(document == {'version': '0.6.0', 'platform': 'linux', 'arch': 'x64',
         'assets': {name: items[name][1] for name in handoff.ARTIFACTS},
         'commit': authority.source_commit, 'validation': handoff.UNPERFORMED}, 'original-primary-record')
    pair_wire.tick(deadline)
    rows = by_descriptor(mount, *pick(items[handoff.TARBALL]), archive_inventory.tar_inventory)
    pair_wire.tick(deadline)
    root = Path(archive_inventory.TAR_ROOT)
    launcher = rows[root / 'AppRun']
    payload = rows[root / 'resources/app.asar']
    need(launcher.mode & 0o100 and launcher.size > 0 and payload.size > 0, 'tar-portable-roles')
    return {'tarSHA256': items[handoff.TARBALL][1], 'recordSHA256': items[handoff.RECORD][1],
            'files': [r.size for r in rows.values() if r.kind == 'file'],
            'dirs': sum(r.kind == 'directory' for r in rows.values())}


def pick(item):
    count, pin, name = item
    return name, pin, count


def read_small(stream):
    result = stream.read(65537)
    need(0 < len(result) <= 65536, 'small-original-bound')
    return result


def rounded(value, unit):
    need(type(value) is int and value >= 0, 'allocation-size')
    return (value + unit - 1) // unit * unit


def budget(census):
    sizes, dirs = census['files'], census['dirs']
    need(sizes and all(type(n) is int and n >= 0 for n in sizes) and type(dirs) is int and dirs > 0,
         'fresh-tar-census')
    actual = sum(sizes)
    need(actual <= archive_inventory.MAX_ARCHIVE_FILE_BYTES, 'fresh-tar-logical-content')
    return {
        'logicalBytes': actual,
        'tarTwoCopiesOverlay': 2 * sum(rounded(n, CLUSTER) + CLUSTER for n in sizes if n),
        'tarTwoCopiesGuestBlocks': 2 * sum(rounded(n, 4096) for n in sizes),
        'guestInodeBudget': max(12000, 2 * (len(sizes) + dirs) + 16),
        'nativeInstallerMinimumIfSupported': 3 * actual + 64 * MIB,
    }


@dataclass(frozen=True)
class HostBacking:
    device: int
    available: int
    charge: int
    read_only: bool


def host_capacity(roles):
    need(roles and all(type(row) is HostBacking and type(row.device) is int and row.device > 0 and
                       type(row.available) is int and row.available >= 0 and type(row.charge) is int and
                       row.charge >= 0 and row.read_only is False for row in roles), 'host-backing-readback')
    for device in {row.device for row in roles}:
        shared = [row for row in roles if row.device == device]
        need(min(row.available for row in shared) >= HOST_FLOOR + sum(row.charge for row in shared),
             'host-backing-shared-floor')


@dataclass(frozen=True)
class ObservedGuest:
    image_sha256: str
    virtual_disk_bytes: int
    cluster_bytes: int
    regular_owned_overlay: bool
    qemu_file_soft_limit: int
    qemu_file_hard_limit: int
    overlay_file_bytes: int
    overlay_allocated_bytes: int
    guest_free_bytes: int
    guest_free_inodes: int
    cache_private_tmpfs: bool
    cache_free_bytes_before_copy: int
    cache_free_inodes_before_copy: int
    guest_uid: int
    completed: frozenset


def phase_charge(phase, overlay_cap, product_medium_bytes):
    need(type(overlay_cap) is int and overlay_cap in (NATIVE_PLANNING_CAP, NATIVE_SENSITIVITY_CAP),
         'native-cap-must-be-reviewed')
    need(type(product_medium_bytes) is int and 0 < product_medium_bytes <= pair_wire.CAP,
         'native-product-medium-bound')
    if phase == 'pre-intake':
        return (GUEST_IMAGE_ARCHIVE_BYTES + (96 + 256 + 136) * MIB + product_medium_bytes +
                HOST_MEDIA_INTAKE_AND_OUTPUT_CAP + overlay_cap)
    if phase == 'post-intake':
        return overlay_cap + 16 * MIB
    if phase == 'pre-boot':
        return overlay_cap + EPHEMERAL_PRE_BOOT_BUDGET
    raise ValueError('native-unknown-storage-phase')


def guest_admission(census, facts, candidate_cap):
    """This takes live probes from a trusted caller. Import media cannot supply these facts."""
    need(type(facts) is ObservedGuest and facts.image_sha256 == BASE_IMAGE and
         facts.virtual_disk_bytes == GUEST_DISK and facts.cluster_bytes == CLUSTER,
         'stock-guest-profile')
    need(type(candidate_cap) is int and candidate_cap in (NATIVE_PLANNING_CAP, NATIVE_SENSITIVITY_CAP),
         'native-cap-must-be-reviewed')
    need(facts.regular_owned_overlay is True and
         facts.qemu_file_soft_limit == facts.qemu_file_hard_limit == candidate_cap and
         type(facts.overlay_file_bytes) is int and type(facts.overlay_allocated_bytes) is int and
         0 < facts.overlay_file_bytes <= candidate_cap and 0 < facts.overlay_allocated_bytes <= candidate_cap,
         'native-hard-overlay-bound')
    need(facts.cache_private_tmpfs is True and
         facts.cache_free_bytes_before_copy >= 51228368 + 16 * MIB and
         facts.cache_free_inodes_before_copy >= 128, 'native-separate-cache')
    need(type(facts.guest_uid) is int and facts.guest_uid > 0 and
         type(facts.completed) is frozenset and facts.completed == frozenset(NEEDED_ROLES),
         'native-runtime-gates')
    reserve = RUNTIME_WRITE_RESERVE + CLEANUP_RESERVE
    # Charge the maximum of length/allocated size, without assuming holes or deletion return host blocks.
    already = max(facts.overlay_file_bytes, facts.overlay_allocated_bytes)
    needed = census['tarTwoCopiesOverlay'] + reserve
    need(candidate_cap - already >= needed, 'native-overlay-after-provisioning')
    need(facts.guest_free_bytes >= max(GUEST_FLOOR + census['tarTwoCopiesGuestBlocks'],
                                     census['nativeInstallerMinimumIfSupported'])
         and facts.guest_free_inodes >= census['guestInodeBudget'], 'native-guest-post-provision-floor')
    return {'overlayRequiredRemaining': needed, 'overlayMeasuredRemaining': candidate_cap - already,
            'guestFreeBeforeTar': facts.guest_free_bytes, 'case': 'archive-runtime-identity'}


def preflight(*, authority, expected, manifest_pin, mount, mountinfo, media, archives,
              deadline, host, stock, display, final, solver_outputs, facts, candidate_cap):
    """Combined real data checks and caller-observed state. There is deliberately no product launch."""
    if monotonic() >= deadline:
        raise ValueError('native-preflight-expired')
    host_capacity(host)
    census = budget(original_tar(mount, authority, expected, manifest_pin, deadline, mountinfo))
    media_proof = accept_runtime_media(media, archives, deadline)
    check_runtime_solver(*solver_outputs)
    check_runtime_database(stock, display, final)
    result = guest_admission(census, facts, candidate_cap)
    pair_wire.tick(deadline)
    return {'case': result, 'tar': census, 'media': media_proof, 'productExecuted': False}


if __name__ == '__main__':
    raise SystemExit('Disabled offline preflight. Run test_native_preflight.py for the inert rehearsal.')
