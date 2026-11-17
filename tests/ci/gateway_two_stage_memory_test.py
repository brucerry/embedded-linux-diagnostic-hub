"""Closed-port supervisor controls. All children, files and service labels are memory fakes."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('two_stage', ROOT/'scripts/ci/gateway-two-stage-supervisor.py')
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)


def binding():
    descriptor = lambda name: dict(name=name, bytes=23, sha256='b'*64)
    name = 'Diagnostic-Hub-Gateway-0.6.0.tar.gz'
    return dict(context=dict(scope='gateway', version='0.6.0', sourceCommit='a'*40,
                            sourceTree='c'*40, runId='123', runAttempt='1', jobKey='gateway_build'),
                buildRecord=descriptor('gateway-build.json'),
                artifacts=[descriptor(name), descriptor(name+'.sha256')])


class ClassifierTests(unittest.TestCase):
    def test_producer_and_runtime_are_independent(self):
        self.assertEqual(S.classify('producer', 0, json.dumps(binding()).encode(), b'', True), ('producer-ready','none'))
        self.assertEqual(S.classify('runtime', 0, S.RUNTIME_COMPLETE, b'', True), ('runtime-closed','none'))
        self.assertEqual(S.classify('runtime', 0, json.dumps(binding()).encode(), b'', True), ('failed','invalid-output'))

    def test_exit_failure_cannot_be_replaced_by_success_message(self):
        self.assertEqual(S.classify('runtime', 1, S.RUNTIME_COMPLETE, b'', True), ('failed','worker-failed'))

    def test_missing_or_uncertain_output_never_succeeds(self):
        for code, out, err, closed in [(0,b'',b'',True), (0,S.RUNTIME_COMPLETE,b'',False),
                                       (0,S.RUNTIME_COMPLETE,b'x'*65537,True)]:
            self.assertEqual(S.classify('runtime',code,out,err,closed)[0], 'failed')

    def test_bounded_exact_original_selection(self):
        for mutate in [lambda x:x.update(extra=True), lambda x:x['context'].update(extra=True),
                       lambda x:x['artifacts'][1].update(bytes=1025),
                       lambda x:x['buildRecord'].update(sha256='bad'),
                       lambda x:x['artifacts'].reverse()]:
            value=copy.deepcopy(binding());mutate(value)
            self.assertEqual(S.classify('producer',0,json.dumps(value).encode(),b'',True), ('failed','invalid-output'))
        self.assertEqual(S.classify('producer',0,b' '*16385,b'',True), ('failed','invalid-output'))


class OutsideOwnerTests(unittest.TestCase):
    def run_fake(self, role='producer', *, out=None, code=0, tamper=False, publish_error=False, closed=True):
        original=json.dumps(binding()).encode()
        environment=dict(GITHUB_RUN_ID='123',GITHUB_SHA='a'*40,PRODUCER_BINDING_SHA=hashlib.sha256(original).hexdigest())
        child=SimpleNamespace(returncode=code,stdout=SimpleNamespace(closed=closed),stderr=SimpleNamespace(closed=closed),
                              stdin=None if role=='producer' else SimpleNamespace(closed=closed),poll=lambda:code)
        child.communicate=Mock(return_value=(out if out is not None else (original if role=='producer' else S.RUNTIME_COMPLETE),b''))
        with patch.object(S,'select',return_value=(Path('/fixture/source'),Path('/fixture/private'),Path('/fixture/node'),{})), \
             patch.object(S.os.path,'lexists',return_value=False), \
             patch.object(S.COMMON,'read',return_value=original+b' ' if tamper else original), \
             patch.object(S.COMMON,'write') as write, \
             patch.object(S.subprocess,'Popen',return_value=child) as launch, \
             patch.object(S,'publish',side_effect=OSError() if publish_error else None) as publish:
            result=S.main(role,environment)
        return SimpleNamespace(result=result,write=write,launch=launch,publish=publish,child=child,original=original)

    def test_original_stdout_hash_is_persisted_only_after_successful_exit_and_eof(self):
        f=self.run_fake()
        self.assertEqual(f.result,0)
        self.assertEqual(f.write.call_args.args[1], f.original)
        self.assertEqual(f.publish.call_args.args[-1], hashlib.sha256(f.original).hexdigest())
        self.assertEqual(f.launch.call_count,1)
        self.assertEqual(f.launch.call_args.args[0][-1],'--qualify-branch')
        self.assertFalse(f.launch.call_args.kwargs['shell'])

    def test_failed_producer_retains_failure_without_publishing_binding(self):
        f=self.run_fake(code=1)
        self.assertEqual(f.result,1);f.write.assert_not_called()
        self.assertEqual(f.publish.call_args.args[2:4],('failed','worker-failed'))

    def test_runtime_receives_original_bytes_and_hash_without_producer(self):
        f=self.run_fake('runtime')
        self.assertEqual(f.result,0);f.write.assert_not_called()
        f.child.communicate.assert_called_once_with(f.original)
        self.assertTrue(f.launch.call_args.args[0][1].endswith('/run-gateway-runtime-stage.mjs'))
        self.assertEqual(f.launch.call_args.args[0][2],hashlib.sha256(f.original).hexdigest())

    def test_tampered_binding_refuses_before_launch(self):
        f=self.run_fake('runtime',tamper=True)
        self.assertEqual(f.result,1);f.launch.assert_not_called();f.write.assert_not_called()

    def test_missing_outside_report_or_unclosed_pipe_cannot_succeed(self):
        self.assertEqual(self.run_fake(publish_error=True).result,1)
        f=self.run_fake(closed=False)
        self.assertEqual(f.result,1);f.write.assert_not_called()

    def test_wrong_branch_refuses_before_files_or_child(self):
        with patch.object(S.os,'getuid',return_value=1000), patch.object(S.COMMON,'read') as read:
            with self.assertRaises(AssertionError):S.select({},'runtime')
        read.assert_not_called()


if __name__=='__main__':unittest.main()
