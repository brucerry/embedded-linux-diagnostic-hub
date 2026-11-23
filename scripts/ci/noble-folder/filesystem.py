"""Owned readback for the exact no-menu install and current-payload removal."""
from base64 import b64decode, b64encode
from dataclasses import dataclass, field
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

import consent
from loader_gate import FilePin, need


PRODUCT = 'dev.diagnostichub.desktop'
RECORD = '.diagnostic-hub-installation.json'
MANIFEST = '.diagnostic-hub-release.json'
DESCRIPTOR = 'diagnostic-hub-setup-payload.json'
OWNERSHIP = '.diagnostic-hub-ownership.json'
METADATA = (RECORD, MANIFEST, OWNERSHIP)
WORK = '.DiagnosticHub-maintenance-' + sha256(consent.TARGET.encode('ascii')).hexdigest()[:20]
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
MAX_NODES = 40064
MAX_PAYLOAD = 2*2**30
MAX_METADATA = 4*2**20
UUID4 = r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'


def digest(raw):
    return sha256(raw).hexdigest()


def closed(pairs):
    value = dict(pairs)
    need(len(value) == len(pairs), 'filesystem-duplicate-key')
    return value


def decode(raw):
    return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=closed)


def stamp(row):
    return (row.st_dev, row.st_ino, row.st_uid, row.st_mode, row.st_nlink,
            row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def directory(path, uid):
    need(path.is_absolute() and path.resolve(strict=True) == path, 'filesystem-canonical-path')
    for part in (path, *path.parents):
        row = part.lstat()
        need(stat.S_ISDIR(row.st_mode) and row.st_uid in (0, uid)
             and not row.st_mode & 0o7022, 'filesystem-protected-ancestry')
    owner = path.lstat()
    need(owner.st_uid == uid, 'filesystem-owned-directory')
    return owner


def read_at(parent_fd, name, uid, cap, *, return_bytes=False):
    with os.fdopen(os.open(name, FLAGS, dir_fd=parent_fd), 'rb') as body:
        first = os.fstat(body.fileno())
        need(stat.S_ISREG(first.st_mode) and first.st_uid == uid and first.st_nlink == 1
             and not first.st_mode & 0o7022 and 0 < first.st_size <= cap, 'filesystem-owned-file')
        count, chunks, hasher = 0, [], sha256()
        while part := body.read(65536):
            count += len(part)
            need(count <= first.st_size, 'filesystem-file-grew')
            hasher.update(part)
            if return_bytes:
                chunks.append(part)
        actual = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        need(count == first.st_size and stamp(first) == stamp(actual) == stamp(os.fstat(body.fileno())),
             'filesystem-file-changed')
    pin = FilePin(count, hasher.hexdigest(), stat.S_IMODE(first.st_mode))
    return (pin, b''.join(chunks)) if return_bytes else pin


def read(path, uid, cap):
    parent = directory(path.parent, uid)
    fd = os.open(path.parent, FLAGS | os.O_DIRECTORY)
    try:
        need(stamp(parent) == stamp(os.fstat(fd)), 'filesystem-open-parent')
        result = read_at(fd, path.name, uid, cap, return_bytes=True)[1]
        need(stamp(parent) == stamp(directory(path.parent, uid)) == stamp(os.fstat(fd)),
             'filesystem-read-parent')
        return result
    finally:
        os.close(fd)


@dataclass(frozen=True)
class Tree:
    directories: dict[str, int]
    files: dict[str, FilePin]
    identities: dict[str, tuple[int,int]] = field(compare=False)


def tree(path, uid, *, optional=False):
    if optional and not os.path.lexists(path):
        return None
    root = directory(path, uid)
    dirs, files, identities = {}, {}, {}
    total = 0

    def walk(fd, prefix, level):
        nonlocal total
        need(level <= 32, 'filesystem-tree-depth')
        first = os.fstat(fd)
        need(first.st_uid == uid and first.st_dev == root.st_dev
             and not first.st_mode & 0o7022, 'filesystem-tree-owned-directory')
        dirs[prefix] = stat.S_IMODE(first.st_mode)
        identities[prefix] = first.st_dev,first.st_ino
        for leaf in os.listdir(fd):
            need(len(dirs) + len(files) < MAX_NODES
                 and len(leaf) <= 255 and re.fullmatch(r'[^\x00-\x1f\x7f\\/]+', leaf),
                 'filesystem-tree-bound')
            rel = prefix + '/' + leaf if prefix else leaf
            before = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                child = os.open(leaf, FLAGS | os.O_DIRECTORY, dir_fd=fd)
                try:
                    need(stamp(before) == stamp(os.fstat(child)), 'filesystem-tree-child-changed')
                    walk(child, rel, level+1)
                finally:
                    os.close(child)
            else:
                files[rel] = read_at(fd, leaf, uid, MAX_PAYLOAD-total)
                identities[rel] = before.st_dev,before.st_ino
                total += files[rel].size
            need(stamp(before) == stamp(os.stat(leaf, dir_fd=fd, follow_symlinks=False)),
                 'filesystem-tree-member-changed')
        need(stamp(first) == stamp(os.fstat(fd)), 'filesystem-tree-changed')

    fd = os.open(path,FLAGS | os.O_DIRECTORY)
    try:
        need(stamp(root) == stamp(os.fstat(fd)), 'filesystem-tree-root')
        walk(fd, '', 0)
        need(stamp(root) == stamp(directory(path, uid)) == stamp(os.fstat(fd)), 'filesystem-tree-root')
    finally:
        os.close(fd)
    return Tree(dirs, files, identities)


def manifest(raw, commit, app_files):
    doc = decode(raw)
    need(type(doc) is dict and set(doc) == {
        'schemaVersion','product','layout','platform','arch','version','sourceCommit','entryPoint','files'
    } and {key: doc[key] for key in doc if key != 'files'} == {
        'schemaVersion':1,'product':PRODUCT,'layout':'linux-folder','platform':'linux',
        'arch':'x64','version':consent.VERSION,'sourceCommit':commit,'entryPoint':'app/diagnostic-hub',
    }, 'installed-manifest-identity')
    rows = doc['files']
    need(type(rows) is list and 0 < len(rows) <= 20000, 'installed-manifest-roster')
    paths = {}
    for item in rows:
        need(type(item) is dict and set(item) == {'kind','path','bytes','sha256'}
             and item['kind'] == 'file' and type(item['path']) is str
             and item['path'].startswith('app/') and item['path'] not in paths,
             'installed-manifest-member')
        key = item['path']
        target = PurePosixPath(key)
        need(key == str(target) and not any(part in ('.','..') for part in target.parts),
             'installed-manifest-path')
        paths[key] = item['bytes'], item['sha256']
    need(paths == {f'app/{key}':(pin.size,pin.sha256) for key,pin in app_files.items()},
         'installed-manifest-readback')
    return doc


@dataclass(frozen=True)
class Installed:
    profile: str
    journal: bytes
    originals: dict[str, bytes]
    profile_tree: Tree | None
    envelope: Tree
    menu: Tree
    roster: dict[str,dict]


def actor_owner(pty):
    return {'pid':pty.pid,'startTicks':str(pty.start_ticks),'executable':consent.APP+'/diagnostic-hub'}


def read_installed(root, uid, commit, expected_envelope, descriptor_sha, pty, menu_before):
    profile = pty.profile
    envelope = tree(root/'envelope',uid)
    need(envelope == expected_envelope, 'installed-source-changed')
    app = {key[4:]:pin for key,pin in envelope.files.items() if key.startswith('app/')}
    raw_descriptor = read(root/'envelope'/DESCRIPTOR,uid,MAX_METADATA)
    need(digest(raw_descriptor) == descriptor_sha, 'installed-descriptor-identity')
    descriptor = manifest(raw_descriptor,commit,app)
    owned = tree(root/'installed',uid)
    need(set(owned.files) == {*(f'app/{key}' for key in app), *METADATA} and
         all(owned.files[f'app/{key}'] == pin for key,pin in app.items()) and
         set(owned.directories) == {key for key in envelope.directories if key == '' or key == 'app'
                                    or key.startswith('app/')}, 'installed-tree-readback')
    originals = {leaf:read(root/'installed'/leaf,uid,MAX_METADATA) for leaf in METADATA}
    need(manifest(originals[MANIFEST],commit,app) == descriptor and
         all(digest(raw) == owned.files[leaf].sha256 for leaf, raw in originals.items()),
         'installed-manifest-changed')
    install_id = profile.removeprefix(consent.PROFILE)
    need(profile == consent.PROFILE + install_id and re.fullmatch(UUID4, install_id),
         'installed-profile-identity')
    record, owner = decode(originals[RECORD]), decode(originals[OWNERSHIP])
    need(record == {'schemaVersion':1,'product':PRODUCT,'installationId':install_id,
                    'manifestSHA256':digest(originals[MANIFEST]),'profile':'dedicated'},
         'installed-record-identity')
    transaction = owner.get('transactionId')
    need(type(transaction) is str and re.fullmatch(UUID4, transaction) and owner == {
        'schemaVersion':1,'product':PRODUCT,'root':consent.TARGET,'installationId':install_id,
        'transactionId':transaction,'options':{'startMenu':False,'desktop':False,'launch':False},'integrations':[],
    }, 'installed-no-menu-owner')
    journal = read(root/WORK/'journal.json',uid,8192)
    state = decode(journal)
    need(state == {
        'schemaVersion':1,'root':consent.TARGET,'uid':uid,'transactionId':transaction,
        'installationId':install_id,'profile':profile,'phase':'candidate-active','previousSHA256':None,
        'candidateSHA256':digest(originals[MANIFEST]),'owner':actor_owner(pty)
    } and
         not os.path.lexists(root/WORK/'completed-journal.json') and
         not os.path.lexists(root/(WORK+'-uninstall')), 'installed-uninstall-eligible')
    menu = tree(root/'data',uid)
    need(menu == menu_before, 'installed-menu-state')
    selected_profile = root/'config'/'DiagnosticHub'/'profiles'/install_id
    return Installed(profile,journal,originals,tree(selected_profile,uid,optional=True),envelope,menu,
                     deletion_roster(owned,uid))


def deletion_roster(owned,uid):
    roster = {}
    for path,(dev,ino) in owned.identities.items():
        source = {'path':path,'uid':uid,'dev':dev,'ino':ino}
        if path in owned.files:
            pin = owned.files[path]
            roster[path] = source|{'kind':'file','mode':stat.S_IFREG|pin.mode,'bytes':pin.size,'sha256':pin.sha256}
        else:
            roster[path] = source|{'kind':'directory','mode':stat.S_IFDIR|owned.directories[path]}
    return roster


def read_removed(root, uid, installed, pty):
    removal = root/(WORK+'-uninstall')
    need(not os.path.lexists(root/'installed') and not os.path.lexists(root/WORK)
         and not os.path.lexists(removal/'payload'), 'uninstall-owned-payload-remains')
    disposal = tree(removal/'disposal',uid)
    need(not disposal.files and set(disposal.directories)=={''}, 'uninstall-disposal-not-empty')
    snapshot = read(removal/'snapshot.json',uid,24*2**20+131072)
    progress = decode(read(removal/'state.json',uid,8192))
    saved = decode(snapshot)
    need(saved.get('schemaVersion') == 1 and saved.get('root') == consent.TARGET and
         saved.get('removalOwner') == actor_owner(pty) and 'confirmedCleanup' not in saved and
         type(saved.get('entries')) is list and 0 < len(saved['entries']) <= 20010 and
         saved.get('initial',{}).get('journal') == decode(installed.journal),
         'uninstall-snapshot-identity')
    observed = {row['path']:row for row in saved['entries'] if type(row) is dict and 'path' in row}
    need(len(observed)==len(saved['entries']) and observed==installed.roster,'uninstall-owned-roster')
    need(progress == {'schemaVersion':1,'phase':'complete','index':len(saved['entries']),
                      'leaf':'source','snapshotSHA256':digest(snapshot)},'uninstall-progress-missing')
    originals = {}
    for item in saved['originals']:
        need(set(item) == {'path','base64','sha256'} and item['path'] in METADATA and
             item['path'] not in originals, 'uninstall-original-roster')
        raw = b64decode(item['base64'],validate=True)
        need(b64encode(raw).decode('ascii') == item['base64'] and digest(raw) == item['sha256'],
             'uninstall-original-hash')
        originals[item['path']] = raw
    need(originals == installed.originals and
         read(removal/'original-maintenance'/'journal.json',uid,8192) == installed.journal,
         'uninstall-original-changed')
    install_id = installed.profile.removeprefix(consent.PROFILE)
    profile = root/'config'/'DiagnosticHub'/'profiles'/install_id
    for actual, expected in ((tree(profile,uid,optional=True),installed.profile_tree),
                             (tree(root/'envelope',uid),installed.envelope),(tree(root/'data',uid),installed.menu)):
        need(actual==expected and (actual is None or actual.identities==expected.identities),
             'uninstall-preservation-readback')
