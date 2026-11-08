"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

function requireCommand(
  method,
  params,
  sessionId,
  pageTarget,
  metadataSession,
) {
  if (["Browser.getVersion", "Target.getTargets"].includes(method)) {
    assert.equal(sessionId, undefined);
    assert.deepEqual(params, {});
  } else if (method === "Target.setDiscoverTargets") {
    assert.equal(sessionId, undefined);
    assert.deepEqual(params, { discover: true });
  } else if (method === "Target.attachToTarget") {
    assert.ok(
      pageTarget && !metadataSession,
      "Only the one pre-bound page may be attached.",
    );
    assert.equal(sessionId, undefined);
    assert.deepEqual(params, { targetId: pageTarget, flatten: true });
  } else if (method === "Target.detachFromTarget") {
    assert.ok(metadataSession);
    assert.equal(sessionId, undefined);
    assert.deepEqual(params, { sessionId: metadataSession });
  } else if (
    ["ServiceWorker.enable", "ServiceWorker.disable"].includes(method)
  ) {
    assert.ok(metadataSession);
    assert.equal(sessionId, metadataSession);
    assert.deepEqual(params, {});
  } else throw Error("Passive lifetime witness forbids command: " + method);
}
function requireSameVersion(value, binding) {
  assert.ok(value, "Exact native worker version is missing.");
  for (const key of ["versionId", "registrationId", "scriptURL"])
    assert.equal(
      value[key],
      binding[key],
      "Native worker identity changed: " + key,
    );
  if (value.targetId) assert.equal(value.targetId, binding.targetId);
  return value;
}
class PassiveLifetimeCDP extends EventEmitter {
  constructor(endpoint, origin, emit, dependencies = {}) {
    super();
    const url = new URL(endpoint);
    assert.equal(url.protocol, "ws:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.pathname, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
    assert.ok(!url.username && !url.password && !url.search && !url.hash);
    this.origin = origin;
    this.record = emit;
    this.setTimer = dependencies.setTimeout ?? setTimeout;
    this.clearTimer = dependencies.clearTimeout ?? clearTimeout;
    this.now = dependencies.now ?? (() => performance.now());
    this.eventOrdinal = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.versions = new Map();
    this.events = [];
    this.closed = false;
    this.closedPromise = new Promise(
      (resolve) => (this.resolveClosed = resolve),
    );
    this.socket = dependencies.socketFactory
      ? dependencies.socketFactory(endpoint)
      : new WebSocket(endpoint);
    this.onMessage = (event) => {
      try {
        this.receive(event.data);
      } catch (error) {
        this.fail(error);
      }
    };
    this.onError = () => this.fail(Error("Passive metadata transport error."));
    this.onClose = (event) => {
      this.closed = true;
      this.write("passive-transport-close", {
        code: event.code,
        reason: event.reason,
      });
      for (const [id, call] of this.pending) {
        this.clearTimer(call.timer);
        this.write("passive-call-closed", {
          id,
          method: call.method,
          deadlineExpired: call.expired,
        });
        call.reject(
          this.failure ??
            Error("Metadata transport closed before reply: " + call.method),
        );
      }
      this.pending.clear();
      this.resolveClosed();
      this.signalChange();
    };
    this.socket.addEventListener("message", this.onMessage);
    this.socket.addEventListener("error", this.onError);
    this.socket.addEventListener("close", this.onClose);
  }
  fail(error) {
    if (!this.failure) this.failure = error;
    try {
      this.record("passive-witness-error", { error: String(error) });
    } catch (recording) {
      if (!this.failureRecordingError) this.failureRecordingError = recording;
    }
    this.signalChange();
  }
  signalChange() {
    try {
      this.emit("change");
    } catch (error) {
      if (!this.failure) this.failure = error;
      if (!this.failureNotificationError) this.failureNotificationError = error;
    }
  }
  write(stage, data) {
    try {
      this.record(stage, data);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  async open() {
    if (this.socket.readyState !== WebSocket.OPEN)
      await this.wait(
        () => this.socket.readyState === WebSocket.OPEN,
        "metadata-open",
      );
  }
  async wait(predicate, label) {
    const check = () => {
      if (this.failure) throw this.failure;
      if (this.closed) throw Error("Passive witness lost before " + label);
      return predicate();
    };
    if (check()) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        this.clearTimer(timer);
        this.off("change", changed);
        this.socket.removeEventListener("open", changed);
        error ? reject(error) : resolve();
      };
      const changed = () => {
        try {
          if (check()) finish();
        } catch (error) {
          finish(error);
        }
      };
      const timer = this.setTimer(
        () => finish(Error("Native metadata deadline 10000 ms: " + label)),
        10000,
      );
      this.on("change", changed);
      this.socket.addEventListener("open", changed);
      changed();
    });
  }
  receive(text) {
    assert.equal(typeof text, "string");
    assert.ok(
      Buffer.byteLength(text) <= 256 * 1024,
      "Metadata frame bound exceeded.",
    );
    const message = JSON.parse(text);
    assert.ok(
      message && typeof message === "object" && !Array.isArray(message),
    );
    if (Object.hasOwn(message, "id")) {
      assert.ok(Number.isSafeInteger(message.id) && message.id > 0);
      const call = this.pending.get(message.id);
      assert.ok(call, "Unknown metadata reply ID.");
      assert.equal(
        message.sessionId,
        call.sessionId,
        "Metadata reply session differs from the actual command.",
      );
      this.pending.delete(message.id);
      this.clearTimer(call.timer);
      const recorded = this.write("passive-call-settled", {
        id: message.id,
        method: call.method,
        deadlineExpired: call.expired,
        error: message.error ?? null,
      });
      if (!recorded) {
        call.reject(this.failure);
      } else
        message.error
          ? call.reject(Error(JSON.stringify(message.error)))
          : call.resolve(message.result);
      return;
    }
    assert.equal(typeof message.method, "string");
    assert.ok(this.events.length < 512, "Native event journal bound exceeded.");
    const row = Object.freeze({
      ...structuredClone(message),
      at: new Date().toISOString(),
      monotonic: this.now(),
      ordinal: ++this.eventOrdinal,
    });
    this.events.push(row);
    if (!this.write("passive-native-event", row)) return;
    if (
      message.method === "ServiceWorker.workerVersionUpdated" &&
      message.sessionId === this.metadataSession
    )
      for (const version of message.params.versions) {
        assert.ok(
          this.versions.has(version.versionId) || this.versions.size < 16,
          "Native version inventory bound exceeded.",
        );
        this.versions.set(version.versionId, structuredClone(version));
      }
    if (message.method === "Target.targetCrashed")
      this.fail(Error("Owned native target crashed."));
    this.signalChange();
  }
  send(method, params = {}, sessionId) {
    requireCommand(
      method,
      params,
      sessionId,
      this.pageTarget,
      this.metadataSession,
    );
    if (this.closed || this.failure)
      return Promise.reject(
        this.failure ?? Error("Metadata transport closed."),
      );
    assert.equal(this.socket.readyState, WebSocket.OPEN);
    assert.ok(this.pending.size < 16, "Pending metadata call bound exceeded.");
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      const call = { method, sessionId, resolve, reject, expired: false };
      call.timer = this.setTimer(() => {
        call.expired = true;
        this.write("passive-call-deadline", { id, method });
        reject(
          this.failure ?? Error("Metadata RPC deadline 10000 ms: " + method),
        );
        // Keep the real reply owned until reply or actual transport close.
      }, 10000);
      this.pending.set(id, call);
      const command = {
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      };
      if (!this.write("passive-command", command)) {
        this.pending.delete(id);
        this.clearTimer(call.timer);
        reject(this.failure);
        return;
      }
      try {
        this.socket.send(JSON.stringify(command));
      } catch (error) {
        this.clearTimer(call.timer);
        this.pending.delete(id);
        this.fail(error);
        this.write("passive-call-send-failed", {
          id,
          method,
          error: String(error),
        });
        reject(error);
      }
    });
    return promise;
  }
  async bindPage() {
    assert.equal(this.pageTarget, undefined);
    const targets = (await this.send("Target.getTargets")).targetInfos;
    const pages = targets.filter(
      (row) => row.type === "page" && row.url === this.origin + "/",
    );
    assert.equal(pages.length, 1, "Owned metadata page identity is ambiguous.");
    this.pageTarget = pages[0].targetId;
    const attached = await this.send("Target.attachToTarget", {
      targetId: this.pageTarget,
      flatten: true,
    });
    assert.ok(attached.sessionId);
    this.metadataSession = attached.sessionId;
    await this.send("Target.setDiscoverTargets", { discover: true });
    await this.send("ServiceWorker.enable", {}, this.metadataSession);
  }
  async refreshVersions() {
    await this.send("ServiceWorker.disable", {}, this.metadataSession);
    this.versions.clear();
    await this.send("ServiceWorker.enable", {}, this.metadataSession);
  }
  async close() {
    // This transport owns only passive metadata/page-inspection sessions. Join
    // its real close instead of issuing a late RPC through a closing parent.
    if (!this.closed) this.socket.close(1000, "owned diagnostic complete");
    await Promise.race([
      this.closedPromise,
      new Promise((_, reject) => {
        const timer = this.setTimer(
          () => reject(Error("Metadata close unjoined after 10000 ms.")),
          10000,
        );
        void this.closedPromise.finally(() => this.clearTimer(timer));
      }),
    ]);
    assert.equal(this.pending.size, 0);
    assert.equal(
      this.listenerCount("change"),
      0,
      "Passive condition wait remains owned.",
    );
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("error", this.onError);
    this.socket.removeEventListener("close", this.onClose);
    if (this.failure) throw this.failure;
  }
}
module.exports = { PassiveLifetimeCDP, requireCommand, requireSameVersion };
