"""Offline-only composition of the producer hook, sealed ISO media and a guest backend."""

from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
from time import monotonic

from folder_record import record as build_record
from readonly_iso import Member, build, memory, need, verify


MIB = 2**20
PRODUCT_LIMIT = 288*MIB
SUPPORT_LIMIT = 192*MIB
PACKAGE_BODY_LIMIT = 64*MIB
TRANSACTION_SHA256 = 'bab31cbbe0e4b4cf8c2cb976571147be182d5ebda2fea9afbe03635debf61fb3'
TRIO = {
    'Diagnostic-Hub-linux-x64.tar.gz': ('PAYLOAD.TGZ',256*MIB),
    'Diagnostic-Hub-linux-x64.tar.gz.sha256': ('PAYLOAD.SHA',256),
    'linux-build-info.json': ('BUILD.JSN',65536),
}
SCOPE = 'inert-only'
GUEST_CHECKS = ('media','network','package_state','dependencies','loader','storage','identity','pty',
                'install','uninstall','poweroff')


def canon(value):
    return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode('ascii')


def digest(data):
    return sha256(data).hexdigest()


def sha(value):
    return isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value) is not None


def closed(pairs):
    value = dict(pairs)
    need(len(pairs) == len(value),'duplicate-json-key')
    return value


def require_time(deadline):
    need(monotonic() < deadline,'controller-deadline')


def private(directory):
    st = directory.lstat()
    need(directory.resolve(strict=True) == directory and st.st_uid == os.getuid() == os.geteuid() != 0
         and st.st_mode & 0o177777 == 0o40700, 'controller-private-directory')


def read_fixed(path, limit):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    with os.fdopen(os.open(path,flags),'rb') as body:
        row = os.fstat(body.fileno())
        need(stat.S_ISREG(row.st_mode) and row.st_uid == os.getuid() and row.st_nlink == 1
             and 0 < row.st_size <= limit and not row.st_mode & 0o7022, 'controller-fixed-file')
        data = body.read(limit+1)
        need(len(data) == row.st_size,'controller-fixed-size')
        return data


@dataclass(frozen=True)
class Export:
    directory: Path
    header: dict


def collect(worker, verdicts, attempt, export_root):
    """The existing owned worker is retired on both accept and refusal paths."""
    try:
        private(export_root)
        need(not any(export_root.iterdir()),'private-export-roster')
        header = worker.attach_folder_export(verdicts,attempt,export_root)
    finally:
        retired = worker.retire()
    need(retired is True,'producer-retirement')
    return Export(export_root,header)


def product_entries(export, expected_attempt, nonce, transaction_pin):
    private(export.directory)
    header = export.header
    need(type(header) is dict and set(header) == {'attempt','members'} and
         type(expected_attempt) is dict and expected_attempt.get('run_attempt') == 1 and
         header['attempt'] == expected_attempt and sha(nonce) and
         sha(transaction_pin),'producer-attempt')
    members = header['members']
    need(type(members) is list and len(members) == len(TRIO)
         and {path.name for path in export.directory.iterdir()} == set(TRIO),'producer-export-roster')
    entries = []
    for member,(original,(alias,cap)) in zip(members,TRIO.items(),strict=True):
        need(type(member) is list and len(member) == 3 and member[0] == original
             and type(member[1]) is int and 0 < member[1] <= cap and sha(member[2]),'producer-member-pin')
        entries.append(Member(alias,export.directory/original,member[1],member[2]))
    tar, sidecar, record = entries
    expected_sidecar = f'{tar.sha256}  {next(iter(TRIO))}\n'.encode()
    sidecar_bytes = read_fixed(sidecar.source,256)
    need(sidecar_bytes == expected_sidecar and digest(sidecar_bytes) == sidecar.sha256,'producer-sidecar')
    record_bytes = read_fixed(record.source,65536)
    need(digest(record_bytes) == record.sha256 and json.loads(record_bytes,object_pairs_hook=closed) ==
         build_record(expected_attempt,tar.size,tar.sha256),'producer-record')
    binding = canon({'attempt':expected_attempt,'nonce':nonce,'transactionSHA256':transaction_pin,
                     'sourceMembers':members})
    return [*entries,memory('BIND.JSN',binding)]


def dependency_entries(transaction, expected_sha, directory):
    need(digest(transaction) == expected_sha,'guest-transaction-pin')
    lock = json.loads(transaction,object_pairs_hook=closed)
    rows = lock['entries']
    need(0 < len(rows) <= 80 and lock['compressedPackageBytes'] <= PACKAGE_BODY_LIMIT,'guest-package-budget')
    if expected_sha == TRANSACTION_SHA256:
        need(len(rows) == 67 and lock['transaction'] == {'adds':62,'upgrades':5,'removals':0}
             and lock['guestAfterPackageCount'] == 726,'guest-package-census')
    entries = [memory('LOCK.JSN',transaction)]
    cache_names = set()
    for index,row in enumerate(rows):
        name = row['cacheName']
        need(type(name) is str and re.fullmatch(r'[A-Za-z0-9+_.%~:-]+\.deb',name) and name not in cache_names,
             'guest-package-name')
        cache_names.add(name)
        entries.append(Member(f'P{index:03}.DEB',directory/name,row['compressed_bytes'],row['sha256']))
    present = {path.name for path in directory.iterdir()}
    if 'partial' in present:
        partial = directory/'partial'
        need(stat.S_ISDIR(partial.lstat().st_mode) and not any(partial.iterdir()),'guest-package-partial')
        present.remove('partial')
    need(sum(entry.size for entry in entries[1:]) == lock['compressedPackageBytes']
         and present == cache_names,'guest-package-roster')
    return entries


def fixed_path(path):
    need(path.is_absolute() and path.resolve(strict=True) == path and
         not re.search(r'[,\x00-\x20]',str(path)), 'qemu-path')
    return str(path)


def qemu_arguments(executable, base, overlay, code, vars_copy, bios, seed, product, dependencies):
    """Only this argument shape may reach a future admitted backend."""
    binary, base, overlay, code, vars_copy, bios, seed, product, dependencies = map(
        fixed_path,(executable,base,overlay,code,vars_copy,bios,seed,product,dependencies))
    nodes = [
        {'driver':'file','node-name':'basefile','filename':base,'read-only':True},
        {'driver':'qcow2','node-name':'base','file':'basefile','backing':None,'read-only':True},
        {'driver':'file','node-name':'overlayfile','filename':overlay},
        {'driver':'qcow2','node-name':'system','file':'overlayfile','backing':'base','read-only':False},
    ]
    argv = [binary,'-machine','q35,accel=tcg','-cpu','max','-smp','2','-m','2048','-nodefaults','-no-user-config',
            '-nic','none','-display','none','-monitor','none','-serial','stdio','-no-reboot','-L',bios,
            '-drive',f'if=pflash,unit=0,format=raw,readonly=on,file={code}',
            '-drive',f'if=pflash,unit=1,format=raw,file={vars_copy}']
    for node in nodes:
        argv.extend(('-blockdev',json.dumps(node,separators=(',',':'))))
    argv.extend(('-device','virtio-blk-pci,drive=system,bootindex=1'))
    for drive_id, bus, image in (('cidata','ide.1',seed),('payload','ide.2',product),('packages','ide.3',dependencies)):
        argv.extend(('-drive',f'if=none,id={drive_id},format=raw,media=cdrom,readonly=on,file={image}',
                     '-device',f'ide-cd,drive={drive_id},bus={bus}'))
    return argv


def guest_receipt(raw, nonce):
    need(0 < len(raw) <= 4096 and raw.endswith(b'\n') and sha(nonce),'guest-receipt-envelope')
    lines = raw.decode('ascii').splitlines()
    for index, line in enumerate(lines):
        need(index < len(GUEST_CHECKS),'guest-receipt-extra')
        stage = GUEST_CHECKS[index]
        expected = f'HUB_FOLDER {nonce} {stage} '
        need(line in (expected+'pass',expected+'fail'),'guest-receipt-identity')
        if line.endswith(' fail'):
            need(index == len(lines)-1,'guest-receipt-after-failure')
            raise ValueError('guest-'+stage)
    need(len(lines) == len(GUEST_CHECKS),'guest-receipt-incomplete')
    return tuple(GUEST_CHECKS)


def run_inert(*, make_worker, verdicts, attempt, attempt_fields, export_root, media_root, packages,
              transaction, expected_transaction, nonce, backing, admit_inputs, plan, guest, seconds):
    """Use only with an inert worker and guest. There is no real activation path."""
    need(type(seconds) is int and 0 < seconds <= 720,'controller-time-bound')
    deadline = monotonic()+seconds
    def check():
        require_time(deadline)

    private(media_root)
    need(not any(media_root.iterdir()),'private-media-roster')
    need(backing('host-export'),'host-export-storage')
    # Live wiring must independently admit the tool/firmware/loader and signed base before material setup.
    need(admit_inputs() is True,'qemu-tool-and-source')
    require_time(deadline)
    export = collect(make_worker(),verdicts,attempt,export_root)
    require_time(deadline)
    need(backing('host-media'),'host-media-storage')
    payload = product_entries(export,attempt_fields,nonce,expected_transaction)
    dependencies = dependency_entries(transaction,expected_transaction,packages)
    product, support = media_root/'product.iso',media_root/'support.iso'
    first = build(product,'HUB_PAYLOAD',payload,PRODUCT_LIMIT,check=check)
    second = build(support,'HUB_DEPS',dependencies,SUPPORT_LIMIT,check=check)
    require_time(deadline)
    need(backing('host-guest-start'),'host-guest-start-storage')
    argv = qemu_arguments(*plan,product,support)
    need(first == verify(product,'HUB_PAYLOAD',payload,PRODUCT_LIMIT,check=check)
         and second == verify(support,'HUB_DEPS',dependencies,SUPPORT_LIMIT,check=check),'sealed-media-before-guest')
    require_time(deadline)
    seed_contract = {
        'nonce':nonce, 'attempt':attempt_fields, 'transactionSHA256':expected_transaction,
        'productBindingSHA256':payload[-1].sha256, 'productISO':first, 'supportISO':second,
    }
    reply = guest(argv, max(0,deadline-monotonic()), seed_contract)
    need(reply['clientReaped'] is True and reply['engineRetired'] is True and reply['exit'] == 0,
         'guest-process-retirement')
    require_time(deadline)
    need(first == verify(product,'HUB_PAYLOAD',payload,PRODUCT_LIMIT,check=check)
         and second == verify(support,'HUB_DEPS',dependencies,SUPPORT_LIMIT,check=check),'sealed-media-after-guest')
    steps = guest_receipt(reply['receipt'],nonce)
    return {'mode':SCOPE,'fixtureVerdicts':steps,'product':first,'dependencies':second}
