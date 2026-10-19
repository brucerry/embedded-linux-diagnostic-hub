## MODIFIED Requirements

### Requirement: Explicit manual installation and launch

The documented one-line command SHALL download, verify and install the complete app in a user-owned
location and request a normal macOS launch. Future guided mode SHALL present native or terminal
review choices for location, existing installation maintenance and launch before explicit
installation confirmation, retaining compatible version/directory/no-launch options and immutable
historical helper behavior. The helper SHALL support installation without launch and explicit
version/directory selection. An already-running app SHALL not be replaced. Mac in-app automatic
update installation SHALL remain explicitly unsupported; manual updates and repair SHALL use the
same verification and replacement safeguards. Missing graphical/terminal approval surfaces SHALL
fail clearly without hanging or installing automatically. Installation SHALL preserve existing user
data and truthful ad-hoc/non-notarized policy.

#### Scenario: Running app or manual update

- **WHEN** a user attempts a replacement while the app is running
- **THEN** the helper asks the user to quit and preserves the current installation

#### Scenario: Launch refusal

- **WHEN** macOS refuses launch
- **THEN** the helper reports the refusal, preserves/restores the prior app when applicable, and
  points to explicit user/administrator approval without bypassing protections

#### Scenario: Guided manual setup review

- **WHEN** a supported Intel or Apple Silicon user invokes guided setup
- **THEN** they can review the actual user-owned bundle destination and launch choice before
  confirming installation or cancelling without app/profile changes

#### Scenario: Guided setup cannot request approval

- **WHEN** normal native dialogs are unavailable or denied and no controlling terminal is available
- **THEN** setup stops with explicit download/manual alternatives and does not infer approval from
  piped input
