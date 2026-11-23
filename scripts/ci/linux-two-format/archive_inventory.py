"""Independent bounded archive inventories. This module neither extracts nor executes."""

from dataclasses import dataclass
import gzip
from pathlib import PurePosixPath
import re
import tarfile


MIB = 1024**2
MAX_ARCHIVE_FILE_BYTES = 512 * MIB
MAX_ENTRIES = 2040
MAX_LIST_BYTES = MIB
TEMP_BYTES_MARGIN = 256 * MIB
TEMP_INODES_MARGIN = 16
TAR_ROOT = "Diagnostic-Hub-linux-x64"
IMAGE_ROOT = "squashfs-root"
PATH = re.compile(r"[A-Za-z0-9_.+@/-]{1,320}")
MODE = r"[r-][w-][x-][r-][w-][x-][r-][w-][x-]"
LIST_ROW = re.compile(rf"(?P<type>[-dl])(?P<mode>{MODE}) 0/0 +(?P<size>[0-9]{{1,9}}) "
                      r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} (?P<name>.+)")
MODES = {
    "resources/linux-installed-AppRun": 0o755,
    "resources/linux-setup-bootstrap.cjs": 0o644,
    "resources/linux-setup-install.cjs": 0o644,
    "resources/diagnostic_hub_rename_noreplace.node": 0o644,
}


@dataclass(frozen=True)
class Entry:
    kind: str
    mode: int
    size: int
    target: str = ""


def need(condition, label):
    if not condition:
        raise ValueError(label)


def round_to(size, unit):
    return ((size + unit - 1) // unit) * unit


def path_name(text):
    need(PATH.fullmatch(text) and all(p not in ("", ".", "..", ".git") for p in text.split("/")),
         "archive-relative-path")
    return PurePosixPath(text)


def add(entries, name, entry):
    need(name not in entries and len(entries) < MAX_ENTRIES, "archive-entry-count-or-alias")
    need(0 <= entry.size <= MAX_ARCHIVE_FILE_BYTES, "archive-entry-size")
    if entry.kind == "symlink":
        need(entry.mode == 0o777 and entry.size == len(entry.target), "archive-link-mode-size")
    else:
        need(not entry.mode & 0o7022 and entry.mode & 0o400 and
             (entry.kind != "directory" or entry.mode & 0o100), "archive-entry-mode")
    entries[name] = entry


def validate_tree(entries, root_name, *, permanent):
    root = PurePosixPath(root_name)
    need(root in entries and entries[root].kind == "directory", "archive-root-directory")
    for path, row in entries.items():
        need(path == root or path.is_relative_to(root), "archive-named-root")
        if path != root:
            need(path.parent in entries and entries[path.parent].kind == "directory",
                 "archive-directory-parent")
        if row.kind == "symlink":
            target = path.parent / path_name(row.target)
            need(target in entries and entries[target].kind == "file", "archive-link-file-target")
    need(entries.get(root / "AppRun", Entry("", 0, 0)).kind == "file" and
         entries.get(root / "resources/app.asar", Entry("", 0, 0)).kind == "file", "archive-product-roles")
    if permanent:
        for name, mode in MODES.items():
            row = entries.get(root / name, Entry("", 0, 0))
            need(row.kind == "file" and row.mode == mode and row.size > 0, "archive-permanent-mode")


def tar_inventory(stream, *, permanent=True):
    # Read plain ustar blocks directly. Reject extension/sparse/link headers before
    # exposing their lengths to a library, with only a small buffer for data discard.
    rows = {}
    expanded = 0
    with gzip.GzipFile(fileobj=stream, mode="rb") as archive:
        while True:
            header = archive.read(512)
            need(len(header) == 512, "tar-header-truncated")
            if not any(header):
                need(archive.read(512) == bytes(512), "tar-end-marker")
                while pad := archive.read(512):
                    expanded += len(pad)
                    need(expanded <= MAX_ARCHIVE_FILE_BYTES + 8 * MIB and not any(pad), "tar-trailing-data")
                break
            need(header[257:265] == b"ustar\0" + b"00" and not any(header[157:257])
                 and header[156:157] in (b"0", b"\0", b"5") and not any(header[500:]), "tar-ustar-plain")
            item = tarfile.TarInfo.frombuf(header, "ascii", "strict")
            need(item.devmajor == item.devminor == 0, "tar-device-fields")
            directory = item.isdir()
            need(not directory or item.size == 0, "tar-directory-size")
            name = path_name(item.name)
            add(rows, name, Entry("directory" if directory else "file", item.mode, item.size))
            expanded += 512 + round_to(item.size,512)
            need(expanded <= MAX_ARCHIVE_FILE_BYTES + 8 * MIB, "tar-expanded-cap")
            remaining = item.size
            while remaining:
                count = min(65536, remaining)
                need(len(archive.read(count)) == count,"tar-file-truncated")
                remaining -= count
            padding = (-item.size) % 512
            if padding:
                need(archive.read(padding) == bytes(padding), "tar-nonzero-padding")
    validate_tree(rows, TAR_ROOT, permanent=permanent)
    return rows


def squash_inventory(listing, expected_inodes, *, permanent=True):
    need(0 < len(listing) <= MAX_LIST_BYTES and listing.endswith(b"\n") and listing.isascii(),
         "squash-list-framing")
    rows = {}
    for line in listing.decode("ascii").split("\n")[:-1]:
        match = LIST_ROW.fullmatch(line)
        need(match is not None, "squash-list-row")
        fields = match.groupdict()
        kind = {"-":"file", "d":"directory", "l":"symlink"}[fields["type"]]
        mode = sum(1 << (8 - index) for index, char in enumerate(fields["mode"]) if char != "-")
        name, arrow, target = fields["name"].partition(" -> ")
        need(bool(arrow) == (kind == "symlink"), "squash-list-alias")
        add(rows,path_name(name),Entry(kind,mode,int(fields["size"]),target))
    need(len(rows) == expected_inodes, "squash-inode-census")
    validate_tree(rows, IMAGE_ROOT, permanent=permanent)
    return rows


def budget(tar, image, block_size):
    need(4096 <= block_size <= 65536 and block_size & (block_size-1) == 0,"worker-allocation-unit")
    def charge(archive):
        payload = sum(row.size for row in archive.values() if row.kind == "file")
        need(payload <= MAX_ARCHIVE_FILE_BYTES, "archive-logical-expand-limit")
        # Always budget a block for each member, plus rounded file or directory data.
        blocks = sum(round_to(row.size,block_size) + block_size for row in archive.values())
        need(blocks <= MAX_ARCHIVE_FILE_BYTES, "archive-allocated-expand-limit")
        return {"entries":len(archive),"logicalFileBytes":payload,"budgetBytes":blocks}
    left,right=charge(tar),charge(image)
    return {"tar":left,"appimage":right,
            "requiredBytes":left["budgetBytes"]+right["budgetBytes"]+TEMP_BYTES_MARGIN,
            "requiredInodes":left["entries"]+right["entries"]+TEMP_INODES_MARGIN}
