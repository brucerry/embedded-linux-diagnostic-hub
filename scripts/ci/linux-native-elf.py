"""Static required-library/version preflight; never ldd or a payload interpreter."""
import re
from pathlib import Path


class ElfRefused(ValueError):
    pass


def need(value):
    if not value:
        raise ElfRefused("input")


def dynamic(text):
    needed, paths = [], []
    for kind, value in re.findall(r"\((NEEDED|RPATH|RUNPATH)\).*?\[([^\]]*)\]", text):
        if kind == "NEEDED":
            need(re.fullmatch(r"[A-Za-z0-9_.+-]{1,160}", value))
            needed.append(value)
        else:
            paths.extend(value.split(":"))
    need(len(needed) <= 128 and len(set(needed)) == len(needed) and len(paths) <= 32)
    return needed, paths


def versions(text):
    mode, current, required, provided = None, None, {}, set()
    for line in text.splitlines():
        if line.startswith("Version definition section"):
            mode = "provided"
        elif line.startswith("Version needs section"):
            mode = "required"
        elif line.startswith("Version "):
            mode = None
        file = re.search(r"File: ([A-Za-z0-9_.+-]+)", line)
        if file and mode == "required":
            current = file[1]
            required.setdefault(current, set())
        name = re.search(r"Name: ([A-Za-z0-9_.+-]+)", line)
        if name and mode == "required":
            need(current is not None)
            required[current].add(name[1])
        elif name and mode == "provided":
            provided.add(name[1])
    return required, provided


def cache_entries(text):
    result = {}
    for name, flags, path in re.findall(r"^\s*([A-Za-z0-9_.+-]+) \(([^\n]+)\) => (/[A-Za-z0-9_./+-]+)$", text, re.M):
        if "x86-64" in flags:
            result.setdefault(name, Path(path))
    need(result)
    return result


def inspect(appdir, tools, collect, stable_read):
    cache = cache_entries(collect("ldcache", [tools["ldconfig"], "-p"]))
    pending = []
    for file in sorted(appdir.rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        with file.open("rb") as stream:
            if stream.read(4) == b"\x7fELF":
                pending.append(file)
    need(0 < len(pending) <= 64)
    parsed, edges = {}, []
    def parse(file):
        if file in parsed:
            return parsed[file]
        need(len(parsed) < 256)
        data = stable_read(file, 256 * 1024**2)
        need(len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01" and int.from_bytes(data[18:20], "little") == 62)
        number = str(len(parsed))
        deps, paths = dynamic(collect("elf-dyn-" + number, [tools["readelf"], "--wide", "--dynamic", str(file)]))
        required, provided = versions(collect("elf-ver-" + number, [tools["readelf"], "--wide", "--version-info", str(file)]))
        parsed[file] = {"deps": deps, "paths": paths, "required": required, "provided": provided}
        return parsed[file]
    seen = set()
    while pending:
        file = pending.pop()
        if file in seen:
            continue
        seen.add(file)
        row = parse(file)
        directories = []
        for text in row["paths"]:
            # Owned app RPATHs may refer only within this same verified AppDir.
            if file.is_relative_to(appdir):
                need(text == "$ORIGIN" or text.startswith("$ORIGIN/"))
                directory = (file.parent / text.removeprefix("$ORIGIN").lstrip("/")).resolve(strict=True)
                need(directory.is_relative_to(appdir))
                directories.append(directory)
        for name in row["deps"]:
            candidate = next((d / name for d in directories if (d / name).exists()), None)
            if candidate is None and file.is_relative_to(appdir) and (appdir / name).exists():
                candidate = appdir / name
            if candidate is None:
                candidate = cache.get(name)
            need(candidate is not None)
            provider = candidate.resolve(strict=True)
            if not provider.is_relative_to(appdir):
                need(provider.is_relative_to(Path("/usr/lib")) or provider.is_relative_to(Path("/lib")))
            provided = parse(provider)
            need(row["required"].get(name, set()) <= provided["provided"])
            edges.append((file.name, name))
            need(len(edges) <= 1024)
            pending.append(provider)
        need(set(row["required"]) <= set(row["deps"]))
    return {"elfObjects": len(parsed), "requiredLibraryEdges": len(edges), "missingOrVersionMismatch": False,
            "linkerOrPayloadExecuted": False}
