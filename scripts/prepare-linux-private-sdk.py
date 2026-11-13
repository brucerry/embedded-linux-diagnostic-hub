"""Prepare one fixed official SDK; never execute its Node/npm or alter a cache.

Only main performs IO. Failed/uncertain resources and original exceptions remain
owned; the CLI does not retry, remove artifacts, close uncertain FDs or signal.
"""
import hashlib
import json
import os
import posixpath
import secrets
import stat
import sys
import tarfile
import time
import urllib.request

VERSION = '24.22.0'
NAME = 'node-v24.22.0-linux-x64'
URL = 'https://nodejs.org/dist/v24.22.0/' + NAME + '.tar.gz'
ARCHIVE_BYTES = 58256361
ARCHIVE_SHA256 = '28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c'
NODE_BYTES = 126816376
NODE_SHA256 = '67ca5783febb8bf85736c79fcdd92c8d6d465a0eb2a082672bcdfa76a506751c'
LINKS = {'bin/npm': '../lib/node_modules/npm/bin/npm-cli.js',
         'bin/npx': '../lib/node_modules/npm/bin/npx-cli.js',
         'bin/corepack': '../lib/node_modules/corepack/dist/corepack.js'}
CRITICAL = {
    'bin/node': (NODE_BYTES, NODE_SHA256),
    'lib/node_modules/npm/package.json': (6597, 'f6478d5600180a23f73e4217610c7709a71cedb4ae13f6c3e15ecb457f5d4fd6'),
    'lib/node_modules/npm/bin/npm-cli.js': (54, '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7'),
    'include/node/node_api.h': (10370, '2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a'),
    'include/node/node_api_types.h': (1930, 'a25356630d3058f0a0c8937d9f297e9471e037fda58c2696d8a505c2bd99cb00'),
    'include/node/js_native_api.h': (33170, '82d3708ce120f8000ec34d72e1aa70b0d7d8a43027986293681374a71b2cb840'),
    'include/node/js_native_api_types.h': (7871, '4f19cb90d240765cc0961d92a1ee20f65fdc50db7de1ab0a5cb6bc227224e1a0'),
}


def new_state():
    return dict(fds=set(), objects=[], uncertain=False, primary_set=False,
                primary=None, secondary=[], secondary_overflow=False,
                stage='not-started', prefix=None)


STATE = new_state()


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def remember(error):
    if not STATE['primary_set']:
        STATE['primary_set'], STATE['primary'] = True, error
    elif error is not STATE['primary'] and len(STATE['secondary']) < 8:
        STATE['secondary'].append(error)
    elif error is not STATE['primary']:
        STATE['secondary_overflow'] = True


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
            info.st_mode, info.st_nlink)


def directory_identity(info):
    # mkdir of a child legitimately increments its parent's link count.
    return identity(info)[:-1]


def plain(info, uid, directory=False):
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == uid and 0 < info.st_ino <= 9007199254740991
            and 0 <= info.st_dev <= 9007199254740991 and not info.st_mode & 0o7022
            and (directory or info.st_nlink == 1), 'SDK_OWNERSHIP')


def parents(path, uid):
    require(os.path.isabs(path) and os.path.normpath(path) == path
            and not any(ord(c) < 32 or ord(c) == 127 for c in path), 'SDK_PATH')
    cursor = '/'
    for part in ['', *path.split('/')[1:]]:
        cursor = os.path.join(cursor, part)
        info = os.lstat(cursor)
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and info.st_uid in (0, uid) and 0 < info.st_ino <= 9007199254740991
                and not info.st_mode & 0o7022 and os.path.realpath(cursor) == cursor,
                'SDK_PARENT')


def owned_open(path, flags, uid, mode=None):
    STATE['uncertain'] = True
    try:
        fd = os.open(path, flags, mode) if mode is not None else os.open(path, flags)
    except FileExistsError:
        if flags & os.O_CREAT and flags & os.O_EXCL:
            STATE['uncertain'] = False  # Atomic exclusive collision created no FD/file.
        raise
    STATE['fds'].add(fd)  # Adopt returned FD before fstat or any further check.
    plain(os.fstat(fd), uid)
    require(identity(os.fstat(fd)) == identity(os.lstat(path))
            and os.path.realpath(path) == path, 'SDK_FD_CHANGED')
    STATE['uncertain'] = False
    return fd


def close_fd(fd):
    try:
        os.close(fd)
    except BaseException as error:
        remember(error)
        raise
    STATE['fds'].remove(fd)


def own(value):
    STATE['objects'].append(value)
    return value


def close_object(value):
    try:
        value.close()
    except BaseException as error:
        remember(error)
        raise
    STATE['objects'] = [item for item in STATE['objects'] if item is not value]


def write_all(fd, data):
    at = 0
    while at < len(data):
        size = os.write(fd, data[at:])
        require(type(size) is int and 0 < size <= len(data) - at, 'SDK_WRITE')
        at += size


def new_directory(path, uid):
    parents(os.path.dirname(path), uid)
    STATE['uncertain'] = True
    os.mkdir(path, 0o700)  # Exclusive creation; no exist_ok/chmod/ownership restoration.
    info = os.lstat(path)
    plain(info, uid, True)
    require(stat.S_IMODE(info.st_mode) == 0o700 and os.path.realpath(path) == path,
            'SDK_DIRECTORY_CHANGED')
    STATE['uncertain'] = False
    return directory_identity(info)


def create_file(path, mode, uid):
    parents(os.path.dirname(path), uid)
    fd = owned_open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    uid, mode)
    require(stat.S_IMODE(os.fstat(fd).st_mode) == mode, 'SDK_FILE_MODE')
    return fd


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise RuntimeError('SDK_REDIRECT_REFUSED')


def download(path, uid):
    fd = create_file(path, 0o600, uid)
    opener = urllib.request.build_opener(NoRedirect())  # Normal proxy and TLS trust.
    STATE['uncertain'] = True
    response = own(opener.open(URL, timeout=60))  # One fixed request; never retry.
    STATE['uncertain'] = False
    require(response.getcode() == 200 and response.geturl() == URL, 'SDK_HTTP')
    digest, total, until = hashlib.sha256(), 0, time.monotonic() + 180
    while True:
        require(time.monotonic() < until, 'SDK_DOWNLOAD_DEADLINE')
        part = response.read(min(65536, ARCHIVE_BYTES - total + 1))
        if not part:
            break
        total += len(part)
        require(total <= ARCHIVE_BYTES, 'SDK_ARCHIVE_BOUND')
        write_all(fd, part)
        digest.update(part)
    require(total == ARCHIVE_BYTES and digest.hexdigest() == ARCHIVE_SHA256,
            'SDK_ARCHIVE_SHA256')
    os.fsync(fd)
    close_fd(fd)
    close_object(response)


def plan_archive(archive):
    """Metadata only, after the caller verified the complete fixed archive SHA."""
    entries, sizes = {}, 0
    for member in archive:
        require(len(entries) < 5888 and isinstance(member.name, str), 'SDK_MEMBER_BOUND')
        name = member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name
        require(name == NAME or name.startswith(NAME + '/'), 'SDK_ARCHIVE_ROOT')
        relative = name[len(NAME):].removeprefix('/')
        require(not any(ord(c) < 32 or ord(c) == 127 for c in name)
                and '\\' not in name and not name.endswith('/') and len(name) <= 4096
                and (not relative or all(p not in ('', '.', '..') for p in relative.split('/')))
                and relative not in entries, 'SDK_MEMBER_PATH')
        kind = ('directory' if member.type == tarfile.DIRTYPE else 'file'
                if member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) else 'symlink'
                if member.type == tarfile.SYMTYPE else 'other')
        require(kind != 'other' and type(member.mode) is int and 0 <= member.mode <= 0o7777,
                'SDK_MEMBER_TYPE')
        if kind == 'symlink':
            require(relative in LINKS and member.linkname == LINKS[relative]
                    and member.mode == 0o777, 'SDK_LINK')
        else:
            require(not member.mode & 0o7022 and member.mode & 0o400, 'SDK_MEMBER_MODE')
        require(type(member.size) is int and 0 <= member.size <= 134217728
                and (kind == 'file' or member.size == 0), 'SDK_MEMBER_SIZE')
        sizes += member.size
        entries[relative] = dict(member=member, kind=kind, sourceMode=member.mode,
                                 bytes=member.size)
    counts = {kind: sum(e['kind'] == kind for e in entries.values())
              for kind in ('file', 'directory', 'symlink')}
    require(counts == dict(file=4797, directory=1088, symlink=3)
            and sizes == 201678212 and entries.get('', {}).get('kind') == 'directory',
            'SDK_COMPLETE_ARCHIVE')
    for relative, entry in entries.items():
        cursor = posixpath.dirname(relative)
        while relative and cursor:
            require(entries.get(cursor, {}).get('kind') == 'directory', 'SDK_MEMBER_PARENT')
            cursor = posixpath.dirname(cursor)
        if entry['kind'] == 'symlink':
            target = posixpath.normpath(posixpath.join(posixpath.dirname(relative), LINKS[relative]))
            require(entries.get(target, {}).get('kind') == 'file', 'SDK_LINK_TARGET')
    require(all(entries.get(name, {}).get('kind') == 'file' for name in CRITICAL),
            'SDK_CRITICAL_MISSING')
    return entries


def copy_member(archive, entry, path, uid):
    stream = own(archive.extractfile(entry['member']))
    require(stream is not None, 'SDK_MEMBER_STREAM')
    fd = create_file(path, entry['sourceMode'] & 0o700, uid)
    digest, total = hashlib.sha256(), 0
    while True:
        part = stream.read(min(65536, entry['bytes'] - total + 1))
        if not part:
            break
        total += len(part)
        require(total <= entry['bytes'], 'SDK_MEMBER_BOUND')
        write_all(fd, part)
        digest.update(part)
    require(total == entry['bytes'], 'SDK_MEMBER_TRUNCATED')
    os.fsync(fd)
    info = os.fstat(fd)
    plain(info, uid)
    require(info.st_size == total and identity(info) == identity(os.lstat(path)),
            'SDK_MEMBER_CHANGED')
    close_fd(fd)
    close_object(stream)
    return dict(bytes=total, sha256=digest.hexdigest(), identity=identity(info),
                mtime_ns=info.st_mtime_ns, ctime_ns=info.st_ctime_ns)


def verify_file(path, expected, uid):
    parents(os.path.dirname(path), uid)
    before = os.lstat(path)
    plain(before, uid)
    require(identity(before) == tuple(expected['identity'])
            and before.st_mtime_ns == expected['mtime_ns']
            and before.st_ctime_ns == expected['ctime_ns'], 'SDK_FILE_CHANGED')
    fd = owned_open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, uid)
    digest, total = hashlib.sha256(), 0
    while True:
        part = os.read(fd, min(65536, expected['bytes'] - total + 1))
        if not part:
            break
        total += len(part)
        require(total <= expected['bytes'], 'SDK_FILE_BOUND')
        digest.update(part)
    require(total == before.st_size == expected['bytes']
            and digest.hexdigest() == expected['sha256']
            and identity(before) == identity(os.fstat(fd)) == identity(os.lstat(path)),
            'SDK_FILE_READBACK')
    require(before.st_mtime_ns == os.fstat(fd).st_mtime_ns
            and before.st_ctime_ns == os.fstat(fd).st_ctime_ns, 'SDK_FILE_CHANGED')
    close_fd(fd)


def verify_archive_fd(fd, path):
    before = os.fstat(fd)
    os.lseek(fd, 0, os.SEEK_SET)
    digest, total = hashlib.sha256(), 0
    while True:
        part = os.read(fd, min(65536, ARCHIVE_BYTES - total + 1))
        if not part:
            break
        total += len(part)
        require(total <= ARCHIVE_BYTES, 'SDK_ARCHIVE_BOUND')
        digest.update(part)
    after = os.fstat(fd)
    require(total == before.st_size == after.st_size == ARCHIVE_BYTES
            and digest.hexdigest() == ARCHIVE_SHA256
            and identity(before) == identity(after) == identity(os.lstat(path))
            and before.st_mtime_ns == after.st_mtime_ns
            and before.st_ctime_ns == after.st_ctime_ns, 'SDK_ARCHIVE_CHANGED')
    os.lseek(fd, 0, os.SEEK_SET)


def append_output(path, data, uid):
    require(os.path.isabs(path) and os.path.realpath(path) == path, 'SDK_OUTPUT_PATH')
    parents(os.path.dirname(path), uid)
    before = os.lstat(path)
    plain(before, uid)
    require(before.st_size <= 1048576 and len(data) <= 8192, 'SDK_OUTPUT_BOUND')
    fd = owned_open(path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, uid)
    require(identity(before) == identity(os.fstat(fd)), 'SDK_OUTPUT_CHANGED')
    write_all(fd, data)
    os.fsync(fd)
    require(identity(before) == identity(os.fstat(fd)) == identity(os.lstat(path))
            and os.fstat(fd).st_size == before.st_size + len(data), 'SDK_OUTPUT_CHANGED')
    close_fd(fd)


def main(args):
    require(not args and sys.platform == 'linux', 'SDK_ARGUMENTS')
    uid = os.getuid()
    require(uid > 0 and uid == os.geteuid(), 'SDK_UID')
    home = os.environ.get('HOME', '')
    parents(home, uid)
    require(os.lstat(home).st_uid == uid and len(home) <= 240, 'SDK_HOME')
    STATE['stage'] = 'allocation'
    prefix = os.path.join(home, '.diagnostic-hub-sdk-' + secrets.token_hex(12))
    STATE['prefix'] = prefix  # Responsible owner before mkdir/download/extraction.
    new_directory(prefix, uid)
    archive_path = prefix + '/' + NAME + '.tar.gz'
    STATE['stage'] = 'download'
    download(archive_path, uid)
    fd = owned_open(archive_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, uid)
    verify_archive_fd(fd, archive_path)  # Held-FD bytes, not just the earlier download pathname.
    original = own(os.fdopen(fd, 'rb', closefd=False))
    archive = own(tarfile.open(fileobj=original, mode='r:gz'))
    STATE['stage'] = 'archive-plan'
    entries = plan_archive(archive)
    sdk = prefix + '/' + NAME
    STATE['stage'] = 'materialization'
    inventory = []
    for relative, entry in sorted(entries.items(), key=lambda item: (item[0].count('/'), item[0])):
        if entry['kind'] == 'directory':
            entry['identity'] = new_directory(sdk + ('/' + relative if relative else ''), uid)
    for relative, entry in entries.items():
        if entry['kind'] != 'file':
            continue
        copied = copy_member(archive, entry, sdk + '/' + relative, uid)
        if relative in CRITICAL:
            require((copied['bytes'], copied['sha256']) == CRITICAL[relative], 'SDK_CRITICAL_SHA256')
        entry['copied'] = copied
    close_object(archive)
    close_object(original)
    verify_archive_fd(fd, archive_path)
    close_fd(fd)
    for relative, target in LINKS.items():
        parents(os.path.dirname(sdk + '/' + relative), uid)
        STATE['uncertain'] = True
        os.symlink(target, sdk + '/' + relative)
        require(os.readlink(sdk + '/' + relative) == target, 'SDK_LINK_CHANGED')
        STATE['uncertain'] = False
    STATE['stage'] = 'readback'
    for relative, entry in entries.items():
        file = sdk + ('/' + relative if relative else '')
        info = os.lstat(file)
        if entry['kind'] == 'file':
            verify_file(file, entry['copied'], uid)
        elif entry['kind'] == 'directory':
            plain(info, uid, True)
            require(stat.S_IMODE(info.st_mode) == 0o700 and os.path.realpath(file) == file,
                    'SDK_DIRECTORY_CHANGED')
            require(directory_identity(info) == entry['identity'], 'SDK_DIRECTORY_CHANGED')
        else:
            target = posixpath.normpath(posixpath.join(posixpath.dirname(file), LINKS[relative]))
            require(stat.S_ISLNK(info.st_mode) and info.st_uid == uid and info.st_nlink == 1
                    and 0 < info.st_ino <= 9007199254740991
                    and 0 <= info.st_dev <= 9007199254740991
                    and stat.S_IMODE(info.st_mode) == 0o777
                    and os.readlink(file) == LINKS[relative] and os.path.realpath(file) == target,
                    'SDK_LINK_CHANGED')
        inventory.append(dict(path=relative, kind=entry['kind'], sourceMode=entry['sourceMode'],
                              privateMode=stat.S_IMODE(info.st_mode), uid=info.st_uid,
                              gid=info.st_gid, dev=info.st_dev, ino=info.st_ino, links=info.st_nlink,
                              **({k: entry['copied'][k] for k in ('bytes', 'sha256')}
                                 if entry['kind'] == 'file' else {})))
    # npm version is also pinned by its whole package.json hash above; never run it here.
    facts = dict(schemaVersion=1, nodeVersion=VERSION, npmVersion='11.19.1', sdk=sdk,
                 archiveSHA256=ARCHIVE_SHA256, archiveBytes=ARCHIVE_BYTES,
                 signatureAuthenticationPerformed=False, selectedExecutablesInvoked=False,
                 inventory=inventory)
    record = create_file(prefix + '/verified-sdk.json', 0o600, uid)
    write_all(record, (json.dumps(facts, sort_keys=True) + '\n').encode())
    os.fsync(record)
    close_fd(record)
    STATE['stage'] = 'outputs'
    values = dict(HUB_PRIVATE_SDK_ROOT=sdk, HUB_PRIVATE_NODE=sdk + '/bin/node',
                  HUB_PRIVATE_NPM=sdk + '/lib/node_modules/npm/bin/npm-cli.js')
    append_output(os.environ.get('GITHUB_ENV', ''), ''.join(k + '=' + v + '\n' for k, v in values.items()).encode(), uid)
    append_output(os.environ.get('GITHUB_PATH', ''), (sdk + '/bin\n').encode(), uid)
    STATE['stage'] = 'complete'
    return values


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
        sys.stdout.write('PRIVATE_SDK_READY\n')
        sys.stdout.flush()
    except BaseException as error:
        remember(error)
        try:
            sys.stderr.write('PRIVATE_SDK_NONPASS\n')
            sys.stderr.flush()
        except BaseException as secondary:
            remember(secondary)
        while STATE['fds'] or STATE['objects'] or STATE['uncertain']:
            try:
                time.sleep(60)
            except BaseException as secondary:
                remember(secondary)
        raise SystemExit(1)
