"""Incrementally validate the fixed serial prefix before any launch grant."""
import re
from threading import Event
from time import monotonic

PREFIX=('native_stock','native_custody','native_guest_storage','native_display_apt',
        'native_runtime_apt','native_display_capability','native_ready')
LIMIT=256*1024


class Evidence:
    def __init__(self,nonce):
        if not re.fullmatch('[a-f0-9]{64}',nonce):
            raise ValueError('pregrant-nonce')
        self.nonce=nonce.encode('ascii')
        self.pending=bytearray()
        self.seen=0
        self.boot=0
        self.matched=0
        self.event=Event()
        self.refused=False

    def fail(self):
        self.refused=True
        self.event.set()

    def line(self,raw):
        row=raw.removesuffix(b'\r')
        if self.matched==len(PREFIX):
            return
        if row==b'HUB_QEMU_READY_TO_EXEC':
            if self.boot:
                self.fail()
            self.boot=1
        elif re.fullmatch(rb'\[\s*0\.0+\] Linux version [0-9][^\r\n]+',row):
            if self.boot!=1:
                self.fail()
            self.boot=2
        elif b'HUB_JAMMY_VENUE ' in row:
            part=b'HUB_JAMMY_VENUE '+self.nonce+b' '
            if row==part+b'begin' and self.boot==2:
                self.boot=3
            elif row==part+b'loopback-only' and self.boot==3:
                self.boot=4
            else:
                self.fail()
        elif b'HUB_JAMMY_NATIVE ' in row:
            expected=(b'HUB_JAMMY_NATIVE '+self.nonce+b' '+PREFIX[self.matched].encode('ascii')+b' pass')
            if self.boot!=4 or row!=expected:
                self.fail()
            else:
                self.matched+=1
                if self.matched==len(PREFIX):
                    self.event.set()

    def feed(self,block):
        if self.event.is_set():
            return
        self.seen+=len(block)
        if self.seen>LIMIT:
            self.fail()
            return
        self.pending.extend(block)
        *done,remaining=self.pending.split(b'\n')
        self.pending=bytearray(remaining)
        if len(self.pending)>65536:
            self.fail()
            return
        for line in done:
            self.line(bytes(line))
            if self.event.is_set():
                return

    def require(self,deadline,cancelled):
        while not self.event.is_set():
            left=deadline-monotonic()
            if left<=0 or cancelled():
                raise ValueError('pregrant-evidence-unreached')
            self.event.wait(min(left,.1))
        if self.refused or self.matched!=len(PREFIX) or cancelled():
            raise ValueError('pregrant-evidence-refused')
