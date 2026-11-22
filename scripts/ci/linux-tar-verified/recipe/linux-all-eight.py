#!/usr/bin/env python3
"""Reconstruct eight source-derived Linux providers and observe their job-local venue."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit
import zlib

HERE = Path(__file__).resolve().parent
MIB = 1 << 20
REPO = "brucerry/embedded-linux-diagnostic-hub"
REF = "refs/heads/ci/v060-linux-all-eight-custody-20261120"
JOB = "linux-provider-custody"
NAMES = ("filelist", "ssh2", "app-builder-lib", "esbuild", "@esbuild/linux-x64",
         "agent-base", "http-proxy-agent", "https-proxy-agent")
CONTEXT = ("GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID",
           "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")
HELPER = "linux-provider-rehearsal.py"
HELPER_SHA = "ba8d05fed245056ce7383e2d10a682d7725aef04cf371110d757211a1680a9f9"
CAP_HELPER_SHA = "b3184eef8abc8c4767cf223cbda6a572080fd96bf225689aa4ba76a2ac4295f3"
INPUTS_SHA = "2df7ede2f96b922bf2b4f239223c7ad8f00f9dcfafdf810a8a5c730aba147c7d"
ENV = {"PATH":"/usr/bin:/bin", "LANG":"C.UTF-8", "TZ":"UTC"}


def need(ok, label):
    if not ok:
        raise ValueError(label)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sri(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def read(file, cap, expected=None):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(file, flags), "rb") as stream:
        before = os.fstat(stream.fileno())
        need(file.resolve() == file and stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_uid in (0,os.getuid()) and not before.st_mode & 0o7022
             and 0 < before.st_size <= cap,"input-handle")
        data = stream.read(before.st_size + 1)
        after = os.fstat(stream.fileno())
        observed = file.lstat()
        need(len(data) == before.st_size and
             (before.st_dev,before.st_ino,before.st_mode,before.st_size,before.st_mtime_ns,before.st_ctime_ns) ==
             (after.st_dev,after.st_ino,after.st_mode,after.st_size,after.st_mtime_ns,after.st_ctime_ns) ==
             (observed.st_dev,observed.st_ino,observed.st_mode,observed.st_size,
              observed.st_mtime_ns,observed.st_ctime_ns), "input-changed")
    need(expected is None or sha(data) == expected, "input-digest")
    return data


def config():
    return json.loads(read(HERE/"linux-all-eight-inputs.json", MIB, INPUTS_SHA))


def helpers():
    path = HERE/HELPER
    buf = read(path,MIB,HELPER_SHA)
    spec = importlib.util.spec_from_loader("provider", loader=None)
    provider = importlib.util.module_from_spec(spec)
    provider.__file__ = str(path)
    exec(compile(buf,str(path),"exec"), provider.__dict__)
    read(HERE/"linux-provider-inputs.json",MIB,
         "fde75f4f5e0693b48f309705f1b295a8a70d0f796a776cb86465431c227c031c")
    return provider


def context(env):
    result = {k:env[k] for k in CONTEXT}
    repo, ref, commit, run_id, attempt, job = result.values()
    need((repo,ref,job) == (REPO,REF,JOB) and env.get("GITHUB_EVENT_NAME") == "push"
         and re.fullmatch(r"[a-f0-9]{40}",commit)
         and re.fullmatch(r"[1-9][0-9]{0,18}",run_id)
         and re.fullmatch(r"[1-9][0-9]{0,8}",attempt), "job-context")
    return result


def public(url, cap):
    """One HTTPS publisher request; do not follow redirects or forward credentials."""
    p = urlsplit(url)
    need(p.scheme == "https" and p.netloc in {"nodejs.org","raw.githubusercontent.com",
          "registry.npmjs.org","proxy.golang.org","codeload.github.com","dl.google.com"}
         and not p.query and not p.fragment and 0 < cap <= 70*MIB, "public-address")
    output = subprocess.run(["/usr/bin/curl","--disable","--silent","--show-error","--fail",
        "--proto","=https","--connect-timeout","7","--max-time","60","--max-filesize",str(cap),
        "--write-out","\n%{http_code}",url], capture_output=True,env=ENV,timeout=65)
    data,sep,status = output.stdout.rpartition(b"\n")
    need(output.returncode == 0 and sep and status == b"200" and 0 < len(data) <= cap, "public-read")
    return data


def command(argv, cwd, env, seconds, runner=()):
    # Files rather than unmanaged pipes give the child a hard output limit.
    prefix = ["/usr/bin/prlimit","--fsize=268435456:268435456","--"]
    out = cwd/".compiler-stdout"
    err = cwd/".compiler-stderr"
    # The pre-pinned Go tool writes its cache and ELF output; output and diagnostics
    # are checked before reading. Only these named, task-owned transient streams are removed.
    with out.open("xb+") as stdout, err.open("xb+") as stderr:
        proc = subprocess.Popen([*runner,*prefix,*argv],cwd=cwd,env=env,
                 stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True)
        try:
            code = proc.wait(seconds)
            try:
                os.killpg(proc.pid,0)
            except ProcessLookupError:
                pass
            else:
                raise ValueError("compiler-closure")
        except (subprocess.TimeoutExpired,ValueError):
            try:
                os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(5)
            raise
        try:
            need(code == 0 and out.stat().st_size + err.stat().st_size < MIB, "compiler-exit")
            stdout.seek(0)
            stderr.seek(0)
            return stdout.read(),stderr.read()
        finally:
            out.unlink()
            err.unlink()


def safe_path(path):
    return (len(path) <= 350 and not path.startswith("/") and
            not set(path.split("/")) & {"",".","..",".git"} and
            not re.search(r"[\\:\x00-\x1f\x7f]",path))


def decoded(raw, cap):
    reader = zlib.decompressobj(31)
    data = reader.decompress(raw,cap+1)
    need(reader.eof and not reader.unused_data and not reader.unconsumed_tail
         and 0 < len(data) <= cap,"archive-bound")
    return data


def official(fetch,pin):
    data = fetch(pin["url"],pin["bytes"])
    need(len(data) == pin["bytes"] and sha(data) == pin["sha256"]
         and ("integrity" not in pin or sri(data) == pin["integrity"]), "publisher-digest")
    return data


def rows(archive, root, count, source_tar=False, metadata=("path","mtime","atime","ctime")):
    end = 0
    inventory = {}
    with tarfile.open(fileobj=io.BytesIO(archive),mode="r:") as tar:
        for item in tar:
            name = item.name
            need(safe_path(name) and (name == root or name.startswith(root+"/"))
                 and name not in inventory and len(inventory) < count and not item.sparse
                 and not item.mode & (0o7000 if source_tar else 0o7022) and item.size <= 64*MIB
                 and set(item.pax_headers) <= set(metadata), "archive-entry")
            is_link = source_tar and item.issym()
            need((item.type in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE) and not item.linkname)
                 or is_link, "archive-type")
            need(item.isfile() or item.size == 0, "archive-size")
            inventory[name] = item
            end = item.offset_data + (item.size+511)//512*512
        need(len(archive)-end >= 1024 and not any(archive[end:]),"archive-eof")
        need(root in inventory and inventory[root].isdir() and all(
            str(PurePosixPath(n).parent) in inventory and inventory[str(PurePosixPath(n).parent)].isdir()
            for n in inventory if n != root), "archive-tree")
        yield tar,inventory


def member(tar, item):
    need(item.isfile(), "archive-regular")
    with tar.extractfile(item) as payload:
        data = payload.read(item.size+1)
    need(len(data) == item.size, "archive-short")
    return data


def esbuild_sources(tool, fetch, pin, commit, root):
    src = f"esbuild-{commit}"
    fmt = decoded(official(fetch,pin["sourceArchive"]),32*MIB)
    expected = pin["files"]
    for tar,index in rows(fmt,src,1024,True,("comment","path","mtime")):
        need(sum(item.issym() for item in index.values()) == 1 and
             sum(item.isfile() for item in index.values()) == 351, "esbuild-source-census")
        need({n.removeprefix(src+"/") for n,r in index.items() if r.isfile() and
             (n.removeprefix(src+"/") in ("go.mod","go.sum","go.version","version.txt","LICENSE.md")
             or n.startswith(src+("/cmd/esbuild/")) or n.startswith(src+"/internal/")
             or n.startswith(src+"/pkg/"))} == set(expected), "esbuild-source-selection")
        for name,digest in expected.items():
            data = member(tar,index[src+"/"+name])
            need(sha(data) == digest,"esbuild-source-file")
            tool.save(root,name,data)
    need((root/"go.version").read_bytes().strip() == b"1.26.5" and
         (root/"cmd/esbuild/version.go").read_bytes() == b'package main\n\nconst esbuildVersion = "0.28.2"\n',
         "esbuild-source-version")


def stage_go(tool, fetch, pin, root, layout=None):
    archive = decoded(official(fetch,pin["distribution"]),pin["expandedBytes"])
    need(len(archive) == pin["expandedBytes"],"go-expanded-size")
    for tar,index in rows(archive,"go",pin["entryCount"]):
        need(len(index) == pin["entryCount"],"go-entry-count")
        for path,item in index.items():
            if item.isfile():
                data = member(tar,item)
                if path in pin["executables"]:
                    need(item.mode & 0o100 and sha(data) == pin["executables"][path], "go-executable")
                if layout is not None and path in pin["executables"]:
                    layout.stage_executable(layout.tools / path, data, tool.save)
                else:
                    tool.save(root,path,data,layout is None and bool(item.mode & 0o100))
    if layout is None:
        for path,digest in pin["executables"].items():
            read(root/path,64*MIB,digest)
    else:
        layout.link_go_data()
        layout.check()
    need((root/"go/VERSION").read_bytes().splitlines()[0] == b"go1.26.5","go-release")


def build_esbuild(tool, fetch, run, cfg, root, layout=None):
    go = cfg["go"]
    profile = cfg["esbuild"]
    wanted = cfg["providers"]
    src = wanted["esbuild"]
    project = root/"esbuild-source"
    esbuild_sources(tool,fetch,profile,src["sourceCommit"],project)
    stage_go(tool,fetch,go,root,layout)
    goroot = root/"go" if layout is None else layout.goroot
    for path,pin in go["moduleProxy"].items():
        tool.save(root/"module-proxy",path,official(fetch,pin))
    go_sum = (project/"go.sum").read_text().splitlines()
    need(go_sum == go["goSum"],"go-source-sums")
    for name in ("ghome","gtmp","gopath","gocache","modcache"):
        (root/name).mkdir(mode=0o700)
    env = {**ENV,"HOME":str(root/"ghome"),"TMPDIR":str(root/"gtmp"),
           "GOENV":"off","GOTOOLCHAIN":"local","GOWORK":"off","GOROOT":str(goroot),
           "GOPATH":str(root/"gopath"),"GOCACHE":str(root/"gocache"),"GOMODCACHE":str(root/"modcache"),
           "GOPROXY":(root/"module-proxy").as_uri(),"GOSUMDB":"sum.golang.org",
           "GOAMD64":"v1","CGO_ENABLED":"0","GOOS":"linux","GOARCH":"amd64"}
    binary_go = goroot/"bin/go"
    mod = "golang.org/x/sys"
    ver = go["moduleVersion"]
    out,err = run([binary_go,"version"],project,env,10)
    need(out.strip() == b"go version go1.26.5 linux/amd64" and not err, "go-version")
    out,err = run([binary_go,"mod","download","-json",mod+"@"+ver],project,env,20)
    got = json.loads(out)
    need(not err and got["Path"] == mod and got["Version"] == ver and
         [got["Sum"],got["GoModSum"]] == [entry.split()[-1] for entry in go_sum], "go-module-sums")
    env["GOPROXY"] = "off"
    out,err = run([binary_go,"mod","verify"],project,env,20)
    need(out.strip() == b"all modules verified" and not err, "go-module-readback")
    executable = root/"esbuild"
    out,err = run([binary_go,"build","-mod=readonly","-trimpath","-buildvcs=false",
                   "-ldflags=-s -w -buildid=","-o",executable,"./cmd/esbuild"],project,env,180)
    need(not out and not err,"esbuild-go-compile")
    binary = read(executable,16*MIB,profile["binarySHA256"])
    need(binary[:6] == b"\x7fELF\x02\x01" and int.from_bytes(binary[18:20],"little") == 62,"esbuild-elf")
    out,err = run([binary_go,"version","-m",executable],project,env,10)
    need(not err and b"\tpath\tgithub.com/evanw/esbuild/cmd/esbuild" in out and
         f"\tdep\t{mod}\t{ver}".encode() in out,"esbuild-buildinfo")
    if layout is not None:
        layout.stage_executable(layout.esbuild, binary, tool.save)
        executable.unlink()
        executable = layout.esbuild
        layout.check()
    wrapper = root/"wrapper-source"
    for path,pin in profile["wrapperFiles"].items():
        tool.save(wrapper,path,tool.raw_get(fetch,src,path,pin))
    pkg = json.loads((wrapper/"npm/esbuild/package.json").read_bytes())
    need((pkg["name"],pkg["version"],pkg["scripts"]) == ("esbuild","0.28.2",{"postinstall":"node install.js"}),
         "esbuild-upstream-manifest")
    for field in ("scripts","optionalDependencies","esbuild.binaryHashes"):
        del pkg[field]
    pkg.update(os=["linux"],cpu=["x64"],dependencies={"@esbuild/linux-x64":"0.28.2"})
    files = {"package.json":(0o644,tool.encoded(pkg)), "LICENSE.md":(0o644,(wrapper/"LICENSE.md").read_bytes()),
             "lib/main.d.ts":(0o644,(wrapper/"lib/shared/types.ts").read_bytes())}
    for dest,source,extra,mode in (
        ("lib/main.js","lib/npm/node.ts",["--define:WASM=false"],0o644),
        ("bin/esbuild","lib/npm/node-shim.ts",[],0o755)):
        out,err = run([executable,source,"--bundle","--target=node10",'--define:ESBUILD_VERSION="0.28.2"',
                    "--external:esbuild","--platform=node","--log-level=warning",*extra],wrapper,ENV,20)
        need(out and not err,"esbuild-wrapper")
        files[dest] = (mode,out)
    manifest = {"name":"@esbuild/linux-x64","version":"0.28.2","license":"MIT",
                "os":["linux"],"cpu":["x64"],"engines":{"node":">=18"}}
    tool.verify_output(root,"esbuild",files,wanted["esbuild"])
    tool.verify_output(root,"@esbuild/linux-x64",{"package.json":(0o644,tool.encoded(manifest)),
                       "LICENSE.md":files["LICENSE.md"],"bin/esbuild":(0o755,binary)},wanted["@esbuild/linux-x64"])


def package_files(fetch, name, pin, only=None):
    # Registry inputs use the previously reviewed data-only npm parser policy:
    # no link/native members or lifecycle, and never apply publisher modes.
    raw = decoded(official(fetch,pin),32*MIB)
    seen = set()
    files = {}
    end = 0
    with tarfile.open(fileobj=io.BytesIO(raw),mode="r:") as tar:
        for item in tar:
            n = item.name.removeprefix(pin["root"])
            need(safe_path(item.name) and len(item.name) < 300 and len(item.name.split("/")) <= 21
                 and (item.name == pin["root"].rstrip("/") or item.name.startswith(pin["root"]))
                 and n not in seen and len(seen) < 10000 and not item.sparse and not item.linkname
                 and not item.mode & 0o7000 and set(item.pax_headers) <= {"path","mtime"},
                 "npm-member-path")
            seen.add(n)
            end = item.offset_data + (item.size+511)//512*512
            if item.isdir():
                need(item.size == 0, "npm-directory")
                continue
            need(n and item.type in (tarfile.REGTYPE,tarfile.AREGTYPE) and item.size < 16*MIB
                 and not n.endswith((".node",".so",".dll",".exe","binding.gyp")), "npm-member-type")
            files[n] = (0o644,member(tar,item))
    need(len(raw)-end >= 1024 and not any(raw[end:]) and all(
        all(str(parent) not in files for parent in PurePosixPath(n).parents) for n in files), "npm-closure")
    manifest = json.loads(files["package.json"][1])
    need((manifest["name"],manifest["version"]) == (name,pin["version"])
         and not (set(manifest.get("scripts",{})) & {"preinstall","install","postinstall","dependencies"}),
         "npm-manifest")
    return files if only is None else {n:files[n] for n in only}


def build_proxies(tool, fetch, run, cfg, root, node_path=None):
    for name in ("typescript","@types/node","undici-types","@types/debug","@types/ms"):
        files = package_files(fetch,name,cfg["npm"][name])
        for path,(_,body) in files.items():
            if name == "typescript" and path == "lib/typescript.js":
                # A single verified archive is fetched; the earlier Builder emitter used these same bytes.
                need(read(root/"tool/typescript.js",16*MIB,tool.COMPILER_SHA) == body,"shared-ts")
            tool.save(root,f"node_modules/{name}/{path}",body)
    tsc = root/"node_modules/typescript/lib/tsc.js"
    node = root/"tool/node" if node_path is None else node_path
    out,err = run([node,"--no-global-search-paths",tsc,"--version"],root,ENV,10)
    need(not err and out.strip() == b"Version 5.8.2","shared-ts-version")
    agent = None
    for name in ("agent-base","http-proxy-agent","https-proxy-agent"):
        want = cfg["providers"][name]
        spec = cfg["proxies"][name]
        project = root/"packages"/name
        prefix = f"packages/{name}/"
        for path,pin in spec["sourceFiles"].items():
            dest = path.removeprefix(prefix) if path.startswith(prefix) else f"node_modules/tsconfig/{Path(path).name}"
            tool.save(project,dest,tool.raw_get(fetch,want,path,pin))
        if name != "agent-base":
            for path,(_,body) in agent.items():
                tool.save(project,f"node_modules/agent-base/{path}",body)
        out,err = run([node,"--permission","--allow-fs-read="+str(root),
                      "--allow-fs-write="+str(project),"--no-global-search-paths",tsc,
                      "-p","tsconfig.json","--pretty","false","--noEmitOnError","--listEmittedFiles"],
                      project,ENV,30)
        files = spec["output"]
        lines = out.decode().splitlines()
        expected = {f"TSFILE: {project}/{p}" for p in files if p.startswith("dist/")}
        need(not err and len(lines) == len(expected) and set(lines) == expected,"proxy-emitted-files")
        packaged = {p:(0o644,read(project/p,8*MIB,pin)) for p,pin in files.items()}
        tool.verify_output(root,name,packaged,want)
        if name == "agent-base":
            agent = packaged


def stage_observation(tool, fetch, cfg, root, node_archive):
    headers = tool.data_archive(node_archive,tool.PREFIX,256*MIB,set(cfg["headers"]))
    for name,(_,body) in headers.items():
        tool.save(root,name,tool.match(body,cfg["headers"][name],"node-header"))
    base = f"https://raw.githubusercontent.com/{REPO}/{cfg['candidate']}/"
    for name,pin in cfg["rules"].items():
        tool.save(root,name,tool.match(fetch(base+name,pin["bytes"]),pin,"production-guard"))
    want = cfg["providers"]["app-builder-lib"]
    builder = read(root/want["file"],16*MIB,want["sha256"])
    subset = tool.data_archive(builder,"package/",16*MIB,
                   {"package.json","out/packager.js","out/targets/archive.js"})
    for name,files in (("app-builder-lib",subset), *(
        (name,package_files(fetch,name,cfg["npm"][name],{"package.json",entry})) for name,entry in
        (("builder-util","out/util.js"),("temp-file","out/main.js")))):
        for path,(_,body) in files.items():
            tool.save(root,f"projection/node_modules/{name}/{path}",body)
    for directory in ("builder-tmp","release"):
        (root/directory).mkdir(mode=0o700)


def verify_archives(cfg, root):
    expected = cfg["providers"]
    need(set(expected) == set(NAMES), "provider-count")
    names = {Path(v["file"]).name for v in expected.values()}
    need({p.name for p in (root/"vendor").iterdir()} == names, "provider-directory")
    for name in NAMES:
        pin = expected[name]
        node = root/pin["file"]
        data = read(node,16*MIB,pin["sha256"])
        need(len(data) == pin["bytes"] and sri(data) == pin["lockIntegrity"], "provider-readback")
    return {name:{key:expected[name][key] for key in ("file","bytes","sha256","lockIntegrity")}
            for name in NAMES}


def reconstruct(root, identify, fetch, run):
    cfg = config()
    tool = helpers()
    base = tool.pins()
    need(all(cfg["providers"][n] == base["expected"][n] for n in NAMES[:3]),"prior-provider-pin")
    shared_urls = {base["officialArchives"][n]["url"] for n in ("node","typescript")}
    retained = {}
    def shared(url, cap):
        if url not in shared_urls:
            return fetch(url,cap)
        if url not in retained:
            retained[url] = fetch(url,cap)
        need(len(retained[url]) == cap,"shared-size")
        return retained[url]
    def emit(args):
        out,err = run(args,root,{**ENV,"HOME":str(root)},30)
        need(not out and not err,"matcher-compiler-output")
    tool.reconstruct(root,shared,emit)
    build_esbuild(tool,shared,run,cfg,root)
    build_proxies(tool,shared,run,cfg,root)
    stage_observation(tool,shared,cfg,root,official(shared,base["officialArchives"]["node"]))
    receipt = {"context":identify,"candidate":cfg["candidate"],"parent":cfg["parent"],
               "linuxLockSHA256":cfg["linuxLockSHA256"],"manifestSHA256":INPUTS_SHA,
               "providers":verify_archives(cfg,root)}
    tool.save(root,"custody.json",tool.encoded(receipt))


def verify_receipt(root, identity):
    cfg = config()
    result = json.loads(read(root/"custody.json",64*1024))
    expected = {"context":identity,"candidate":cfg["candidate"],"parent":cfg["parent"],
                "linuxLockSHA256":cfg["linuxLockSHA256"],"manifestSHA256":INPUTS_SHA,
                "providers":verify_archives(cfg,root)}
    need(result == expected, "job-custody-receipt")
    return result


def venue_directory(env):
    workspace = Path(env["GITHUB_WORKSPACE"])
    need(workspace.is_absolute() and workspace.resolve(strict=True) == workspace and
         workspace.stat().st_uid == os.getuid(), "job-workspace")
    return workspace/".hub-all-eight-private"


def main(args, env):
    os.umask(0o077)
    need(sys.platform == "linux" and os.uname().machine == "x86_64" and
         os.getuid() > 0 and os.getuid() == os.geteuid(), "job-platform")
    need(len(args) == 1 and args[0] in ("custody","capacity"), "job-phase")
    identity = context(env)
    root = venue_directory(env)
    if args[0] == "custody":
        need(os.statvfs(root.parent).f_bavail * os.statvfs(root.parent).f_frsize >= 4*1024**3,
             "initial-workspace-capacity")
        root.mkdir(mode=0o700)
        reconstruct(root,identity,public,command)
        print("eight-exact-provider-archives",flush=True)
    else:
        st = root.lstat()
        need(root.resolve() == root and stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid()
             and stat.S_IMODE(st.st_mode) == 0o700, "job-directory")
        verify_receipt(root,identity)
        read(root/"tool/node",128*MIB,helpers().NODE_SHA)
        read(HERE/"linux-provider-capacity.cjs",64*1024,CAP_HELPER_SHA)
        out,err = command([root/"tool/node",HERE/"linux-all-eight-capacity.cjs",root],root,
                          {**ENV,"HOME":str(root),"TMPDIR":str(root/"builder-tmp")},15)
        need(not err, "capacity-stderr")
        result = json.loads(out)
        helpers().save(root,"capacity.json",helpers().encoded({"context":identity,**result}))
        for k in ("nativeAncestorPass","nativeReservePass","packagingBytesFit"):
            print(f"{k}={'pass' if result[k] else 'refused'}",flush=True)
        need(all(result[k] is True for k in ("nativeAncestorPass","nativeReservePass","packagingBytesFit")),
             "capacity-or-ancestry")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:],os.environ))
    except (ValueError,OSError,subprocess.SubprocessError,tarfile.TarError,KeyError,TypeError) as exc:
        label = str(exc)
        print("custody-refused/"+(label if re.fullmatch(r"[a-z0-9/-]{1,85}",label) else "preflight"))
        raise SystemExit(1)
