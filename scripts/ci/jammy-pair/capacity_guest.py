"""The stock Jammy provisioning checkpoint. There is no product action."""

from contextlib import contextmanager
from hashlib import sha256
import os
from pathlib import Path
import re
import stat
import sys
from time import monotonic

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guest_closure
import native_control
import native_guest as qualified
from runtime_gate import DISK_FLOOR, need


MOUNTS = {'/mnt/hub-apt-witness': '/dev/sr1', '/mnt/hub-apt-runtime': '/dev/sr2'}
PHASES = ('stock_guest', 'grow', 'display_54', 'runtime_51', 'ordinary_user', 'sample_ack', 'final_loopback')
TITLE = 'HUB_JAMMY_CAPACITY'
DATA = re.compile(rb'([1-9][0-9]{0,10}) ([1-9][0-9]{0,9})\n')
LOCKS = (qualified.native.DISPLAY_PIN, qualified.native.RUNTIME_PIN)
MAX_GUEST = qualified.stock.DISK


def binding(nonce):
    need(type(nonce) is str and re.fullmatch('[a-f0-9]{64}', nonce), 'capacity-nonce')
    return sha256(('jammy-provisioning-capacity-v1\n' + '\n'.join((nonce, *LOCKS)) + '\n').encode('ascii')).hexdigest()


def parse(data):
    match = DATA.fullmatch(data)
    need(match, 'capacity-guest-data')
    free, inodes = map(int, match.groups())
    need(DISK_FLOOR <= free < MAX_GUEST and free % 4096 == 0 and inodes >= 12000,
         'capacity-guest-floor')
    return free, inodes


def ordinary_read():
    qualified.x.parent()
    account = qualified.x.credentials()
    home = Path(account.pw_dir)
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        home_info = os.fstat(fd)
        fs = os.fstatvfs(fd)
        now = os.lstat(home)
        need(stat.S_ISDIR(now.st_mode) and home_info.st_uid == account.pw_uid
             and (home_info.st_dev, home_info.st_ino) == (now.st_dev, now.st_ino)
             and home_info.st_dev == os.stat('/').st_dev and not fs.f_flag & os.ST_RDONLY
             and fs.f_frsize == 4096, 'capacity-guest-home-filesystem')
        data = f'{fs.f_bavail * fs.f_frsize} {fs.f_favail}\n'.encode('ascii')
        parse(data)
        os.write(1, data)
    finally:
        os.close(fd)


def mark(nonce, words):
    with open('/dev/ttyS0', 'w', encoding='ascii') as port:
        print(f'{TITLE} {nonce} {words}', file=port, flush=True)


@contextmanager
def phase(nonce, name):
    try:
        yield
    except Exception:
        mark(nonce, name + ' fail')
        raise
    mark(nonce, name + ' pass')


def supervisor():
    plan = qualified.read_doc(qualified.ROOT / 'plan.json', 4096)
    need(set(plan) == {'nonce', 'binding'} and plan['binding'] == binding(plan['nonce']), 'capacity-plan')
    nonce = plan['nonce']
    end = monotonic() + 375 - float(Path('/proc/uptime').read_text().split()[0])
    with phase(nonce, 'stock_guest'):
        qualified.mounted(MOUNTS)
        first = qualified.Provision(plan, 0, end - 120)
        first.identity()
        account = qualified.x.credentials()
        need(not guest_closure.sample(account.pw_uid), 'capacity-initial-account')
    with phase(nonce, 'grow'):
        first.grow()
        first.space(DISK_FLOOR + 212*2**20)
    with phase(nonce, 'display_54'):
        first.run_exact()
    with phase(nonce, 'runtime_51'):
        last = qualified.Provision(plan, 1, end - 115)
        last.run_exact()
    with phase(nonce, 'ordinary_user'):
        final = qualified.stock.Provision(nonce)
        final.deadline = min(final.deadline, end)
        final.network()
        final.command(['/usr/bin/sync', '-f', '/'], 8)
        data = qualified.run_as(account, plan, 'measure', 8, end - 30, entry=__file__)
        parse(data)
        guest_closure.closed((), exact_zero_exit=True, output_and_stderr_eof=True,
                             sample_owned=lambda: guest_closure.sample(account.pw_uid))
        mark(nonce, 'sample ' + data.decode('ascii').rstrip('\n'))
    with phase(nonce, 'sample_ack'):
        native_control.guest_control(plan['binding'], min(end - 10, monotonic() + 25))
    with phase(nonce, 'final_loopback'):
        need(monotonic() < end, 'capacity-final-deadline')
        final.network()
        need(not guest_closure.sample(account.pw_uid), 'capacity-final-account')


if __name__ == '__main__':
    try:
        os.umask(0o077)
        if sys.argv[1:] == ['measure']:
            ordinary_read()
        else:
            need(sys.argv[1:] == [], 'capacity-guest-invocation')
            supervisor()
    except Exception:
        raise SystemExit(78) from None
