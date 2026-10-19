## ADDED Requirements

### Requirement: Durable capture before flow advancement

An armed flow using full-output capture SHALL seal and integrity-check its raw observations and
commit its immutable outcome before the next step, repeated flow or completed state is authorized.
Prompt/exit observation, terminal rendering acknowledgement and storage enqueue acknowledgement
SHALL NOT replace this requirement. Storage continuations SHALL retain cancellation, connection
generation and lifecycle/watchdog checks through the final outcome commit. Healthy awaited I/O SHALL
be distinguished from an unexplained resume gap without resetting a stale baseline to authorize
later input.

#### Scenario: Cancel or suspend during persistence

- **WHEN** cancellation, ownership loss or an unsafe resume gap occurs while raw/outcome persistence
  is pending
- **THEN** its late completion cannot authorize subsequent input, and cleanup retains ownership
  until the pending work settles
