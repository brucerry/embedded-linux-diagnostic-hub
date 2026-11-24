"""One stock Jammy provisioning measurement. Uses the proven venue without product media."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
from threading import Event, Lock, Thread
from time import monotonic, sleep

import capacity_guest as guest
import native_control
import native_seed
import venue
import venue_seed
from runtime_gate import HOST_FLOOR, MODEL_CAP, inode, need


BRANCH = 'refs/heads/ci/v060-jammy-runtime51-verdicts-20261124'
WORKFLOW = '.github/workflows/v060-jammy-provisioning-capacity.yml'
JOB = 'provisioning'
RUNTIME_DETAILS = tuple('runtime_51_' + name for name in guest.RUNTIME_STAGES)
RUNTIME_RESULTS = tuple('runtime_51_' + name for name in guest.APPLY_FIELDS)
THRESHOLDS = {
    'stock': (763_428_864, 5_454_950_400),
    'direct_stage': (1_113_980_928, 5_111_939_072),
}
NUMERIC = ('cluster_bits', 'host_logical', 'host_allocated', 'logical_peak', 'allocated_peak',
           'guest_free', 'guest_inodes')
STAGES = (
    'context', 'pre_intake', 'oci_pull', 'oci_identity', *venue.INTAKE_STAGES, 'apt_media', 'post_intake',
    'prepare_create', 'prepare_config', 'prepare_mounts', 'prepare_attach',
    *(stage for stage, _ in venue.PREPARE_FRAMES),
    'prepare_exit', 'prepare_retired', 'overlay_header', 'pre_boot',
    'boot_create', 'boot_config', 'boot_mounts', 'boot_attach',
    *venue_seed.GUEST_STAGES, *guest.PHASES[:guest.PHASES.index('runtime_51')],
    *RUNTIME_DETAILS, *guest.PHASES[guest.PHASES.index('runtime_51'):], 'guest_evidence', 'host_measurement', 'worker_exit',
    'boot_worker_retired', 'immutable_media', 'workers_retired', 'scratch_retired',
)


def seed(nonce, product):
    need(product is None, 'capacity-forbids-product')
    return native_seed.guest_seed(
        nonce, {'nonce': nonce, 'binding': guest.binding(nonce)}, guest.MOUNTS,
        'capacity_guest.py', controls=(*native_seed.CONTROL, 'capacity_guest.py'),
    )


def seal(pins, fixture, inputs, download, product):
    return venue.seal_fixture(pins, fixture, inputs, download, product,
                              seed_builder=seed, worker_name='capacity-worker.sh')


class Watch:
    def __init__(self, overlay):
        self.overlay = overlay
        self.owner = inode(overlay.lstat())
        self.parent = inode(overlay.parent.lstat())
        self.lock = Lock()
        self.peaks = (0, 0)

    @contextmanager
    def opened(self):
        path = self.overlay
        parent = path.parent.lstat()
        need(path.parent.resolve(strict=True) == path.parent and inode(parent) == self.parent
             and stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() > 0
             and stat.S_IMODE(parent.st_mode) == 0o700, 'capacity-overlay-parent')
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
        with os.fdopen(os.open(path, flags), 'rb') as source:
            current = os.fstat(source.fileno())
            need(stat.S_ISREG(current.st_mode) and inode(current) == self.owner == inode(path.lstat())
                 and current.st_uid == os.getuid() and current.st_nlink == 1
                 and not current.st_mode & 0o7022, 'capacity-overlay-identity')
            yield source, current
            need(inode(path.lstat()) == self.owner and inode(path.parent.lstat()) == self.parent,
                 'capacity-overlay-drift')

    def geometry(self):
        with self.opened() as (source, _):
            header = source.read(24)
            need(len(header) == 24 and header[:8] == b'QFI\xfb\x00\x00\x00\x03',
                 'capacity-overlay-header')
            bits = int.from_bytes(header[20:24], 'big')
            need(bits == 16, 'capacity-overlay-cluster-bits')
            return bits

    def sample(self, *, backing=False):
        with self.lock, self.opened() as (source, info):
            current = (info.st_size, info.st_blocks*512)
            need(0 < current[0] <= MODEL_CAP and 0 <= current[1] <= MODEL_CAP, 'capacity-host-cap')
            if backing:
                fs = os.fstatvfs(source.fileno())
                need(fs.f_bavail*fs.f_frsize >= HOST_FLOOR and fs.f_favail >= 16
                     and not fs.f_flag & os.ST_RDONLY, 'capacity-host-backing')
            self.peaks = tuple(map(max, zip(self.peaks, current, strict=True)))
            return (*current, *self.peaks)

    def at_checkpoint(self, overlay, owner, cap, reserved, *, limits):
        need(overlay == self.overlay and owner == self.owner and cap == MODEL_CAP
             and reserved == 0 and limits == (cap, cap), 'capacity-live-worker-limit')
        return self.sample(backing=True)


def attach_owned(worker, deadline, maximum, watch, nonce):
    stopped = Event()
    issues = Event()
    result = []
    watch.sample()

    def sample_while_running():
        try:
            while not stopped.wait(.05):
                watch.sample()
        except Exception:
            issues.set()

    def acknowledge():
        try:
            while not os.path.lexists(watch.overlay.parent / native_control.SOCK_LEAF):
                need(not stopped.is_set() and not issues.is_set() and monotonic() < deadline,
                     'capacity-sample-socket')
                sleep(.05)
            actual = worker.inspect(worker.cid, deadline)['State']
            pid = actual['Pid']
            need(actual['Running'] is True and actual['Status'] == 'running'
                 and type(pid) is int and pid > 1, 'capacity-live-worker')
            owner = native_control.Worker(pid, native_control.start_readback(pid), os.getuid(), os.getgid())
            def check_observer():
                need(not stopped.is_set() and not issues.is_set(), 'capacity-sample-monitor')
            result.append(native_control.host_work(
                watch.overlay.parent, watch.owner, MODEL_CAP, 0, owner, guest.binding(nonce), deadline,
                cancelled=lambda: stopped.is_set() or issues.is_set(), pregrant=check_observer,
                measure_overlay=watch.at_checkpoint,
            ))
        except Exception:
            issues.set()

    threads = [Thread(target=task, daemon=True) for task in (sample_while_running, acknowledge)]
    for thread in threads:
        thread.start()
    try:
        code, out, err = venue.capture([*venue.DAEMON, 'start', '--attach', worker.cid],
                                        worker.env, deadline, maximum, stdout_cap=256*1024, stderr_cap=8192)
    finally:
        stopped.set()
        for thread in threads:
            thread.join(timeout=10)
        need(not any(thread.is_alive() for thread in threads), 'capacity-host-thread-closure')
    return code, out, err, None if issues.is_set() or len(result) != 1 else result[0]


class RuntimeEvidence:
    """Reduce a closed, ordered set of second-transaction observations."""

    def __init__(self):
        self.position = 0
        self.failed = False
        self.applied = None

    def current(self):
        need(self.position < len(guest.RUNTIME_STAGES) and not self.failed,
             'runtime-evidence-closed')
        return guest.RUNTIME_STAGES[self.position]

    def observe(self, frame, stages):
        current = self.current()
        if frame.startswith(b'rt51_result '):
            need(current == 'apply' and self.applied is None, 'runtime-result-order')
            values = frame.decode('ascii').split(' ')[1:]
            need(len(values) == len(RUNTIME_RESULTS) and
                 all(value in allowed for value, allowed in zip(values, guest.APPLY_FIELDS.values(), strict=True)),
                 'runtime-result-vocabulary')
            self.applied = dict(zip(guest.APPLY_FIELDS, values, strict=True))
            return
        tokens = frame.decode('ascii').split(' ')
        need(len(tokens) == 3 and tokens[:2] == ['rt51', current] and tokens[2] in ('pass', 'fail'),
             'runtime-evidence-order')
        value = tokens[2]
        if current == 'apply':
            if value == 'pass':
                need(self.applied is not None and self.applied['prov_exit'] == 'zero'
                     and self.applied['prov_child'] == 'closed', 'runtime-apply-proof')
            if self.applied is not None:
                stages.update(zip(RUNTIME_RESULTS, self.applied.values(), strict=True))
        if current == 'observer' and value == 'pass':
            expected = {'prov_status': 'valid', 'prov_progress': 'child-reported',
                        'prov_error': 'not-seen', 'prov_prompt': 'not-seen'}
            need(all(self.applied[key] == state for key, state in expected.items()), 'runtime-observer-proof')
        stages[RUNTIME_DETAILS[self.position]] = value
        self.position += 1
        self.failed = value == 'fail'

    def finish(self, value):
        if value == 'pass':
            need(not self.failed and self.position == len(RUNTIME_DETAILS), 'runtime-evidence-incomplete')
        else:
            need(self.failed, 'runtime-failed-detail-missing')


def evidence(wire, nonce, stages):
    stock = venue_seed.boot_evidence(wire, nonce)
    stages.update({name: 'pass' if value else 'fail' for name, value in stock.items()})
    if not all(stock.get(name) for name in venue_seed.GUEST_STAGES):
        return None
    lines = wire.splitlines()
    start = lines.index(f'HUB_JAMMY_VENUE {nonce} loopback-only'.encode())
    end = next(i for i,line in enumerate(lines) if b'Datasource DataSourceNoCloud [seed=/dev/sr0].' in line
               and b' finished at ' in line)
    prefix = f'{guest.TITLE} {nonce} '.encode()
    next_phase = 0
    sample = None
    closed = False
    runtime = RuntimeEvidence()
    for position,row in enumerate(lines):
        if guest.TITLE.encode() not in row:
            continue
        need(start < position < end and row.startswith(prefix) and not closed, 'capacity-serial-identity')
        frame = row.removeprefix(prefix)
        if frame.startswith((b'rt51 ', b'rt51_result ')):
            need(next_phase == guest.PHASES.index('runtime_51'), 'runtime-evidence-phase')
            runtime.observe(frame, stages)
            continue
        if frame.startswith(b'sample '):
            need(next_phase == guest.PHASES.index('ordinary_user') and sample is None, 'capacity-serial-sample-order')
            sample = guest.parse(frame.removeprefix(b'sample ') + b'\n')
            continue
        need(next_phase < len(guest.PHASES), 'capacity-serial-stage-count')
        name = guest.PHASES[next_phase]
        need(frame in (f'{name} pass'.encode(), f'{name} fail'.encode()), 'capacity-serial-stage-order')
        closed = frame.endswith(b' fail')
        if name == 'ordinary_user' and not closed:
            need(sample is not None, 'capacity-serial-missing-sample')
        value = 'fail' if closed else 'pass'
        stages[name] = value
        if name == 'runtime_51':
            runtime.finish(value)
        next_phase += 1
    return sample if not closed and next_phase == len(guest.PHASES) else None


def compare(host, guest_free):
    host_max = max(host[2:])
    outcomes = {
        (False, False): 'fits', (True, False): 'host-short',
        (False, True): 'guest-short', (True, True): 'host-and-guest-short',
    }
    return {name: outcomes[host_max > host_limit, guest_free < guest_need]
            for name, (host_limit, guest_need) in THRESHOLDS.items()}


def attempt(stages):
    os.umask(0o077)
    scratch = None
    workers = []
    retire_end = monotonic()+710

    @contextmanager
    def phase(name):
        stages[name] = 'fail'
        yield
        stages[name] = 'pass'

    try:
        with phase('context'):
            temp, run = venue.context(BRANCH, WORKFLOW, JOB)
            now = monotonic()
            prepare_end, boot_stop, retire_end = now+240, now+640, now+710
            path = venue.HERE/'venue-inputs.json'
            venue.pinned(path, 256*venue.MIB, venue.INPUTS_SHA)
            pins = json.loads(path.read_bytes())
            need(len(pins['archives']) == 52 and len(pins['members']) == 64, 'capacity-pinned-input-census')
            import tempfile
            scratch = Path(tempfile.mkdtemp(dir=temp, prefix='hjr-cap-'))
            owner = inode(scratch.lstat())
            for part in ('fixture', 'input', 'work', 'download', 'gpg-empty', 'docker'):
                (scratch/part).mkdir(mode=0o700)
            env = venue.OPT | {'HOME': str(scratch), 'DOCKER_CONFIG': str(scratch/'docker')}
        worker_id = run+'-'+secrets.token_hex(5)
        with phase('pre_intake'):
            info = json.loads(venue.command([*venue.DAEMON, 'info', '--format', '{{json .}}'], env, prepare_end, 10))
            need(info['Architecture'] in ('amd64','x86_64') and info['OSType']=='linux'
                 and 'name=seccomp,profile=builtin' in info['SecurityOptions']
                 and info['Driver'] in ('overlay2','overlayfs') and info['DockerRootDir']=='/var/lib/docker',
                 'stock-docker')
            docker_backing = [Path('/var/lib/docker')]
            if info['Driver']=='overlayfs':
                docker_backing.append(Path('/var/lib/containerd'))
            stage_bytes = pins['guest']['size']+(96+256+136+128+64)*venue.MIB+MODEL_CAP
            image_cost = pins['stockLayerBytes']+pins['stockLayerExpandedBytes']+64*venue.MIB
            venue.capacity([(scratch,stage_bytes),*((p,image_cost) for p in docker_backing)])
        image = pins['stockImage']
        with phase('oci_pull'):
            venue.command([*venue.DAEMON, 'pull', '--platform=linux/amd64', image], env, prepare_end, 65)
        with phase('oci_identity'):
            actual, = json.loads(venue.command([*venue.DAEMON,'image','inspect',image],env,prepare_end,8))
            need((actual['Id'],actual['Os'],actual['Architecture'])==(pins['stockConfig'],'linux','amd64')
                 and not actual['Config'].get('Volumes') and not actual['Config'].get('Healthcheck'),'stock-oci-digest')
        with phase('apt_media'):
            archive_media = venue.prepare_runtime(scratch, venue.fetch, prepare_end)
            need(set(archive_media) == {'apt-display.iso', 'apt-runtime.iso'}, 'capacity-media-allowlist')
        nonce = venue.assemble(pins, scratch, env, prepare_end, phase, stages, None, sealer=seal)
        with phase('post_intake'):
            venue.capacity([(scratch,MODEL_CAP+16*venue.MIB),*((p,0) for p in docker_backing)])
            need(int(re.search(r'(?m)^MemAvailable:\s+(\d+) kB$',Path('/proc/meminfo').read_text())[1])
                 >=4*1024**2,'stock-memory')
        preparer = venue.OwnedWorker(worker_id, 'prepare', scratch, image, pins['stockConfig'], env)
        workers.append(preparer)
        code, out, err = preparer.launch(prepare_end, 100, phase)
        remainder = venue.prepare_receipt(out, phase)
        with phase('prepare_exit'):
            need(code==0 and not err and not remainder and preparer.normal_terminal(prepare_end), 'prepare-exit')
        with phase('prepare_retired'):
            preparer.retire(prepare_end)
        with phase('overlay_header'):
            seed_hash = venue.overlay_and_seed(scratch)
            watch = Watch(scratch/'work'/'disk.qcow2')
            bits = watch.geometry()
        with phase('pre_boot'):
            inputs = scratch/'input'
            need({path.name for path in inputs.iterdir()} == {
                'meta-data','user-data','jammy.qcow2','SHA256SUMS','seed.iso',*archive_media,
            }, 'capacity-input-roster')
            venue.capacity([(scratch,MODEL_CAP+320*venue.MIB),*((p,0) for p in docker_backing)])
        boot_deadline = min(monotonic()+400, boot_stop)
        boot = venue.OwnedWorker(worker_id, 'boot', scratch, image, pins['stockConfig'], env)
        workers.append(boot)
        code, out, err, host = boot.launch(boot_deadline, 400, phase,
            attach=lambda worker, deadline, duration: attach_owned(worker, deadline, duration, watch, nonce))
        stages['guest_evidence'] = 'fail'
        try:
            sample = evidence(out, nonce, stages)
        except (ValueError, StopIteration):
            sample = None
        if sample is not None:
            stages['guest_evidence'] = 'pass'
        with phase('worker_exit'):
            need(code==0 and not err and boot.normal_terminal(retire_end), 'capacity-boot-terminal')
        with phase('boot_worker_retired'):
            boot.retire(retire_end)
        with phase('host_measurement'):
            need(host is not None and sample is not None, 'capacity-coupled-sample')
            watch.sample(backing=True)
        with phase('immutable_media'):
            guard_retired_media(scratch, archive_media, seed_hash, pins['guest'])
            venue.capacity([(scratch,0),*((p,0) for p in docker_backing)])
    finally:
        if scratch is not None:
            retire(scratch, owner, workers, retire_end, phase)
    numbers = dict(zip(NUMERIC, (bits, *host, *sample), strict=True))
    return numbers | compare(host, sample[0])


def guard_retired_media(scratch, archives, seed_hash, stock):
    source = scratch/'input'
    venue.pinned(source/'seed.iso',venue.MIB,seed_hash)
    for item,receipt in archives.items():
        venue.pinned(source/item,64*venue.MIB,receipt['sha256'],receipt['bytes'])
    venue.pinned(source/'jammy.qcow2',stock['size'],stock['sha256'],stock['size'])
    work = scratch/'work'
    endpoint = work/native_control.SOCK_LEAF
    if os.path.lexists(endpoint):
        meta = endpoint.lstat()
        need(stat.S_ISSOCK(meta.st_mode) and meta.st_uid==os.getuid() and not meta.st_mode&0o077,
             'capacity-closed-socket')
        endpoint.unlink()
    need({p.name for p in work.iterdir()} == {'disk.qcow2','vars.fd','chain.json','READONLY.SHA256'},
         'capacity-output-roster')
    venue.pinned(work/'vars.fd',8*venue.MIB,size=(scratch/'fixture/firmware/OVMF_VARS_4M.fd').stat().st_size)


def retire(scratch, owner, workers, limit, phase):
    with phase('workers_retired'):
        failures = []
        for worker in reversed(workers):
            try:
                worker.retire(limit)
            except Exception as error:
                failures.append(error)
        need(not failures, 'capacity-worker-retirement-uncertain')
    with phase('scratch_retired'):
        need(owner==inode(scratch.lstat()) and scratch==scratch.resolve()
             and shutil.rmtree.avoids_symlink_attacks, 'capacity-scratch-ownership')
        shutil.rmtree(scratch)
        need(not os.path.lexists(scratch), 'capacity-scratch-retirement')


def entry():
    signal.signal(signal.SIGTERM, venue.interrupted)
    signal.signal(signal.SIGINT, venue.interrupted)
    output = Path(os.environ['GITHUB_OUTPUT'])
    stages, metrics = {}, {}
    try:
        metrics = attempt(stages)
    except Exception:
        pass
    good = bool(metrics) and all(stages.get(name) == 'pass' for name in STAGES)
    with output.open('a', encoding='ascii') as out:
        for name in STAGES:
            print(f'{name}={stages.get(name, "unreached")}', file=out)
        for name in RUNTIME_RESULTS:
            print(f'{name}={stages.get(name, "unreached")}', file=out)
        if good:
            for name in (*NUMERIC, *THRESHOLDS):
                print(f'{name}={metrics[name]}', file=out)
        print(f'result={"pass" if good else "fail"}', file=out)
    return 0 if good else 1


if __name__ == '__main__':
    raise SystemExit(entry())
