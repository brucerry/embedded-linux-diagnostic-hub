"""Verify boot observations and the local APT plan before allowing guest mutation."""

from hashlib import file_digest
import json
import os
from pathlib import Path
import re
import stat

from controller import TRIO, closed, digest, need


MOUNTS = ('/mnt/hub-payload','/mnt/hub-deps')
NODE_SIZE = 126_881_248
NODE_SHA = '904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52'

# The origin column is display text. Name, prior version, candidate and architecture
# are the locked fields. The file-only package inventory is verified separately.
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

APPLY_STAGES = ('guest_apply_preflight','guest_apply_capture','guest_apply_exit',
                'guest_apply_database','guest_apply_capacity')
APPLY_CAPTURE_FAILURES = frozenset({'fail-launch','fail-timeout','fail-output-cap','fail-io'})
APPLY_EXIT_PATTERNS = (
    ('fail-storage', rb'^(?:E:|dpkg:|dpkg-deb:).*(?:No space left on device|Disk quota exceeded|You don.t have enough free space)'),
    ('fail-lock', rb'^E: (?:Could not get lock |Unable to acquire the .*lock|Unable to lock directory )'),
    ('fail-access', rb'^(?:E:|dpkg:|dpkg-deb:).*(?:Permission denied|Read-only file system)'),
    ('fail-dpkg-script', rb'^ *(?:(?:installed|new) .* script subprocess returned error exit status [1-9][0-9]*|dpkg: error processing package .* \(--triggers-only\):)$'),
    ('fail-archives', rb'^E: (?:Failed to fetch |Unable to fetch some archives|Unable to correct missing packages)'),
    ('fail-dependencies', rb'^E: (?:Unmet dependencies\.|Error, pkgProblemResolver::Resolve generated breaks)'),
    ('fail-dpkg', rb'^E: Sub-process /usr/bin/dpkg returned an error code \([1-9][0-9]*\)$'),
)
APPLY_EXIT_FAILURES = frozenset({'fail-signal','fail-unknown',*(category for category,_ in APPLY_EXIT_PATTERNS)})
APPLY_FAILURES = {'guest_apply_capture': APPLY_CAPTURE_FAILURES, 'guest_apply_exit': APPLY_EXIT_FAILURES}


def apply_exit_failure(code, stdout, stderr):
    """Classify only a failed attempt. Raw streams stay in the disposable guest."""
    need(type(code) is int and code!=0 and type(stdout) is type(stderr) is bytes and
         len(stdout)+len(stderr)<=131072,'guest-apt-apply-classifier-input')
    if code<0:
        return 'fail-signal'
    for category,pattern in APPLY_EXIT_PATTERNS:
        if any(re.search(pattern,stream,re.MULTILINE) for stream in (stdout,stderr)):
            return category
    return 'fail-unknown'


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


def media_and_network(mountinfo, interfaces, ipv4, ipv6):
    need(interfaces == ['lo'],'guest-loopback-only')
    for routes in (ipv4,ipv6):
        need(type(routes) is list and all(type(route) is dict and route.get('dev') == 'lo'
             and route.get('dst') not in (None,'default','0.0.0.0/0','::/0')
             and 'gateway' not in route and 'nexthops' not in route and 'via' not in route
             for route in routes),'guest-route-table')
    found = {}
    for row in mountinfo.splitlines():
        left, sep, right = row.partition(' - ')
        fields, fs = left.split(), right.split()
        need(sep and len(fields) >= 6 and len(fs) == 3,'guest-mountinfo')
        path = fields[4]
        if path in MOUNTS:
            need(path not in found and fields[3] == '/' and
                 {'ro','nosuid','nodev','noexec'} <= set(fields[5].split(',')) and fs[0] == 'iso9660'
                 and re.fullmatch(r'/dev/sr[0-9]+',fs[1]) and 'ro' in fs[2].split(','),
                 'guest-media-readonly')
            found[path] = fs[1]
        elif any(path.startswith(base+'/') for base in MOUNTS):
            raise ValueError('guest-media-nested-mount')
    need(set(found) == set(MOUNTS) and len(set(found.values())) == len(MOUNTS),'guest-media-roster')


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
        need(stat.S_ISREG(first.st_mode) and first.st_size == size and file_digest(body,'sha256').hexdigest() ==
             expected_hash,'guest-deb-pin')
        last = os.fstat(body.fileno())
        need((last.st_size,last.st_mtime_ns,last.st_ctime_ns) ==
             (first.st_size,first.st_mtime_ns,first.st_ctime_ns),'guest-deb-changed')


def media_files(directory):
    paths = list(Path(directory).iterdir())
    aliases = {path.name.lower():path for path in paths}
    need(len(aliases) == len(paths),'guest-media-duplicate-alias')
    return aliases


def product_media(directory, expected_binding_sha, attempt, nonce, expected_lock):
    files = media_files(directory)
    need(set(files) == {'bind.jsn',*(alias.lower() for alias,_ in TRIO.values())},'guest-product-roster')
    flags = os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
    with os.fdopen(os.open(files['bind.jsn'],flags),'rb') as source:
        st = os.fstat(source.fileno())
        need(stat.S_ISREG(st.st_mode) and 0 < st.st_size <= 8192,'guest-product-binding-file')
        raw = source.read(8193)
        need(len(raw) == st.st_size and digest(raw) == expected_binding_sha,'guest-product-binding-pin')
    binding = json.loads(raw,object_pairs_hook=closed)
    need(set(binding) == {'nonce','attempt','transactionSHA256','sourceMembers'} and binding['nonce'] == nonce and binding['attempt'] == attempt and
         binding['transactionSHA256'] == expected_lock,'guest-product-attempt')
    members = binding['sourceMembers']
    need(type(members) is list and len(members) == len(TRIO),'guest-product-members')
    for row, (name,(alias,cap)) in zip(members,TRIO.items(),strict=True):
        need(type(row) is list and len(row) == 3 and row[0] == name and type(row[1]) is int and
             0 < row[1] <= cap,'guest-product-member-pin')
        locked_file(files[alias.lower()],row[1],row[2])


def preflight(*, lock_bytes, expected_lock, status_bytes, mountinfo, interfaces, ipv4, ipv6,
              packages, apt_stdout, apt_stderr, apt_exit):
    """The caller supplies actual stock reads from inside the admitted disposable guest."""
    media_and_network(mountinfo,interfaces,ipv4,ipv6)
    need(digest(lock_bytes) == expected_lock,'guest-transaction-pin')
    lock = json.loads(lock_bytes,object_pairs_hook=closed)
    need(digest(status_bytes) == lock['guestStatusSHA256'],'guest-dpkg-status-pin')
    names = {f'p{index:03}.deb' for index,_ in enumerate(lock['entries'])}
    actual = media_files(packages)
    need(set(actual) == names|{'lock.jsn','node.bin'},'guest-deb-media-roster')
    locked_file(actual['node.bin'],NODE_SIZE,NODE_SHA)
    locked_file(actual['lock.jsn'],len(lock_bytes),expected_lock)
    for index,row in enumerate(lock['entries']):
        locked_file(actual[f'p{index:03}.deb'],row['compressed_bytes'],row['sha256'])
    need(type(apt_exit) is int and apt_exit == 0 and apt_stderr == b'','guest-solver-exit')
    plan_matches(apt_stdout,lock)
    return ('media','network','package_state','dependencies')


def admit_actor(*, uid, euid, exact_loader, protected_owner, pty, free_before, required_before, free_after):
    """Gate the ordinary-user install actor after a separately authorized exact stock transaction."""
    need(type(uid) is int and type(euid) is int and uid == euid and uid > 0,'guest-actor-user')
    need(exact_loader is True,'guest-actor-loader')
    need(protected_owner is True and pty is True,'guest-actor-ownership-or-pty')
    need(all(type(value) is int for value in (free_before,required_before,free_after)) and
         free_before >= required_before >= 4*2**30 and free_after >= 4*2**30,'guest-actor-storage')


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


def exercise_inert_actor(*, product, admission, observe_actor, fake_provision, fake_install, fake_uninstall):
    """Fixture-only operation ordering. No real launcher or package command is supplied here."""
    preflight(**admission)
    product_media(**product)
    after = fake_provision()
    provisioned_state(admission['status_bytes'],after,json.loads(admission['lock_bytes'],object_pairs_hook=closed))
    admit_actor(**observe_actor())
    need(fake_install() is True,'guest-install-receipt')
    need(fake_uninstall() is True,'guest-uninstall-receipt')
