# Console helper iteration identity correction

Apply this small test-only correction after the immutable console helper packet. It changes no
product runner, Page, repository, native main, transport, API, package or primary instrumentation
source.

The actual frozen runner creates one `runId` in its repeat iteration before entering `plan.steps`.
Every command in one Run once therefore shares that iteration ID. Step IDs and ordinals remain
distinct. The original helper incorrectly applied an identity-uniqueness assertion to run IDs, and
its two-step model incorrectly generated one run ID per step. That model passed a representation the
actual product does not produce.

The corrected helper requires all command run IDs to be nonempty and exactly one iteration identity
across the complete Run once journal. It separately requires distinct supplied step IDs and already
checks each actual step ID and ordinal in order. It returns the observed shared runId in its result.
The modeled fixture now uses a shared ID. The dedicated positive regression checks Script and Send
Enter sharing one ID with distinct step provenance. The substitution regression changes the second
command and its dispatch-preparation metadata consistently to a different run ID; the corrected
helper must still reject it.

The short red controls use the unchanged helper with the corrected semantic fixture: shared-ID
positive fails under the old uniqueness assertion, while the per-step substitution is wrongly
accepted. Both expected failures and the old source/test bytes are retained before the exact
assertion/return correction. The remaining pure controls recheck raw CRC, schema2 metadata,
independently expected raw bytes, criterion/input/preparation provenance, source iterator
settlement, catalog bounds and explicit unsupported PTY/ACK fields.

This correction verifies a helper contract, not an actual product console run. Actual browser/native
persistent console journal, real commands, PTY/ACK/provenance, reader closure, viewer isolation,
Results exports and full product resource/memory/platform gates remain for the primary to exercise.
The helper observes a common run ID from real journal metadata but does not independently attest a
globally substituted ID without an external expected runner ID. No ownership zero or native evidence
is invented.
