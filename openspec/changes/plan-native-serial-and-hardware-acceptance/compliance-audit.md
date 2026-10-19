# Current v0.6.0 OpenSpec compliance checkpoint

Audit date: October 15, 2026. Target remains the combined **v0.6.0**; original main/package remain
2f84f429 / 0.5.2. This pass changes local planning artifacts and freezes existing evidence only. It
does not implement the viewer, SSH console or another product increment.

## Outcome and limits

Fresh `openspec validate --all --strict --json` passes **23/23: five active changes and 18 canonical
specs**, with zero failures. All five changes now have the schema planning prerequisites present;
the native coordination queue intentionally keeps specs skipped. Current task counts are below.
Unfinished changes remain active and unarchived.

This is a present artifact/coverage check, not blanket historical workflow compliance or release
acceptance. The fresh pre-repair validator also passed 21/21 while the native change's status said
`isPlanningComplete: false` and apply instructions listed `missingPrerequisites: [design]`.
Validation does not establish semantic coherence, user approval history, test quality or product
qualification by itself.

## Instructions and evidence inspected

- Repository `.agents/skills/openspec-propose/SKILL.md`, `openspec-update-change/SKILL.md` and
  `openspec-apply-change/SKILL.md`; current root/context/config, per-artifact instructions/status
  and concrete apply context.
- All relevant canonical Automation/export/Serial/SSH-terminal requirements, current active
  proposals/design/tasks and affected deltas; native storage historical design/checkpoints; isolated
  current code and focused test/receipt evidence. Installer task history/native receipts are used
  only at their stated snapshot scope; this is not a new independent review of every installer code
  path.
- Original source boundaries and isolated integration: SerialSession/runner/AutomationPage/results
  and raw repositories; SSH per-step exec/session/manual PTY/gateway; Modal/theme/CSP and existing
  stars/Serial scene. The graph and dedicated SSH console are not implemented. SSH still has the
  legacy bounded capture path.
- Read-only official Electron PDF API and browser printing documentation/standard for the viewer
  feasibility choice. No port/SSH target, permissions, dependencies, install or publication action
  was used.

## Actual change IDs and task state

| Active change                                | Planning state                                            | Completed / total | Meaning                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `plan-native-serial-and-hardware-acceptance` | proposal/design/tasks present; specs deliberately skipped | 23 / 39           | Decision/acceptance coordination and exact historical checkpoint bookkeeping; broad storage/platform/hardware gates stay open            |
| `plan-windows-permanent-delivery`            | all artifacts present                                     | 63 / 109          | Existing implementation/native evidence retained; added visual refinements and combined-scope gates are unchecked                        |
| `add-ssh-persistent-console-automation`      | all artifacts present                                     | 0 / 17            | Dedicated PTY/intents/criteria/context design; no implementation claimed                                                                 |
| `add-durable-automation-capture`             | all artifacts present                                     | 4 / 15            | Formal storage lifecycle and integration coverage; four checks describe already tested/accepted checkpoint preparation, not new adoption |
| `add-automation-flow-viewer`                 | all artifacts present                                     | 0 / 13            | Read-only graph design and implementation/test plan only                                                                                 |

## Discrepancies found and repairs

1. **Missing schema design, not absence of all prior design.** The native queue had
   `skip_specs: true`, proposal/tasks and a substantial preimplementation `storage-design.md`, but
   no schema `design.md`. It accumulated behavior-changing work beyond its original
   native-port/hardware decision. Added the missing coordination design and routed detailed behavior
   to the dedicated durable-capture change. The existing Windows delta already required Serial
   full-output storage/exports; claiming there had been no storage spec would be incorrect. The
   missing coverage was detailed durable outcome/commit, migration/index/recovery/ownership and
   cross-transport behavior.
2. **Implementation preceded complete formal deltas.** Prior user authorization and
   design/checkpoints supported the isolated storage implementation, but its current complete
   schema/spec set was absent. There is no basis to call that historical sequence fully OpenSpec
   compliant. This pass repairs coverage prospectively and preserves the initial state; it does not
   invent retroactive approval or assert that prior authorized implementation was unauthorized.
   Graph and persistent-console design precede their implementation.
3. **Canonical bounded retention conflicted with the accepted request.** Durable-capture deltas
   replace small automatic total/row retention with bounded working memory and explicit deletion,
   while keeping finite storage and raw completeness honest. Manual Serial privacy now distinguishes
   explicit Automation persistence from unrelated manual transcripts.
4. **Overlapping active deltas could undo each other.** The SSH result replacement still required
   bounded retained eviction, and Windows' transport replacement still described only exec. Complete
   overlapping replacement blocks are now identical in the affected active changes; legacy JSON
   v1/v2 requirements are explicitly legacy, separate from stored v3 observations/outcomes. Future
   synchronization must compose the remaining non-overlapping additions; nothing is archived now.
5. **Stale completed-slice narratives.** The native task prose still said visible UI/native
   IPC/catalog/export integration was unwired after the accepted visible checkpoint and seven-file
   correction. Updated the current narrative and added narrow checked 8.8/8.9. Kept broad
   5.2/5.3/8.4 open, because independent SSH/gateway capture and aggregate gates are incomplete.
   Historical checkpoint files remain unchanged.
6. **Indexing completion confused with acceptance.** Added checked 8.10 / durable task 2.1 only for
   tested candidate preparation, backed by 47 native/31 browser passes, two explicit skips and
   native/build receipts. Independent review/adoption is separately unchecked (8.11 / 2.2), and
   native index-mode/heap qualification remains open.
7. **Visual backlog duplicated baseline work.** Confirmed bird removal/distant tree islands/static
   crabs are already implemented and accepted. Current unchecked work is left foreground removal,
   Serial-only ANSI/default/selection/cursor contrast, subtle pixel clouds and SSH height/star
   refinement. SSH already contains stars. Added missing visual spec coverage and unchecked Windows
   tasks 20.1/20.2; no scene code changed.
8. **Latest graph behavior was not recorded.** Added a separate
   capability/proposal/design/spec/tasks with confirmed consecutive arrowed edges following
   positions and view-only dragging, theme/interaction/accessibility/live-snapshot requirements and
   complete local PNG/SVG/PDF export. It has no execution editing/ownership and no implementation
   checkboxes checked.
9. **SSH storage/context gaps.** Removed obsolete exact total-cap acceptance in console tasks,
   coordinated independent streaming first, and specified typed startup/idle/shutdown context
   segments without fabricated command outcomes. Real ash/PTY qualification stays separate from a
   mock model and remains blocked on an available authorized runtime.

## Requirement and test mapping

| Approved scope                                                               | Requirement / design owner                                                              | Evidence or remaining acceptance                                                                                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select/Deselect, contrast/focus, clock label, action presentation and Cancel | Windows Serial/clock/command deltas; native tasks 2.x/7.x                               | Existing independently accepted packets; do not redo narrow completed work or claim hardware evidence                                                                                       |
| Full raw storage, bounded memory, immutable outcome before next send         | durable `automation-capture-storage`; `command-automation` durable-advancement addition | Accepted Serial foundation/core/visible packets plus corrected storage/watchdog/delivery behavior; SSH streaming and whole-product heap remain open                                         |
| Search/paging/off-page stable selection/full scoped exports                  | durable `automation-exports` full replacement                                           | Accepted visible packet; accepted seven-file correction tests/negative controls; native shutdown and current-input membership controls                                                      |
| Native disposable index / deletion recovery                                  | durable storage recovery/catalog requirements                                           | Frozen ten-file candidate; 2048-row scale/scan evidence, quota/permission/alias/duplicate controls and owned-child SIGKILL; independent review and integrated index-mode/heap still pending |
| IndexedDB migration/outcome/lifecycle                                        | durable immutable-outcome/recovery requirements                                         | Real v1 upgrade/abort/blocked/malformed/future/counter/outcome transaction controls; reload all engines, actual Chromium crash; Firefox/WebKit crash explicitly skipped                     |
| SSH independent full capture / persistent console                            | durable streaming contract plus SSH proposal/spec/design                                | Implementation absent; exact code order and contracts in Task/ssh-storage-console-preparation/implementation-sequence.md; external target access excluded                                   |
| Latest Serial and SSH appearance                                             | Windows Serial/SSH-terminal deltas and native 6.x                                       | Newly explicit pending tasks; baseline bird-free islands/crabs and stars preserved                                                                                                          |
| Optional graph                                                               | graph capability's five requirements                                                    | 13 unchecked tasks; pure view snapshot, layout-only movement, accessible interaction, live identity, full-graph export/privacy and live-run continuity qualification                        |
| Installation/docs/release                                                    | Windows release plan and current per-snapshot receipts                                  | Earlier exact Windows native install/launch is valid only for its snapshot; combined Windows/Linux/macOS/installer/docs/final-source gates remain pending                                   |

## Reliability packet and retained failures

The new index/lifecycle review packet is **10 files, 86,854 patch bytes**, SHA256
**17c767666f6880515c8b691c5ff54345cbc0689ba6ed04661a53e445b6d3608e**, applying cleanly to the
accepted 404-file correction baseline. Frozen candidate has 410 source files. Its manifest records
every file and evidence hash; old packets remain unchanged.

- `Task/serial-fix-evidence/capture-index-lifecycle-review.json` and `.patch`
- `Task/capture-index-lifecycle/capture-index-lifecycle-checkpoint.md`
- `Task/capture-index-lifecycle/frozen-source`

The ordinary parallel WebKit matrix remains **8 passes / one unchanged five-second failure**.
Diagnostic snapshots show receive/storage/next-write progress in reproduced failures; that is not a
passing gate, CPU root-cause proof or an explanation of all historical traces. Original failures and
the separate diagnostic-only patch are preserved at
Task/webkit-progress-probe/progress-manifest.json and webkit-progress-checkpoint.md. No
assertion/deadline is raised or waived.

Unexpected midstream Firefox/WebKit download-error feedback remains open. Real ash/busybox/docker
was not available on PATH; read-only WSL enumeration returned Wsl/E_ACCESSDENIED in this selected
environment. That does not establish whether host distributions exist. No runtime installation or
permission change was attempted.

## Proposed graph PDF approach requiring review

The proposal assumes a reviewed lazy local browser PDF generator so export can avoid ordinary
blocking print behavior. This is an explicitly recorded reversible design assumption, not a
confirmed user preference or authorization to add a dependency during scoping. The optional
clarification remains pending. Electron's built-in asynchronous PDF API is the proposed native path;
it still needs isolated-surface/security/live-run acceptance. If the user prefers deferring browser
PDF, update the graph platform/scope explicitly before implementation rather than quietly
substituting SVG/PNG.

## Preservation and next stage

No project source was edited during this audit; only local OpenSpec planning and Task-owned evidence
were written. The user live-test SHA256 remains
**07dd490a4abff47fc24fcd86ceb63a3ff5fa0d7605b427420a08c1af2043376b**, +4/-0, never copied. Main-only
history, canonical specs/archive, existing exclusions and published assets/tags are unchanged.
`.git/info/exclude` still excludes OpenSpec/.agents/.codex. Exact changed planning paths, preserved
baseline hashes, fresh status/validation/format receipts and semantic overlap checks are in
audit-manifest.json.

Next: independently review the frozen index/lifecycle packet, resolve the WebKit latency/failure
feedback and other reliability gates, then apply independent SSH streaming/console in bounded
reviewed increments. Review the graph design and proposed PDF route before its separate
implementation request. Keep all remaining platform, docs, source adoption and publication gates
open.
