"""Streaming hashes of already bounded files on both Jammy 3.10 and hosted Python."""
from hashlib import sha256


def sha256_stream(wire):
    digest=sha256()
    while chunk:=wire.read(65536):
        digest.update(chunk)
    return digest
