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
    if (event.type === "agent_start") {
      this.isStreaming = true;
      // A new run starts clean: the previous run's stall verdict must not carry
      // over and make the sweeper skip this one.
      this.stallAborted = false;
    } else if (event.type === "agent_settled" || event.type === "agent_end") this.isStreaming = false;
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
    return this.sdk.createAgentSessionServices({
      cwd: resolved,
      settingsManager: shared.settingsManager,
    });
  }

  /** Forget a workspace so the next open re-reads its extensions and settings (a
   *  `/reload`, or an extension installed while the server ran). */
  dropWorkspace(cwd) {
    this.workspaces.delete(path.resolve(cwd));
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
   * ## Why it is not a plain deadline
   *
   * Silence alone does not distinguish a dead connection from a slow one, and a
   * slow one is common here: 2.19% of 37,872 measured healthy gaps exceed 60 s,
   * with p99 at 154 s. So the two jobs are split. The tab names the silence
   * after a minute (`STALL_FIRST_TOKEN_MS` in public/app.js) and aborts nothing;
   * this host aborts at STALL_ABORT_AFTER_MS, past 99.5% of every gap a working
   * run has produced. A false positive costs one re-sent message, and only for a
   * run that had already been silent for five minutes.
   *
   * Reporting goes through the ordinary event stream (`server` / `run_stalled`)
   * so the tab shows why the turn stopped instead of freezing. The sweep only
   * runs while a session is streaming, so the numbers above are the whole cost.
   */
  reapStalled(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (!session.isStreaming) continue;
      // Already aborted this run: one notice per dead run, not one per sweep.
      if (session.stallAborted) continue;
      const silentFor = now - session.lastActivity;
      if (silentFor < STALL_ABORT_AFTER_MS) continue;
      session.stallAborted = true;
      const seconds = Math.round(silentFor / 1000);
      console.error(`[pi-ui] run silent for ${seconds}s (key=${key}) — aborting`);
      // Broadcast before the abort: once it lands the transcript shows an
      // aborted turn with no reason, and the reason is the whole point.
      session.broadcast({
        type: "server",
        event: "run_stalled",
        silentForMs: silentFor,
        message: `no response from the provider for ${seconds}s — the run was aborted. The connection may have dropped; send the message again to retry.`,
      });
      void session.session.abort().catch((err) => {
        console.error("[pi-ui] stall abort failed:", err?.message || err);
        // The abort did not land, so the run is still live as far as the SDK is
        // concerned. Clear the verdict so the next sweep tries again instead of
        // leaving the session streaming forever.
        session.stallAborted = false;
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
