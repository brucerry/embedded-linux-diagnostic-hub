# Pending Automation lease cancellation correction

The independent review accepted the frozen interim Serial/UI packet but found that Cancel while
`acquireAutomationActivity()` was pending could be followed by `runner.start()`, which reset the
runner's cancellation flags. This correction remains isolated and unadopted for re-review.

Candidate: `../automation-arm-correction/workspace`.
Exact two-file delta: `automation-arm-correction-review.patch`.
Manifest/evidence: `automation-arm-correction-review.json`.
Patch SHA-256: `cba13de58291f5955e14bcdb1cc278118a1d220c061ba9752be0602752df7799`.
Baseline accepted packet SHA-256: `9873e2e9c67958c2d5c0825b067ca379e75f132c2a6c7e1beb8992b4490d9ba5`.

Each start receives a unique attempt token. Cancel invalidates a pending token and its eligibility
epoch before unfreezing the draft. A late granted lease is released by its original continuation,
which returns before starting the runner. A stale rejection or finally block cannot change a newer
attempt's error, busy state or arming state; final cleanup checks ownership after asynchronous
release. Cancellation of an already active runner retains the existing queued/repeating/scheduled
disarm behavior. No transport, host activity implementation or remote command is changed.

The host currently grants only one desktop activity lease. If an immediate explicit re-arm reaches
that host before an old grant has been released, the host may reject it as already owned; that is a
safe failed arm, not an automatic retry. Synthetic overlapping grants deliberately exercise the
renderer fencing more strongly than this current host permits.

Validation:

- Baseline pending-lease browser regression failed as expected before the source correction; log
  and trace remain under `../automation-arm-correction/baseline-pending-cancel.log` and
  `../automation-arm-correction/browser-results/`.
- 12 new actual-component browser cases passed: SSH and Serial, immediate/scheduled plus repetition,
  stale grant/reject during a newer arm and during a newer active flow. No cancelled draft sends or
  implicit restart occurred; late granted leases were released. No physical transport was used.
- Nine existing affected Automation browser cases passed in the same run: 21 total. Four pending
  cancellation cases were repeated after strengthening the real results-table/disabled-clear checks;
  all four passed. Tests use the virtual clock to cross scheduled start and repetition deadlines.
- 37 focused runner/cancellation/Serial unit cases passed; typecheck and changed-file format passed.
- Patch apply-check passed against the frozen checkpoint. All 359 frozen source hashes and every
  other candidate source hash were verified. The user's live edit remains uncopied and has SHA-256
  `07dd490a4abff47fc24fcd86ceb63a3ff5fa0d7605b427420a08c1af2043376b`.

The native installer/installed app evidence remains accepted for snapshot
`972be142f3067c49df91cdec6d9bfd08ae7b9f63`, independently of this source change. No native install
was repeated and no release, packaging, physical UART/SSH or full-output acceptance is claimed.

The separate storage design and generated-data feasibility evidence are in
`../capture-storage-draft/storage-design.md`. The interim cap is still not compliant with the
full-output request; production storage and persistent console implementation remain pending.
