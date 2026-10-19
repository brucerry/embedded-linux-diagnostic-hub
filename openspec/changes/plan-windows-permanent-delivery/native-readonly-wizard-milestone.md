# Visible native wizard milestone

Actual private Windows setup 0.5.2, frozen source 869d7d7ae88e30162046af670b9591f0957b6961, now
renders Welcome/location/options/review. The fresh-folder native probe returns new/install with
Start menu on, Desktop off and launch off (the test passes NOLAUNCH). All three allowed Next
transitions stopped at Review; the Install control was never invoked. Localized cancellation
confirmation completed normally, with no remaining owned setup process, installation destination or
normal profile inventory change.

A separate nonempty unowned task folder was refused; its exact sentinel survived and the wizard
returned to location/cancel. That case also cancelled normally without any apply action or profile
inventory change. Actual runtime extraction is verified against both compiler ASAR and executable
hashes. Retained probe INIs show operation=probe, consent=0 and launch=0; they contain only the
known task target. Screenshots are owned-window captures and have been visually inspected.

Successful cases: C:/Users/bruce/Desktop/Codex/2026-10-13/task/setup-qa/readonly-new-acb6c456 and
C:/Users/bruce/Desktop/Codex/2026-10-13/task/setup-qa/readonly-unowned-9fb1e42c. Fresh probe
observation 1.19 seconds; Welcome observed after 24.49 seconds. Negative refusal observed after
10.11 seconds, including modal automation time. These are neither installed-app startup measurements
nor installer lifecycle timings.

Initial automation failures remain in their original receipts. They involved localized message-box
buttons (OS UI text is localized even with the NSIS English page language) and required termination
of only the attested setup process. The successful reruns use the observed native
confirmation/acknowledgement controls scoped to the owned dialog; no source-runtime change or
installer mutation was used to correct automation.

Native screenshots expose polish work before public release: the caption repeats Setup; a long
application path clips in Review; flags display 1/0; unowned-folder refusal is safe but shows raw
ENOENT instead of a friendly next step. These are recorded, not silently presented as final UX
acceptance.

The real install test did not start. Automatic approval review rejected the command because it would
mutate files, shortcuts and registry while the visible initial user scope was planning-only. One
unchanged-call retry was subsequently rejected before process creation;
native-install-retry-rejection.json records it. No alternate route or further retry was used.
Reading the parent thread returned no human turns to verify an expanded authorization. Concrete
pending action: native-install-approval-action.json, exact proposed root
C:/Users/bruce/Desktop/Codex/2026-10-13/task/setup-qa/native-869d7d7-approved/target-app, immutable
installer SHA256 bb8ea8f734b239107402c2b4a9b7c686e9a597f11165d8c155ff305dfbf31193. Existing
installations/profiles, source inputs, published history and user live test edit remain protected.

Source review acceptance allows the staged technical approach; it does not resolve the action
approval rejection. Native install/launch/repair/recovery/removal, actual lifecycle timing, true
future-version/report cases and Mac/Linux acceptance remain pending. Current evidence is actual
read-only wizard/probe/cancel only, using a private 0.5.2 artifact, not a public v0.6.0 release.

Proof limits clarified: normal profile directory names/count remained the same; existing profile
file contents were not inspected or proven unchanged. The original /NOLAUNCH test qualifies its
forced disabled/off option only, not normal launch controls or native app launch. New synthetic
metadata presentation cases are never native install/repair/recovery/removal acceptance.
