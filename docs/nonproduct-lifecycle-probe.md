# Nonproduct lifecycle candidate

This code is available for review. No real probe has been executed and no exec-server outage,
memory, product, installer or Windows qualification follows from the unit tests. The measurement
marker remains untouched by those tests.

`scripts/nonproduct-lifecycle-probe.mjs` imports built-ins and the owned-child observer only.
Importing it runs nothing. A future separately reviewed run uses exactly one attached foreground
Node owner, one dummy work child and one dummy observer child. No product module, network, detached
process, unref, job service, persistence or OS security change is involved. The work child finishes
naturally after four 600 ms waits. The observer unsubscribes after 100 ms. Both require
nonce/role/sequence/PID bound IPC and acknowledged sends before disconnecting.

The owner has an 8-second observation budget including a 1-second cleanup reserve. It records actual
spawn, exit and close; only its direct child handles can be terminated. Spawn uncertainty, missing
close or failed evidence closure retains the marker and reports INVALID. Known pre-spawn setup
failures attempt every journal close and release only the exact own-token marker when closure is
certain. There are no retries. This is a finite observation budget, not a guarantee that a stalled
filesystem or unkillable attached OS handle will let the client return within eight seconds.

Evidence uses a unique private directory and create-only files. The combined journal, owner closure
receipt, final owner receipt, two client records, client verdict and reserved console frames are
bounded to 16 KiB and 32 records. The journal handles short writes, fsyncs every row and requires
explicit closure. The owner records its exact Node executable hash and fixture/helper hashes. A
pre-existing canonical marker blocks admission before either dummy is spawned. No guessed PID kill,
marker deletion or hidden recovery is attempted.

Client input size and remaining aggregate budget are checked before opening each regular file. Reads
allocate at most the remaining byte budget plus one byte, reject growth or rebinding, and require
explicit close. Parsing and verdict creation reuse that single bounded snapshot; they do not reread
the journal or receipts. Both planned resume outputs are validated before writing either.

Child closure and journal closure are persisted in `owner-closure.json` before releasing the exact
own-token marker. If this receipt cannot be synced and closed, the result is INVALID and the marker
stays held. The final owner receipt records the subsequent release acknowledgement. Failure to write
that final receipt leaves an incomplete client result; a closed pre-release receipt remains
available for review.

After code review, a prospective operator would use the exact reviewed Node and candidate paths:

```sh
node scripts/nonproduct-lifecycle-probe.mjs --run=1 --out=/absolute/task-or-temporary/private-directory
```

The client must use the supported exec tool's normal yielded-session mechanism. The owner-ready
frame supplies the private directory, nonce and owner PID. While that returned session is actually
running, record the tool-provided session ID:

```sh
node scripts/nonproduct-lifecycle-probe.mjs --client-directory=OWNER_DIRECTORY --client-phase=yield --nonce=OWNER_NONCE --owner-pid=OWNER_PID --session=TOOL_SESSION_ID
```

Then resume that same session through the supported tool and preserve its actual completion output,
exit code and absence of pending work. Only after successful owner completion:

```sh
node scripts/nonproduct-lifecycle-probe.mjs --client-directory=OWNER_DIRECTORY --client-phase=resume --nonce=OWNER_NONCE --owner-pid=OWNER_PID --session=TOOL_SESSION_ID --owner-exit-code=0
```

The owner receipt stays `OWNER_COMPLETE_PENDING_CLIENT`; its own code zero alone is insufficient.
`client-verdict.json` requires matching nonce, PID, session, actual owner closure evidence and the
client's running/yield and successful completed/resume records. These client fields are operator
attestations; the corresponding supported-tool transcript must accompany them for independent
review. They are not authenticated by the local program. A successful future result could establish
completion retrieval after a supported yield and dummy observer separation. It would not establish
live-resume overlap, exec-server outage survival, or product memory/lifecycle qualification.

`tests/nonproduct-lifecycle.test.ts` injects a virtual clock, EventEmitters, fake IPC, in-memory
journals and a fake lease. It exercises deadlines, cleanup, malformed/duplicate messages, failed
spawn/send/kill, missing closure, write/fsync/close errors, budget limits, foreign marker tokens and
client evidence. It forks no real dummy child and does not claim the canonical marker.
