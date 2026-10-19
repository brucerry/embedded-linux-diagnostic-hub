# Corrected native Windows wizard UX

Private source d0cbd47f7f0676b01c82accdc643c81d1cf91c2d, actual version 0.5.2, combined target
v0.6.0. Setup SHA256 6d1c96c660c732eca52e2556658429b0b62526a1899ffd1196710b2421557526, ASAR
c50a37585b937e18d91eb6b05a4e5bbb103a560d01edb47bd325a275d482fd17; /WX exit 0, zero warnings, all 101
payload files reverified. Runtime source/files are unchanged from 4221cab except the NSIS layout;
runtime-equivalence.json records the exact one-file delta.

Six final presentation-only cases pass: fresh install review, same-version Open/Repair, older
Open/Update, recovery Open/Confirm/Recover, interrupted-removal Remove, and actual unowned-folder
refusal. All seven action labels/effects/final captions were captured and visually inspected. Each
direct Review control fits its actual native page; readonly path values/styles and complete native
Select All are verified. Every action returns through Back with its exact selected label retained
and Next restored. Normal fresh launch checkbox is enabled/off without NOLAUNCH; no normal
application launch is claimed. All cases cancel normally, no final operation is invoked, synthetic
fixture bytes remain unchanged and no owned setup process remains.

Raw screenshots/UIA/INIs and case results are indexed in wizard-ux-native-review.json. An earlier
overlapping capture was refused and cancelled normally; it is retained and excluded. Final Back
cases ran strictly sequentially. PrintWindow images missing child labels are superseded and never
used as final visual evidence.

Maintenance fixtures contain non-executable plaintext sentinel bytes. These prove
presentation/probe/back/cancel only, not native installation, repair, update, recovery, removal or
integration behavior. Normal profile directory names/count remain unchanged; personal profile
contents were not inspected or proven unchanged. Actual native install/launch remains blocked by the
repeated automatic action-review rejection; no additional attempt or alternate route occurred.

Dedicated requested regression: incomplete-identity-regression.json/patch and
incomplete-identity-regression-tests.log; one focused test covers all six partial
record/manifest/owner subsets with actionable refusal, exact file-byte retention, no integrations,
appData or sibling maintenance creation. Product runtime source is unchanged.
