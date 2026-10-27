"use strict";
const assert = require("node:assert/strict");
const { requireSameVersion } = require("./passive-cdp.cjs");

/** One controller epoch/deadline covers disconnect, worker-close and native stop. */
async function observeInspectorRelease({
  metadata,
  binding,
  controlOffset,
  playwrightClosed,
  disconnect,
  joinWorkerClose,
  record,
}) {
  const running = requireSameVersion(
    metadata.versions.get(binding.versionId),
    binding,
  );
  assert.ok(
    !metadata.failure && !metadata.closed,
    "Native witness is already invalid.",
  );
  assert.equal(
    running.runningStatus,
    "running",
    "Worker stopped before release.",
  );
  assert.equal(running.status, "redundant");
  assert.deepEqual(running.controlledClients, []);
  assert.equal(playwrightClosed(), false, "Worker close preceded release.");
  const hasBoundStop = (event) =>
    event.method === "ServiceWorker.workerVersionUpdated" &&
    event.sessionId === metadata.metadataSession &&
    event.params.versions.some(
      (row) =>
        row.versionId === binding.versionId && row.runningStatus === "stopped",
    );
  assert.ok(
    !metadata.events.slice(controlOffset).some(hasBoundStop),
    "Native stop preceded release.",
  );

  const releaseAt = metadata.now(),
    deadline = releaseAt + 10000;
  const cutoffOrdinal = metadata.eventOrdinal;
  let nativeStop, terminal, timer;
  let resolveStop, rejectStop, rejectTerminal;
  const stopped = new Promise((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  const terminalPromise = new Promise((_, reject) => {
    rejectTerminal = reject;
  });
  void stopped.catch(() => {});
  void terminalPromise.catch(() => {});
  const fail = (error) => {
    if (!terminal) {
      terminal = error;
      rejectStop(error);
      rejectTerminal(error);
    }
  };
  const changed = () => {
    try {
      if (metadata.failure) throw metadata.failure;
      assert.equal(
        metadata.closed,
        false,
        "Passive witness lost during release.",
      );
      for (const event of metadata.events) {
        if (event.ordinal <= cutoffOrdinal || !hasBoundStop(event)) continue;
        assert.ok(
          event.monotonic >= releaseAt && event.monotonic < deadline,
          "Native stop outside absolute 10000 ms release window.",
        );
        const row = event.params.versions.find(
          (value) =>
            value.versionId === binding.versionId &&
            value.runningStatus === "stopped",
        );
        requireSameVersion(row, binding);
        assert.equal(row.status, "redundant");
        assert.deepEqual(row.controlledClients, []);
        if (!nativeStop) {
          nativeStop = Object.freeze({
            eventOrdinal: event.ordinal,
            observedAt: event.monotonic,
            version: structuredClone(row),
          });
          resolveStop(nativeStop);
        }
      }
    } catch (error) {
      fail(error);
    }
  };
  const within = async (operation) => {
    if (terminal) throw terminal;
    if (metadata.now() >= deadline)
      throw Error("Absolute 10000 ms release deadline exhausted.");
    const value = await Promise.race([operation(), terminalPromise]);
    if (terminal) throw terminal;
    if (metadata.now() >= deadline)
      throw Error("Absolute 10000 ms release deadline exhausted.");
    return value;
  };
  metadata.on("change", changed);
  timer = metadata.setTimer(
    () => fail(Error("Absolute 10000 ms release deadline exhausted.")),
    10000,
  );
  try {
    // Arm native observation before invoking any disconnect/evidence callback.
    changed();
    record("release-owned-playwright-connection-start", {
      releaseAt,
      deadline,
      cutoffOrdinal,
      scope:
        "Only owned automation disconnect; browser/page/passive metadata remain live.",
    });
    await within(disconnect);
    await within(joinWorkerClose);
    await within(() => stopped);
    assert.ok(nativeStop);
    return Object.freeze({
      releaseAt,
      deadline,
      cutoffOrdinal,
      nativeStop,
      nativeStopLatencyMilliseconds: nativeStop.observedAt - releaseAt,
      releaseJoinMilliseconds: metadata.now() - releaseAt,
    });
  } finally {
    metadata.clearTimer(timer);
    metadata.off("change", changed);
    // No native/automation operation is canceled or removed from its real owner.
    fail(terminal ?? Error("Release observation finished."));
  }
}
module.exports = { observeInspectorRelease };
