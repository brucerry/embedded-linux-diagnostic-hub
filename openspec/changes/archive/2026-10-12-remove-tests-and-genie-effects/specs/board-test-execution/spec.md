# Spec Delta

## REMOVED Requirements

### Requirement: Shared functional testing workspace

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Direct JSON engineering workflow

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Authenticated isolated bounded execution

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Resource coordination and lifecycle recovery

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Honest results and cancellation

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: LED pattern adapter with physical verification

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: UART fixture loopback adapter

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Approved I2C identity adapter

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

### Requirement: Clearly separate simulation

**Reason**: Bruce retired Tests and app-owned Genie behavior in remove-tests-and-genie-effects.
**Migration**: Use the surviving diagnostic/terminal workspace and standard platform windows; preserve existing files and historical evidence.

## ADDED Requirements

### Requirement: Retired Tests entry points

Both editions SHALL omit Tests navigation, setup/JSON/simulation/run controls and test report entry points. Desktop SHALL register/expose no test execution IPC handlers or bridge methods; gateway SHALL provide no active testing routes. Direct attempts to use retired endpoints SHALL fail without discovery or adapter execution. The automated development test suite SHALL remain available and cover absence of these paths and surviving functions.

#### Scenario: Invoke a retired discovery operation

- **WHEN** a client directly requests a retired Tests discovery endpoint
- **THEN** it is rejected without parsing DT properties or sending an SSH test command
