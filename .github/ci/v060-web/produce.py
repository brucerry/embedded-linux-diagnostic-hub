"""Disposable CI-only Vite/ZIP producer; not a release gate or publisher."""
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
import zipfile

SOURCE = "8078fb5f83b4d87c70e9806b1f90881a5c26da05"
TREE = "e2b3d22a30a5a20be0c299a337dcf2144c13603d"
LOCK = "19b9794c0da10a71bb3ecdb4cc03019706e3f4c45a070bc3fcdf07b9a53c2ec3"
NODE = "v24.21.0"
ALLOWED = (
    "@oxc-project/types", "@rolldown/binding-linux-x64-gnu", "@rolldown/pluginutils",
    "@vitejs/plugin-react", "@xterm/addon-fit", "@xterm/xterm", "detect-libc",
    "fflate", "fdir", "lightningcss", "lightningcss-linux-x64-gnu", "lucide-react",
    "nanoid", "picocolors", "picomatch", "postcss", "react", "react-dom",
    "rolldown", "scheduler", "source-map-js", "tinyglobby", "vite",
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
    a = p.parse_args()
    source = a.source.resolve()
    env = os.environ.copy()
    for k in ("NODE_OPTIONS", "NODE_PATH", "ROLLDOWN_NATIVE_BINDING_PATH"):
        env.pop(k, None)

    def run(*args):
        return subprocess.check_output(args, cwd=source, env=env, text=True).strip()

    need(run("git", "rev-parse", "HEAD") == SOURCE and
         run("git", "rev-parse", "HEAD^{tree}") == TREE and
         run("git", "status", "--porcelain", "--untracked-files=all") == "",
         "not an exact fresh candidate checkout")
    need(run("node", "--version") == NODE and run("node", "-p", "process.platform + '/' + process.arch")
         == "linux/x64", "unexpected runtime")
    lock_raw = (source / "package-lock.json").read_bytes()
    need(sha(lock_raw) == LOCK and not (source / "node_modules").exists(), "input mismatch")
    lock = json.loads(lock_raw)["packages"]
    cache = None
    if a.local_cache_dir:
        cache = {}
        for record in json.loads((a.local_cache_dir / "receipt.json").read_text())["retained"]:
            cache[record["sourceIntegrity"]] = a.local_cache_dir / (record["sha256"] + ".tgz")
        cache[lock["node_modules/fflate"]["integrity"]] = a.local_cache_dir / "fflate.tgz"
    receipt = {}
    expanded = packed = 0
    for name in sorted(ALLOWED):
        row = lock["node_modules/" + name]
        version, sri, url = row["version"], row["integrity"], urlsplit(row["resolved"])
        need(re.fullmatch(r"[A-Za-z0-9.-]+", version) and sri.startswith("sha512-") and
             url.scheme == "https" and url.netloc == "registry.npmjs.org" and not url.query and
             not url.fragment and url.path ==
             "/" + name + "/-/" + name.split("/")[-1] + "-" + version + ".tgz",
             "invalid resolved archive")
        data = read_tarball(url, sri, cache)
        packed += len(data)
        expanded += unpack(data, source / "node_modules" / name)
        need(packed <= 40 * 1024**2 and expanded <= 192 * 1024**2, "aggregate input bound exceeded")
        receipt[name] = {"version": version, "integrity": sri, "sha256": sha(data)}
    env["WEB_BASE_PATH"] = "./"
    subprocess.run(["node", "node_modules/vite/bin/vite.js", "build", "--mode", "web",
                    "--outDir", "dist-site"], cwd=source, env=env, check=True)
    subprocess.run(["node", "scripts/package-web.mjs"], cwd=source, env=env, check=True)
    expected = json.loads(Path(__file__).with_name("expected-payload.json").read_bytes())
    dist = source / "dist-site"
    actual = {f.relative_to(dist).as_posix(): sha(f.read_bytes())
              for f in dist.rglob("*") if f.is_file()}
    need(len(expected) == 23 and actual == expected, "rendered file mismatch")
    zips = list((source / "release").glob("Diagnostic-Hub-Web-*.zip"))
    need(len(zips) == 1, "unexpected web ZIP count")
    with zipfile.ZipFile(zips[0]) as z:
        need(len(z.infolist()) == len(actual) and
             {m.filename: sha(z.read(m)) for m in z.infolist()} == actual, "ZIP payload mismatch")
    summary = {"source": SOURCE, "tree": TREE, "node": NODE, "archives": receipt,
               "payload_files": len(actual), "zip_sha256": sha(zips[0].read_bytes()),
               "release_qualified": False, "persistent_artifact_uploaded": False}
    print(json.dumps(summary, sort_keys=True))
    if env.get("GITHUB_STEP_SUMMARY"):
        with Path(env["GITHUB_STEP_SUMMARY"]).open("a") as f:
            f.write("### Renderer-only rehearsal (not release acceptance)\n\n```json\n")
            f.write(json.dumps(summary, sort_keys=True, indent=2) + "\n```\n")


if __name__ == "__main__":
    main()
