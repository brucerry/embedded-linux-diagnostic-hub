"""Render the no-product venue witness seed. This module starts no subprocesses."""

import json
import re

def need(value, label):
    if not value:
        raise ValueError(label)


def sha(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{64}',value) is not None


PROPOSED_BRANCH = 'refs/heads/ci/v060-noble-qemu-folder-venue-20261123'
JOB_SECONDS = 720
INTAKE_AND_PREFLIGHT_SECONDS = 240
BOOT_SECONDS = 400
RETIREMENT_SECONDS = 80
SERIAL_LIMIT = 256*1024


def seed(nonce):
    need(sha(nonce),'venue-nonce')
    # This is a fixed stock shell action. It reads boot state and emits one private receipt.
    shell = '''set -eu
mark() { printf '%s %s %s\\n' HUB_NOBLE_VENUE NONCE "$1" > /dev/ttyS0; }
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


def receipt(serial, nonce, normal_exit, retired):
    need(sha(nonce) and 0 < len(serial) <= SERIAL_LIMIT and normal_exit is True and retired is True,
         'venue-serial-or-retirement')
    lines = serial.splitlines()
    matching = [(i,line) for i,line in enumerate(lines) if b'HUB_NOBLE_VENUE' in line]
    need(len(matching)==1 and matching[0][1]==f'HUB_NOBLE_VENUE {nonce} loopback-only'.encode(),
         'venue-loopback-receipt')
    poweroff = [i for i,line in enumerate(lines)
                if re.fullmatch(rb'(?:\[\s*\d+(?:\.\d+)?\]\s+)?reboot: Power down',line)]
    need(len(poweroff)==1 and poweroff[0]>matching[0][0],'venue-normal-poweroff')
    return ('loopback-only','normal-poweroff','process-retired')
