# Tasks

## 1. Bundle and shared qualification

- [x] 1.1 Record official runner/storage/draft-privacy evidence and implement new-tag/source/draft guards; verify mocked API failures and anonymous draft denial without touching existing releases.
- [x] 1.2 Produce complete architecture ZIPs, sidecars and source/version/minimum-OS/ASAR/signature manifests; verify archive extraction, links, native architecture, codesign and source equality on both native Mac runners.
- [x] 1.3 Share the existing Mac build/qualification steps between read-only main and release jobs; verify all original browser/SSH/clock/reset/trust/native assertions, deadlines and 100 cycles remain executed.

## 2. Mac installer and launcher

- [x] 2.1 Implement Bash 3.2/native-tool platform, architecture (including translated-terminal), safe tag and OS selection; verify supported, unsupported and mismatched metadata controls before installation.
- [x] 2.2 Verify same-release checksum/manifest/bundle identity/architecture/signature/ASAR and preflight archive roots/links; verify corrupt, incomplete, unsafe and mismatched inputs never replace or launch an app.
- [x] 2.3 Implement private same-volume staging and replacement/rollback with paths containing spaces and running-app refusal; verify failed/interrupted install preserves the prior app and user-data paths.
- [x] 2.4 Implement normal launch, no-launch and manual update options without elevation, quarantine removal or Gatekeeper changes; verify launch/refusal/update controls and actual installed-bundle smoke in both native architectures.

## 3. Delivery and documentation

- [x] 3.1 Integrate Mac draft uploads/downloads and complete-asset validation into the existing release workflow; verify draft/source/privacy guards and that publication depends on every required platform gate.
- [x] 3.2 Add dependent published-command checks on both free native Mac runners without new Mac Actions artifacts/caches; verify the actual release helper/ZIP/manifests and launched app via source/architecture/CDP evidence.
- [x] 3.3 Prepare v0.4.0 version and coordinated README Get started, download commands/platform table, Mac installation/troubleshooting and release/delivery notes; verify links, actual filenames, manual updates and ad-hoc/notarization/managed-device limitations agree.

## 4. Exact-source acceptance and closeout

- [x] 4.1 Pass local public-source format, type/build/unit/browser and strict OpenSpec checks; verify original user payloads and only scoped public edits before committing.
- [x] 4.2 Push scoped source and qualify all exact-source main jobs across Windows, Linux/seven GNOME, both Mac architectures and website; diagnose actual failures before any corrective push.
- [x] 4.3 Create a new v0.4.0 tag only after qualification and pass all tag gates before publishing the complete release; independently verify all 24 expected assets/digests/sidecars/four manifests, generated notes since published v0.3.1 and latest metadata.
- [x] 4.4 Verify the published one-line command end to end in both available hosted Mac environments and report CI evidence separately from quarantined-browser/physical-Mac limits; preserve v0.3.1/v0.3.0/v0.2.0 metadata/assets/tags.
- [x] 4.5 Sync and archive the completed private change after canonical semantic comparison and strict validation; verify all prior specs, Git exclusion and the separate live.spec.ts user edit remain preserved.
