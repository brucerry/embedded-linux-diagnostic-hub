"""Bounded APT 2.8.3 phase observer. This module does not start APT or dpkg."""
from dataclasses import dataclass
import os
import re
import selectors
from time import monotonic

OUTPUT_LIMIT=128*1024
STATUS_LIMIT=64*1024
RECORD_LIMIT=1024
FIELDS=re.compile(rb'[\x20-\x7e]{1,768}')
PERCENT=re.compile(rb'(\d{1,3})\.(\d{4})')


@dataclass(frozen=True)
class Status:
    stream: str
    progress: str
    package_error: bool=False
    conffile_prompt: bool=False


def unobserved(verdict):
    return Status(verdict,'unobserved')


def decode(raw):
    if len(raw)>STATUS_LIMIT:
        return unobserved('status-cap')
    if not raw:
        return Status('empty','no-batch-announcement')
    if not raw.endswith(b'\n\n'):
        return unobserved('invalid-status')
    records=raw[:-2].split(b'\n\n')
    if len(records)>RECORD_LIMIT:
        return unobserved('status-cap')
    batch=child=package_error=prompt=False
    for record in records:
        items=record.split(b'\n')
        with_package=len(items)==4
        keys=(b'Status',b'Package',b'Percent',b'Message') if with_package else (b'Status',b'Percent',b'Message')
        if len(items)!=len(keys) or any(not row.startswith(key+b': ')
                                        for row,key in zip(items,keys,strict=True)):
            return unobserved('invalid-status')
        values={key:row[len(key)+2:] for row,key in zip(items,keys,strict=True)}
        percent=PERCENT.fullmatch(values[b'Percent'])
        if (not percent or int(percent[1])*10000+int(percent[2])>1_000_000
                or not FIELDS.fullmatch(values[b'Message'])):
            return unobserved('invalid-status')
        kind=values[b'Status']
        if not with_package:
            if kind!=b'progress' or values[b'Message']!=b'Running dpkg':
                return unobserved('invalid-status')
            batch=True
            continue
        if not batch or not FIELDS.fullmatch(values[b'Package']) or kind not in (b'progress',b'Error',b'ConfFile'):
            return unobserved('invalid-status')
        child=True
        package_error|=kind==b'Error'
        prompt|=kind==b'ConfFile'
    return Status('valid','child-reported' if child else 'batch-announced',package_error,prompt)


def drain(stdout_fd,stderr_fd,status_fd,deadline):
    """Read only the three owned pipe ends with one absolute monotonic deadline."""
    if len({stdout_fd,stderr_fd,status_fd})!=3:
        raise ValueError('observer-distinct-owned-pipes')
    ordinary=0
    status=bytearray()
    with selectors.DefaultSelector() as events:
        for fd in (stdout_fd,stderr_fd,status_fd):
            events.register(fd,selectors.EVENT_READ)
        while events.get_map():
            remaining=deadline-monotonic()
            if remaining<=0:
                return unobserved('capture-timeout')
            ready=events.select(remaining)
            if not ready:
                return unobserved('capture-timeout')
            for key,_ in ready:
                part=os.read(key.fd,8192)
                if not part:
                    events.unregister(key.fd)
                elif key.fd==status_fd:
                    status.extend(part)
                    if len(status)>STATUS_LIMIT:
                        return unobserved('status-cap')
                else:
                    ordinary+=len(part)
                    if ordinary>OUTPUT_LIMIT:
                        return unobserved('output-cap')
    return decode(bytes(status))
