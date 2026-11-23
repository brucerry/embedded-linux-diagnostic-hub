"""Host entry for one independently approved, exact same-job archive-to-guest attempt."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import sys
import tempfile
from time import monotonic,time

HERE=Path(__file__).resolve().parent
PRODUCER=HERE.parent/'linux-two-format'
sys.path.insert(0,str(PRODUCER))

import host as production
from boot_plan import STAGES as GUEST_STAGES, classify
from controller import Export
import folder_venue as venue
from host_media import make_node, packages, project, seal_images
from host_attempt import expected
from phase_storage import measure

FOLDER_JOB_REVIEWED = True

PHASES=('context','host_space','inputs','image_space','created','isolation','export_backing','private_export',
        'worker_retired','media_backing','exact_project','signed_package_bodies','optical_media',
        'venue_pre_intake','venue_oci','guest_origin','guest_host_preflight','guest_prep','guest_overlay',
        'guest_boot_backing','boot_exec','guest_kernel','guest_nocloud',*GUEST_STAGES,'guest_poweroff',
        'guest_exit','guest_worker_retired','scratch_retired')
SNAPSHOT_OUTPUTS=tuple(dict.fromkeys((*PHASES,*production.STAGES)))
GIB=2**30


def need(value,label):
    if not value:
        raise ValueError(label)


@contextmanager
def stage(verdicts,name):
    verdicts[name]='fail'
    yield
    verdicts[name]='pass'


def owned(path):
    row=path.lstat()
    return row.st_dev,row.st_ino,row.st_uid,row.st_gid,row.st_mode


def retire_tree(path,identity):
    need(path.resolve(strict=True)==path and owned(path)==identity and shutil.rmtree.avoids_symlink_attacks,
         'folder-scratch-identity')
    shutil.rmtree(path)
    need(not os.path.lexists(path),'folder-scratch-remains')


def handoff(producer,verdicts,attempt,root,remaining,admission=measure):
    """No guest work begins until the private transfer and producer retirement agree."""
    with stage(verdicts,'export_backing'):
        need(admission('host-export',{'export':root})['admitted'],'same-job-export-backing')
        need(remaining>=30,'producer-time-before-attach')
    with stage(verdicts,'private_export'):
        header=producer.attach_folder_export(verdicts,attempt,root,seconds=min(720,remaining))
    with stage(verdicts,'worker_retired'):
        need(producer.retire() and not producer.scope(),'private-producer-retirement')
    return Export(root,header)


def boot_once(guest,verdicts,deadline,retire_end,nonce):
    code,out,err=guest.launch(deadline,960)
    result=classify(out,nonce)
    verdicts.update(result)
    with stage(verdicts,'guest_exit'):
        need(code==0 and not err and guest.normal_terminal(retire_end),'guest-normal-terminal-exit')
    with stage(verdicts,'guest_worker_retired'):
        guest.retire(retire_end)
        need(not guest.pending,'guest-not-retired')
    need(all(value=='pass' for value in result.values()),'guest-native-verdicts')


def main(verdicts):
    need(FOLDER_JOB_REVIEWED,'folder-job-held')
    os.umask(0o077)
    with stage(verdicts,'context'):
        run=production.control_environment(os.environ)
        elapsed=time()-int(os.environ['FOLDER_JOB_EPOCH'])
        need(0<=elapsed<90,'exact-first-job-clock')
        start=monotonic()-elapsed
        produce_end,media_end,boot_end,retire_end=(start+seconds for seconds in (1440,1800,2760,2860))
        temp=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        checkout=Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
        need(HERE.is_relative_to(checkout) and temp.stat().st_uid==os.getuid(),'runner-owned-collection')
        root=Path(tempfile.mkdtemp(prefix='hub-native-folder-'+run+'-',dir=temp))
        root_owner=owned(root)
    producer=None
    workers=[]
    producer_retired=False
    try:
        prep,export,qemu,debs=(root/name for name in ('producer','export','qemu','debs'))
        for path in (prep,export,qemu,debs):
            path.mkdir(mode=0o700)
        prep_owner,export_owner,debs_owner=map(owned,(prep,export,debs))
        (prep/'docker').mkdir(mode=0o700)
        env={**production.SAFE_ENV,'HOME':str(prep),'DOCKER_CONFIG':str(prep/'docker')}
        producer=production.Worker(env,run+'-1')
        production.PRODUCER_PHASE_DEADLINE=produce_end
        with stage(verdicts,'host_space'):
            backs=production.check_host(producer,prep,verdicts)
        with stage(verdicts,'inputs'):
            source=production.stage(prep,checkout,producer)
        with stage(verdicts,'image_space'):
            production.check_image(producer,backs)
        with stage(verdicts,'created'):
            need(monotonic()+40<produce_end,'producer-time-before-creation')
            doc=producer.create(source)
        with stage(verdicts,'isolation'):
            production.isolated(doc,producer.cid,source,producer.bound)
            attempt=expected(source/'attempt.json',os.environ['GITHUB_SHA'],production.file_hash(checkout/production.WORKFLOW),
                             producer.binding,run)
        production.PRODUCER_PHASE_DEADLINE=None
        exported=handoff(producer,verdicts,attempt,export,int(produce_end-monotonic()))
        producer_retired=True
        roles={name:qemu for name in ('intake','qemu_root','product_iso','support_iso','seed','aux')}
        with stage(verdicts,'media_backing'):
            need(measure('host-media',roles)['admitted'],'after-export-media-backing')
        for name in ('fixture','input','work','download','docker','gpg-empty'):
            (qemu/name).mkdir(mode=0o700)
        with stage(verdicts,'exact_project'):
            kit=project(source)
            node_pin,=[item for item in production.providers.load_plan() if item.sha256==
                       '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9']
            node=make_node(source,PRODUCER,node_pin,root/'node.bin')
        retire_tree(prep,prep_owner)
        with stage(verdicts,'signed_package_bodies'):
            deps=packages(debs,venue.fetch,media_end)
        nonce=secrets.token_hex(32)
        with stage(verdicts,'optical_media'):
            seed_files,media=seal_images(exported,attempt,node,deps,kit,qemu/'input',nonce,media_end)
        retire_tree(export,export_owner)
        retire_tree(debs,debs_owner)
        (root/'node.bin').unlink()
        venv=venue.OPT|{'HOME':str(qemu),'DOCKER_CONFIG':str(qemu/'docker')}
        venue.pinned(HERE/'venue-inputs.json',256*1024,venue.INPUTS_SHA)
        pins=json.loads((HERE/'venue-inputs.json').read_bytes())
        with stage(verdicts,'venue_pre_intake'):
            info=json.loads(venue.command([*venue.DAEMON,'info','--format','{{json .}}'],venv,media_end,10))
            need(info['Architecture'] in ('amd64','x86_64') and info['OSType']=='linux' and
                 'name=seccomp,profile=builtin' in info['SecurityOptions'] and
                 info['Driver'] in ('overlay2','overlayfs') and info['DockerRootDir']=='/var/lib/docker',
                 'stock-venue-daemon')
            docker=[Path('/var/lib/docker')]
            if info['Driver']=='overlayfs':
                docker.append(Path('/var/lib/containerd'))
            charge=pins['stockLayerBytes']+pins['stockLayerExpandedBytes']+64*2**20
            venue.capacity([(qemu,pins['guest']['size']+512*2**20),*((path,charge) for path in docker)])
        with stage(verdicts,'venue_oci'):
            image=pins['stockImage']
            venue.command([*venue.DAEMON,'pull','--platform=linux/amd64',image],venv,media_end,65)
            actual,=json.loads(venue.command([*venue.DAEMON,'image','inspect',image],venv,media_end,8))
            need((actual['Id'],actual['Os'],actual['Architecture'])==(pins['stockConfig'],'linux','amd64')
                 and not actual['Config'].get('Volumes') and not actual['Config'].get('Healthcheck'),
                 'exact-guest-container-image')
        @contextmanager
        def hidden(_name):
            yield
        with stage(verdicts,'guest_origin'):
            venue.assemble(pins,qemu,venv,media_end,hidden,{},seed_override=seed_files)
        with stage(verdicts,'guest_host_preflight'):
            need(measure('host-guest-start',{'overlay':qemu/'work','aux':qemu/'input'})['admitted'] and
                 int(re.search(r'(?m)^MemAvailable:\s+(\d+) kB$',Path('/proc/meminfo').read_text())[1])>=4*1024**2,
                 'actual-guest-backing-and-memory')
        identity=run+'-'+secrets.token_hex(5)
        worker=venue.OwnedWorker(identity,'prepare',qemu,image,pins['stockConfig'],venv)
        workers.append(worker)
        with stage(verdicts,'guest_prep'):
            exit_code,out,error=worker.launch(media_end,100)
            need(exit_code==0 and not error and not venue.prepare_receipt(out,hidden) and
                 worker.normal_terminal(media_end),'isolated-preparation')
            worker.retire(media_end)
        with stage(verdicts,'guest_overlay'):
            seed_pin=venue.overlay_and_seed(qemu)
            for leaf,row in media.items():
                venue.pinned(qemu/'input'/leaf,row['bytes'],row['sha256'],row['bytes'])
        with stage(verdicts,'guest_boot_backing'):
            need(measure('host-guest-start',{'overlay':qemu/'work','aux':qemu/'input'})['admitted'],
                 'after-staging-guest-backing')
            venue.capacity([(qemu,4*GIB+8*2**20),*((path,0) for path in docker)])
        guest=venue.OwnedWorker(identity,'boot',qemu,image,pins['stockConfig'],venv)
        workers.append(guest)
        guest_until=min(monotonic()+960,boot_end)
        need(guest_until-monotonic()>=900,'full-guest-time')
        boot_once(guest,verdicts,guest_until,retire_end,nonce)
        venue.pinned(qemu/'input'/'seed.iso',2**20,seed_pin)
        for leaf,row in media.items():
            venue.pinned(qemu/'input'/leaf,row['bytes'],row['sha256'],row['bytes'])
        venue.pinned(qemu/'input'/'noble.qcow2',pins['guest']['size'],pins['guest']['sha256'],pins['guest']['size'])
        venue.pinned(qemu/'work'/'vars.fd',8*2**20,size=(qemu/'fixture'/'firmware'/'OVMF_VARS_4M.fd').stat().st_size)
        venue.pinned(qemu/'work'/'disk.qcow2',4*GIB)
        need({f.name for f in (qemu/'work').iterdir()}=={'disk.qcow2','vars.fd','chain.json','READONLY.SHA256'},
             'closed-writable-qemu-roster')
    finally:
        production.PRODUCER_PHASE_DEADLINE=None
        for worker in reversed(workers):
            if worker.pending:
                worker.retire(retire_end)
        if producer is not None and not producer_retired:
            if producer.creation is not None and producer.scope():
                producer.retire()
            need(not producer.scope() and (producer.creation in (None,'start-failed','ok') or producer.cid is not None),
                 'producer-ownership-unresolved')
        with stage(verdicts,'scratch_retired'):
            retire_tree(root,root_owner)


def interrupt(_signum,_frame):
    signal.signal(signal.SIGINT,signal.SIG_IGN)
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    raise InterruptedError('bounded-native-qualification-interrupted')


def entry():
    signal.signal(signal.SIGINT,interrupt)
    signal.signal(signal.SIGTERM,interrupt)
    verdicts=dict.fromkeys(SNAPSHOT_OUTPUTS,'unreached')
    passed=False
    try:
        main(verdicts)
        passed=True
    except (Exception,KeyboardInterrupt):
        if verdicts['scratch_retired']=='unreached':
            verdicts['scratch_retired']='preserved'
    if output:=os.environ.get('GITHUB_OUTPUT'):
        with open(output,'a',encoding='ascii') as stream:
            for name,result in verdicts.items():
                stream.write(f'{name}={result}\n')
    return 0 if passed else 1


if __name__=='__main__':
    raise SystemExit(entry())
