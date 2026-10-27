import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type ConnectOverCDPTransport,
} from "@playwright/test";
import fs from "node:fs";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type OwnedProcess = Pick<
  ChildProcessWithoutNullStreams,
  "pid" | "stdout" | "stderr" | "once" | "on"
>;
type SocketLike = Pick<
  WebSocket,
  "addEventListener" | "send" | "close" | "readyState"
>;
export function endpoint(line: string, kind: "node" | "browser") {
  const prefix =
    kind === "node" ? "Debugger listening on " : "DevTools listening on ";
  assert(line.startsWith(prefix), "Endpoint prefix");
  const raw = line.slice(prefix.length);
  const u = new URL(raw);
  assert(
    u.protocol === "ws:" &&
      u.hostname === "127.0.0.1" &&
      u.port !== "" &&
      +u.port > 0 &&
      +u.port <= 65535 &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "Endpoint origin",
  );
  assert(
    (kind === "node"
      ? /^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
      : /^\/devtools\/browser\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
    ).test(u.pathname),
    "Endpoint shape",
  );
  return raw;
}
/** Owns exactly the caller's child. Never receives or exposes a termination operation. */
export class LaunchCustody {
  readonly failed = deferred<never>();
  readonly rootClosed = deferred<void>();
  readonly nodeEndpoint = deferred<string>();
  readonly browserEndpoint = deferred<string>();
  readonly streams = {
    stdoutBytes: 0,
    stderrBytes: 0,
    capExceeded: false,
    stdoutComplete: false,
    stderrComplete: false,
    stdoutEOF: false,
    stderrEOF: false,
  };
  readonly facts: { event: string; mono: number; utc: string }[] = [];
  child: OwnedProcess | undefined;
  reason: string | null = null;
  phaseDeadline: number | null = null;
  exitObserved = false;
  closeObserved = false;
  exitCode: number | null = null;
  signal: string | null = null;
  rejectedOwnedCalls = 0;
  quitIntent = false;
  quitScheduledAck = false;
  quitComplete = false;
  preQuitReceiptVerified = false;
  publicationFDs = new Set<number>();
  mainPendingCount = 0;
  pendingWaits = new Map<number, { phase: string; returned: boolean; rejected: boolean; value?: unknown; task?: Promise<unknown> }>();
  private waitSequence = 0;
  shutdown = { mode: 'INACTIVE', until: 0, incident: null as null | string, terminal: null as null | string, repeated: false, complete: false };
  readonly shutdownFailed = deferred<never>();
  readonly eof = { stdout: deferred<void>(), stderr: deferred<void>() };
  shutdownPending = new Map<number, { phase: string; returned: boolean; rejected: boolean; value?: unknown; task?: Promise<unknown> }>();

  attachStarted = false;
  attachReturned = false;
  private endpoints: { node?: string; browser?: string } = {};
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private stdoutFailed = false;
  private stderrFailed = false;
  private captured = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  constructor(
    readonly deadline: number,
    readonly now: () => number = () => performance.now(),
    readonly captureBudget?: { take(bytes: number): boolean },
  ) {}
  cut(event: string) {
    if (this.facts.length >= 64) {
      if (this.reason === null) {
        this.reason = "launch-fact-cap";
        this.failed.reject(Error("launch-fact-cap"));
      }
      return;
    }
    this.facts.push({ event, mono: this.now(), utc: new Date().toISOString() });
  }
  socketError(kind: 'node' | 'browser') {
    const reason = kind + '-socket-error';
    if (this.shutdown.mode === 'DRAINING_NONPASS' && this.shutdown.incident === reason) {
      this.shutdown.repeated = true;if(this.now() >= this.shutdown.until)this.freeze('shutdown-deadline');return;
    }
    const eligible=this.shutdown.mode==='CLOSING' && this.reason===null && this.preQuitReceiptVerified && this.quitScheduledAck && this.pendingWaits.size===0 && this.mainPendingCount===0 && this.publicationFDs.size===0 && this.now()<this.shutdown.until;
    if(!eligible){this.freeze(reason);return;}
    this.reason=reason;this.shutdown.incident=reason;this.shutdown.mode='DRAINING_NONPASS';this.cut('draining-nonpass');this.failed.reject(Error(reason));
  }
  shutdownActive() {
    if(!['CLOSING','DRAINING_NONPASS'].includes(this.shutdown.mode)||this.shutdown.terminal)throw Error('shutdown-retained');
    if(this.now()>=Math.min(this.deadline,this.shutdown.until)){this.freeze('shutdown-deadline');throw Error('shutdown-deadline');}
    if(this.reason && this.reason!==this.shutdown.incident){this.freeze('shutdown-reason');throw Error('shutdown-reason');}
  }
  beginShutdown() {
    this.active();assert(this.preQuitReceiptVerified && this.pendingWaits.size===0 && this.mainPendingCount===0 && this.publicationFDs.size===0 && this.shutdown.mode==='INACTIVE');
    this.shutdown.mode='CLOSING';this.shutdown.until=Math.min(this.deadline,this.phaseDeadline??Infinity,this.now()+20000);this.phaseDeadline=this.shutdown.until;
  }
  async waitShutdown<T>(p:Promise<T>,phase:string):Promise<T> {
    assert(['normal-root-close','stdout-eof','stderr-eof','transport-close'].includes(phase));this.shutdownActive();assert(this.shutdownPending.size<8);
    const id=++this.waitSequence,record={phase,returned:false,rejected:false,value:undefined as unknown,task:undefined as Promise<unknown>|undefined};this.shutdownPending.set(id,record);
    record.task=p.then(value=>{record.value=value;record.returned=true;return value;},error=>{record.rejected=true;this.freeze('shutdown-join-rejected');throw error;});void record.task.catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;
    try {const value=await Promise.race([record.task,this.shutdownFailed.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{this.freeze('shutdown-deadline');reject(Error('shutdown-deadline'));},Math.max(0,this.shutdown.until-this.now()));})]);this.shutdownActive();this.shutdownPending.delete(id);return value as T;}finally{if(timer)clearTimeout(timer);}
  }
  finishShutdown() {
    this.shutdownActive();assert(this.exitObserved&&this.closeObserved&&this.exitCode===0&&this.signal===null&&this.streams.stdoutComplete&&this.streams.stderrComplete&&this.pendingWaits.size===0&&this.shutdownPending.size===0&&this.mainPendingCount===0&&this.publicationFDs.size===0);
    this.shutdown.complete=true; // Receipt I/O remains separately gated by the SAME fixed deadline.
  }
  freeze(reason: string) {
    if (this.reason === null) {
      this.reason = reason;
      this.cut(reason);
      this.failed.reject(Error(reason));
    }
    if(this.shutdown.mode!=='INACTIVE'){this.shutdown.terminal??=reason;this.shutdown.mode='RETAINED_UNKNOWN';this.shutdownFailed.reject(Error(reason));}
  }
  active() {
    if (this.reason) {if(this.shutdown.mode==='DRAINING_NONPASS')this.freeze('workload-after-nonpass');throw Error(this.reason);}
    if (this.phaseDeadline !== null && this.now() >= this.phaseDeadline) {
      this.freeze("owner-phase-deadline");
      throw Error("owner-phase-deadline");
    }
    if (this.now() >= this.deadline) {
      this.freeze("owner-deadline");
      throw Error("owner-deadline");
    }
  }
  async wait<T>(
    p: Promise<T>,
    phase: string,
    until = this.deadline,
  ): Promise<T> {
    // Register rejection custody even when the pre-gate has already frozen.
    void p.catch(() => {
      this.rejectedOwnedCalls++;
      if (this.reason) this.cut("owned-call-rejected");
    });
    this.active();assert(this.pendingWaits.size<32);
    const id=++this.waitSequence,record={phase,returned:false,rejected:false,value:undefined as unknown,task:undefined as Promise<unknown>|undefined};this.pendingWaits.set(id,record);
    record.task=p.then(value=>{record.returned=true;record.value=value;return value;},error=>{record.rejected=true;throw error;});void record.task.catch(()=>{});
    const waitEnd = Math.min(until, this.deadline, this.phaseDeadline ?? Infinity);
    const remaining = waitEnd - this.now();
    if (remaining <= 0) {
      this.freeze("phase-deadline");
      throw Error("phase-deadline");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        record.task,
        this.failed.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.freeze("phase-deadline");
            reject(Error("phase-deadline"));
          }, remaining);
        }),
      ]);
      this.active();
      if (this.now() >= waitEnd) {
        this.freeze("phase-deadline");
        throw Error("phase-deadline");
      }
      this.pendingWaits.delete(id);return value as T;
    } catch (error) {
      this.freeze(phase + "-failed");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  adopt(child: OwnedProcess) {
    assert(!this.child, "Child already adopted");
    this.child = child;
    this.cut("spawn-handle-retained");
    // Node child_process emits process/stream events asynchronously; install before yielding.
    child.stdout.on("data", (b: Buffer) => this.data("stdout", b));
    child.stderr.on("data", (b: Buffer) => this.data("stderr", b));
    child.on("error", () => this.freeze("child-error"));
    child.stdout.on("error", () => {
      this.stdoutFailed = true;
      this.streams.stdoutComplete = false;
      this.freeze("root-stream-error");
    });
    child.stderr.on("error", () => {
      this.stderrFailed = true;
      this.streams.stderrComplete = false;
      this.freeze("root-stream-error");
    });
    child.stdout.once("end", () => {
      this.streams.stdoutEOF = true;
      this.streams.stdoutComplete =
        !this.stdoutFailed && this.streams.stdoutBytes <= 65536;this.eof.stdout.resolve();
    });
    child.stderr.once("end", () => {
      this.streams.stderrEOF = true;
      this.streams.stderrComplete =
        !this.stderrFailed && this.streams.stderrBytes <= 65536;this.eof.stderr.resolve();
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      this.exitObserved = true;
      this.exitCode = code;
      this.signal = signal;
      this.cut("root-exit");
      if (!this.quitIntent) this.freeze("unexpected-root-exit");else if(code!==0||signal!==null)this.freeze('root-exit-not-normal');
    });
    child.once("close", () => {
      this.closeObserved = true;
      this.cut("root-close");
      if (!this.exitObserved || this.exitCode !== 0 || this.signal !== null)
        this.freeze("root-close-not-normal");
      this.rootClosed.resolve();
    });
  }
  private data(which: "stdout" | "stderr", input: Buffer) {
    const b = Buffer.from(input);
    const key = which === "stdout" ? "stdoutBytes" : "stderrBytes";
    this.streams[key] += b.length;
    if (this.streams[key] > 65536 || (this.captureBudget && !this.captureBudget.take(b.length))) {
      this.streams.capExceeded = true;
      this.streams[which === "stdout" ? "stdoutComplete" : "stderrComplete"] =
        false;
      this.freeze("root-stream-cap");
      return;
    }
    this.captured[which].push(b);
    if (which !== "stderr" || this.reason) return;
    this.partial += this.decoder.write(b);
    if (Buffer.byteLength(this.partial) > 65536) {
      this.freeze("endpoint-line-cap");
      return;
    }
    let n: number;
    while ((n = this.partial.indexOf("\n")) >= 0) {
      const line = this.partial.slice(0, n).replace(/\r$/, "");
      this.partial = this.partial.slice(n + 1);
      for (const kind of ["node", "browser"] as const)
        if (
          line.startsWith(
            kind === "node"
              ? "Debugger listening on "
              : "DevTools listening on ",
          )
        ) {
          try {
            const value = endpoint(line, kind);
            if (this.endpoints[kind] && this.endpoints[kind] !== value) {
              this.freeze("endpoint-conflict");
              return;
            }
            this.endpoints[kind] = value;
            this.cut(kind + "-endpoint-observed");
            (kind === "node"
              ? this.nodeEndpoint
              : this.browserEndpoint
            ).resolve(value);
          } catch {
            this.freeze("endpoint-invalid");
            return;
          }
        }
    }
  }
  snapshot() {
    return {
      pid: this.child?.pid ?? null,
      reason: this.reason,
      exitObserved: this.exitObserved,
      closeObserved: this.closeObserved,
      exitCode: this.exitCode,
      signal: this.signal,
      streams: { ...this.streams },
      nodeEndpointObserved: !!this.endpoints.node,
      browserEndpointObserved: !!this.endpoints.browser,
      rejectedOwnedCalls: this.rejectedOwnedCalls,
      activePhaseDeadline: this.phaseDeadline,
      attachStarted: this.attachStarted,
      attachReturned: this.attachReturned,
      quitIntent: this.quitIntent,
      quitScheduledAck: this.quitScheduledAck,
      quitComplete: this.quitComplete,shutdown:{...this.shutdown},genericPending:this.pendingWaits.size,shutdownPending:this.shutdownPending.size,mainPendingCount:this.mainPendingCount,publicationFDCount:this.publicationFDs.size,
      facts: this.facts.map((x) => ({ ...x })),
      privateEndpointAndStreamBuffersPublished: false,
      physicalDescendantClosure: false,
    };
  }
}
class LocalSocket {
  readonly opened = deferred<void>();
  readonly closed = deferred<void>();
  closedObserved = false;
  readonly socket: SocketLike;
  onmessage: ((value: any) => void) | undefined;
  onclose: (() => void) | undefined;
  private allowClose = false;
  constructor(
    readonly owner: LaunchCustody,
    url: string,
    readonly kind: "node" | "browser",
    factory: (url: string) => SocketLike,
  ) {
    this.socket = factory(url);
    this.socket.addEventListener("open", () => this.opened.resolve());
    this.socket.addEventListener("error", () => {
      owner.socketError(kind);
      this.opened.reject(Error("socket-error"));
    });
    this.socket.addEventListener("close", () => {
      this.closedObserved = true;
      this.closed.resolve();
      if (!this.allowClose && !owner.quitIntent && !owner.closeObserved)
        owner.freeze(kind + "-socket-disconnected");
      try {
        this.onclose?.();
      } catch {
        owner.freeze(kind + "-close-callback-failed");
      }
    });
    this.socket.addEventListener("message", (event: any) => {
      try {
        assert.equal(typeof event.data, "string");
        if (kind === "node")
          assert(
            Buffer.byteLength(event.data) <= 65536,
            "Main inspector frame cap",
          );
        const v = JSON.parse(event.data);
        assert(this.onmessage, "Inspector message before handler");
        this.onmessage(v);
      } catch {
        owner.freeze(kind + "-protocol-invalid");
      }
    });
  }
  send(v: object) {
    this.owner.active();
    assert.equal(this.socket.readyState, 1, "Socket not open");
    this.socket.send(JSON.stringify(v));
  }
  disconnectOnly() {
    if(this.allowClose)return;this.allowClose = true;
    try {
      this.socket.close();
    } catch {
      this.owner.freeze(this.kind + "-transport-close-failed");
    }
  }
}
class MainInspector {
  private sequence = 0;
  private pending = new Map<number, Deferred<any>>();
  readonly context = deferred<number>();
  constructor(
    readonly owner: LaunchCustody,
    readonly link: LocalSocket,
  ) {
    link.onmessage = (v: any) => {
      if (
        v.method === "Runtime.executionContextCreated" &&
        v.params?.context?.auxData?.isDefault
      )
        this.context.resolve(v.params.context.id);
      if (Number.isInteger(v.id)) {
        const d = this.pending.get(v.id);
        if (!d) return;
        if (v.error) {
          owner.freeze("main-inspector-response-error");
          d.reject(Error("main-inspector-response-error"));
          return;
        }
        this.pending.delete(v.id);owner.mainPendingCount=this.pending.size;
        d.resolve(v.result);
      }
    };
    link.onclose = () => {
      if (!owner.quitScheduledAck && !owner.closeObserved)
        owner.freeze("main-inspector-disconnected");
    };
  }
  send(method: string, params: object) {
    this.owner.active();
    assert(this.pending.size < 16, "Main inspector pending bound");
    const id = ++this.sequence,
      d = deferred<any>();
    this.pending.set(id, d);this.owner.mainPendingCount=this.pending.size;
    this.link.send({ id, method, params });
    return this.owner.wait(d.promise, "main-response");
  }
  async initialize() {
    await this.send("Runtime.enable", {});
    await this.owner.wait(this.context.promise, "main-context");
  }
  async evaluate<R, A>(
    fn: (electron: typeof import("electron"), arg: A) => R,
    arg?: A,
  ): Promise<Awaited<R>> {
    const contextId = await this.owner.wait(
      this.context.promise,
      "main-context",
    );
    // Functions come only from the fixed caller, never artifact/user strings. Arguments are JSON data.
    const expression = `(async()=>{const __name=(v)=>v;const fn=(${fn.toString()});return await fn(require('electron'),${JSON.stringify(arg) ?? "undefined"});})()`;
    const value = await this.send("Runtime.evaluate", {
      contextId,
      expression,
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
    });
    if (value.exceptionDetails) {
      this.owner.freeze("main-evaluate-exception");
      throw Error("main-evaluate-exception");
    }
    return value.result?.value as Awaited<R>;
  }
  pendingCount() {
    return this.pending.size;
  }
}
export type AttachDependencies = {
  socket: (url: string) => SocketLike;
  connect: (
    transport: ConnectOverCDPTransport,
    options: { artifactsDir: string; noDefaults: boolean; timeout: number },
  ) => Promise<Browser>;
};
const fixedAttach: AttachDependencies = {
  socket: (url) => new WebSocket(url),
  connect: (transport, options) => chromium.connectOverCDP(transport, options),
};
/** Fixed transport only: framework receives no child, and cannot send a process-close command. */
export function rendererTransport(
  owner: LaunchCustody,
  link: {
    send: (v: object) => void;
    disconnectOnly: () => void;
    onmessage?: (v: any) => void;
    onclose?: () => void;
  },
): ConnectOverCDPTransport {
  const transport: ConnectOverCDPTransport = {
    send(v: any) {
      owner.active();
      if (
        [
          "Browser.close",
          "Browser.crash",
          "Target.closeTarget",
          "Target.disposeBrowserContext",
          "Page.close",
        ].includes(v.method)
      ) {
        owner.freeze("forbidden-termination-command");
        throw Error("forbidden-termination-command");
      }
      link.send(v);
    },
    close() { owner.freeze('framework-transport-close-refused'); },
  };
  link.onmessage = (v) => {
    if (!transport.onmessage) {
      if (!owner.closeObserved) owner.freeze("renderer-message-before-handler");
      return;
    }
    transport.onmessage(v);
  };
  link.onclose = () => transport.onclose?.("Owned socket disconnected");
  return transport;
}
export class OwnedDesktop {
  readonly owner: LaunchCustody;
  private main: MainInspector | undefined;
  private mainLink: LocalSocket | undefined;
  private browserLink: LocalSocket | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private launchDeadline: number | undefined;
  private launchArgs: string[] | undefined;
  private spawned = false;
  private quitCalled = false;
  constructor(
    readonly options: {
      executable: string;
      profile: string;
      env: NodeJS.ProcessEnv;
      artifactsDir: string;
      deadline: number;
      offline?: boolean;
      captureBudget?: { take(bytes: number): boolean };
    },
    readonly deps: AttachDependencies = fixedAttach,
  ) {
    this.owner = new LaunchCustody(options.deadline, undefined, options.captureBudget);
  }
  launch(
    spawnChild: (
      executable: string,
      args: string[],
      options: any,
    ) => OwnedProcess = (exe, args, opts) => spawn(exe, args, opts),
  ) {
    this.owner.active();
    assert(!this.spawned, "Launch spent");
    this.spawned = true;
    this.owner.cut("spawn-intent");
    this.launchDeadline = Math.min(
      this.options.deadline,
      this.owner.phaseDeadline ?? Infinity,
      performance.now() + 30000,
    );
    this.owner.phaseDeadline = this.launchDeadline;
    this.launchArgs = [
      this.options.offline ? "--inspect-brk=127.0.0.1:0" : "--inspect=127.0.0.1:0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + this.options.profile,
    ];
    assert.equal(
      fs.realpathSync(this.options.artifactsDir),
      this.options.artifactsDir,
    );
    assert.equal(this.options.env.NODE_OPTIONS, undefined);
    assert.equal(this.options.env.ELECTRON_RUN_AS_NODE, undefined);
    try {
      this.owner.active();
      const child = spawnChild(this.options.executable, this.launchArgs, {
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: false,
      });
      this.owner.adopt(child);
      this.owner.active();
      return child;
    } catch (error) {
      this.owner.freeze("spawn-failed");
      throw error;
    }
  }
  process() {
    assert(this.owner.child);
    return this.owner.child;
  }
  async attach() {
    this.owner.active();
    assert(this.owner.child);
    assert(!this.owner.attachStarted, "Attach spent");
    this.owner.attachStarted = true;
    const until = this.launchDeadline!;
    try {
      const node = await this.owner.wait(
        this.owner.nodeEndpoint.promise,
        "node-endpoint",
        until,
      );
      this.mainLink = new LocalSocket(
        this.owner,
        node,
        "node",
        this.deps.socket,
      );
      await this.owner.wait(
        this.mainLink.opened.promise,
        "node-connect",
        until,
      );
      this.main = new MainInspector(this.owner, this.mainLink);
      await this.owner.wait(this.main.initialize(), "main-initialize", until);
      if (this.options.offline) {
        const scheduled = await this.main.evaluate(({ app, session }) => {
          const state = { applied: false, readyBeforeWindow: false };
          (globalThis as any).__hubInstallerOffline = state;
          const apply = () => {
            session.defaultSession.enableNetworkEmulation({ offline: true });
            state.applied = true;
            state.readyBeforeWindow = require('electron').BrowserWindow.getAllWindows().length === 0;
          };
          if (app.isReady()) apply(); else void app.whenReady().then(apply);
          return { scheduled: true };
        });
        assert.equal(scheduled.scheduled, true);
        await this.main.send('Runtime.runIfWaitingForDebugger', {});
      }
      const url = await this.owner.wait(
        this.owner.browserEndpoint.promise,
        "browser-endpoint",
        until,
      );
      this.browserLink = new LocalSocket(
        this.owner,
        url,
        "browser",
        this.deps.socket,
      );
      await this.owner.wait(
        this.browserLink.opened.promise,
        "browser-connect",
        until,
      );
      const transport = rendererTransport(this.owner, this.browserLink);
      const pending = this.deps
        .connect(transport, {
          artifactsDir: this.options.artifactsDir,
          noDefaults: true,
          timeout: Math.max(1, until - performance.now()),
        })
        .then((browser) => {
          this.browser = browser;
          return browser;
        });
      await this.owner.wait(pending, "renderer-attach", until);
      const contexts = this.browser!.contexts();
      assert.equal(contexts.length, 1);
      this.context = contexts[0];
      this.owner.attachReturned = true;
      this.owner.phaseDeadline = null;
      this.owner.cut("attach-return");
    } catch (error) {
      this.owner.freeze("attach-failed");
      throw error;
    }
  }
  async firstWindow(): Promise<Page> {
    this.owner.active();
    assert(this.context);
    const ready =
      this.context.pages()[0] ??
      (await this.owner.wait(
        this.context.waitForEvent("page", { timeout: 0 }),
        "first-window",
        Math.min(this.options.deadline, performance.now() + 10000),
      ));
    this.owner.active();
    return ready;
  }
  windows() {
    return this.context?.pages() ?? [];
  }
  evaluate<R, A = undefined>(
    fn: (electron: typeof import("electron"), arg: A) => R,
    arg?: A,
  ): Promise<Awaited<R>> {
    this.owner.active();
    assert(this.main);
    return this.main.evaluate(fn, arg);
  }
  async normalQuit() {
    this.owner.beginShutdown();
    assert(!this.quitCalled, "Quit intent spent");
    this.quitCalled = true;
    this.owner.quitIntent = true;
    this.owner.cut("normal-quit-intent");
    try {
      const ack = await this.evaluate(({ app }) => {
        setImmediate(() => app.quit());
        return { scheduled: true };
      });
      assert.equal(ack.scheduled, true);
      this.owner.quitScheduledAck = true;
      this.owner.cut("normal-quit-schedule-ack");
      // Only our inspector connection is disconnected; no Browser.close/process signal/delete fallback.
      this.mainLink!.disconnectOnly();
      await this.owner.waitShutdown(this.owner.rootClosed.promise, "normal-root-close");
      await this.owner.waitShutdown(this.owner.eof.stdout.promise,'stdout-eof');
      await this.owner.waitShutdown(this.owner.eof.stderr.promise,'stderr-eof');
      assert(
        this.owner.exitObserved &&
          this.owner.closeObserved &&
          this.owner.exitCode === 0 &&
          this.owner.signal === null &&
          this.owner.streams.stdoutComplete &&
          this.owner.streams.stderrComplete,
      );
      this.owner.cut("normal-root-close-acknowledged");
      this.browserLink?.disconnectOnly();
      await this.owner.waitShutdown(
        Promise.all([
          this.mainLink!.closed.promise,
          this.browserLink!.closed.promise,
        ]),
        "transport-close",
      );
      this.owner.finishShutdown();this.owner.quitComplete = true;
      this.owner.cut("normal-quit-complete");
    } catch (error) {
      this.owner.freeze("normal-quit-failed");
      throw error;
    }
  }
  snapshot() {
    return {
      ...this.owner.snapshot(),
      mainPending: this.main?.pendingCount() ?? null,
      mainTransportClosed: this.mainLink?.closedObserved ?? null,
      rendererTransportClosed: this.browserLink?.closedObserved ?? null,
      browserAttachmentRetained: !!this.browser,
      launch: {
        executable: this.options.executable,
        args: this.launchArgs ?? null,
        cwd: process.cwd(),
        profile: this.options.profile,
        artifactsDir: this.options.artifactsDir,
        environmentNames: Object.keys(this.options.env).sort(),
        shell: false,
        detached: false,
        phaseDeadline: this.launchDeadline ?? null,
      },
      frameworkOwnsProcess: false,
      frameworkTemporaryDirectoryAllocated: false,
    };
  }
}
/** Retains failed custody; caller attempts bounded evidence only when safe. No new observation/work. */
export function parkRetained(context: unknown): Promise<never> {
  return new Promise(() => {
    const timer = setInterval(() => {}, 60000);
    Object.defineProperty(timer, "retainedCustody", {
      value: context,
      writable: false,
    });
  });
}
