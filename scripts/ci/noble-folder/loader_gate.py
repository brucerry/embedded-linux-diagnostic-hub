"""Closed loader observations for the install-only controller. No loader is invoked here."""
from dataclasses import dataclass
from hashlib import sha256
import re
from struct import unpack_from


ALIAS = '/lib64/ld-linux-x86-64.so.2'
LOADER = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
APPLICATION = '/home/ubuntu/.hub-folder-qualification/envelope/app'
ROLE_PATHS = {
    'node': '/home/ubuntu/.hub-folder-qualification/tools/node',
    'installer': APPLICATION + '/diagnostic-hub',
    'addon': APPLICATION + '/resources/diagnostic_hub_rename_noreplace.node',
}
INTERPRETER = (ALIAS + '\0').encode('ascii')
SONAME = r'[A-Za-z0-9_.+-]{1,120}'
ADDRESS = r'\(0x[0-9a-f]{1,16}\)'
FILE = r'/[A-Za-z0-9_./+-]{1,511}'
PIN = r'[a-f0-9]{64}'


def need(condition, label):
    if not condition:
        raise ValueError(label)


@dataclass(frozen=True)
class FilePin:
    size: int
    sha256: str
    mode: int


@dataclass(frozen=True)
class LoaderRead:
    target: FilePin
    elf_header: bytes
    alias_path: str
    loader: FilePin
    cached: bytes
    uncached: bytes
    providers: dict[str, tuple[str, FilePin]]


def elf_interpreter(header, role, size):
    need(type(header) is bytes and 64 <= len(header) <= min(size, 65536)
         and header[:7] == b'\x7fELF\x02\x01\x01', 'elf64-little-endian')
    kind, machine = unpack_from('<HH', header, 16)
    offset = unpack_from('<Q', header, 32)[0]
    entry_bytes, count = unpack_from('<HH', header, 54)
    need(machine == 62 and kind in (2, 3) and (role != 'addon' or kind == 3)
         and entry_bytes == 56 and 0 < count <= 128 and 64 <= offset
         and offset + count * entry_bytes <= len(header), 'elf64-program-table')
    interpreters = []
    for index in range(count):
        ph = offset + index * entry_bytes
        if unpack_from('<I', header, ph)[0] == 3:
            start = unpack_from('<Q', header, ph + 8)[0]
            width = unpack_from('<Q', header, ph + 32)[0]
            need(width == len(INTERPRETER) and start + width <= len(header), 'elf64-interpreter-range')
            interpreters.append(header[start:start + width])
    need(interpreters == ([] if role == 'addon' else [INTERPRETER]), 'elf64-interpreter')


def loader_map(raw):
    need(type(raw) is bytes and 0 < len(raw) <= 32768 and raw.endswith(b'\n'), 'loader-output-bound')
    rows = {}
    for line in raw.decode('ascii', 'strict').splitlines():
        text = line.strip()
        vdso = re.fullmatch(r'linux-vdso\.so\.1\s+' + ADDRESS, text)
        interpreter = re.fullmatch(re.escape(ALIAS) + r'\s+' + ADDRESS, text)
        match = re.fullmatch(r'(' + SONAME + r') => (' + FILE + r')\s+' + ADDRESS, text)
        need(vdso or interpreter or match, 'loader-output-row')
        if vdso:
            name, path = 'linux-vdso.so.1', None
        elif interpreter:
            name, path = 'ld-linux-x86-64.so.2', ALIAS
        else:
            name, path = match.groups()
        need(name not in rows and len(rows) < 192, 'loader-output-roster')
        rows[name] = path
    rows.pop('linux-vdso.so.1', None)
    need(rows.pop('ld-linux-x86-64.so.2', None) in (ALIAS, LOADER), 'loader-output-interpreter')
    need(bool(rows), 'loader-output-empty')
    return rows


def check_pin(pin):
    need(isinstance(pin, FilePin) and type(pin.size) is int and 0 < pin.size <= 256*2**20
         and re.fullmatch(PIN, pin.sha256) and pin.mode in (0o444, 0o555, 0o644, 0o755, 0o700),
         'loader-file-pin')


def verify(role, report, expected_target, expected_loader, expected_providers):
    need(role in ROLE_PATHS and isinstance(report, LoaderRead), 'loader-role')
    for pin in (report.target, report.loader, expected_target, expected_loader):
        check_pin(pin)
    need(report.alias_path == LOADER and report.loader == expected_loader, 'loader-exact-interpreter')
    need(report.target == expected_target, 'loader-exact-attempt-target')
    elf_interpreter(report.elf_header, role, report.target.size)
    cached = loader_map(report.cached)
    uncached = loader_map(report.uncached)
    need(cached.keys() == uncached.keys(), 'loader-cache-disagreement')
    need(cached.keys() == expected_providers.keys() == report.providers.keys(), 'loader-closure-roster')
    for name, (expected_path, pin) in expected_providers.items():
        check_pin(pin)
        allowed = {expected_path}
        if expected_path.startswith('/usr/lib/x86_64-linux-gnu/'):
            allowed |= {expected_path.removeprefix('/usr'), '/usr/lib/x86_64-linux-gnu/'+name,
                        '/lib/x86_64-linux-gnu/'+name}
        else:
            need(expected_path == APPLICATION+'/libffmpeg.so' and name == 'libffmpeg.so',
                 'loader-bundled-provider')
        need(cached[name] in allowed and uncached[name] in allowed and
             report.providers[name] == (expected_path, pin), 'loader-closure-file')
    return sha256(repr(sorted(expected_providers.items())).encode('ascii')).hexdigest()
