# Isolated soak correction controls

This is a preparation checkpoint in task-5/windows-soak-controls-candidate-26. It preserves the
968-file candidate-25 prototype with source SHA256
fd2298553de2666036f62c5cfa712579ebb6f79a1acf3ab72fc3419c8c4b2720. Candidate 25 is incomplete and
unaccepted; these controls do not retroactively accept it. Original repository planning files and
all sealed predecessors remain unchanged.

## Independent changes

- Use a distinct increasing global checkpoint ordinal across warm and measured phases; retain cycle
  ordinals separately. Require node-performance clock windows and real spacing. Compare exact
  state/PID/creation/role/metric series, and fail incomplete calibration without thresholds.
- Keep ephemeral measurements lifecycle-local. Refuse borrowed warmup, duplicate process rows,
  terminated zero values, missing reasons, excessive identity/series history and legacy slope units.
- Verify actual sampling windows and conserved counters independently of target cadence. Slow reads
  and coalesced requests remain evidence, not fabricated successful observations.
- Refuse duplicate dictionary content, foreign references, wrong schema/hash/order/ordinals,
  incomplete EOF/footer and late corrupt events before semantic visibility. Reader callback failures
  remain sticky. Descriptor finalization is coalesced; a throwing hold callback cannot prevent the
  close attempt, and close refusal cannot report success.

The tests use synthetic data, real local temporary-file I/O where explicitly named, controlled
descriptor ports and virtual driver clocks. They do not run a native application or full soak. The
existing invocation tests include metadata-only Node subprocesses; they do not collect product
memory or execute capture workloads. Exact commands, counts, logs and source hashes are in the
successor's review-packet/CHECKPOINT.json and source-inputs.json when sealed.

## Remaining gates

Task 4.8 and its capacity, report-validation, full-source review and actual host qualification gates
remain open. The separate task-4/soak-staged-capacity-decision-1 resolves design choices for future
implementation: existing 16-KiB fixture geometry, a shared 32-MiB canonical staging quota, separate
record/report counters and unchanged 16-MiB reader credit. It does not establish that this source
implements those decisions or that any full-count model fits. The 64-byte model remains a capacity
refusal negative. Collection remains disabled; there is no push, dispatch or full-soak approval.

## Official OpenSpec validation tooling

The repository's generated skills identify generatedBy 1.13.1. Its existing compliance audit uses
openspec validate --all --strict --json. The official v1.13.1 package is @fission-ai/openspec and
its bin is bin/openspec.js; this is a matching generator version, not an application dependency pin.
No executable, local dependency or cached package was found in the inspected environment. The
official package must be made available to run that command; no installation, init, update, custom
validator or structural-validation pass is claimed here. Existing copied requirements/task edits are
explicitly authorized. Nothing creates or modifies an original planning root.
