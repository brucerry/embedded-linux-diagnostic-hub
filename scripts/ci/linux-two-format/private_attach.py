"""Private binary transport for the producing worker's one attached client."""

import os
import selectors
import signal
import subprocess
from time import monotonic

from private_export import need, receive
from worker_protocol import DIGEST_KEYS


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

    def metadata(self):
        prefix = bytearray()
        terminal = b'HUB_FOLDER_DATA_OK '
        count = 0
        while True:
            split = self.buffer.find(b'\n')
            if split < 0:
                if self.eof and not self.buffer:
                    return bytes(prefix)
                need(not self.eof and count + len(self.buffer) < 4096, 'attach-metadata-limit')
                self.poll()
                continue
            line = self.read(split + 1)
            count += len(line)
            need(count <= 4096, 'attach-metadata-limit')
            prefix.extend(line)
            if line.startswith(terminal):
                return bytes(prefix)


def attach(argv, env, seconds, parse_metadata, directory, expected_attempt, reserve):
    """Drain and reap the client. Its caller independently owns and retires the worker."""
    deadline = monotonic() + seconds
    with subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as client:
        success = False
        try:
            with selectors.DefaultSelector() as monitor:
                reader = AttachedPipe(client, deadline, monitor)
                digests = parse_metadata(reader.metadata())
                need(type(digests) is dict and set(digests) == set(DIGEST_KEYS), 'attach-metadata-refused')
                receipt = receive(reader, directory, expected_attempt, tuple(digests[key] for key in DIGEST_KEYS),
                                  reserve=reserve)
                while monitor.get_map():
                    reader.poll()
            remaining = deadline - monotonic()
            need(remaining > 0, 'attach-deadline')
            try:
                need(client.wait(timeout=remaining) == 0, 'attach-client-exit')
            except subprocess.TimeoutExpired:
                raise ValueError('attach-deadline') from None
            success = True
            return receipt
        finally:
            if not success:
                try:
                    os.killpg(client.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    client.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    raise ValueError('attach-client-retirement') from None
