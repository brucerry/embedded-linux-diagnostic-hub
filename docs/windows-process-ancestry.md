# Process ancestry and PID generations

This local repair follows the retained startup hold from run 39365924595 on commit
`0f1a06f6cf98c70858c74d6fb516cf38c55ec356`. The runtime worker exited successfully and its pipes
closed, but four identities classified as descendants were created about 319 seconds before that
worker. The artifact contains selected identities and process-table hashes; it does not contain the
raw historical parent edges. Historical PID reuse remains a hypothesis. The original hold and its
unreleased marker record remain unchanged.

## Attribution

Roots remain the exact PID and creation identity of launched children. A later process with the same
PID does not become a new root. Every newly discovered edge uses the current parent generation and
its previously established ownership, regardless of table order or number of ancestry hops. Once a
descendant is tracked, reparenting, disappearance of its ancestors or replacement of a parent PID
cannot erase that ownership. A subsequently observed replacement descendant needs its own valid
edge.

Production readers label the creation clock explicitly:

- Windows `Win32_Process` UTC roundtrip timestamps require seven fractional digits and a valid
  calendar value. Comparisons preserve 100-nanosecond units using integers. A strictly older
  candidate cannot descend from that current parent generation; traversal cannot cross that edge.
- Linux `/proc` start ticks use unsigned decimal integers without conversion to floating point. The
  same strictly-older rule applies within this boot-relative clock.
- macOS `ps lstart` has local wall time, no timezone/fold and only second precision. Its English
  shape, calendar and weekday are validated. Apparent ordering cannot exclude a possible child: even
  an earlier displayed local second can be a clock adjustment. These edges remain tracked
  conservatively. No locale or arbitrary-label fallback establishes ownership.

Equal births remain possible custody. Missing, invalid, oversized or mixed relevant creation
identities fail closed. Detectable backwards generation changes for a previously tracked Windows or
Linux PID are sticky uncertainty. Duplicate PID rows and malformed PID values also refuse the
observation. An unrelated ambient timestamp is not a reason to enroll its process. The exact
original creation strings remain the matching identities; comparison values do not replace them.

## Bounded diagnosis and closure

Each admitted table replaces the previous ancestry-decision summary. It retains at most eight
relevant edge facts, a total/omitted count and a rolling digest, bound to the table sequence and
hash. Facts contain exact bounded child/parent creation identities, clock domains and the decision.
Repeated exclusions do not grow historical ownership or an unbounded evidence sidecar. Normal
startup child receipts and held terminal snapshots carry these summaries.

Filtering a never-owned older candidate is not a closure receipt and does not retire a previously
owned identity. The 256 unresolved-identity limit, 256 pending query-witness limit and 16-proof
batch remain unchanged. Authenticated query retirement still requires the exact owner generation,
query identity and command, actual exit/pipe closure and a subsequently started complete census. A
matching live or reparented query cannot be retired. Query and owner creation clocks must agree with
the receipt platform.

Startup join still requires direct child closure, all already-admitted observations to settle and a
final complete descendant census. A malformed `ps` row cannot silently disappear from that census.
Unknown custody retains the referenced hold, including when persistence fails or a later empty
table, cancellation or deadline occurs. No timeout, successful publication or direct exit alone
releases a marker.

## Validation and scope

The regression suite uses the shipped sampler, startup controller, lease and hold helpers with
injected process tables and disposable local Node fixtures. It covers fractional boundaries, older
and genuine siblings, unordered multi-hop ancestry, PID generations, reparenting, malformed and
missing identities, coarse clocks, cycles, overflow, query retirement and cancellation.

Passing local checks provides no Windows PTY or native qualification, historical cleanup proof or
release authority. Existing preparation/workflow/time/disk/security/approval limits are unchanged.
Future source/runtime/request bindings require separate review and preparation; no existing sealed
request is updated by this repair.

Candidate 44's independent review demonstrated the missing-parent cleanup gap with shipped sampler
and startup-controller injections. Those controls and candidate 44 remain frozen. The successor adds
direct absent/reused parent, tracked intermediate, late mixed multi-hop, unknown birth,
cancellation/expiry and real disposable marker regressions. These are local failure controls; they
do not reconstruct a historical Windows parent chain or prove historical release.

## Complete-table discovery order

The next local successor resolves all currently provable owned parent generations in the complete
admitted table before latching remembered-parent uncertainty. A reused parent can itself be a
legitimate new child of an owned root. Its descendants must not be held or classified as ambient
only because their rows precede that parent in the table. The discovery loop adds exact generation
identities to a fixed point, then evaluates unresolved edges and unowned-replacement exclusions.
This is the same admitted table and clock budget; no additional OS query or retry is introduced.
Each productive pass adds an identity under the existing 256-identity bound. A no-growth pass and a
final unresolved-edge pass finish the decision. Any remaining plausible unexplained ancestry still
fails sticky before a positive census is returned. Equal and macOS local/coarse births remain
conservative, and genuine live descendants still prevent startup join.

Permutation regressions cover equal Windows/Linux births, later Windows births, macOS equal/later
local births, multiple reused intermediates and reparenting. Shipped periodic startup observations
must give the same held/join outcome for parent-first and grandchild-first orders, including both
all-owned-processes-gone and genuine-surviving-descendant controls. Candidate 45 and its independent
row-order controls remain immutable evidence; passing these local permutations does not establish
historical PID reuse or release.
