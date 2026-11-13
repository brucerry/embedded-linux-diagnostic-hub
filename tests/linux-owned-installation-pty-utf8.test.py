"""Memory controls for the actual pending-review decoder and literal predicate.

Only selected inert AST definitions are executed. The PTY runner, its imports,
main function, filesystem/process operations and signal paths are never loaded.
"""
import ast
import codecs
import hashlib
import pathlib
import re
import unittest


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/linux-owned-installation-pty.py'
RAW_SOURCE = SOURCE.read_bytes()
TREE = ast.parse(RAW_SOURCE, filename=str(SOURCE))
SELECTED = []
for name in ('A', 'B'):
    matches = [node for node in TREE.body if isinstance(node, ast.Assign)
               and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
               and node.targets[0].id == name]
    if len(matches) != 1 or not isinstance(matches[0].value, ast.Constant):
        raise AssertionError('Fixed literal fixture version required.')
    SELECTED.extend(matches)
for name, kind in (('expected_review', ast.FunctionDef), ('PendingReviewText', ast.ClassDef)):
    matches = [node for node in TREE.body if isinstance(node, kind) and node.name == name]
    if len(matches) != 1:
        raise AssertionError('Exactly one inert definition required.')
    SELECTED.extend(matches)
NAMESPACE = {'codecs': codecs, 're': re}
exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE) + '.memory', 'exec'), NAMESPACE)
PendingReviewText = NAMESPACE['PendingReviewText']
expected_review = NAMESPACE['expected_review']


def request(unicode=False):
    root = '/home/test/fixture' if not unicode else '/home/測試/fixture-é-🙂'
    return {'operation': 'update', 'target': root + '/installed',
            'version': NAMESPACE['B'], 'appData': root + '/config'}


def prompt(value):
    return ('\nDiagnostic Hub Linux setup\nOperation: update'
            + '\nApplication: ' + value['target']
            + '\nCandidate version: ' + value['version']
            + '\nInstalled version: ' + NAMESPACE['A']
            + '\nSettings/reports: ' + value['appData']
            + '/DiagnosticHub/profiles/11111111-1111-4111-8111-111111111111'
            + '\nPrevious payloads are retained. No Finalize or removal is performed.'
            + '\nType "apply menu" or "apply no-menu" to apply this operation;'
            + ' Enter/cancel leaves everything unchanged: ')


def consume(value, chunks, eof=True):
    """Closed-memory read loop using actual definitions, retaining the raw transcript."""
    decoder = PendingReviewText()
    transcript = bytearray()
    sent = 0
    for part in chunks:
        transcript.extend(part)
        if not sent and expected_review(value, decoder.append(part)):
            sent += 1
    if eof and not sent:
        decoder.finish()
    return bytes(transcript), sent


class PendingReviewUTF8Tests(unittest.TestCase):
    def test_every_byte_split_of_a_unicode_prompt_waits_for_the_exact_full_review(self):
        value = request(True)
        text = prompt(value)
        raw = text.encode('utf-8')
        self.assertTrue(expected_review(value, text))
        for at in range(len(raw) + 1):
            with self.subTest(split=at):
                decoder = PendingReviewText()
                first = decoder.append(raw[:at])
                self.assertEqual(expected_review(value, first), at == len(raw))
                self.assertEqual(decoder.append(raw[at:]), text)
                self.assertEqual(decoder.finish(), text)
                self.assertEqual(consume(value, [raw[:at], raw[at:]]), (raw, 1))
        self.assertEqual(consume(value, [raw[at:at + 1] for at in range(len(raw))]), (raw, 1))

    def test_ascii_prompt_and_all_ascii_prefixes_keep_the_original_decoding_behavior(self):
        value = request()
        raw = prompt(value).encode('utf-8')
        decoder = PendingReviewText()
        for at in range(len(raw)):
            self.assertEqual(decoder.append(raw[at:at + 1]), raw[:at + 1].decode('utf-8'))
        self.assertEqual(decoder.finish(), raw.decode('utf-8'))
        self.assertEqual(consume(value, [raw]), (raw, 1))

    def test_malformed_pending_utf8_is_refused_instead_of_replaced_or_ignored(self):
        for chunks in ([b'\xff'], [b'prefix\xe2', b'('], [b'\xc0\xaf']):
            with self.subTest(chunks=chunks):
                decoder = PendingReviewText()
                with self.assertRaises(UnicodeDecodeError):
                    for chunk in chunks:
                        decoder.append(chunk)
        with self.assertRaises(UnicodeDecodeError):
            consume(request(True), [prompt(request(True)).encode('utf-8')[:-1] + b'\xff'])

    def test_incomplete_pending_utf8_at_eof_remains_nonpassing(self):
        raw = prompt(request(True)).encode('utf-8')
        at = raw.index('測'.encode('utf-8')) + 1
        decoder = PendingReviewText()
        self.assertFalse(expected_review(request(True), decoder.append(raw[:at])))
        with self.assertRaises(UnicodeDecodeError):
            decoder.finish()
        with self.assertRaises(UnicodeDecodeError):
            consume(request(True), [raw[:at]])
        # A full prompt followed by an unfinished codepoint must not grant
        # consent by hiding those already received raw bytes in decoder state.
        decoder = PendingReviewText()
        self.assertEqual(decoder.append(raw + b'\xe2'), '')
        with self.assertRaises(UnicodeDecodeError):
            consume(request(True), [raw + b'\xe2'])
        self.assertEqual(consume(request(True), [raw + b'\xe2', b'\x82\xac']),
                         (raw + '\u20ac'.encode('utf-8'), 0))
        self.assertEqual(consume(request(), [b'valid UTF-8 but no complete review']),
                         (b'valid UTF-8 but no complete review', 0))

    def test_raw_transcript_and_postconsent_bytes_are_unchanged(self):
        value = request(True)
        raw = prompt(value).encode('utf-8')
        original_hash = hashlib.sha256(raw).hexdigest()
        for at in range(len(raw) + 1):
            transcript, sent = consume(value, [raw[:at], raw[at:]])
            self.assertEqual(hashlib.sha256(transcript).hexdigest(), original_hash)
            self.assertEqual(sent, 1)
        # The existing runner never decodes output after consent. Binary data here
        # would fail strict pending decoding, so this also guards that boundary.
        transcript, sent = consume(value, [raw, b'\xff\x00post-consent', raw])
        self.assertEqual(transcript, raw + b'\xff\x00post-consent' + raw)
        self.assertEqual(sent, 1)

    def test_changed_or_duplicate_pending_reviews_do_not_grant_new_consent(self):
        value = request(True)
        raw = prompt(value).encode('utf-8')
        for changed in (raw.replace(b'Operation: update', b'Operation: rollback'),
                        raw.replace(b'Installed version: ' + NAMESPACE['A'].encode(),
                                    b'Installed version: 0.5.0'),
                        raw + raw, b'prefix' + raw):
            with self.subTest(changed=changed):
                self.assertEqual(consume(value, [changed]), (changed, 0))
        self.assertEqual(consume(value, [raw, raw]), (raw + raw, 1))

    def test_actual_main_decodes_only_under_the_original_pending_consent_boundary(self):
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        candidates = [node for node in ast.walk(main) if isinstance(node, ast.If)
                      and isinstance(node.test, ast.BoolOp) and isinstance(node.test.op, ast.And)
                      and len(node.test.values) == 2
                      and ast.dump(node.test.values[0]) == ast.dump(ast.parse('not consent', mode='eval').body)
                      and ast.dump(node.test.values[1]) == ast.dump(ast.parse(
                          'expected_review(request, pending_review.append(part))', mode='eval').body)]
        self.assertEqual(len(candidates), 1)
        writes = [node for node in ast.walk(candidates[0]) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == 'write']
        self.assertEqual(len(writes), 1)
        self.assertEqual(ast.literal_eval(writes[0].args[1]), b'apply no-menu\n')
        finishes = [node for node in ast.walk(main) if isinstance(node, ast.If)
                    and ast.dump(node.test) == ast.dump(ast.parse('not consent', mode='eval').body)
                    and len(node.body) == 1 and isinstance(node.body[0], ast.Expr)
                    and ast.dump(node.body[0].value) == ast.dump(ast.parse('pending_review.finish()', mode='eval').body)]
        self.assertEqual(len(finishes), 1)
        selected_kinds = {type(node).__name__ for node in SELECTED}
        self.assertEqual(selected_kinds, {'Assign', 'FunctionDef', 'ClassDef'})
        self.assertNotIn(main, SELECTED)


if __name__ == '__main__':
    unittest.main()
