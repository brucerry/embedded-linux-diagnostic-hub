"""Existing nonblocking, deadline-bound private client pipe."""
import os
import selectors
from time import monotonic
from pair_wire import need

class AttachedPipe:
    def __init__(self, client, deadline, monitor):
        self.client = client
        self.deadline = deadline
        self.monitor = monitor
        self.buffer = bytearray()
        self.eof = False
        for pipe in (client.stdout, client.stderr):
            os.set_blocking(pipe.fileno(), False)
            monitor.register(pipe, selectors.EVENT_READ)

    def poll(self):
        remaining = self.deadline - monotonic()
        need(remaining > 0, 'attach-deadline')
        events = self.monitor.select(remaining)
        need(events, 'attach-deadline')
        for key, _ in events:
            data = os.read(key.fd, 65536)
            if not data:
                self.monitor.unregister(key.fileobj)
                if key.fileobj == self.client.stdout:
                    self.eof = True
            else:
                need(key.fileobj == self.client.stdout, 'attach-private-stderr')
                self.buffer.extend(data)

    def read(self, count):
        while not self.buffer and not self.eof:
            self.poll()
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data

