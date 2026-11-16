# Native selected-source Gateway bootstrap

`node scripts/build-gateway-tag-archive.mjs` is a real native entrypoint for the current release-tag
job shape. Import is inert. The native path reads its actual process/event/tool/filesystem
observations and calls the independent source selector, matches the selected source/tree to local
raw Git, then invokes the canonical producer and strict original-record/archive/checksum readback.
It does not upload, install or launch the Gateway, connect SSH, or activate a workflow.

The independent selector uses only public GETs on fixed `api.github.com` Git reference,
annotated-tag and commit endpoints for this repository. It follows locally constructed hash paths,
never response URLs. Ref snapshots bracket up to eight tag-object reads plus the canonical
commit/tree read: at most eleven GETs. A branch uses three. It reuses the existing HTTPS owner,
exact API version, TLS, wire-size/JSON bounds and request/response/socket retirement. No credential
is read. Unsupported proxy/custom-CA configurations fail closed without a direct-route fallback or
settings change. Public rate limits or unavailable metadata stop the operation without retry.

The selector is independent of local Git and the package under check. It pins the current advertised
ref snapshot before building. That is not proof of the annotated object which triggered an earlier
event. Tag mode additionally bounds the push `after` value to the independently selected ref object
or canonical commit; it does not infer annotation-event authentication. Such authority stays null,
as do numeric-job/upload attribution and release acceptance.

A separate tag execution factory shares the existing fixed command/Git/file owner body. The original
branch validator and legacy branch CLI stay unchanged. Native artifact readback retains the existing
UID, mode, inode, alias and descriptor checks. The canonical build and offline lock commands,
deadlines and uncertain custody behavior remain the existing ones. Errors retain outputs and owners;
there is no process termination, automatic retry or stage cleanup.

The native bootstrap retains the original independent selection and bounded HTTP witnesses alongside
the original producer-record identity in `validation/gateway-source-binding.json`. It is exclusively
written and reread; raw response bodies, tag messages, authors, response URLs and credentials are
not included. The canonical artifacts directory still contains the original record, archive and
checksum. This supplemental local record is nonqualifying and does not replace service/upload
provenance or add a release admission mechanism.

## No-tag branch qualification

`node scripts/build-gateway-tag-archive.mjs --qualify-branch` uses the real branch event and the
unchanged branch context policy. It queries that exact branch, selects its actual commit/tree, and
executes the same native host/selector/owner and producer/readback implementation. It never
fabricates a tag or changes `GITHUB_*`. Its result reports branch coverage, not a tag-event
qualification.

The contents-read/no-upload CI draft must remain local until review and action-time preflight. Use a
clean public-base overlay, one exact new branch-push Ubuntu job, pinned checkout/Node, locked tools
with lifecycle scripts disabled, and the explicit branch command. No runtime installation,
upload/cache-save, tag, publication or permission increase belongs in that job. Actual tag-event
behavior and real hosted TLS/tool/filesystem execution remain unobserved until the corresponding
genuine execution; memory fixtures do not establish them.

The model export runs the same selector and bootstrap algorithms through explicit fake
HTTPS/FS/Git/compiler ports. It does not mutate the real process environment, use the native
entrypoint to bypass its guards, or grant a native capability. Normal archive controls remain
unchanged. All existing runtime/GC/installer, service-reader and publication barriers stay closed
where evidence is absent.

API contract references:

- [Exact Git reference](https://docs.github.com/en/rest/git/refs#get-a-reference)
- [Annotated tag object](https://docs.github.com/en/rest/git/tags#get-a-tag)
- [Commit/tree object](https://docs.github.com/en/rest/git/commits#get-a-commit-object)
