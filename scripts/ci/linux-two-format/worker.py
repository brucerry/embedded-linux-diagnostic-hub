"""Build one tar.gz in the pinned, network-none Noble worker."""
from collections import deque
from contextlib import contextmanager
import ctypes
from functools import partial
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

import build_layout as layout_rules
import compiler_gate as compiler
import dependencies
import reproduction as providers
import tar_admission as pins
import extract_adapter
import package_pair
from worker_protocol import ArchiveVerificationRefused, CLOSURE_STAGES


INPUTS = Path('/inputs')
WORK = Path('/work')
SCRATCH = Path('/scratch')
FLOOR = 4 * 1024**3
CONTROL = Path(__file__).resolve().parent
GNU_LOADER = Path(compiler.INTERPRETER)
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
        first,sep,last=line.partition(' - ')
        fields,tail=first.split(),last.split()
        need(sep and len(fields)>=6 and len(tail)>=3,'mountinfo-framing')
        number,root,dest,flags=fields[2],fields[3],fields[4],set(fields[5].split(','))
        fs=tail[0]
        need(dest not in mounts,'unique-worker-mount')
        mounts[dest]=(flags,fs)
        if dest in PROC_FILE_MASKS:
            need(fs=='tmpfs' and root=='/null','stock-mask-mount')
            masks[dest]=number
            continue
        if dest in layout_rules.MOUNTS:
            _,execute=layout_rules.MOUNTS[dest]
            need(fs=='tmpfs' and root=='/' and {'rw','nosuid','nodev'}<=flags
                 and 'ro' not in flags and ('noexec' in flags)==(execute=='noexec'),
                 'writable-tmpfs-options')
        elif 'rw' in flags:
            need(pseudo.get(dest)==fs,'unexpected-writable-mount')
    null=device('/dev/null')
    need(stat.S_ISCHR(null.st_mode) and (os.major(null.st_rdev),os.minor(null.st_rdev))==(1,3),
         'stock-null-identity')
    for path,number in masks.items():
        observed=device(path)
        need(number==f'{os.major(null.st_dev)}:{os.minor(null.st_dev)}' and
             (observed.st_mode,observed.st_rdev,observed.st_dev,observed.st_ino)==
             (null.st_mode,null.st_rdev,null.st_dev,null.st_ino),'stock-mask-identity')
    for place in ('/','/inputs','/control','/etc/hosts','/etc/hostname','/etc/resolv.conf'):
        need(place in mounts and 'ro' in mounts[place][0] and 'rw' not in mounts[place][0],
             'read-only-worker-boundary')
    need(layout_rules.MOUNTS.keys() <= mounts.keys(), 'expected-private-mounts')
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
    for place in sorted(PROC_FILE_MASKS - mounts.keys()):
        try:
            os.lstat(place)
        except FileNotFoundError:
            continue
        raise ValueError('stock-mask-presence')
    for place,(size,_) in layout_rules.MOUNTS.items():
        root=Path(place)
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
            if name == 'bin/node':
                info, hashes, _ = pins.file_data(sdk/name, 'staged-sdk-node', byte_count=pin['bytes'])
                need(hashes['sha256']==pin['sha256'] and stat.S_IMODE(info.st_mode)==0o700,
                     'staged-sdk-node-identity')
            else:
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


class ProcessClosureRefused(ValueError):
    pass


def drain_owned():
    while True:
        try:
            pid,status=os.waitpid(-1,os.WNOHANG)
        except ChildProcessError:
            return
        if not (pid>0 and os.WIFEXITED(status) and os.WEXITSTATUS(status)==0):
            raise ProcessClosureRefused('owned-worker-descendants')


@contextmanager
def phase(name, *, stream=None):
    try:
        yield
    except Exception as error:
        suffix = ' closure' if name in CLOSURE_STAGES and isinstance(error, ProcessClosureRefused) else ''
        if name == 'archive_verification' and isinstance(error, ArchiveVerificationRefused):
            suffix = f' verifier {error.condition} {error.retirement}'
        print(f'HUB_PAIR_PHASE {name} fail{suffix}', file=stream, flush=True)
        raise
    print(f'HUB_PAIR_PHASE {name} pass', file=stream, flush=True)


def compile_and_package(run_id):
    os.umask(0o077)
    with phase('runtime'):
        effective_worker()
        config=pins.pins()
        compiled_root(config)
        need(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'build-worker-subreaper')
    with phase('provider_layout'):
        code,tool,cfg=providers.recipe_objects()
        layout=layout_rules.ProviderLayout(WORK,SCRATCH,cfg['go']['executables'],
                                           tool.NODE_SHA,cfg['esbuild']['binarySHA256'])
        layout.begin()
        (layout.data/'temp').mkdir(mode=0o700)
    checkpoint = partial(phase, stream=sys.stdout)
    with checkpoint('provider_inputs'):
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
    with checkpoint('provider_node'):
        node_pin=tool.pins()['officialArchives']['node']
        node_archive=tool.match(fetch(node_pin['url'],node_pin['bytes']),node_pin,'official-node-archive')
        node=tool.data_archive(node_archive,tool.PREFIX,256*1024**2,{'bin/node'})['bin/node'][1]
        layout.stage_executable(layout.node,node,tool.save)
        del node_archive,node
        layout.check()

    def provider_run(argv,cwd,env,seconds):
        role=Path(argv[0])
        need(role in (layout.node,layout.goroot/'bin/go',layout.esbuild)
             and cwd.is_relative_to(layout.data) and cwd.resolve(strict=True)==cwd,
             'exact-provider-command')
        execution_env={'HOME':str(layout.data),'TMPDIR':str(layout.data/'temp'),**env}
        need(execution_env.get('PATH')=='/usr/bin:/bin'
             and (role!=layout.goroot/'bin/go' or execution_env.get('GOROOT')==str(layout.goroot)),
             'exact-provider-tool-resolution')
        for key in ('HOME','TMPDIR','GOPATH','GOCACHE','GOMODCACHE'):
            if key in execution_env:
                location=Path(execution_env[key])
                need(location.is_relative_to(layout.data) and location.resolve(strict=True)==location,
                     'provider-data-write-path')
        layout.check()
        try:
            out=code.command(argv,cwd,execution_env,seconds)
        except code.CompilerClosureRefused as error:
            raise ProcessClosureRefused('owned-worker-process-group') from error
        drain_owned()
        layout.check()
        return out

    archives=providers.assemble_providers(layout.data,fetch,provider_run,layout,checkpoint=checkpoint)
    with checkpoint('provider_process_closure'):
        drain_owned()
    with checkpoint('providers'):
        layout.check()
        layout.retire()
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
    with phase('packer_preload'):
        need(not os.path.lexists('/etc/ld.so.preload'), 'no-loader-preload')
    tools = WORK/'appimage-tools'
    def loader_command(argv, loader_env, seconds):
        out,_ = code.command([str(part) for part in argv],native,loader_env,seconds)
        drain_owned()
        return out
    tool_receipt = package_pair.stage_tools(INPUTS/'media/appimage-tools.tar.gz', tools,
        config['APPIMAGE-TOOLS.json'],GNU_LOADER,loader_map,loader_command,phase=phase)
    with phase('packer'):
        attempt = package_pair.live_attempt(INPUTS/'attempt.json',run_id,tool_receipt)
        env['APPIMAGE_TOOLS_PATH'] = str(tools)
    with phase('build'):
        space = os.statvfs(WORK)
        need(space.f_bavail*space.f_frsize >= 2*1024**3,'post-install-package-headroom')
        need(not os.path.lexists(native/'release'),'fresh-package-output')
        command([*npm,'run','package:linux'],300)
    release=native/'release'
    with phase('appimage_envelope'):
        seal=package_pair.appimage_envelope(release,attempt)
    if package_pair.EXTRACTION_POLICY_REVIEWED:
        extract_adapter.verify_once(native,release,attempt,seal,node,npm,env,
            config['READER-DATA-RECEIPT.json'],loader_map,drain_owned,phase=phase)
    else:
        with phase('archive_verification'):
            handoff = package_pair.handoff
            handoff.recheck_for_verifier(release,attempt,seal)
    with phase('original_evidence'):
        # Official recorder is deliberately the build-only/unperformed-runtime record.
        # Only the recorder receives the already bound checkout SHA.
        package_pair.copy_launcher(native,release)
        record_env={**env,'GITHUB_SHA':attempt.source_commit}
        code.command([node,native/'scripts/record-linux-build.mjs'],native,record_env,30)
        drain_owned()
        command([*npm,'run','checksums'],30)
        digests=package_pair.evidence(release,attempt,seal)
    with phase('tar_original_members'):
        proof=CONTROL/'tar-proof.mjs'
        report=json.loads(command([node,proof,native,'verify'],120))
        need(report['productTree']==pins.TREE and report['lockSHA256']==pins.LOCK and
             report['artifact']['sha256']==digests[0] and len(report['members'])==4 and
             {item['path']:item['mode'] for item in report['members']} == {
                 'resources/linux-installed-AppRun':0o755,
                 'resources/linux-setup-bootstrap.cjs':0o644,
                 'resources/linux-setup-install.cjs':0o644,
                 'resources/diagnostic_hub_rename_noreplace.node':0o644,
             },'closed-tar-proof')
        need(package_pair.evidence(release,attempt,seal)==digests,'pair-closure')
        drain_owned()
    return attempt.worker_binding,digests,('verified' if package_pair.EXTRACTION_POLICY_REVIEWED else 'held')



def entry(argv):
    try:
        bound,=argv
        need(re.fullmatch(r'[1-9][0-9]{0,18}-1',bound),'run-identity')
        binding,digests,extraction=compile_and_package(bound)
        print('HUB_PAIR_DATA_OK '+bound+' '+binding+' '+extraction+' '+' '.join(digests),flush=True)
    except Exception:
        return 1
    return 0


if __name__=='__main__':
    raise SystemExit(entry(sys.argv[1:]))
