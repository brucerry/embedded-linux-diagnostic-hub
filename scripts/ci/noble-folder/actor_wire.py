"""Fixed actor verdicts. The root guest validates before relaying any names."""
from contextlib import contextmanager
import re

STAGES = (
    'actor_entry', 'actor_preflight', 'actor_node_loader', 'actor_envelope',
    'actor_installer_loader', 'actor_install_start', 'actor_install_exit',
    'actor_install_closure', 'actor_installed_verification', 'actor_uninstall_preflight',
    'actor_uninstall_start', 'actor_uninstall_exit', 'actor_uninstall_closure',
    'actor_uninstall_verification',
)
SUCCESS = 'original-custody loader-closure install-pty installed-readback uninstall-pty removal-and-preservation'
CAP = 2048
CHILD_PREFIX = b'HUB_ACTOR_STAGE '
RELAY_PREFIX = b'HUB_NOBLE_ACTOR '
INSTALL_EXIT = 'actor_install_exit'
INSTALL_BOUNDARY = 'actor_install_boundary'
DEADLINE_LIMITS = ('operation', 'actor', 'tie')
DEADLINE_POSITIONS = (
    'no-output', 'unmatched-output', 'prompt-matched', 'retained-before-consent',
    'retained-after-consent', 'await-exit-and-eof', 'await-exit', 'await-eof', 'late-completion',
)
INSTALL_REFUSALS = (
    'deadline', 'process-observation', 'read', 'frame', 'prompt', 'prompt-unseen',
    'prompt-owner', 'consent-write', 'child-exited-before-consent', 'child-nonzero',
    'child-signal', 'completion-mismatch', 'failure-closure',
) + tuple(f'deadline-{limit}-{position}' for limit in DEADLINE_LIMITS for position in DEADLINE_POSITIONS)
REFUSAL_WORDS = {b'fail-' + value.encode('ascii'): value for value in INSTALL_REFUSALS}


def need(valid, label):
    if not valid:
        raise ValueError(label)


@contextmanager
def stage(name):
    need(name in STAGES, 'actor-stage-name')
    try:
        yield
    except BaseException as error:
        verdict = 'fail'
        if name == INSTALL_EXIT:
            boundary = getattr(error, INSTALL_BOUNDARY, None)
            if boundary in INSTALL_REFUSALS:
                verdict += '-' + boundary
        print(f'HUB_ACTOR_STAGE {name} {verdict}', flush=True)
        raise
    else:
        print(f'HUB_ACTOR_STAGE {name} pass', flush=True)


def states(rows, prefix):
    """Admit only one exact ordered prefix and forbid anything after a failure."""
    verdicts = {}
    for row in rows:
        index = len(verdicts)
        need(index < len(STAGES) and 'fail' not in verdicts.values(), 'actor-stage-boundary')
        name = STAGES[index]
        start = prefix+name.encode('ascii')+b' '
        need(row.startswith(start), 'actor-stage-frame')
        word = row[len(start):]
        if name == INSTALL_EXIT and word in REFUSAL_WORDS:
            verdicts[name] = 'fail'
            verdicts[INSTALL_BOUNDARY] = REFUSAL_WORDS[word]
        else:
            need(word in (b'pass', b'fail'), 'actor-stage-frame')
            verdicts[name] = word.decode('ascii')
    return verdicts


def relay_values(verdicts):
    """Re-encode the validated extra field only as a closed suffix on the failed stage."""
    boundary = verdicts.get(INSTALL_BOUNDARY)
    if boundary is not None:
        need(boundary in INSTALL_REFUSALS and verdicts.get(INSTALL_EXIT) == 'fail', 'actor-relay-boundary')
    for name, value in verdicts.items():
        if name != INSTALL_BOUNDARY:
            yield name, value + '-' + boundary if name == INSTALL_EXIT and boundary is not None else value


def complete(verdicts):
    return len(verdicts)==len(STAGES) and all(value=='pass' for value in verdicts.values())


def child(data, nonce):
    need(type(data) is bytes and len(data)<=CAP and (not data or data.endswith(b'\n'))
         and re.fullmatch('[a-f0-9]{64}',nonce), 'actor-channel-shape')
    rows = data.split(b'\n')[:-1]
    terminal = f'HUB_GUEST_ACTOR {nonce} {SUCCESS}'.encode('ascii')
    success = rows[-1:] == [terminal]
    verdicts = states(rows[:-1] if success else rows, CHILD_PREFIX)
    need(not success or complete(verdicts), 'actor-channel-premature-success')
    return verdicts,success


def relayed(rows,nonce):
    need(sum(len(row)+1 for row in rows)<=CAP and re.fullmatch('[a-f0-9]{64}',nonce),
         'actor-relay-bound')
    return states(rows,RELAY_PREFIX+nonce.encode('ascii')+b' ')
