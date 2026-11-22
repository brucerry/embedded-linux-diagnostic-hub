"""Same-worker admission for the original Linux package verifier."""

from contextlib import nullcontext
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
from time import monotonic

import archive_inventory
import compiler_gate
import handoff
import read_envelope
import reader_input
import tar_admission as pins
from worker_protocol import EXTRACTION_POLICY_REVIEWED

LOADER = Path("/lib64/ld-linux-x86-64.so.2")
LIBDIR = Path("/usr/lib/x86_64-linux-gnu")
LIBRARIES = {"libc.so.6", "libm.so.6", "libz.so.1", "libzstd.so.1", "liblz4.so.1", "liblzma.so.5", "liblzo2.so.2", LOADER.name}
HOST_TAR = Path("/usr/bin/tar")
TEMP_ROOT = Path("/work/temp")
EXTRACTION_TEMP = TEMP_ROOT / "package-verify"
READER_SECONDS = 15
VERIFY_SECONDS = 120
OUTPUT_LIMIT = 1024**2
VERIFIER = "scripts/verify-linux-package.mjs"


def ended(group):
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return True
    return False


def bounded(argv, cwd, env, seconds, drain):
    """Shared bounded output, EOF and exact process-group exit, then PID-1 child closure."""
    deadline = monotonic() + seconds
    drain()
    with subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,start_new_session=True) as child:
        try:
            with selectors.DefaultSelector() as watch:
                watch.register(child.stdout, selectors.EVENT_READ, bytearray())
                watch.register(child.stderr, selectors.EVENT_READ, bytearray())
                streams = [row.data for row in watch.get_map().values()]
                total = 0
                while watch.get_map():
                    remaining = deadline - monotonic()
                    pins.need(remaining > 0, "verifier-timeout")
                    events = watch.select(remaining)
                    pins.need(events, "verifier-timeout")
                    for key, _ in events:
                        chunk = os.read(key.fd, min(65536, OUTPUT_LIMIT+1-total))
                        if not chunk:
                            watch.unregister(key.fileobj)
                            continue
                        total += len(chunk)
                        pins.need(total <= OUTPUT_LIMIT,"verifier-output-cap")
                        key.data.extend(chunk)
            pins.need(child.wait(timeout=max(0,deadline-monotonic())) == 0
                      and ended(child.pid),"verifier-exit-or-group")
            drain()
            pins.need(not streams[1],"verifier-stderr")
            return bytes(streams[0])
        except BaseException:
            if not ended(child.pid):
                try:
                    os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.wait(timeout=5)
            pins.need(ended(child.pid),"verifier-group-not-closed")
            drain()
            raise


def admit_reader(data, project, parse_loader, drain):
    pins.need(not data["installed"] and not data["executed"] and not data["liveLoaderCacheObserved"],
              "reader-data-pin-scope")
    files = data["projectedRoles"]
    library_roles = {str(LIBDIR/name) for name in LIBRARIES}
    pins.need(set(files) == library_roles | {reader_input.MEMBER} and not os.path.lexists("/etc/ld.so.preload"),
              "reader-closed-role-set")
    expected = {}
    for role in sorted(library_roles):
        entry = files[role]["expected"]
        path = Path(entry["canonical"])
        pins.need(path.parent == LIBDIR and Path(role).resolve(strict=True) == path,"reader-stock-role-path")
        if Path(role) != path:
            compiler_gate.read_alias(Path(role), {"uid":0,"gid":0,"mode":"0777","target":path.name})
        compiler_gate.read_member(path,{"bytes":entry["bytes"],"sha256":entry["digest"],
                                  "mode":format(entry["mode"],"04o"),"uid":0,"gid":0},capture=False)
        expected[Path(role).name] = str(path)
    pins.need(LOADER.resolve(strict=True) == Path(expected[LOADER.name]),"reader-canonical-interpreter")
    staged, seal = reader_input.stage_member(reader_input.INPUT, files[reader_input.MEMBER]["expected"])
    env = {"PATH":"/usr/bin:/bin","LANG":"C","LC_ALL":"C","TZ":"UTC"}
    pins.need(reader_input.check_stage(staged) == seal,"reader-closure-stage-identity")
    output = bounded([LOADER,"--list",staged],project,env,READER_SECONDS,drain)
    pins.need(parse_loader(output) == expected,"reader-live-loader-map")
    pins.need(reader_input.check_stage(staged) == seal,"reader-closure-stage-identity")
    return staged, seal, env


def verified_inventory(project, release, attempt, seal, reader, reader_seal, reader_env, drain):
    handoff.recheck_for_verifier(release,attempt,seal)
    envelope = read_envelope.stable_read(release/handoff.APPIMAGE)
    image, tar = seal.artifacts
    pins.need((envelope["artifactSHA256"],envelope["bytes"]) == (image.sha256,image.size),
              "squash-envelope-to-seal")
    pins.need(reader_input.check_stage(reader) == reader_seal,"reader-inventory-stage-identity")
    listing = bounded([reader,"-offset",str(handoff.RUNTIME_BYTES),"-strict-errors",
                       "-no-progress","-lln",release/handoff.APPIMAGE],
                      project,reader_env,READER_SECONDS,drain)
    image_rows = archive_inventory.squash_inventory(listing,envelope["squashfsInodes"])
    with handoff.release_directory(release) as (directory, identity):
        pins.need(identity == seal.directory,"tar-inventory-producer-directory")
        with handoff.open_original(directory,handoff.TARBALL,handoff.ARCHIVE_CAP,False) as (body,size,stamp):
            pins.need((size,stamp) == (tar.size,tar.identity),"tar-inventory-producer-file")
            tar_rows = archive_inventory.tar_inventory(body)
    handoff.recheck_for_verifier(release,attempt,seal)
    return tar_rows,image_rows


def private_temp(parent):
    pins.need(parent == TEMP_ROOT and parent.resolve(strict=True) == parent,"verifier-temp-location")
    fd = os.open(parent,os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_RDONLY)
    try:
        row = os.fstat(fd)
        pins.need(row.st_uid == os.getuid() and stat.S_IMODE(row.st_mode) == 0o700
                  and handoff.directory_identity(row) == handoff.directory_identity(parent.lstat())
                  and row.st_dev == Path("/work").stat().st_dev,"owned-worker-temp")
        return handoff.directory_identity(row),os.fstatvfs(fd)
    finally:
        os.close(fd)


def check_capacity(space, budget):
    pins.need(not space.f_flag & os.ST_RDONLY and space.f_bavail*space.f_frsize >= budget["requiredBytes"]
              and space.f_favail >= budget["requiredInodes"],"original-archive-extraction-capacity")

def verify_once(project, release, attempt, seal, node, npm, env, reader, parse_loader, drain, *, phase=nullcontext):
    """Dormant until exact execution approval. Calls the unchanged official verifier."""
    pins.need(EXTRACTION_POLICY_REVIEWED,"appimage-extraction-policy-held")
    with phase("reader_admission"):
        pins.need(os.getuid() == os.geteuid() != 0 and os.getpid() == 1,"private-nonroot-worker")
        # The outer and effective isolation proofs have already run in this worker.
        # Recheck no ingress path, the exact started worker and both original archives.
        pins.need({p.name for p in Path("/sys/class/net").iterdir()} == {"lo"},"verifier-loopback-only")
        status=dict(row.split(":",1) for row in Path("/proc/self/status").read_text().splitlines())
        pins.need(status["Seccomp"].strip()=="2" and status["NoNewPrivs"].strip()=="1"
                  and all(int(status[k].strip(),16)==0 for k in ("CapEff","CapPrm","CapBnd","CapAmb")),
                  "verifier-worker-isolation")
        pins.need(project == Path("/work/source") and release == project/"release"
                  and node == Path("/work/node-sdk/bin/node") and list(npm)==
                      [node,Path("/work/node-sdk/lib/node_modules/npm/bin/npm-cli.js")],
                  "verifier-fixed-entrypoint")
        pins.need(env.get("PATH") == f"{node.parent}:/usr/bin:/bin" and
                  not any(key in env for key in ("APPIMAGE_EXTRACT_AND_RUN","NODE_OPTIONS","NODE_PATH",
                                               "LD_PRELOAD","LD_LIBRARY_PATH","BASH_ENV","ENV")),
                  "verifier-clean-environment")
        # Check the exact admitted source and provider-installed package script again.
        manifest = pins.pins()["SOURCE-FILES.json"]["files"]
        for name in (VERIFIER,"package.json","package-lock.json"):
            _, hashes, _ = pins.file_data(project/name,"official-verifier-source",digests=("git",))
            pins.need(hashes["git"]==manifest[name][0],"official-verifier-source-pin")
        # The official verifier resolves GNU tar from the clean PATH. Don't accept a
        # same-name executable placed earlier in PATH by an installed package.
        npm_shim=npm[1].parent.parent/"node_modules/@npmcli/run-script/lib/node-gyp-bin/tar"
        earlier=[node.parent/"tar",npm_shim,*(p/"node_modules/.bin/tar" for p in (project,*project.parents))]
        pins.need(not any(os.path.lexists(p) for p in earlier),"verifier-no-tar-shadow")
        tar_path=HOST_TAR.resolve(strict=True)
        compiler_gate.protected_ancestors(tar_path)
        tar_stat,_,_=pins.file_data(tar_path,"stock-worker-tar",owned=False)
        pins.need(tar_stat.st_uid == 0 and not tar_stat.st_mode & 0o7022,"stock-worker-tar-mode")

        reader_path,reader_seal,reader_env=admit_reader(reader,project,parse_loader,drain)
    with phase("archive_inventory"):
        tar_rows,image_rows=verified_inventory(project,release,attempt,seal,reader_path,reader_seal,reader_env,drain)
        temp_owner,space=private_temp(TEMP_ROOT)
        plan=archive_inventory.budget(tar_rows,image_rows,space.f_frsize)
        check_capacity(space,plan)
    with phase("archive_verification"):
        EXTRACTION_TEMP.mkdir(mode=0o700)
        own=handoff.directory_identity(EXTRACTION_TEMP.lstat())
        verifier_env={**env,"TMPDIR":str(EXTRACTION_TEMP)}
        # Preserve the official verifier's own tar and AppImage invocation and checks.
        try:
            handoff.recheck_for_verifier(release,attempt,seal)
            pins.need(reader_input.check_stage(reader_path)==reader_seal,"reader-extraction-stage-identity")
            bounded([*npm,"run","verify:linux"],project,verifier_env,VERIFY_SECONDS,drain)
            handoff.recheck_for_verifier(release,attempt,seal)
            pins.need(not any(EXTRACTION_TEMP.iterdir()),"official-verifier-temp-leftovers")
        finally:
            # If closure, ownership, or backing identity becomes uncertain, preserve
            # the directory for the host's already-owned worker retirement instead.
            drain()
            pins.need(private_temp(TEMP_ROOT)[0]==temp_owner and
                      EXTRACTION_TEMP.resolve(strict=True)==EXTRACTION_TEMP and
                      handoff.directory_identity(EXTRACTION_TEMP.lstat())==own and
                      shutil.rmtree.avoids_symlink_attacks,"verifier-temp-retirement-identity")
            shutil.rmtree(EXTRACTION_TEMP)
            pins.need(not os.path.lexists(EXTRACTION_TEMP),"verifier-temp-retirement")
        return plan
