/**
 * In-process session hosting.
 *
 * ## Why this replaces `pi --mode rpc` subprocesses
 *
 * Booting a `pi` subprocess costs ~1.3 s, and 0.9 s of that is one thing:
 * `createAgentSessionServices()` discovering extensions, skills and MCP servers.
 * That work depends only on the working directory, never on the conversation, so
 * a process per session pays for it again and again: ten sessions in one
 * workspace cost ten times 0.9 s and ten resident copies.
 *
 * Here the services are cached per cwd and only the `AgentSession` (which owns
 * one conversation) is created per open session. Measured on this machine:
 *
 *   services, cold cwd          ~0.78 s   (once per workspace, then reused)
 *   services, cached cwd          0 ms
 *   new session                 ~46 ms
 *   open a 30 MB session        ~88 ms   (parse + extension bind)
 *
 * ## Why one session per key, not in-process switching
 *
 * `switch_session` inside one process invalidates every extension context that
 * captured `ctx`, which is why the RPC bridge needed a process per session. The SDK's
 * `AgentSessionRuntime` avoids that by rebuilding the extension runner, but the
 * host still has to rebind subscriptions on every switch, and a session that is
 * mid-run cannot be switched away from at all. A pool keyed by session file — the
 * map the RPC bridge already has — sidesteps both: each open session keeps its own
 * `AgentSession`, its own queue and its own run, and no switch ever happens.
 * What changes is only the cost of *creating* one.
 *
 * ## Failure containment
 *
 * A subprocess crash was contained by the OS. In-process, a throw during a run
 * would take the whole UI down with it, so every inbound event is funnelled
 * through one guarded listener and every command through `#guard()`.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { toJsonEvent } from "./events.js";
import { ImageStash, offloadEntries } from "./images.js";
import { ExtensionUi } from "./ui-context.js";
import { wireVerdict, wireHost, probeHost, transportVerdict } from "./wire.js";

/** Idle sessions with no attached browser are disposed after this long. */
const IDLE_REAP_MS = 30 * 60 * 1000;

/** When a silent run is aborted.
 *
 *  This is NOT a "the model is too slow" deadline and must not be read as one.
 *  A turn can legitimately emit nothing for a long time — large prompts and
 *  `reasoning_effort: high` have run for many minutes on this machine and then
 *  completed. Measured over 37,872 event-to-event gaps in the session files
 *  here, p99.5 of healthy gaps is 269 s, so five minutes sits past 99.5% of
 *  everything a working run has ever done. The cost of a false positive is an
 *  aborted turn the user must re-send, which is why this is deliberately the
 *  conservative end rather than "just past p99".
 *
 *  Reporting comes first and is the frontend's job (`STALL_FIRST_TOKEN_MS`,
 *  one minute): between the two thresholds the status line says the run has
 *  gone quiet and nothing is aborted. The two numbers live on separate sides
 *  on purpose — a tab that is closed can still be aborted, while only an open
 *  tab can draw the line — and the smoke test asserts this one is the larger. */
const STALL_ABORT_AFTER_MS = 5 * 60 * 1000;

/** How long a silence is given before the wire is asked what it thinks.
 *
 *  Below this, a run is simply working: measured over this machine's 791 Cursor
 *  turns, a first token arrives in 26 s at the median and 91 s at p90, so
 *  probing earlier would spend requests on runs that are about to answer.
 *
 *  This is also the reason no constant here is tied to the transport's own
 *  `bodyTimeout` (300 s by default): the wire is asked repeatedly from 90 s on,
 *  so a request that dies with `UND_ERR_SOCKET` at 120 s is noticed at the next
 *  sweep, and one that starves until `UND_ERR_BODY_TIMEOUT` at 300 s is noticed
 *  when that error lands. The deadline stays a fallback rather than the only
 *  signal, and the gap between 90 s and 300 s is no longer spent guessing. */
const WIRE_CHECK_AFTER_MS = 90 * 1000;

/** Automatic re-sends allowed per prompt when a *proven* dead connection is
 *  what killed the run. One: a second failure means the endpoint is the
 *  problem, and retrying into that only delays the message the user needs. */
const AUTO_RETRY_MAX = 1;

/** How often the wire is re-asked about one unbroken silence.
 *
 *  The first answer is not the last word: a socket can be carrying bytes at 90 s
 *  and die at 400 s, and a route can drop after a reachability probe succeeded.
 *  Re-checking on this interval keeps a run that outlives its connection from
 *  waiting out the full fallback, while staying far below the socket sampling
 *  rate so a long silence costs a handful of verdicts, not a loop. */
const WIRE_RECHECK_MS = 30 * 1000;

/** How long an abort is given to settle before the re-send stops waiting on it.
 *  `AgentSession.abort()` ends with `await waitForIdle()`, and a run whose
 *  connection is gone is precisely what never becomes idle, so the wait has to
 *  be bounded or the recovery it gates would never run. */
const ABORT_SETTLE_MS = 10 * 1000;

/** Whether a streamed assistant delta put something on screen.
 *
 *  `message_update` carries the in-flight `assistantMessageEvent`, whose type
 *  says which kind of delta it is. Starting a tool call or a text block is
 *  visible; a bare `start`/`finish` marker is not. Used only to decide whether a
 *  later silence can be re-sent automatically, so an over-estimate is the safe
 *  direction: it leaves the turn to the user. */
function hasVisibleDelta(event) {
  const inner = event.assistantMessageEvent;
  if (!inner || typeof inner.type !== "string") return false;
  if (inner.type === "toolcall_start") return true;
  if (inner.type !== "text_delta" && inner.type !== "thinking_delta") return false;
  return Boolean(String(inner.delta || "").length);
}

/** Whether an assistant message is only pi's marker for an aborted run.
 *
 *  `handleRunFailure` in `@earendil-works/pi-agent-core` emits one of these when
 *  a run is aborted: role "assistant", empty text, `stopReason: "aborted"`. It
 *  exists so the transcript records *that* the turn ended, and it carries no
 *  model output — which is what decides whether a rewind before a re-send would
 *  throw away something the reader saw. */
function isEmptyAbortMessage(message) {
  if (message.stopReason !== "aborted") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return !blocks.some(
    (b) =>
      b &&
      ((b.type === "text" && String(b.text || "").trim()) ||
        (b.type === "thinking" && String(b.thinking || "").trim()) ||
        b.type === "toolCall")
  );
}

/** What `session.prompt()` reports for an accepted prompt, in the RPC shape. */
const PROMPT_DISPOSITIONS = new Set(["started", "queued", "handled"]);

/** How long `bindExtensions` may hold up a session's creation. An extension that
 *  asks a question on `session_start` leaves the bind promise unsettled until it
 *  is answered; without a bound, `/api/open` waits forever. Long enough for the
 *  ordinary extension startup measured in this repo (~0.8 s cold, ~0 ms warm). */
const BIND_DEADLINE_MS = 15000;
const BIND_DEADLINE = Symbol("bind-deadline");

/**
 * One open session: an `AgentSession` plus the browser bookkeeping the RPC bridge kept
 * on its subprocess (queue snapshot, leftover background processes, clients).
 */
class Session {
  constructor(pool, key, { cwd, sessionFile, session }) {
    this.pool = pool;
    this.key = key;
    this.cwd = cwd;
    this.session = session;
    this.sessionFile = sessionFile || null;
    this.isStreaming = false;
    this.lastActivity = Date.now();
    /** Set when the watchdog has already aborted this run for going silent, so
     *  the sweeper reports it once rather than every pass. Cleared by the next
     *  `agent_start`, and by a stall abort that failed to land. */
    this.stallAborted = false;
    /** When the wire was last consulted about a silence, and what it said.
     *  Compared against `lastActivity`, so any new event re-arms the check.
     *  `wireAliveNoticed` keeps a proof-of-life notice to one per silence. */
    this.wireCheckedAt = 0;
    this.wireAliveNoticed = false;
    /** The prompt the browser last submitted, kept so a run that a *proven*
     *  dead connection killed can be re-sent without the user retyping it.
     *  Only a run that executed no tool is ever re-sent automatically: a tool
     *  call is a side effect, and repeating one is worse than a lost turn.
     *  A steer is excluded too — it is mid-run text, not a turn's opening
     *  message, so re-sending it would replay the wrong thing. */
    this.lastPrompt = null;
    /** The leaf that was active before that prompt was recorded. A re-send
     *  needs it to take the lost turn back off the branch: re-sending on top of
     *  the dead turn would hand the model the same message twice. */
    this.lastPromptParentId = null;
    /** How many tool calls the current run has started. */
    this.toolCallsThisRun = 0;
    /** Tool calls currently in flight. A running tool explains a silence on its
     *  own, so the wire is not consulted while one is open (see
     *  `#checkWireForStall`). */
    this.runningTools = 0;
    /** Whether this run put anything on screen: streamed text, thinking, a tool
     *  call, or partial tool output. A silence that happened *after* visible
     *  output is not a message that never arrived, so it is never re-sent
     *  automatically — the reader would watch the same lines appear twice. */
    this.runProducedOutput = false;
    /** Automatic re-sends spent on `lastPrompt`, capped so a genuinely broken
     *  endpoint cannot become a loop. */
    this.autoRetries = 0;
    this.queued = { steering: [], followUp: [] };
    this.unsubscribe = null;
    this.ui = new ExtensionUi((record) => this.broadcast(record));
    /** toolCallId -> process table captured when that bash call started. */
    this.callSnapshots = new Map();
    /** pid -> described leftover process from one of this session's bash calls. */
    this.leftovers = new Map();
    this.disposed = false;
  }

  get clients() {
    return this.pool.clientsOn(this.key);
  }

  /** Extension context handed to `bindExtensions`. */
  #extensionBindings() {
    return {
      uiContext: this.ui.context(),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: (options) => this.pool.newSessionInPlace(this, options),
        fork: (entryId, forkOptions) => this.pool.forkInPlace(this, entryId, forkOptions),
        navigateTree: async (targetId, options) => {
          const result = await this.session.navigateTree(targetId, options || {});
          return { cancelled: Boolean(result?.cancelled) };
        },
        switchSession: (sessionPath, options) => this.pool.switchInPlace(this, sessionPath, options),
        reload: () => this.session.reload(),
      },
      shutdownHandler: () => {
        // `ctx.shutdown()` asks the host to exit. There is one host process
        // serving every tab, so honouring it would kill unrelated sessions;
        // report it instead and let the operator decide.
        this.broadcast({ type: "server", event: "extension_shutdown_requested" });
      },
      onError: (err) => {
        this.broadcast({
          type: "extension_error",
          extensionPath: err?.extensionPath,
          event: err?.event,
          error: err?.error ?? String(err),
        });
      },
    };
  }

  /** Bind extensions and start forwarding events. Re-runnable after the
   *  session is replaced by new/fork/switch. */
  async bind() {
    const ui = this.#extensionBindings();
    // Subscribe BEFORE binding: `bindExtensions` fires `session_start`, and a
    // handler that blocks on a question must not also hold back the session's
    // own event stream.
    this.observe();
    try {
      await this.#awaitBind(ui);
    } catch (err) {
      // An extension failing to bind must not make the session unusable.
      this.broadcast({ type: "server", event: "extension_bind_error", error: err.message });
    }
  }

  /** `bindExtensions`, bounded.
   *
   *  A handler on `session_start` may ask a question (`ctx.ui.select` in a trust
   *  or permission gate), and the bind promise does not settle until it is
   *  answered. Unbounded, that makes `/api/open` wait for a user who may never
   *  see the prompt — and `ask_user_question`-shaped calls pass no timeout, so
   *  the request would hang forever. The question itself is still delivered (the
   *  client key is set before the session is created); this only stops the
   *  session's *creation* from waiting on it, and says so on the page. */
  async #awaitBind(ui) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(BIND_DEADLINE), BIND_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.session.bindExtensions(ui), deadline]);
      if (outcome === BIND_DEADLINE) {
        this.broadcast({
          type: "server",
          event: "extension_bind_error",
          error: `extensions are still starting after ${Math.round(BIND_DEADLINE_MS / 1000)}s — an extension is waiting for an answer`,
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** (Re)attach the single guarded event listener. */
  observe() {
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe((event) => {
      try {
        this.#onEvent(event);
      } catch (err) {
        // A throwing handler would unwind into the agent's own event loop.
        console.error("[pi-ui] event handler error:", err);
      }
    });
  }

  #onEvent(event) {
    this.lastActivity = Date.now();
    // Any event is new evidence about this run, so the wire check is re-armed
    // and a previous proof-of-life no longer describes the current silence.
    this.wireAliveNoticed = false;
    if (event.type === "agent_start") {
      this.isStreaming = true;
      // A new run starts clean: the previous run's stall verdict must not carry
      // over and make the sweeper skip this one.
      this.stallAborted = false;
      this.wireCheckedAt = 0;
      this.toolCallsThisRun = 0;
      this.runningTools = 0;
      this.runProducedOutput = false;
    } else if (event.type === "agent_settled" || event.type === "agent_end") {
      this.isStreaming = false;
      // A run that ended on its own closes the exchange, so the next prompt
      // starts with a full retry budget even if it repeats the same text.
      // A stall-aborted run deliberately keeps its budget: re-sending is what
      // the budget caps, and clearing it here would let a broken endpoint loop.
      if (!this.stallAborted) this.autoRetries = 0;
    }
    if (event.type === "tool_execution_start") {
      this.toolCallsThisRun += 1;
      this.runningTools += 1;
      this.runProducedOutput = true;
    } else if (event.type === "tool_execution_end") {
      // Clamped: a result arriving for a call this listener never saw start
      // (a session adopted mid-run) must not drive the count negative, or the
      // guard would then need to be `!== 0` and would stop explaining anything.
      this.runningTools = Math.max(0, this.runningTools - 1);
    } else if (event.type === "message_update") {
      // Streamed text or thinking means the reader has already seen the turn
      // start. Recorded from the event, not from the branch afterwards: a
      // dropped connection can lose the persisted copy of text that was
      // rendered, and the *rendered* copy is what a re-send would duplicate.
      if (hasVisibleDelta(event)) this.runProducedOutput = true;
    }
    // Queue state is only emitted on change, and `get_state` may not carry the
    // text, so keep the last snapshot for a tab that re-attaches mid-run.
    if (event.type === "queue_update") {
      this.queued = {
        steering: [...(event.steering || [])],
        followUp: [...(event.followUp || [])],
      };
    }

    // Bracket bash calls here, where every event passes, so a `nohup … &` is
    // attributed to the call that started it. The process table diffing lives
    // in the server module, which receives these two hooks.
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      this.pool.onBashStart?.(this, event.toolCallId);
    } else if (event.type === "tool_execution_end") {
      this.pool.onBashEnd?.(this, event.toolCallId);
    }

    this.broadcast(toJsonEvent(event));
  }

  /**
   * Replay one event as if the agent had produced it.
   *
   * Only the smoke test uses this. The bash bracketing above only runs for a
   * real agent tool call, which needs a model and credentials, so without a way
   * to inject the two events the leftover-process tracking would have no
   * automated coverage at all. It goes through exactly the same path as a live
   * event, so the hook logic under test is the shipping logic.
   */
  injectEventForTest(event) {
    this.#onEvent(event);
  }

  broadcast(record) {
    let payload;
    try {
      payload = `data: ${JSON.stringify(record)}\n\n`;
    } catch (err) {
      console.error("[pi-ui] could not serialize event:", err.message);
      return;
    }
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        // the SSE close handler drops the client entry
      }
    }
  }

  sendQueueSnapshot(res) {
    const { steering, followUp } = this.queued;
    if (!steering.length && !followUp.length) return;
    try {
      res.write(`data: ${JSON.stringify({ type: "queue_update", steering, followUp })}\n\n`);
    } catch {
      // client is gone; the close handler cleans up
    }
  }

  /** Replay dialogs this session is still waiting on.
   *
   *  A question asked while no tab was attached reached nobody, and the
   *  extension is blocked on it — `ask_user_question` and permission gates pass
   *  no timeout, so it never resolves by itself. Sending the pending records on
   *  attach (and on open) is the only way the user can answer them.
   *
   *  The same record is sent to every attached tab: two windows on one session
   *  is a supported arrangement, and whichever answers first wins (the loser's
   *  answer is dropped by `ExtensionUi.answer` returning false). */
  sendPendingDialogs(res) {
    for (const record of this.ui.snapshot()) {
      try {
        res.write(`data: ${JSON.stringify(record)}\n\n`);
      } catch {
        // client is gone; the close handler cleans up
        return;
      }
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ui.cancelAll();
    try {
      await this.session.dispose();
    } catch (err) {
      console.error("[pi-ui] session dispose failed:", err.message);
    }
  }
}

export class SessionHost {
  /**
   * @param {object} options
   * @param {object} options.sdk      the loaded SDK module
   * @param {string} options.cwd      default working directory
   * @param {string} options.sessionDir pi's session directory (for listing)
   * @param {Map<string, { res: import("node:http").ServerResponse | null, key: string | null, detachedAt: number }>} options.clients
   *   clientId -> SSE response. Owned by the server module; the host reads and
   *   writes the same map so a broadcast can reach every attached tab.
   */
  constructor({ sdk, cwd, sessionDir, clients }) {
    this.sdk = sdk;
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.images = new ImageStash();

    /** key -> Session. File-backed sessions are keyed "file:<abs>"; a brand-new
     *  one gets "slot:<uuid>" until pi persists it. */
    this.sessions = new Map();
    /** abs session file -> key, for live sessions only. */
    this.fileAlias = new Map();
    /** clientId -> { res, key, detachedAt }. Owned by the server, which is the
     *  only place an SSE response is written and closed; the host reads and
     *  writes the same map so a broadcast can find every attached tab. */
    this.clients = clients;
    /** cwd -> the part of a workspace that is genuinely shared by its sessions. */
    this.workspaces = new Map();
    /** cwd -> in-flight promise, so two tabs opening at once share one build. */
    this.workspacesPending = new Map();
    /** One pre-built `servicesFor` result, tagged with its cwd: { cwd, promise }.
     *  Building a session's own services (model runtime + resource loader) is
     *  the bulk of `/api/open` for a session that is not already running, and
     *  it does not depend on which session is being opened — only on the cwd.
     *  Keeping the most recently used workspace's next build in flight turns
     *  that cost into background work. Replaced rather than accumulated, so a
     *  server that has seen many projects still holds at most one spare. */
    this.spareServices = null;
    /** Keeps the refill off the open's own critical path; see queueWarmServices. */
    this.warmTimer = null;
    this.warmTimerCwd = null;
  }

  // -------------------------------------------------------------------------
  // workspace services
  // -------------------------------------------------------------------------

  /** The shareable half of a workspace's services. Concurrent callers share one
   *  build.
   *
   *  Deliberately NOT the whole `AgentSessionServices`: those bundle a resource
   *  loader, and behind it the extension runtime that every session built from
   *  the same object would then share. `AgentSession.dispose()` calls
   *  `extensionRunner.invalidate()` on that runtime, so one session going away —
   *  the idle reaper, or the old session a new/fork/switch hands off from —
   *  leaves every other session in the workspace with extension handlers that
   *  throw "This extension ctx is stale", and every session opened afterwards
   *  reports the same error on its own `session_start`. Rebuilding the loader
   *  per session is what keeps the runtimes separate.
   *
   *  The `ModelRuntime` is NOT shared either, for a second and unrelated reason.
   *  A `ModelRuntime` holds ONE registration per provider, and extensions
   *  re-register on every `session_start` (`pi-cursor-sdk` calls
   *  `registerProvider` there). Because `registerProvider` replaces the previous
   *  registration, opening a sibling session in the same workspace silently
   *  takes the provider over from the session that already owned it. Cursor
   *  stamps each request with a receipt naming the owning registration and
   *  fails closed when the receipt and the current registration disagree:
   *
   *    "Cursor provider ownership is unavailable: this request does not belong
   *     to the active Cursor registration."
   *
   *  That error is sticky (the displaced session never gets its registration
   *  back, so `continue` fails forever, whatever the model), and it does not
   *  heal on reload because the reloading session takes the provider over in
   *  turn. Each session therefore gets its own `ModelRuntime`; it costs ~6-10 ms
   *  to build, and its model catalog converges to the same list. Only the
   *  settings manager is genuinely shareable. */
  async workspaceFor(cwd) {
    const resolved = path.resolve(cwd);
    const cached = this.workspaces.get(resolved);
    if (cached) return cached;
    const pending = this.workspacesPending.get(resolved);
    if (pending) return pending;
    const build = (async () => {
      try {
        const services = await this.sdk.createAgentSessionServices({ cwd: resolved });
        // Keep only the settings manager. Dropping the services object here is
        // what drops the model runtime and the loader with it.
        const shared = { settingsManager: services.settingsManager };
        this.workspaces.set(resolved, shared);
        return shared;
      } finally {
        this.workspacesPending.delete(resolved);
      }
    })();
    this.workspacesPending.set(resolved, build);
    return build;
  }

  /** One session's own services: the workspace's shared settings plus a fresh
   *  model runtime and a fresh resource loader, hence a fresh extension runtime
   *  and its own provider registrations. */
  async servicesFor(cwd) {
    const resolved = path.resolve(cwd);
    const shared = await this.workspaceFor(resolved);
    const spare = this.spareServices;
    if (spare && spare.cwd === resolved) {
      this.spareServices = null;
      const ready = await spare.promise.catch(() => null);
      // Refill for the next open.
      this.queueWarmServices(resolved);
      if (ready) return ready;
    }
    const fresh = await this.sdk.createAgentSessionServices({
      cwd: resolved,
      settingsManager: shared.settingsManager,
    });
    // A workspace other than the one the spare was built for: move the spare
    // here, so its second open (and every one after) is warm too.
    if (!this.spareServices || this.spareServices.cwd !== resolved) this.queueWarmServices(resolved);
    return fresh;
  }

  /** Queue the next build behind the commands an open is immediately followed
   *  by (`get_entries`, `get_state`, `get_session_stats`). Building it inline
   *  puts ~20 ms of synchronous extension work in front of those, which showed
   *  up as a 21 ms empty transcript fetch; 100 ms later those follow-ups are
   *  done and nobody is waiting, while a real click on a session is seconds
   *  away. */
  queueWarmServices(cwd) {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimerCwd = path.resolve(cwd);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      this.warmTimerCwd = null;
      this.warmServices(cwd);
    }, 100);
    this.warmTimer.unref?.();
  }

  /** Build one session's services ahead of the open that will need them. This is
   *  the same per-session pair `servicesFor` returns — its own runtime and
   *  loader, never shared with a live session — so pre-building it only moves
   *  the work earlier; it does not weaken the isolation described above. */
  warmServices(cwd) {
    const resolved = path.resolve(cwd);
    const promise = this.workspaceFor(resolved).then((shared) =>
      this.sdk.createAgentSessionServices({ cwd: resolved, settingsManager: shared.settingsManager })
    );
    this.spareServices = { cwd: resolved, promise };
    promise.catch(() => {
      if (this.spareServices && this.spareServices.promise === promise) this.spareServices = null;
    });
    return promise;
  }

  /** Forget a workspace so the next open re-reads its extensions and settings (a
   *  `/reload`, or an extension installed while the server ran). */
  dropWorkspace(cwd) {
    const resolved = path.resolve(cwd);
    this.workspaces.delete(resolved);
    if (this.spareServices && this.spareServices.cwd === resolved) this.spareServices = null;
    if (this.warmTimer && this.warmTimerCwd === resolved) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
      this.warmTimerCwd = null;
    }
  }

  /**
   * The session directory for one working directory.
   *
   * pi groups sessions per cwd: `<sessionRoot>/--<cwd with separators as dashes>--`.
   * The SDK's `sessionDir` argument is that LEAF directory, not the root — passing
   * the root makes pi write sessions directly under it, which then cannot be found
   * again by cwd and does not match the layout the sidebar lists. Deriving it here
   * keeps pi-ui's files where the `pi` command would put them.
   */
  #sessionDirFor(cwd) {
    const resolved = path.resolve(cwd);
    const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return path.join(this.sessionDir, safe);
  }

  // -------------------------------------------------------------------------
  // client bookkeeping
  // -------------------------------------------------------------------------

  clientEntry(id) {
    let c = this.clients.get(id);
    if (!c) {
      c = { res: null, key: null, detachedAt: 0 };
      this.clients.set(id, c);
    }
    return c;
  }

  clientsOn(key) {
    const out = [];
    for (const c of this.clients.values()) if (c.key === key && c.res) out.push(c.res);
    return out;
  }

  // -------------------------------------------------------------------------
  // open / attach
  // -------------------------------------------------------------------------

  /** Resolve where a session lives and which cwd it belongs to.
   *  @param {{ sessionFile?: string | null, cwd?: string | null }} target */
  async #resolveTarget({ sessionFile, cwd }) {
    if (!sessionFile) {
      return { cwd: cwd ? path.resolve(cwd) : this.cwd, file: null };
    }
    const abs = path.resolve(sessionFile);
    // A live session already owns this path; the in-memory one is authoritative.
    if (this.fileAlias.has(abs) || this.sessions.has(`file:${abs}`)) {
      return { cwd: cwd ? path.resolve(cwd) : this.cwd, file: abs, reuse: true };
    }
    const header = await this.#sessionHeader(abs);
    if (header) {
      // The header records the cwd the session ran in. Trust it over the client so
      // a stale cached frontend cannot build a workspace's services in the wrong
      // directory (which would load the wrong project's extensions and skills).
      const headerCwd = typeof header.cwd === "string" && header.cwd ? path.resolve(header.cwd) : null;
      return { cwd: headerCwd || (cwd ? path.resolve(cwd) : this.cwd), file: abs, reuse: false };
    }
    // The file is missing. That is not an error: pi creates a session file lazily,
    // so a path reported minutes ago may not be on disk yet — and `pi --session
    // <missing path>` opens an empty session there rather than refusing. Match
    // that, so a reload of a brand-new session lands on an empty conversation
    // instead of a dead link. The cwd comes from the URL, since there is no header.
    return { cwd: cwd ? path.resolve(cwd) : this.cwd, file: abs, reuse: false, fresh: true };
  }

  /** Read a session file's header line, or null when there is not one.
   *
   *  One read answers both questions the caller has: whether this is a session at
   *  all, and which cwd it ran in. */
  async #sessionHeader(file) {
    try {
      const handle = await fsp.open(file, "r");
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        if (bytesRead === 0) return null;
        const header = JSON.parse(buf.toString("utf8", 0, bytesRead).split("\n")[0]);
        return header?.type === "session" ? header : null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Attach a browser client to the session for `sessionFile` (creating it when
   * needed), or to a brand-new session. Never disposes another session: switching
   * away in the UI must leave the old run going, exactly as the process pool did.
   */
  async open({ client, sessionFile, cwd }) {
    const c = this.clientEntry(client);
    // A live session may already own a path that has no file yet (pi persists
    // lazily). Resolve through the alias first so a reload attaches to it instead
    // of being rejected or duplicated.
    let key = null;
    if (sessionFile) {
      const abs = path.resolve(sessionFile);
      const aliasKey = this.fileAlias.get(abs);
      if (aliasKey && this.sessions.has(aliasKey)) key = aliasKey;
    }
    let workdir = cwd ? path.resolve(cwd) : this.cwd;
    let file = sessionFile ? path.resolve(sessionFile) : null;
    if (!key) {
      const resolved = await this.#resolveTarget({ sessionFile, cwd });
      workdir = resolved.cwd;
      file = resolved.file;
      key = file ? `file:${file}` : `slot:${randomUUID()}`;
    }

    let session = this.sessions.get(key);
    if (!session) {
      // The client's key is assigned BEFORE the session is created, because
      // `#create()` binds extensions and `bindExtensions` fires `session_start`
      // — where a permission gate or trust prompt may call `ui.select()`. Every
      // extension-UI record fans out through `broadcast()` → `clientsOn(key)`,
      // which matches on `c.key`; with the key set afterwards nothing matches,
      // the question reaches no tab, and `/api/open` blocks until the dialog's
      // own timeout (or forever, for the no-timeout shape `ask_user_question`
      // uses). `#create()` registers the session before it binds, so the answer
      // route can find it too. Rolled back on failure so a broken cwd does not
      // leave the tab pointing at a session that was never created.
      c.key = key;
      try {
        session = await this.#create({ key, cwd: workdir, file });
      } catch (err) {
        c.key = null;
        throw err;
      }
    } else {
      c.key = key;
    }
    this.learnSessionFile(session);

    session.lastActivity = Date.now();
    // The attach handshake (hello, queue snapshot, leftover processes) lives in
    // the server's openSession(), which owns the SSE response. Repeating it here
    // would need a callback into the server for no gain.
    return {
      ok: true,
      sessionFile: session.sessionFile,
      cwd: session.cwd,
      sessionId: session.session.sessionId,
    };
  }

  /** Create and bind one session. */
  async #create({ key, cwd, file }) {
    const services = await this.servicesFor(cwd);
    let manager;
    if (file) {
      manager = this.sdk.SessionManager.open(file, this.#sessionDirFor(cwd), cwd);
      // `open()` invents its own path when the file is absent (a fresh session
      // writes nothing yet), which would detach the session from the path the
      // browser has in its URL. Pin it to the requested path so the next reload
      // finds the same conversation instead of yet another empty one.
      if (manager.getSessionFile() !== file) {
        const written = await this.#exists(file);
        if (!written) manager.setSessionFile(file);
      }
    } else {
      manager = this.sdk.SessionManager.create(cwd, this.#sessionDirFor(cwd));
    }
    const { session } = await this.sdk.createAgentSessionFromServices({
      services,
      sessionManager: manager,
    });
    const host = new Session(this, key, { cwd, sessionFile: file, session });
    // Register BEFORE binding. `bind()` fires `session_start`, where an extension
    // may ask a question; the answer arrives at `/api/ui-response`, which finds
    // the session through `sessionForClient()` → `this.sessions`. Unregistered,
    // that lookup returns null and the route answers 503 "no session — open one
    // first", so the dialog could be delivered but never answered, and `open()`
    // would wait out the bind bound. The client's own key is already set by the
    // caller, so fan-out reaches its tab from the first record.
    this.sessions.set(key, host);
    if (file) this.fileAlias.set(file, key);
    try {
      await host.bind();
    } catch (err) {
      // `bind()` swallows extension errors itself, so this is a genuine failure
      // to start the session: drop the half-built entry rather than leave a
      // session nobody can use occupying the slot.
      this.sessions.delete(key);
      if (file) this.fileAlias.delete(file);
      throw err;
    }
    return host;
  }

  /** Whether a path exists on disk. */
  async #exists(file) {
    try {
      await fsp.access(file);
      return true;
    } catch {
      return false;
    }
  }

  /** A "slot" session learns the file pi persisted once it writes one, so another
   *  tab clicking the new row attaches instead of creating a second session. */
  /**
   * Record the file a session writes to, so this path can be attached to later.
   *
   * pi reports `sessionFile` before it writes anything, so the alias is the only
   * way a page reload can find a session whose file does not exist yet. Safe to
   * call repeatedly: a file already claimed by another live session is left alone.
   */
  learnSessionFile(sessionHost) {
    if (sessionHost.sessionFile) return;
    const file = sessionHost.session.sessionFile;
    if (!file) return;
    const abs = path.resolve(file);
    if (this.fileAlias.has(abs) && this.fileAlias.get(abs) !== sessionHost.key) return;
    sessionHost.sessionFile = abs;
    this.fileAlias.set(abs, sessionHost.key);
  }

  sessionForClient(client) {
    const c = this.clients.get(client);
    if (!c || !c.key) return null;
    return this.sessions.get(c.key) || null;
  }

  // -------------------------------------------------------------------------
  // commands — the RPC command surface, answered from memory
  // -------------------------------------------------------------------------

  /**
   * Execute one RPC-shaped command against a session.
   *
   * The shape returned is `{ success, data | error }` for `/api/cmd` to wrap,
   * so the browser's `cmd()` helper keeps working unchanged.
   */
  async command(sessionHost, command) {
    const session = sessionHost.session;
    switch (command.type) {
      case "get_state":
        return {
          data: {
            model: session.model,
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            steeringMode: session.steeringMode,
            followUpMode: session.followUpMode,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            autoCompactionEnabled: session.autoCompactionEnabled,
            messageCount: session.messages.length,
            pendingMessageCount: session.pendingMessageCount,
          },
        };

      case "get_entries": {
        const manager = session.sessionManager;
        let entries = manager.getEntries();
        if (command.since !== undefined) {
          const at = entries.findIndex((e) => e.id === command.since);
          if (at === -1) return { success: false, error: `Entry not found: ${command.since}` };
          entries = entries.slice(at + 1);
        }
        return {
          data: {
            entries: offloadEntries(entries, this.images),
            leafId: manager.getLeafId(),
          },
        };
      }

      case "get_messages":
        return {
          data: {
            messages: session.messages.map((m) => {
              const entry = { type: "message", message: m };
              return offloadImageMessage(entry, this.images).message;
            }),
          },
        };

      case "get_session_stats":
        return { data: session.getSessionStats() };

      case "get_available_models": {
        // The snapshot is synchronous: the RPC mode reads it the same way, and
        // waiting on credential resolution here would stall the model picker.
        const models = session.modelRuntime.getAvailableSnapshot();
        return { data: { models } };
      }

      case "get_available_thinking_levels":
        return { data: { levels: session.getAvailableThinkingLevels() } };

      case "get_commands": {
        const commands = [];
        for (const command of session.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: command.invocationName,
            description: command.description,
            source: "extension",
            sourceInfo: command.sourceInfo,
          });
        }
        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { data: { commands } };
      }

      case "set_model": {
        const model = session.modelRuntime.getModel(command.provider, command.modelId);
        if (!model) return { success: false, error: `Unknown model ${command.provider}/${command.modelId}` };
        await session.setModel(model);
        return { data: session.model };
      }

      case "set_thinking_level":
        session.setThinkingLevel(command.level);
        return { data: undefined };

      case "set_steering_mode":
        session.setSteeringMode(command.mode);
        return { data: undefined };

      case "set_follow_up_mode":
        session.setFollowUpMode(command.mode);
        return { data: undefined };

      case "set_auto_compaction":
        session.setAutoCompactionEnabled(command.enabled !== false);
        return { data: undefined };

      case "set_auto_retry":
        session.setAutoRetryEnabled(command.enabled !== false);
        return { data: undefined };

      case "set_session_name":
        session.setSessionName(command.name);
        return { data: undefined };

      case "get_last_assistant_text":
        return { data: { text: session.getLastAssistantText() ?? null } };

      case "get_fork_messages":
        return { data: { messages: session.getUserMessagesForForking() } };

      case "get_tree":
        return {
          data: {
            tree: offloadTree(session.sessionManager.getTree(), this.images),
            leafId: session.sessionManager.getLeafId(),
          },
        };

      case "compact": {
        const result = await session.compact(command.customInstructions);
        return { data: result };
      }

      case "abort":
        await session.abort();
        return { data: undefined };

      case "abort_retry":
        session.abortRetry();
        return { data: undefined };

      case "abort_bash":
        session.abortBash();
        return { data: undefined };

      case "clear_queue": {
        const cleared = session.clearQueue();
        return {
          data: {
            steering: cleared?.steering ?? [],
            followUp: cleared?.followUp ?? [],
          },
        };
      }

      case "steer": {
        const disposition = await session.steer(command.message, command.images, { source: "rpc" });
        return { data: { disposition } };
      }

      case "follow_up": {
        const disposition = await session.followUp(command.message, command.images, { source: "rpc" });
        return { data: { disposition } };
      }

      case "export_html": {
        const file = session.exportToHtml(command.outputPath);
        return { data: { path: file } };
      }

      // `prompt` is handled by the caller so it can answer before the run ends;
      // reaching here means the caller did not special-case it.
      default:
        return { success: false, error: `pi-ui does not implement the "${command.type}" command` };
    }
  }

  /**
   * Start a prompt. Resolves as soon as pi accepts it (via the preflight hook),
   * not when the run finishes: the browser expects the acknowledgement while
   * output streams in, exactly as RPC mode answers `prompt`.
   */
  prompt(sessionHost, command) {
    const session = sessionHost.session;
    // Remembered before the send: a run killed by a dead connection must be
    // re-sendable, and by then the text only exists in the browser's composer
    // history. A prompt that differs from the last one is a new message, so its
    // retry budget starts over.
    //
    // A steer is skipped: it is text injected into a run already underway, so
    // re-sending it would replay a mid-turn instruction as if it opened the
    // turn. `streamingBehavior` says which shape this is — a fresh send carries
    // nothing there.
    const message = command.message;
    const startsTurn = typeof message === "string" && command.streamingBehavior !== "steer";
    if (startsTurn) {
      // The leaf *before* this send: the entry the message is about to be
      // appended under. A re-send returns here first, so the failed attempt's
      // user message is not still on the branch when the new one is appended.
      //
      // Recorded on every turn, not only when the text changes: typing the same
      // prompt twice is two turns, and keeping the older leaf would make a
      // re-send of the second one rewind past the first.
      sessionHost.lastPromptParentId = session.sessionManager.getLeafId() || null;
      if (message !== sessionHost.lastPrompt?.message || command.images?.length) {
        // A different message is a new intent, so its retry budget starts over.
        if (message !== sessionHost.lastPrompt?.message) sessionHost.autoRetries = 0;
        sessionHost.lastPrompt = { message, images: command.images };
      }
    }
    return new Promise((resolve) => {
      let answered = false;
      const answer = (result) => {
        if (answered) return;
        answered = true;
        resolve(result);
      };
      void session
        .prompt(command.message, {
          images: command.images,
          streamingBehavior: command.streamingBehavior,
          source: "rpc",
          preflightResult: (disposition) => {
            if (!PROMPT_DISPOSITIONS.has(disposition)) {
              answer({ success: false, error: `unexpected disposition: ${disposition}` });
              return;
            }
            answer({ data: { disposition } });
          },
        })
        .then(() => {
          // A prompt a handler consumed without preflighting still counts.
          answer({ data: { disposition: "handled" } });
          this.learnSessionFile(sessionHost);
        })
        .catch((err) => {
          answer({ success: false, error: err.message });
        });
      // If preflight never fires and the promise never settles (a run that keeps
      // going), the tab must still get its acknowledgement.
      setTimeout(() => answer({ data: { disposition: "started" } }), 60_000).unref?.();
    });
  }

  // -------------------------------------------------------------------------
  // in-process session replacement (extension commands use these)
  // -------------------------------------------------------------------------

  async newSessionInPlace(sessionHost, options) {
    const { session } = await this.sdk.createAgentSessionFromServices({
      services: await this.servicesFor(sessionHost.cwd),
      sessionManager: this.sdk.SessionManager.create(sessionHost.cwd, this.#sessionDirFor(sessionHost.cwd)),
    });
    await this.#replace(sessionHost, session, options?.withSession);
    return { cancelled: false };
  }

  async forkInPlace(sessionHost, entryId) {
    sessionHost.session.sessionManager.branch(entryId);
    const newFile = sessionHost.session.sessionManager.createBranchedSession(entryId);
    if (newFile) await this.switchInPlace(sessionHost, newFile);
    return { cancelled: false, selectedText: "" };
  }

  async switchInPlace(sessionHost, sessionPath) {
    const abs = path.resolve(sessionPath);
    const { cwd } = await this.#resolveTarget({ sessionFile: abs });
    const { session } = await this.sdk.createAgentSessionFromServices({
      services: await this.servicesFor(cwd),
      sessionManager: this.sdk.SessionManager.open(abs, this.#sessionDirFor(cwd), cwd),
    });
    await this.#replace(sessionHost, session);
    return { cancelled: false };
  }

  /** Swap the AgentSession inside an existing host, keeping the browser's
   *  attachment, and rebind what the old session owned. */
  async #replace(sessionHost, session, withSession) {
    sessionHost.unsubscribe?.();
    try {
      await sessionHost.session.dispose();
    } catch {
      // the old session is being abandoned either way
    }
    sessionHost.session = session;
    sessionHost.sessionFile = session.sessionFile ? path.resolve(session.sessionFile) : null;
    if (sessionHost.sessionFile) this.fileAlias.set(sessionHost.sessionFile, sessionHost.key);
    await sessionHost.bind();
    if (typeof withSession === "function") {
      try {
        await withSession(session.createReplacedSessionContext());
      } catch (err) {
        sessionHost.broadcast({ type: "server", event: "extension_bind_error", error: err.message });
      }
    }
    sessionHost.broadcast({ type: "server", event: "session_replaced", sessionFile: sessionHost.sessionFile });
  }

  // -------------------------------------------------------------------------
  // images
  // -------------------------------------------------------------------------

  imageData(id) {
    return this.images.get(id);
  }

  // -------------------------------------------------------------------------
  // idle reaping
  // -------------------------------------------------------------------------

  /** Dispose sessions nobody is watching. A running session is left alone: the
   *  user may have closed the tab while a long run continues, and re-attaching
   *  to it is the whole point of the pool. */
  reapIdle(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (this.clientsOn(key).length || session.isStreaming) continue;
      if (now - session.lastActivity < IDLE_REAP_MS) continue;
      console.log(`[pi-ui] disposing idle session (key=${key})`);
      this.#drop(key);
    }
  }

  /**
   * Abort a run whose provider connection has gone silent.
   *
   * ## Why a watchdog is needed at all
   *
   * A dropped provider connection does not fail: no error reaches the SDK, no
   * `close` fires, and the request promise never settles. The process then sits
   * at ~0% CPU waiting on a socket the kernel already marked CLOSED, and the run
   * stays "streaming" forever. Observed in practice for twelve minutes, and
   * across the session files on this machine eleven turns were still hanging
   * with the oldest weeks old — the state never self-heals.
   *
   * ## Why silence alone is not enough — and what replaces it
   *
   * The event stream cannot tell a dead connection from a slow one. Measured
   * over this machine's 791 Cursor turns: a first token takes 26 s at the
   * median, 91 s at p90 and 320 s at p99, and nine turns waited past 300 s and
   * then answered. Any single wall-clock number is therefore wrong in one
   * direction — too low aborts work that was about to land, too high burns
   * minutes on a connection that is provably gone.
   *
   * So the deadline became the *fallback*, and two checks refine it — see
   * `sdk/wire.js` for the measurements behind both. Only one of them can end a
   * run early:
   *
   *  - a live socket (`bytesRead` advancing). This never aborts: it only says
   *    the wait belongs to the provider, so the tab stops implying a fault.
   *    A *closed* socket is deliberately not used — measured, undici reports an
   *    error when it recycles a healthy idle connection, and a real HTTP/2 drop
   *    reports none, so a close proves nothing either way.
   *  - reachability. A dead route (network off, VPN down) sends no FIN at all,
   *    so no socket event ever fires — and this machine's TCP keepalive is two
   *    hours, far longer than any run. One probe to the host the run talks to
   *    answers it, and it is only sent once a run has been quiet that long.
   *
   * Everything here degrades to the old behaviour: no socket records, no
   * channel, another provider, a probe that comes back fine — all leave the
   * fallback in charge.
   *
   * Reporting stays on the ordinary event stream (`server` / `run_stalled`) so
   * the tab shows why the turn stopped instead of freezing, and the message
   * carries what was actually observed so "may have dropped" is never asserted
   * over a connection that was checked.
   */
  reapStalled(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (!session.isStreaming) continue;
      // Already aborted this run: one notice per dead run, not one per sweep.
      if (session.stallAborted) continue;
      const silentFor = now - session.lastActivity;
      if (silentFor < STALL_ABORT_AFTER_MS) {
        // Below the fallback: only a *positive* "the connection is gone" can
        // end this run early. A probe in flight or a clean verdict changes
        // nothing, so a slow provider is never cut short by this branch.
        // Errors are contained here: this runs from a interval, so a rejected
        // promise would otherwise surface as an unhandled rejection.
        void this.#checkWireForStall(session, silentFor, now).catch((err) => {
          console.error("[pi-ui] wire check failed:", err?.message || err);
        });
        continue;
      }
      this.#abortStalled(session, silentFor, { reason: "fallback" });
    }
  }

  /**
   * Ask the network whether a short silence is a dead connection.
   *
   * Three steps, in increasing cost: read the requests the transport already
   * failed, then the sockets the SDK owns, then — only if those say nothing —
   * send one reachability probe.
   *
   * Fire-and-forget, and re-asked on `WIRE_RECHECK_MS`: the first probe can
   * succeed while the route drops later, so a run that outlives its connection
   * should not have to sit out the five-minute fallback because the check ran
   * too early.
   */
  async #checkWireForStall(session, silentFor, now) {
    if (silentFor < WIRE_CHECK_AFTER_MS) return;
    // One check per interval, not per sweep (the sweep runs every 15 s).
    if (session.wireCheckedAt && now - session.wireCheckedAt < WIRE_RECHECK_MS) return;
    session.wireCheckedAt = now;
    const since = session.lastActivity;
    // A tool that is running is the reason there are no events: a build, a test
    // suite or a long `grep` emits nothing for its whole duration. That is why
    // no *inference from silence* may run here — but it is not a reason to
    // ignore a transport that has already reported an error. A local command
    // says nothing about whether the provider connection under this run is
    // still alive, so the request-level check below is done either way and only
    // the silence-based halves are skipped.
    const toolRunning = session.runningTools > 0;
    // Request level first: this is the only *positive* evidence of a dead
    // connection, and unlike the socket records it needs no provider allow-list,
    // so a Cursor, WorkBuddy or Anthropic run is all covered by the same check.
    // `since` is what keeps a run that already recovered out of this: pi emits
    // `auto_retry_start` before retrying, which moves `since` past the failure.
    const transport = transportVerdict({ since });
    if (transport.state === "broken") {
      this.#abortStalled(session, silentFor, {
        reason: "transport failed",
        detail: `${transport.code} on ${transport.origin || "the provider"} after ${Math.round(
          (transport.openMs || 0) / 1000
        )}s`,
      });
      return;
    }
    // Everything below only ever *softens* the wait, so a running tool decides
    // it: a long build is a silence with a known cause.
    if (toolRunning) return;
    // Only the Cursor transport is observable at the socket level. The socket
    // records are process-wide, so a Cursor connection another session opened
    // must never become evidence about a WorkBuddy or Anthropic run. Those keep
    // the fallback for the socket half, while the request half above already
    // covered them.
    if (session.session?.model?.provider !== "cursor") return;
    // A socket carrying bytes proves the transport is up: say so once, and let
    // the fallback own the decision. This is the only use of the socket layer —
    // a *closed* socket is not evidence of anything (see `sdk/wire.js`).
    // The request level is consulted too, because its chunk counter sees the
    // same traffic through a transport-agnostic channel.
    if (wireVerdict().state === "alive" || transport.state === "alive") {
      if (!session.wireAliveNoticed) {
        session.wireAliveNoticed = true;
        session.broadcast({
          type: "server",
          event: "run_waiting",
          silentForMs: silentFor,
          detail: "the connection to the provider is up; the model has not answered yet",
        });
      }
      return;
    }
    // Nothing observed. Ask the network directly — this is the case no socket
    // event can report, and the only one that may end the run early.
    //
    // The host is the one observed on a real Cursor socket, never
    // `model.baseUrl`: pi-cursor-sdk registers that as `https://cursor.com`
    // while the run transport is `api2.cursor.sh`, so probing the model's URL
    // would test the web host and prove nothing about the run.
    const host = wireHost();
    if (!host) return;
    const probe = await probeHost(`https://${host}/`);
    // The run may have resumed while the probe was in flight; aborting now
    // would kill a turn that is streaming.
    if (!session.isStreaming || session.lastActivity !== since) return;
    if (!probe.reachable) {
      this.#abortStalled(session, silentFor, {
        reason: "network unreachable",
        detail: probe.error || "no answer from the provider's host",
      });
    }
  }

  /**
   * End one silent run and say why.
   *
   * `reason` decides three things: the sentence, whether the failure was *proven*
   * by evidence rather than inferred from silence, and — through `proven` —
   * whether the turn can be re-sent without the user asking.
   *
   * Two reasons are evidence-backed, and they are different evidence:
   *
   *  - `network unreachable` — a probe got no answer, so nothing can have been
   *    streaming and the prompt provably never reached the provider.
   *  - `transport failed` — a long-lived provider request died with a transport
   *    error after this run's last event. That proves the *connection* is gone,
   *    which is all the abort needs; it does not prove the prompt never arrived,
   *    because it may have died mid-answer. The sentence says so rather than
   *    reusing the unreachable wording.
   *
   * Re-sending is safe for both for the same reason, and it is not the reason
   * someone would guess: the guarantee is `#canAutoRetry`, which refuses a turn
   * that rendered anything or ran any tool. So the worst case of a re-send is a
   * second generation the reader never saw, bounded by `AUTO_RETRY_MAX`; the
   * alternative is a turn the user has to notice and retype.
   *
   * The 5-minute fallback keeps the old behaviour entirely: it fires on silence
   * alone, which is not evidence of anything, so it stays unproven and manual.
   *
   * @param {Session} session
   * @param {number} silentFor
   * @param {{ reason?: string, detail?: string }} [options]
   */
  #abortStalled(session, silentFor, { reason, detail } = {}) {
    const key = session.key;
    session.stallAborted = true;
    const seconds = Math.round(silentFor / 1000);
    const why =
      reason === "network unreachable"
        ? `the provider could not be reached (${detail ?? "network error"})`
        : reason === "transport failed"
          ? `the connection to the provider failed (${detail ?? "transport error"})`
          : "the connection may have dropped";
    const proven = reason === "network unreachable" || reason === "transport failed";
    const canResend = proven && this.#canAutoRetry(session);
    console.error(
      `[pi-ui] run silent for ${seconds}s (key=${key}) — ${why}${canResend ? "; re-sending" : "; aborting"}`
    );
    // Broadcast before the abort: once it lands the transcript shows an
    // aborted turn with no reason, and the reason is the whole point.
    session.broadcast({
      type: "server",
      event: "run_stalled",
      silentForMs: silentFor,
      reason: reason ?? "fallback",
      proven,
      willRetry: canResend,
      message: canResend
        ? `${why} after ${seconds}s of silence — re-sending the message on a new connection.`
        : `no response from the provider for ${seconds}s — ${why}. The run was aborted; send the message again to retry.`,
    });
    void this.#abandonStalled(session).then(async ({ aborted }) => {
      if (!aborted) {
        // The abort did not land, so the run is still live as far as the SDK is
        // concerned. Clear the verdict so the next sweep tries again instead of
        // leaving the session streaming forever — and do not re-send into a run
        // that is still occupying the session.
        session.stallAborted = false;
        // The tab was told this run would be re-sent. It will not be, so say so
        // rather than leaving it waiting on a turn that never starts.
        if (canResend) {
          session.broadcast({
            type: "server",
            event: "run_retry_failed",
            error: "the stalled run could not be stopped in time",
          });
        }
        return;
      }
      if (canResend) await this.#resendAfterStall(session);
    });
  }

  /**
   * Abort a dead run without waiting on a promise that may never settle.
   *
   * `AgentSession.abort()` ends with `await waitForIdle()`, and on a connection
   * that is provably gone the run is exactly the thing that never becomes idle.
   * Waiting there would turn "the socket died" into "the abort hangs", so the
   * re-send would never happen — trading a five-minute hang for an unbounded
   * one. The abort is issued, and only the *wait* is bounded: the SDK still
   * tears its own side down, while the re-send stops depending on it.
   */
  async #abandonStalled(session, ms = ABORT_SETTLE_MS) {
    const aborting = session.session.abort();
    let timer = null;
    const bounded = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    try {
      const settled = aborting.then(
        () => true,
        (err) => {
          console.error("[pi-ui] stall abort failed:", err?.message || err);
          return false;
        }
      );
      return { aborted: await Promise.race([settled, bounded]) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Move the branch back to where the lost prompt started.
   *
   * Returns false when the branch holds work that must not be discarded. The
   * caller has already applied the authoritative check (`runProducedOutput`,
   * which counts what was *rendered*), so this is the second line of defence:
   * a branch that grew an assistant reply or a tool result for any reason — a
   * late write, a message the event stream did not attribute to this run — is
   * left alone rather than silently cut off.
   *
   * `navigateTree` refuses while the session is streaming, which is why this is
   * called after the abort has settled or been given up on.
   */
  async #rewindToPromptStart(session) {
    const target = session.lastPromptParentId;
    if (!target) return false;
    const manager = session.session.sessionManager;
    if (manager.getLeafId() === target) return true; // nothing was appended
    // Everything after the target is the dead attempt. A toolResult entry means
    // a tool ran (excluded earlier, but the check belongs with the branch, not
    // with a counter). An assistant entry is allowed to be there when it is the
    // one pi appends for an abort: `handleRunFailure` writes an assistant
    // message with empty text and `stopReason: "aborted"`, which is a marker,
    // not output. Anything else the model actually produced blocks the rewind.
    let cur = manager.getLeafEntry();
    const guard = new Set();
    while (cur && cur.id !== target && !guard.has(cur.id)) {
      guard.add(cur.id);
      const message = cur.type === "message" ? cur.message : null;
      if (message && message.role === "toolResult") return false;
      if (message && message.role === "assistant" && !isEmptyAbortMessage(message)) return false;
      cur = cur.parentId ? manager.getEntry(cur.parentId) : null;
    }
    if (!cur) return false; // the target is not on this branch: do not guess
    try {
      const result = await session.session.navigateTree(target, { summarize: false });
      return !result?.cancelled;
    } catch (err) {
      console.error("[pi-ui] rewind before re-send failed:", err?.message || err);
      return false;
    }
  }

  /** May this stalled run be re-sent without the user asking? */
  #canAutoRetry(session) {
    if (session.disposed) return false;
    // Any output means the reader watched this turn begin; re-sending would
    // paint the same lines twice, and the abandoned attempt's text is already
    // in the transcript where they can read it.
    if (session.runProducedOutput) return false;
    if (session.toolCallsThisRun > 0) return false;
    if (!session.lastPrompt?.message) return false;
    // Without the pre-send leaf there is nothing to rewind to, so the re-send
    // would stack a second copy of the prompt on the dead turn. Checked here
    // rather than after the abort: this is what `willRetry` promised the tab.
    if (!session.lastPromptParentId) return false;
    return session.autoRetries < AUTO_RETRY_MAX;
  }

  /**
   * Re-send the prompt the dead connection lost.
   *
   * A fresh `prompt()` starts a new request on a new connection, which is the
   * whole recovery: the SDK builds its agent per turn, so nothing of the dead
   * transport survives. The abort has been given `ABORT_SETTLE_MS` to land (see
   * `#abandonStalled`) — bounded, because the run it is aborting is the one that
   * never goes idle.
   *
   * Failure is reported, never retried: the budget is one attempt per prompt,
   * because a second failure means the endpoint, not the connection, is the
   * problem — and by then the user is watching.
   */
  async #resendAfterStall(session) {
    const pending = session.lastPrompt;
    if (!pending?.message) return;
    session.autoRetries += 1;
    // Take the dead attempt off the branch before appending the new one. The
    // failed turn left its own user message behind, so sending on top of it
    // would hand the model the same prompt twice — a different conversation
    // from the one the user is looking at, and a duplicate the UI would have to
    // paint. `navigateTree` moves the leaf without deleting anything, so the
    // abandoned attempt stays readable in history.
    //
    // Announced *after* the rewind, not before: the tab answers `run_retrying`
    // by re-reading the branch, and a refresh that raced the rewind would paint
    // the turn this is about to remove.
    const rewindable = await this.#rewindToPromptStart(session);
    if (!rewindable) {
      // A turn that produced visible output is not silently discarded: the tab
      // keeps what the reader already saw and the user decides.
      session.broadcast({
        type: "server",
        event: "run_retry_failed",
        error: "the lost turn had already produced output, so it was left in place",
      });
      return;
    }
    session.broadcast({ type: "server", event: "run_retrying", attempt: session.autoRetries });
    try {
      await session.session.prompt(pending.message, {
        images: pending.images,
        source: "rpc",
      });
    } catch (err) {
      session.broadcast({
        type: "server",
        event: "run_retry_failed",
        error: err?.message || String(err),
      });
    }
  }

  #drop(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    for (const [file, k] of this.fileAlias) if (k === key) this.fileAlias.delete(file);
    for (const c of this.clients.values()) if (c.key === key) c.key = null;
    void session.dispose();
  }

  async disposeAll() {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.fileAlias.clear();
    await Promise.all(all.map((s) => s.dispose()));
  }

  /** Live status for `/api/sessions`, keyed by the file the session writes. */
  activeStatus() {
    const out = new Map();
    for (const session of this.sessions.values()) {
      const file = session.sessionFile || session.session.sessionFile;
      if (!file) continue;
      out.set(path.resolve(file), {
        active: true,
        streaming: session.isStreaming,
        clients: this.clientsOn(session.key).length,
      });
    }
    return out;
  }
}

/** A raw image message for the offload helper's single-message form. */
function offloadImageMessage(entry, stash) {
  const [only] = offloadEntries([entry], stash);
  return only;
}

/** Offload images anywhere in a tree (get_tree). */
function offloadTree(nodes, stash) {
  return nodes.map((node) => ({
    ...node,
    entry: offloadImageMessage(node.entry, stash),
    children: node.children?.length ? offloadTree(node.children, stash) : [],
  }));
}
