# Non-shipping Gateway ownership build

This source implements the approved split: an instrumented ownership build is separate from the
unmodified shipped Gateway CLI's behavior/performance/GC qualification. It does not change any
shipping source, package command, workflow, permission, runtime admission or release consumer. No
real build, inspector, Gateway, socket, process, package or device ran during preparation.

`tests/fixtures/instrumented-gateway-entry.ts` is a separate build entry. Importing it does not
connect an inspector, construct a Gateway or listen. It exports `prepareInstrumentedGateway`, which
uses the actual `createGateway` factory and a privately owned `inspector.Session`. Actual activation
requires an explicit `start(config)` call. It refuses an already listening inspector and never calls
`inspector.open`, creates a TCP debug endpoint, launches a process or reads a real
environment/configuration file. An explicitly requested `listen(port)` binds only 127.0.0.1; this is
the Gateway service, not an inspector listener. No such calls were executed here.

The collector subscribes before connecting/enabling the debugger. It reads actual
`Debugger.getScriptSource` responses, comparing exact text with copied, strictly decoded admitted
source bytes. URLs and inspector-provided hash fields are insufficient. Unknown file scripts,
sourceURL/live-edit aliases, duplicate identities, unsupported CommonJS wrapper/source transforms,
missing entry observations, callback errors and overflows fail. Node builtin script notifications
are counted separately and **not authenticated**. Parsed text is compilation evidence, not proof
that every function executed or that a particular source URL could not be forged by malicious
same-isolate code. The observer and Node inspector are trusted harness components in the observed
isolate; this is not isolation from malicious code in that isolate.

Selection records source commit/tree, instrumented artifact path/hash and observer hash. The
instrumented entry's actual returned script text must match the selected artifact. This does not by
itself prove which source was built, identify a service upload, map the kernel executable, or close
dependency provenance. `buildProvenanceVerified` remains false. A future bounded producer must
independently bind reviewed source/entry/build acknowledgement/readback before real admission. No
synthetic selection is promoted to build or release evidence.

Before every session acquisition, debugger request, product factory or server-listener operation,
the owner records custody. Unknown factory acquisition or missing/rejected callback/close/detach
remains visible. A post throw is not converted into acknowledged retirement. Close freezes product
admission, joins startup and any in-flight bind, awaits the actual product `close()`, validates its
actual zero ownership counters, detaches owned server listeners, drains debugger source callbacks,
awaits debugger-disable acknowledgement and disconnects only the owned in-process session. The first
error survives later cleanup diagnostics. There is no retry, forced disconnect of pending requests,
kill, signal, timeout-as-retirement or invented zero snapshot. Unsupported asynchronous returns from
APIs specified as synchronous latch unknown operation custody; later synchronous
removal/disconnection cannot silently retire a registration or connect still in flight.

Only numeric/boolean product counts and array lengths are retained, not tokens, targets, session
IDs, transcripts, script source or raw error text. Emission returns bounded canonical JSONL bytes
and a hash; durable writer/readback acknowledgement is still separate. Local product/observer
retirement can be acknowledged even when the experiment failed, while the failed outcome remains
visible. Product close rejection is never treated as proof that product resources retired.

Observer bounds: 512 admitted scripts / 64 MiB copied text total / 32 MiB per script, 2,048 script
notifications, 16 simultaneous inspector callbacks, 16 secondary diagnostics per owner and a 4 MiB
emitted record. These are admission bounds, not OS/heap/CPU quotas. An inspector response can
already be allocated by V8 before the callback validates it. Real Node source-format behavior,
callback ordering and instrumentation overhead remain untested.

`processGroupRetirement` is always null. Local zero counters and inspector disconnection do not
prove descendants, kernel handles, unref'd resources, real configuration policy, GC or a full soak.
Shipping CLI behavior/performance/GC fields stay null and `releaseAcceptance` stays false. No
inspector/object-count surrogate relaxes the external process-group retirement requirement.

Next concrete work is to build/readback this separate entry under an admitted bounded producer, then
characterize the pinned Node inspector with owned synthetic workloads and externally observed normal
child/group closure. The unchanged shipped CLI must receive its own exact-artifact behavior and
performance tests. Package/storage, spending, native/DUT and real-execution holds remain active.
