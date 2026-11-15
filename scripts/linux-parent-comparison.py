"""Five fixed parent snapshots only. No traversal after either policy refuses."""
import hashlib
import os
import pathlib
import re
import stat
import sys
import time
import types

BRANCH = 'refs/heads/ci/v060-linux-parent-comparison-20261115'
CLASSIFIER_SHA = 'aafd058da58f4798112928010e74f7dd96f627efbadfe09d7608a789203060cb'
TARGETS = (('share', 'usr', 'share'), ('doc', 'share', 'doc'), ('man', 'share', 'man'),
           ('man1', 'man', 'man1'), ('menu', 'share', 'menu'))
TOKENS = {'yes', 'no', 'unknown', 'directory', 'symlink', 'other', 'root', 'runner',
          'non-root', 'non-root-runner-unknown', 'pass', 'refuse'}
STAGES = ('context', 'binding', 'bootstrap', 'share', 'doc', 'man', 'man1', 'menu', 'identity', 'close', 'complete')
REASONS = ('none', 'context', 'binding', 'ancestor-refused', 'changed', 'binding-unavailable',
           'access', 'bound', 'custody', 'unexpected')


class Refused(Exception):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid',
        'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def both_pass(row):
    return (row['production_parent_predicate'] == 'pass' and
            row['preflight579_parent_predicate'] == 'pass')


def unknown(classify, uid, state):
    return {'state': state, 'attributes': classify({'present': None, 'mode': None,
        'uid': None, 'gid': None, 'inode': None, 'canonical': None, 'runner_uid': uid})}


def attributes(classify, info, uid, canonical):
    return classify({'present': True, 'mode': info.st_mode, 'uid': info.st_uid,
        'gid': info.st_gid, 'inode': info.st_ino, 'canonical': canonical, 'runner_uid': uid})


def verify_frames(io, frames):
    for frame in frames.values():
        try:
            owner = frame['owner']
            expected = identity(frame['snapshot'])
            need(identity(io.fstat(owner)) == expected, 'changed')
            # Parent-name binding matters: fstat of a detached FD alone is insufficient.
            actual = io.root_stat() if frame['parent'] is None else \
                io.entry(frame['parent']['owner'], frame['name'])
            need(identity(actual) == expected, 'changed')
        except OSError as error:
            if io.first is None:
                io.first = error
            raise Refused('binding-unavailable') from None


def open_frame(io, parent, name, snapshot, row):
    need(both_pass(row), 'ancestor-refused')
    owner = io.open_directory(parent['owner'] if parent else None, name)
    frame = {'owner': owner, 'parent': parent, 'name': name, 'snapshot': snapshot}
    need(identity(io.fstat(owner)) == identity(snapshot), 'changed')
    actual = io.root_stat() if parent is None else io.entry(parent['owner'], name)
    need(identity(actual) == identity(snapshot), 'changed')
    return frame


def collect(io, classify, report):
    uid = io.uid
    frames = {}
    report['stage'] = 'bootstrap'
    root = io.root_stat()
    root_row = attributes(classify, root, uid, True)
    need(both_pass(root_row), 'ancestor-refused')
    frames['root'] = open_frame(io, None, '/', root, root_row)
    verify_frames(io, frames)
    usr = io.entry(frames['root']['owner'], 'usr')
    usr_row = attributes(classify, usr, uid, None if stat.S_ISLNK(usr.st_mode) else True)
    need(both_pass(usr_row), 'ancestor-refused')
    frames['usr'] = open_frame(io, frames['root'], 'usr', usr, usr_row)
    verify_frames(io, frames)
    report['bootstrap'] = 'both-policies-pass'
    for key, parent_key, component in TARGETS:
        report['stage'] = key
        if parent_key not in frames:
            report['rows'][key] = unknown(classify, uid, 'blocked-ancestor')
            continue
        verify_frames(io, frames)
        parent = frames[parent_key]
        try:
            before = io.entry(parent['owner'], component)
        except FileNotFoundError:
            value = classify({'present': False, 'mode': None, 'uid': None, 'gid': None,
                'inode': None, 'canonical': None, 'runner_uid': uid})
            report['rows'][key] = {'state': 'missing', 'attributes': value}
            continue
        # Only one fixed component is inspected, never followed. Canonical equivalence
        # remains provisional until the full retained ancestry is revalidated below.
        canonical = None if stat.S_ISLNK(before.st_mode) else True
        value = attributes(classify, before, uid, canonical)
        after = io.entry(parent['owner'], component)
        need(identity(before) == identity(after), 'changed')
        verify_frames(io, frames)
        report['rows'][key] = {'state': 'observed', 'attributes': value}
        if key in ('share', 'man') and both_pass(value):
            frames[key] = open_frame(io, parent, component, before, value)
    report['stage'] = 'identity'
    verify_frames(io, frames)
    io.gate()  # A late final stat is not admitted as an on-budget completion.
    report.update(result='comparison-complete', stage='complete', reason='none')


def row_text(row):
    need(type(row) is dict and row['state'] in ('unobserved', 'observed', 'missing', 'blocked-ancestor', 'changed', 'unverified'), 'binding')
    value = row['attributes']
    keys = ('present', 'kind', 'owner', 'group', 'inode_positive', 'special_mode_bits',
            'group_write', 'other_write', 'canonical', 'production_parent_predicate', 'preflight579_parent_predicate')
    need(all(type(value[k]) is str and value[k] in TOKENS for k in keys), 'binding')
    need(value['native_qualification'] is False and value['provisioning_authorized'] is False, 'binding')
    short = ('present', 'kind', 'owner', 'group', 'inode', 'special', 'groupwrite', 'otherwrite', 'canonical', 'production', 'preflight579')
    text = 'state=' + row['state'] + ' ' + ' '.join(a + '=' + value[b] for a, b in zip(short, keys))
    need(len(text) <= 360 and re.fullmatch('[a-z0-9 =-]+', text), 'binding')
    return text


def encode(report):
    need(report['result'] in ('incomplete', 'comparison-complete') and report['stage'] in STAGES and
         report['reason'] in REASONS and report['bootstrap'] in ('not-checked', 'both-policies-pass', 'invalidated') and
         report['dirs'] in ('closed', 'unknown'), 'binding')
    rows = ['summary=result=' + report['result'] + ' stage=' + report['stage'] + ' reason=' + report['reason'] +
            ' bootstrap=' + report['bootstrap'] + ' dirs=' + report['dirs'] + ' native=false provisioning=false']
    rows += [key + '=' + row_text(report['rows'][key]) for key, _, _ in TARGETS]
    raw = ('\n'.join(rows) + '\n').encode('ascii')
    need(len(raw) <= 4096, 'bound')
    return raw


def run_comparison(host, classify):
    report = {'result': 'incomplete', 'stage': 'bootstrap', 'reason': 'unexpected',
              'bootstrap': 'not-checked', 'dirs': 'unknown',
              'rows': {key: unknown(classify, host.uid, 'unobserved') for key, _, _ in TARGETS}}
    try:
        collect(host, classify, report)
    except BaseException as error:
        if host.first is None:
            host.first = error
        report['result'] = 'incomplete'
        report['reason'] = str(error) if type(error) is Refused and str(error) in REASONS else \
            'access' if isinstance(error, OSError) else 'unexpected'
        # Any interrupted collection lacks the final full-chain check. Preserve
        # its actual reason privately/publicly, but never publish provisional passes.
        report['bootstrap'] = 'invalidated'
        state = 'changed' if report['reason'] == 'changed' else 'unverified'
        report['rows'] = {key: unknown(classify, host.uid, state) for key, _, _ in TARGETS}
    closed = host.close_directories()
    report['dirs'] = 'closed' if closed else 'unknown'
    if not closed:
        if report['result'] == 'comparison-complete':
            report['reason'] = 'custody'
        report['result'] = 'incomplete'
    return report, closed


class Host:
    def __init__(self):
        self.uid = os.getuid()
        self.started = time.monotonic()
        self.calls = 0
        self.owners = []
        self.first = None
        self.output_owner = None

    def owned(self, owner):
        return any(owner is item for item in self.owners)

    def gate(self):
        self.calls += 1
        need(self.calls <= 160 and 0 <= time.monotonic() - self.started < 25, 'bound')

    def root_stat(self):
        self.gate()
        return os.stat('/', follow_symlinks=False)

    def entry(self, owner, name):
        self.gate()
        need(name in ('usr', 'share', 'doc', 'man', 'man1', 'menu') and '/' not in name and
             self.owned(owner) and owner['returned'] and not owner['closed'], 'binding')
        return os.stat(name, dir_fd=owner['fd'], follow_symlinks=False)

    def open_directory(self, parent, name):
        self.gate()
        need((parent is None and name == '/') or
             (self.owned(parent) and parent['returned'] and not parent['closed'] and
              name in ('usr', 'share', 'man')), 'binding')
        owner = {'issued': True, 'returned': False, 'fd': None, 'close_issued': False, 'closed': False}
        self.owners.append(owner)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(name, flags, dir_fd=parent['fd'] if parent else None)
        owner.update(returned=True, fd=fd)
        return owner

    def fstat(self, owner):
        self.gate()
        need(self.owned(owner) and owner['returned'] and not owner['closed'], 'binding')
        try:
            return os.fstat(owner['fd'])
        except BaseException:
            owner['uncertain'] = True
            raise

    def close_directories(self):
        if any(not o['returned'] or o.get('uncertain', False) for o in self.owners):
            return False
        for owner in reversed(self.owners):
            if owner['closed']:
                continue
            if owner['close_issued']:
                return False
            owner['close_issued'] = True
            try:
                os.close(owner['fd'])
                owner['closed'] = True
            except BaseException as error:
                if self.first is None:
                    self.first = error
                return False
        return True

    def retain(self):
        # No retry, close of uncertain handles, signal or filesystem cleanup.
        while True:
            time.sleep(1)


def publish(host, payload):
    owner = {'issued': False, 'returned': False, 'fd': None, 'close_issued': False, 'closed': False}
    host.output_owner = owner
    failed = False
    try:
        output = os.environ.get('GITHUB_OUTPUT', '')
        temp = os.environ.get('RUNNER_TEMP', '')
        need(temp.startswith('/') and output.startswith(temp + '/') and os.path.realpath(output) == output, 'binding')
        owner['issued'] = True
        fd = os.open(output, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
        owner.update(returned=True, fd=fd)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == host.uid and info.st_nlink == 1, 'binding')
        need(os.write(fd, payload) == len(payload), 'bound')
    except BaseException as error:
        failed = True
        if host.first is None:
            host.first = error
    if owner['returned']:
        owner['close_issued'] = True
        try:
            os.close(owner['fd'])
            owner['closed'] = True
        except BaseException as error:
            failed = True
            if host.first is None:
                host.first = error
    return not failed


def main():
    host = Host()
    report = {'result': 'incomplete', 'stage': 'context', 'reason': 'context',
              'bootstrap': 'not-checked', 'dirs': 'unknown', 'rows': {}}
    classify = None
    closed = False
    try:
        need(len(sys.argv) == 1 and sys.platform == 'linux' and host.uid > 0 and host.uid == os.geteuid() and
             os.uname().machine == 'x86_64' and os.environ.get('GITHUB_REF') == BRANCH and
             os.environ.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub' and
             os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and os.environ.get('GITHUB_EVENT_NAME') == 'push' and
             os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and os.environ.get('RUNNER_OS') == 'Linux' and
             os.environ.get('RUNNER_ARCH') == 'X64' and re.fullmatch('[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')) and
             os.environ.get('GITHUB_WORKFLOW_SHA') == os.environ.get('GITHUB_SHA') and
             not any(k in os.environ for k in ('LD_PRELOAD', 'LD_LIBRARY_PATH')), 'context')
        report['stage'] = 'binding'
        file = pathlib.Path(__file__).resolve().parent / 'linux-parent-classifier.py'
        raw = file.read_bytes()
        need(0 < len(raw) <= 16384 and hashlib.sha256(raw).hexdigest() == CLASSIFIER_SHA, 'binding')
        module = types.ModuleType('_fixed_parent_classifier')
        module.__file__ = str(file)
        exec(compile(raw, str(file), 'exec'), module.__dict__)
        classify = module.classify
        report['rows'] = {key: unknown(classify, host.uid, 'unobserved') for key, _, _ in TARGETS}
        report, closed = run_comparison(host, classify)
    except BaseException as error:
        host.first = error
        report['result'] = 'incomplete'
        report['reason'] = str(error) if type(error) is Refused and str(error) in REASONS else \
            'access' if isinstance(error, OSError) else 'unexpected'
    if classify is None:
        # No classifier means no attributable per-path data. A fixed error contains
        # no exception text/path/environment; passive labels remain not-reported.
        os.write(2, b'Parent comparison incomplete before fixed classifier binding\n')
        return 1
    payload = encode(report)
    published = publish(host, payload)
    if not published:
        os.write(2, b'Parent comparison output incomplete\n')
    output_unknown = host.output_owner['issued'] and not host.output_owner['closed']
    if output_unknown:
        host.retain()
    if not closed:
        host.retain()
    return 0 if published and report['result'] == 'comparison-complete' else 1


if __name__ == '__main__':
    sys.exit(main())
