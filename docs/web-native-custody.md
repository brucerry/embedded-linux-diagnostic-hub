# Web native IO preparation and external retirement boundary

The original candidate 280 preparation executed no Git/build child, file destination, package,
server, workflow or permission change. The separately approved diagnostic-only executor is described
in diagnostic-web-execution.md; it does not supply the independent retirement primitive below.
The actual CLI now requires an in-memory source-owned capability before parsing native inputs or
reading environment/filesystem state. Serialized objects and the inactive template cannot grant it.
Default command-line invocation has no capability and fails through the caught boundary. No active
workflow, shipped product or release gate changed; execution/storage/$0/security holds persist.

`createOwnedWebCapabilities` has explicit filesystem, launcher, clock and timer ports, no native
defaults. It copies an exact PATH/LANG/LC_ALL/TZ selection and constructs complete Git/build child
environments with fixed overlays. There is no ambient spread, credential propagation, HOME override
or fallback. Complete build-environment SHA256 is in Vite custody; the combined profile digest is
available separately. This is a proposed deterministic profile, not approval or authentication of
all installed tools/OS/filesystem inputs. Toolchain fallback configuration still needs admission.

The web path opts into async `localSourceProvider`; other callers retain the old sync default. Fixed
read-only Git argv is enforced, including the intended literal-dot configuration query. Git's
selected on-disk SHA256 is checked through owned descriptors before and after each command. This is
not kernel executable mapping or protection from malicious same-user swap/restore. Existing
command-local fsmonitor/untracked-cache flags remain read-only profile selections, not a security
grant. The unnecessary hook-path override was removed before diagnostic execution; no hook or
Git setting is changed. The supported commands do not invoke hooks.

The Git owner registers child, timer, listeners and batch input before dispatch. Input needs write
callback acknowledgement and close; success also needs finish. Normal child/pipe closures precede
observer removal. A 30-second observation expiry rejects without signals; later known closure may
retire those handles but cannot turn failure into success. Only the config query's normal code-one,
empty-output result is interpreted as missing. Output bounds are 136 MiB stdout / 1 MiB stderr,
4,096 chunks per stream and 4 KiB input. They are not measured heap/CPU limits or job billing
ceilings.

The file owner registers open/opendir before await and holds unknown/rejected acquisitions/closes.
Reads use no-follow/nonblocking final-file opens, explicit directory handles and acknowledged close.
Existing stable readers retain byte/metadata checks. Creation validates a canonical nonsymlink
parent before mutation. It rejects static aliases, not hostile rename/restore races: a
trusted-parent or identity-preserving workspace remains necessary. Exclusive publication handles
partial writes, file stat/sync/close and parent stat/sync/close. It never overwrites, deletes,
chmods or retries. Primary errors survive secondary cleanup failures; uncertain namespace/descriptor
custody prevents settled success. Sync acknowledgements do not promise crash durability or
storage-medium behavior.

## Minimum external OS primitive and decision

The parent needs a service-owned containment identity before launch, atomic launch into that scope,
and authoritative proof that the entire scope is empty after normal root-child exit and stream
closure. On Linux a correctly delegated cgroup v2 with stable identity, enforced membership/no
escape and `cgroup.events` populated=0 can provide this boundary. The supervisor must distinguish
normal closure from forced teardown and retain custody when observations fail or are unavailable.
PID/PGID polling, kill(pid,0), child-self-reported counters and direct-child close cannot
substitute. A synthetic cgroup record does not establish the real primitive.

Read-only metadata in assessment277 showed cgroup v2 mounted read-only, with no delegated owned
child scope. No admitted pidfd/group-owner adapter is established here; this is not a claim that
Linux lacks the facilities. A future user decision must cover provisioning/admitting that isolated
supervisor scope, the explicit child profile and Git flags, and bounded failure/timeout teardown and
costs. No such permission, provisioning or budget change is performed in this preparation.

Real tool compatibility, source/build/service binding, file durability/readback, process-group
retirement, packages and runtime/GC qualification remain unrun. The new capsule supplies local
observations only and always reports processGroupRetirement:null. Release acceptance stays blocked.
