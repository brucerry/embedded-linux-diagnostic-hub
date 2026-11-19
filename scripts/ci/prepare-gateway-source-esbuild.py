"""Build two pinned Gateway tool slots from official upstream source, in this job only."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import ssl
import subprocess
import tarfile
import time
import urllib.request
import zlib


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PUBLISHER = sibling("prepare-gateway-publisher-node")
COMMON = PUBLISHER.COMMON
require = COMMON.require
BRANCH = "ci/v060-gateway-source-tool-buildonly-20261119"
COMMIT = "609683d892977362a0f99026cb74b96263d728a9"
TREE = "a58e636987c5d8878037e68fb5e71c90329f0bab"
MODULE = "golang.org/x/sys"
VERSION = "v0.0.0-20220715151400-c0bba94af5f8"
MODULE_SUFFIX = MODULE + "/@v/" + VERSION
INPUTS = {
    "source": ("https://codeload.github.com/evanw/esbuild/tar.gz/" + COMMIT,
               2011018, "04cb2d38fb6af093577aa8bf174add7286099b65ef7854480cbbb8ff061cef1f"),
    "go": ("https://dl.google.com/go/go1.26.5.linux-amd64.tar.gz",
           66879095, "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053"),
    "info": ("https://proxy.golang.org/" + MODULE_SUFFIX + ".info",
             78, "af73b8ff9188b41ddc2f426a0c066203fb4907b91e77d29a9164e9cf37d572dc"),
    "mod": ("https://proxy.golang.org/" + MODULE_SUFFIX + ".mod",
            33, "f033333096fe198f3151deed93f2deba74e50bbfe7739134045bc3b7ce4a5024"),
    "zip": ("https://proxy.golang.org/" + MODULE_SUFFIX + ".zip",
            1798284, "3b180937216e93559f16b6076d09baf54a5707378f11b867b6eb914c56b09b91"),
}
GO_TOOLS = {
    "go/bin/go": "8da5fd321795754b994c64e3eb8a5a14ff47bd285559a7e876f3c79abafc67f9",
    "go/pkg/tool/linux_amd64/asm": "0c9a07447aba3ed1df7a0a3e85f6e003d9bf312d2936dfc4b79e3d81e8ca7636",
    "go/pkg/tool/linux_amd64/compile": "10c67b9de41c1e546b9bf416ceef410e5e3dd87a76d129b08b74a9570db9c463",
    "go/pkg/tool/linux_amd64/link": "e58a36e6550a32ed7175cd6e2a1824dc66c034d1e3539ebeac8af719a9150d5d",
}
GO_SUM = (
    "h1:0A+M6Uqn+Eje4kHMK80dtF3JCXC4ykBgQG4Fe06QRhQ=",
    "h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=",
)
BINARY = (11427966, "ed59354772a53bc6aa5b7c4219338e1522fb73a8e5fff3f6fc2d036ad8726494")
WRAPPER = {
    "LICENSE.md": (1069, "b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681"),
    "bin/esbuild": (9336, "8d2ff811a001eeaebaa6c88749e5d31013ef9b1c3aef976af4652f4993984980"),
    "lib/main.d.ts": (23551, "e078310f23f0ccfa28a6ac81b5fad81f27150e921f92ab6e648caab42e2d9a14"),
    "lib/main.js": (97773, "d52d8f3bc8af4261cb113b34ea67bd9d6c2692afb11d94c2c43b43554d61964c"),
    "package.json": (379, "93527957a89fb0306875f1f9d1b565bcfcb3bf6d5bc37e9e970817c9d39630e4"),
}
# The upstream source archive includes one tracked link. Inspect its Git hash
# in memory as part of the tree, with no link creation in any prefix.
UPSTREAM_LINK = "scripts/browser/esbuild.wasm.bagel"
WRAPPER_SOURCE = {
    "LICENSE.md", "npm/esbuild/package.json", "lib/npm/node-shim.ts", "lib/npm/node-platform.ts",
    "lib/npm/node.ts", "lib/shared/common.ts", "lib/shared/stdio_protocol.ts",
    "lib/shared/types.ts", "lib/shared/uint8array_json_parser.ts", "lib/shared/worker.ts",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked(data, pin):
    require((len(data), sha(data)) == pin, "package-integrity")
    return data


def fetch(name):
    url, limit, digest = INPUTS[name]
    request = urllib.request.Request(url, headers={"Accept": "application/octet-stream",
                                                   "Accept-Encoding": "identity",
                                                   "User-Agent": "DiagnosticHub-SourceTool"})
    opener = urllib.request.build_opener(
        COMMON.NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    start = time.monotonic()
    data = bytearray()
    with opener.open(request, timeout=15) as response:
        require(response.status == 200 and response.geturl() == url, "endpoint")
        length = response.headers.get("Content-Length")
        require(length is None or length == str(limit), "download-size")
        while chunk := response.read(min(65536, limit + 1 - len(data))):
            require(time.monotonic() - start < 90, "download-deadline")
            data.extend(chunk)
            require(len(data) <= limit, "download-size")
    require(time.monotonic() - start < 90, "download-deadline")
    return checked(data, (limit, digest))


def safe_name(name):
    return (0 < len(name) <= 300 and PurePosixPath(name).as_posix() == name
            and not re.search(r"[\\:\x00-\x1f\x7f]", name)
            and not set(name.split("/")) & {"", ".", "..", ".git"})


def unpack(data, kind):
    # Keep the authentication boundary at the parser even for a replaced reader.
    checked(data, INPUTS[kind][1:])
    maximum, count = (32 << 20, 442) if kind == "source" else (244699648, 16693)
    decoder = zlib.decompressobj(31)
    raw = decoder.decompress(data, maximum + 1)
    require(0 < len(raw) <= maximum and decoder.eof and not decoder.unconsumed_tail
            and not decoder.unused_data, "archive-policy")
    members = {}
    end = 0
    prefix = "esbuild-" + COMMIT if kind == "source" else "go"
    # Source archive modes are Git data. The verified codeload format uses 0664/0775.
    # Only file payloads leave the parser, and source files are always written mode 0600.
    prohibited_modes = 0o7000 if kind == "source" else 0o7022
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for item in archive:
            name = item.name
            require(len(members) < count and safe_name(name) and name not in members
                    and (name == prefix or name.startswith(prefix + "/"))
                    and not item.sparse and not item.mode & prohibited_modes, "archive-policy")
            headers = {"comment", "path", "mtime"} if kind == "source" else {"path", "mtime", "atime", "ctime"}
            require(set(item.pax_headers) <= headers and
                    item.pax_headers.get("comment", COMMIT) == COMMIT, "archive-policy")
            if item.isdir():
                require(item.size == 0 and not item.linkname, "archive-policy")
                row = ("40000", b"")
            elif item.issym():
                require(kind == "source" and name == prefix + "/" + UPSTREAM_LINK
                        and item.size == 0, "archive-policy")
                row = ("120000", item.linkname.encode())
            else:
                require(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not item.linkname
                        and 0 <= item.size <= (64 << 20), "archive-policy")
                with archive.extractfile(item) as member:
                    content = member.read(item.size + 1)
                require(len(content) == item.size, "file-length")
                row = ("100755" if item.mode & 0o100 else "100644", content)
            members[name] = row
            end = item.offset_data + ((item.size + 511) // 512) * 512
    require(len(members) == count and len(raw) - end >= 1024 and not any(raw[end:])
            and members.get(prefix) == ("40000", b""), "archive-policy")
    require(all(members.get(str(PurePosixPath(p).parent), (None,))[0] == "40000"
                for p in members if p != prefix), "archive-policy")
    return members


def git_hash(kind, body):
    return hashlib.sha1(f"{kind} {len(body)}\0".encode() + body).digest()


def source_files(members):
    prefix = "esbuild-" + COMMIT
    by_parent = {p: [] for p, (mode, _) in members.items() if mode == "40000"}
    for name, row in members.items():
        if name != prefix:
            parent, _, leaf = name.rpartition("/")
            by_parent[parent].append((leaf, name, row))
    tree_ids = {}
    for folder in sorted(by_parent, key=lambda name: -name.count("/")):
        rows = sorted(by_parent[folder], key=lambda e: e[0].encode() +
                      (b"/" if e[2][0] == "40000" else b""))
        body = b"".join(mode.encode() + b" " + leaf.encode() + b"\0" +
                        (tree_ids[path] if mode == "40000" else git_hash("blob", data))
                        for leaf, path, (mode, data) in rows)
        tree_ids[folder] = git_hash("tree", body)
    require(len(by_parent) == 90 and tree_ids[prefix].hex() == TREE, "source-integrity")
    files = {name.removeprefix(prefix + "/"): data for name, (mode, data) in members.items()
             if mode in {"100644", "100755"}}
    go = {n: b for n, b in files.items()
          if n in {"go.mod", "go.sum", "go.version", "version.txt", "LICENSE.md"}
          or n.startswith(("cmd/esbuild/", "internal/", "pkg/"))}
    require(len(go) == 177 and WRAPPER_SOURCE <= files.keys(), "source-integrity")
    require(go["version.txt"] == b"0.28.2\n" and go["go.version"].strip() == b"1.26.5"
            and go["go.sum"].decode().splitlines() ==
            [f"{MODULE} {VERSION} {GO_SUM[0]}", f"{MODULE} {VERSION}/go.mod {GO_SUM[1]}"],
            "source-integrity")
    return go, {n: files[n] for n in WRAPPER_SOURCE}


def write(root, name, data, mode=0o600):
    path = root / name
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    COMMON.directory(path.parent)
    COMMON.write(path, data, mode)


def reread(root, entries):
    for name, body in entries.items():
        require(COMMON.read(root / name, len(body)) == body, "source-integrity")


def run(root, label, argv, cwd, env, timeout, limit):
    out, err = root / (label + ".out"), root / (label + ".err")
    with out.open("xb") as stdout, err.open("xb") as stderr:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            code = child.wait(timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(5)
            raise
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        retired = True
    else:
        retired = False
    require(code == 0 and retired, "child-failed")
    require(not COMMON.read(err, 65536), "child-failed")
    return COMMON.read(out, limit)


def stage_source_tools(root):
    COMMON.PHASE = "esbuild-source-inputs"
    go_source, wrapper_source = source_files(unpack(fetch("source"), "source"))
    distribution = unpack(fetch("go"), "go")
    module = {name: fetch(name) for name in ("info", "mod", "zip")}
    require(json.loads(module["info"])["Version"] == VERSION, "package-manifest")
    for name, digest in GO_TOOLS.items():
        require(distribution[name][0] == "100755" and sha(distribution[name][1]) == digest,
                "package-integrity")
    for name, (mode, body) in distribution.items():
        if mode != "40000":
            write(root, name, body, 0o700 if mode == "100755" else 0o600)
    for subdir, mapping in (("src", go_source), ("wrapper", wrapper_source)):
        for name, body in mapping.items():
            write(root / subdir, name, body)
    for suffix, body in module.items():
        write(root / "proxy", MODULE_SUFFIX + "." + suffix, body)

    COMMON.PHASE = "esbuild-source-build"
    for leaf in ("home", "tmp", "cache", "modcache", "gopath"):
        (root / leaf).mkdir(mode=0o700)
        COMMON.directory(root / leaf)
    go = root / "go/bin/go"
    for name, digest in GO_TOOLS.items():
        require(sha(COMMON.read(root / name, 64 << 20)) == digest, "package-integrity")
    env = {"HOME": str(root / "home"), "TMPDIR": str(root / "tmp"), "LANG": "C.UTF-8",
           "GOENV": "off", "GOTOOLCHAIN": "local", "GOWORK": "off", "GOROOT": str(root / "go"),
           "GOPATH": str(root / "gopath"), "GOMODCACHE": str(root / "modcache"),
           "GOCACHE": str(root / "cache"), "GOPROXY": (root / "proxy").as_uri(),
           "GOSUMDB": "sum.golang.org", "GOVCS": "*:off", "GOAMD64": "v1",
           "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64"}
    src = root / "src"
    reread(src, go_source)
    output = run(root, "go-version", [go, "version"], src, env, 10, 1024)
    require(output == b"go version go1.26.5 linux/amd64\n", "invalid-data")
    output = run(root, "go-download-local", [go, "mod", "download", "-json", MODULE + "@" + VERSION],
                 src, env, 30, 16384)
    receipt = json.loads(output)
    require((receipt["Path"], receipt["Version"], receipt["Sum"], receipt["GoModSum"]) ==
            (MODULE, VERSION, *GO_SUM), "package-integrity")
    env["GOPROXY"] = "off"
    require(run(root, "go-verify", [go, "mod", "verify"], src, env, 30, 1024)
            == b"all modules verified\n", "package-integrity")
    binary = root / "esbuild"
    require(not os.path.lexists(binary), "file-identity")
    require(not run(root, "go-build", [go, "build", "-mod=readonly", "-trimpath", "-buildvcs=false",
                "-ldflags=-s -w -buildid=", "-o", binary, "./cmd/esbuild"], src, env, 240, 4096),
            "child-failed")
    binary_bytes = checked(COMMON.read(binary, BINARY[0]), BINARY)
    require(binary_bytes[:6] == b"\x7fELF\x02\x01" and binary_bytes[18:20] == b"\x3e\x00"
            and COMMON.metadata(binary).st_mode & 0o100, "package-integrity")
    reread(src, go_source)

    COMMON.PHASE = "esbuild-wrapper-build"
    manifest = json.loads(wrapper_source["npm/esbuild/package.json"])
    require(manifest["name"] == "esbuild" and manifest["version"] == "0.28.2", "package-manifest")
    for key in ("scripts", "optionalDependencies", "esbuild.binaryHashes"):
        del manifest[key]
    wrapped = {
        "LICENSE.md": wrapper_source["LICENSE.md"],
        "lib/main.d.ts": wrapper_source["lib/shared/types.ts"],
        "package.json": (json.dumps(manifest, indent=2) + "\n").encode(),
    }
    flags = ["--bundle", "--target=node10", '--define:ESBUILD_VERSION="0.28.2"',
             "--external:esbuild", "--platform=node", "--log-level=warning"]
    for label, entry, destination, extra in (
        ("shim", "lib/npm/node-shim.ts", "bin/esbuild", []),
        ("api", "lib/npm/node.ts", "lib/main.js", ["--define:WASM=false"]),
    ):
        checked(COMMON.read(binary, BINARY[0]), BINARY)
        reread(root / "wrapper", wrapper_source)
        wrapped[destination] = run(root, label, [binary, entry, *flags, *extra],
                                   root / "wrapper", {"LANG": "C.UTF-8"}, 20, WRAPPER[destination][0])
    require(wrapped.keys() == WRAPPER.keys(), "package-manifest")
    for name, body in wrapped.items():
        checked(body, WRAPPER[name])
    return {"esbuild": {n: (b, 0o700 if n == "bin/esbuild" else 0o600) for n, b in wrapped.items()},
            "@esbuild/linux-x64": {"bin/esbuild": (binary_bytes, 0o700)}}


if __name__ == "__main__":
    raise SystemExit(COMMON.collect_diagnostic(node_provider=PUBLISHER.acquire_node,
                                                expected_branch=BRANCH, source_tools=stage_source_tools))
