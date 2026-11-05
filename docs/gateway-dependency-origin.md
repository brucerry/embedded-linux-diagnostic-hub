# Final Gateway dependency bytes and remaining loader gap

This is source preparation on candidate 275. No package was fetched, installed, extracted, imported
or executed. Tests use authored gzip/USTAR buffers, recording filesystems and fake child events. All
207 shipping production files remain identical to `96a56cdbb462320c54fe74022d7436e665a31d31`.

## Concrete architecture

The prepared Gateway build record fixes source commit/tree, source lock, prepared lock and tar
hashes. Its build command bundles `gateway/main.ts` as CommonJS with `--external:ssh2`.
`backend/ssh/session.ts` imports `Client` from `ssh2`, so the final Node process still needs actual
installed packages. The selected frozen source lock requires ssh2, asn1, bcrypt-pbkdf, safer-buffer
and tweetnacl; cpu-features/nan are optional. The package has no node_modules and its instructions
say `npm ci --omit=optional --ignore-scripts`. These statements describe source and intended
installation, not an observed installed or loaded dependency graph.

Candidate 275 independently reads installation files but its name/version agreement cannot detect
changed JS with unchanged package.json. This revision adds `observeDependencyOrigin(archives)` after
the adapter's acknowledged installation census and before child observation. It accepts only
retained raw archive buffers identified by required lock resolution paths. It accepts neither caller
inventories nor a claimed install/loader receipt. The existing prepared-lock validation still binds
resolutions to separately supplied frozen source-lock bytes.

The new pure byte inspector checks the exact canonical SHA-512 SRI against compressed bytes before
decoding. The current frozen closure uses SHA-512; other algorithms and multi-digests fail closed.
It derives every regular file's size/hash from the authenticated archive bytes, strips only the
literal `package/` namespace and maps to the exact required lock path. The observer compares this
complete derived set to its internal independently read dependency census. Missing, changed or extra
files fail, even when package names/versions still agree. Caller mutation of returned census or
origin objects cannot replace internal state. The existing second census after child closure still
rejects changed bytes or file identity. No origin claim is emitted after a failed comparison.

Only `node_modules/.package-lock.json`, an installer-generated metadata file, is outside the
registry member comparison. If present, its exact observed bytes/hash/identity remain in the full
census and the origin record explicitly lists it as excluded installer metadata. This does not claim
that arbitrary data outside the archives has no possible runtime influence.

The package parser supports a bounded uncompressed POSIX USTAR file/directory profile inside a
single gzip member with no optional gzip headers. Directories may be explicit or implicit; USTAR
prefix names are supported. It rejects links, bundled node_modules, native addons, PAX/GNU/special
members, aliases/traversal, invalid padding/checksums/UTF-8, writable/setid modes and trailing data.
PAX or other legitimate unsupported package encodings must stop admission; no real package format
has been tested here. It never rewrites an unsupported archive or pretends it installed one.

Bounds are 128 archives, 16 MiB compressed per archive / 128 MiB total, 64 MiB expanded per archive
/ 256 MiB total, 4,096 entries per package and 4,096 regular files across the closure. Manifest
reads are capped at 1 MiB. These are observer admission limits, not disk quotas or a measured
heap/CPU policy. Decompression uses the existing admitted synchronous codec pattern, bounds output
before decode, verifies full compressed-span consumption, length and CRC; no codec stream/process is
owned.

The returned origin is tied to exact source context, Gateway tar/build-record/source/prepared-lock
digests, package SRI/archive hashes, derived files and installation-census digest. It means the
observed installation matched those retained locked archive bytes. It does not authenticate a new
producer, npm service, service upload or release artifact beyond the separately admitted frozen
source/artifact boundary. Supplied bytes remain inputs requiring that separate custody/admission.

## What cannot be established without real observation

The shipped `gateway/main.ts` owns its server internally, receives normal shutdown through signals
and has no source-owned IPC loader report. The existing adapter sees parent-reported spawn identity
and direct-child events; it does not see which CommonJS modules V8 compiled, which executable the
kernel mapped, or whether an installed file was transiently substituted and restored between reads.
Neither the lock, a tar inventory, name/version metadata nor a successful census supplies those
missing observations. A source fixture's module hooks cannot qualify an unchanged final tar.

This revision deliberately adds no module preload/require hook, inspector/debug endpoint, target
import, process launcher, signal or environment/configuration reader. Therefore `loadedCodeObserved`
is always false and emitted loaded-dependency/kernel mapping fields remain null. Actual execution
would still need a separately admitted owned launch and a reviewed authoritative loader/OS observer
or an explicit immutable/trusted-installation threat model. Such a trust decision has not been
silently adopted. A real test must also supply retained package bytes; synthetic controls do not
establish which archive format, installer transformations or process behavior occurs in reality.

Descendants, all Gateway HTTP/SSH/console owners, configuration identity, normal shutdown, durable
parent closure, GC, reviewed policy and measured workloads/soak remain unproved. `releaseAcceptance`
stays false and the fail-closed release consumer, package/storage, spending and native/DUT holds are
unchanged. File-origin comparison is substantive evidence preparation, not runtime qualification.
