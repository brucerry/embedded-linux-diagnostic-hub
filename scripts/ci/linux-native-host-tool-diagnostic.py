"""Report only the first rejection from the unchanged public tool guard."""

from hashlib import sha256
import os
from pathlib import Path
import stat
import sys
from types import ModuleType


GUARD_SHA256 = '1c5906f1a692ff0c2b7c1686bd4c40b11a39010cb2b0aca47efba0d9ed74fb33'
TOOLS = (
    ('xvfb', '/usr/bin/Xvfb'),
    ('xauth', '/usr/bin/xauth'),
    ('cc', '/usr/bin/cc'),
    ('readelf', '/usr/bin/readelf'),
    ('ldconfig', '/usr/sbin/ldconfig.real'),
)
TOOL_IDS = frozenset(name for name, _ in TOOLS)
PREDICATES = frozenset({
    'parent-custody', 'parent-access', 'resolve', 'file-access', 'owner', 'file-type',
    'link-count', 'mode', 'owner-exec', 'open', 'descriptor-access', 'opened-identity',
    'header-read', 'header-length', 'elf-format', 'elf-machine', 'mtime', 'close', 'unclassified',
})
UNAVAILABLE = 'refused / none / unavailable'


def load_guard():
    path = Path(__file__).with_name('linux-native-host.py')
    with path.open('rb') as stream:
        source = stream.read(16385)
    if len(source) > 16384 or sha256(source).hexdigest() != GUARD_SHA256:
        raise ValueError('guard identity')
    host = ModuleType('native_host_guard')
    exec(compile(source, path.name, 'exec'), host.__dict__)
    return host


def metadata_predicate(row):
    # This classification runs only after tool() already refused the file.
    if row.st_uid != 0:
        return 'owner'
    if not stat.S_ISREG(row.st_mode):
        return 'file-type'
    if row.st_nlink != 1:
        return 'link-count'
    if row.st_mode & 0o7022:
        return 'mode'
    if not row.st_mode & stat.S_IXUSR:
        return 'owner-exec'
    return 'unclassified'


def header_predicate(header):
    if len(header) != 64:
        return 'header-length'
    if header[:6] != b'\x7fELF\x02\x01':
        return 'elf-format'
    if int.from_bytes(header[18:20], 'little') != 62:
        return 'elf-machine'
    return 'unclassified'


def predicate(host, error):
    trace = error.__traceback__
    while trace is not None and trace.tb_frame.f_code is not host.tool.__code__:
        trace = trace.tb_next
    if trace is None:
        return 'unclassified'

    # Line numbers refer to the hash-bound original tool() body. Its return value,
    # operations and exceptions are untouched. Only fixed categories leave here.
    line = trace.tb_lineno
    if isinstance(error, host.Refused):
        if error.reason == 'custody' and line in (64, 66):
            return 'parent-custody'
        if error.reason != 'tool':
            return 'unclassified'
        if line in (68, 69):
            return metadata_predicate(trace.tb_frame.f_locals['row'])
        if line in (75, 76):
            return header_predicate(trace.tb_frame.f_locals['header'])
        return {73: 'opened-identity', 77: 'mtime'}.get(line, 'unclassified')
    if isinstance(error, OSError):
        return {
            64: 'parent-access', 65: 'resolve', 66: 'parent-access', 67: 'file-access',
            70: 'open', 72: 'descriptor-access', 74: 'header-read',
            77: 'descriptor-access', 79: 'close',
        }.get(line, 'unclassified')
    return 'unclassified'


def first_rejection(host, uid):
    for name, path in TOOLS:
        try:
            host.tool(Path(path), uid)
        except (host.Refused, OSError) as error:
            return name, predicate(host, error)
    return 'none', 'none'


def outcome(tool, reason):
    if tool == 'none' and reason == 'none':
        return 'passed / none / none', 0
    if tool in TOOL_IDS and reason in PREDICATES:
        return f'refused / {tool} / {reason}', 1
    if tool == 'none' and reason in ('guard-integrity', 'runner-identity'):
        return f'refused / none / {reason}', 1
    return UNAVAILABLE, 1


def run_diagnostic():
    uid = os.getuid()
    uname = os.uname()
    if uid <= 0 or uid != os.geteuid() or (uname.sysname, uname.machine) != ('Linux', 'x86_64'):
        return 'none', 'runner-identity'
    try:
        host = load_guard()
    except (OSError, ValueError, SyntaxError):
        return 'none', 'guard-integrity'
    return first_rejection(host, uid)


def main():
    if len(sys.argv) != 2:
        return 1
    try:
        label, code = outcome(*run_diagnostic())
    except Exception:
        label, code = UNAVAILABLE, 1
    try:
        # The only argument is Actions' own output file. No host environment or
        # diagnostics are serialized, and even an output error stays opaque.
        with open(sys.argv[1], 'a', encoding='ascii') as stream:
            stream.write('label=' + label + '\n')
    except (OSError, ValueError):
        return 1
    return code


if __name__ == '__main__':
    raise SystemExit(main())
