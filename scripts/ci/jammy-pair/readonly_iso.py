"""Write and reopen closed, flat ISO 9660 data media without mounting a filesystem."""

from dataclasses import dataclass
from hashlib import sha256
import os
from pathlib import Path
import re
import stat
import struct


BLOCK = 2048
ROOT = 20
MIN_BLOCKS = 24
COPY = 65536


def need(value, label):
    if not value:
        raise ValueError(label)


@dataclass(frozen=True)
class Member:
    name: str
    source: Path | bytes
    size: int
    sha256: str


def memory(name, data):
    return Member(name, data, len(data), sha256(data).hexdigest())


def both(value, width):
    return value.to_bytes(width, 'little') + value.to_bytes(width, 'big')


def two_orders(buf, start, width):
    low = int.from_bytes(buf[start:start+width], 'little')
    high = int.from_bytes(buf[start+width:start+2*width], 'big')
    need(low == high, 'iso-endian-pair')
    return low


def rounded(size):
    return (size + BLOCK - 1) // BLOCK


def directory_record(block, size, name, directory=False):
    length = 33 + len(name) + int(len(name) % 2 == 0)
    return (bytes((length, 0)) + both(block, 4) + both(size, 4) + bytes((126, 1, 1, 0, 0, 0, 0))
            + bytes((2 if directory else 0, 0, 0)) + both(1, 2) + bytes((len(name),)) + name
            + bytes(int(len(name) % 2 == 0)))


def roster(entries):
    need(0 < len(entries) <= 96, 'iso-roster-cap')
    names = set()
    for entry in entries:
        need(re.fullmatch(r'[A-Z0-9_]{1,8}\.[A-Z0-9_]{1,3}',entry.name) and entry.name not in names and
             type(entry.size) is int and 0 < entry.size and re.fullmatch(r'[a-f0-9]{64}',entry.sha256),
             'iso-roster-entry')
        names.add(entry.name)
    return sorted(entries,key=lambda entry:entry.name)


def contents(item, output, check):
    if isinstance(item.source, bytes):
        need((len(item.source),sha256(item.source).hexdigest()) == (item.size,item.sha256),'iso-input-bytes')
        output.write(item.source)
        return
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    with os.fdopen(os.open(item.source,flags),'rb') as source:
        first = os.fstat(source.fileno())
        need(stat.S_ISREG(first.st_mode) and first.st_size == item.size and first.st_nlink == 1 and
             first.st_uid == os.getuid() and not first.st_mode & 0o7022, 'iso-input-identity')
        count, digest = 0, sha256()
        while chunk := source.read(COPY):
            check()
            count += len(chunk)
            need(count <= item.size, 'iso-input-size')
            digest.update(chunk)
            output.write(chunk)
        last = os.fstat(source.fileno())
        need((last.st_size,last.st_mtime_ns,last.st_ctime_ns) ==
             (first.st_size,first.st_mtime_ns,first.st_ctime_ns) and
             (count,digest.hexdigest()) == (item.size,item.sha256),'iso-input-pin')


def build(path, label, entries, limit, *, check=lambda:None):
    ordered = roster(entries)
    need(re.fullmatch(r'[A-Z0-9_]{1,32}',label) and type(limit) is int and limit > 0,'iso-label-cap')
    # Directory records must fit within one sector. Count padding before placing file extents.
    lengths = [34,34,*[len(directory_record(0,0,(item.name+';1').encode())) for item in ordered]]
    end = 0
    for length in lengths:
        if end % BLOCK + length > BLOCK:
            end = rounded(end)*BLOCK
        end += length
    root_size = rounded(end)*BLOCK
    cursor = ROOT + rounded(root_size)
    root = bytearray()
    records = [directory_record(ROOT,root_size,b'\0',True),directory_record(ROOT,root_size,b'\1',True)]
    for item in ordered:
        records.append(directory_record(cursor,item.size,(item.name+';1').encode()))
        cursor += rounded(item.size)
    total_blocks = max(cursor,MIN_BLOCKS)
    for record in records:
        if len(root) % BLOCK + len(record) > BLOCK:
            root.extend(bytes((-len(root)) % BLOCK))
        root.extend(record)
    root.extend(bytes(root_size-len(root)))
    need(total_blocks*BLOCK <= limit,'iso-output-cap')
    pvd = bytearray(BLOCK)
    pvd[:7] = b'\1CD001\1'
    pvd[8:40] = b'HUB'.ljust(32)
    pvd[40:72] = label.encode().ljust(32)
    pvd[80:88] = both(total_blocks,4)
    pvd[120:124] = both(1,2)
    pvd[124:128] = both(1,2)
    pvd[128:132] = both(BLOCK,2)
    pvd[132:140] = both(10,4)
    struct.pack_into('<I',pvd,140,18)
    struct.pack_into('>I',pvd,148,19)
    pvd[156:190] = records[0]
    pvd[190:813] = bytes(b' ')*623
    for offset in (813,830,847,864):
        pvd[offset:offset+17] = b'2026010100000000\0'
    pvd[881] = 1
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    check()
    with os.fdopen(os.open(path,flags,0o400),'wb') as output:
        output.write(bytes(16*BLOCK))
        output.write(pvd)
        output.write(b'\xffCD001\1'.ljust(BLOCK,b'\0'))
        for order in ('little','big'):
            table = b'\1\0' + ROOT.to_bytes(4,order) + (1).to_bytes(2,order) + b'\0\0'
            output.write(table.ljust(BLOCK,b'\0'))
        output.write(root)
        for item in ordered:
            check()
            contents(item,output,check)
            output.write(bytes((-item.size) % BLOCK))
        output.write(bytes((total_blocks-cursor)*BLOCK))
        need(output.tell() == total_blocks*BLOCK,'iso-final-size')
    return verify(path,label,ordered,limit,check=check)


def verify(path, label, entries, limit, *, check=lambda:None):
    expected = {entry.name:entry for entry in roster(entries)}
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    with os.fdopen(os.open(path,flags),'rb') as media:
        first = os.fstat(media.fileno())
        need(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and
             first.st_uid == os.getuid() and stat.S_IMODE(first.st_mode) == 0o400 and
             0 < first.st_size <= limit,'iso-output-identity')
        media.seek(16*BLOCK)
        pvd, end = media.read(BLOCK), media.read(BLOCK)
        need(pvd[:7] == b'\1CD001\1' and end[:7] == b'\xffCD001\1' and
             pvd[40:72] == label.encode().ljust(32) and two_orders(pvd,128,2) == BLOCK and
             two_orders(pvd,80,4)*BLOCK == first.st_size,'iso-descriptor')
        start, size = two_orders(pvd,158,4), two_orders(pvd,166,4)
        need(start == ROOT and BLOCK <= size <= 4*BLOCK and size % BLOCK == 0,'iso-root-size')
        media.seek(start*BLOCK)
        directory = media.read(size)
        need(len(directory) == size,'iso-root-truncated')
        cursor, block, roots, found = 0, start+rounded(size), [], set()
        while cursor < size:
            check()
            length = directory[cursor]
            if length == 0:
                aligned = rounded(cursor+1)*BLOCK
                need(not any(directory[cursor:aligned]),'iso-directory-padding')
                cursor = aligned
                continue
            need(34 <= length <= BLOCK-cursor%BLOCK and cursor+length <= size,'iso-directory-record')
            row = directory[cursor:cursor+length]
            cursor += length
            width = row[32]
            name = row[33:33+width]
            where, count = two_orders(row,2,4), two_orders(row,10,4)
            need(width and len(name) == width and not any(row[33+width:]) and
                 row[1] == row[26] == row[27] == 0 and two_orders(row,28,2) == 1,'iso-record-flags')
            if name in (b'\0',b'\1'):
                need(row[25] == 2 and (where,count) == (start,size),'iso-root-entry')
                roots.append(name)
                continue
            need(row[25] == 0 and name.endswith(b';1'),'iso-regular-member')
            text = name[:-2].decode('ascii')
            need(text in expected and text not in found and (where,count) == (block,expected[text].size) and
                 where*BLOCK+count <= first.st_size,'iso-member-extent')
            media.seek(where*BLOCK)
            remaining, digest = count, sha256()
            while remaining:
                check()
                chunk = media.read(min(remaining,COPY))
                need(chunk,'iso-member-truncated')
                digest.update(chunk)
                remaining -= len(chunk)
            need(digest.hexdigest() == expected[text].sha256 and
                 not any(media.read((-count)%BLOCK)),'iso-member-pin')
            block += rounded(count)
            found.add(text)
        need(roots == [b'\0',b'\1'] and found == set(expected) and
             max(block,MIN_BLOCKS)*BLOCK == first.st_size,'iso-closed-roster')
        media.seek(block*BLOCK)
        need(not any(media.read((max(block,MIN_BLOCKS)-block)*BLOCK)),'iso-final-padding')
        media.seek(0)
        image = sha256()
        while chunk := media.read(COPY):
            check()
            image.update(chunk)
        digest = image.hexdigest()
        last = os.fstat(media.fileno())
        stamp = (first.st_dev,first.st_ino,first.st_size,first.st_mtime_ns,first.st_ctime_ns)
        need(stamp == (last.st_dev,last.st_ino,last.st_size,last.st_mtime_ns,last.st_ctime_ns),'iso-changed')
        return {'bytes':first.st_size,'sha256':digest}
