"""One fixed signed Ubuntu Release observation, never provisioning or runtime.

Import is inert. Fixed HTTPS metadata and existing gpgv are the only children.
The explicit index modes may fetch one signed, bounded package index, never
package/key bytes, installation, a client or Hub code.
Raw output remains private. Unknown children/descriptors are never killed,
retried or cleaned up to manufacture completion.
"""
import datetime
import email.utils
import errno
import hashlib
import json
import lzma
import os
import pathlib
import re
import select
import stat
import subprocess
import sys
import time

REPOSITORY = 'brucerry/embedded-linux-diagnostic-hub'
BRANCH = 'refs/heads/ci/v060-ubuntu-archive-verifier-20261114'
CLASSIFICATION_BRANCH = 'refs/heads/ci/v060-ubuntu-keyring-classification-20261114'
CANDIDATE_BRANCH = 'refs/heads/ci/v060-ubuntu-archive-input-preflight-20261114'
VERIFICATION_BRANCH = 'refs/heads/ci/v060-ubuntu-archive-metadata-verify-20261114'
INDEX_BRANCH = 'refs/heads/ci/v060-ubuntu-x11-index-auth-20261114'
INDEX_REPORT_BRANCH = 'refs/heads/ci/v060-ubuntu-x11-index-report-20261114'
CANDIDATE_PATHS = (('root', '/'), ('etc', '/etc'), ('apt', '/etc/apt'),
                   ('trusted-directory', '/etc/apt/trusted.gpg.d'),
                   ('keyring', '/etc/apt/trusted.gpg.d/ubuntu-keyring-2018-archive.gpg'))
CURL = '/usr/bin/curl'
GPGV = '/usr/bin/gpgv'
KEYRING = '/usr/share/keyrings/ubuntu-archive-keyring.gpg'
PRIMARY = 'F6ECB3762474EDA9D21B7022871920D1991BC93C'
URL = 'https://snapshot.ubuntu.com/ubuntu/20261113T000000Z/dists/noble/InRelease'
INDEX_PATH = 'main/binary-amd64/Packages.xz'
INDEX_URL = 'https://snapshot.ubuntu.com/ubuntu/20261113T000000Z/dists/noble/main/binary-amd64/Packages.xz'
INDEX_INRELEASE_SHA256 = 'cdb2f31d809f589719a53c6ad15f255b27569c4059542ada282aaa21b8e164b0'
INDEX_COMPRESSED_LIMIT = 8 * 1024 ** 2
INDEX_TEXT_LIMIT = 64 * 1024 ** 2
INDEX_DECODER_MEMORY = 128 * 1024 ** 2
SNAPSHOT = datetime.datetime(2026, 11, 13, tzinfo=datetime.timezone.utc).timestamp()
TRUST_ENV = ('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy',
             'all_proxy', 'no_proxy', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE')
PHASES = ('binding', 'preflight', 'download', 'verification', 'index-download', 'index-validation', 'readback', 'output')
PREFLIGHT_REASONS = ('not-reported', 'path-absent', 'stat-denied', 'stat-error', 'symlink',
                     'nonregular', 'non-root-owner', 'link-count', 'empty', 'oversize',
                     'unsafe-mode', 'noncanonical', 'not-executable', 'attributes-ok')
CANDIDATE_REASONS = ('input-all-attributes-ok',) + tuple(
    'input-' + label + '-' + reason for label, _ in CANDIDATE_PATHS for reason in
    ('path-absent', 'stat-denied', 'stat-error', 'symlink', 'non-directory', 'parent-owner',
     'nonregular', 'non-root-owner', 'link-count', 'empty', 'oversize', 'unsafe-mode', 'noncanonical'))
CURRENT = []


def need(value, code):
    if not value:
        raise RuntimeError(code)


def safe_stage(value):
    return value if type(value) is str and value in PHASES else 'unavailable'


def identity(value):
    return tuple(getattr(value, name) for name in ('st_dev', 'st_ino', 'st_uid', 'st_mode',
                 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def preflight_attribute_reason(info):
    """Classify exactly the preliminary attribute guard; never admit key bytes."""
    if stat.S_ISLNK(info.st_mode):
        return 'symlink'
    if not stat.S_ISREG(info.st_mode):
        return 'nonregular'
    if info.st_uid != 0:
        return 'non-root-owner'
    if info.st_nlink != 1:
        return 'link-count'
    if info.st_size <= 0:
        return 'empty'
    if info.st_size > 16 * 1024 ** 2:
        return 'oversize'
    if info.st_mode & 0o7022:
        return 'unsafe-mode'
    return 'attributes-ok'


def preflight_stat_reason(error):
    if error.errno == errno.ENOENT:
        return 'path-absent'
    if error.errno in (errno.EACCES, errno.EPERM):
        return 'stat-denied'
    return 'stat-error'


def candidate_parent_reason(info, uid):
    """Same directory predicate as Probe.parents, including the root itself."""
    if stat.S_ISLNK(info.st_mode):
        return 'symlink'
    if not stat.S_ISDIR(info.st_mode):
        return 'non-directory'
    if info.st_uid not in (0, uid):
        return 'parent-owner'
    if info.st_mode & 0o7022:
        return 'unsafe-mode'
    return 'attributes-ok'


def candidate_metadata(probe, uid):
    """Only fixed-path metadata; no key bytes, file opens or trust admission."""
    for index, (label, path) in enumerate(CANDIDATE_PATHS):
        probe.gate()
        try:
            info = probe.capture(os.lstat(path))
        except OSError as error:
            probe.returned.append(error)
            return 'input-' + label + '-' + preflight_stat_reason(error)
        reason = (preflight_attribute_reason(info) if index == len(CANDIDATE_PATHS) - 1
                  else candidate_parent_reason(info, uid))
        if reason == 'attributes-ok' and probe.capture(os.path.realpath(path)) != path:
            reason = 'noncanonical'
        if reason != 'attributes-ok':
            return 'input-' + label + '-' + reason
    return 'input-all-attributes-ok'


def fixed_command(role, directory, keyring=KEYRING, entry=None):
    need(keyring in (KEYRING, CANDIDATE_PATHS[-1][1]), 'SIGNED_FIXED_KEYRING')
    if role == 'index':
        checked_index_entry(entry)
        return (CURL, '--disable', '--proto', '=https', '--fail', '--silent', '--show-error',
                '--max-time', '20', '--connect-timeout', '10', '--retry', '0', '--max-filesize', str(entry[1]), INDEX_URL)
    need(entry is None, 'SIGNED_UNEXPECTED_INDEX_ENTRY')
    if role == 'download':
        return (CURL, '--disable', '--proto', '=https', '--fail', '--silent', '--show-error',
                '--max-time', '20', '--connect-timeout', '10', '--retry', '0', '--max-filesize', '1048576', URL)
    need(role == 'verification', 'SIGNED_FIXED_ROLE')
    return (GPGV, '--homedir', directory + '/gnupg', '--keyring', keyring,
            '--status-fd', '2', '--output', '-', directory + '/InRelease')


def fixed_environment(role, directory, inherited):
    need(role in ('download', 'verification', 'index'), 'SIGNED_FIXED_ROLE')
    env = {'LC_ALL': 'C', 'LANG': 'C', 'TZ': 'UTC',
           'HOME': directory + '/gnupg', 'GNUPGHOME': directory + '/gnupg'}
    if 'PATH' in inherited:
        env['PATH'] = inherited['PATH']  # Absolute executables; never rewrite the existing search path.
    if role in ('download', 'index'):
        env.update({name: inherited[name] for name in TRUST_ENV if name in inherited})
    return env


def status_time(value):
    need(type(value) is bytes and len(value) <= 32, 'SIGNED_SIGNATURE_TIME')
    if re.fullmatch(rb'[0-9]{1,12}', value):
        return int(value)
    text = value.decode('ascii')
    for pattern in ('%Y%m%dT%H%M%S', '%Y-%m-%dT%H:%M:%S'):
        try:
            return int(datetime.datetime.strptime(text.removesuffix('Z'), pattern).replace(tzinfo=datetime.timezone.utc).timestamp())
        except ValueError:
            pass
    raise RuntimeError('SIGNED_SIGNATURE_TIME')


def signature_status(code, status, now):
    """Only gpgv's actual status stream is authoritative, never diagnostic text."""
    need(code == 0 and type(status) is bytes and 0 < len(status) <= 65536 and now >= SNAPSHOT,
         'SIGNED_VERIFIER_RESULT')
    allowed = {b'NEWSIG', b'KEY_CONSIDERED', b'SIG_ID', b'GOODSIG', b'VALIDSIG', b'PLAINTEXT',
               b'PLAINTEXT_LENGTH', b'TRUST_UNDEFINED', b'TRUST_MARGINAL', b'TRUST_FULLY',
               b'TRUST_ULTIMATE', b'VERIFICATION_COMPLIANCE_MODE', b'NOTATION_NAME',
               b'NOTATION_DATA', b'NOTATION_FLAGS', b'POLICY_URL', b'PROGRESS'}
    signatures = []
    for line in status.splitlines():
        if not line.startswith(b'[GNUPG:] '):
            continue
        fields = line[len(b'[GNUPG:] '):].split()
        need(fields and fields[0] in allowed, 'SIGNED_REJECTED_STATUS')
        if fields[0] != b'VALIDSIG':
            continue
        values = fields[1:]
        need(len(values) in (9, 10) and re.fullmatch(rb'[0-9A-F]{40}', values[0]), 'SIGNED_VALID_STATUS')
        signer = values[0].decode('ascii')
        primary = values[9].decode('ascii') if len(values) == 10 else signer
        need(primary == PRIMARY and re.fullmatch('[0-9A-F]{40}', primary), 'SIGNED_AUTHORIZED_PRIMARY')
        need(re.fullmatch(rb'[0-9]{4}-[0-9]{2}-[0-9]{2}', values[1]), 'SIGNED_SIGNATURE_TIME')
        created, expires = status_time(values[2]), status_time(values[3])
        need(0 < created <= SNAPSHOT <= now and (expires == 0 or expires > now) and
             datetime.datetime.fromtimestamp(created, datetime.timezone.utc).date().isoformat().encode() == values[1],
             'SIGNED_SIGNATURE_TIME')
        need(all(re.fullmatch(rb'[0-9]{1,3}', value) and 0 < int(value) <= 255 for value in (values[4], values[6], values[7])) and
             values[5] == b'0' and re.fullmatch(rb'[0-9A-Fa-f]{2}', values[8]), 'SIGNED_SIGNATURE_ALGORITHM')
        signatures.append({'signer': signer, 'primary': primary, 'created': created, 'expires': expires,
                           'publicKeyAlgorithm': values[6], 'hashAlgorithm': values[7], 'class': values[8]})
    need(signatures, 'SIGNED_MISSING_VALID_SIGNATURE')
    return signatures


def release_metadata(raw, now):
    """Called only on gpgv verified stdout after accepted actual exit/status."""
    need(type(raw) is bytes and 0 < len(raw) <= 1048576 and now >= SNAPSHOT, 'SIGNED_RELEASE_BOUND')
    text = raw.replace(b'\r\n', b'\n')
    need(b'\r' not in text and b'\0' not in text, 'SIGNED_RELEASE_ENCODING')
    fields = {}
    for line in text.decode('ascii').splitlines():
        if not line:
            continue
        if line.startswith((' ', '\t')):
            continue
        name, separator, value = line.partition(':')
        need(separator and re.fullmatch('[A-Za-z][A-Za-z0-9-]*', name) and name not in fields, 'SIGNED_RELEASE_FIELDS')
        fields[name] = value.strip()
    need(all(fields.get(name) == value for name, value in
             (('Origin', 'Ubuntu'), ('Label', 'Ubuntu'), ('Suite', 'noble'), ('Codename', 'noble'))), 'SIGNED_RELEASE_IDENTITY')
    need('amd64' in fields.get('Architectures', '').split() and 'main' in fields.get('Components', '').split(),
         'SIGNED_RELEASE_SELECTION')
    date = email.utils.parsedate_to_datetime(fields.get('Date', ''))
    need(date is not None and date.utcoffset() == datetime.timedelta(0) and
         0 < date.timestamp() <= SNAPSHOT <= now, 'SIGNED_RELEASE_DATE')
    expiry = 'not-declared'
    if 'Valid-Until' in fields:
        until = email.utils.parsedate_to_datetime(fields['Valid-Until'])
        need(until is not None and until.utcoffset() == datetime.timedelta(0) and
             until.timestamp() > date.timestamp() and now < until.timestamp(), 'SIGNED_RELEASE_EXPIRY')
        expiry = 'present-valid'
    return {'expiry': expiry, 'date': date.timestamp()}


def checked_index_entry(entry):
    need(type(entry) is tuple and len(entry) == 2 and type(entry[0]) is str and
         re.fullmatch('[a-f0-9]{64}', entry[0]) and type(entry[1]) is int and
         0 < entry[1] <= INDEX_COMPRESSED_LIMIT, 'SIGNED_INDEX_ENTRY')
    return entry


def index_entry(verified):
    """Select one exact index only from already verified Release plaintext."""
    need(type(verified) is bytes and 0 < len(verified) <= 1048576, 'SIGNED_INDEX_RELEASE_BOUND')
    raw = verified.replace(b'\r\n', b'\n')
    need(b'\r' not in raw and b'\0' not in raw, 'SIGNED_INDEX_RELEASE_ENCODING')
    fields, section, matches = set(), None, []
    for line in raw.decode('ascii').splitlines():
        if not line:
            continue
        if line.startswith((' ', '\t')):
            need(section is not None, 'SIGNED_INDEX_RELEASE_FIELD')
            if section == 'sha256':
                values = line.split()
                need(len(values) == 3 and re.fullmatch('[a-fA-F0-9]{64}', values[0]) and
                     re.fullmatch('[0-9]{1,12}', values[1]), 'SIGNED_INDEX_CHECKSUM_ROW')
                if values[2] == INDEX_PATH:
                    matches.append((values[0].lower(), int(values[1])))
            continue
        name, separator, value = line.partition(':')
        need(separator and re.fullmatch('[A-Za-z][A-Za-z0-9-]*', name) and name.lower() not in fields,
             'SIGNED_INDEX_RELEASE_FIELD')
        section = name.lower()
        fields.add(section)
        need(section != 'sha256' or not value.strip(), 'SIGNED_INDEX_CHECKSUM_HEADER')
    need(len(matches) == 1, 'SIGNED_INDEX_MISSING_OR_AMBIGUOUS')
    return checked_index_entry(matches[0])


def authenticate_index(raw, entry):
    digest, size = checked_index_entry(entry)
    need(type(raw) is bytes and len(raw) == size, 'SIGNED_INDEX_SIZE')
    need(hashlib.sha256(raw).hexdigest() == digest, 'SIGNED_INDEX_HASH')


def decompress_index(raw, gate, output_limit=INDEX_TEXT_LIMIT, memory_limit=INDEX_DECODER_MEMORY):
    need(type(raw) is bytes and 0 < len(raw) <= INDEX_COMPRESSED_LIMIT and
         type(output_limit) is int and 0 < output_limit <= INDEX_TEXT_LIMIT and
         type(memory_limit) is int and 0 < memory_limit <= INDEX_DECODER_MEMORY, 'SIGNED_INDEX_DECODE_BOUND')
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=memory_limit)
    parts, total, offset = [], 0, 0
    while not decoder.eof:
        gate()
        if decoder.needs_input:
            need(offset < len(raw), 'SIGNED_INDEX_TRUNCATED')
            chunk = raw[offset:offset + 65536]
            offset += len(chunk)
        else:
            chunk = b''
        part = decoder.decompress(chunk, max_length=min(65536, output_limit - total + 1))
        total += len(part)
        need(total <= output_limit, 'SIGNED_INDEX_TEXT_BOUND')
        parts.append(part)
        gate()
    need(not decoder.unused_data and offset == len(raw), 'SIGNED_INDEX_TRAILING_DATA')
    need(total > 0, 'SIGNED_INDEX_EMPTY')
    return b''.join(parts)


def validate_package_record(fields):
    required = ('package', 'architecture', 'version', 'size', 'sha256', 'filename')
    need(all(type(fields.get(name)) is str and fields[name].isascii() for name in required), 'SIGNED_PACKAGE_FIELDS')
    need(fields['package'] == 'x11-utils' and fields['architecture'] == 'amd64', 'SIGNED_PACKAGE_IDENTITY')
    need(re.fullmatch('[0-9][0-9A-Za-z.+:~_-]{0,127}', fields['version']) and
         re.fullmatch('[0-9]{1,12}', fields['size']) and int(fields['size']) > 0 and
         re.fullmatch('[a-fA-F0-9]{64}', fields['sha256']), 'SIGNED_PACKAGE_VALUES')
    filename = fields['filename']
    need(re.fullmatch(r'pool/main/x/x11-utils/x11-utils_[A-Za-z0-9.+~_-]{1,160}_amd64[.]deb', filename) and
         '..' not in filename.split('/'), 'SIGNED_PACKAGE_FILENAME')
    return {'version': fields['version'], 'architecture': fields['architecture'], 'size': int(fields['size']),
            'sha256': fields['sha256'].lower(), 'filename': filename}


def package_record(raw, gate):
    need(type(raw) is bytes and 0 < len(raw) <= INDEX_TEXT_LIMIT, 'SIGNED_PACKAGE_TEXT_BOUND')
    raw = raw.replace(b'\r\n', b'\n')
    need(b'\r' not in raw and b'\0' not in raw, 'SIGNED_PACKAGE_ENCODING')
    matches = []
    for paragraph in raw.decode('utf-8').split('\n\n'):
        gate()
        if not paragraph.strip():
            continue
        fields, continued, previous = {}, set(), None
        for line in paragraph.strip('\n').split('\n'):
            if line.startswith((' ', '\t')):
                need(previous is not None, 'SIGNED_PACKAGE_CONTINUATION')
                continued.add(previous)
                continue
            name, separator, value = line.partition(':')
            need(separator and re.fullmatch('[A-Za-z0-9][A-Za-z0-9-]*', name) and name.lower() not in fields,
                 'SIGNED_PACKAGE_DUPLICATE_OR_MALFORMED_FIELD')
            previous = name.lower()
            fields[previous] = value.strip()
        if fields.get('package') == 'x11-utils':
            need('package' not in continued and 'architecture' in fields and 'architecture' not in continued,
                 'SIGNED_PACKAGE_FIELDS')
            if fields['architecture'] == 'amd64':
                need(not continued.intersection(('version', 'size', 'sha256', 'filename')), 'SIGNED_PACKAGE_REQUIRED_CONTINUATION')
                matches.append(validate_package_record(fields))
    need(len(matches) == 1, 'SIGNED_PACKAGE_MISSING_OR_AMBIGUOUS')
    return matches[0]


class Probe:
    def __init__(self, started, include_index=False):
        need(type(include_index) is bool, 'SIGNED_INDEX_MODE')
        self.include_index = include_index
        self.started, self.until = started, started + 70
        self.fds, self.children, self.returned, self.secondary = [], [], [], []
        self.first_set, self.first, self.frozen = False, None, False
        self.phase = 'binding'
        self.preflight_reasons = {}
        self.diagnostic = None

    def fail(self, error):
        self.frozen = True
        if not self.first_set:
            self.first_set, self.first = True, error
        else:
            self.secondary.append(error)

    def gate(self):
        need(not self.frozen and self.started <= time.monotonic() < self.until, 'SIGNED_DEADLINE')

    def capture(self, value):
        self.returned.append(value)
        self.gate()
        return value

    def opened(self, file, flags, mode=0o600):
        self.gate()
        owner = {'path': file, 'issued': True, 'returned': False, 'fd': None, 'close_issued': False, 'closed': False}
        self.fds.append(owner)
        fd = os.open(file, flags | os.O_CLOEXEC, mode)
        owner['fd'], owner['returned'] = fd, True
        self.capture(fd)
        return owner

    def closed(self, owner):
        need(not owner['close_issued'], 'SIGNED_CLOSE_ONCE')
        owner['close_issued'] = True
        value = os.close(owner['fd'])
        owner['closed'] = True
        self.capture(value)

    def parents(self, directory, uid):
        current = pathlib.Path('/')
        for part in pathlib.Path(directory).parts[1:]:
            current = current / part
            info = self.capture(os.lstat(current))
            need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid) and not info.st_mode & 0o7022 and
                 os.path.realpath(current) == str(current), 'SIGNED_PARENT')

    def read(self, file, cap, uid):
        self.parents(str(pathlib.Path(file).parent), os.getuid())
        before = self.capture(os.lstat(file))
        need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and
             0 < before.st_size <= cap and not before.st_mode & 0o7022 and os.path.realpath(file) == file, 'SIGNED_INPUT')
        owner = self.opened(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        need(identity(os.fstat(owner['fd'])) == identity(before), 'SIGNED_INPUT_CHANGED')
        parts, count = [], 0
        while True:
            part = self.capture(os.read(owner['fd'], min(65536, before.st_size - count + 1)))
            if not part:
                break
            parts.append(part)
            count += len(part)
            need(count <= before.st_size, 'SIGNED_INPUT_BOUND')
        need(count == before.st_size and identity(os.fstat(owner['fd'])) == identity(before) and
             identity(os.lstat(file)) == identity(before), 'SIGNED_INPUT_CHANGED')
        self.closed(owner)
        return b''.join(parts)

    def preflight_metadata(self, file, executable):
        need(file in (CURL, GPGV, KEYRING, CANDIDATE_PATHS[-1][1]), 'SIGNED_FIXED_INPUT')
        try:
            before = self.capture(os.lstat(file))
        except OSError as error:
            self.returned.append(error)
            reason = preflight_stat_reason(error)
            self.preflight_reasons[file] = reason
            return None, reason
        reason = preflight_attribute_reason(before)
        if reason == 'attributes-ok' and os.path.realpath(file) != file:
            reason = 'noncanonical'
        if reason == 'attributes-ok' and executable and not os.access(file, os.X_OK):
            reason = 'not-executable'
        self.preflight_reasons[file] = reason
        return before, reason

    def preflight(self, file, executable):
        before, reason = self.preflight_metadata(file, executable)
        if reason != 'attributes-ok':
            return None
        raw = self.read(file, 16 * 1024 ** 2, 0)  # Any issued-FD/read/close failure propagates, never becomes absence.
        need(identity(os.lstat(file)) == identity(before), 'SIGNED_PREFLIGHT_CHANGED')
        return identity(before), hashlib.sha256(raw).hexdigest()

    def pin(self, file, cap, uid):
        before = self.capture(os.lstat(file))
        raw = self.read(file, cap, uid)
        after = self.capture(os.lstat(file))
        need(identity(before) == identity(after), 'SIGNED_PIN_CHANGED')
        value = {'raw': raw, 'identity': identity(after)}
        self.returned.append(value)
        return value

    def write_private(self, file, raw, cap=1048576):
        need(type(cap) is int and cap in (1048576, INDEX_COMPRESSED_LIMIT) and type(raw) is bytes and 0 < len(raw) <= cap, 'SIGNED_PRIVATE_BOUND')
        owner = self.opened(file, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
        at = 0
        while at < len(raw):
            count = self.capture(os.write(owner['fd'], raw[at:]))
            need(type(count) is int and 0 < count <= len(raw) - at, 'SIGNED_PRIVATE_WRITE')
            at += count
        self.capture(os.fsync(owner['fd']))
        need(self.capture(os.pread(owner['fd'], len(raw) + 1, 0)) == raw, 'SIGNED_PRIVATE_READBACK')
        self.closed(owner)
        actual = self.read(file, cap, os.getuid())
        need(actual == raw, 'SIGNED_PRIVATE_CHANGED')

    def run(self, role, directory, inherited, keyring=KEYRING, entry=None):
        self.gate()
        roles = ('download', 'verification', 'index') if self.include_index else ('download', 'verification')
        need(len(self.children) < len(roles) and role == roles[len(self.children)], 'SIGNED_ROLE_ORDER')
        argv = fixed_command(role, directory, keyring, entry)
        stdout_cap = entry[1] if role == 'index' else 1048576
        child = {'role': role, 'issued': False, 'returned': False, 'object': None, 'exit': None,
                 'pipes': {}, 'stdout': bytearray(), 'stderr': bytearray(), 'soft_expired': False}
        self.children.append(child)
        logs = {name: self.opened(directory + '/' + role + '-' + name + '.bin', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
                for name in ('stdout', 'stderr')}
        started = time.monotonic()
        child['issued'] = True
        actual = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=fixed_environment(role, directory, inherited), close_fds=True)
        child['object'], child['returned'] = actual, True
        self.returned.append(actual)
        for name in ('stdout', 'stderr'):
            child['pipes'][name] = {'object': getattr(actual, name), 'eof': False, 'close_issued': False, 'closed': False}
        self.gate()
        for pipe in child['pipes'].values():
            os.set_blocking(pipe['object'].fileno(), False)
            self.gate()
        while not (child['exit'] is not None and all(pipe['eof'] for pipe in child['pipes'].values())):
            self.gate()
            child['soft_expired'] |= time.monotonic() - started >= 20
            if child['exit'] is None:
                child['exit'] = actual.poll()
                self.capture(child['exit'])
            readable = {pipe['object'].fileno(): (name, pipe) for name, pipe in child['pipes'].items() if not pipe['eof']}
            ready, _, _ = select.select(list(readable), [], [], 0.05)
            self.gate()
            for fd in ready:
                name, pipe = readable[fd]
                try:
                    part = os.read(fd, 4096)
                except OSError as error:
                    if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        continue
                    raise
                self.returned.append(part)
                if not part:
                    pipe['eof'] = True
                self.gate()
                if not part:
                    continue
                need(len(child[name]) + len(part) <= (stdout_cap if name == 'stdout' else 65536), 'SIGNED_STREAM_BOUND')
                child[name].extend(part)
                at = 0
                while at < len(part):
                    count = self.capture(os.write(logs[name]['fd'], part[at:]))
                    need(type(count) is int and 0 < count <= len(part) - at, 'SIGNED_LOG_WRITE')
                    at += count
        for name, pipe in child['pipes'].items():
            pipe['close_issued'] = True
            value = pipe['object'].close()
            pipe['closed'] = True
            self.capture(value)
            need(self.capture(os.pread(logs[name]['fd'], (stdout_cap if name == 'stdout' else 65536) + 1, 0)) == bytes(child[name]), 'SIGNED_LOG_READBACK')
            self.capture(os.fsync(logs[name]['fd']))
            self.closed(logs[name])
        child['soft_expired'] |= time.monotonic() - started >= 20
        need(not child['soft_expired'] and child['exit'] == 0, 'SIGNED_CHILD_NONPASS')
        return bytes(child['stdout']), bytes(child['stderr'])

    def publish(self, file, temporary, uid, values):
        base = {'verifier', 'anchor', 'anchor_reason', 'signature', 'metadata', 'signer', 'inrelease_sha256', 'expiry'}
        index_fields = {'index_sha256', 'index_size', 'package_version', 'package_architecture',
                        'package_size', 'package_sha256', 'package_filename'}
        need(set(values) in (base, base | index_fields) and
             values['verifier'] in ('established', 'unavailable') and values['anchor'] in ('established', 'unavailable') and
             values['anchor_reason'] in PREFLIGHT_REASONS + CANDIDATE_REASONS and
             values['signature'] in ('verified', 'not-verified') and values['metadata'] in ('verified', 'not-verified') and
             values['signer'] in (PRIMARY, 'unavailable') and values['expiry'] in ('present-valid', 'not-declared', 'unavailable') and
             (values['inrelease_sha256'] == 'unavailable' or re.fullmatch('[a-f0-9]{64}', values['inrelease_sha256'])), 'SIGNED_PUBLIC_ENUMS')
        if index_fields.issubset(values):
            need(values['signature'] == values['metadata'] == 'verified' and values['signer'] == PRIMARY and
                 re.fullmatch('[0-9]{1,8}', values['index_size']), 'SIGNED_INDEX_PUBLIC_VALUES')
            checked_index_entry((values['index_sha256'], int(values['index_size'])))
            validate_package_record({'package': 'x11-utils', 'architecture': values['package_architecture'],
                'version': values['package_version'], 'size': values['package_size'], 'sha256': values['package_sha256'],
                'filename': values['package_filename']})
        raw = ''.join(key + '=' + value + '\n' for key, value in values.items()).encode('ascii')
        self._append_managed(file, temporary, uid, raw)

    def _append_managed(self, file, temporary, uid, raw):
        self.gate()
        need(type(raw) is bytes and 0 < len(raw) <= 4096, 'SIGNED_MANAGED_BOUND')
        need(temporary.startswith('/') and file.startswith(temporary + '/') and os.path.realpath(file) == file, 'SIGNED_MANAGED_PATH')
        self.parents(str(pathlib.Path(file).parent), uid)
        before = self.capture(os.lstat(file))
        need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and
             before.st_size <= 1048576 and not before.st_mode & 0o7022, 'SIGNED_MANAGED_FILE')
        owner = self.opened(file, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
        need(identity(os.fstat(owner['fd'])) == identity(before), 'SIGNED_MANAGED_CHANGED')
        at = 0
        while at < len(raw):
            count = self.capture(os.write(owner['fd'], raw[at:]))
            need(type(count) is int and 0 < count <= len(raw) - at, 'SIGNED_MANAGED_WRITE')
            at += count
        self.capture(os.fsync(owner['fd']))
        after = self.capture(os.fstat(owner['fd']))
        need((after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_nlink) ==
             (before.st_dev, before.st_ino, before.st_uid, before.st_mode, before.st_nlink) and
             after.st_size == before.st_size + len(raw) and identity(os.lstat(file)) == identity(after), 'SIGNED_MANAGED_CHANGED')
        self.closed(owner)

    def publish_failure_stage(self, file, temporary, uid):
        # Independent, single-use diagnostic custody shares the original deadline.
        # The failed owner stays frozen; this channel can publish no trust result.
        need(self.first_set and self.frozen and self.diagnostic is None, 'SIGNED_DIAGNOSTIC_CONTEXT')
        self.diagnostic = type(self)(self.started)
        try:
            raw = ('failure_stage=' + safe_stage(self.phase) + '\n').encode('ascii')
            self.diagnostic._append_managed(file, temporary, uid, raw)
            self.diagnostic.gate()
            need(not self.diagnostic.unknown(), 'SIGNED_DIAGNOSTIC_RETAINED')
        except BaseException as error:
            self.diagnostic.fail(error)
            raise

    def unknown(self):
        return (any(not owner['returned'] or not owner['closed'] for owner in self.fds) or
                any(child['issued'] and (not child['returned'] or child['exit'] is None or len(child['pipes']) != 2 or
                    any(not pipe['closed'] for pipe in child['pipes'].values())) for child in self.children) or
                (self.diagnostic is not None and self.diagnostic.unknown()))


def main(args):
    index_reporting = args == ['--authenticate-x11-index-report']
    index_authentication = args == ['--authenticate-x11-index'] or index_reporting
    probe = Probe(time.monotonic(), include_index=index_authentication)
    CURRENT.append(probe)
    classification = args == ['--classify-keyring']
    candidate = args == ['--preflight-ubuntu-archive-input']
    candidate_verification = args == ['--verify-ubuntu-archive-input'] or index_authentication
    need((not args or classification or candidate or candidate_verification) and sys.platform == 'linux', 'SIGNED_ARGUMENT')
    expected_ref = (INDEX_REPORT_BRANCH if index_reporting else INDEX_BRANCH if index_authentication else VERIFICATION_BRANCH if candidate_verification else CANDIDATE_BRANCH if candidate
                    else CLASSIFICATION_BRANCH if classification else BRANCH)
    uid = os.getuid()
    need(uid > 0 and uid == os.geteuid() and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and
         os.environ.get('GITHUB_REF') == expected_ref and os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
         os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
         os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64' and
         re.fullmatch('[1-9][0-9]{0,31}', os.environ.get('GITHUB_RUN_ID', '')), 'SIGNED_CONTEXT')
    source = str(pathlib.Path(__file__).resolve().parents[1])
    need(source == os.environ.get('GITHUB_WORKSPACE'), 'SIGNED_SOURCE')
    head = probe.pin(source + '/.git/HEAD', 256, uid)
    commit = head['raw'].decode('ascii').strip()
    need(re.fullmatch('[a-f0-9]{40}', commit) and commit == os.environ.get('GITHUB_SHA'), 'SIGNED_HEAD')
    own_file = source + '/scripts/linux-ubuntu-signed-metadata.py'
    own = probe.pin(own_file, 1024 * 1024, uid)
    event = json.loads(probe.read(os.environ.get('GITHUB_EVENT_PATH', ''), 2 * 1024 ** 2, uid))
    need(event['repository']['full_name'] == REPOSITORY and event['repository']['private'] is False and
         event['after'] == commit and event['ref'] == expected_ref, 'SIGNED_PUBLIC_SOURCE')
    values = {'verifier': 'unavailable', 'anchor': 'unavailable', 'anchor_reason': 'not-reported', 'signature': 'not-verified',
              'metadata': 'not-verified', 'signer': 'unavailable', 'inrelease_sha256': 'unavailable', 'expiry': 'unavailable'}
    probe.phase = 'preflight'
    if candidate:
        values['anchor_reason'] = candidate_metadata(probe, uid)
        probe.phase = 'readback'
        need(probe.pin(source + '/.git/HEAD', 256, uid) == head and probe.pin(own_file, 1024 * 1024, uid) == own,
             'SIGNED_SOURCE_CHANGED')
        probe.phase = 'output'
        probe.publish(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
        probe.gate()
        need(not probe.unknown(), 'SIGNED_RETAINED')
        print(json.dumps({'anchor_reason': values['anchor_reason'], 'scope': 'candidate-attributes-only'}, sort_keys=True))
        need(values['anchor_reason'] == 'input-all-attributes-ok', 'SIGNED_CANDIDATE_REFUSED')
        return
    if classification:
        _, values['anchor_reason'] = probe.preflight_metadata(KEYRING, False)
        # Attribute eligibility is not a stable-read/content/signature trust result.
        probe.phase = 'readback'
        need(probe.pin(source + '/.git/HEAD', 256, uid) == head and probe.pin(own_file, 1024 * 1024, uid) == own,
             'SIGNED_SOURCE_CHANGED')
        probe.phase = 'output'
        probe.publish(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
        probe.gate()
        need(not probe.unknown(), 'SIGNED_RETAINED')
        print(json.dumps({'anchor_reason': values['anchor_reason'], 'scope': 'attributes-only'}, sort_keys=True))
        return
    selected_keyring = CANDIDATE_PATHS[-1][1] if candidate_verification else KEYRING
    if candidate_verification:
        values['anchor_reason'] = candidate_metadata(probe, uid)
        if values['anchor_reason'] != 'input-all-attributes-ok':
            probe.publish(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
            raise RuntimeError('SIGNED_CANDIDATE_REFUSED')
    originals = {}
    for file in (CURL, GPGV, selected_keyring):
        originals[file] = probe.preflight(file, file != selected_keyring)
        if candidate_verification and originals[file] is None:
            values['verifier'] = 'established' if originals.get(CURL) is not None and originals.get(GPGV) is not None else 'unavailable'
            values['anchor_reason'] = probe.preflight_reasons.get(selected_keyring, 'not-reported')
            probe.publish(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
            raise RuntimeError('SIGNED_PREREQUISITE_UNAVAILABLE')
    values['verifier'] = 'established' if originals[CURL] is not None and originals[GPGV] is not None else 'unavailable'
    values['anchor'] = 'established' if originals[selected_keyring] is not None else 'unavailable'
    values['anchor_reason'] = probe.preflight_reasons[selected_keyring]
    if any(value is None for value in originals.values()):
        probe.publish(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
        raise RuntimeError('SIGNED_PREREQUISITE_UNAVAILABLE')
    if all(value is not None for value in originals.values()):
        temporary = os.environ.get('RUNNER_TEMP', '')
        need(temporary.startswith('/') and os.path.realpath(temporary) == temporary, 'SIGNED_SCRATCH')
        probe.parents(temporary, uid)
        directory = temporary + '/hub-ubuntu-signed-' + os.environ['GITHUB_RUN_ID'] + '-attempt-1'
        probe.capture(os.mkdir(directory, 0o700))
        probe.capture(os.mkdir(directory + '/gnupg', 0o700))
        need(probe.capture(os.listdir(directory + '/gnupg')) == [], 'SIGNED_EMPTY_HOME')
        probe.phase = 'download'
        signed, _ = probe.run('download', directory, os.environ)
        probe.write_private(directory + '/InRelease', signed)
        signed_before = probe.pin(directory + '/InRelease', 1048576, uid)
        need(signed_before['raw'] == signed, 'SIGNED_DOWNLOAD_CHANGED')
        need(probe.capture(os.listdir(directory + '/gnupg')) == [], 'SIGNED_EMPTY_HOME')
        probe.phase = 'verification'
        verified, status = probe.run('verification', directory, os.environ, selected_keyring)
        now = time.time()
        signatures = signature_status(probe.children[-1]['exit'], status, now)
        probe.returned.append(signatures)
        metadata = release_metadata(verified, now)  # Never parse unsigned body directly.
        probe.returned.append(metadata)
        probe.gate()
        index_values = None
        if index_authentication:
            need(hashlib.sha256(signed_before['raw']).hexdigest() == INDEX_INRELEASE_SHA256, 'SIGNED_INDEX_INRELEASE_PIN')
            entry = index_entry(verified)
            probe.phase = 'index-download'
            compressed, _ = probe.run('index', directory, os.environ, selected_keyring, entry)
            authenticate_index(compressed, entry)
            probe.write_private(directory + '/Packages.xz', compressed, INDEX_COMPRESSED_LIMIT)
            index_before = probe.pin(directory + '/Packages.xz', INDEX_COMPRESSED_LIMIT, uid)
            need(index_before['raw'] == compressed, 'SIGNED_INDEX_CHANGED')
            probe.phase = 'index-validation'
            decoded = decompress_index(compressed, probe.gate)
            package = package_record(decoded, probe.gate)
            need(probe.pin(directory + '/Packages.xz', INDEX_COMPRESSED_LIMIT, uid) == index_before, 'SIGNED_INDEX_CHANGED')
            index_values = {'index_sha256': entry[0], 'index_size': str(entry[1]), 'package_version': package['version'],
                'package_architecture': package['architecture'], 'package_size': str(package['size']),
                'package_sha256': package['sha256'], 'package_filename': package['filename']}
        probe.phase = 'readback'
        need(probe.pin(directory + '/InRelease', 1048576, uid) == signed_before, 'SIGNED_DOWNLOAD_CHANGED')
        for file, original in originals.items():
            need(probe.preflight(file, file != selected_keyring) == original, 'SIGNED_ANCHOR_OR_TOOL_CHANGED')
        if candidate_verification:
            need(candidate_metadata(probe, uid) == 'input-all-attributes-ok', 'SIGNED_CANDIDATE_CHANGED')
        values.update(signature='verified', metadata='verified', signer=PRIMARY,
                      inrelease_sha256=hashlib.sha256(signed_before['raw']).hexdigest(), expiry=metadata['expiry'])
        if index_values is not None:
            values.update(index_values)
    probe.phase = 'readback'
    need(probe.pin(source + '/.git/HEAD', 256, uid) == head and probe.pin(own_file, 1024 * 1024, uid) == own,
         'SIGNED_SOURCE_CHANGED')
    probe.phase = 'output'
    probe.publish(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), uid, values)
    probe.gate()
    need(not probe.unknown(), 'SIGNED_RETAINED')
    print(json.dumps(values, sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        probe = CURRENT[0] if CURRENT else None
        if probe is not None:
            probe.fail(error)
        if probe is not None and sys.argv[1:] == ['--authenticate-x11-index-report']:
            try:
                probe.publish_failure_stage(os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', ''), os.getuid())
            except BaseException as report_error:
                probe.secondary.append(report_error)
        try:
            print('::error title=Ubuntu signed metadata::Fixed observation unavailable at ' +
                  safe_stage(probe.phase if probe is not None else None) + '; uncertain custody retained.')
        except BaseException as report_error:
            if probe is not None:
                probe.secondary.append(report_error)
        while probe is not None and probe.unknown():
            try:
                time.sleep(0.5)
            except BaseException as waiting_error:
                probe.secondary.append(waiting_error)
        raise SystemExit(1)
