# Test reports

Exporting is optional. **Export JSON** creates the canonical `diagnostic-hub-test-report`, schema 1;
**Export HTML** creates a self-contained readable document. Desktop **Export PDF** writes a native
PDF after a save dialog. On the website, **Print / Save PDF** opens an explicit preview: choose
**Print / Save as PDF**, then use your browser's print dialog. The website does not claim a PDF was
saved automatically.

Documents include source labels, overall verdict and counts, observed board metadata and declared
revision, endpoint/SSH username, application/adapter versions, UTC run timestamps, inventory
limitations, exact profile digest, resolved resources, parameters, acceptance criteria, fixture
readiness/identity, operator observations, expected/observed values, restoration and interruption
details. Raw stdout/stderr appears in a separate appendix. JSON also retains the complete normalized
profile and inventory, including raw DT evidence. Missing values remain unknown; observed zero is
not treated as missing.

No password, private key, terminal transcript or header-clock sample is collected into a report.
Endpoint, username, serial, fixture identifiers and command output can identify your test setup;
review exported evidence before sharing it. Export and print use no cloud service, external fonts or
network resources. Device-provided markup is escaped as text. The temporary native PDF renderer is
hidden, sandboxed, has no Node/preload or JavaScript access, refuses network/permissions and is
destroyed on success, failure or its 30-second deadline.

## Verdicts

| Verdict      | Meaning                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| Pass         | Recorded acceptance criteria met, with required restoration and observations verified. |
| Fail         | Observed behavior mismatched the approved expectation.                                 |
| Blocked      | A mapping, fixture, tool, permission or access prerequisite prevented the operation.   |
| Skipped      | The case was not executed, such as after cancellation or stop-on-failure.              |
| Inconclusive | Execution, cleanup or physical observation is incomplete/uncertain.                    |

Required cases determine the summary; if none are required, all selected cases do. A failed required
case yields Fail. Interrupted/incomplete evidence cannot yield Pass. A finished LED command needs
operator feedback, and a command exit code of zero alone never proves functional success.

Use **Import test report** for test JSON. This is separate from **Import report** for diagnostic
snapshots. Imports are validated, bounded to 16 MiB and displayed as historical evidence; they do
not connect to a recorded endpoint or start testing. Digest/evidence/verdict inconsistencies are
rejected without replacing the current result. Validation detects structural inconsistency; these
reports are not digitally signed attestations and do not prove authenticity against deliberate
rewriting of all observations.

Only one current run is retained per backend session. Export important evidence before another run
or reset. Reports are never saved automatically or uploaded.
