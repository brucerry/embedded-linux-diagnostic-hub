"""Authored-memory classification controls; no compile log fixture or native I/O."""
from pathlib import Path
import importlib.util
import stat
import types
import unittest

source = Path(__file__).resolve().parents[1] / '.github/scripts/windows-compile-diagnostic.py'
spec = importlib.util.spec_from_file_location('actual_compile_diagnostic', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
classify = module.classify_compile_log


class CompileDiagnostic(unittest.TestCase):
    def test_actual_classifier_reports_only_known_code_and_bounded_fixed_source_line(self):
        data = b'PRIVATE\\authority.cc(12,4): error C2065: PRIVATE_SYMBOL\r\n'
        self.assertEqual(classify(data, 200, 'compile-link'),
                         {'phase': 'compile-link', 'status': 'observed-code', 'code': 'C2065', 'line': '12'})
        self.assertEqual(classify(data.decode().encode('utf-16'), 200, 'compile-link')['code'], 'C2065')
        self.assertEqual(classify(b'LINK : fatal error LNK1120: PRIVATE', 200, 'compile-link')['line'], 'unknown')
        for code in ('C3646', 'C4430'):
            result = classify(('authority.cc(12): error ' + code + ': PRIVATE').encode(), 200, 'compile-link')
            self.assertEqual(result['code'], code)
            self.assertEqual(result['line'], '12')

    def test_unknown_and_foreign_diagnostics_do_not_publish_paths_or_symbols(self):
        for data, status in [(b'PRIVATE authority.cc warning C2065: PRIVATE', 'no-code'),
                             (b'PRIVATE : error C9999: PRIVATE', 'unlisted-code'),
                             (b'PRIVATE utf8 \xff', 'unsupported-encoding')]:
            result = classify(data, 200, 'compile-link')
            self.assertEqual(result['status'], status)
            self.assertEqual(result['code'], 'unknown')
            self.assertEqual(result['line'], 'unknown')
            self.assertNotIn('PRIVATE', str(result))
        self.assertEqual(classify(b'PRIVATE\\other.cc(12): error C2065: PRIVATE', 200, 'compile-link')['line'], 'unknown')

    def test_missing_truncated_failed_or_unstable_reads_never_yield_a_code(self):
        data = b'authority.cc(12): error C2065: PRIVATE'
        for state in ('missing', 'truncated', 'read-failed', 'changed', 'not-regular', 'PRIVATE'):
            result = classify(data, 200, 'compile-link', state)
            self.assertEqual(result['code'], 'unknown')
            self.assertEqual(result['line'], 'unknown')
        self.assertEqual(classify(data, 200, 'tool-versions')['status'], 'stage-only')
        self.assertEqual(classify(data, 200, 'PRIVATE')['phase'], 'unclassified')

    def test_reader_never_exceeds_64k_and_oversize_is_unknown_without_reading(self):
        class MemoryFile:
            def __init__(self, data):
                self.data = data
                self.reads = []
            def lstat(self):
                return types.SimpleNamespace(st_mode=stat.S_IFREG, st_size=len(self.data), st_dev=1, st_ino=2, st_mtime_ns=3)
            stat = lstat
            def open(self, mode):
                self.assert_mode = mode
                return self
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, maximum):
                self.reads.append(maximum)
                return self.data[:maximum]
        file = MemoryFile(b'x' * 65536)
        self.assertEqual(module.read_bounded(file, 65536), ('complete', file.data))
        self.assertEqual(file.reads, [65536])
        large = MemoryFile(b'x' * 65537)
        self.assertEqual(module.read_bounded(large, 65536), ('truncated', None))
        self.assertEqual(large.reads, [])
        self.assertEqual(classify(large.data, 200, 'compile-link')['status'], 'truncated')

    def test_first_diagnostic_code_and_closed_projection_survive_private_text(self):
        data = b'authority.cc(3): error C9999: PRIVATE\nauthority.cc(4): error C2065: PRIVATE'
        result = classify(data, 200, 'compile-link')
        self.assertEqual(result['code'], 'unknown')
        self.assertEqual(set(result), {'phase', 'status', 'code', 'line'})
        for value in result.values():
            self.assertNotIn('PRIVATE', value)
            self.assertNotIn('\n', value)

    def test_line_limits_and_missing_source_count_remain_truthful(self):
        for line in ('0', '201', '999999', '01'):
            result = classify(('authority.cc(' + line + '): error C2065: PRIVATE').encode(), 200, 'compile-link')
            self.assertEqual(result['line'], 'unknown')
        for count in (None, 0, True, 100001):
            result = classify(b'authority.cc(1): error C2065: PRIVATE', count, 'compile-link')
            self.assertEqual(result['status'], 'source-unknown')
            self.assertEqual(result['code'], 'unknown')


if __name__ == '__main__':
    unittest.main()
