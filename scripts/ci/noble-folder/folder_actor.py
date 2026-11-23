"""Disabled composition of original custody, loader maps, and exactly two private PTY operations."""
from dataclasses import dataclass
import os
from pathlib import Path
import re
from time import monotonic

import consent
from folder_record import record as build_record
from filesystem import WORK, DESCRIPTOR, decode, directory, digest, read, read_installed, read_removed, tree
from guest_install_gate import locked_file, media_files, product_media
from loader_gate import FilePin, ROLE_PATHS, need, verify
from pty_actor import pump


ORIGINAL_TAR = 'Diagnostic-Hub-linux-x64.tar.gz'
CANDIDATE_COMMIT = re.compile(r'[a-f0-9]{40}')
HASH = re.compile(r'[a-f0-9]{64}')


@dataclass(frozen=True)
class Original:
    directory: Path
    size: int
    sha256: str
    commit: str
    attempt: dict
    binding_sha: str


@dataclass(frozen=True)
class Prepared:
    app_files: dict[str, FilePin]
    descriptor_sha: str


@dataclass(frozen=True)
class LoaderReference:
    loader: FilePin
    node: FilePin
    providers: dict[str, dict[str, tuple[str, FilePin]]]


def read_media(path, cap):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    with os.fdopen(os.open(path,flags),'rb') as body:
        st = os.fstat(body.fileno())
        data = body.read(cap+1)
        after = os.fstat(body.fileno())
        need(0 < st.st_size == len(data) <= cap and
             (st.st_dev,st.st_ino,st.st_ctime_ns,st.st_mtime_ns) ==
             (after.st_dev,after.st_ino,after.st_ctime_ns,after.st_mtime_ns),'folder-media-small-read')
    return data


def selected_original(media, binding_sha, attempt, nonce, transaction):
    need(type(binding_sha) is str and HASH.fullmatch(binding_sha) and type(nonce) is str
         and HASH.fullmatch(nonce) and type(transaction) is str and HASH.fullmatch(transaction),
         'folder-private-input-identity')
    commit = attempt.get('source_commit', '')
    need(type(commit) is str and CANDIDATE_COMMIT.fullmatch(commit)
         and type(attempt.get('run_attempt')) is int and attempt['run_attempt'] == 1
         and attempt.get('job') == 'two-format', 'folder-producer-attempt')
    product_media(media,binding_sha,attempt,nonce,transaction)
    files = media_files(media)
    raw = read_media(files['bind.jsn'],8192)
    need(digest(raw) == binding_sha, 'folder-binding-changed')
    binding = decode(raw)
    row, sidecar, record = binding['sourceMembers']
    _, size, tar_sha = row
    need(type(tar_sha) is str and HASH.fullmatch(tar_sha),'folder-original-digest')
    original_checksum = read_media(files['payload.sha'],256)
    need(len(original_checksum) == sidecar[1] and digest(original_checksum) == sidecar[2]
         and original_checksum == f'{tar_sha}  {ORIGINAL_TAR}\n'.encode('ascii'),
         'folder-original-sidecar')
    original_record = read_media(files['build.jsn'],65536)
    need(len(original_record) == record[1] and digest(original_record) == record[2]
         and decode(original_record) == build_record(attempt,size,tar_sha),'folder-original-record')
    return Original(media, size, tar_sha, commit, dict(attempt), binding_sha)


def custody_matches(original, media, binding_sha, attempt, nonce, transaction):
    need(selected_original(media,binding_sha,attempt,nonce,transaction) == original,
         'folder-original-removal-binding')


def execute_case(*, root, uid, media, binding_sha, attempt, nonce, transaction,
                 references, backend, deadline, now=monotonic):
    """Single fixed fixture/guest contract. No environment/CLI route calls it."""
    def bound():
        need(now() < deadline, 'folder-case-deadline')

    bound()
    owner = directory(root,uid)
    need(owner.st_mode & 0o7777 == 0o700 and not any(os.path.lexists(root/leaf) for leaf in
         ('installed',WORK,WORK+'-uninstall','envelope',ORIGINAL_TAR)), 'folder-fresh-owned-root')
    backend.preflight()
    original = selected_original(media,binding_sha,attempt,nonce,transaction)
    need(isinstance(references, LoaderReference) and references.providers.keys() == ROLE_PATHS.keys(),
         'folder-loader-reference-contract')
    verify('node',backend.loader('node'),references.node,references.loader,references.providers['node'])
    bound()
    prepared = backend.stage(original)
    bound()
    need(isinstance(prepared, Prepared) and HASH.fullmatch(prepared.descriptor_sha),
         'folder-preparation-contract')
    locked_file(root/ORIGINAL_TAR, original.size, original.sha256)
    envelope = tree(root/'envelope',uid)
    need({key[4:]:pin for key,pin in envelope.files.items() if key.startswith('app/')} ==
         prepared.app_files and set(envelope.files) == {DESCRIPTOR,*(f'app/{key}' for key in prepared.app_files)}
         and prepared.descriptor_sha == digest(read(root/'envelope'/DESCRIPTOR,uid,4*2**20)),
         'folder-prepared-envelope-pin')
    for path in ('diagnostic-hub','AppRun','resources/linux-setup-install.cjs',
                 'resources/diagnostic_hub_rename_noreplace.node','resources/app.asar'):
        need(path in prepared.app_files, 'folder-prepared-role')
    need(prepared.app_files['AppRun'].mode == prepared.app_files['diagnostic-hub'].mode == 0o755
         and all(prepared.app_files[path].mode == 0o644 for path in (
             'resources/linux-setup-install.cjs','resources/diagnostic_hub_rename_noreplace.node',
             'resources/app.asar')), 'folder-prepared-role-mode')
    menu = tree(root/'data',uid)
    targets = {
        'node': references.node,
        'installer': prepared.app_files['diagnostic-hub'],
        'addon': prepared.app_files['resources/diagnostic_hub_rename_noreplace.node'],
    }

    def loaders(roles):
        backend.preflight()
        for role in roles:
            bound()
            verify(role,backend.loader(role),targets[role],references.loader,references.providers[role])

    loaders(('installer','addon'))
    first = pump(backend.start('install'), 'install', None, deadline,now=now)
    bound()
    installed = read_installed(root,uid,original.commit,envelope,prepared.descriptor_sha,first,menu)
    custody_matches(original,media,binding_sha,attempt,nonce,transaction)
    locked_file(root/ORIGINAL_TAR, original.size, original.sha256)
    loaders(('installer','addon','node'))
    bound()
    need(read_installed(root,uid,original.commit,envelope,prepared.descriptor_sha,first,menu) == installed,
         'folder-uninstall-preimage-changed')
    second = pump(backend.start('uninstall-current'),'uninstall-current',installed.profile,deadline,now=now)
    need((second.pid,second.start_ticks) != (first.pid,first.start_ticks), 'folder-distinct-actor')
    bound()
    read_removed(root,uid,installed,second)
    custody_matches(original,media,binding_sha,attempt,nonce,transaction)
    locked_file(root/ORIGINAL_TAR, original.size, original.sha256)
    final_owner = directory(root,uid)
    need((final_owner.st_dev,final_owner.st_ino) == (owner.st_dev,owner.st_ino), 'folder-owner-changed')
    return ('original-custody','loader-closure','install-pty','installed-readback',
            'uninstall-pty','removal-and-preservation')
