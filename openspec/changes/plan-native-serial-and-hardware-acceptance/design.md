# Design

## Context

See proposal.md. This skip-specs queue originally covered a pending native port discovery decision
and hardware evidence. It later accumulated authorized UI/storage checkpoint tasks;
storage-design.md supplied technical work but was not the schema's design.md. The October 15 audit
observed isPlanningComplete=false and missingPrerequisites=[design], although the apply instruction
state said ready and strict validation passed 21/21.

## Goals / Non-Goals

Goals: preserve exact evidence and honest stage boundaries, eliminate stale task narratives and
complete the concrete behavioral specifications for implementation. Non-goals: invent approval
history, qualify a DUT from mocks, archive unfinished work or authorize a port/backend dependency.

## Decisions

- Keep skip_specs only for coordination. The missing design is now present; storage behavior is
  specified in add-durable-automation-capture. The existing storage-design.md is an immutable
  historical feasibility checkpoint, not a description of today's implementation format.
- Preserve old checked tasks as narrow completed checkpoints. Add separately worded
  preparation/acceptance tasks rather than checking broad 5.2/5.3/8.4 while SSH, memory,
  native-platform and browser failure gates remain open.
- Frozen packets are authoritative for exact source and evidence. Integrate only accepted packets
  into isolated candidates; original repository adoption and release qualification require their own
  evidence. The separate four-line live.spec.ts edit, main-only history, local exclusion and
  published assets remain preserved.
- Keep unsupported native driver coverage and physical acceptance explicit. No request in this audit
  opens a port, connects to a target, changes access/driver policy or asks the target to enable
  UART.
- Use sibling proposal/design/spec/task coverage for new functionality: persistent SSH console,
  durable capture and optional flow viewer. Latest Serial foreground/cloud/palette and SSH
  height/star refinements remain unchecked visual tasks in their existing release plan; implemented
  islands/crabs/bird removal are retained.

## Risks / Trade-offs

- A broad task can hide completed subwork: retain the broad gate while documenting exact accepted
  slices.
- A green validator can omit semantic/process gaps: independently inspect prerequisites, conflicting
  requirements, evidence provenance and adoption state.
- Later drafts cannot retroactively establish a preimplementation spec: report that discrepancy in
  the audit and require the updated artifacts to govern further work.

## Migration Plan

No data or product migration occurs here. Read the sibling change's concrete context before its next
apply operation, preserve frozen packets, review the current index candidate, then complete
independent SSH streaming and the remaining release gates. Leave this queue active until its actual
pending decisions/acceptance are resolved.
