"""Unprivileged guest entry. The root runner verifies the private media before this starts."""
from pathlib import Path
import json
import os
import sys
from time import monotonic

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))

from filesystem import tree
from folder_actor import execute_case
from guest_backend import ACCOUNT_UID, GuestBackend, HOME
from kit_media import pinned, sha


def main(argv):
    if len(argv)!=2:
        return 78
    config=Path(argv[0])
    if config!=HERE/'attempt.json':
        return 78
    raw=pinned(config,32768,digest=argv[1])
    bound=json.loads(raw)
    backend=GuestBackend(
        pinned(HERE/'LOADER-REFERENCE.json',65536),
        tree(HOME/'project',ACCOUNT_UID),
        monotonic()+540,
    )
    results=execute_case(root=HOME,uid=ACCOUNT_UID,media=Path('/mnt/hub-payload'),
                         binding_sha=bound['productBindingSHA256'],attempt=bound['attempt'],nonce=bound['nonce'],
                         transaction=bound['transactionSHA256'],references=backend.reference,backend=backend,
                         deadline=backend.deadline)
    print('HUB_GUEST_ACTOR '+bound['nonce']+' '+' '.join(results),flush=True)
    return 0


if __name__=='__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception:
        # Do not expose files, PTY data or command output through the guest console.
        raise SystemExit(78) from None
