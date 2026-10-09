# Board testing

Open **Tests → Manufactural tests** to prepare repeatable checks for a connected board. No device
agent is installed. Profiles declare what to exercise and what counts as success; the application
supplies the bounded execution commands. Test evidence is separate from diagnostic snapshots.

## Try without hardware

Turn **Simulation** on, use **Setup**, then choose **Validate & prepare tests**. Review the mappings
and check the exclusive-use acknowledgement before **Run selected tests**. Confirm, reject or leave
the LED observation unobserved when the run finishes. **Simulate UART loopback failure** produces a
mismatch; cancelling a run demonstrates incomplete evidence and skipped later cases. Imported
reports remain historical. Every simulated report is labeled and does not qualify physical hardware.

## Run on a device

Turn **Simulation** off to use the connected device. Simulation and connected-device settings are
kept separately: switching restores that source's own input mode, JSON, profile, editor, selected
tests, readiness, notices and results. Simulation JSON is never filled into the connected workspace.
The switch is unavailable during work or pending live operator observations; finish or dismiss those
observations before changing sources. If execution status cannot be confirmed after a lost reply,
disconnect to cancel backend work and review the device before continuing.

1. Connect over SSH and choose **Discover board**. This reads the live device tree, runtime
   resources, permissions and required tool capabilities. It does not scan buses or exercise
   interfaces.
2. Discovery automatically fills a fresh draft below the inventory, or you can import a
   [project profile](board-profiles.md). Later setup sections appear only after complete discovery.
   Review the board identity, logical mappings, expected outcomes, parameters and fixtures. Unknown
   intent stays incomplete.
3. Validate the profile, select a test or saved sequence, inspect the resolved paths and effects,
   and confirm [fixture readiness](board-fixtures.md). Record a fixture identifier when useful.
4. Run the selected tests. Keep the device powered and connected through cleanup. Record the LED
   observation when execution finishes. Review expected/observed values and restoration evidence.
5. Optionally export [JSON, HTML or PDF](board-test-reports.md).

The advanced JSON editor is at the top of the profile section. Valid edits update the form, and form
edits update JSON. Use the top-right copy button or ordinary text selection and Ctrl+C/Ctrl+V.
Required invalid fields have red borders and explanations; correct them before preparing tests.
Rediscovering regenerates the draft, so export any profile you want to preserve before rediscovery.

## JSON runs

Choose **JSON** for a prepared engineering bench. Paste a complete profile and choose **Run JSON**:
the app discovers, prepares and executes without intermediate checkboxes or confirmation dialogs. A
profile uses its first saved sequence, or all tests when it has no sequence. For a quick example,
turn **Simulation** on, then choose **JSON → Run JSON**.

Run records fixture readiness from your execution action. Optional `fixtures` entries in a request
can provide identifiers or mark an unavailable fixture `ready: false` (that case is Blocked). Device
matching, parameter limits, tool/access checks, resource ownership, cancellation and cleanup still
apply. Incomplete test intent is rejected before discovery. This mode automatically records
unobserved LED behavior as Inconclusive and finalizes the run without an observation prompt; it
cannot establish an optical pass. Use **Setup** to record physical LED observations.

To choose particular tests, wrap your complete profile like this (replace the placeholder object):

```json
{
    "profile": { "...": "your complete schemaVersion 1 profile" },
    "testIds": ["test-uart-2", "test-i2c-3"],
    "fixtures": {
        "test-uart-2": { "ready": true, "identity": "Loopback fixture A" },
        "test-i2c-3": { "ready": true, "identity": "Approved sensor fixture" }
    }
}
```

Alternatively use `"sequence": "bench"` instead of `testIds`. The complete runnable
[simulation request](examples/simulation-run-request.json) selects UART and I2C and produces Pass in
simulation; enable **Simulate UART loopback failure** to review Fail. Select the complete profile to
include the LED and review an Inconclusive run. Review results in place and explicitly export JSON,
HTML or PDF; no report is automatically saved.

The initial active adapters are LED patterns, UART fixture loopback and approved I2C byte-register
identity reads. GPIO, SPI, PCIe, LAN, WLAN, HDMI and watchdog resources can appear in inventory but
their functional adapters are not implemented. Discovery is not a universal board test: a device
tree describes hardware and topology, but usually does not specify acceptance criteria, safe
registers, electrical fixtures or manufacturing intent.

## Session behavior

One sequence runs serially per connection. Active testing temporarily pauses live/manual diagnostic
collection and new terminal input. The live-update preference is preserved and collection resumes
after resources are released, even if operator feedback is still pending. Existing PTY output,
resize acknowledgements and independent device-clock queries keep working. Test output uses separate
SSH execution channels and never enters the terminal.

Already-running shell programs, kernel output and other clients cannot be stopped by this lock.
Prepare the board for exclusive use before approving the run. No queued terminal input is replayed.
Cancel waits for bounded remote completion/restoration evidence. Disconnect attempts cancellation;
transport loss or app termination can leave cleanup unverified. Such results cannot pass. Reconnect
and review the hardware state before retrying after unverified restoration.

Profiles and reports are kept in current application memory until you explicitly export them. There
is no run database, cloud upload or automatic report persistence. Device replacement preserves the
displayed connected result as historical evidence and clears the connected setup; simulation stays
independent. Resetting session data clears both workspaces and restores the simulation sample.

Diagnostic **Import report / Export report** actions appear on diagnostic pages. Terminal and Tests
omit those actions. Tests keeps its own **Import test report**, profile controls and result exports;
test reports are separate from diagnostic reports.

See [software qualification and limits](board-testing-qualification.md) before using results as
manufacturing evidence.
