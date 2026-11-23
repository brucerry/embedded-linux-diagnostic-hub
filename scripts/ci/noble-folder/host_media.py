"""Build closed same-attempt payload and guest support media after producer retirement."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from time import monotonic
from urllib.parse import quote

from boot_plan import canonical, seed
from controller import dependency_entries, product_entries
from kit_media import assemble, pinned, seal
from private_export import attempt_fields
from readonly_iso import Member, build, memory, need, verify


HERE=Path(__file__).resolve().parent
MIB=2**20
TRANSACTION='bab31cbbe0e4b4cf8c2cb976571147be182d5ebda2fea9afbe03635debf61fb3'
NODE_SIZE=126_881_248
NODE_SHA='904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52'
NODE_TAR_SIZE=58_299_872
NODE_TAR_SHA='361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9'
PROJECT_SHA='16f282d9fa62974da2e69d522b9f0eaef0da5f44ae90a132c5baf85ec8f6415a'
CONTROL_NAMES=('LOADER-REFERENCE.json','archive_inventory.py','consent.py','controller.py',
               'envelope_stage.py','filesystem.py','folder_actor.py','guest_backend.py','guest_entry.py',
               'guest_install_gate.py','kit_media.py','loader_gate.py','pty_actor.py','readonly_iso.py')
SNAPSHOT='https://snapshot.ubuntu.com/ubuntu/20261120T060000Z/'


def digest(body):
    return sha256(body).hexdigest()


def store(path,body):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC
    with os.fdopen(os.open(path,flags,0o400),'wb') as stream:
        stream.write(body)


def make_node(producer_inputs,producer_control,archive_pin,target):
    node_archive=pinned(producer_inputs/'provider'/archive_pin.name,64*MIB,NODE_TAR_SIZE,NODE_TAR_SHA)
    reader=producer_control/'recipe/linux-provider-rehearsal.py'
    pinned(reader,256*1024,digest='ba8d05fed245056ce7383e2d10a682d7725aef04cf371110d757211a1680a9f9')
    spec=importlib.util.spec_from_file_location('hub_reviewed_node_reader',reader)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    mode,node=module.data_archive(node_archive,module.PREFIX,256*MIB,{'bin/node'})['bin/node']
    need((mode,len(node),digest(node))==(0o755,NODE_SIZE,NODE_SHA),'node-exact-publisher-member')
    store(target,node)
    return Member('NODE.BIN',target,NODE_SIZE,NODE_SHA)


def project(producer_inputs):
    def source(path,pin):
        if path=='folder-envelope.mjs':
            current=HERE/path
        elif path=='package.json':
            current=HERE/'helper-profile.json'
        else:
            current=producer_inputs/'base'/path
        need(current.resolve(strict=True)==current,'helper-source-canonical')
        return pinned(current,MIB,pin['bytes'],pin['sha256'])
    entries=assemble(pinned(HERE/'HELPER-INPUTS.json',65536),source,producer_inputs/'registry')
    tar,manifest=seal(entries)
    closed=json.loads(pinned(HERE/'KIT-RECEIPT.json',65536))
    need(digest(tar)==PROJECT_SHA==closed['projectTarSHA256'] and len(tar)==closed['projectTarBytes']
         and manifest==closed['sourceAndModePins'] and len(manifest)==161,'helper-realized-lock-pin')
    return tar,canonical(manifest)


def packages(path,fetch,deadline):
    lock=pinned(HERE/'GUEST-TRANSACTION.json',65536,digest=TRANSACTION)
    plan=json.loads(lock)
    rows=plan['entries']
    need(len(rows)==67 and sum(row['compressed_bytes'] for row in rows)==55561760 and
         plan['snapshot']==SNAPSHOT,'guest-package-lock-roster')
    def acquire(row):
        leaf, file=row['cacheName'],row['filename']
        need(re.fullmatch(r'[A-Za-z0-9+_.%~:-]+\.deb',leaf) and
             re.fullmatch(r'pool/[a-z0-9+/._~%-]+\.deb',file,re.ASCII|re.IGNORECASE) and
             PurePosixPath(file).as_posix()==file and '..' not in PurePosixPath(file).parts,
             'guest-package-public-pool-name')
        fetch(SNAPSHOT+quote(file,safe='/._-~+%'),path/leaf,row['compressed_bytes'],row['sha256'],deadline)
    with ThreadPoolExecutor(max_workers=6) as tasks:
        for i in range(0,len(rows),6):
            list(tasks.map(acquire,rows[i:i+6]))
    return dependency_entries(lock,TRANSACTION,path)


def seal_images(exported, attempt, node, deps, kit, inputs, nonce, deadline):
    product=product_entries(exported,attempt_fields(attempt),nonce,TRANSACTION)
    project_tar,project_manifest=kit
    holder,_=seal({name:(0o644,pinned(HERE/name,2*MIB)) for name in CONTROL_NAMES})
    boot=pinned(HERE/'guest_boot.py',65536)
    setup=canonical({'attempt':attempt_fields(attempt),'nonce':nonce,'transactionSHA256':TRANSACTION,
                     'productBindingSHA256':product[-1].sha256,'projectSHA256':digest(project_tar),
                     'projectManifestSHA256':digest(project_manifest),'actorSHA256':digest(holder),
                     'virtualBytes':10*2**30,'overlayCapBytes':4*2**30})
    support=[*deps,node,memory('PROJECT.TAR',project_tar),memory('PROJ.JSN',project_manifest),
             memory('ACTOR.TAR',holder),memory('BOOT.PY',boot),memory('QUALIFY.JSN',setup)]
    digests={}
    def within():
        need(monotonic()<deadline,'private-media-phase-time')
    for file,label,rows,cap in (('payload.iso','HUB_PAYLOAD',product,288*MIB),
                                ('support.iso','HUB_DEPS',support,192*MIB)):
        expected=build(inputs/file,label,rows,cap,check=within)
        need(expected==verify(inputs/file,label,rows,cap,check=within),'closed-original-media-readback')
        digests[file]=expected
    return seed(nonce,digest(boot),digest(setup)),digests
