# Current local OpenSpec reconciliation

At 2026-10-14 synchronization the native implementation workflow continued to use this existing
change, but the latest small artwork/timestamp/validation requirements and completed v0.5.2
publication had lagged in the local task record. This file and the added delta specs/tasks correct
that lag before further validation implementation. The active changes remain
plan-windows-permanent-delivery and plan-native-serial-and-hardware-acceptance. Canonical specs
remain the released baseline until completed change synchronization/archive; current follow-ons are
explicitly recorded as active deltas.

Independent review accepted the art increment (three files, 2 UI cases plus typecheck/visual
inspection) and receive-output increment (seven file hashes, 19 unit cases, 1 Serial UI case and
typecheck). These are checked only to the bounded increment scope. Field validation source
implementation, its review, fresh preview packaging, production installer gates and all pending
hardware/platform qualification remain unchecked.

v0.5.2 publication evidence was confirmed by the parent: source
2f84f429214633374e56159296b87c188d64c5f2, annotated tag 4ac19c67773d0240c53d8f88a887e32435baf700,
release 412835331, 24 assets, successful workflow 38583615508 and published Mac x64/arm64 consumer
checks. Local v052 source/tag/push receipts remain in the task evidence directory. Task 5.1 is now
reconciled as completed. The selected next target is one combined v0.6.0, not v0.5.3.

User-reported COM11 basic connect/send/receive exists, but does not replace complete physical
office/power-cycle/replay/control-line/platform acceptance. The separate hardware queue remains 0/2
complete. Neither this spec synchronization nor tests opened a physical port or changed
device/host/network settings. OpenSpec/.agents/.codex remain excluded by .git/info/exclude.
