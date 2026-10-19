# board-test-execution Specification

## Purpose

Execute reusable board tests through the connected device with bounded resource use, separate
evidence, repeatable sequences, and verdicts that reflect the observations actually obtained.

## Requirements

### Requirement: Retired Tests entry points

Both editions SHALL omit Tests navigation, setup/JSON/simulation/run controls and test report entry
points. Desktop SHALL register/expose no test execution IPC handlers or bridge methods; gateway
SHALL provide no active testing routes. Direct attempts to use retired endpoints SHALL fail without
discovery or adapter execution. The automated development test suite SHALL remain available and
cover absence of these paths and surviving functions.

#### Scenario: Invoke a retired discovery operation

- **WHEN** a client directly requests a retired Tests discovery endpoint
- **THEN** it is rejected without parsing DT properties or sending an SSH test command
