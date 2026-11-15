"""Pure diagnostic comparison only; no filesystem reader, CLI or admission authority."""
import stat

KEYS = {'present', 'mode', 'uid', 'gid', 'inode', 'canonical', 'runner_uid'}


class InvalidSample(Exception):
    pass


def conjunction(values):
    if any(v is False for v in values):
        return 'refuse'
    return 'pass' if all(v is True for v in values) else 'unknown'


def classify(sample):
    # Exact built-in types only: do not stringify or inspect user-derived objects.
    if type(sample) is not dict or any(type(k) is not str for k in sample) or set(sample) != KEYS:
        raise InvalidSample('invalid-sample')
    for key in ('present', 'canonical'):
        if sample[key] is not None and type(sample[key]) is not bool:
            raise InvalidSample('invalid-sample')
    for key in ('mode', 'uid', 'gid', 'inode', 'runner_uid'):
        value = sample[key]
        if value is not None and (type(value) is not int or value < 0):
            raise InvalidSample('invalid-sample')
    if sample['runner_uid'] is not None and sample['runner_uid'] == 0:
        raise InvalidSample('non-root-context-required')
    mode, uid, gid = sample['mode'], sample['uid'], sample['gid']
    if mode is not None and mode > 0xffff:
        raise InvalidSample('invalid-sample')
    present = sample['present']
    unknown = present is not True
    directory = None if unknown or mode is None else stat.S_ISDIR(mode)
    uid_root = None if unknown or uid is None else uid == 0
    uid_runner = None if unknown or uid is None or sample['runner_uid'] is None else uid == sample['runner_uid']
    gid_root = None if unknown or gid is None else gid == 0
    positive = None if unknown or sample['inode'] is None else sample['inode'] > 0
    canonical = None if unknown else sample['canonical']
    specials = None if unknown or mode is None else bool(mode & 0o7000)
    group_write = None if unknown or mode is None else bool(mode & 0o20)
    other_write = None if unknown or mode is None else bool(mode & 0o2)
    safe_mode = None if unknown or mode is None else not bool(mode & 0o7022)
    production_owner = True if uid_root is True or uid_runner is True else \
        False if uid_root is False and uid_runner is False else None
    common = (present, directory, positive, safe_mode, canonical)
    production = conjunction((*common, production_owner))
    preflight = conjunction((*common, uid_root, gid_root))
    def flag(value):
        return 'yes' if value is True else 'no' if value is False else 'unknown'
    kind = 'unknown' if unknown or mode is None else 'directory' if stat.S_ISDIR(mode) else \
        'symlink' if stat.S_ISLNK(mode) else 'other'
    owner = 'unknown' if unknown or uid is None else 'root' if uid_root else \
        'runner' if uid_runner else 'other' if uid_runner is False else 'non-root-runner-unknown'
    group = 'unknown' if gid_root is None else 'root' if gid_root else 'non-root'
    return {
        'scope': 'diagnostic-only',
        'present': flag(present), 'kind': kind, 'owner': owner, 'group': group,
        'inode_positive': flag(positive), 'canonical': flag(canonical),
        'special_mode_bits': flag(specials), 'group_write': flag(group_write), 'other_write': flag(other_write),
        'production_parent_predicate': production,
        'preflight579_parent_predicate': preflight,
        'difference': 'stricter-579-only' if production == 'pass' and preflight == 'refuse' else
                      'both-pass' if production == preflight == 'pass' else
                      'both-refuse' if production == preflight == 'refuse' else 'unknown',
        'native_qualification': False,
        'provisioning_authorized': False,
    }
