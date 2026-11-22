"""Build one tar.gz in the pinned, network-none Noble worker."""
from collections import deque
from contextlib import contextmanager
import ctypes
from hashlib import sha1, sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import zipfile

import compiler_gate as compiler
import dependencies
import reproduction as providers
import tar_admission as pins


INPUTS = Path('/inputs')
WORK = Path('/work')
SCRATCH = Path('/scratch')
FLOOR = 4 * 1024**3
CONTROL = Path(__file__).resolve().parent
GNU_LOADER = Path(compiler.INTERPRETER)
CAPS = {WORK:10*1024**3,SCRATCH:768*1024**2}
PROC_FILE_MASKS = {f'/proc/{name}' for name in (
    'interrupts', 'kcore', 'keys', 'latency_stats', 'timer_list', 'timer_stats', 'sched_debug',
)}


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def mount_readback(body, device):
    mounts={}
    masks={}
    pseudo={'/proc':'proc','/dev':'tmpfs','/dev/pts':'devpts','/dev/mqueue':'mqueue'}
    for line in body.splitlines():
        first,last=line.split(' - ',1)
        fields=first.split()
        number,root,dest,flags=fields[2],fields[3],fields[4],set(fields[5].split(','))
        fs=last.split()[0]
        need(dest not in mounts,'unique-worker-mount')
        mounts[dest]=(flags,fs)
        if dest in PROC_FILE_MASKS:
            need(fs=='tmpfs' and root=='/null','stock-mask-mount')
            masks[dest]=number
            continue
        if 'rw' in flags:
            if dest in {str(root) for root in CAPS}:
                need(fs=='tmpfs' and {'rw','nosuid','nodev'}<=flags and 'noexec' not in flags,'writable-tmpfs-options')
            else:
                need(pseudo.get(dest)==fs,'unexpected-writable-mount')
    null=device('/dev/null')
    need(stat.S_ISCHR(null.st_mode) and (os.major(null.st_rdev),os.minor(null.st_rdev))==(1,3) and
         '/proc/keys' in masks,'stock-null-identity')
    for path,number in masks.items():
        observed=device(path)
        need(number==f'{os.major(null.st_dev)}:{os.minor(null.st_dev)}' and
             (observed.st_mode,observed.st_rdev,observed.st_dev,observed.st_ino)==
             (null.st_mode,null.st_rdev,null.st_dev,null.st_ino),'stock-mask-identity')
    for place in ('/','/inputs','/control','/etc/hosts','/etc/hostname','/etc/resolv.conf'):
        need(place in mounts and 'ro' in mounts[place][0],'read-only-worker-boundary')
    return mounts


def effective_worker():
    uid,gid=os.geteuid(),os.getegid()
    need(os.getuid()==uid!=0 and os.getgid()==gid!=0 and os.uname().machine=='x86_64','nonroot-worker')
    status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines())
    need(status['Seccomp'].strip()=='2' and status['NoNewPrivs'].strip()=='1' and
         all(int(status[key].strip(),16)==0 for key in ('CapEff','CapPrm','CapBnd','CapAmb')),'stock-sandbox-security')
    need({entry.name for entry in Path('/sys/class/net').iterdir()}=={'lo'} and
         all(line.split()[0]=='lo' for line in Path('/proc/net/route').read_text().splitlines()[1:] if line.split()) and
         all(line.split()[-1]=='lo' for line in Path('/proc/net/ipv6_route').read_text().splitlines() if line.split()),'loopback-only')
    mounts=mount_readback(Path('/proc/self/mountinfo').read_text(),os.lstat)
    need(all(place in mounts or not os.path.lexists(place) for place in PROC_FILE_MASKS),'stock-mask-presence')
    for root,size in CAPS.items():
        need(root.resolve()==root and not any(root.iterdir()),'fresh-private-tmpfs')
        row=root.lstat()
        fs=os.statvfs(root)
        need(mounts[str(root)][1]=='tmpfs' and (row.st_uid,row.st_gid,stat.S_IMODE(row.st_mode))==(uid,gid,0o700)
             and fs.f_blocks*fs.f_frsize==size,'actual-tmpfs-ceiling-and-owner')
    need(os.readlink('/proc/self/ns/pid')==os.readlink('/proc/1/ns/pid') and os.getpid()==1,'job-private-pid-one')


def loader_map(body, resolve=lambda value: str(Path(value).resolve(strict=True))):
    result={}
    for line in body.decode('ascii').splitlines():
        entry=re.fullmatch(r'\s*(\S+)(?: => (/\S+))? \(0x[0-9a-f]+\)',line)
        need(entry,'stock-loader-framing')
        name,path=entry.groups()
        if name=='linux-vdso.so.1':
            need(path is None,'vdso-form')
            continue
        if name.startswith('/'):
            need(name==str(GNU_LOADER),'loader-path-form')
            name,path=GNU_LOADER.name,path or name
        need(path is not None,'loader-library-path')
        need(name not in result,'unique-live-libraries')
        result[name]=resolve(path)
    return result


def closure(seed, roles):
    found={}
    queue=deque(seed)
    while queue:
        name=queue.popleft()
        if name in found:
            continue
        row=roles[name]
        found[name]=row['canonical']
        queue.extend(row['directNeeded'])
    return found


def compiled_root(configuration):
    pins.stock_native(configuration['NOBLE-COMPILER-REFERENCE.json'])
    abi=compiler.load_plan()
    compiler.readback(abi)
    need(not os.path.lexists('/etc/ld.so.preload'),'no-loader-preload')
    roles={Path(p).name:row for p,row in abi['elfMembersAndDirectResolution'].items()}
    targets={row['canonical']:list(row['directNeeded']) for row in roles.values()
             if row['interpreter'] and row['canonical'].startswith(('/usr/bin/','/usr/libexec/gcc/'))}
    plugin=abi['possibleLinkerPlugin']
    plugin_bytes=compiler.read_member(Path(plugin['canonical']),plugin['pin'],capture=True)
    _, linked=compiler.elf_identity(plugin_bytes)
    targets[plugin['canonical']]=linked
    for exe,dependencies in targets.items():
        env={'LANG':'C','PATH':'/usr/bin:/bin'}
        done=subprocess.run([GNU_LOADER,'--list',exe],env=env,capture_output=True,timeout=5)
        need(done.returncode==0 and not done.stderr and 0<len(done.stdout)<=8192,'live-loader-resolution')
        expected=closure([*dependencies,GNU_LOADER.name],roles)
        need(loader_map(done.stdout)==expected,'exact-live-compiler-loader-map')


def digest(raw):
    return sha256(raw).hexdigest()


def save(path, raw, mode):
    path.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    with path.open('xb') as file:
        file.write(raw)
        os.fchmod(file.fileno(),mode)


def project_from_base(output, config, vendored):
    manifest=config['SOURCE-FILES.json']
    by_path={p['path']:vendored[name] for name,p in config['BUILD-ADMISSION.json']['allFileProviders'].items()}
    by_path['.linux-package-inputs/electron.d.ts']=(INPUTS/'media/electron.d.ts').read_bytes()
    base=INPUTS/'base'
    original=config['BUILD-ADMISSION.json']
    need(digest(by_path['.linux-package-inputs/electron.d.ts'])==original['electronDeclarationSHA256'], 'electron-declaration')
    for rel,(oid,exec_bit) in manifest['files'].items():
        name=PurePosixPath(rel)
        need(str(name)==rel and not name.is_absolute() and '..' not in name.parts,'source-path')
        if rel in by_path:
            body=by_path[rel]
        else:
            file=base/rel
            info=file.lstat()
            need(file.resolve()==file and stat.S_ISREG(info.st_mode) and info.st_nlink==1 and
                 info.st_size<=32*1024**2 and bool(info.st_mode&0o111)==exec_bit,'source-custody')
            body=file.read_bytes()
        need(sha1(f'blob {len(body)}\0'.encode()+body).hexdigest()==oid,'exact-product-blob')
        save(output/rel,body,0o700 if exec_bit else 0o600)
    pins.source(output, manifest)
    pins.providers(output/'vendor',original)


def sdk_and_electron(output,sdk,config):
    media=config['CUSTODY.json']['officialMediaReadback']
    specs=config['SDK-MEMBERS.json']
    node=INPUTS/'provider/node'
    electron=INPUTS/'media/electron.zip'
    for key,path in [('node',node),('electron',electron)]:
        _, hashes, _=pins.file_data(path,key,byte_count=media[key]['bytes'])
        need(hashes['sha256']==media[key]['sha256'],'official-distribution-pin')
    selected=set(specs['node'])
    prefix='node-v24.22.2-linux-x64/'
    with tarfile.open(node,mode='r|gz') as archive:
        for item in archive:
            name=item.name.removeprefix(prefix)
            if not item.name.startswith(prefix) or name not in specs['node']:
                continue
            need(name in selected,'sdk-duplicate')
            selected.remove(name)
            pin=specs['node'][name]
            if 'link' in pin:
                need(name=='bin/npm' and item.issym() and item.linkname==pin['link'],'sdk-npm-link')
                continue
            need(item.isreg() and item.size==pin['bytes'] and bool(item.mode&0o111)==pin['exec'],'official-sdk-member')
            body=archive.extractfile(item).read()
            need(digest(body)==pin['sha256'],'official-sdk-member-digest')
            save(sdk/name,body,0o700 if pin['exec'] else 0o600)
    need(not selected,'official-sdk-member-roster')
    (sdk/'bin/npm').symlink_to(specs['node']['bin/npm']['link'])
    target=output/pins.ELECTRON
    with zipfile.ZipFile(electron) as archive:
        members=archive.infolist()
        names={x.filename for x in members}
        need(len(names)==len(members) and names==specs['electron'].keys(),'official-electron-roster')
        for member in members:
            expect=specs['electron'][member.filename]
            mode=member.external_attr>>16
            need(stat.S_ISREG(mode) and member.file_size==expect['bytes'] and bool(mode&0o111)==expect['exec'],'official-electron-member')
            body=archive.read(member)
            need(digest(body)==expect['sha256'],'official-electron-member-digest')
            save(target/member.filename,body,0o700 if expect['exec'] else 0o600)
    pins.sdk_members(sdk,target,specs)


def drain_owned():
    while True:
        try:
            pid,status=os.waitpid(-1,os.WNOHANG)
        except ChildProcessError:
            return
        need(pid>0 and os.WIFEXITED(status) and os.WEXITSTATUS(status)==0,'owned-worker-descendants')


@contextmanager
def phase(name):
    try:
        yield
    except Exception:
        print(f'HUB_TAR_PHASE {name} fail', flush=True)
        raise
    print(f'HUB_TAR_PHASE {name} pass', flush=True)


def compile_and_package(run_id):
    os.umask(0o077)
    with phase('runtime'):
        effective_worker()
        config=pins.pins()
        compiled_root(config)
        need(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'build-worker-subreaper')
    with phase('providers'):
        scope=providers.load_plan()
        lookup={p.url:p for p in scope}
        def fetch(url, size):
            pin=lookup[url]
            need(pin.size==size,'closed-provider-input-url')
            file=INPUTS/'provider'/pin.name
            _, hashes, _=pins.file_data(file,'public-provider-body',byte_count=size)
            need(hashes['sha256']==pin.sha256,'exact-provider-input')
            raw=providers.check_bytes(file.read_bytes(),pin)
            if pin.git_blob is not None:
                need(sha1(f'blob {size}\0'.encode()+raw).hexdigest()==pin.git_blob,'source-git-blob')
            return raw
        providers.archive_inputs(fetch)
        code,tool,cfg=providers.recipe_objects()
        provider=SCRATCH/'compiler'
        provider.mkdir(mode=0o700)
        go=provider/'go/bin/go'
        approved={go:cfg['go']['executables']['go/bin/go'],provider/'tool/node':tool.NODE_SHA,
                  provider/'esbuild':cfg['esbuild']['binarySHA256']}
        def provider_run(argv,cwd,env,seconds):
            role=Path(argv[0])
            need(role in approved and role.resolve()==role and digest(role.read_bytes())==approved[role], 'exact-provider-tool')
            out=code.command(argv,cwd,{**env,'TMPDIR':env.get('TMPDIR',str(provider/'temp'))},seconds)
            drain_owned()
            return out
        (provider/'temp').mkdir(mode=0o700)
        archives=providers.assemble_providers(provider,fetch,provider_run)
    with phase('installed'):
        native=WORK/'source'
        sdk=WORK/'node-sdk'
        project_from_base(native,config,archives)
        sdk_and_electron(native,sdk,config)
        files=INPUTS/'registry'
        pins.registry(files,config['REGISTRY-PLAN.json'],native/'package-lock.json')
        pins.native_ancestors(native)
        pins.native_ancestors(sdk/'include/node')
        fs=os.statvfs(WORK)
        need(fs.f_bavail*fs.f_frsize>=FLOOR,'native-post-staging-floor')
        need(not any(os.path.lexists(native/name) for name in ('node_modules','dist','dist-electron','dist-linux-native','release')),
             'fresh-product-build-paths')
        for name in ('home','temp','builder-tmp','npm-cache'):
            (WORK/name).mkdir(mode=0o700)
        for cfgname in ('global.npmrc','user.npmrc'):
            (WORK/cfgname).touch(exist_ok=False,mode=0o600)
        env={'PATH':f'{sdk}/bin:/usr/bin:/bin','LANG':'C.UTF-8','CI':'true','HOME':'/work/home','TMPDIR':'/work/temp',
             'APP_BUILDER_TMP_DIR':'/work/builder-tmp','npm_config_cache':'/work/npm-cache',
             'npm_config_globalconfig':'/work/global.npmrc','npm_config_userconfig':'/work/user.npmrc',
             'npm_config_offline':'true','npm_config_audit':'false','npm_config_fund':'false',
             'npm_config_update_notifier':'false'}
        node=sdk/'bin/node'
        npm=[node,sdk/'lib/node_modules/npm/bin/npm-cli.js']
        def command(argv, max_seconds):
            result=code.command(argv,native,env,max_seconds)
            drain_owned()
            return result[0]
        need(command([node,'--version'],10)==b'v24.22.2\n','approved-node-runtime')
        package_lock=(native/'package-lock.json').read_bytes()
        raw=json.loads(package_lock)['packages']
        local={name for name,row in raw.items() if row.get('resolved','').startswith('file:vendor/')}
        registry={name for row in config['REGISTRY-PLAN.json'].values() for name in row['slots']}
        need(len(registry)==306 and len(local)==8 and not local&registry,'installed-placement-plan')
        placements={name:raw[name] for name in sorted(registry|local)}
        expected,links=dependencies.dependency_expectations(native,files,placements)
        cache=sorted(files.iterdir())
        for index in range(0,len(cache),24):
            command([*npm,'cache','add','--offline',*cache[index:index+24]],30)
        command([*npm,'ci','--offline','--no-audit','--no-fund','--no-update-notifier','--os=linux','--cpu=x64'],120)
        dependencies.installed_readback(native,placements,expected,links)
        need((native/'package-lock.json').read_bytes()==package_lock,'unchanged-verified-lock')
    with phase('build'):
        command([*npm,'run','build'],150)
        command([*npm,'run','build:linux-native'],45)
        command([node,native/'node_modules/electron-builder/out/cli/cli.js','--linux','tar.gz','--x64','--publish','never'],180)
    with phase('archive'):
        proof=CONTROL/'tar-proof.mjs'
        command([node,proof,native,'capture-checksum'],45)
        report=json.loads(command([node,proof,native,'verify'],120))
        need(report['productTree']==pins.TREE and report['lockSHA256']==pins.LOCK and
             re.fullmatch(r'[0-9a-f]{64}',report['artifact']['sha256']) and len(report['members'])==4 and {item['path']:item['mode'] for item in report['members']} == {
                 'resources/linux-installed-AppRun':0o755,
                 'resources/linux-setup-bootstrap.cjs':0o644,
                 'resources/linux-setup-install.cjs':0o644,
                 'resources/diagnostic_hub_rename_noreplace.node':0o644,
             },'closed-tar-proof')
    return report['artifact']['sha256']


if __name__=='__main__':
    try:
        bound,=sys.argv[1:]
        need(re.fullmatch(r'[1-9][0-9]{0,18}-1',bound),'run-identity')
        result=compile_and_package(bound)
        print(f'HUB_TAR_BUILD_AND_READBACK_OK {bound} {result}')
    except Exception:
        raise SystemExit(1) from None
