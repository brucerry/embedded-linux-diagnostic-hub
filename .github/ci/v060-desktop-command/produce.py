"""Bounded source-only desktop compiler rehearsal; not a runtime or release gate."""
import argparse
import base64
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
from urllib.parse import urlsplit

LOCK = "84447b99442f454cbdd2fb553bb37e84ff8c507821ae1be8a5c3f9affd1b6490"
NODE = "v24.21.0"
COMPILER = (
    "@oxc-project/types", "@rolldown/pluginutils",
    "detect-libc", "rolldown",
)
LIMIT = 24 * 1024**2
EXPANDED_LIMIT = 96 * 1024**2


def need(ok, msg):
    if not ok:
        raise ValueError(msg)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_tarball(url, sri, cache):
    if cache is not None:
        data = cache[sri].read_bytes()
    else:
        conn = http.client.HTTPSConnection("registry.npmjs.org", timeout=10)
        try:
            conn.request("GET", url.path, headers={"Accept-Encoding": "identity"})
            reply = conn.getresponse()
            need(reply.status == 200 and reply.getheader("Content-Encoding", "identity")
                 == "identity", "unexpected registry response")
            data = reply.read(LIMIT + 1)
        finally:
            conn.close()
    need(0 < len(data) <= LIMIT and hashlib.sha512(data).digest() ==
         base64.b64decode(sri[7:], validate=True), "invalid archive digest or size")
    return data


def unpack(data, dest):
    dest.mkdir(parents=True, exist_ok=False)
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as g:
        decoded = g.read(EXPANDED_LIMIT + 1)
    need(len(decoded) <= EXPANDED_LIMIT, "expanded archive too large")
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(decoded), mode="r:") as tf:
        for m in tf:
            path = m.name.split("/")
            need(path == ["package"] or (path[0] == "package" and len(path) > 1
                 and all(part not in ("", ".", "..") and "\\" not in part
                         and all(32 <= ord(c) < 127 for c in part) for part in path[1:])),
                 "unsafe archive member")
            need(m.name not in seen and len(seen) < 10000, "duplicate or excess members")
            seen.add(m.name)
            need(m.isdir() or (m.isfile() and len(path) > 1 and not m.sparse),
                 "unexpected archive member type")
            if len(path) == 1:
                continue
            out = dest.joinpath(*path[1:])
            if m.isdir():
                out.mkdir(parents=True, exist_ok=True)
            else:
                out.parent.mkdir(parents=True, exist_ok=True)
                with out.open("xb") as f:
                    f.write(tf.extractfile(m).read())
    return len(decoded)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source", type=Path)
    p.add_argument("--local-cache-dir", type=Path)
    p.add_argument("--lane", choices=("win32-x64-msvc", "darwin-x64", "darwin-arm64", "linux-x64-gnu"), required=True)
    p.add_argument("--check", action="store_true")
    a = p.parse_args()
    source = a.source.resolve()
    env = os.environ.copy()
    for k in ("NODE_OPTIONS", "NODE_PATH", "ROLLDOWN_NATIVE_BINDING_PATH"):
        env.pop(k, None)

    def run(*args):
        return subprocess.check_output(args, cwd=source, env=env, text=True).strip()

    commit = run("git", "rev-parse", "HEAD")
    need(commit == env.get("GITHUB_SHA") and run("git", "status", "--porcelain", "--untracked-files=all") == "",
         "not the declared clean CI branch checkout")
    selected = {"win32-x64-msvc": "win32/x64", "darwin-x64": "darwin/x64", "darwin-arm64": "darwin/arm64", "linux-x64-gnu": "linux/x64"}
    need(run("node", "--version") == NODE and run("node", "-p", "process.platform + '/' + process.arch")
         == selected[a.lane], "unexpected native runtime")
    lock_raw = (source / "package-lock.json").read_bytes()
    need(sha(lock_raw) == LOCK, "input lock mismatch")
    pkg = json.loads((source / "package.json").read_bytes())
    need(pkg["scripts"]["build:desktop"] == "node scripts/build-desktop-rolldown.mjs" and
         pkg["devDependencies"]["rolldown"] == "1.2.12", "different desktop command")
    if a.check:
        expected = {"main.cjs", "preload.cjs", "linux-setup-review.cjs",
                    "linux-setup-install.cjs", "linux-setup-bootstrap.cjs"}
        root = source / "dist-electron"
        files = sorted(root.iterdir())
        need({f.name for f in files} == expected, "unexpected desktop outputs")
        outputs = {}
        for f in files:
            need(f.is_file() and not f.is_symlink() and 0 < f.stat().st_size <= 16*1024**2,
                 "invalid desktop output file")
            subprocess.run(["node", "--check", str(f)], cwd=source, env=env, check=True)
            outputs[f.name] = sha(f.read_bytes())
        summary = {"source": commit, "lane": a.lane, "outputs": outputs,
                   "installer_built": False, "release_qualified": False}
        print(json.dumps(summary, sort_keys=True))
        return
    need(not (source / "node_modules").exists(), "existing node_modules")
    lock = json.loads(lock_raw)["packages"]
    here = Path(__file__).resolve().parent
    deps = json.loads((here / "compile-deps.json").read_bytes())
    native = "@rolldown/binding-" + a.lane
    allowed = (*COMPILER, native, *deps)
    need(len(allowed) == len(set(allowed)) == 22, "unexpected dependency closure")
    cache = None
    if a.local_cache_dir:
        cache = {}
        for name in allowed:
            sri = lock["node_modules/" + name]["integrity"]
            raw = base64.b64decode(sri[7:], validate=True).hex()
            path = a.local_cache_dir / raw[:2] / raw[2:4] / raw[4:]
            cache[sri] = path
    receipt = {}
    expanded = packed = 0
    for name in sorted(allowed):
        row = lock["node_modules/" + name]
        version, sri, url = row["version"], row["integrity"], urlsplit(row["resolved"])
        if name in deps:
            need(deps[name] == {"version": version, "integrity": sri}, "compiler plan differs from lock")
        pkg = name.split("/node_modules/")[-1]
        need(re.fullmatch(r"[A-Za-z0-9.-]+", version) and sri.startswith("sha512-") and
             url.scheme == "https" and url.netloc == "registry.npmjs.org" and not url.query and
             not url.fragment and url.path ==
             "/" + pkg + "/-/" + pkg.split("/")[-1] + "-" + version + ".tgz",
             "invalid resolved archive")
        data = read_tarball(url, sri, cache)
        packed += len(data)
        expanded += unpack(data, source / "node_modules" / name)
        need(packed <= 40 * 1024**2 and expanded <= 192 * 1024**2, "aggregate input bound exceeded")
        receipt[name] = {"version": version, "integrity": sri, "sha256": sha(data)}
    binding = source / "node_modules" / native / ("rolldown-binding." + a.lane + ".node")
    pins = json.loads((here / "binding-pins.json").read_bytes())
    need(sha(binding.read_bytes()) == pins[a.lane], "native binary differs from independent readback")
    print(json.dumps({"source": commit, "lane": a.lane, "reviewed_archives": len(receipt)}))


if __name__ == "__main__":
    main()
