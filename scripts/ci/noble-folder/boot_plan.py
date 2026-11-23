"""Join the passed provisioning seed and the sealed private folder action."""
import json
import re

from transition_seed import boot_evidence, seed as provisioning_seed
from wire import EXTRA, PHASES

STAGES = ('guest_identity','readonly_media','guest_product_capacity',
          'guest_account','realized_helpers','native_install_removal')
OBSERVATIONS = ('boot_exec','guest_kernel','guest_nocloud','guest_sentinel',
                'guest_loopback','guest_poweroff',*PHASES,*STAGES,*EXTRA)
REQUIRED = tuple(key for key in OBSERVATIONS if key not in EXTRA)
PROVISION_PREFIX = b'HUB_NOBLE_PROVISION '
FOLDER_PREFIX = b'HUB_NOBLE_FOLDER '
SERIAL_LIMIT = 256 * 1024


def need(condition, label):
    if not condition:
        raise ValueError(label)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')


def seed(nonce, boot_pin, binding_pin):
    need(all(re.fullmatch('[a-f0-9]{64}', value) for value in (nonce,boot_pin,binding_pin)),
         'folder-seed-pins')
    files = provisioning_seed(nonce)
    config = json.loads(files['user-data'].split(b'\n',1)[1])
    [command] = config['runcmd']
    invocation = f'exec /usr/bin/python3.12 -I -B /mnt/hub-apt-witness/boot.py {nonce}\n'
    need(command[:2]==['/bin/sh','-ec'] and command[2].startswith('set -eu\n')
         and command[2].endswith(invocation),'sealed-provision-command')
    command[2] = command[2][:-len(invocation)] + invocation.removeprefix('exec ') + f'''
mkdir -m 0755 /mnt/hub-payload /mnt/hub-deps
/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal LABEL=HUB_PAYLOAD /mnt/hub-payload
/usr/bin/mount -t iso9660 -o ro,nodev,nosuid,noexec,map=normal LABEL=HUB_DEPS /mnt/hub-deps
printf '%s  %s\\n' {boot_pin} /mnt/hub-deps/boot.py | /usr/bin/sha256sum -c --status
exec /usr/bin/python3.12 -I -B /mnt/hub-deps/boot.py {nonce} {binding_pin}
'''
    files['user-data'] = b'#cloud-config\n' + canonical(config)
    return files


def classify(output, nonce):
    need(type(output) is bytes and len(output) <= SERIAL_LIMIT and
         re.fullmatch('[a-f0-9]{64}',nonce),'guest-private-serial-bound')
    verdicts = dict.fromkeys(OBSERVATIONS,'unreached')
    proven,metrics = boot_evidence(output,nonce)
    need(set(proven)<=set(REQUIRED) and set(metrics)<=set(EXTRA),'guest-closed-provision-receipt')
    verdicts.update({name:'pass' if value else 'fail' for name,value in proven.items()})
    verdicts.update(metrics)
    rows = output.splitlines()
    folder = [(i,row) for i,row in enumerate(rows) if b'HUB_NOBLE_FOLDER' in row]
    if not folder:
        return verdicts
    need(len(folder)<=len(STAGES) and all(proven.get(name) for name in REQUIRED if name not in STAGES),
         'folder-after-complete-provisioning')
    start = rows.index(PROVISION_PREFIX+nonce.encode()+b' prov_capacity pass')
    after = [i for i,row in enumerate(rows) if re.fullmatch(
        rb'\[\s*\d+\.\d+\] cloud-init\[\d+\]: Cloud-init v\. .+ finished at .+\. '
        rb'Datasource DataSourceNoCloud \[seed=/dev/sr0\]\. +Up \d+(?:\.\d+)? seconds',row)]
    for offset, (index,row) in enumerate(folder):
        name = STAGES[offset]
        prefix = FOLDER_PREFIX + nonce.encode() + b' ' + name.encode() + b' '
        need(start<index<after[0] and (not offset or verdicts[STAGES[offset-1]]=='pass')
             and row in (prefix+b'pass',prefix+b'fail'),'folder-order-or-receipt')
        verdicts[name] = row[len(prefix):].decode('ascii')
    return verdicts
