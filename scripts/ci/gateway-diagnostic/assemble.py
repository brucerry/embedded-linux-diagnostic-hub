"""Build and bind the diagnostic inputs inside this job, before runtime admission."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tarfile
from urllib.parse import urlsplit
import zlib

HERE = Path(__file__).resolve().parent
HOSTS = {"raw.githubusercontent.com", "registry.npmjs.org", "api.github.com"}
SOURCE = "https://raw.githubusercontent.com/brucerry/embedded-linux-diagnostic-hub/"


def need(predicate, label):
    if not predicate:
        raise ValueError(label)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def match(data, pin):
    need((len(data), sha(data)) == (pin["bytes"], pin["sha256"]), "input-hash")
    return data


def fetch(url, cap):
    p = urlsplit(url)
    need(p.scheme == "https" and p.netloc in HOSTS and not p.query and not p.fragment,
         "public-input-route")
    out = subprocess.run(["/usr/bin/curl", "--disable", "--silent", "--fail", "--proto", "=https",
                          "--connect-timeout", "5", "--max-time", "20", "--max-filesize", str(cap),
                          "--write-out", "%{http_code}", url],
                         env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                         capture_output=True, timeout=24, stdin=subprocess.DEVNULL)
    need(out.returncode == 0 and not out.stderr and out.stdout[-3:] == b"200"
         and len(out.stdout) <= cap + 3, "public-input-response")
    return out.stdout[:-3]


def put(root, relative, data, executable=False):
    path = Path(relative)
    need(not path.is_absolute() and ".." not in path.parts, "output-path")
    dest = root / path
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with dest.open("xb") as output:
        output.write(data)
        os.fchmod(output.fileno(), 0o700 if executable else 0o600)
    need(dest.read_bytes() == data, "output-readback")
    return dest


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def signed_source(pins, read=fetch):
    origin = pins["derivedSsh2"]
    tag = json.loads(read("https://api.github.com/repos/mscdex/ssh2/git/tags/" + origin["tagObject"], 16384))
    need(tag["sha"] == origin["tagObject"] and tag["tag"] == origin["tag"]
         and tag["object"] == {"type": "commit", "sha": origin["commit"],
                               "url": "https://api.github.com/repos/mscdex/ssh2/git/commits/" + origin["commit"]}
         and tag["verification"]["verified"] is True and tag["verification"]["reason"] == "valid",
         "signed-tag-identity")
    return origin


def ssh2_archive(pins, origin, read=fetch):
    members = {}
    prefix = f"https://raw.githubusercontent.com/mscdex/ssh2/{origin['commit']}/"
    for path, pin in pins["ssh2SourceMembers"].items():
        data = match(read(prefix + path, pin["bytes"]), pin)
        oid = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        need(oid == pin["gitBlob"], "signed-source-blob")
        members[path] = data
    package = json.loads(members["package.json"])
    need(package["name"] == "ssh2" and package["version"] == "1.17.0"
         and package["scripts"]["install"] == "node install.js"
         and package["dependencies"] == pins["packages"]["ssh2"]["dependencies"],
         "ssh2-source-manifest")
    for key in ("scripts", "optionalDependencies", "devDependencies"):
        del package[key]
    package.update(os=["linux"], cpu=["x64"])
    members["package.json"] = (json.dumps(package, indent=2, ensure_ascii=False) + "\n").encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path, body in sorted(members.items()):
            entry = tarfile.TarInfo("package/" + path)
            entry.mode, entry.size = 0o644, len(body)
            archive.addfile(entry, io.BytesIO(body))
    raw = buffer.getvalue()
    recipe = pins["ssh2ProviderRecipe"]
    need((len(members), len(raw), sha(raw)) ==
         (recipe["memberCount"], recipe["tarBytes"], recipe["tarSHA256"]), "derived-tar-identity")
    codec = zlib.compressobj(9, wbits=-15)
    need(recipe["localRetainedMemberReassembly"] == "gzip.compress-mtime-zero", "derived-gzip-profile")
    data = (bytes.fromhex("1f8b0800000000000203") + codec.compress(raw) + codec.flush()
            + struct.pack("<II", zlib.crc32(raw), len(raw)))
    return match(data, pins["packages"]["ssh2"])


def runtime_files(pins, source_lock, diagnostic_lock, parser, ssh, read=fetch):
    source = json.loads(source_lock)["packages"]
    locked = json.loads(diagnostic_lock)["packages"]
    expected_names = set(pins["packages"])
    need(expected_names == {"ssh2", "asn1", "bcrypt-pbkdf", "safer-buffer", "tweetnacl"}
         and set(locked) == {""} | {"node_modules/" + n for n in expected_names}, "runtime-closure")
    all_files = {}
    for name, pin in pins["packages"].items():
        slot = "node_modules/" + name
        row = locked[slot]
        need(all(row[key] == pin[key] for key in ("version", "integrity", "resolved"))
             and row.get("dependencies", {}) == pin["dependencies"], "runtime-lock-binding")
        if name == "ssh2":
            need(row["resolved"] == "file:" + pins["ssh2ProviderRecipe"]["file"]
                 and row["integrity"] != source[slot]["integrity"]
                 and row["os"] == ["linux"] and row["cpu"] == ["x64"], "derived-lock-identity")
            data = ssh
        else:
            need(row == source[slot], "registry-lock-row")
            data = read(pin["resolved"], pin["bytes"])
        checked = parser.inspect_runtime_archive(match(data, pin),
            {"name": name, "version": pin["version"], "integrity": pin["integrity"],
             "dependencies": pin["dependencies"], "optionalDependencies": {}})
        files = checked["files"]
        need(sorted(checked["directories"]) == pin["directories"]
             and {p: {"size": len(v), "sha256": sha(v)} for p, v in files.items()} == pin["files"],
             "runtime-member-census")
        for path, body in files.items():
            all_files[slot + "/" + path] = body
    return all_files


def assemble(root, stage):
    pins = json.loads((HERE / "pins.json").read_bytes())
    lock = (HERE / "package-lock.json").read_bytes()
    manifest = (HERE / "package.json").read_bytes()
    need(sha(lock) == pins["diagnosticLockSHA256"] == "08d8f01de2007ae609c93fafbb571ec012d8b864772ce5b8b0627b58a211056c"
         and sha(manifest) == pins["manifestSHA256"], "diagnostic-lock-identity")
    helpers, source = root / "helpers", root / "compile"
    for name, pin in pins["helperInputs"].items():
        put(helpers, name, match(fetch(pin["url"], pin["bytes"]), pin))
    parser = load(helpers / "prepare-gateway-runtime-inputs.py")
    publisher = load(helpers / "prepare-gateway-publisher-node.py")
    tooling = load(helpers / "prepare-gateway-source-esbuild.py")
    profile = json.loads((helpers / "gateway-four-tool-inputs.json").read_bytes())
    for path, pin in pins["hubBundleInputs"].items():
        url = SOURCE + pins["hubSource"]["commit"] + "/" + path
        put(source, path, match(fetch(url, pin["bytes"]), pin))
    source_lock = (source / "package-lock.json").read_bytes()
    need(sha(source_lock) == pins["hubSource"]["originalLockSHA256"], "hub-lock")
    ssh = ssh2_archive(pins, signed_source(pins))
    runtime = runtime_files(pins, source_lock, lock, parser, ssh)
    semver = next(p for p in profile["packages"] if p["name"] == "semver")
    data = match(fetch(semver["url"], pins["buildOnlySemver"]["bytes"]), pins["buildOnlySemver"])
    for path, (body, _) in publisher.COMMON.inspect_package(data, semver).items():
        if body is not None:
            put(source, "node_modules/semver/" + path, body)
    tool_root = root / "tools"
    tool_root.mkdir(mode=0o700)
    tooling.stage_source_tools(tool_root)
    compiler = tool_root / "esbuild"
    need(sha(compiler.read_bytes()) == "ed59354772a53bc6aa5b7c4219338e1522fb73a8e5fff3f6fc2d036ad8726494",
         "source-built-compiler")
    tooling.run(tool_root, "gateway-bundle", [compiler, "gateway/main.ts", "--bundle", "--platform=node",
        "--format=cjs", "--outfile=dist-gateway/main.cjs", "--external:ssh2", "--log-level=warning"],
        source, {"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"}, 25, 4096)
    bundle = (source / "dist-gateway/main.cjs").read_bytes()
    need(len(bundle) == pins["retainedBundle"]["bytes"]
         and sha(bundle) == pins["retainedBundle"]["sha256"], "exact-gateway-bundle")
    distribution = publisher.fetch_distribution(publisher.NODE_ARCHIVE)
    binary = publisher.inspect_distribution(distribution, profile["node"], publisher.NODE_ARCHIVE)["bin/node"]
    match(binary, pins["node"])
    files = {
        **runtime, "dist-gateway/main.cjs": bundle, "package.json": manifest,
        "package-lock.json": lock, "bin/node": binary,
        pins["ssh2ProviderRecipe"]["file"]: ssh,
        "startup.cjs": (HERE / "startup.cjs").read_bytes(),
        "worker.sh": (HERE / "worker.sh").read_bytes(),
    }
    files["loader-pins"] = "".join(f"{row['sha256']}  {path}\n"
                                   for path, row in pins["nodeLoader"].items()).encode()
    loader = {Path(path).name: row["file"] for path, row in pins["nodeLoader"].items()}
    files["loader-map"] = "".join(f"{name} {path}\n" for name, path in sorted(loader.items())).encode()
    files["census"] = "".join(f"{sha(body)}  {path}\n" for path, body in sorted(files.items())).encode()
    for path, body in files.items():
        put(stage, path, body, executable=(path == "bin/node"))
    return {path: sha(body) for path, body in files.items()}
