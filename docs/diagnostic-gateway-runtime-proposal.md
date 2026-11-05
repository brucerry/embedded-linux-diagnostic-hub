# Smallest next Gateway runtime diagnostic

Preparation only: no runtime, server, socket, installation, network request, push or CI dispatch
has occurred. This candidate adds one explicit-port HTTP observation helper and source-bound fake
tests. It adds no active workflow, default native ports or shipping/debug endpoint. A complete
native install/start/shutdown driver remains to be implemented and reviewed before execution.

## Exact source and archive boundary

Base tooling/source is f841eef7b174d07c74d39a346da3138ac83fe130, tree
1c67b4f64241270b24c4a9ed1d7904a80d2504c1. Shipping roots remain byte-identical to
96a56cdbb462320c54fe74022d7436e665a31d31. Freeze this derivative's exact commit/tree and
all source/tool controls before any future job; earlier receipts do not test that derivative.

The prior original job 41986532147/attempt 1/job 127108460826 built and same-run-inspected
validation/gateway-diagnostic/artifacts/Diagnostic-Hub-Gateway-0.6.0.tar.gz, 54,765 bytes,
SHA256 2c715d6a34949b9b8383646909fcca3f19330f4f264efd659f43e3efff94ebd4. It was neither
uploaded nor downloaded, so its bytes cannot now be consumed from that service run. Do not invent
an artifact ID or obtain a different tar under its receipt.

The minimal no-upload path is one new same-run build plus runtime job. Rebuild through the reviewed
bounded Gateway producer, validate the new actual record/checksum/tar and bind the runtime to those
exact bytes. A rebuild is not reuse of the historical archive; record its actual new hashes even
if deterministic payloads happen to match. This is a candidate archive produced from unchanged
shipping code, not an assertion that a published release artifact exists. The legacy shipping
package:gateway script uses a different staging/lock/archive route and must not be silently run or
claimed equivalent. Published-artifact acceptance would need its own admitted readback.

## Real behavior proposed

Use the already strict openGatewayArchiveBytes member snapshots to populate one new owned
installation directory. Write only the eight admitted regular files and three directories,
exclusively; reject links, aliases, existing work and unsupported metadata. Do not shell-extract an
unchecked archive or alter existing permissions. Keep the source/build cache separate from this
runtime install. Compare all payload bytes to the admitted tar before and after execution through
the existing createFinalGatewayObserver installation census.

Install only the prepared lock's required closure with the selected Node/npm. Use npm ci with
--omit=optional --ignore-scripts --no-audit --no-fund --fetch-retries=0, explicit new owned
cache/prefix/empty user/global configs, no workspaces/global install, registry.npmjs.org, no
ambient npm/runtime/proxy credential overrides. This runtime install is online: the new cache
cannot be assumed populated by the build. Source lock currently selects ssh2 1.17.0, asn1 0.2.6,
bcrypt-pbkdf 1.0.2, safer-buffer 2.1.2 and tweetnacl 0.14.5. Omit cpu-features/nan and all native
addons; no lifecycle scripts, native compilation or optional fallback. Verify the actual prepared
lock again rather than substitute these textual versions. Stop on incompatible package formats,
links, optional/extraneous files, unsafe permissions or installed census failures; never chmod them.
Npm SRI checking and observed installed files do not establish independent loaded-code provenance.

Launch exactly selected-Node /new-owned-install/dist-gateway/main.cjs with cwd at that install,
stdin ignored and bounded piped stdout/stderr. No npm start, --env-file, preload, inspector,
NODE_OPTIONS or real .env/credential file. The complete child environment contains only selected
PATH/locale/TZ/NODE_ENV and these synthetic HUB fields:

- HUB_GATEWAY_HOST=127.0.0.1; HUB_GATEWAY_PORT=58731.
- A new cryptographically random 32-byte token encoded as 64 lowercase hex characters, never
  printed, uploaded or included in the receipt.
- HUB_ALLOWED_ORIGINS=http://127.0.0.1.
- HUB_TARGETS_JSON contains one dummy target: host 127.0.0.1, port 1, fingerprint SHA256: followed
  by 43 A characters. It satisfies configuration shape only; it is never contacted or trusted
  as a real host key. No sessions/fingerprint/automation/terminal route is called.

The shipped CLI requires a nonzero port and provides no inherited-listener option. Use one fixed
high loopback port and one launch, never a release/reserve/rebind loop or automatic port retry.
Wait at most 10 seconds for actual child spawn and its exact configured listening line before any
HTTP request. A bind error or collision fails the experiment; never probe an already present
listener. Stdout readiness plus selected child/bytes relies on a trusted disposable runner without
malicious same-user mutation. It is not an independent kernel endpoint-to-PID attestation and does
not defend against a malicious peer that can read the synthetic environment or forge output.

Then issue exactly three sequential GET /api/health requests to literal IPv4 127.0.0.1:58731:

1. Correct synthetic Origin/Bearer: 200; exact JSON version 0.6.0, activeSessions 0 and
   connectionCancellation true, plus actual JSON/no-store/nosniff and allowed-origin headers.
2. Correct Origin, no token: 401.
3. Disallowed synthetic Origin http://127.0.0.2, correct token: 403 and no allowed-origin header.

The origin is a header, not an outbound destination. There are no redirects, DNS lookups, SSH
connections, browser processes, device traffic, downloads or user exports in the runtime segment.
The HTTP helper fixes method/path/IPv4/agent:false/Connection:close, caps headers at 8 KiB and each
body at 4 KiB/128 chunks, and permits 2 seconds per complete request lifecycle. It consumes actual
ClientRequest, response and socket events; completion requires request finish/close, response
end/complete/close, connected loopback peer and socket close. HTTP result settlement alone is not
retirement. Body/header/status failures remain failures after acknowledged resource retirement.
Pending, timed-out or unsupported port/observer cleanup stays held. No raw body, URL, token, target
identifier, native error or transcript is emitted. The helper has no native defaults or destruction,
retry, signal or endpoint-selection escape. Fake-port passes are not real HTTP qualification.

## Shutdown, limits and evidence

After checks, request exactly one SIGTERM through the directly owned ChildProcess object to invoke
the shipped CLI's documented normal close handler. This is a new, narrow normal-shutdown signal
scope, not permission to kill a process tree, unrelated PID or watchdog. A true kill() return only
acknowledges the request. Require actual exit code 0/signal null, child close and both stream closes,
all HTTP owners retired, stable post-run installation census and detached observers. Do not infer
normal shutdown from PID absence, listener disappearance or a resolved RPC. No SIGKILL/escalation,
retry, forced exit, recursive removal or deletion of existing data is proposed. If the behavioral
check fails after launch, the same once-only normal-close request may retire the owned child while
the original failed outcome remains failed. Unknown close/IO retains custody and stops the job.

Suggested whole runtime acceptance budget: 45 seconds including startup, three requests, at most
10 seconds for normal shutdown and final observation reserve. Stdout/stderr at most 64 KiB each
and 1,024 chunks each; raw output is not logged. Install gets 3 minutes; build retains 8 minutes
and offline lock 2 minutes. The complete proposed standard public ubuntu-24.04 job remains capped
at 20 minutes, one worker/job, original attempt only, no automatic retry. Use available-runner
admission checks, no larger runner or paid upgrade. Read/archive/output limits are not disk or heap
quotas. Timeout/cancellation may rely on disposable runner teardown; it does not prove graceful
whole-group retirement and cannot convert failure into a pass.

Reuse official pinned setup/checkout and source guards, then bind source/tree, Node/main/lock/tar
hashes, before/after installation digest, original service run/job/attempt and sanitized request
statuses/counters/closure flags into a receipt at most 16 KiB. No Actions artifact/cache upload;
no built tar or dependency cache retention. Only the original job's log receipt is retrieved.
Log retention follows repository policy, potentially 90 days; total log size is only checked after
retrieval. Standard public Ubuntu compute is the intended free tier, not a billing API guarantee;
fresh public/access/trigger/action/cost checks and the unchanged $0 block still apply. Stop on any
service block, failure, timeout, missing evidence, uncertainty or unapproved cost. No probe push.

## Split observer and actual blockers

This minimum tests unchanged CLI behavior only. Do not link the private instrumented entry into
the tar, enable debug ports or claim the HTTP helper observes internal ownership. The approved
separate instrumented build can later use prepareInstrumentedGateway with an in-process inspector,
exact independent instrumented artifact/source binding and its own resource-counter close receipts.
That entry has no default CLI and its bootstrap/compiler/source-format wiring is still unrun.
Its counters can qualify only the separate instrumented build, never the unchanged CLI by transfer.

Neither route proves authoritative whole-process-group normal retirement, kernel executable mapping,
all loaded dependency code, exhaustive Gateway ownership, calibrated memory/performance/GC or soak.
The managed platform still lacks a supported independent normal-group retirement receipt; GitHub
job success/teardown and direct Node closure do not supply it. Full release acceptance stays false.
This diagnostic can be developed under the explicitly stated teardown exception, without weakening
the strict release gate. No additional platform capability is needed to prepare it, but user consent
cannot manufacture the missing release-grade observation.

Remaining implementation before a run: reviewed owned extraction/install driver; exact native
CLI acquisition/readiness and once-only normal-SIGTERM controller; bind the existing final-byte
observer and this HTTP helper; fake lifecycle/failure controls and exact source/trigger pinning.
There is no execution-ready workflow in this candidate.

Smallest next decision: permit development and one new same-run Gateway build/install/loopback
health/auth/normal-shutdown diagnostic with these effects, official required dependency downloads,
one owned SIGTERM and runner teardown fallback, no artifact/cache upload and bounded log retrieval.
The completed one-job archive-build approval did not authorize a runtime/listener or shutdown signal.
Package/storage, $0 spending, native/DUT and release holds remain unchanged. Real-device acceptance
ordering is not moved earlier by this proposal.
