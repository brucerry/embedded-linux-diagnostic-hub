"""Render the no-product venue witness seed. This module starts no subprocesses."""

import json
import re

def need(value, label):
    if not value:
        raise ValueError(label)


def sha(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{64}',value) is not None


PROPOSED_BRANCH = 'refs/heads/ci/v060-noble-qemu-folder-venue-boot-verdicts-20261123'
JOB_SECONDS = 720
INTAKE_AND_PREFLIGHT_SECONDS = 240
BOOT_SECONDS = 400
RETIREMENT_SECONDS = 80
SERIAL_LIMIT = 256*1024
BOOT_EXEC_FRAME = b'HUB_QEMU_READY_TO_EXEC'
GUEST_STAGES = ('boot_exec','guest_kernel','guest_nocloud','guest_sentinel','guest_loopback','guest_poweroff')


def seed(nonce):
    need(sha(nonce),'venue-nonce')
    # This is a fixed stock shell action. It reads boot state and emits one private receipt.
    shell = '''set -eu
mark() { printf '%s %s %s\\n' HUB_JAMMY_VENUE NONCE "$1" > /dev/ttyS0; }
mark begin
set -- /sys/class/net/*
[ "$#" -eq 1 ] && [ "$1" = /sys/class/net/lo ] || { mark refuse; exit 1; }
for family in -4 -6; do
    table=$(/usr/sbin/ip -o "$family" route show table all) || { mark refuse; exit 1; }
    if ! printf '%s\\n' "$table" | awk 'NF && ($0 !~ / dev lo( |$)/ || $0 ~ /(^default |(^| )via )/) { exit 1 }'; then
        mark refuse
        exit 1
    fi
done
mark loopback-only
'''.replace('NONCE',nonce)
    user = {
        'users':[], 'disable_root':True, 'ssh_pwauth':False, 'ssh_genkeytypes':[],
        'growpart':{'mode':'off'}, 'resize_rootfs':False, 'package_update':False,
        'package_upgrade':False, 'runcmd':[['/bin/sh','-ec',shell]],
        'power_state':{'mode':'poweroff','delay':'now','timeout':60},
    }
    user_data = ('#cloud-config\n'+json.dumps(user,sort_keys=True,indent=2)+'\n').encode()
    meta_data = f'instance-id: hub-venue-{nonce}\nlocal-hostname: hub-venue\n'.encode()
    return {'user-data':user_data,'meta-data':meta_data}


def boot_evidence(wire, nonce):
    """Reduce bounded private console output to fixed phase verdicts."""
    need(sha(nonce) and len(wire) <= SERIAL_LIMIT,'venue-serial-bound')
    exec_frame, sep, serial = wire.partition(b'\n')
    evidence = {'boot_exec':bool(sep and exec_frame==BOOT_EXEC_FRAME)}
    if not evidence['boot_exec']:
        return evidence
    lines = serial.splitlines()
    kernel = [i for i,line in enumerate(lines)
              if re.fullmatch(rb'\[\s*0\.0+\] Linux version [0-9][^\r\n]+',line)]
    evidence['guest_kernel'] = len(kernel)==1
    if not evidence['guest_kernel']:
        return evidence
    poweroff = [i for i,line in enumerate(lines)
                if re.fullmatch(rb'(?:\[\s*\d+(?:\.\d+)?\]\s+)?reboot: Power down',line)]
    end = poweroff[0] if len(poweroff)==1 else len(lines)
    cloud = [i for i,line in enumerate(lines)
             if re.fullmatch(rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
                             rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',line)]
    evidence['guest_nocloud'] = len(cloud)==1 and kernel[0]<cloud[0]<end
    markers = [(i,line) for i,line in enumerate(lines) if b'HUB_JAMMY_VENUE' in line]
    begin = f'HUB_JAMMY_VENUE {nonce} begin'.encode()
    success = f'HUB_JAMMY_VENUE {nonce} loopback-only'.encode()
    evidence['guest_sentinel'] = bool(markers and markers[0][1]==begin
                                     and kernel[0]<markers[0][0]<end)
    evidence['guest_loopback'] = (evidence['guest_sentinel'] and len(markers)==2
                                  and markers[1][1]==success and markers[1][0]<end)
    evidence['guest_poweroff'] = len(poweroff)==1 and kernel[0]<poweroff[0]
    return evidence
