"""Same-job data custody and held Linux provider assembly. No executable entry point."""

from base64 import b64encode
from contextlib import contextmanager, nullcontext, redirect_stdout
from dataclasses import dataclass
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import stat
from urllib.parse import urlsplit
import zipfile

import contract
from intake import (
    BLOCK, DIR_FLAGS, READ_FLAGS, Stage, Refused, available, deadline, inode, need,
    owned_parent, public_bytes, verified_body,
)


ROOT = Path(__file__).resolve().parent
PLAN = 'f1cae7b1b253672e9de857aac673c1b275e65b7d20b2a8022e03228faf4fddf2'
BASE = '5e3c66f4a62e3606abdd650972e0f76b71ff5c54'
INPUT_BYTES = 135996198
INPUT_CAP = 136 * 1024**2
MIB = 1024**2
PUBLISHERS = {'codeload.github.com', 'raw.githubusercontent.com', 'proxy.golang.org',
              'dl.google.com', 'nodejs.org', 'registry.npmjs.org'}
BODY_PINS = {
    'recipe/linux-all-eight.py': '1cafe50a9dab937427f16ccfe34ef6d5ab06626202f6ebb32d1c47464504c28d',
    'recipe/linux-all-eight-inputs.json': '2df7ede2f96b922bf2b4f239223c7ad8f00f9dcfafdf810a8a5c730aba147c7d',
    'recipe/linux-provider-rehearsal.py': 'ba8d05fed245056ce7383e2d10a682d7725aef04cf371110d757211a1680a9f9',
    'recipe/linux-provider-inputs.json': 'fde75f4f5e0693b48f309705f1b295a8a70d0f796a776cb86465431c227c031c',
    'overlay/LINUX-NODE-GZIP.patch': '02b08547dc8e8dbaa01e95f1ef9831e2734548bb3566d788843c46f49cdc54ff',
    'overlay/emit.cjs': 'a876f3683a8cd7479858e6e22b9de8442915407529de2a402b99f3390117f6a0',
    'overlay/archive.ts': 'baf8030c14146d2d24b9e16deea051b101d9a842dd6b1b0efa42d65208ad7373',
    'overlay/ArchiveTarget.ts': '97e391408405a3b7aef029adac3fe7cd1d2499a04a0d2f8dd1baf6655d237ce1',
}
REGISTRY = ('typescript', '@types/node', 'undici-types', '@types/debug', '@types/ms')
TARGETS = ('archive', 'ArchiveTarget')
HEX40 = re.compile('[a-f0-9]{40}')
HEX64 = re.compile('[a-f0-9]{64}')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def sri(body):
    return 'sha512-' + b64encode(hashlib.sha512(body).digest()).decode('ascii')


def text_blob(path, digest, cap):
    with path.open('rb') as stream:
        data = stream.read(cap + 1)
    need(0 < len(data) <= cap and sha(data) == digest, 'reviewed-control-file')
    return data


@dataclass(frozen=True)
class BuildPin:
    name: str
    group: str
    url: str
    size: int
    sha256: str
    git_blob: str | None
    integrity: str | None

    def address(self):
        uri = urlsplit(self.url)
        need(uri.scheme == 'https' and uri.netloc in PUBLISHERS and self.url == uri.geturl()
             and not uri.query and not uri.fragment and self.url.isascii()
             and re.fullmatch(r'/[A-Za-z0-9@./_-]+', uri.path)
             and all(x not in {'', '.', '..'} for x in uri.path[1:].split('/')), 'public-publisher-address')
        return uri


def load_plan(raw=None):
    raw = (ROOT / 'build-inputs.json').read_bytes() if raw is None else raw
    need(len(raw) <= 65536 and sha(raw) == PLAN, 'build-plan-digest')
    cfg = json.loads(raw)
    need((cfg['tree'], cfg['lockSHA256'], cfg['baseCommit']) == (contract.TREE, contract.LOCK, BASE),
         'successor-binding')
    rows = [BuildPin(*row) for row in cfg['inputs']]
    need(len(rows) == len({p.name for p in rows}) == len({p.url for p in rows}) == 80
         and sum(p.size for p in rows) == INPUT_BYTES <= INPUT_CAP, 'input-closure')
    for p in rows:
        p.address()
        need(re.fullmatch('[a-z0-9-]{1,45}', p.name) and 0 < p.size < 68*MIB
             and HEX64.fullmatch(p.sha256)
             and (p.git_blob is None or HEX40.fullmatch(p.git_blob))
             and (p.integrity is None or re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', p.integrity)),
             'input-pin')
    return rows


@dataclass(frozen=True)
class Binding:
    ref: str
    sha: str
    run: str
    nonce: str

    @classmethod
    def from_environment(cls, env, reviewed_ref, nonce):
        ref = env.get('GITHUB_REF', '')
        sha_value = env.get('GITHUB_SHA', '')
        run = env.get('GITHUB_RUN_ID', '')
        need(env.get('GITHUB_REPOSITORY') == 'brucerry/embedded-linux-diagnostic-hub'
             and ref == reviewed_ref and re.fullmatch(r'refs/heads/ci/[a-z0-9-]+', ref)
             and HEX40.fullmatch(sha_value) and env.get('GITHUB_WORKFLOW_SHA') == sha_value
             and env.get('GITHUB_RUN_ATTEMPT') == '1'
             and re.fullmatch(r'[1-9][0-9]{0,18}', run) and HEX64.fullmatch(nonce), 'job-context')
        return cls(ref, sha_value, run, nonce)

    def frame(self):
        ident = json.dumps([self.ref, self.sha, self.run, self.nonce, PLAN, contract.TREE, contract.LOCK],
                           separators=(',', ':')).encode()
        return b'HUB-PROVIDERS/1 ' + sha(ident).encode() + b'\n'


def check_bytes(raw, pin):
    verified_body(io.BytesIO(raw), pin)
    need(pin.integrity is None or sri(raw) == pin.integrity, 'publisher-integrity')
    return raw


class StagedInputs:
    def __init__(self, stage, pins, binding, checkpoints):
        self.stage = stage
        self.pins = pins
        self.by_url = {p.url: p for p in pins}
        self.binding = binding
        self.checkpoints = checkpoints

    def fetch_staged(self, url, size):
        need(url in self.by_url and self.by_url[url].size == size, 'unstaged-input-request')
        pin = self.by_url[url]
        self.stage.directory()
        fd = os.open(pin.name, READ_FLAGS, dir_fd=self.stage.fd)
        with os.fdopen(fd, 'rb') as raw:
            row = os.fstat(raw.fileno())
            self.stage.file(row, pin.name)
            buf = raw.read(size + 1)
            linked = os.stat(pin.name, dir_fd=self.stage.fd, follow_symlinks=False)
            self.stage.file(linked, pin.name)
            need(os.fstat(raw.fileno()).st_ctime_ns == row.st_ctime_ns == linked.st_ctime_ns,
                 'staged-input-change')
        return check_bytes(buf, pin)


@contextmanager
def public_stage(parent, binding, checkpoints, reader=public_bytes):
    """Keep source bytes private until the same job consumes them and then retire them."""
    pins = load_plan()
    checkpoints['intake'] = 'fail'
    with owned_parent(parent) as host:
        block = max(os.fstatvfs(host).f_frsize, 4096)
        reserve = sum(((p.size + block - 1) // block) * block for p in pins) + BLOCK
        need(available(host) >= contract.FLOOR + reserve, 'pre-staging-capacity')
        name = 'hub-build-inputs-' + secrets.token_hex(12)
        os.mkdir(name, 0o700, dir_fd=host)
        checkpoints['retirement'] = 'fail'
        try:
            fd = os.open(name, DIR_FLAGS, dir_fd=host)
        except OSError as exc:
            raise Refused('scratch-retirement-unverified') from exc
        stage = Stage(host, name, fd)
        bound = StagedInputs(stage, pins, binding, checkpoints)
        admitted = False
        try:
            with deadline(240):
                for pin in pins:
                    stage.stage(pin, reader)
                stage.readback(pins)
                # SRI is independently read back over the kept exact bytes.
                for pin in pins:
                    if pin.integrity is not None:
                        bound.fetch_staged(pin.url, pin.size)
                checkpoints['intake'] = 'pass'
                checkpoints['capacity'] = 'fail'
                with owned_parent(parent) as current:
                    need(inode(os.fstat(current)) == inode(os.fstat(host)), 'stage-ancestry-readback')
                    directory = stage.directory()
                    need(directory.st_dev == os.fstat(current).st_dev and available(fd) >= contract.FLOOR,
                         'post-staging-capacity')
                checkpoints['capacity'] = 'pass'
                admitted = True
            yield bound
        finally:
            try:
                # Preserve task evidence if certified inputs became mutable.
                if admitted:
                    stage.readback(pins)
                stage.retire()
                checkpoints['retirement'] = 'pass'
            except (OSError, Refused) as exc:
                raise Refused('scratch-retirement-unverified') from exc
            finally:
                os.close(fd)


def recipe_objects():
    for path, pin in BODY_PINS.items():
        text_blob(ROOT / path, pin, MIB)
    path = ROOT / 'recipe/linux-all-eight.py'
    spec = importlib.util.spec_from_file_location('reviewed_provider_recipe', path)
    code = importlib.util.module_from_spec(spec)
    # The digest-pinned reviewed Python module contains no top-level tool invocation.
    exec(compile(text_blob(path, BODY_PINS['recipe/linux-all-eight.py'], MIB),
                 'reviewed_provider_recipe', 'exec'), code.__dict__)
    return code, code.helpers(), code.config()


def archive_inputs(fetch):
    """Inspect actual publisher bytes as data. Return distinct support-role verdicts."""
    code, tool, cfg = recipe_objects()
    exact = {p.name: p for p in load_plan()}

    def source(name):
        p = exact[name]
        return check_bytes(fetch(p.url, p.size), p)

    checks = {}
    g = cfg['go']
    go = code.decoded(source('go'), g['expandedBytes'])
    need(len(go) == g['expandedBytes'], 'go-size')
    for tar, rows in code.rows(go, 'go', g['entryCount']):
        need(len(rows) == g['entryCount'], 'go-census')
        for name, digest in g['executables'].items():
            item = rows[name]
            need(item.mode & 0o100 and sha(code.member(tar, item)) == digest, 'go-member')
        need(code.member(tar, rows['go/VERSION']).splitlines()[0] == b'go1.26.5', 'go-version-file')
    del go
    checks['goMembers'] = g['entryCount']
    node = tool.data_archive(source('node'), tool.PREFIX, 256*MIB, {'bin/node'})['bin/node'][1]
    need(len(node) == 126881248 and sha(node) == tool.NODE_SHA, 'node-member')
    del node
    checks['nodeExecutable'] = True
    for name in REGISTRY:
        files = code.package_files(fetch, name, cfg['npm'][name])
        if name == 'typescript':
            need(sha(files['lib/typescript.js'][1]) == tool.COMPILER_SHA, 'typescript-member')
    checks['compilerAndDeclarationArchives'] = len(REGISTRY)
    builder = builder_members(source('builder-base'), tool)
    checks['builderPublisherMembers'] = len(builder)
    for name in TARGETS:
        p = 'builder-source-' + name.lower()
        m = json.loads(builder[f'out/targets/{name}.js.map'][1])
        need(m['sources'] == [f'../../src/targets/{name}.ts']
             and [x.encode() for x in m['sourcesContent']] == [source(p)], 'builder-source-map-binding')
    checks['builderUpstreamSources'] = len(TARGETS)
    checks.update(go_sources(code, cfg, source))
    return checks


def verify_for_job(staged, identity):
    """Bind the compiler and Builder role checks to the same live intake object."""
    need(staged.binding == identity and staged.checkpoints.get('intake') == 'pass'
         and staged.checkpoints.get('capacity') == 'pass', 'build-input-job-binding')
    staged.checkpoints['buildInputs'] = 'fail'
    verdicts = archive_inputs(staged.fetch_staged)
    staged.stage.readback(staged.pins)
    staged.checkpoints['buildInputs'] = 'pass'
    return verdicts


def go_sources(code, cfg, source):
    revision = cfg['providers']['esbuild']['sourceCommit']
    prefix = 'esbuild-' + revision
    archive = code.decoded(source('esbuild-source'), 32*MIB)
    expected = cfg['esbuild']['files']
    g = cfg['go']
    for tar, rows in code.rows(archive, prefix, 1024, True, ('comment', 'path', 'mtime')):
        for name, digest in expected.items():
            need(sha(code.member(tar, rows[f'{prefix}/{name}'])) == digest, 'esbuild-source-member')
        sums = code.member(tar, rows[f'{prefix}/go.sum']).decode().splitlines()
        modfile = code.member(tar, rows[f'{prefix}/go.mod']).decode().splitlines()
        lines = [s.strip() for s in modfile if s.strip() and not s.lstrip().startswith('//')]
        need(sums == g['goSum'] and lines == ['module github.com/evanw/esbuild', 'go 1.13',
             'require golang.org/x/sys ' + g['moduleVersion']], 'esbuild-module-pins')
    mod = source('x-sys-mod')
    need(json.loads(source('x-sys-info'))['Version'] == g['moduleVersion'], 'module-version')
    path_prefix = 'golang.org/x/sys@' + g['moduleVersion'] + '/'
    with zipfile.ZipFile(io.BytesIO(source('x-sys-zip'))) as archive_zip:
        entries = archive_zip.infolist()
        names = {e.filename for e in entries}
        need(len(names) == len(entries) == 496 and sum(e.file_size for e in entries) <= 32*MIB,
             'module-census')
        slots = {}
        for item in entries:
            need(item.filename.startswith(path_prefix) and code.safe_path(item.filename)
                 and not item.is_dir() and not item.flag_bits & 1
                 and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), 'module-member')
            with archive_zip.open(item) as f:
                slots[item.filename] = hashlib.file_digest(f, 'sha256').hexdigest()
        need(slots.get(path_prefix + 'go.mod') == sha(mod), 'module-go-mod')

    def h1(rows):
        manifest = ''.join(f'{digest}  {name}\n' for name, digest in sorted(rows.items())).encode()
        return 'h1:' + b64encode(hashlib.sha256(manifest).digest()).decode()

    need([h1(slots), h1({'go.mod': sha(mod)})] == [s.split()[-1] for s in sums], 'module-h1')
    return {'goSourceMembers': len(expected), 'goModuleMembers': len(slots)}


def builder_members(raw, tool):
    files = tool.data_archive(raw, 'package/', 16*MIB)
    meta = json.loads(files['package.json'][1])
    need(meta['name'] == 'app-builder-lib' and meta['version'] == '26.15.3', 'builder-base-identity')
    return files


def builder_finish(base, generated, tool, cfg, scope):
    want = scope['gzipBuilder']
    old = cfg['providers']['app-builder-lib']
    need(len(base) == old['bytes'] and sha(base) == old['sha256'] and sri(base) == old['lockIntegrity'],
         'matcher-builder-identity')
    members = builder_members(base, tool)
    profile = old['localRetainedMemberReassembly']
    need(tool.emit(members, profile)[1] == base, 'matcher-builder-reassembly')
    changes = want['changedProviderMembers']
    need(set(generated) == set(changes) and len(changes) == 4, 'builder-output-census')
    for path, pair in changes.items():
        mode, content = members[path]
        need(sha(content) == pair['oldSHA256'] and sha(generated[path]) == pair['newSHA256'],
             'builder-member-delta')
        members[path] = (mode, generated[path])
    tar, blob = tool.emit(members, profile)
    p = want['provider']
    need((len(members), sha(tar), len(blob), sha(blob), sri(blob)) ==
         (p['memberCount'], p['tarSHA256'], p['bytes'], p['sha256'], p['SRI'])
         and builder_members(blob, tool) == members, 'builder-final-identity')
    return blob


def assemble_providers(root, fetch, run, layout=None, *, checkpoint=lambda _: nullcontext()):
    """Held worker recipe. The supplied runner must already enforce the worker profile."""
    with checkpoint('provider_plan'):
        code, tool, cfg = recipe_objects()
        scope = contract.pinned()
        before = tool.pins()
        need(all(cfg['providers'][name] == before['expected'][name] for name in code.NAMES[:3]),
             'prior-provider-binding')
        fetch_plan = {p.name: p for p in load_plan()}
        node = None if layout is None else layout.node

    def compile_matcher(args):
        out, err = run(args, root, {**code.ENV, 'HOME': str(root)}, 30)
        need(not out and not err, 'matcher-compiler')

    # The helper emits ordinary fixed verdicts. Keep the worker output channel
    # free for the final frame when a fully reviewed launcher is available.
    with redirect_stdout(io.StringIO()):
        with checkpoint('provider_filelist_ssh2'):
            tool.js_providers(root, before, fetch)
        with checkpoint('provider_builder_matcher'):
            tool.builder(root, before, fetch, compile_matcher, node)
        code.build_esbuild(tool, fetch, run, cfg, root, layout, checkpoint=checkpoint)
        code.build_proxies(tool, fetch, run, cfg, root, node, checkpoint=checkpoint)
    with checkpoint('provider_gzip_builder'):
        old = cfg['providers']['app-builder-lib']
        base = code.read(root / old['file'], 16*MIB, old['sha256'])
        files = builder_members(base, tool)
        work = root / 'gzip-emit'
        tool.save(work, 'emit.cjs', text_blob(ROOT / 'overlay/emit.cjs', BODY_PINS['overlay/emit.cjs'], MIB))
        tool.save(work, 'compiler/typescript.js', code.read(root / 'tool/typescript.js', 16*MIB, tool.COMPILER_SHA))
        for n in TARGETS:
            input_pin = fetch_plan['builder-source-' + n.lower()]
            clean = check_bytes(fetch(input_pin.url, input_pin.size), input_pin)
            sm = json.loads(files[f'out/targets/{n}.js.map'][1])
            need(sm['sources'] == [f'../../src/targets/{n}.ts'] and [x.encode() for x in sm['sourcesContent']] == [clean],
                 'builder-source-map-binding')
            tool.save(work, f'source/before/{n}.ts', clean)
            path = f'overlay/{n}.ts'
            tool.save(work, f'source/after/{n}.ts', text_blob(ROOT / path, BODY_PINS[path], MIB))
            for ext in ('.js', '.js.map'):
                tool.save(work, f'emit/before/{n}{ext}', files[f'out/targets/{n}{ext}'][1])
        (work / 'emit/after').mkdir(mode=0o700)
        out, err = run([node or root/'tool/node', work/'emit.cjs'], work, {**code.ENV, 'HOME': str(root)}, 30)
        need(not err and out == b'Exact baseline JS+map parity for both files; emitted the changed TypeScript slice with TS 5.8.2.\n',
             'gzip-builder-compile')
        generated = {p: code.read(work/'emit/after'/Path(p).name, MIB)
                     for p in scope['gzipBuilder']['changedProviderMembers']}
        final = builder_finish(base, generated, tool, cfg, scope)
        (root / old['file']).unlink()
        tool.save(root, scope['gzipBuilder']['provider']['file'], final)
    with checkpoint('provider_archive_digests'):
        expected = scope['successorProviders']
        need({v.name for v in (root/'vendor').iterdir()} == {Path(r['path']).name for r in expected.values()},
             'output-directory')
        result = {name: code.read(root / row['path'], 16*MIB, row['sha256']) for name, row in expected.items()}
        contract.verify_output_rows(scope, result)
    return result


def read_exact(stream, count):
    body = bytearray()
    while len(body) < count:
        block = stream.read(min(count-len(body), BLOCK))
        need(isinstance(block, bytes) and 0 < len(block) <= count-len(body), 'output-truncated')
        body.extend(block)
    return bytes(body)


def receive_closed_frame(stream, binding, scope):
    header = binding.frame()
    need(read_exact(stream, len(header)) == header, 'output-job-binding')
    rows = scope['successorProviders']
    need(len(rows) == 8 and all(0 < r['size'] <= contract.OUTPUT_CAP for r in rows.values())
         and sum(r['size'] for r in rows.values()) <= contract.OUTPUT_CAP, 'output-cap')
    objects = {name: read_exact(stream, rows[name]['size']) for name in sorted(rows)}
    need(stream.read(1) == b'', 'output-trailing')
    contract.verify_output_rows(scope, objects)
    return {name: {'size': len(blob), 'sha256': sha(blob), 'integrity': sri(blob)} for name, blob in objects.items()}


def write_frame(stream, binding, scope, objects):
    contract.verify_output_rows(scope, objects)
    header = binding.frame()
    need(stream.write(header) == len(header), 'output-frame-write')
    for name in sorted(objects):
        blob = objects[name]
        need(stream.write(blob) == len(blob), 'output-frame-write')
    stream.flush()


def finish_worker(stream, binding, scope, inspection, immutable_id, remove_exact, remaining, *, eof, timed_out):
    need(HEX64.fullmatch(immutable_id), 'worker-id')
    state = inspection['State']
    need(inspection['Id'] == immutable_id
         and inspection.get('Config', {}).get('Labels') == {'org.hub.provider-run': binding.run}
         and state['Status'] == 'exited' and state['Pid'] == 0
         and state['Running'] is False, 'worker-retirement-ambiguous')
    # On a proven inactive identity, retire even a failed compiler safely.
    try:
        need(state['ExitCode'] == 0 and state['OOMKilled'] is False and eof is True and timed_out is False,
             'worker-process-closure')
        result = receive_closed_frame(stream, binding, scope)
    finally:
        removal = remove_exact(immutable_id)
        leftovers = remaining()
        need(removal == immutable_id and leftovers == [], 'worker-retirement-unverified')
    contract.teardown(inspection, immutable_id, removal, leftovers, eof, timed_out)
    return result


def check_worker_runtime(reference):
    scope = contract.pinned()
    expected = scope['noble']
    need(reference['officialManifestSHA256'] == expected['manifest'].split(':', 1)[1]
         and reference['configSHA256'] == expected['config'].split(':', 1)[1], 'worker-image-reference')
    need({'python3', 'python3-minimal', 'libexpat1'} <= set(reference['packages']), 'worker-python-closure')
    # A stock package census is only the first predicate. A future whole
    # runtime proof must also bind the exact interpreter, stdlib and ELF closure.
    raise Refused('worker-python-runtime-not-admitted')
