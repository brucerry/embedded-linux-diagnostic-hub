"""One producer, one private original-pair transfer, one data-only Jammy guest."""
from base64 import b64decode
from dataclasses import dataclass
from hashlib import sha256
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

import attach_pair
import handoff
import host as producer
import pair_custody as pair
from package_pair import LAUNCHER_SHA256

CONTROL=Path(__file__).resolve().parent
sys.path.insert(0,str(CONTROL.parent/'jammy-pair'))
import venue as jammy
import observer_media
import native_preflight
import appimage_inventory as image
import archive_inventory

EXTRA=('producer_custody','producer_phase_budget','guest_pair_import','guest_appimage_lifecycle','combined_retirement','observer_media','appimage_receipt')
STAGES=tuple('producer_'+key for key in producer.STAGES if key not in producer.VERIFIER_OUTPUTS)+tuple(
    'jammy_'+key for key in jammy.STAGES)+EXTRA

@dataclass(frozen=True)
class Product:
    directory: Path
    header: dict
    expected: dict
    observer: dict
    required_overlay: int
    guest_copy: int
    image_inventory: dict
    image_budget: dict

    @property
    def medium_bytes(self):
        return pair.iso_bytes(self.header)

    def seal(self,path,deadline):
        return pair.seal_medium(self.directory,path,self.header,self.expected,deadline)

def select_binding(metadata,attempt_input,worker,verdicts):
    lines=metadata.splitlines(keepends=True)
    producer.need(len(lines)>=3,'pair-prelude-shape')
    frame=re.fullmatch(rb'HUB_APPIMAGE_SCAN ([A-Za-z0-9+/=]+)\n',lines[-3])
    producer.need(frame is not None,'appimage-producer-frame')
    data=b64decode(frame[1],validate=True)
    producer.need(0<len(data)<=image.METADATA_LIMIT,'appimage-producer-frame-limit')
    inventory=json.loads(data,object_pairs_hook=handoff.closed_object)
    producer.need(image.wire.canonical(inventory)==data,'appimage-producer-frame-canonical')
    tools=re.fullmatch(rb'HUB_PAIR_TOOLS ([0-9a-f]{64})\n',lines[-2])
    producer.need(tools is not None,'tool-receipt-missing')
    parsed=producer.worker_frame(b''.join(lines[:-3]+lines[-1:]),worker.bound,verdicts,worker.binding)
    producer.need(parsed is not None and parsed['launcher_sha256']==LAUNCHER_SHA256 and
                  verdicts.get('extraction')=='held','pair-producer-fixed-verdict')
    known=json.loads(attempt_input.read_bytes(),object_pairs_hook=handoff.closed_object)
    producer.need(set(known)=={'source_commit','workflow_sha256','worker_binding','run_id'}
                  and known['worker_binding']==worker.binding and known['run_id']+'-1'==worker.bound
                  and known['source_commit']==os.environ['GITHUB_SHA'],'pair-host-attempt')
    attempt=dict(repository=handoff.REPOSITORY,source_commit=known['source_commit'],
                 source_checkout_tree=handoff.SOURCE_CHECKOUT_TREE,product_tree=handoff.PRODUCT_TREE,
                 manifest_sha256=handoff.PRODUCT_MANIFEST,lock_sha256=handoff.LINUX_LOCK,
                 workflow_sha256=known['workflow_sha256'],run_id=known['run_id'],run_attempt=1,
                 job='two-format',worker_binding=known['worker_binding'],
                 runner_tool_receipt_sha256=tools[1].decode('ascii'))
    need=re.fullmatch(r'[0-9a-f]{64}',attempt['workflow_sha256']) is not None
    producer.need(need,'pair-workflow-shape')
    handoff.validate_attempt(handoff.Attempt(**attempt))
    bind={}
    for asset,kind in ((pair.TAR,'tar_sha256'),(pair.APP,'appimage_sha256')):
        value=parsed[kind]
        sidecar=f'{value}  {asset}\n'.encode('ascii')
        bind[asset]=[asset,None,value]
        bind[asset+'.sha256']=[asset+'.sha256',len(sidecar),sha256(sidecar).hexdigest()]
    bind[pair.RECORD]=[pair.RECORD,None,parsed['record_sha256']]
    return {'attempt':attempt,'members':[bind[n] for n in pair.NAMES]},inventory

def execute_release(stages,checkout,root,run,deadline):
    records={}
    def step(name,call):
        try:
            return producer.step(records,name,call)
        finally:
            stages.update({'producer_'+key:value for key,value in records.items()})
    raw=root/'export'
    raw.mkdir(mode=0o700)
    building=root/'producer'
    building.mkdir(mode=0o700)
    identity=producer.identity(building.lstat())
    (building/'docker').mkdir(mode=0o700)
    env={**producer.SAFE_ENV,'HOME':str(building),'DOCKER_CONFIG':str(building/'docker')}
    worker=producer.Worker(env,run+'-1')
    original=producer.capture

    def bounded(argv,env,seconds,**kwargs):
        left=deadline-monotonic()
        producer.need(left>0,'producer-phase-deadline')
        return original(argv,env,min(seconds,left),**kwargs)
    producer.capture=bounded
    clean=False
    try:
        backs=step('host_space',lambda:producer.check_host(worker,building,records))
        inputs=step('inputs',lambda:producer.stage(building,checkout,worker))
        step('runtime_rebuild',lambda:producer.stage_runtime(building,inputs))
        step('image_space',lambda:producer.check_image(worker,backs))
        document=step('created',lambda:worker.create(inputs))
        step('isolation',lambda:producer.isolated(document,worker.cid,inputs,worker.bound))
        expected=independent=None
        def choose(meta):
            nonlocal expected,independent
            expected,independent=select_binding(meta,inputs/'attempt.json',worker,records)
            return expected
        worker.attaching=True
        left=deadline-monotonic()
        producer.need(left>=30,'producer-attach-time')
        header=step('attach',lambda:attach_pair.attach([*producer.DOCKER,'start','--attach',worker.cid],
            env,min(left,720),choose,raw,reserve=jammy.FLOOR))
        def make_observer():
            need_now=64*2**20
            producer.need(producer.free(root)>=jammy.FLOOR+need_now,'observer-optical-space')
            return observer_media.build(root,deadline,inputs=inputs)
        observer=producer.step(stages,'observer_media',make_observer)
    finally:
        # Retirement has its own bounded CLI calls and starts even on budget exhaustion.
        producer.capture=original
        try:
            clean=step('worker_retired',worker.retire) if worker.creation is not None else False
        finally:
            if stages.get('producer_worker_retired')!='fail':
                def cleanup():
                    producer.need(producer.identity(building.lstat())==identity and
                                  building.resolve()==building and shutil.rmtree.avoids_symlink_attacks,
                                  'producer-scratch-owner')
                    shutil.rmtree(building)
                    producer.need(not building.exists(),'producer-scratch-retirement')
                step('scratch_retired',cleanup)
    producer.need(clean and type(expected) is dict,'pair-closed-producer')
    def verified_appimage():
        authority=handoff.Attempt(**header['attempt'])
        record=native_preflight.by_descriptor(raw,handoff.RECORD,
                    header['members'][4][2],header['members'][4][1],native_preflight.read_small)
        receipt=image.bind(authority,header,record,independent)
        rows=image.verify(authority,header,receipt,sha256(image.wire.canonical(receipt)).hexdigest())
        # Sizing here supplies the remaining charge. Actual provisioned occupancy is
        # read from the same QEMU overlay by the unchanged prelaunch controller.
        budget=image.budget(receipt['artifact'][1],rows,observer,provisioned=1)
        producer.need(monotonic()<deadline,'fresh-appimage-budget')
        return Product(raw,header,expected,observer,budget['afterProvisioningOverlayCharge'],
                       budget['guestCopy'],receipt,budget)
    return producer.step(stages,'appimage_receipt',verified_appimage)


def main(stages,*,venue=jammy.main):
    os.umask(0o077)
    producer.need(not producer.EXTRACTION_POLICY_REVIEWED,'custody-only-extraction-disabled')
    elapsed=time()-int(os.environ['PAIR_JOB_EPOCH'])
    producer.need(0<=elapsed<60,'exact-first-job-clock')
    started=monotonic()-elapsed
    run=producer.step(stages,'producer_context',lambda:producer.control_environment(os.environ))
    temp,guest_run=jammy.context()
    producer.need(run==guest_run,'combined-attempt')
    checkout=Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
    producer.need(CONTROL.is_relative_to(checkout) and temp.stat().st_uid==os.getuid(),'runner-owned-checkout')
    root=Path(tempfile.mkdtemp(prefix='hub-jammy-pair-',dir=temp))
    original=producer.identity(root.lstat())
    outcomes={}
    try:
        product=producer.step(stages,'producer_custody',lambda:execute_release(stages,checkout,root,run,started+655))
        # 710 seconds for the guest, 35 seconds outside it for combined retirement and runner metadata.
        producer.step(stages,'producer_phase_budget',lambda:producer.need(monotonic()<started+695,
            'combined-guest-phase-budget'))
        try:
            venue(outcomes,product)
        finally:
            stages.update({'jammy_'+key:value for key,value in outcomes.items()})
            if 'native_custody' in outcomes:
                stages['guest_pair_import']=outcomes['native_custody']
        producer.step(stages,'guest_appimage_lifecycle',lambda:producer.need(
            outcomes.get('native_custody')==outcomes.get('native_packaged_window_quit')==
            outcomes.get('native_owned_retirement')==outcomes.get('retirement')=='pass',
            'combined-guest-appimage-lifecycle'))
    finally:
        if stages.get('producer_worker_retired')=='fail' or outcomes.get('retirement')=='fail':
            stages['combined_retirement']='preserved'
        else:
            def retire():
                producer.need(root.resolve()==root and producer.identity(root.lstat())==original
                              and shutil.rmtree.avoids_symlink_attacks,'combined-scratch-owner')
                shutil.rmtree(root)
                producer.need(not os.path.lexists(root),'combined-scratch-retirement')
            producer.step(stages,'combined_retirement',retire)

def entry():
    stages={}
    signal.signal(signal.SIGTERM,jammy.interrupted)
    signal.signal(signal.SIGINT,jammy.interrupted)
    success=False
    try:
        main(stages)
        success=stages.get('guest_appimage_lifecycle')==stages.get('combined_retirement')=='pass'
    except Exception:
        pass
    finally:
        with open(os.environ['GITHUB_OUTPUT'],'a',encoding='ascii') as stream:
            for name in STAGES:
                value=stages.get(name,'unreached')
                if value not in ('pass','fail','unreached','preserved','held'):
                    value='fail'
                stream.write(name+'='+value+'\n')
    return 0 if success else 1

if __name__=='__main__':
    raise SystemExit(entry())
