"""Data-only inventory and custody binding for the private AppImage venue."""
from dataclasses import asdict
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import selectors
import signal
import stat
import subprocess
from time import monotonic

import archive_inventory as archive
import handoff
import pair_wire as wire
import read_envelope

CASE = 'appimage-runtime-identity'
ROLES = ('AppRun', 'diagnostic-hub', 'resources/app.asar')
MIB = 2**20
PHYSICAL_CAP = 2**31
GUEST_FLOOR = 2**32
METADATA_LIMIT = 64*1024


def owned_child(argv, env, source, deadline, limit, *, exact_size=False):
    """Drain bounded output without persisting a selected executable or ASAR."""
    end = min(deadline, monotonic()+15)
    total = 0
    reading = bytearray()
    digest = sha256()
    child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, pass_fds=(source,), start_new_session=True)
    try:
        with selectors.DefaultSelector() as wait:
            wait.register(child.stdout, selectors.EVENT_READ, True)
            wait.register(child.stderr, selectors.EVENT_READ, False)
            while wait.get_map():
                remaining = end-monotonic()
                wire.need(remaining>0, 'squashfs-reader-deadline')
                events = wait.select(remaining)
                wire.need(events, 'squashfs-reader-deadline')
                for key, _ in events:
                    data = os.read(key.fd, 64*1024)
                    if not data:
                        wait.unregister(key.fileobj)
                    else:
                        total+=len(data)
                        wire.need(key.data and total<=limit, 'squashfs-reader-output')
                        if exact_size:
                            digest.update(data)
                        else:
                            reading.extend(data)
        wire.need(child.wait(timeout=max(0,end-monotonic()))==0 and closed(child.pid),
                  'squashfs-reader-closure')
        if exact_size:
            wire.need(total==limit, 'squashfs-reader-selected-length')
            return digest.hexdigest()
        return bytes(reading)
    finally:
        if child.poll() is None or not closed(child.pid):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=3)
            wire.need(closed(child.pid), 'squashfs-reader-group-retained')
        child.stdout.close()
        child.stderr.close()


def closed(group):
    try:
        os.killpg(group,0)
    except ProcessLookupError:
        return True
    return False


def scan(image, reader, env, expected_row, deadline, guard, *, permanent=True, notices=None, apprun_sha=None):
    """The caller admits the already recognized reader and its exact live loader first."""
    guard()
    wire.need(len(expected_row)==3 and expected_row[0]==wire.APP and
              type(expected_row[1]) is int and 0<expected_row[1]<=handoff.ARCHIVE_CAP and
              image.lstat().st_size==expected_row[1], 'appimage-archive-read-cap')
    envl = read_envelope.stable_read(image)
    wire.need(expected_row == [wire.APP, envl['bytes'], envl['artifactSHA256']], 'appimage-envelope-row')
    initial = wire.stamp(image.lstat())
    source = os.open(image, os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        wire.need(wire.stamp(os.fstat(source))==initial, 'appimage-inventory-open-drift')
        fixed = [reader,'-offset',str(envl['squashfsOffset']),'-strict-errors','-no-progress']
        reference = f'/proc/self/fd/{source}'
        listing = owned_child([*fixed,'-lln',reference],env,source,deadline,archive.MAX_LIST_BYTES)
        rows = archive.squash_inventory(listing,envl['squashfsInodes'],permanent=permanent)
        root = PurePosixPath(archive.IMAGE_ROOT)
        members = [[leaf.relative_to(root).as_posix(),r.kind,r.mode,r.size,r.target]
                   for leaf,r in sorted(rows.items())]
        pins = {}
        for leaf in ROLES:
            wire.tick(deadline)
            role = rows[root/leaf]
            wire.need(role.kind=='file' and role.size>0 and (leaf==ROLES[2] or role.mode&0o100),
                      'appimage-inventory-selected-shape')
            guard()
            digest = owned_child([*fixed,'-no-wildcards','-cat',reference,leaf],
                                 env,source,deadline,role.size,exact_size=True)
            pins[leaf] = [role.size,role.mode,digest]
        if apprun_sha is not None:
            wire.need(pins["AppRun"][1:] == [0o755, apprun_sha], "appimage-original-apprun")
        if notices is not None:
            notice_dir = root / "usr/lib/appimage-runtime-notices"
            wire.need(set(notices) == {leaf.name for leaf in rows if leaf.parent == notice_dir},
                      "appimage-original-notice-roster")
            for name, pin in notices.items():
                leaf = notice_dir / name
                row = rows[leaf]
                wire.need(row.kind == "file" and row.mode == 0o644 and row.size == pin["bytes"],
                          "appimage-original-notice-mode")
                guard()
                body_digest = owned_child([*fixed,'-no-wildcards','-cat',reference,
                                           leaf.relative_to(root).as_posix()],env,source,deadline,
                                          row.size,exact_size=True)
                wire.need(body_digest == pin["sha256"], "appimage-original-notice-digest")
        wire.need(initial==wire.stamp(os.fstat(source))==wire.stamp(image.lstat()),
                  'appimage-inventory-original-drift')
        guard()
        wire.need(read_envelope.stable_read(image)==envl, 'appimage-inventory-envelope-drift')
    finally:
        os.close(source)
    return {'runtimeSHA256':read_envelope.RUNTIME_SHA,'offset':envl['squashfsOffset'],
            'artifact':expected_row,'inventory':members,'roles':pins}


def original_record(authority, rows, raw):
    wire.need(type(raw) is bytes and 0<len(raw)<=65536 and
              rows[4]==[wire.RECORD,len(raw),sha256(raw).hexdigest()],
              'appimage-originating-record-bytes')
    actual=json.loads(raw,object_pairs_hook=wire.closed_object)
    wire.need(actual=={'version':'0.6.0','platform':'linux','arch':'x64',
                       'commit':authority.source_commit,'validation':handoff.UNPERFORMED,
                       'assets':{name:pin for name,_,pin in (rows[0],rows[2])}},
              'appimage-originating-record-fields')


def bind(authority, header, record_bytes, independently_read):
    """Bind the reader output to the primary artifact rows already received for this attempt."""
    handoff.validate_attempt(authority)
    wire.need(header['attempt']==asdict(authority) and authority.job=='two-format',
              'appimage-originating-attempt')
    rows = wire.valid_header(header, header)
    original_record(authority,rows,record_bytes)
    image, sidecar, record = rows[2:]
    body = f'{image[2]}  {wire.APP}\n'.encode('ascii')
    wire.need(sidecar==[wire.APP+'.sha256',len(body),sha256(body).hexdigest()],
              'appimage-originating-sidecar')
    data = {'schema':1,'case':CASE,'attempt':asdict(authority),
            'pairSHA256':sha256(wire.canonical(header)).hexdigest(),'producerRecord':record,
            **independently_read}
    wire.need(set(independently_read)=={'runtimeSHA256','offset','artifact','inventory','roles'} and
              data['artifact']==image, 'appimage-inventory-artifact')
    verify(authority,header,data,sha256(wire.canonical(data)).hexdigest())
    return data


def verify(authority, header, data, trusted_pin):
    """Fail closed on a foreign proposal, even when its archive-size census is plausible."""
    handoff.validate_attempt(authority)
    wire.need(set(data)=={'schema','case','attempt','pairSHA256','producerRecord','runtimeSHA256',
                        'offset','artifact','inventory','roles'} and data['schema']==1 and
              data['case']==CASE and header['attempt']==data['attempt']==asdict(authority)
              and authority.job=='two-format', 'appimage-receipt-scope')
    rows = wire.valid_header(header,header)
    wire.need(len(wire.canonical(data))<=METADATA_LIMIT and
              sha256(wire.canonical(data)).hexdigest()==trusted_pin and
              sha256(wire.canonical(header)).hexdigest()==data['pairSHA256'] and
              data['artifact']==rows[2] and data['producerRecord']==rows[4] and
              data['runtimeSHA256']==read_envelope.RUNTIME_SHA and data['offset']==read_envelope.RUNTIME_BYTES,
              'appimage-receipt-custody')
    entries = validate_inventory(data['inventory'])
    wire.need(set(data['roles'])==set(ROLES),'appimage-receipt-role-roster')
    for role in ROLES:
        _,kind,mode,count,_=entries[role]
        wire.need(kind=='file' and count>0 and (role==ROLES[2] or mode&0o100) and
                  data['roles'][role][:2]==[count,mode] and len(data['roles'][role])==3 and
                  handoff.hex_string(data['roles'][role][2],64),'appimage-receipt-role-shape')
    return entries


def for_verified_export(directory, authority, expected, emitted, reader, env, deadline, guard):
    # The authenticated worker prelude supplies the expected header. Verify the
    # received five files before composing the root-owned guest seed.
    handoff.validate_attempt(authority)
    rows = wire.valid_header(emitted, expected)
    wire.need(emitted['attempt']==asdict(authority),
              'appimage-fresh-export-attempt')
    owner = directory.lstat()
    wire.need(directory==directory.resolve(strict=True) and stat.S_ISDIR(owner.st_mode) and
              stat.S_IMODE(owner.st_mode)==0o700 and owner.st_uid==os.getuid()>0,
              'appimage-export-owner')
    wire.need(set(os.listdir(directory))==set(wire.NAMES), 'appimage-export-roster')
    snapshots = {}
    small = {}
    for name,size,wanted in rows:
        path = directory/name
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC),'rb') as data:
            item = os.fstat(data.fileno())
            wire.need(stat.S_ISREG(item.st_mode) and item.st_dev==owner.st_dev and item.st_uid==owner.st_uid
                      and item.st_nlink==1 and not item.st_mode&0o7022 and item.st_size==size,
                      'appimage-export-file')
            digest = sha256()
            active = 0
            collected = bytearray()
            while True:
                wire.tick(deadline)
                part = data.read(65536)
                if not part:
                    break
                active += len(part)
                wire.need(active<=size,'appimage-export-length')
                digest.update(part)
                if name not in (wire.TAR,wire.APP):
                    collected.extend(part)
            wire.need(active==size and digest.hexdigest()==wanted and
                      wire.stamp(item)==wire.stamp(os.fstat(data.fileno()))==wire.stamp(path.lstat()),
                      'appimage-export-bytes')
            snapshots[name] = wire.stamp(item)
            if name not in (wire.TAR,wire.APP):
                small[name] = bytes(collected)
    for name,_,digest in (rows[0],rows[2]):
        wire.need(small[name+'.sha256']==f'{digest}  {name}\n'.encode('ascii'),
                  'appimage-export-sidecar')
    independent = scan(directory/wire.APP,reader,env,rows[2],deadline,guard)
    wire.need(wire.directory_stamp(directory.lstat())==wire.directory_stamp(owner) and
              snapshots=={name:wire.stamp((directory/name).lstat()) for name in os.listdir(directory)},
              'appimage-export-replaced')
    return bind(authority,emitted,small[wire.RECORD],independent)


def grant_identity(nonce, reference, trusted_receipt_sha256, observer_lock_sha256):
    # Both endpoints compute this from root-owned seed metadata and the same
    # exported custody inputs, prior to asking QEMU for a one-time launch grant.
    import runtime_gate
    wire.need(all(handoff.hex_string(v,64) for v in
                  (trusted_receipt_sha256,observer_lock_sha256)), 'appimage-grant-input-pins')
    wire.need(sha256(wire.canonical(reference)).hexdigest()==trusted_receipt_sha256 and
              reference.get('case')==CASE, 'appimage-grant-bound-inventory')
    combined = sha256((trusted_receipt_sha256+'\n'+observer_lock_sha256+'\n').encode('ascii')).hexdigest()
    return runtime_gate.binding(nonce,reference['pairSHA256'],combined,CASE)


def validate_inventory(rows):
    wire.need(type(rows) is list and 0<len(rows)<=archive.MAX_ENTRIES, 'appimage-census-size')
    index={}
    tree={}
    root=archive.path_name(archive.IMAGE_ROOT)
    for r in rows:
        wire.need(type(r) is list and len(r)==5,'appimage-census-row')
        leaf,kind,mode,size,target=r
        wire.need(type(leaf) is str and kind in ('file','directory','symlink') and
                  type(mode) is int and 0<=mode<=0o777 and type(size) is int and
                  type(target) is str and (kind=='symlink' or not target),'appimage-census-row')
        name=root if leaf=='.' else root/archive.path_name(leaf)
        archive.add(tree,name,archive.Entry(kind,mode,size,target))
        index[leaf]=r
    # Session plan retains the same four installed member modes as the producer gate.
    archive.validate_tree(tree,archive.IMAGE_ROOT,permanent=True)
    return index


def budget(image_bytes, rows, observer, *, provisioned):
    """Model one original copy and one runtime extraction. Credit no discarded bytes."""
    wire.need(type(image_bytes) is int and 0<image_bytes<=handoff.ARCHIVE_CAP and
              type(provisioned) is int and 0<provisioned<PHYSICAL_CAP,'appimage-capacity-input')
    for key in ('observerGuest4KiB','observerOverlay64KiB'):
        wire.need(type(observer[key]) is int and 0<observer[key]<=256*MIB,'appimage-observer-budget')
    wire.need(sum(r[3] for r in rows.values() if r[1]=='file')<=archive.MAX_ARCHIVE_FILE_BYTES,
              'appimage-expanded-limit')
    def charge(unit):
        return (archive.round_to(image_bytes,unit)+unit+
                sum(archive.round_to(r[3],unit)+unit for r in rows.values()))
    reserve=192*MIB
    after=charge(65536)+observer['observerOverlay64KiB']+reserve
    guest_next=charge(4096)+observer['observerGuest4KiB']
    wire.need(provisioned+after<=PHYSICAL_CAP,'appimage-capacity-2GiB')
    return {'physicalCap':PHYSICAL_CAP,'guestFloor':GUEST_FLOOR,'beforeStagingFree':GUEST_FLOOR+guest_next,
            'afterProvisioningOverlayCharge':after, 'guestCopy':guest_next,
            'maximumOverlayAtGrant':PHYSICAL_CAP-after,'modeledPeak':provisioned+after,
            'margin':PHYSICAL_CAP-provisioned-after,'minGuestInodes':max(12000,len(rows)+16)}
