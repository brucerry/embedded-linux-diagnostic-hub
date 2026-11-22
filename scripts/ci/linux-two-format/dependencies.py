"""Exact npm installed-byte readback from the verified package inputs."""
import base64
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

PUBLISHER_ARCHIVE_ROOT = {
    "node_modules/@types/node": "node v24.19",
    "node_modules/@types/ssh2/node_modules/@types/node": "node v18.19",
    "node_modules/ejs": "ejs-v3.1.10",
    "node_modules/jake": "jake-v10.9.4",
}


def need(condition, label):
    if not condition:
        raise ValueError(label)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def dependency_expectations(project, registry, rows):
    expected = {}
    bin_paths = defaultdict(set)
    total = 0
    for slot, row in rows.items():
        path = PurePosixPath(slot)
        need(str(path) == slot and path.parts[0] == "node_modules" and ".." not in path.parts, "lock-placement-path")
        resolved = row["resolved"]
        digest = base64.b64decode(row["integrity"].removeprefix("sha512-"), validate=True).hex()
        if resolved.startswith("file:"):
            rel = resolved.removeprefix("file:")
            need(re.fullmatch(r"vendor/[a-zA-Z0-9._-]+\.tgz", rel), "exact-local-provider-route")
            origin = project / rel
        else:
            need(resolved.startswith("https://registry.npmjs.org/"), "exact-registry-route")
            origin = registry / (digest + ".tgz")
        need(hashlib.sha512(origin.read_bytes()).hexdigest() == digest and not row.get("hasInstallScript"), "lock-archive-binding")
        bins = {name: target.removeprefix("./") for name, target in row.get("bin", {}).items()}
        slot_dir = slot.rsplit("node_modules/", 1)[0] + "node_modules/.bin/"
        for name, target in bins.items():
            need(re.fullmatch(r"[A-Za-z0-9._-]+", name), "bin-name")
            bin_paths[slot_dir + name].add(slot + "/" + target)
        files = set()
        roots = {PUBLISHER_ARCHIVE_ROOT[slot]} if slot in PUBLISHER_ARCHIVE_ROOT else {"package"}
        if slot not in PUBLISHER_ARCHIVE_ROOT and "/@types/" in slot:
            roots.add(path.name)
        observed_root = None
        with tarfile.open(origin, mode="r|gz") as archive:
            for item in archive:
                if item.isdir():
                    continue
                need(item.isreg() and 0 <= item.size <= 20 * 1024**2, "dependency-member-type-or-size")
                name = item.name.removeprefix("./").split("/", 1)
                need(len(name) == 2 and name[0] in roots and observed_root in (None, name[0]), "dependency-root:" + slot)
                observed_root = name[0]
                inner = PurePosixPath(name[1])
                need(str(inner) == name[1] and inner.parts and ".." not in inner.parts and name[1] not in files,
                     "dependency-member-path")
                files.add(name[1])
                data = archive.extractfile(item).read()
                need(len(data) == item.size, "dependency-member-read")
                if name[1] == "package.json":
                    manifest = json.loads(data)
                    need(manifest["version"] == row["version"] and not set(manifest.get("scripts", {})) &
                         {"preinstall", "install", "postinstall", "dependencies"}, "install-lifecycle:" + slot)
                if name[1] in bins.values():
                    data = re.sub(rb"^(#![^\n]+)\r\n", rb"\1\n", data, count=1)
                key = slot + "/" + name[1]
                need(key not in expected, "dependency-placement-overlap")
                expected[key] = (len(data), sha(data))
                total += len(data)
                need(total <= 512 * 1024**2, "dependency-expansion-budget")
        need("package.json" in files and set(bins.values()) <= files, "dependency-member-roster")
    return expected, bin_paths


def installed_readback(project, rows, expected, bins):
    node_modules = project / "node_modules"
    realized = json.loads((node_modules / ".package-lock.json").read_bytes())["packages"]
    need(set(realized) == set(rows) and all(all(realized[slot][key] == row[key] for key in
         ("resolved", "version", "integrity")) for slot, row in rows.items()), "exact-realized-lock")
    unseen = set(expected)
    links = set()
    for directory, directories, files in os.walk(node_modules):
        base = Path(directory)
        need(not any((base / item).is_symlink() for item in directories), "installed-directory-link")
        for name in files:
            file = base / name
            relative = file.relative_to(project).as_posix()
            if relative == "node_modules/.package-lock.json":
                continue
            info = file.lstat()
            if stat.S_ISLNK(info.st_mode):
                resolved = file.resolve(strict=True).relative_to(project).as_posix()
                need(relative in bins and resolved in bins[relative] and os.access(project / resolved, os.X_OK), "npm-bin-link")
                links.add(relative)
                continue
            need(relative in unseen and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                 and info.st_uid == os.getuid() and info.st_size == expected[relative][0], "installed-file-shape:" + relative)
            need(sha(file.read_bytes()) == expected[relative][1], "installed-file-digest:" + relative)
            unseen.remove(relative)
    need(not unseen and links == bins.keys(), "complete-installed-census")
    return {"placements": len(rows), "regularFiles": len(expected), "binLinks": len(links)}
