"""Read-only GCC, binutils and ELF admission for the held tar.gz caller."""

from contextlib import nullcontext
import json
import os
from pathlib import Path
import stat
from struct import Struct

from tar_admission import Refused, file_data, need, stamp

PLAN_SHA = "3aaa35e7ea9d0b2afcf61e0c80d289f8c3952ff1c0b72c4589a3f152ed36e15f"
PLAN_PATH = Path(__file__).with_name("COMPILER-READBACK-PLAN.json")
COMPILER = "/usr/bin/x86_64-linux-gnu-gcc-13"
INTERPRETER = "/lib64/ld-linux-x86-64.so.2"
LOADER = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
ASSEMBLER = "/usr/bin/x86_64-linux-gnu-as"
LINKER = "/usr/bin/x86_64-linux-gnu-ld.bfd"
PLUGIN = "/usr/libexec/gcc/x86_64-linux-gnu/13/liblto_plugin.so"

ELF_HEADER = Struct("<16sHHIQQQIHHHHHH")
PROGRAM_HEADER = Struct("<IIQQQQQQ")
DYNAMIC_ENTRY = Struct("<qQ")
PT_LOAD, PT_DYNAMIC, PT_INTERP = 1, 2, 3
DT_NULL, DT_NEEDED, DT_STRTAB, DT_STRSZ = 0, 1, 5, 10
DT_FLAGS_1, DF_1_NODEFLIB = 0x6FFFFFFB, 0x800
# DT_RPATH, DT_RUNPATH, DT_CONFIG, DT_DEPAUDIT, DT_AUDIT, DT_AUXILIARY, DT_FILTER
SEARCH_OVERRIDES = {15, 29, 0x6FFFFEFA, 0x6FFFFEFB, 0x6FFFFEFC, 0x7FFFFFFD, 0x7FFFFFFF}


def load_plan():
    _, digest, body = file_data(PLAN_PATH, "compiler-plan-pin", capture=True)
    need(digest["sha256"] == PLAN_SHA, "compiler-plan-pin")
    return json.loads(body)


def elf_identity(body):
    """Read bounded x86-64 program and dynamic headers without a loader or subprocess."""
    need(len(body) >= ELF_HEADER.size, "elf-header")
    ident, e_type, machine, version, _, offset, _, _, size, entry_size, count, *_ = (
        ELF_HEADER.unpack_from(body)
    )
    need(ident[:7] == b"\x7fELF\x02\x01\x01" and e_type in (2, 3) and machine == 62
         and version == 1 and size == ELF_HEADER.size and entry_size == PROGRAM_HEADER.size
         and 0 < count <= 128 and size <= offset <= len(body) - count * entry_size, "elf-header")
    loads, interpreters, tables = [], [], []
    for index in range(count):
        kind, _, start, vaddr, _, length, _, _ = PROGRAM_HEADER.unpack_from(body, offset + index * entry_size)
        need(start <= len(body) and length <= len(body) - start, "elf-segment")
        if kind == PT_LOAD:
            loads.append((vaddr, start, length))
        elif kind == PT_INTERP:
            need(2 <= length <= 512, "elf-interpreter")
            raw = body[start:start + length]
            need(raw[-1] == 0 and b"\0" not in raw[:-1] and raw.isascii(), "elf-interpreter")
            interpreters.append(raw[:-1].decode("ascii"))
        elif kind == PT_DYNAMIC:
            tables.append((start, length))
    need(len(interpreters) <= 1, "elf-interpreter")
    need(len(tables) <= 1, "elf-dynamic")
    if not tables:
        return interpreters, []
    start, length = tables[0]
    need(0 < length <= 65536 and length % DYNAMIC_ENTRY.size == 0, "elf-dynamic")
    tags, needed = {}, []
    for tag, value in DYNAMIC_ENTRY.iter_unpack(body[start:start + length]):
        if tag == DT_NULL:
            break
        need(tag not in SEARCH_OVERRIDES and (tag != DT_FLAGS_1 or not value & DF_1_NODEFLIB),
             "elf-unsupported-resolution")
        if tag in (DT_STRTAB, DT_STRSZ):
            need(tag not in tags, "elf-dynamic")
            tags[tag] = value
        elif tag == DT_NEEDED:
            needed.append(value)
    else:
        raise Refused("elf-dynamic")
    if not needed:
        return interpreters, []

    addr, length = tags.get(DT_STRTAB, -1), tags.get(DT_STRSZ, 0)
    offsets = [pos + addr - base for base, pos, span in loads
               if length > 0 and base <= addr and addr - base + length <= span]
    need(len(offsets) == 1, "elf-dynamic-strings")
    start = offsets[0]
    names = []
    for entry in needed:
        need(entry < length, "elf-dynamic-strings")
        end = body.find(b"\0", start + entry, min(start + length, start + entry + 256))
        need(end > start + entry, "elf-dynamic-strings")
        raw = body[start + entry:end]
        need(raw.isascii() and b"/" not in raw, "elf-unsupported-resolution")
        names.append(raw.decode("ascii"))
    need(len(names) == len(set(names)), "elf-unsupported-resolution")
    return interpreters, names


def protected_ancestors(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0)
             and not stat.S_IMODE(info.st_mode) & 0o7022, "compiler-path-ancestry")


def checked_file(path, pin, *, capture):
    info, hashes, body = file_data(path, "compiler-file", byte_count=pin["bytes"], capture=capture,
                                   capture_limit=32 * 1024**2, owned=False)
    need((info.st_uid, info.st_gid, f"{stat.S_IMODE(info.st_mode):04o}", hashes["sha256"])
         == (pin["uid"], pin["gid"], pin["mode"], pin["sha256"]), "compiler-file-identity")
    return body


def read_member(path, pin, *, capture):
    protected_ancestors(path)
    return checked_file(path, pin, capture=capture)


def read_alias(path, pin):
    protected_ancestors(path)
    before = path.lstat()
    need(stat.S_ISLNK(before.st_mode)
         and (before.st_uid, before.st_gid, f"{stat.S_IMODE(before.st_mode):04o}")
         == (pin["uid"], pin["gid"], pin["mode"]) and os.readlink(path) == pin["target"]
         and stamp(path.lstat()) == stamp(before), "compiler-alias-identity")


def readback(plan, *, member=read_member, alias=read_alias, resolve=Path.resolve,
             checkpoint=lambda _: nullcontext()):
    """Read archive-bound files and aliases. An expected SONAME is a static identity only."""
    with checkpoint('compiler_aliases'):
        roles = plan["elfMembersAndDirectResolution"]
        plugin = plan["possibleLinkerPlugin"]
        need(len(roles) == 18 and plan["canonicalCompiler"] == COMPILER and plan["canonicalLoader"] == LOADER
             and plan["loaderPathSpellingInELF"] == INTERPRETER and plugin["canonical"] == PLUGIN,
             "compiler-plan-shape")
        approved = {Path(role).name: entry["canonical"] for role, entry in roles.items()}
        need(len(approved) == len(roles), "compiler-plan-shape")

        aliases = dict(plan["offlineAliasPins"])
        aliases.update(plugin["aliases"])
        aliases.update({role: entry["alias"] for role, entry in roles.items() if entry["alias"]})
        # These stock generated paths still require live observation. The archive pins cover
        # every subsequent GCC hop and the loader symlink under /usr/lib64.
        for name, target in {"/usr/bin/cc": "/etc/alternatives/cc",
                             "/etc/alternatives/cc": "/usr/bin/gcc", "/lib64": "usr/lib64"}.items():
            aliases[name] = {"uid": 0, "gid": 0, "mode": "0777", "target": target}
        for path, pin in aliases.items():
            alias(Path(path), pin)

        destinations = {"/usr/bin/cc": COMPILER, "/usr/bin/gcc": COMPILER,
                        "/usr/bin/gcc-13": COMPILER, "/usr/bin/as": ASSEMBLER,
                        "/usr/bin/ld": LINKER, "/usr/bin/ld.bfd": LINKER,
                        "/usr/bin/x86_64-linux-gnu-ld": LINKER, INTERPRETER: LOADER,
                        "/lib64": "/usr/lib64", "/usr/lib64/ld-linux-x86-64.so.2": LOADER}
        destinations.update({path: PLUGIN for path in plugin["aliases"]})
        destinations.update({role: entry["canonical"] for role, entry in roles.items() if entry["alias"]})
        for path, final in destinations.items():
            need(resolve(Path(path), strict=True) == Path(final), "compiler-alias-destination")

    with checkpoint('compiler_elf_members'):
        for entry in roles.values():
            body = member(Path(entry["canonical"]), entry["pin"], capture=True)
            interpreters, needed = elf_identity(body)
            need(interpreters == entry["interpreter"], "elf-interpreter")
            need({name: approved.get(name) for name in needed} == entry["directNeeded"],
                 "elf-unsupported-resolution")
        interpreters, needed = elf_identity(member(Path(PLUGIN), plugin["pin"], capture=True))
        need(not interpreters, "plugin-interpreter")
        need(set(needed) <= approved.keys(), "plugin-unsupported-resolution")
        for path, pin in plan["linkInputs"].items():
            member(Path(path), pin, capture=False)
    return {"elfRoles": len(roles), "aliases": len(aliases), "linkInputs": len(plan["linkInputs"]),
            "linkerPluginReadback": True}


def require_live_resolution():
    # There is no admitted collector for the exact launched worker. Static records,
    # ld.so.cache and paths from other jobs cannot authorize compiler execution.
    raise Refused("same-job-loader-resolution-unbound")
