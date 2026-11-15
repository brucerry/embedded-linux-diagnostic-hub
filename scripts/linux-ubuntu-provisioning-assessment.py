"""Read-only host assessment, not a package installer or native qualification."""
import hashlib
import json
import os
import pathlib
import re
import selectors
import stat
import subprocess
import sys
import time

BRANCH = 'refs/heads/ci/v060-ubuntu-provisioning-assessment-20261115'
INPUT_SHA = '496103851b4395272a614d3039fcc21e69b4d54d019ed585ecd4d49a44844195'
HOOKS = ('DPkg::Pre-Invoke', 'DPkg::Post-Invoke', 'DPkg::Pre-Install-Pkgs',
         'APT::Install::Pre-Invoke', 'APT::Install::Post-Invoke-Success',
         'APT::Update::Pre-Invoke', 'APT::Update::Post-Invoke',
         'APT::Update::Post-Invoke-Success')
TOOLS = ('/usr/bin/dpkg-query', '/usr/bin/dpkg', '/usr/bin/apt-config')
VERSION = r'[0-9][0-9A-Za-z.+:~_-]{0,79}'
CURRENT = []
FIELDS = ('result', 'stage', 'dependencies', 'package', 'targetversion',
    'aptversion', 'dpkgversion', 'pendingpackages', 'files', 'filemap', 'hooks', 'hookhash',
    'hookrefs', 'dpkgconfig', 'dpkgconfighash', 'triggers', 'unincorporated',
    'updates', 'menu', 'simulation', 'versions0', 'versions1', 'versions2', 'versions3',
    'versions4', 'versions5')


class Refused(Exception):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def dependencies(data):
    need(data['package'] == {'name': 'x11-utils', 'version': '7.7+6build2',
        'architecture': 'amd64', 'bytes': 188800,
        'sha256': 'ffcc681f98ad4bd1857456f09c5464b5bdcb95a1162582899b2d93abaf361c74'}, 'input')
    rows = []
    for text in data['depends']:
        m = re.fullmatch(r'([a-z0-9][a-z0-9+-]{0,63})(?: \((>=|>>) (' + VERSION + r')\))?', text)
        need(m is not None, 'input')
        rows.append((m[1], m[2], m[3]))
    need(len(rows) == 23 and len({r[0] for r in rows}) == 23, 'input')
    return rows


def package_rows(raw, error, exit_code, names):
    need(exit_code in (0, 1) and len(raw) <= 32768 and len(error) <= 16384, 'query')
    result = {}
    for line in raw.decode('ascii').splitlines():
        row = line.split('\t')
        need(len(row) == 5, 'query')
        name = row[0].removesuffix(':amd64')
        need(name in names and name not in result and re.fullmatch(VERSION, row[1]) and
             re.fullmatch(r'[uihrp][ncHUFwWti][ R]', row[2]), 'query')
        result[name] = {'version': row[1], 'state': 'installed' if row[2] == 'ii ' else
                        'held-installed' if row[2] == 'hi ' else 'other-state',
                        'pending': bool(row[3] or row[4])}
    missing = set(names) - set(result)
    messages = error.decode('ascii').splitlines()
    expected = {'dpkg-query: no packages found matching ' + n + ':amd64' for n in missing}
    need((exit_code == 0 and not missing and not messages) or
         (exit_code == 1 and set(messages) == expected and len(messages) == len(expected)), 'query')
    return result


def hook_rows(raw):
    """Only the eight explicit hook subtrees; no values or unknown key names escape."""
    counts = [0] * len(HOOKS)
    references = dict.fromkeys(('needrestart', 'update-menus', 'packagekit', 'appstream', 'other'), 0)
    for line in raw.splitlines():
        fields = line.split(b'\t', 1)
        need(len(fields) == 2, 'hooks')
        key, value = fields
        key = key.decode('ascii').lower()
        matches = [i for i, prefix in enumerate(HOOKS)
                   if key == prefix.lower() or key.startswith(prefix.lower() + '::')]
        need(len(matches) == 1, 'hooks')
        if not value:
            continue
        counts[matches[0]] += 1
        text = value.lower()
        tags = [tag for tag in references if tag != 'other' and tag.encode() in text]
        for tag in tags or ['other']:
            references[tag] += 1
    return counts, references, hashlib.sha256(raw).hexdigest()


def dpkg_config_rows(raw):
    counts = {'pre': 0, 'post': 0, 'filters': 0, 'other': 0}
    for line in raw.decode('utf8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name = re.split(r'[=\s]', line, 1)[0].removeprefix('--')
        key = 'pre' if name == 'pre-invoke' else 'post' if name == 'post-invoke' else \
              'filters' if name in ('path-include', 'path-exclude') else 'other'
        counts[key] += 1
    return counts


def trigger_rows(raw, files):
    matched = []
    for line in raw.decode('utf8').splitlines():
        if not line.strip():
            continue
        fields = line.split()
        need(len(fields) >= 2 and fields[0].startswith('/'), 'triggers')
        prefix = fields[0].rstrip('/')
        if any(file == prefix or file.startswith(prefix + '/') for file in files):
            for item in fields[1:]:
                package = item.split('/', 1)[0].removesuffix(':amd64')
                need(re.fullmatch('[a-z0-9][a-z0-9+-]{0,63}', package), 'triggers')
                matched.append('man-db' if package == 'man-db' else 'menu' if package == 'menu' else 'other')
    return {key: matched.count(key) for key in ('man-db', 'menu', 'other')}


def encoded(report):
    need(type(report) is dict and set(report) == set(FIELDS), 'output')
    need(report['result'] in ('incomplete', 'read-only-assessment-complete') and
         report['stage'] in ('context', 'tools', 'input', 'packages', 'files', 'hooks',
                             'dpkg-config', 'triggers', 'menu', 'complete'), 'output')
    need(all(type(value) is str and re.fullmatch('[A-Za-z0-9 .+:~_=-]{1,480}', value)
             for value in report.values()), 'output')
    raw = ''.join(key + '=' + report[key] + '\n' for key in FIELDS).encode('ascii')
    need(len(raw) <= 6144, 'output')
    return raw


def custody_closed(io):
    return (all(owner['closed'] for owner in io.fds) and
            all(owner['closed'] and owner['exit'] is not None and
                owner['eof'] == {'out', 'err'} for owner in io.children))


class Host:
    """Only fixed data-query commands. No apt-get, shell, pager or package script."""
    def __init__(self):
        self.started = time.monotonic()
        self.children = []
        self.fds = []
        self.first = None  # Preserve the original object privately; never publish exception text.
        self.env = {key: value for key, value in os.environ.items() if key in ('HOME', 'TMPDIR')}
        self.env.update(PATH='/usr/sbin:/usr/bin:/sbin:/bin', LANG='C', LC_ALL='C')

    def gate(self):
        need(0 <= time.monotonic() - self.started < 55, 'deadline')

    def retained(self, code):
        # Preserve original children/handles; never kill/retry/clean up to force closure.
        self.failure = code
        while True:
            time.sleep(1)

    def run(self, role, names=None, comparison=None):
        self.gate()
        if role == 'query':
            need(names and all(re.fullmatch('[a-z0-9][a-z0-9+-]{0,63}', n) for n in names), 'query')
            argv = ['/usr/bin/dpkg-query', '--no-pager', '--admindir=/var/lib/dpkg', '--show',
                '--showformat=${binary:Package}\t${Version}\t${db:Status-Abbrev}\t${Triggers-Pending}\t${Triggers-Awaited}\n',
                *[n + ':amd64' for n in names]]
        elif role == 'compare':
            a, relation, b = comparison
            need(re.fullmatch(VERSION, a) and re.fullmatch(VERSION, b) and relation in ('ge', 'gt'), 'query')
            argv = ['/usr/bin/dpkg', '--compare-versions', a, relation, b]
        elif role == 'hooks':
            argv = ['/usr/bin/apt-config', '--no-empty', '--format', '%F%N%V%n', 'dump', *HOOKS]
        else:
            raise Refused('command')
        owner = {'role': role, 'issued': True, 'child': None, 'exit': None, 'eof': set(), 'closed': False}
        self.children.append(owner)
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, close_fds=True, env=self.env)
        owner['child'] = p
        parts = {'out': bytearray(), 'err': bytearray()}
        selector = selectors.DefaultSelector()
        for label, stream in (('out', p.stdout), ('err', p.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, label)
        until = time.monotonic() + 5
        while selector.get_map() or p.poll() is None:
            if time.monotonic() >= until or time.monotonic() - self.started >= 55:
                self.retained('child-deadline')
            for key, _ in selector.select(0.02):
                part = os.read(key.fd, 16384)
                if not part:
                    owner['eof'].add(key.data)
                    selector.unregister(key.fileobj)
                else:
                    parts[key.data].extend(part)
                    if len(parts[key.data]) > (65536 if key.data == 'out' else 16384):
                        self.retained('child-stream-bound')
        owner['exit'] = p.poll()
        try:
            p.stdout.close()
            p.stderr.close()
            selector.close()
            owner['closed'] = True
        except BaseException as error:
            self.first = error
            self.retained('child-close')
        self.gate()
        return bytes(parts['out']), bytes(parts['err']), owner['exit']

    def read(self, file, cap, missing=False):
        self.gate()
        try:
            before = os.lstat(file)
        except FileNotFoundError:
            if missing:
                return b''
            raise
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
             before.st_size <= cap and os.path.realpath(file) == file, 'file')
        owner = {'file': file, 'issued': True, 'fd': None, 'close_issued': False, 'closed': False}
        self.fds.append(owner)
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        owner['fd'] = fd
        parts = bytearray()
        while True:
            self.gate()
            block = os.read(fd, min(65536, cap - len(parts) + 1))
            parts.extend(block)
            need(len(parts) <= cap, 'file')
            if not block:
                break
        after = os.fstat(fd)
        again = os.lstat(file)
        for key in ('st_dev', 'st_ino', 'st_uid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'):
            need(getattr(before, key) == getattr(after, key) == getattr(again, key), 'changed')
        need(len(parts) == before.st_size, 'changed')
        owner['close_issued'] = True
        try:
            os.close(fd)
            owner['closed'] = True
        except BaseException as error:
            self.first = error
            self.retained('file-close')
        self.gate()
        return bytes(parts)


def assess(io, data, report):
    deps = dependencies(data)
    names = [r[0] for r in deps] + ['x11-utils', 'menu', 'man-db', 'apt', 'dpkg']
    report['stage'] = 'packages'
    inventory = package_rows(*io.run('query', names=names), names)
    versions = []
    satisfied = 0
    for name, relation, bound in deps:
        value = inventory.get(name)
        state = 'missing' if value is None else value['state']
        if value and state in ('installed', 'held-installed'):
            ok = True
            if relation:
                out, err, status = io.run('compare', comparison=(value['version'], 'ge' if relation == '>=' else 'gt', bound))
                need(status in (0, 1) and not out and not err, 'query')
                ok = status == 0
            held = state == 'held-installed'
            state = ('held-' if held else '') + ('satisfied' if ok else 'too-old')
            satisfied += ok
        versions.append(name + '=' + (value['version'] if value else 'absent') + ':' + state)
    for i in range(6):
        report['versions' + str(i)] = ' '.join(versions[i * 4:(i + 1) * 4])
    report['dependencies'] = str(satisfied) + '-of-23'
    report['package'] = inventory.get('x11-utils', {}).get('state', 'missing')
    report['targetversion'] = inventory.get('x11-utils', {}).get('version', 'absent')
    report['aptversion'] = inventory.get('apt', {}).get('version', 'absent')
    report['dpkgversion'] = inventory.get('dpkg', {}).get('version', 'absent')
    report['pendingpackages'] = str(sum(v['pending'] for v in inventory.values()))
    report['stage'] = 'files'
    paths = []
    filemap = []
    counts = dict.fromkeys(('absent', 'matching', 'conflict', 'conffile', 'unreadable'), 0)
    for row in data['files']:
        file = '/' + row['path']
        need(file.startswith(('/usr/bin/', '/usr/share/', '/etc/X11/app-defaults/')) and
             str(pathlib.PurePosixPath(file)) == file and '..' not in pathlib.PurePosixPath(file).parts,
             'input')
        paths.append(file)
        try:
            value = os.lstat(file)
        except FileNotFoundError:
            key = 'absent'
        except OSError:
            key = 'unreadable'
        else:
            if file.startswith('/etc/'):
                key = 'conffile'  # Never read or overwrite a pre-existing configuration value.
            elif not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != 0 or \
                    stat.S_IMODE(value.st_mode) != int(row['mode'], 8) or value.st_size != row['bytes'] or os.path.realpath(file) != file:
                key = 'conflict'
            else:
                # Issued-read/descriptor errors propagate; never relabel custody as a path absence.
                key = 'matching' if hashlib.sha256(io.read(file, 2 * 1024 ** 2)).hexdigest() == row['sha256'] else 'conflict'
        counts[key] += 1
        filemap.append({'absent': 'a', 'matching': 'm', 'conflict': 'c', 'conffile': 'f', 'unreadable': 'u'}[key])
    report['files'] = '-'.join(k + str(v) for k, v in counts.items())
    report['filemap'] = ''.join(filemap)
    report['stage'] = 'hooks'
    raw, error, status = io.run('hooks')
    need(status == 0 and not error, 'hooks')
    counts, references, digest = hook_rows(raw)
    report['hooks'] = '-'.join(str(n) for n in counts)
    report['hookhash'] = digest
    report['hookrefs'] = '-'.join(k + str(v) for k, v in references.items())
    report['stage'] = 'dpkg-config'
    config = io.read('/etc/dpkg/dpkg.cfg', 65536, True)
    try:
        entries = os.listdir('/etc/dpkg/dpkg.cfg.d')
    except FileNotFoundError:
        entries = []
    need(len(entries) <= 64, 'file')
    for name in sorted(entries):
        if re.fullmatch('[A-Za-z0-9_-]+', name):
            config += b'\n' + io.read('/etc/dpkg/dpkg.cfg.d/' + name, 65536)
            need(len(config) <= 262144, 'file')
    report['dpkgconfig'] = '-'.join(k + str(v) for k, v in dpkg_config_rows(config).items())
    report['dpkgconfighash'] = hashlib.sha256(config).hexdigest()
    report['stage'] = 'triggers'
    matches = trigger_rows(io.read('/var/lib/dpkg/triggers/File', 1024 ** 2), paths)
    report['triggers'] = '-'.join(k + str(v) for k, v in matches.items())
    report['unincorporated'] = 'present' if io.read('/var/lib/dpkg/triggers/Unincorp', 262144).strip() else 'empty'
    report['updates'] = str(len(os.listdir('/var/lib/dpkg/updates')))
    report['stage'] = 'menu'
    found = []
    for file in ('/usr/bin/update-menus', '/usr/sbin/update-menus'):
        try:
            value = os.lstat(file)
        except FileNotFoundError:
            continue
        found.append('regular-executable' if stat.S_ISREG(value.st_mode) and value.st_mode & 0o111 else 'other')
    report['menu'] = '-'.join(found) if found else 'absent-fixed-paths'
    report['simulation'] = 'not-run-hook-execution-boundary'
    need(custody_closed(io), 'custody')
    report['result'], report['stage'] = 'read-only-assessment-complete', 'complete'


def main():
    report = dict.fromkeys(FIELDS, 'not-checked')
    report['result'], report['stage'] = 'incomplete', 'context'
    host = Host()
    CURRENT.append(host)
    try:
        need(sys.platform == 'linux' and os.uname().machine == 'x86_64' and
             os.getuid() > 0 and os.getuid() == os.geteuid() and
             os.environ.get('GITHUB_REF') == BRANCH and
             os.environ.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub' and
             os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
             os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
             os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64' and
             os.environ.get('GITHUB_EVENT_NAME') == 'push' and
             re.fullmatch('[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')) and
             os.environ.get('GITHUB_WORKFLOW_SHA') == os.environ.get('GITHUB_SHA') and
             not any(k in os.environ for k in ('APT_CONFIG', 'DPKG_ROOT', 'DPKG_ADMINDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH')), 'context')
        report['stage'] = 'tools'
        for tool in TOOLS:
            for parent in reversed(pathlib.PurePosixPath(tool).parents):
                info = os.lstat(str(parent))
                need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid()) and
                     info.st_ino > 0 and not info.st_mode & 0o7022 and
                     os.path.realpath(str(parent)) == str(parent), 'tool')
            value = os.lstat(tool)
            need(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and value.st_nlink == 1 and
                 not value.st_mode & 0o7022 and value.st_mode & 0o111 and os.path.realpath(tool) == tool, 'tool')
        report['stage'] = 'input'
        raw = host.read(str(pathlib.Path(__file__).resolve().parent / 'linux-ubuntu-x11-audited-metadata.json'), 32768)
        need(hashlib.sha256(raw).hexdigest() == INPUT_SHA, 'input')
        assess(host, json.loads(raw), report)
    except BaseException as error:
        host.first = error
        report['result'] = 'incomplete'
    if not custody_closed(host):
        host.retained('unknown-custody')
    raw = encoded(report)
    file = os.environ.get('GITHUB_OUTPUT', '')
    need(file.startswith('/') and os.path.realpath(file) == file, 'output')
    owner = {'file': 'CI-output', 'issued': True, 'fd': None, 'closed': False}
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
    return 0 if report['result'] == 'read-only-assessment-complete' else 1


if __name__ == '__main__':
    sys.exit(main())
