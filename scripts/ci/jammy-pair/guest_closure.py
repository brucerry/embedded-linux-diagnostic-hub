"""Independent dedicated-user process readback before and after portable runtime."""

from dataclasses import dataclass
import os
from pathlib import Path
import re

from runtime_gate import need


@dataclass(frozen=True)
class Process:
    pid: int
    parent: int
    start: int


def process(raw,pid):
    match=re.fullmatch(rb'([0-9]+) \((.*)\) ([A-Z]) ([0-9]+) (.*)\n',raw)
    need(match and len(raw)<=4096 and int(match[1])==pid,'retirement-proc-frame')
    fields=match[5].split()
    need(len(fields)>17 and fields[17].isdigit(),'retirement-proc-start')
    return Process(pid,int(match[4]),int(fields[17]))


def sample(uid,proc=Path('/proc')):
    need(type(uid) is int and 0<uid<60000,'retirement-dedicated-uid')
    candidates=[]
    for item in proc.iterdir():
        if item.name.isdecimal():
            candidates.append(item)
            need(len(candidates)<=4096, 'retirement-proc-roster-bound')
    owned=[]
    for candidate in candidates:
        pid=int(candidate.name)
        try:
            status=(candidate/'status').read_bytes()
            need(len(status)<=16384,'retirement-proc-status-bound')
            row=re.findall(rb'(?m)^Uid:\s+([0-9]+)\s+[0-9]+\s+[0-9]+\s+[0-9]+\s*$',status)
            need(len(row)==1,'retirement-owner-readback')
            if int(row[0])!=uid:
                continue
            before=process((candidate/'stat').read_bytes(),pid)
            need(before==process((candidate/'stat').read_bytes(),pid),'retirement-pid-reuse')
            owned.append(before)
        except FileNotFoundError:
            continue
    need(len(owned)<=512,'retirement-owned-roster-bound')
    return tuple(sorted(owned,key=lambda p:p.pid))


def closed(baseline, *, exact_zero_exit, output_and_stderr_eof, sample_owned):
    need(exact_zero_exit is True and output_and_stderr_eof is True,'retirement-observer-terminal')
    need(type(baseline) is tuple and len({p.pid for p in baseline}) == len(baseline),
         'retirement-baseline-set')
    need(sample_owned()==sample_owned()==baseline,'retirement-owned-processes')
