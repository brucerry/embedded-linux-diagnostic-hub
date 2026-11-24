"""Use the existing bounded client pipe for the pair-specific checked transport."""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
from time import monotonic

from pair_custody import exact, need, receive
from private_attach import AttachedPipe

MARK=b'HUB_PAIR_DATA_OK '

def prelude(reader,deadline):
    """Retain the fixed phase metadata only. Reject oversized, incomplete, or missing terminal lines."""
    result=bytearray()
    while len(result)<4096:
        start=len(result)
        while len(result)<4096:
            char=exact(reader,1,deadline)
            result.extend(char)
            if char==b'\n':
                break
        line=bytes(result[start:])
        need(line.endswith(b'\n'),'pair-attach-prelude')
        if line.startswith(MARK):
            return bytes(result)
    raise ValueError('pair-attach-prelude')

def attach(argv,env,seconds,select_binding,directory,*,reserve):
    """The caller must still establish ownership, terminal state, and worker retirement."""
    deadline=monotonic()+seconds
    with subprocess.Popen(argv,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,start_new_session=True) as client:
        passed=False
        try:
            with selectors.DefaultSelector() as monitor:
                reader=AttachedPipe(client,deadline,monitor)
                expected=select_binding(prelude(reader,deadline))
                result=receive(reader,directory,expected,deadline,reserve=reserve)
                while monitor.get_map():
                    reader.poll()
            left=deadline-monotonic()
            need(left>0,'pair-attach-deadline')
            try:
                need(client.wait(timeout=left)==0,'pair-attach-exit')
            except subprocess.TimeoutExpired:
                raise ValueError('pair-attach-deadline') from None
            passed=True
            return result
        finally:
            if not passed:
                try:
                    os.killpg(client.pid,signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    client.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    raise ValueError('pair-attach-retirement') from None
