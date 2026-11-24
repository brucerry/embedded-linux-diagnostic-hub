"""Provisioning-only gates reproduced from the exact root apply source."""
from hashlib import sha256
import os
import re
import stat

def need(value,label):
    if not value:
        raise ValueError(label)

def closed(pairs):
    value = dict(pairs)
    need(len(pairs) == len(value),'duplicate-json-key')
    return value


NAME = r'([a-z0-9+.\-]+)(?::amd64)?'
VERSION = r'[0-9][A-Za-z0-9.+~:\-]*'
DESTINATION = rf'\(({VERSION})(?: [^()\[\]\r\n]+)? \[(all|amd64)\]\)'
INST = re.compile(rf'Inst {NAME}(?: \[({VERSION})\])? {DESTINATION}(?: \[\])?')
CONF = re.compile(rf'Conf {NAME} {DESTINATION}')
APT_EXEC_CONFIG = {
    'Dir::State::status': '/var/lib/dpkg/status',
    'Dir::Cache::pkgcache': '',
    'Dir::Cache::srcpkgcache': '',
    'APT::Architecture': 'amd64',
    'APT::Sandbox::User': '_apt',
    'APT::Install-Recommends': 'false',
    'APT::Install-Suggests': 'false',
    'APT::Get::AllowUnauthenticated': 'false',
    'Acquire::AllowInsecureRepositories': 'false',
    'Acquire::AllowDowngradeToInsecureRepositories': 'false',
    'Acquire::Check-Valid-Until': 'true',
    'Acquire::Retries': '0',
}

def apt_config_options(scratch):
    path = str(scratch)
    need(scratch.is_absolute() and '..' not in scratch.parts and
         re.fullmatch(r'/[a-zA-Z0-9_./-]+',path), 'guest-apt-private-config-path')
    no_parts, empty = str(scratch/'parts'),str(scratch/'empty.conf')
    return APT_EXEC_CONFIG | {
        'Dir::Etc::parts': no_parts,
        'Dir::Etc::main': empty,
        'Dir::Etc::sourcelist': empty,
        'Dir::Etc::sourceparts': no_parts,
        'Dir::Etc::preferences': empty,
        'Dir::Etc::preferencesparts': no_parts,
        'Dir::State::lists': str(scratch/'lists'),
    }


def apt_config_text(settings):
    return (''.join(f'{key} "{setting}";\n' for key,setting in settings.items()) +
            'APT::Architectures { "amd64"; };\n').encode('ascii')


def config_matches(output, settings):
    need(type(output) is bytes and 0<len(output)<=131072 and output.endswith(b'\n'),
         'guest-apt-effective-config-limit')
    rows = {}
    architectures = []
    expected = {name.lower():value for name,value in settings.items()}
    for row in output.decode('ascii').splitlines():
        match = re.fullmatch(r'(\S+) "(.*)";',row)
        need(match is not None,'guest-apt-effective-config-format')
        key,value = match.groups()
        folded = key.lower()
        need(not re.search(r'(^|::)(?:[^:]*invoke[^:]*|[^:]*install-pkgs[^:]*|hooks?)(::|$)',folded),
             'guest-apt-ambient-hook')
        if folded=='apt::architectures::':
            architectures.append(value)
        elif folded in expected:
            need(folded not in rows,'guest-apt-effective-config-duplicate')
            rows[folded]=value
    need(architectures==['amd64'] and rows==expected,
         'guest-apt-effective-config-mismatch')


def plan_matches(output, transaction):
    need(type(output) is bytes and 0<len(output)<=131072 and output.endswith(b'\n'),
         'guest-solver-output-limit')
    installed,configured = {},{}
    for line in output.decode('ascii').split('\n'):
        words = line.split(maxsplit=1)
        if not words:
            continue
        operation = words[0]
        if operation in ('Remv','Purg'):
            raise ValueError('guest-solver-removal')
        if operation=='Inst':
            match = INST.fullmatch(line)
            need(match is not None and match[1] not in installed,'guest-solver-install-row')
            installed[match[1]] = match[2],match[3],match[4]
        elif operation=='Conf':
            match = CONF.fullmatch(line)
            need(match is not None and match[1] not in configured and match[1] in installed,
                 'guest-solver-configure-row')
            configured[match[1]] = match[2],match[3]
    expected = {row['name']:(row['beforeVersion'],row['version'],row['architecture'])
                for row in transaction['entries']}
    need(len(expected)==len(transaction['entries']) and installed==expected,'guest-solver-transaction')
    need(configured=={key:(version,architecture) for key,(_,version,architecture) in expected.items()},
         'guest-solver-configure-transaction')


def locked_file(path, size, expected_hash):
    flags = os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
    with os.fdopen(os.open(path,flags),'rb') as body:
        first = os.fstat(body.fileno())
        need(stat.S_ISREG(first.st_mode) and first.st_size == size,'guest-deb-size')
        stream_hash = sha256()
        remaining = size
        while remaining:
            chunk = body.read(min(65536,remaining))
            need(bool(chunk),'guest-deb-short')
            stream_hash.update(chunk)
            remaining -= len(chunk)
        need(not body.read(1) and stream_hash.hexdigest()==expected_hash,'guest-deb-pin')
        last = os.fstat(body.fileno())
        need((last.st_size,last.st_mtime_ns,last.st_ctime_ns) ==
             (first.st_size,first.st_mtime_ns,first.st_ctime_ns),'guest-deb-changed')


def database(raw):
    need(type(raw) is bytes and 0 < len(raw) <= 4*2**20,'guest-dpkg-status-limit')
    packages = {}
    for stanza in raw.decode().strip().split('\n\n'):
        rows = [(key,value) for line in stanza.splitlines()
                for key,sep,value in [line.partition(': ')]
                if sep and key in ('Package','Architecture','Version','Status')]
        row = closed(rows)
        need(set(row) == {'Package','Architecture','Version','Status'} and
             row['Status'] == 'install ok installed' and row['Architecture'] in ('amd64','all') and
             row['Package'] not in packages,'guest-dpkg-status-row')
        packages[row['Package']] = (row['Version'],row['Architecture'])
    return packages


def provisioned_state(before, after, transaction):
    expected = database(before)
    need(len(expected) == transaction['guestBeforePackageCount'],'guest-dpkg-before-count')
    for row in transaction['entries']:
        name = row['name']
        previous = expected.get(name)
        need((previous[0] if previous else None) == row['beforeVersion'],'guest-dpkg-upgrade-version')
        expected[name] = (row['version'],row['architecture'])
    need(len(expected) == transaction['guestAfterPackageCount'] and database(after) == expected,
         'guest-dpkg-final-state')


