"""Data-only preparation of the existing fixed outer-TTY request.

No actor, Node, PTY, application or lifecycle operation is invoked. Original
records remain unchanged; a partial/uncertain fresh request is never retried or
cleaned up. The resulting hash is data, not runtime admission or acceptance.
"""
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import types


def load_actor(source):
    file = source + '/scripts/linux-owned-second-seal-pty.py'
    actor = types.ModuleType('_hub_fixed_outer_request_io')
    actor.__file__ = file
    # Fixed inert source reuse without an import-loader .pyc write or __main__.
    exec(compile(pathlib.Path(file).read_bytes(), file, 'exec'), actor.__dict__)
    return actor


def request_from_originals(actor, source, build, home, uid, commit):
    source_hashes = {}
    for name in actor.SOURCE_NAMES:
        source_hashes[name] = actor.observed(source + '/' + name, 1024 * 1024, uid)['sha256']
    loader = actor.observed(source + '/node_modules/tsx/dist/loader.mjs', 1024 * 1024, uid)
    records = {}
    for role in ('a', 'b', 'c'):
        records[role] = {}
        for name in actor.RECORD_NAMES:
            cap = 16 * 1024 ** 2 if name == 'inputs.json' else 4 * 1024 ** 2
            records[role][name] = actor.observed(build + '/records-' + role + '/' + name, cap, uid)['sha256']
    request = {'schema': 1, 'sourceCommit': commit, 'buildRoot': build,
               'loaderSHA256': loader['sha256'], 'sourceSHA256': source_hashes, 'recordsSHA256': records}
    actor.require(actor.validate_request(request, home, commit) == build, 'REQUEST_FIXED_SCHEMA')
    return request


def prepare_request(actor, source, build, home, uid, commit):
    """Only captured original actor validators/FD ownership perform real data IO."""
    owner = {'request': None, 'originals': None, 'raw': None, 'output': None,
             'pending': None, 'returned': [], 'result': None}
    actor.STATE['returned'].append(owner)  # Before even input reads can allocate a descriptor.
    try:
        actor.require(isinstance(build, str) and build.startswith(home + '/'), 'REQUEST_BUILD_HOME')
        actor.parents(build, uid)
        actor.require(source != build and not source.startswith(build + '/') and
                      not build.startswith(source + '/'), 'REQUEST_BUILD_CONTAINMENT')
        file = build + '/outer-second-seal-request.json'
        try:
            os.lstat(file)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError('REQUEST_OUTPUT_EXISTS')
        owner['request'] = request_from_originals(actor, source, build, home, uid, commit)
        owner['originals'] = actor.read_inputs(owner['request'], source, uid)
        raw = (json.dumps(owner['request'], sort_keys=True, separators=(',', ':')) + '\n').encode()
        owner['raw'] = raw
        actor.require(0 < len(raw) <= 65536, 'REQUEST_BOUND')
        owner['pending'] = 'open'
        output = actor.opened(file, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
        owner['output'] = output
        owner['pending'] = None
        at = 0
        while at < len(raw):
            owner['pending'] = 'write'
            count = os.write(output['fd'], raw[at:])
            owner['returned'].append(count)  # Actual return is retained before checking it.
            actor.require(type(count) is int and 0 < count <= len(raw) - at, 'REQUEST_WRITE')
            at += count
            owner['pending'] = None
        owner['pending'] = 'sync'
        returned = os.fsync(output['fd'])
        owner['returned'].append(returned)
        owner['pending'] = None
        before = os.fstat(output['fd'])
        owner['returned'].append(before)
        actual = actor.observed(file, 65536, uid)
        owner['returned'].append(actual)
        actor.require(actual['raw'] == raw and actor.identity(before) == actual['identity'], 'REQUEST_READBACK')
        fresh = actor.read_inputs(owner['request'], source, uid)
        owner['returned'].append(fresh)
        actor.require(fresh == owner['originals'], 'REQUEST_ORIGINALS_CHANGED')
        head = actor.observed(source + '/.git/HEAD', 256, uid)
        owner['returned'].append(head)
        named = actor.observed(file, 65536, uid)
        owner['returned'].append(named)
        actor.require(head['raw'].decode('ascii').strip() == commit and
                      named == actual and actor.identity(os.fstat(output['fd'])) == named['identity'], 'REQUEST_SOURCE_OR_OUTPUT_CHANGED')
        owner['pending'] = 'close'
        actor.closed(output)  # One close; uncertain close remains in the original actor FD owner.
        owner['pending'] = None
        result = {'path': file, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        owner['result'] = result
        return result
    except BaseException as error:
        actor.fail(error)  # Preserve the raw first value and original FD/partial-output custody.
        raise


def unknown_data(actor):
    return bool(actor.STATE['fds'] or any(not item['returned'] or
                (item['close_issued'] and not item['closed']) for item in actor.STATE['opens']))


def main(args):
    if len(args) != 2 or args[0] != '--build-root':
        raise RuntimeError('REQUEST_ARGUMENT')
    source = str(pathlib.Path(__file__).resolve().parents[1])
    actor = load_actor(source)
    try:
        uid, home = os.getuid(), os.environ.get('HOME', '')
        actor.require(sys.platform == 'linux' and uid > 0 and uid == os.geteuid() and
                      home.startswith('/') and os.path.realpath(home) == home, 'REQUEST_HOST')
        commit = actor.observed(source + '/.git/HEAD', 256, uid)['raw'].decode('ascii').strip()
        actor.require(re.fullmatch('[a-f0-9]{40}', commit) and commit == os.environ.get('GITHUB_SHA') and
                      os.environ.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub' and
                      os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
                      re.fullmatch('[1-9][0-9]{0,31}', os.environ.get('GITHUB_RUN_ID', '')), 'REQUEST_ACTUAL_SOURCE_CONTEXT')
        result = prepare_request(actor, source, args[1], home, uid, commit)
        # Only the exact request SHA is emitted; no paths, records, consent or success flags.
        sys.stdout.write(result['sha256'] + '\n')
        sys.stdout.flush()
    except BaseException as error:
        if not actor.STATE['first_set']:
            actor.fail(error)
        try:
            os.write(2, b'Fixed second-seal request preparation is nonpassing; uncertain data custody is retained.\n')
        except BaseException as report_error:
            actor.STATE['secondary'].append(report_error)
        while unknown_data(actor):
            try:
                time.sleep(0.5)
            except BaseException as wait_error:
                actor.STATE['secondary'].append(wait_error)
        raise SystemExit(78)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except BaseException:
        sys.stderr.write('Fixed request inputs were refused before owned data preparation.\n')
        raise SystemExit(78)
