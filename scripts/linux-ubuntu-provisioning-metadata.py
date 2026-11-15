"""Fixed read-only provisioning metadata; never installs or invokes package tools."""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import types

BRANCH = 'refs/heads/ci/v060-ubuntu-provisioning-metadata-20261115'
BASE_SHA = '1c9ce77e5c0b2fa2d3f02be2ce1ca6dd4ad06278a301e14e4a4ec6327d569e52'
INPUT_SHA = '1e1f9d40d7801fe818a01a45c9d31ede831e7d9a94e19f1468c776f081caa851'
STAGES = ('context', 'binding', 'packages', 'parents', 'files', 'configuration',
          'pending', 'registrations', 'handlers', 'complete')
FIELDS = ('result', 'stage', 'reason', 'packages', 'versions0', 'versions1', 'versions2',
          'versions3', 'versions4', 'versions5', 'versions6', 'parents', 'parentmap',
          'files', 'filemap', 'configuration', 'confighash', 'pending', 'registrations',
          'diversions', 'overrides', 'libcpostinst', 'libctriggers', 'manpostinst',
          'mantriggers', 'ldconfig', 'ldconfigreal', 'mandb', 'menu', 'custody')
HANDLERS = {
    'libcpostinst': '/var/lib/dpkg/info/libc-bin.postinst',
    'libctriggers': '/var/lib/dpkg/info/libc-bin.triggers',
    'manpostinst': '/var/lib/dpkg/info/man-db.postinst',
    'mantriggers': '/var/lib/dpkg/info/man-db.triggers',
    'ldconfig': '/usr/sbin/ldconfig',
    'ldconfigreal': '/usr/sbin/ldconfig.real',
    'mandb': '/usr/bin/mandb',
}


class Refused(Exception):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def encode(report):
    need(type(report) is dict and set(report) == set(FIELDS), 'output')
    need(report['result'] in ('incomplete', 'metadata-only-complete') and
         report['stage'] in STAGES and report['reason'] in
         ('not-checked', 'none', 'context', 'binding', 'metadata', 'unsafe', 'changed',
          'format', 'bound', 'custody', 'unexpected'), 'output')
    need(all(type(v) is str and re.fullmatch(r'[A-Za-z0-9 .+:~_=-]{1,480}', v)
             for v in report.values()), 'output')
    raw = ''.join(k + '=' + report[k] + '\n' for k in FIELDS).encode('ascii')
    need(len(raw) <= 6144, 'output')
    return raw


def metadata(io, file, missing=False):
    try:
        return io.lstat(file)
    except FileNotFoundError:
        if missing:
            return None
        raise


def safe_directory(io, path):
    info = metadata(io, path, True)
    if info is None:
        return 'a'
    if not (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
            info.st_ino > 0 and not info.st_mode & 0o7022 and io.realpath(path) == path):
        return 'u'
    return 's'


def checked_read(io, file, cap, missing=False, identity=False):
    for parent in reversed(pathlib.PurePosixPath(file).parents):
        state = safe_directory(io, str(parent))
        if state == 'a' and missing:
            return None
        need(state == 's', 'unsafe')
    before = metadata(io, file, missing)
    if before is None:
        return None
    need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0 and
         before.st_nlink == 1 and not before.st_mode & 0o7022 and
         io.realpath(file) == file and 0 <= before.st_size <= cap, 'unsafe')
    raw = io.read(file, cap)
    after = io.lstat(file)
    for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                'st_size', 'st_mtime_ns', 'st_ctime_ns'):
        need(getattr(before, key) == getattr(after, key), 'changed')
    return (raw, after) if identity else raw


def control_records(raw):
    need(len(raw) <= 16 * 1024 ** 2 and b'\x00' not in raw, 'bound')
    rows = []
    for paragraph in raw.decode('utf8').strip().split('\n\n'):
        if not paragraph:
            continue
        row, previous = {}, None
        for line in paragraph.splitlines():
            if line.startswith((' ', '\t')):
                need(previous is not None, 'format')
                row[previous] += '\n' + line
            else:
                key, sep, value = line.partition(':')
                need(sep and re.fullmatch('[A-Za-z][A-Za-z0-9-]*', key) and key not in row, 'format')
                row[key], previous = value.strip(), key
        need('Package' in row and 'Status' in row and
             re.fullmatch('[a-z0-9][a-z0-9+.-]{0,79}', row['Package']), 'format')
        need(len(rows) < 8192, 'bound')
        rows.append(row)
    need(bool(rows), 'format')
    return rows


def configuration_counts(raw):
    counts = dict.fromkeys(('pre', 'post', 'filters', 'force', 'logger', 'root', 'other'), 0)
    for line in raw.decode('utf8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key = re.split(r'[=\s]', line, maxsplit=1)[0].removeprefix('--')
        group = 'pre' if key == 'pre-invoke' else 'post' if key == 'post-invoke' else \
            'filters' if key in ('path-include', 'path-exclude') else \
            'force' if key.startswith(('force-', 'refuse-', 'no-force-')) else \
            'logger' if key in ('status-logger', 'status-fd', 'log') else \
            'root' if key in ('root', 'instdir', 'admindir') else 'other'
        counts[group] += 1
    return counts


def summarized(counts):
    return '-'.join(str(k) + str(v) for k, v in counts.items())


def load_reader(raw, filename):
    need(hashlib.sha256(raw).hexdigest() == BASE_SHA, 'binding')
    base = types.ModuleType('_fixed_assessment_reader')
    base.__file__ = filename
    exec(compile(raw, filename, 'exec'), base.__dict__)
    return base


def assess(io, data, report):
    paths = ['/' + row['path'] for row in data['files']]
    need(len(paths) == 57 and len(set(paths)) == 57 and
         all(str(pathlib.PurePosixPath(p)) == p and '..' not in pathlib.PurePosixPath(p).parts
             and p.startswith(('/usr/bin/', '/usr/lib/x86_64-linux-gnu/', '/usr/share/',
                               '/etc/X11/app-defaults/')) for p in paths), 'binding')
    report['stage'] = 'packages'
    raw = checked_read(io, '/var/lib/dpkg/status', 16 * 1024 ** 2)
    rows = control_records(raw)
    selected = {}
    pending = dict.fromkeys(('states', 'triggers', 'awaited'), 0)
    for row in rows:
        state = row['Status'].split()
        need(len(state) == 3 and state[0] in ('unknown', 'install', 'hold', 'deinstall', 'purge') and
             state[1] in ('ok', 'reinstreq') and state[2] in
             ('not-installed', 'config-files', 'half-installed', 'unpacked',
              'half-configured', 'triggers-awaited', 'triggers-pending', 'installed'), 'format')
        pending['states'] += state[1] != 'ok' or state[2] not in ('installed', 'config-files', 'not-installed')
        pending['triggers'] += bool(row.get('Triggers-Pending'))
        pending['awaited'] += bool(row.get('Triggers-Awaited'))
        if row.get('Architecture') == 'amd64' and row['Package'] in data['observedPackages']:
            name = row['Package']
            need(name not in selected and re.fullmatch(r'[0-9][0-9A-Za-z.+:~_-]{0,79}', row.get('Version', '')), 'format')
            selected[name] = row
    versions = []
    for name in data['observedPackages']:
        row = selected.get(name)
        versions.append(name + '=' + (row['Version'] if row else 'absent') + ':' +
                        ('installed' if row and row['Status'] == 'install ok installed' else
                         'other' if row else 'absent'))
    need(len(versions) == 27, 'binding')
    for index in range(7):
        report['versions' + str(index)] = ' '.join(versions[index * 4:(index + 1) * 4])
    report['packages'] = 'selected' + str(len(selected)) + '-globalrecords' + str(len(rows))
    report['stage'] = 'parents'
    parents = sorted({str(q) for p in paths for q in pathlib.PurePosixPath(p).parents})
    classes = {p: safe_directory(io, p) for p in parents}
    report['parentmap'] = ''.join(classes[p] for p in parents)
    report['parents'] = summarized({k: list(classes.values()).count(v) for k, v in
                                   [('safe', 's'), ('absent', 'a'), ('unsafe', 'u')]})
    need('u' not in classes.values(), 'unsafe')
    report['stage'] = 'files'
    states = []
    for row, path in zip(data['files'], paths):
        before = metadata(io, path, True)
        if before is None:
            state = 'a'
        elif path.startswith('/etc/'):
            state = 'f'  # Existing conffile contents are never read.
        elif row['kind'] == 'symlink':
            state = 'm' if stat.S_ISLNK(before.st_mode) and before.st_uid == 0 and before.st_gid == 0 and before.st_nlink == 1 and \
                io.readlink(path) == row['linkTarget'] else 'c'
            after = io.lstat(path)
            need(all(getattr(before, k) == getattr(after, k) for k in
                     ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')), 'changed')
        elif not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != int(row['mode'], 8) or before.st_size != row['bytes']:
            state = 'c'
        else:
            content = checked_read(io, path, 2 * 1024 ** 2)
            state = 'm' if hashlib.sha256(content).hexdigest() == row['sha256'] else 'c'
        states.append(state)
    report['filemap'] = ''.join(states)
    report['files'] = summarized({k: states.count(v) for k, v in
                                 [('absent', 'a'), ('matching', 'm'), ('conflict', 'c'), ('conffile', 'f')]})
    report['stage'] = 'configuration'
    config = checked_read(io, '/etc/dpkg/dpkg.cfg', 65536, True) or b''
    directory = '/etc/dpkg/dpkg.cfg.d'
    if safe_directory(io, directory) == 's':
        entries = io.listdir(directory)
        need(len(entries) <= 64, 'bound')
        for name in sorted(entries):
            if re.fullmatch('[A-Za-z0-9_-]+', name):
                config += b'\n' + checked_read(io, directory + '/' + name, 65536)
                need(len(config) <= 262144, 'bound')
    else:
        need(safe_directory(io, directory) == 'a', 'unsafe')
    report['configuration'] = summarized(configuration_counts(config)) + '-rootusercfgUnobserved'
    report['confighash'] = hashlib.sha256(config).hexdigest()
    report['stage'] = 'pending'
    unincorp = checked_read(io, '/var/lib/dpkg/triggers/Unincorp', 262144)
    updates = io.listdir('/var/lib/dpkg/updates')
    need(len(updates) <= 128, 'bound')
    report['pending'] = summarized(pending) + '-unincorp' + str(bool(unincorp.strip())).lower() + '-updates' + str(len(updates))
    for field, file, stride in [('diversions', '/var/lib/dpkg/diversions', 3),
                                ('overrides', '/var/lib/dpkg/statoverride', 1)]:
        content = checked_read(io, file, 1024 ** 2, True) or b''
        lines = content.decode('utf8').splitlines()
        need(len(lines) % stride == 0, 'format')
        matches = sum(any(p == line or p in line.split() for p in paths) for line in lines)
        report[field] = 'records' + str(len(lines) // stride) + '-targetmatches' + str(matches) + '-sha256=' + hashlib.sha256(content).hexdigest()
    report['stage'] = 'registrations'
    named = checked_read(io, '/var/lib/dpkg/triggers/ldconfig', 262144, True)
    names = [] if named is None else named.decode('ascii').split()
    need(all(re.fullmatch('[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:/noawait)?', x) for x in names), 'format')
    libc = sum(x.removesuffix('/noawait').removesuffix(':amd64') == 'libc-bin' for x in names)
    file_interests = checked_read(io, '/var/lib/dpkg/triggers/File', 1024 ** 2)
    matched = dict.fromkeys(('man', 'libc', 'other'), 0)
    for line in file_interests.decode('utf8').splitlines():
        fields = line.split()
        need(len(fields) >= 2 and fields[0].startswith('/'), 'format')
        prefix = fields[0].rstrip('/')
        if any(p == prefix or p.startswith(prefix + '/') for p in paths):
            for token in fields[1:]:
                name = token.split('/', 1)[0].removesuffix(':amd64')
                matched['man' if name == 'man-db' else 'libc' if name == 'libc-bin' else 'other'] += 1
    report['registrations'] = 'namedLibc' + str(libc) + '-namedOther' + str(len(names) - libc) + '-' + summarized(matched)
    report['stage'] = 'handlers'
    for field, file in HANDLERS.items():
        observed = checked_read(io, file, 4 * 1024 ** 2, True, identity=True)
        if observed is None:
            report[field] = 'absent'
        else:
            content, info = observed
            report[field] = 'root-regular-mode' + oct(stat.S_IMODE(info.st_mode))[2:] + '-bytes' + str(len(content)) + '-sha256=' + hashlib.sha256(content).hexdigest()
    menus = [metadata(io, p, True) for p in
             ('/usr/bin/update-menus', '/usr/sbin/update-menus')]
    report['menu'] = 'absent-fixed-paths' if all(v is None for v in menus) else 'present-needs-review'
    need(not io.fds or all(x['closed'] for x in io.fds), 'custody')
    report.update(result='metadata-only-complete', stage='complete', reason='none', custody='all-recorded-read-handles-closed')


def main():
    report = dict.fromkeys(FIELDS, 'not-checked')
    report.update(result='incomplete', stage='context')
    directory = pathlib.Path(__file__).resolve().parent
    # Import only the exact committed data-reader; its main guard remains inert.
    raw = (directory / 'linux-ubuntu-provisioning-assessment.py').read_bytes()
    base = load_reader(raw, str(directory / 'linux-ubuntu-provisioning-assessment.py'))
    host = base.Host()
    host.lstat, host.listdir, host.readlink, host.realpath = os.lstat, os.listdir, os.readlink, os.path.realpath
    try:
        need(sys.platform == 'linux' and os.getuid() > 0 and os.getuid() == os.geteuid() and
             os.uname().machine == 'x86_64' and os.environ.get('GITHUB_REF') == BRANCH and
             os.environ.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub' and
             os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
             os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64' and
             os.environ.get('GITHUB_EVENT_NAME') == 'push' and re.fullmatch('[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')) and
             os.environ.get('GITHUB_WORKFLOW_SHA') == os.environ.get('GITHUB_SHA') and
             not any(k in os.environ for k in ('APT_CONFIG', 'DPKG_ROOT', 'DPKG_ADMINDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH')), 'context')
        report['stage'] = 'binding'
        data_raw = host.read(str(directory / 'linux-ubuntu-provisioning-manifest.json'), 65536)
        need(hashlib.sha256(data_raw).hexdigest() == INPUT_SHA, 'binding')
        assess(host, json.loads(data_raw), report)
    except BaseException as error:
        host.first = error
        report['result'] = 'incomplete'
        report['reason'] = (str(error) if type(error) is Refused and str(error) in
            ('context', 'binding', 'metadata', 'unsafe', 'changed', 'format', 'bound', 'custody') else 'unexpected')
    if not base.custody_closed(host):
        host.retained('unknown-custody')
    raw = encode(report)
    file = os.environ.get('GITHUB_OUTPUT', '')
    need(file.startswith('/') and os.path.realpath(file) == file, 'output')
    owner = {'file': 'CI-output', 'closed': False}
    host.fds.append(owner)
    try:
        fd = os.open(file, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
        owner['fd'] = fd
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1, 'output')
        need(os.write(fd, raw) == len(raw), 'output')
        os.close(fd)
        owner['closed'] = True
    except BaseException as error:
        host.first = error
        host.retained('output-custody')
    return 0 if report['result'] == 'metadata-only-complete' else 1


if __name__ == '__main__':
    sys.exit(main())
