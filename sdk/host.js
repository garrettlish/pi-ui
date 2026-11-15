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

/** What `session.prompt()` reports for an accepted prompt, in the RPC shape. */
const PROMPT_DISPOSITIONS = new Set(["started", "queued", "handled"]);

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
    try {
      await this.session.bindExtensions(ui);
    } catch (err) {
      // An extension failing to bind must not make the session unusable.
      this.broadcast({ type: "server", event: "extension_bind_error", error: err.message });
    }
    this.observe();
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
    if (event.type === "agent_start") this.isStreaming = true;
    else if (event.type === "agent_settled" || event.type === "agent_end") this.isStreaming = false;

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
   *  per session is what keeps the runtimes separate; the model runtime (network
   *  catalog, provider registrations) and the settings manager are the parts
   *  that are safe, and expensive enough, to share. */
  async workspaceFor(cwd) {
    const resolved = path.resolve(cwd);
    const cached = this.workspaces.get(resolved);
    if (cached) return cached;
    const pending = this.workspacesPending.get(resolved);
    if (pending) return pending;
    const build = (async () => {
      try {
        const services = await this.sdk.createAgentSessionServices({ cwd: resolved });
        const shared = { modelRuntime: services.modelRuntime, settingsManager: services.settingsManager };
        this.workspaces.set(resolved, shared);
        return shared;
      } finally {
        this.workspacesPending.delete(resolved);
      }
    })();
    this.workspacesPending.set(resolved, build);
    return build;
  }

  /** One session's own services: the workspace's shared parts plus a fresh
   *  resource loader, hence a fresh extension runtime. */
  async servicesFor(cwd) {
    const resolved = path.resolve(cwd);
    const shared = await this.workspaceFor(resolved);
    return this.sdk.createAgentSessionServices({
      cwd: resolved,
      modelRuntime: shared.modelRuntime,
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
      session = await this.#create({ key, cwd: workdir, file });
      this.sessions.set(key, session);
      if (file) this.fileAlias.set(file, key);
    }
    this.learnSessionFile(session);

    c.key = key;
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
    await host.bind();
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
