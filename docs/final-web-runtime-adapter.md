# Exact web archive host and public startup adapter

This adds source for a real runtime path without rebuilding or instrumenting the shipped app. It has
not been executed against an actual archive, HTTP listener or browser. Unit fixtures contain
synthetic ZIP bytes and fake HTTP/Page objects; their passes do not qualify the shipping artifact.
No CLI/workflow invokes this path and no release consumer is relaxed.

`createFinalWebHost` validates the selected shipping web build record and uses the existing strict
ZIP inspector. Every member is checked before exposure. The host retains copied member bytes in
memory, serves exactly those copies under one explicit loopback prefix, and performs no extraction,
HTML/JS rewriting, private-script installation, API proxy or source build. Unknown paths do not fall
back to the app. Requests are GET/HEAD only; normalized/encoded traversal and aliases fail. Workers
use their actual archive bodies and JavaScript MIME type. Host construction does not listen;
`listen()` explicitly allocates an ephemeral 127.0.0.1 listener. Normal close waits for bind,
server, response and socket acknowledgements; no destruction, signals or timeout recovery is added.
Failed close retains the host and cannot silently retry. A successful host close releases its
member-byte references, not a claim of garbage collection.

`observeFinalWebStartup` consumes that issued host and an already-owned Page at about:blank. It
navigates using the public SDK, hashes the navigation document and observed same-host resource
bodies against archive inventory, then waits for the existing Connect target device and Device time
controls. It installs response/error observers only; no init scripts, fake product globals, routes,
GC hooks, CDP or app/module transforms. Body reservations are made before asynchronous body reads;
default observation bounds are 4,096 response objects and 256 MiB declared aggregate bodies. An
explicit profile can only tighten them and is emitted in the record, with failures rather than
truncation. The public SDK body API still buffers its response; these reservations assume the issued
immutable host supplies its declared bytes, not a hostile/intercepted SDK transport. An unexpected
body size/hash fails, without claiming prevention of an SDK's prior allocation. Parser/member and
observer caps are not a host/kernel/SDK heap quota; an execution owner must separately constrain
requests/concurrency and admit server/browser memory. Hostile local peers are not qualified by this
adapter.

A Page at about:blank does not prove a clean profile/context: routes, init scripts or service
workers installed by its owner remain outside this adapter's proof. Production-source identities
come from the selected build record; browser engine/version are SDK-reported. Neither is an
independently mapped executable/loader observation. A future executor must admit that exact
environment and source/artifact provenance separately. No same-user hostile mutation immunity is
promised.

The function returns a canonical UTF-8 JSONL record, exact bytes and SHA256 to its owning caller.
There is no disk write, upload, attestation or fabricated persistence acknowledgement. Failure
retains a custody snapshot/join for the observer's pending body reads; caller retains Page/browser
and process ownership throughout. Callback detachment and body-read joins cover this observation
only. They are not browser/process retirement. Observation failure produces no success record.
Durable emission still requires a separately owned exclusive writer and readback; it must preserve
primary failure and unresolved publication/cleanup rather than retry automatically.

## Evidence and integration boundaries

| Area                | Implemented here                                                                                               | Still unsupported or separate                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final bytes         | Strict archive/member census, immutable memory copies, unchanged HTTP bodies, observed browser response hashes | Authenticated service/attestation readback and exact future artifact admission; build record names/claims alone do not authenticate source                                 |
| Public UI           | Two visible startup controls, response/error observation on actual supplied Page                               | Automation, import/export, terminal and retention workloads are not run by this case                                                                                       |
| Private hooks       | No instrumentation added by this adapter                                                                       | Existing aggregate workloads depend on memoryProduct, constructor ledgers, injected Serial and replaced workers; they cannot be reclassified as shipping-byte observations |
| Chromium            | Common public Page API startup path prepared                                                                   | Executable identity, sandbox/endpoint ownership, process sampling, forced GC and normal retirement are not supplied                                                        |
| Firefox/WebKit      | Same public Page startup interface, tested with fake reported engines only                                     | No real engine run; existing full aggregate adapter blocks both; forced-GC/worker/visibility/resource semantics remain unimplemented                                       |
| Gateway             | No fake API route or source-import shortcut                                                                    | Final tar/dependency/loader custody and a genuine dist-gateway/main.cjs owner; public API facts cannot replace private source ownership hooks                              |
| Policy/runtime/soak | Selected source/archive and caller context are explicitly distinguished from reported engine/version           | Authoritative per-GC policy/calibration, exact loader/runtime, full measured workload/30 minutes / 100 cycles semantics and durable parent closure                         |
| Release             | Every observation retains releaseAcceptance:false and null missing measurements                                | Staged publication consumer remains unconditionally blocked; synthetic/instrumented results cannot close it                                                                |

The existing browser harness rebuilds instrumented Vite entries and substitutes HTML/workers; its
Gateway host forks TypeScript fixtures importing source. Targeted searches of the current checkpoint
and relevant runtime/producer refs found no reusable exact-archive host, so this primitive is new.
This is a bounded inspection finding, not an exhaustive repository audit.

All package/storage, spending, native/DUT and release holds remain. No runtime execution or remote
upload is part of this change. Later execution needs exact admitted final artifact and fresh owned
browser/profile/listener custody, resource limits and normal cleanup scope. Approval alone does not
supply unsupported native observations or authoritative release-gate schemas/producers.
