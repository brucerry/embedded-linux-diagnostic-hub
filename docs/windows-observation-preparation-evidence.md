# Windows observation preparation evidence

This local repair addresses preparation logging and challenge display. It does not qualify a
Windows/native run or change the observation policy, deadlines, resource bounds or approval gates.
Run39351381522 remains cancelled with retained, unreleased observation custody. Its original
triggering exception was not recovered; the exact legacy boundary reproduction supports the budget
mechanism without proving the historical exception.

## Physical records and reconstruction

Preparation still has a1MiB physical encoded cap,2048records and65536bytes per record. Normal work
cannot consume the327680-byte/32-record terminal reserve. Of that reserve,32768bytes and one row
remain for a real ownership hold. Shared admission also retains this credit within the unchanged
4MiB parent and8MiB combined limits. These are apparent-byte admission checks, not filesystem quotas
or proof of writes between observations.

Every actual provider call still runs. The input, each raw output fragment, and closed process
result are recorded in order. A full record contains either `data`, or `encoded` with lossless
raw-deflate/base64 JSON, original byte count and SHA256. Inflation is bounded at65536bytes. Repeated
security payloads can reference only an earlier full record of the same stage. A reference contains
that origin's sequence, original JSON byte count and SHA256. No reference chains, paths, sidecars or
discarded earlier facts are used. An origin is published to the bounded dictionary only after write,
fsync and actual close succeed. Its file identity and complete physical hash are rechecked before
each reference. The dictionary has at most256entries/262144logical payload bytes; it stores bounded
identifiers, not expanded transcripts. New payloads beyond that index remain full records subject to
the same physical admission.

`readPreparationEvidence(directory)` in `scripts/lib/observation-preparation-evidence.mjs` streams
strictly contiguous records and reconstructs each original `{sequence,stage,data}`. Consume the
whole iterator before claiming a valid prefix. Bind the directory and all member bytes to the sealed
run inventory separately; reconstruction itself is not a run authentication or approval capability.
Raw stdout/stderr base64, input JSON, lengths, hashes, status and sequence remain exact. Logical
reconstructed bytes may exceed physical encoded charges; only real encoded file bytes are charged to
the preparation and shared budgets.

Before a security input/provider call, the live logger reserves an entire bounded raw transcript:
245760bytes/eight rows, covering a65536-byte input record, up to six output fragments for the two
65536-byte streams and the closed result. A new provider is never started using terminal credit in
ordinary mode. Unsupported input, candidate lists or novel results may still fail truthfully; query
attempts whose output/closed evidence is missing retain custody.

Admission before lease creation and again before challenge display computes at most120 polls from
`ceil((originalDeadline-now)/10000)`, with three fresh marker queries per empty-list poll. The
unchanged PTY reader needs `2+6*floor(files/16)+ceil((files%16)/3)` queries per pass. The first
admission includes both PTY passes; the challenge admission includes the remaining pass. Thirty-two
additional query slots cover setup, the valid-artifact API branch and final checks. Routine exact
references cost at most256bytes per row; the first PTY pass declares8192encoded bytes per query.
Actual per-query/record/shared checks remain authoritative if data differs. Unsupported declared
envelopes refuse before lease/challenge admission. A10-file artifact listing need not fit the
successful routine envelope; it can refuse with a durable failed outcome. Setup consumes the
original clock. Clock-only checks after async response bodies, download and waits add no cached
security decisions and never restart the20-minute preparation deadline.

A WeakMap proof is minted only by an actual pre-open budget guard with an intact committed prefix. A
matching message, serialized flag or copied error is not proof. Such a refusal stops new work
without declaring earlier fsync/close results unknown. Once a provider has run, a missing output or
closed-result record makes the query incomplete and retains ownership even if that particular failed
record was refused before open. Open/write/fsync/close/trust failures stay uncertain. Failed
ordinals/charges are never reused.

The original bounded structured error (stage, charges and active query effect/closure state) is
latched before joining descendants or cleanup. Secondary persistence/cleanup errors are separate. A
failed terminal report cannot turn into permission to release. Positive failed cleanup still
requires source, root/environment/ancestry, resources, all evidence and actual marker owner/ACL/
identity/bytes checks, with a durable failed-outcome receipt. Deadline expiry and cancellation
cannot discharge an uncertain referenced hold. The cleanup guard still uses the original deadline.

## Live challenge retrieval

A challenge is first persisted durably, then emitted as separate console records prefixed
`OBSERVATION_CHALLENGE `. Each record is at most900UTF8bytes, leaving124bytes of headroom within the
observed1024-character viewer limit. The version1 start/end manifest gives run, attempt, nonce,
binding/decision SHA256, chunk count, exact decoded byte count and complete payload SHA256.
Ordered384-byte chunks use canonical base64. Total decoded challenge bytes are bounded at65536.

Within the still-live same-host preparation window:

1. Copy each complete prefixed console line, including the start manifest, every sequential chunk
   and end manifest, into a local text file. Timestamp wrappers are permitted. No final job-log
   download is required. A missing line or truncated record must stop approval.
2. In the reviewed source checkout, call
   `readObservationChallenge(lines, {run,commit, sourceSHA256,request})` from
   `scripts/lib/observation-challenge.mjs`. Require a complete successful reconstruction and inspect
   the full binding/decision. Compare the binding SHA256 to the durable challenge and the exact
   sealed request. Do not treat a summary, chunk or display manifest as approval. The test fixture
   contains the actual recovered challenge for offline reproduction.
3. Confirm the original host, run/attempt/commit/source, PID, nonce, marker identity/body, source,
   fresh PTY scope/policy/closure and unchanged deadline before requesting separate human approval.
   Only a current clock reading from the bound host can be used as `hostNowMs`; local wall time
   cannot substitute for the remote monotonic clock.
4. Submit the separately authorized exact decision through the existing authenticated approval
   workflow only after explicit live approval. Complete display reconstruction confers no receipt or
   in-memory authority. Replay, mismatched request, reordered/corrupt/foreign chunks and expired
   challenges refuse. Existing source/PTY/marker revalidation after approval and before payload
   admission remains required.

The regression fixture recovers214real Windows query transcripts byte-for-byte. The disposable Mac
lease/poller fixture uses recovered Windows descriptor/ACE data with paths and ACE file/ directory
flags projected onto disposable local files; it does not execute a Windows provider. These tests do
not prove a live viewer retrieval, native runtime, hosted cleanup or historical release.

For a concrete local reconstruction command, put the expected `run`, `commit`, `sourceSHA256` and
full sealed `request` into `expected.json`, and copied complete console lines in `live-lines.txt`.
From the reviewed source root with Node24 and the existing dependencies:

```sh
node --import tsx --input-type=module -e '
import fs from "node:fs";
import { readObservationChallenge } from "./scripts/lib/observation-challenge.mjs";
const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
const lines = fs.readFileSync("live-lines.txt", "utf8").split(/\r?\n/);
console.log(JSON.stringify(readObservationChallenge(lines, expected), null, 2));
'
```

This command reconstructs a display only. It performs no workflow, approval or workload action.
