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

SOURCE = "8078fb5f83b4d87c70e9806b1f90881a5c26da05"
TREE = "e2b3d22a30a5a20be0c299a337dcf2144c13603d"
LOCK = "19b9794c0da10a71bb3ecdb4cc03019706e3f4c45a070bc3fcdf07b9a53c2ec3"
NODE = "v24.21.0"
COMPILER = (
    "@oxc-project/types", "@rolldown/binding-linux-x64-gnu", "@rolldown/pluginutils",
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
    p.add_argument("--intake-only", action="store_true")
    p.add_argument("--save-cache-dir", type=Path)
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
    here = Path(__file__).resolve().parent
    deps = json.loads((here / "compile-deps.json").read_bytes())
    allowed = (*COMPILER, *deps)
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
        if a.save_cache_dir:
            hx = base64.b64decode(sri[7:], validate=True).hex()
            dst = a.save_cache_dir / hx[:2] / hx[2:4] / hx[4:]
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists():
                with dst.open("xb") as retained:
                    retained.write(data)
        packed += len(data)
        expanded += unpack(data, source / "node_modules" / name)
        need(packed <= 40 * 1024**2 and expanded <= 192 * 1024**2, "aggregate input bound exceeded")
        receipt[name] = {"version": version, "integrity": sri, "sha256": sha(data)}
    if a.intake_only:
        print(json.dumps({"inputs_checked": len(receipt), "bytes": packed, "compiler_executed": False}))
        return
    (source / "out/evidence").mkdir(parents=True, exist_ok=False)
    subprocess.run(["node", str(here / "compile.mjs"), str(source / "node_modules/rolldown"), SOURCE],
                   cwd=source, env=env, check=True)
    result = json.loads((source / "out/evidence/report.json").read_bytes())
    expected = json.loads((here / "expected.json").read_bytes())
    keys = ("name", "bytes", "sha256", "externals")
    actual = [{k: row[k] for k in keys} for row in result["outputs"]]
    need(result["source"] == SOURCE and result["compiler"] == "1.2.12" and
         result["shippingApproval"] is False and actual == expected, "output mismatch")
    summary = {"source": SOURCE, "tree": TREE, "node": NODE, "compiler": "rolldown 1.2.12",
               "locked_inputs": len(receipt), "checked_bundles": len(actual),
               "packaged": False, "runtime_executed": False, "release_qualified": False}
    print(json.dumps(summary, sort_keys=True))
    if env.get("GITHUB_STEP_SUMMARY"):
        with Path(env["GITHUB_STEP_SUMMARY"]).open("a") as out:
            out.write("Compiler-only: " + json.dumps(summary, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
