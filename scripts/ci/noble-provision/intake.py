AUTHENTICATED_RELEASES = {'noble': [254967, '58716ccd6ce78bf798b0f643bb4d0ebc71b5688cc8871aff81c2363ba9fa5755'], 'noble-security': [125244, '6ab90e45f1b0e9d4671ae1a3e3b0e791ec3ccda62d4776e1acfdaf38df8f7cb9'], 'noble-updates': [125242, 'ce485ccb879dfa3e7b70f0ecfddad51af82d6ef6c6d0f143c7d923351da57bd2']}

EXPECTED_POLICY = '8e0b11b057d980fffedb179f47a06e951b58ee842b3629e54742a5a8ccea5387'

import hashlib

import io

import json

import lzma

import os

import re

import resource

import stat

import subprocess

import sys

import tempfile

from datetime import datetime, timezone

from email.utils import parsedate_to_datetime

from pathlib import Path

REPO='brucerry/embedded-linux-diagnostic-hub'

BRANCH='ci/v060-noble-apt-runtime-observations-20261120'

WORKFLOW='.github/workflows/linux-noble-apt-simulation.yml'

JOB='noble-apt-provisioning'

GIB=1024**3

PUB='F6ECB3762474EDA9D21B7022871920D1991BC93C'

BASE_ABI='linux/amd64'

DOCKER='/usr/bin/docker'

SHA=lambda b:hashlib.sha256(b).hexdigest()

HEX=r'[0-9a-f]{64}'

SNAPSHOT='https://snapshot.ubuntu.com/ubuntu/20261120T060000Z'

INRELEASE_LIMIT=256<<10

POOL_URLS={
    'binutils': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/binutils_2.42-4ubuntu2.10_amd64.deb',
    'binutils-common': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/binutils-common_2.42-4ubuntu2.10_amd64.deb',
    'binutils-x86-64-linux-gnu': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/binutils-x86-64-linux-gnu_2.42-4ubuntu2.10_amd64.deb',
    'cpp': 'https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-defaults/cpp_13.2.0-7ubuntu1_amd64.deb',
    'cpp-13': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-13/cpp-13_13.3.0-6ubuntu2~24.04.1_amd64.deb',
    'cpp-13-x86-64-linux-gnu': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-13/cpp-13-x86-64-linux-gnu_13.3.0-6ubuntu2~24.04.1_amd64.deb',
    'cpp-x86-64-linux-gnu': 'https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-defaults/cpp-x86-64-linux-gnu_13.2.0-7ubuntu1_amd64.deb',
    'gcc': 'https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-defaults/gcc_13.2.0-7ubuntu1_amd64.deb',
    'gcc-13': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-13/gcc-13_13.3.0-6ubuntu2~24.04.1_amd64.deb',
    'gcc-13-base': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-13/gcc-13-base_13.3.0-6ubuntu2~24.04.1_amd64.deb',
    'gcc-13-x86-64-linux-gnu': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-13/gcc-13-x86-64-linux-gnu_13.3.0-6ubuntu2~24.04.1_amd64.deb',
    'gcc-x86-64-linux-gnu': 'https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-defaults/gcc-x86-64-linux-gnu_13.2.0-7ubuntu1_amd64.deb',
    'libasan8': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libasan8_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libatomic1': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libatomic1_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libbinutils': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libbinutils_2.42-4ubuntu2.10_amd64.deb',
    'libc-bin': 'https://security.ubuntu.com/ubuntu/pool/main/g/glibc/libc-bin_2.39-0ubuntu8.12_amd64.deb',
    'libc-dev-bin': 'https://security.ubuntu.com/ubuntu/pool/main/g/glibc/libc-dev-bin_2.39-0ubuntu8.12_amd64.deb',
    'libc6': 'https://security.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8.12_amd64.deb',
    'libc6-dev': 'https://security.ubuntu.com/ubuntu/pool/main/g/glibc/libc6-dev_2.39-0ubuntu8.12_amd64.deb',
    'libcc1-0': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libcc1-0_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libcrypt-dev': 'https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcrypt/libcrypt-dev_4.4.36-4build1_amd64.deb',
    'libctf-nobfd0': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libctf-nobfd0_2.42-4ubuntu2.10_amd64.deb',
    'libctf0': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libctf0_2.42-4ubuntu2.10_amd64.deb',
    'libgcc-13-dev': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-13/libgcc-13-dev_13.3.0-6ubuntu2~24.04.1_amd64.deb',
    'libgomp1': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libgomp1_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libgprofng0': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libgprofng0_2.42-4ubuntu2.10_amd64.deb',
    'libhwasan0': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libhwasan0_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libisl23': 'https://archive.ubuntu.com/ubuntu/pool/main/i/isl/libisl23_0.26-3build1.1_amd64.deb',
    'libitm1': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libitm1_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libjansson4': 'https://archive.ubuntu.com/ubuntu/pool/main/j/jansson/libjansson4_2.14-2build2_amd64.deb',
    'liblsan0': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/liblsan0_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libmpc3': 'https://archive.ubuntu.com/ubuntu/pool/main/m/mpclib3/libmpc3_1.3.1-1build1.1_amd64.deb',
    'libmpfr6': 'https://archive.ubuntu.com/ubuntu/pool/main/m/mpfr4/libmpfr6_4.2.1-1build1.1_amd64.deb',
    'libquadmath0': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libquadmath0_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libsframe1': 'https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libsframe1_2.42-4ubuntu2.10_amd64.deb',
    'libtsan2': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libtsan2_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'libubsan1': 'https://security.ubuntu.com/ubuntu/pool/main/g/gcc-14/libubsan1_14.2.0-4ubuntu2~24.04.1_amd64.deb',
    'linux-libc-dev': 'https://archive.ubuntu.com/ubuntu/pool/main/l/linux/linux-libc-dev_6.8.0-151.151_amd64.deb',
    'rpcsvc-proto': 'https://archive.ubuntu.com/ubuntu/pool/main/r/rpcsvc-proto/rpcsvc-proto_1.4.2-0ubuntu7_amd64.deb',
}

APT_CONF="""Dir::Etc::main "/policy/empty.conf";
Dir::Etc::parts "/policy/empty";
Dir::Etc::sourcelist "/policy/empty.conf";
Dir::Etc::sourceparts "/policy/empty";
Dir::Etc::preferences "/policy/empty.conf";
Dir::Etc::preferencesparts "/policy/empty";
Dir::State::lists "/policy/empty";
Dir::State::status "/var/lib/dpkg/status";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
APT::Architecture "amd64";
APT::Architectures { "amd64"; };
APT::Get::AllowUnauthenticated "false";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::Check-Valid-Until "true";
Acquire::Retries "0";
"""

def need(ok,label):
    if not ok:
        raise ValueError(label)

def bounded(argv,scratch,timeout=35,limit=128<<10,*,capture_timeout=False):
    def cap():
        resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
    env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':str(scratch/'home')}
    with tempfile.TemporaryFile(dir=scratch) as out, tempfile.TemporaryFile(dir=scratch) as err:
        try:
            code=subprocess.run(argv,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,
                                timeout=timeout,preexec_fn=cap).returncode
        except subprocess.TimeoutExpired:
            if not capture_timeout:
                raise
            # subprocess.run kills and reaps the host child. The daemon state is checked independently.
            code=None
        out.seek(0)
        err.seek(0)
        body=out.read(limit+1)
        problem=err.read(limit+1)
    need(len(body)<=limit and len(problem)<=limit,'tool-output-bound')
    return code,body,problem

def call(argv,scratch,timeout=35,limit=128<<10):
    code,out,_=bounded(argv,scratch,timeout,limit)
    need(code==0,'bounded-tool-failed')
    return out

def bound_file(path, size, digest, *, allow_terminal_lf=False):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as h:
        a=os.fstat(h.fileno())
        sizes=(size,size+1) if allow_terminal_lf else (size,)
        need(stat.S_ISREG(a.st_mode) and a.st_nlink==1 and a.st_uid==os.getuid() and not a.st_mode&0o077
             and a.st_size in sizes, 'held-file-shape')
        raw=h.read(a.st_size+1)
        b=os.fstat(h.fileno())
        c=path.lstat()
        need((a.st_dev,a.st_ino,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_ctime_ns)==(c.st_dev,c.st_ino,c.st_ctime_ns)
             and len(raw)==a.st_size,'held-file-digest')
        # GnuPG can emit the final cleartext separator LF (RFC 9580 section 7.1).
        if allow_terminal_lf and len(raw)==size+1 and raw.endswith(b'\n'):
            raw=raw[:-1]
        need(len(raw)==size and SHA(raw)==digest,'held-file-digest')
    return raw

def checked_tool(path):
    p=Path(path)
    need(p.resolve(strict=True)==p,'stock-tool-path')
    s=p.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and not s.st_mode&0o7022 and s.st_mode&0o100,'stock-tool-mode')

def job(env):
    sha=env.get('GITHUB_SHA','')
    ref='refs/heads/'+BRANCH
    need(env.get('GITHUB_REPOSITORY')==REPO and env.get('GITHUB_REF')==ref and env.get('GITHUB_EVENT_NAME')=='push'
         and env.get('GITHUB_JOB')==JOB and env.get('RUNNER_ENVIRONMENT')=='github-hosted'
         and env.get('RUNNER_OS')=='Linux' and env.get('RUNNER_ARCH')=='X64'
         and env.get('GITHUB_WORKFLOW_SHA')==sha and re.fullmatch('[0-9a-f]{40}',sha)
         and env.get('GITHUB_WORKFLOW_REF')==REPO+'/'+WORKFLOW+'@'+ref,'reviewed-job-scope')
    run=env.get('GITHUB_RUN_ID','')
    attempt=env.get('GITHUB_RUN_ATTEMPT','')
    need(re.fullmatch('[1-9][0-9]{0,18}',run) and attempt=='1'
         and os.getuid()==os.geteuid()>0 and os.getgid()==os.getegid()>0,'normal-runner-identity')
    return run,attempt

def local_directory(path,owner_only=False):
    need(re.fullmatch(r'/[A-Za-z0-9._/-]+',str(path)) and path.resolve(strict=True)==path
         and '//' not in str(path),'canonical-scratch')
    for entry in [*reversed(path.parents),path]:
        row=entry.lstat()
        need(stat.S_ISDIR(row.st_mode) and row.st_uid in (0,os.getuid()) and not row.st_mode&0o7022,
             'original-directory-ancestry')
    fd=os.open(path,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        st=os.fstat(fd)
        sp=os.fstatvfs(fd)
        need(st.st_ino==path.lstat().st_ino and st.st_dev==path.lstat().st_dev,'capacity-handle')
        if owner_only:
            need(st.st_uid==os.getuid(),'job-owned-path')
        return {'dev':st.st_dev,'ino':st.st_ino,'bytes':sp.f_bavail*sp.f_frsize}
    finally:
        os.close(fd)

def image_identity(row,policy):
    need(row.get('Id')==policy['config'] and row.get('Os')=='linux' and row.get('Architecture')=='amd64'
         and row.get('RootFS')=={'Type':'layers','Layers':[policy['diffID']]},'oci-config-and-layer')
    names=[policy['image'],policy['image'].replace('docker.io/library/','')]
    need(any(name in row.get('RepoDigests',[]) for name in names),'oci-amd64-manifest')

def docker(scratch,*args):
    return (DOCKER,'--host','unix:///var/run/docker.sock','--config',str(scratch/'docker'),*args)

def fetch_https(url,destination,limit,scratch):
    need(url.startswith(SNAPSHOT+'/') and '//' not in url[8:],'approved-transport-route')
    need(limit>0 and not os.path.lexists(destination),'fresh-bounded-download')
    # curl bounds the archive body; the process file-size limit also bounds disk writes.
    raw=call(('/usr/bin/curl','--disable','--fail','--silent','--show-error','--proto','=https',
          '--connect-timeout','8','--max-time','24','--max-filesize',str(limit),
          '--output',str(destination),'--write-out','%{http_code}',url),scratch,28,limit)
    need(raw==b'200','direct-official-http')

def fetch(url,destination,size,digest,scratch):
    fetch_https(url,destination,size,scratch)
    return bound_file(destination,size,digest)

def index_fields(signed, suite):
    fields=dict(re.findall(rb'^([A-Za-z0-9-]+): (.+)$',signed,re.M))
    need((fields.get(b'Origin'),fields.get(b'Codename'),fields.get(b'Suite'))==
         (b'Ubuntu',b'noble',suite.encode()),'signed-ubuntu-suite')
    now=datetime.now(timezone.utc)
    need(parsedate_to_datetime(fields[b'Date'].decode())<=now,'signed-index-date')
    if b'Valid-Until' in fields:
        need(now<=parsedate_to_datetime(fields[b'Valid-Until'].decode()),'signed-index-expiry')
    section=signed.split(b'\nSHA256:\n',1)[1].partition(b'\nSHA512:\n')[0]
    matches=re.findall(rb'^ ([0-9a-f]{64}) +([0-9]+) main/binary-amd64/Packages(\.xz)?$',section,re.M)
    need(len(matches)==2,'signed-plain-and-compressed-index')
    found={suffix.decode():[digest.decode(),int(size)] for digest,size,suffix in matches}
    need(set(found)=={'','.xz'} and found[''][1]<=24<<20 and found['.xz'][1]<=4<<20,'signed-index-size')
    return found

def signed_rows(raw, suite, records):
    selected={}
    for paragraph in raw.split(b'\n\n'):
        name=paragraph.partition(b'\n')[0].removeprefix(b'Package: ').decode()
        expected=records.get(name)
        if expected is None or suite not in expected['pockets']:
            continue
        fields={}
        for key,value in re.findall(rb'^(Version|Architecture|Filename|Size|SHA256): (.+)$',paragraph,re.M):
            need(key not in fields,'signed-record-field')
            fields[key]=value.decode()
        if fields.get(b'Version')!=expected['Version'] or fields.get(b'Architecture')!=expected['Architecture']:
            continue
        need(name not in selected and fields[b'Filename']==expected['Filename'] and fields[b'SHA256']==expected['SHA256']
             and int(fields[b'Size'])==expected['Size'],'signed-exact-package')
        selected[name]=True
    return set(selected)

def snapshot_https(policy,scratch):
    checked_tool('/usr/bin/curl')
    need(policy['snapshot']==SNAPSHOT,'exact-dated-snapshot')
    for suite in policy['indexes']:
        fetch_https(SNAPSHOT+'/dists/'+suite+'/InRelease',scratch/(suite+'.InRelease'),INRELEASE_LIMIT,scratch)

def snapshot_signatures(policy,scratch):
    import base64
    checked_tool('/usr/bin/gpgv')
    key=base64.b64decode(policy['keyringB64'],validate=True)
    need(len(key)==3607 and SHA(key)==policy['keyringSHA256'],'pinned-ubuntu-keyring')
    ring=scratch/'archive-keyring.gpg'
    with ring.open('xb') as destination:
        destination.write(key)
    for suite,pin in policy['indexes'].items():
        message=scratch/(suite+'.InRelease')
        bound_file(message,pin['releaseBytes'],pin['releaseSHA256'])
        clear=scratch/(suite+'.Release')
        need(not os.path.lexists(clear),'fresh-authenticated-metadata')
        status=call(('/usr/bin/gpgv','--homedir',str(scratch/'gpgv'),'--keyring',str(ring),'--status-fd','1',
            '--output',str(clear),str(message)),scratch,12,INRELEASE_LIMIT).decode()
        valid=re.findall(r'(?m)^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b',status)
        need(valid==[PUB] and not re.search(r'(?m)^\[GNUPG:\] (?:BADSIG|ERRSIG|EXPKEYSIG|EXPSIG|REVKEYSIG|KEYEXPIRED)\b',status),
             'canonical-snapshot-signature')
        bound_file(clear,*AUTHENTICATED_RELEASES[suite],allow_terminal_lf=True)

def signed_index_intake(policy,scratch,*,download):
    records=policy['archives']
    covered=set()
    for suite,pin in policy['indexes'].items():
        clear=bound_file(scratch/(suite+'.Release'),*AUTHENTICATED_RELEASES[suite],allow_terminal_lf=True)
        checks=index_fields(clear,suite)
        need(checks==pin['checks'],'exact-signed-index-pins')
        packed=scratch/(suite+'.Packages.xz')
        digest,size=checks['.xz']
        if download:
            compressed=fetch(SNAPSHOT+'/dists/'+suite+'/main/binary-amd64/Packages.xz',packed,size,digest,scratch)
        else:
            compressed=bound_file(packed,size,digest)
        with lzma.open(io.BytesIO(compressed),'rb') as index:
            raw=index.read(checks[''][1]+1)
        need(len(raw)==checks[''][1] and SHA(raw)==checks[''][0],'whole-plain-index')
        expected={name for name,row in records.items() if suite in row['pockets']}
        found=signed_rows(raw,suite,records)
        need(found==expected,'complete-signed-package-membership')
        covered.update(found)
    need(covered==records.keys(),'all-pinned-archives-signed')

def pool_download(url,destination,size,digest,scratch):
    need(size>0 and not os.path.lexists(destination),'fresh-bounded-download')
    for attempt in range(2):
        with tempfile.TemporaryDirectory(prefix='archive-attempt-',dir=scratch) as attempt_dir:
            candidate=Path(attempt_dir)/'body'
            code,status,_=bounded(('/usr/bin/curl','--disable','--fail','--silent','--show-error','--proto','=https',
                 '--connect-timeout','8','--max-time','24','--max-filesize',str(size),
                 '--output',str(candidate),'--write-out','%{http_code}',url),scratch,28,size)
            if code==0 and status==b'200':
                bound_file(candidate,size,digest)
                # Publish only an authenticated inode and never overwrite an approved body.
                os.link(candidate,destination,follow_symlinks=False)
                break
            need(status not in (b'401',b'403',b'407',b'451'),'pool-access-denied')
            need(not re.fullmatch(rb'3[0-9]{2}',status),'pool-redirect-refused')
            need(code in (18,28,52,56) and status in (b'000',b'200'),'pool-transport-refused')
            # A complete-size but unclosed transfer cannot qualify for a retry.
            need(not os.path.lexists(candidate) or candidate.lstat().st_size<size,'pool-transport-ambiguous')
            need(attempt==0,'pool-transport-exhausted')
    bound_file(destination,size,digest)

def pool_routes(records):
    need(POOL_URLS.keys()==records.keys(),'complete-reviewed-pool-routes')
    for name,row in records.items():
        filename=row['Filename']
        need(re.fullmatch(r'pool/main/[a-z0-9]+/[a-z0-9.+-]+/[a-z0-9.+_~%-]+.deb',filename) and
             filename.rsplit('/',1)[-1]==name+'_'+row['Version'].split(':')[-1]+'_'+row['Architecture']+'.deb',
             'signed-archive-path')
        host='security.ubuntu.com' if 'noble-security' in row['pockets'] else 'archive.ubuntu.com'
        need(POOL_URLS[name]=='https://'+host+'/ubuntu/'+filename,'exact-reviewed-pool-route')
    return POOL_URLS

def exact_archive_intake(policy,scratch,*,only=None):
    checked_tool('/usr/bin/curl')
    # The original snapshot still authenticates every package, before the pool is used.
    signed_index_intake(policy,scratch,download=False)
    records=policy['archives']
    need(len(records)==39 and sum(row['Size'] for row in records.values())==58852226,'exact-archive-count-and-transfer')
    routes=pool_routes(records)
    names=sorted(records)
    if only is not None:
        need(1<=only<=len(names),'pinned-archive-ordinal')
        names=[names[only-1]]
    for name in names:
        row=records[name]
        pool_download(routes[name],scratch/'approved'/(name+'.deb'),row['Size'],row['SHA256'],scratch)

def archive_readback(policy,scratch):
    files=policy['archives']
    root=scratch/'approved'
    need(sorted(p.name for p in root.iterdir())==sorted(name+'.deb' for name in files),'complete-staged-debs')
    for name,row in files.items():
        bound_file(root/(name+'.deb'),row['Size'],row['SHA256'])
    expected={'apt.conf':APT_CONF.encode(),'empty.conf':b''}
    actual=scratch/'policy'
    need({p.name for p in actual.iterdir()}==set(expected)|{'empty'} and not any((actual/'empty').iterdir()),'offline-apt-policy-layout')
    need(all(actual.joinpath(name).read_bytes()==raw for name,raw in expected.items()),'exact-offline-apt-policy')

def one(inspect):
    result=json.loads(inspect)
    need(isinstance(result,list) and len(result)==1,'one-real-inspect-object')
    return result[0]
