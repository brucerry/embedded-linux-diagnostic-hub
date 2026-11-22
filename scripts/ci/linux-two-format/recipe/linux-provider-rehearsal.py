#!/usr/bin/env python3
"""Rebuild three pinned Linux file providers in scratch; no install or product launch."""

import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit
import zlib

HERE = Path(__file__).resolve().parent
MIB = 1 << 20
PREFIX = "node-v24.22.2-linux-x64/"
NODE_SHA = "904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52"
COMPILER_SHA = "795e49e46d497cc16e4b02916b50cbca257b4256d62cddc4cc504103f7961027"
SOURCE_PATCHED_SHA = "b7a8579781991651baf37a3557208e1f98a8df9e2cbe12fab127217a3dc98375"
PUBLIC_HOSTS = {"nodejs.org","raw.githubusercontent.com","registry.npmjs.org"}
ENV = {"PATH":"/usr/bin:/bin","LANG":"C.UTF-8","TZ":"UTC"}


def need(accepted, code):
    if not accepted:
        raise ValueError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pins():
    return json.loads((HERE/"linux-provider-inputs.json").read_bytes())


def save(directory, name, content, executable=False):
    path = directory/name
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with path.open("xb") as out:
        out.write(content)
        if executable:
            os.fchmod(out.fileno(),0o700)
    return path


def encoded(manifest):
    return (json.dumps(manifest,indent=2,ensure_ascii=False)+"\n").encode()


def match(content, pin, code):
    need(len(content)==pin["bytes"] and sha(content)==pin["sha256"],code)
    if "gitBlob" in pin:
        need(hashlib.sha1(f"blob {len(content)}\0".encode()+content).hexdigest()==pin["gitBlob"],code)
    return content


def public_source(url, maximum):
    parsed=urlsplit(url)
    need(parsed.scheme=="https" and parsed.netloc in PUBLIC_HOSTS and not parsed.query and not parsed.fragment,
         "public-input-url")
    # No redirects or ambient credentials. Each address and response length is prebound.
    result=subprocess.run(["/usr/bin/curl","--disable","--silent","--show-error","--fail","--proto","=https",
             "--connect-timeout","5","--max-time","20","--max-filesize",str(maximum),url],
             stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=24,env=ENV)
    need(result.returncode==0 and len(result.stdout)<=maximum,"public-input-read")
    return result.stdout


def raw_get(fetch, package, path, pin):
    repo = package["sourceRepository"].removeprefix("https://github.com/")
    need(re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9-]+",repo)
         and re.fullmatch(r"[0-9a-f]{40}", package["sourceCommit"])
         and all(re.fullmatch(r"[A-Za-z0-9_.-]+",p) and p not in (".","..") for p in path.split("/")),
         "public-source-address")
    url=f"https://raw.githubusercontent.com/{repo}/{package['sourceCommit']}/{path}"
    return match(fetch(url,pin["bytes"]),pin,"public-source-member")


def data_archive(blob, root, limit, only=None):
    reader=zlib.decompressobj(31)
    content=reader.decompress(blob,limit+1)
    need(reader.eof and not reader.unused_data and not reader.unconsumed_tail and len(content)<=limit,
         "archive-expanded-bound")
    files={}
    names=set()
    with tarfile.open(fileobj=io.BytesIO(content),mode="r:") as ar:
        for item in ar:
            n=item.name.removeprefix(root)
            need(len(names)<10000 and (item.name==root.rstrip("/") or item.name.startswith(root))
                 and n not in names and ".." not in n.split("/") and "\\" not in n
                 and not n.startswith("/") and not item.sparse,
                 "archive-member-identity")
            names.add(n)
            if not item.isfile():
                need(item.isdir() or (only and item.issym() and n in {"bin/npm","bin/npx","bin/corepack"}),
                     "archive-member-type")
                continue
            if only and n not in only:
                continue
            need(item.mode in (0o644,0o755) and not item.linkname,"archive-member-mode")
            with ar.extractfile(item) as stream:
                body=stream.read(item.size+1)
            need(len(body)==item.size,"archive-member-length")
            files[n]=(item.mode,body)
    if only:
        need(set(files)==set(only),"archive-member-selection")
    return files


def emit(files, profile):
    """Canonical USTAR and exact gzip headers for both retained archive encoders."""
    tar=io.BytesIO()
    with tarfile.open(fileobj=tar,mode="w",format=tarfile.USTAR_FORMAT) as ar:
        for name,(mode,content) in sorted(files.items()):
            row=tarfile.TarInfo("package/"+name)
            row.mode,row.size=mode,len(content)
            ar.addfile(row,io.BytesIO(content))
    data=tar.getvalue()
    zip_writer=zlib.compressobj(9,wbits=-15)
    body=zip_writer.compress(data)+zip_writer.flush()
    os_code = 255 if profile == "gzip.GzipFile-no-filename-mtime-zero" else 3
    return data, bytes.fromhex("1f8b08000000000002")+bytes([os_code])+body + struct.pack(
        "<II",zlib.crc32(data),len(data)&0xffffffff)


def verify_output(folder,name,files,want):
    tar,data=emit(files,want["localRetainedMemberReassembly"])
    need(len(files)==want["memberCount"] and len(tar)==want["tarBytes"] and sha(tar)==want["tarSHA256"]
         and len(data)==want["bytes"] and sha(data)==want["sha256"]
         and "sha512-"+base64.b64encode(hashlib.sha512(data).digest()).decode()==want["lockIntegrity"]
         and gzip.decompress(data)==tar,"provider-digest-"+name)
    output=save(folder,want["file"],data)
    need(output.read_bytes()==data,"provider-write-readback")
    print("exact-output/"+name,flush=True)


def js_providers(folder,source,fetch):
    for name in ("filelist","ssh2"):
        want=source["expected"][name]
        files={p:(0o644,raw_get(fetch,want,p,pin)) for p,pin in source["sourceFiles"][name].items()}
        pkg=json.loads(files["package.json"][1])
        need(pkg["name"]==name and pkg["version"]==want["version"],"source-manifest")
        if name=="ssh2":
            need(pkg["dependencies"]=={"asn1":"^0.2.6","bcrypt-pbkdf":"^1.0.2"}
                 and pkg["scripts"]["install"]=="node install.js","ssh2-native-contract")
            for key in ("scripts","optionalDependencies","devDependencies"):
                del pkg[key]
            pkg.update(os=["linux"],cpu=["x64"])
            files["package.json"]=(0o644,encoded(pkg))
            need(all(n in ("README.md","SFTP.md","LICENSE","package.json") or
                     (n.startswith("lib/") and n.endswith(".js")) for n in files)
                 and all(not v[1].startswith(b"\x7fELF") for v in files.values()),"ssh2-js-only")
        verify_output(folder,name,files,want)


# TypeScript is already the admitted official compiler. It only emits this exact
# source slice; no recipe, dependency lifecycle or product code is evaluated.
EMITTER=r"""
const fs=require('node:fs');
const assert=require('node:assert/strict');
const [compiler,source,js,map]=process.argv.slice(2);
const ts=require(compiler);
assert.equal(process.version,'v24.22.2');
assert.equal(ts.version,'5.8.2');
const result=ts.transpileModule(fs.readFileSync(source,'utf8'),{
  fileName:'fileMatcher.ts', reportDiagnostics:true,
  compilerOptions:{target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.CommonJS,
    esModuleInterop:false,allowSyntheticDefaultImports:true,experimentalDecorators:true,
    sourceMap:true,inlineSources:true,newLine:ts.NewLineKind.LineFeed,strict:true}
});
assert.deepEqual(result.diagnostics,[]);
const parsed=JSON.parse(result.sourceMapText);
assert.deepEqual(parsed.sources,['fileMatcher.ts']);
parsed.sources=['../../../../source/packages/app-builder-lib/src/fileMatcher.ts'];
fs.writeFileSync(js,result.outputText,{flag:'wx'});
fs.writeFileSync(map,JSON.stringify(parsed),{flag:'wx'});
"""


def builder(folder,source,fetch,run, node_path=None):
    archives=source["officialArchives"]
    wanted=source["expected"]["app-builder-lib"]
    def official(name):
        pin=archives[name]
        return match(fetch(pin["url"],pin["bytes"]),pin,"official-archive-"+name)
    files=data_archive(official("builder"),"package/",16*MIB)
    pkg=json.loads(files["package.json"][1])
    need(pkg["name"]=="app-builder-lib" and pkg["version"]=="26.15.3"
         and pkg["dependencies"]["@electron/universal"]=="2.0.3"
         and pkg["dependencies"]["minimatch"]=="^10.2.5","builder-publisher-manifest")
    del pkg["dependencies"]["@electron/universal"]
    pkg["dependencies"]["minimatch"]="11.0.9"
    pkg.update(peerDependenciesMeta={"electron-builder-squirrel-windows":{"optional":True}},os=["linux"],cpu=["x64"])
    files["package.json"]=(files["package.json"][0],encoded(pkg))
    row=source["sourceFiles"]["matcher"]
    matcher=raw_get(fetch,wanted,row["name"],row).decode()
    old='''      if (!pattern.includes(".") && !hasMagic(parsedPattern)) {
        // https://github.com/electron-userland/electron-builder/issues/545
        // add **/*
        result.push(new Minimatch(`${pattern}/**/*`, minimatchOptions))
      }'''
    new='''      if (!pattern.includes(".")) {
        if (parsedPattern.set.length === 0) {
          throw new Error("Cannot classify an empty compiled packaging pattern")
        }
        if (!parsedPattern.hasMagic()) {
          // https://github.com/electron-userland/electron-builder/issues/545
          result.push(new Minimatch(`${pattern}/**/*`, minimatchOptions))
        }
      }'''
    for before,after in (("import { createFilter, hasMagic }","import { createFilter }"),
                         ("const minimatchOptions = { dot: true }",
                          "const minimatchOptions = { dot: true, magicalBraces: true }"),(old,new)):
        need(matcher.count(before)==1,"matcher-source-patch")
        matcher=matcher.replace(before,after)
    need(sha(matcher.encode())==SOURCE_PATCHED_SHA,"matcher-source-hash")
    ts=data_archive(official("typescript"),"package/",32*MIB,{"lib/typescript.js"})["lib/typescript.js"][1]
    need(sha(ts)==COMPILER_SHA,"compiler-member-identity")
    if node_path is None:
        node=data_archive(official("node"),PREFIX,256*MIB,{"bin/node"})["bin/node"][1]
        need(len(node)==126881248 and sha(node)==NODE_SHA,"compiler-member-identity")
        node_path=save(folder,"tool/node",node,True)
    compiler=save(folder,"tool/typescript.js",ts)
    matcher_file=save(folder,"tool/fileMatcher.ts",matcher.encode())
    script=save(folder,"tool/emit.cjs",EMITTER.encode())
    js,mp=(folder/"tool/fileMatcher.js",folder/"tool/fileMatcher.js.map")
    run([node_path,script,compiler,matcher_file,js,mp])
    for name,path,hash_value in (
        ("out/fileMatcher.js",js,"016df9d0534fc04947f89edde99bf25fcec367a54220e42fe9bfed5d397c1f62"),
        ("out/fileMatcher.js.map",mp,"66b03fd4ddf56c54f137b33e0e3ca28088baf863945d9b5cde3112f197cd85e1")):
        data=path.read_bytes()
        need(len(data)<MIB and sha(data)==hash_value,"builder-emission")
        files[name]=(files[name][0],data)
    verify_output(folder,"app-builder-lib",files,wanted)


def reconstruct(folder,fetch,run, node_path=None):
    source=pins()
    js_providers(folder,source,fetch)
    builder(folder,source,fetch,run,node_path)


def main():
    os.umask(0o077)
    need(sys.platform=="linux" and os.uname().machine=="x86_64" and os.getuid()>0
         and os.getuid()==os.geteuid(),"execution-identity")
    tmp=Path(os.environ["RUNNER_TEMP"])
    need(tmp.is_absolute() and tmp.resolve(strict=True)==tmp and tmp.stat().st_uid==os.getuid(),"runner-temp")
    folder=Path(tempfile.mkdtemp(prefix="hub-provider-rehearsal.",dir=tmp))
    def run(command):
        cp=subprocess.run(command,cwd=folder,env={**ENV,"HOME":str(folder)},
                          timeout=30,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        need(cp.returncode==0 and not cp.stdout and not cp.stderr,"compiler-exit")
    try:
        reconstruct(folder,public_source,run)
    except (ValueError,OSError,subprocess.TimeoutExpired,tarfile.TarError,KeyError) as ex:
        # Exception messages contain no upstream data. Scope this one further for Bash output.
        safe=str(ex)
        print("provider-rehearsal/"+(safe if re.fullmatch(r"[a-z0-9/-]{1,70}",safe) else "refused"))
        return 1
    return 0


if __name__=="__main__":
    raise SystemExit(main())
