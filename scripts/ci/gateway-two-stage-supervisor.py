"""Outside-worker outcome owner; no download, retry, kill, cleanup or raw diagnostics.

Only the original successful producer stdout supplies the downstream hash. The
worker's private report is never required or used to replace its process outcome.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

BRANCH = 'ci/v060-gateway-two-stage-20261117'
SPEC = importlib.util.spec_from_file_location('gateway_guarded_files', Path(__file__).with_name('prepare-gateway-four-tools.py'))
COMMON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMMON)
KEYS = ('GITHUB_ACTIONS', 'GITHUB_WORKSPACE', 'GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY',
        'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
        'GITHUB_JOB', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'RUNNER_ENVIRONMENT',
        'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP')
RUNTIME_COMPLETE = b'Gateway runtime health/auth/normal-close complete; no SSH or release qualification.\n'


def select(environment, role):
    assert role in ('producer', 'runtime') and os.getuid() > 0
    for key, value in {
        'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'brucerry/embedded-linux-diagnostic-hub',
        'GITHUB_EVENT_NAME':'push','GITHUB_REF':'refs/heads/'+BRANCH,'GITHUB_RUN_ATTEMPT':'1',
        'GITHUB_JOB':'gateway_build','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
    }.items(): assert environment.get(key)==value
    sha=environment['GITHUB_SHA']; run=environment['GITHUB_RUN_ID']
    assert re.fullmatch('[a-f0-9]{40}',sha) and re.fullmatch('[1-9][0-9]{0,31}',run)
    assert environment['GITHUB_WORKFLOW_SHA']==sha
    assert environment['GITHUB_WORKFLOW_REF']=='brucerry/embedded-linux-diagnostic-hub/.github/workflows/gateway-publisher-node-buildonly.yml@refs/heads/'+BRANCH
    root=Path(environment['GITHUB_WORKSPACE']);temporary=Path(environment['RUNNER_TEMP'])
    COMMON.directory(root);COMMON.directory(temporary)
    node=temporary/('gateway-publisher-node-'+run+'-1')/'bin/node'
    profile=json.loads(COMMON.read(root/'scripts/ci/gateway-four-tool-inputs.json',16384))
    binary=COMMON.read(node,128*1024**2)
    assert profile['node']['version']=='24.22.2' and len(binary)==profile['node']['bytes']
    assert hashlib.sha256(binary).hexdigest()==profile['node']['sha256']
    env={key:environment[key] for key in KEYS}
    env.update(PATH=str(node.parent)+':/usr/bin:/bin',LANG='C.UTF-8',LC_ALL='C.UTF-8',TZ='UTC',NODE_DISABLE_COMPILE_CACHE='1')
    return root,temporary,node,env


def classify(role, code, stdout, stderr, stdin_closed):
    if code != 0: return 'failed','worker-failed'
    if not stdin_closed or len(stderr)>65536: return 'failed','custody-unknown'
    if role=='runtime':
        return ('runtime-closed','none') if stdout==RUNTIME_COMPLETE else ('failed','invalid-output')
    if not 0<len(stdout)<=16384: return 'failed','invalid-output'
    try:
        value=json.loads(stdout)
        assert set(value)=={'context','buildRecord','artifacts'}
        assert set(value['buildRecord'])=={'name','bytes','sha256'}
        assert value['buildRecord']['name']=='gateway-build.json'
        assert len(value['artifacts'])==2
        for row,limit in zip([value['buildRecord'],*value['artifacts']],[16*1024**2,128*1024**2,1024]):
            assert set(row)=={'name','bytes','sha256'}
            assert type(row['bytes']) is int and 0<row['bytes']<=limit
            assert re.fullmatch('[a-f0-9]{64}',row['sha256'])
        assert value['context']['scope']=='gateway' and value['context']['version']=='0.6.0'
        assert set(value['context'])=={'scope','version','sourceCommit','sourceTree','runId','runAttempt','jobKey'}
        assert re.fullmatch('[a-f0-9]{40}',value['context']['sourceCommit'])
        assert re.fullmatch('[a-f0-9]{40}',value['context']['sourceTree'])
        assert [row['name'] for row in value['artifacts']]==['Diagnostic-Hub-Gateway-0.6.0.tar.gz','Diagnostic-Hub-Gateway-0.6.0.tar.gz.sha256']
    except (ValueError,KeyError,TypeError,AssertionError): return 'failed','invalid-output'
    return 'producer-ready','none'


def publish(environment, role, result, reason, original_hash):
    assert role in ('producer','runtime')
    assert result in ('producer-ready','runtime-closed','failed')
    assert reason in ('none','worker-failed','custody-unknown','invalid-output','operation-failed')
    assert original_hash=='none' or re.fullmatch('[a-f0-9]{64}',original_hash)
    assert (result=='failed') == (reason!='none')
    data=('result='+result+'\nstage='+role+'\nreason='+reason+'\nbinding_sha256='+original_hash+'\n').encode('ascii')
    target=Path(environment['GITHUB_OUTPUT'])
    assert target.is_relative_to(Path(environment['RUNNER_TEMP']))
    COMMON.directory(target.parent);before=COMMON.metadata(target)
    fd=os.open(target,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
    try:
        assert COMMON.identity(os.fstat(fd))==COMMON.identity(before)
        assert os.write(fd,data)==len(data)
        os.fsync(fd);after=os.fstat(fd)
        assert COMMON.identity(after)[:6]==COMMON.identity(before)[:6]
        assert after.st_size==before.st_size+len(data)
        assert COMMON.identity(COMMON.metadata(target))==COMMON.identity(after)
    finally:os.close(fd)


def main(role, environment=os.environ):
    result,reason,original_hash='failed','operation-failed','none'
    try:
        root,temporary,node,env=select(environment,role)
        binding=temporary/('gateway-two-stage-'+environment['GITHUB_RUN_ID']+'-1-binding.json')
        original=None
        if role=='producer':
            assert not os.path.lexists(binding)
            argv=[str(node),str(root/'scripts/build-gateway-tag-archive.mjs'),'--qualify-branch']
        else:
            original_hash=environment['PRODUCER_BINDING_SHA']
            assert re.fullmatch('[a-f0-9]{64}',original_hash)
            original=COMMON.read(binding,16384)
            assert hashlib.sha256(original).hexdigest()==original_hash
            argv=[str(node),str(root/'scripts/run-gateway-runtime-stage.mjs'),original_hash]
        child=subprocess.Popen(argv,cwd=root,env=env,stdin=subprocess.PIPE if original is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,shell=False)
        # The frozen entrypoints emit only bounded identities/fixed messages. No signals or
        # forced exit are used to hide an unclosed child; the job's existing timeout remains.
        stdout,stderr=child.communicate(original)
        assert child.poll() is not None and child.stdout.closed and child.stderr.closed
        result,reason=classify(role,child.returncode,stdout,stderr,child.stdin is None or child.stdin.closed)
        if result=='producer-ready':
            value=json.loads(stdout)
            assert value['context']['sourceCommit']==environment['GITHUB_SHA']
            assert value['context']['runId']==environment['GITHUB_RUN_ID']
            assert value['context']['runAttempt']=='1' and value['context']['jobKey']=='gateway_build'
            original_hash=hashlib.sha256(stdout).hexdigest()  # Original pipe bytes, never a later file read.
            COMMON.write(binding,stdout)
    except Exception:
        result,reason='failed','operation-failed'
    try:publish(environment,role,result,reason,original_hash)
    except Exception:
        return 1  # Missing/failed outside report cannot admit either stage.
    return 0 if result in ('producer-ready','runtime-closed') else 1


if __name__=='__main__':
    assert len(sys.argv)==2 and sys.argv[1] in ('producer','runtime')
    sys.exit(main(sys.argv[1]))
