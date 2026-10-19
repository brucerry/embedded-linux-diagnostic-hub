# Windows setup release descriptor prerequisite

Three-file source-only increment: scripts/package-windows-setup.mts,
scripts/lib/windows-setup-release.mjs and tests/windows-setup-release.test.ts. Exact hashes and
incremental patch are in windows-setup-release-review.json/.patch. This is a prerequisite for the
still-unimplemented Windows setup helper verification, not that integration itself.

The packager now records <setup basename>.info.json alongside its SHA256 sidecar. The descriptor
binds schema/product/platform/architecture, producer-declared version/source commit, setup
basename/byte count/SHA256 and the SHA256 of the exact already-validated input payload-manifest
serialization. The writer streams and bounds actual setup bytes, rejects
nonregular/aliased/hardlinked output, checks file identity/size/times after hashing, validates a
caller-selected release identity and strictly limits metadata fields. It refuses pre-existing
setup/descriptor/checksum paths before compilation and uses exclusive sidecar creation. Existing
sidecars remain unchanged. These are build-output checks, not an installer filesystem sandbox or
publisher signature.

Six new descriptor/writer tests and five existing release tests pass (11/11, zero skips). They use
synthetic bytes that are never executable. Cases bind actual written checksums/metadata, reject
wrong source/version/asset/hash/length/architecture, unknown trust claims, unsafe filenames and
invalid sizes, preserve existing descriptor/checksum evidence before any other sidecar is created,
reject a hardlinked output, and refuse invalid identity before sidecar creation. Routine verify
initially caught a test-only assert.throws overload typing error; corrected predicate/message use
and retained the failure log. Final ordinary verification is recorded separately.

No NSIS source, application runtime, default helper, existing release catalogue, public download
URL, workflow or version changed in this increment. No NSIS setup compilation was run and no
existing private setup or release asset was modified. The earlier d0cbd47 compiler/UI receipt
remains evidence for that earlier private binary; it does not qualify native emission from this new
packager source. The descriptor is producer-declared provenance and checksum consistency; it cannot
itself prove that the native compiler embedded the expected manifest/runtime, authenticate a
publisher or qualify an installation. A frozen source build, native compiler output/extraction
verification and eventual helper/release integration remain required.

The precise remaining-scope matrix is v0.6.0-remaining-scope.md. Windows one-line setup
download/verification/options bridging and version-gated setup catalogue/build/upload/publication
integration are still unimplemented. Linux permanent complete-folder and managed AppImage
installation are also unimplemented; current portable helper mocks are not a substitute. Mac native
Bash 3.2/BSD stat/GUI/TTY/bundle/policy gates remain pending despite accepted source guards.

Local-only OpenSpec files were formatted at the parent's request without staging; ordinary
format:check now passes and existing exclusions remain. The user live-test edit, accepted Mac/Linux
source hashes, main-only revision and all historical release assets remain preserved. No
dependencies, permissions, paid services/runners/signing, physical ports, push or publication
occurred.

Windows install/launch remains automatically denied despite forwarded implementation approval.
Direct confirmation for that exact isolated action is requested and pending; no retry or alternate
route was attempted.

Latest ordinary npm run verify passes: 337 passed, zero failed, 12 platform skips (349 total), with
ordinary formatting and typecheck passing. Local-only OpenSpec formatting is now resolved without
staging or changing exclusion/configuration. Exact outcome: remaining-scope-checkpoint.json. Native
compiler/setup/platform gates remain pending, and the all-platform installer is not complete.
