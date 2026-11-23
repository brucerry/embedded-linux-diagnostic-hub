"""Bind the private guest inputs and reduce its bounded, held serial evidence."""
from hashlib import sha256
import json
import re


STAGES=('guest_identity','readonly_media','guest_disk','guest_solver','guest_transaction',
        'guest_account','realized_helpers','native_install_removal')
HEAD=b'HUB_QEMU_READY_TO_EXEC'
PREFIX=b'HUB_NOBLE_FOLDER '
SERIAL_LIMIT=256*1024


def need(value,label):
    if not value:
        raise ValueError(label)


def canonical(data):
    return (json.dumps(data,sort_keys=True,separators=(',',':'))+'\n').encode('ascii')


def seed(nonce,boot_pin,binding_pin):
    need(all(re.fullmatch(r'[a-f0-9]{64}',arg) for arg in (nonce,boot_pin,binding_pin)),
         'folder-seed-pins')
    command=f'''set -eu
[ "$(id -u)" = 0 ]
set -- /sys/class/net/*
[ "$#" = 1 ] && [ "$1" = /sys/class/net/lo ]
[ "$(cat /sys/class/block/vda/size)" = 20971520 ]
mkdir -m 0755 /mnt/hub-payload /mnt/hub-deps
mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal LABEL=HUB_PAYLOAD /mnt/hub-payload
mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal LABEL=HUB_DEPS /mnt/hub-deps
printf '%s  %s\\n' {boot_pin} /mnt/hub-deps/boot.py | /usr/bin/sha256sum -c --status
exec /usr/bin/python3.12 -I -B /mnt/hub-deps/boot.py {nonce} {binding_pin}
'''
    cfg={'users':[], 'disable_root':True,'ssh_pwauth':False,'ssh_genkeytypes':[],
         'growpart':{'mode':'off'},'resize_rootfs':False,'package_update':False,
         'package_upgrade':False,'runcmd':[['/bin/sh','-ec',command]],
         'power_state':{'mode':'poweroff','delay':'now','timeout':60}}
    return {'user-data':b'#cloud-config\n'+canonical(cfg),
            'meta-data':f'instance-id: hub-folder-{nonce}\nlocal-hostname: hub-folder\n'.encode()}


def classify(output,nonce):
    need(type(output) is bytes and len(output)<=SERIAL_LIMIT and re.fullmatch(r'[a-f0-9]{64}',nonce),
         'guest-private-serial-bound')
    rows=output.splitlines()
    results={name:'unreached' for name in ('boot_exec','guest_kernel','guest_nocloud',*STAGES,'guest_poweroff')}
    need(rows[:1]==[HEAD] and rows.count(HEAD)==1,'guest-exec-frame')
    results['boot_exec']='pass'
    kernel=[idx for idx,row in enumerate(rows) if re.fullmatch(rb'\[\s*0\.0+\] Linux version [0-9][^\r\n]+',row)]
    cloud=[idx for idx,row in enumerate(rows) if re.fullmatch(
        rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
        rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',row)]
    stop=[idx for idx,row in enumerate(rows) if re.fullmatch(rb'(?:\[\s*\d+(?:\.\d+)?\]\s+)?reboot: Power down',row)]
    if len(kernel)!=1:
        results['guest_kernel']='fail'
        return results
    k=kernel[0]
    results['guest_kernel']='pass'
    boundary=stop[0] if len(stop)==1 else len(rows)
    results['guest_poweroff']='pass' if len(stop)==1 and k<boundary else 'fail'
    results['guest_nocloud']='pass' if len(cloud)==1 and k<cloud[0]<boundary else 'fail'
    for step,(idx,row) in enumerate((i,line) for i,line in enumerate(rows) if PREFIX in line):
        need(k<idx<boundary and (len(cloud)!=1 or idx<cloud[0]) and step<len(STAGES) and
             (step==0 or results[STAGES[step-1]]=='pass'),'guest-stage-order')
        name=STAGES[step]
        header=PREFIX+nonce.encode()+b' '+name.encode()+b' '
        need(row in (header+b'pass',header+b'fail'),'guest-stage-frame')
        results[name]=row[len(header):].decode('ascii')
    return results
