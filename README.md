# pi-ui

A local web UI for the [pi coding agent](https://github.com/earendil-works/pi), built on the **pi SDK**
instead of a `pi --mode rpc` subprocess.

`pi` ships with a terminal UI. `pi-ui` puts the same agent in a browser and adds what a terminal is
bad at: browsing every past session across every project, and inspecting exactly what the model sent
and received — request arguments, live tool output, full responses, token usage and cost.

The frontend is the same one pi-web uses: three static files, no framework, no build step. What
changed is the backend, and one number in particular:

| | `pi --mode rpc` (one process per session) | pi-ui (in-process SDK) |
| --- | --- | --- |
| New session | 1.33 s | **0.036 s** |
| Open a 30 MB session | 1.39 s | **0.75 s** |
| Read a 30 MB transcript | 2.80 s / 30.5 MB | **0.005 s / 1.9 MB** |
| Ten sessions in one workspace | ten process boots | one workspace build, ten × 46 ms |

## Contents

- [Why it is fast](#why-it-is-fast)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [What the SDK changed](#what-the-sdk-changed)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [When the server goes away](#when-the-server-goes-away)
- [Security notes](#security-notes)
- [Development](#development)
- [Limitations](#limitations)

## Why it is fast

Three separate costs were measured, and only one of them was where it looked.

**1. Booting the agent.** A `pi --mode rpc` process costs ~1.3 s, and 0.9 s of that is a single call:
`createAgentSessionServices()` discovering extensions, skills and MCP servers. That work depends only
on the working directory, never on the conversation. A process per session pays it once per session.
pi-ui builds it **once per workspace** and reuses it, so opening the second and every later session in
a project costs ~46 ms.

```text
services, cold cwd          ~0.78 s   (once per workspace)
services, cached cwd          0 ms
new session                 ~0.046 s
open a 30 MB session        ~0.088 s   (parse + extension bind)
```

**2. Shipping the transcript.** A real 30 MB session was **28.7 MB of base64 PNG data** across 36
image blocks, and 1.7 MB of everything else. The RPC bridge serialized all of it, framed it as one
30 MB JSONL line, and the browser parsed it — to render a transcript where those images are collapsed
until clicked. pi-ui keeps the image bytes on the server and sends a placeholder with an `imageId`;
the browser fetches a picture when it is actually on screen (`GET /api/image-block`). The transcript
payload drops to 1.9 MB, so the same read goes from 2.8 s to 5 ms.

**3. Framing the pipe.** The RPC bridge reads stdout by appending each chunk to a string and slicing
records off it. Strict JSONL is LF-only, and a large response is a single LF-terminated line, so the
scan restarts from index 0 on every chunk until the line completes. That is a real cost, but it is a
consequence of cost 2 — with the images offloaded the line is small and the problem disappears.
In-process hosting removes the pipe entirely.

### Rendering a stream in O(n), not O(n²)

A transcript renders Markdown — headings, tables, code blocks. Parsing it again on every
`text_delta` is both quadratic in the answer's length and visibly wrong: halfway through, an
unterminated code fence or a lone backtick is not Markdown, so the page re-flowed under the reader
with every chunk.

So a streaming turn paints its source as literal text in one node, and each delta is a single
`Text.appendData`. `message_end` renders the real Markdown once. Measured on a 494 KB answer over
100 deltas in Chrome:

```text
re-render per delta (before)   15.1 ms median, 32.9 ms p95    1582 ms total
append per delta (after)        0.0 ms median,  0.1 ms p95       3 ms total
```

Three smaller costs went with it: a 400-row sidebar rebuilt on every filter keystroke (~19 ms, now
debounced 120 ms), a live session file re-parsed whole on every 8 s poll (now topped up from the
bytes appended since the last read), and `ps`/`lsof` run synchronously on every bash call (now async,
and a leftover's liveness is a signal-0 rather than a process table scan).

## Requirements

- Node.js **18 or newer** (ESM and `node:` imports only).
- A working `pi` install, which is where the SDK comes from. The package is resolved from
  `~/.pi/agent/install/current-version`, so `pi-ui` always embeds the same version the `pi` command
  runs, and a `pi` upgrade is picked up without touching this code.
- `npm install @earendil-works/pi-coding-agent` also works and takes precedence, for a pinned or
  project-local SDK.

Nothing else is needed to run it — the frontend has no dependencies and no build step.

## Quick start

```bash
node server.js
```

Open <http://localhost:3220>. The agent starts in the directory `server.js` was launched from — use
the folder button in the sidebar to work somewhere else, or:

```bash
node server.js --cwd ~/code/my-project   # agent works in another project
node server.js --port 8080               # different port
node server.js --sdk /path/to/pkg        # explicit SDK package directory
node server.js --help                    # every option
```

## Architecture

| File | Role |
| --- | --- |
| `server.js` | HTTP surface, SSE fan-out, session listing, follow-up store, background-process tracking, static files |
| `sdk/host.js` | The session pool: per-cwd services cache, one `AgentSession` per open session, the RPC command surface answered from memory |
| `sdk/load.js` | Resolves and imports the installed SDK |
| `sdk/events.js` | Converts `AgentSessionEvent` into the JSON shape the browser consumes |
| `sdk/images.js` | Image offload: placeholders in, base64 kept server-side |
| `sdk/ui-context.js` | The `ExtensionUIContext` the RPC bridge used to provide over stdout |
| `public/index.html`, `public/app.js`, `public/style.css` | The frontend shell, state and rendering, and the design tokens |

The HTTP surface is unchanged from pi-web, so the browser never talks to the agent directly and every
route below behaves as it did.

### One session per key, not one process per session

`switch_session` inside a single process invalidates every extension context that captured `ctx`,
which is why the subprocess design existed at all. pi-ui keeps the same pool — a session per session
file — and only makes *creating* one cheap. Each open session owns its `AgentSession`, its own
message queue and its own run; switching sessions never disposes another one, so a background run
keeps going and can be re-attached.

The pool keys are `file:<abs path>`, with `slot:<uuid>` for a session pi has not persisted yet; the
slot learns its file on the first prompt and becomes attachable by path, so a second tab clicking the
new row attaches instead of opening a duplicate.

## What the SDK changed

Everything the RPC bridge did has a direct in-process equivalent:

| RPC command | SDK |
|---|---|
| `get_state` | `session.model` / `thinkingLevel` / `isStreaming` / `sessionFile` / `sessionName` |
| `get_entries`, `since` | `sessionManager.getEntries()` / `getLeafId()` |
| `get_session_stats` | `session.getSessionStats()` |
| `get_available_models` | `session.modelRuntime.getAvailableSnapshot()` |
| `get_commands` | `extensionRunner.getRegisteredCommands()` + prompt templates + skills |
| `set_model`, `set_thinking_level` | `session.setModel()` / `setThinkingLevel()` |
| `prompt`, `steer`, `follow_up`, `abort`, `clear_queue` | `session.prompt()` / `steer()` / `followUp()` / `abort()` / `clearQueue()` |
| events on stdout | `session.subscribe()` |
| `extension_ui_request` | `ExtensionUIContext` supplied to `bindExtensions()` |

`prompt` resolves when pi *accepts* the prompt, not when the run ends — the same contract RPC mode
has, via `preflightResult`. Streaming continues over SSE.

Three behaviours needed care and are worth knowing about:

- **The event shape.** `session.subscribe()` delivers `AgentSessionEvent` objects, whose
  `message_update` carries the in-flight `partial` message. The RPC sender strips it, and so does
  `sdk/events.js`, so the frontend needed no change.
- **Dialog promises.** An extension asking `ui.select()` must hang until the browser answers. Answers
  arrive at `/api/ui-response` and resolve the pending promise; a timeout or abort resolves the
  default instead of rejecting. TUI-only members (`setFooter`, `setWidget` component factories, theme
  switching) are safe no-ops, because an extension calling one must not crash.
- **Failure containment.** A subprocess crash used to be contained by the OS. In-process, every
  inbound event runs through one guarded listener and every command through a `try/catch`, so an
  extension throwing cannot take the UI down.

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Server cwd, session directory, pi binary |
| `GET /api/health` | Liveness, live sessions, cached workspaces, tracked clients |
| `GET /api/events?client=<id>` | SSE stream of agent records for this client's session |
| `POST /api/open` | `{client, sessionFile?, cwd?}` — attach this client to a session, creating it if needed |
| `POST /api/cmd` | `{client, type, …}` — a pi command (`get_state`, `get_entries`, `prompt`, `steer`, `abort`, …) |
| `POST /api/ui-response` | Answer an extension UI dialog |
| `GET /api/image-block?id=<id>` | Base64 bytes for an image the transcript carries as a placeholder |
| `GET /api/image?path=<file>` | Serve an image a tool call referenced by path (PNG/JPEG/GIF/WebP only) |
| `POST /api/extract` | `{name, data}` (base64) — extract a composer attachment's text (PDF, `.docx`, `.html`, plain text) |
| `GET /api/sessions` | List sessions with live active/streaming flags |
| `GET /api/followups` | List saved follow-ups: metadata only, no bodies |
| `POST /api/followups` | Save one summary |
| `GET /api/followups/<id>` | One saved follow-up, including its Markdown `text` |
| `PATCH /api/followups/<id>` | Rewrite a saved follow-up's title and body |
| `DELETE /api/followups/<id>` | Delete a saved follow-up |
| `GET /api/search?q=&limit=&scope=<all\|prompts\|summary>` | Full-text search across every session |
| `GET /api/browse?path=<dir>` | Directory listing for the workspace picker |
| `GET /api/mcp?client=<id>` | MCP server state as `pi mcp list --json` reports it |
| `GET /api/processes?client=<id>` | Background processes that session's bash calls left running |
| `POST /api/processes/kill` | `{client, pid}` — stop one recorded leftover |

A leftover is tracked from the moment it appears to the moment it is gone, by whichever route gets
there first. A kill goes through `/api/processes/kill`; a process that exits on its own is noticed by
a 5 s sweep (one `kill(pid, 0)` per recorded pid, no subprocess) which pushes the shortened list over
SSE. The sweep matters because the tabs *mirror* a pushed list: without it a dead process would keep
its dock row and its badge until the resources panel happened to re-read `/api/processes`.

`POST /api/test/inject` exists only when `PI_UI_TEST_HOOKS=1`; it replays an event through a
session's live path so the smoke test can cover bash bracketing without a model.

## Configuration

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--port <n>` | `PI_WEB_PORT` | `3220` | Listen port |
| `--host <addr>` | `PI_WEB_HOST` | `127.0.0.1` | Bind address; a non-loopback value enables remote access |
| `--cwd <dir>` | `PI_WEB_CWD` | current directory | Directory the agent works in |
| `--session-dir <dir>` | `PI_CODING_AGENT_SESSION_DIR` | `~/.pi/agent/sessions` | Where pi stores sessions |
| `--followup-dir <dir>` | `PI_WEB_FOLLOWUP_DIR` | `~/.pi/followups` | Where Follow-ups are saved |
| `--pi <path>` | `PI_BIN` | `pi` on `PATH` | pi executable, used only for `pi mcp list` |
| `--sdk <dir>` | `PI_UI_SDK` | the managed pi install | `@earendil-works/pi-coding-agent` package directory |
| `--allow-remote` | `PI_WEB_ALLOW_REMOTE=1` | off | Drop the loopback request guards (reverse proxies) |

## When the server goes away

The browser is a thin client: every command is a POST to the server and every event arrives on its
SSE stream. If that process dies or wedges, nothing works — so the page says so, rather than looking
healthy while it silently fails.

A banner in the composer dock takes over the moment contact is lost. It names the state, keeps the
already-rendered transcript readable, blocks the composer (a disabled Send and a placeholder naming
the fix, so a draft is never lost to a send that could not happen), and offers **Retry now**. The
sidebar keeps a short version of the same fact. When the server returns, the banner clears and the tab
re-opens its session automatically — a restart is a new process, so the old session object is gone
even though its file is not.

Two failures are distinguished, because they need different reactions:

| What happened | How it is detected | Banner says |
| --- | --- | --- |
| process gone | `fetch` rejects, or the SSE stream closes | lost contact — start the server, then Retry |
| process alive but wedged | a `/api/health` probe times out | no response from the server |

The second case is why a probe exists at all. A hung server still owns the SSE connection, so
`EventSource` fires no error and the stream simply produces nothing — indistinguishable from an idle
session, and its `: ping` heartbeat is a comment `EventSource` never surfaces. The page therefore polls
`/api/health` every 15 s (8 s timeout) for as long as it is open. A healthy-but-quiet server answers,
an idle conversation stays green, and a wedge is caught inside half a minute.

## Security notes

- The server can start the agent, which runs shell commands as you. It binds to `127.0.0.1` and
  rejects requests whose `Host` or `Origin` is not local, which blocks DNS rebinding and cross-origin
  requests from other browser tabs. A non-loopback bind, or `--allow-remote`, turns those off; both
  log a warning at startup. Put authentication in front of the port before anyone else can reach it.
- Paths from the browser are resolved and checked against `public/` before being served; the workspace
  picker only lists existing directories.
- `GET /api/image` is the one route that reads an arbitrary absolute path, because a tool result can
  reference a picture anywhere on disk. It is restricted to image bytes verified by magic bytes,
  capped at 16 MB, and served with `no-store`.
- `GET /api/image-block` only resolves an opaque id against the server's own image stash, so it cannot
  be used as a file reader.
- `POST /api/processes/kill` only accepts a pid the session recorded during one of its own bash
  calls, so it cannot be turned into "kill anything I can name".
- Session files are read only from the configured session directory; request bodies are capped at
  32 MB; static serving cannot escape `public/`. The smoke test asserts the traversal and
  cross-origin guards.

## Development

```bash
npm run check      # syntax check on the server, frontend, SDK modules and tests
npm run typecheck  # checkJs over the server, SDK and frontend (needs `npm install`)
npm test           # end-to-end smoke test: HTTP surface, security guards, queue, dialogs, processes
```

`npm test` does not drive the UI, so for frontend changes also run the server and verify the changed
flow in a browser.

### Type checking without a build step

The source stays JavaScript. `npm run typecheck` runs `tsc` in `checkJs` mode through two configs —
`jsconfig.json` for the server and SDK (node types), `jsconfig.web.json` for `public/app.js` (DOM
types) — with `noEmit`, so nothing is compiled and `node server.js` still runs the files directly.

This is worth doing here for one reason: **the pi SDK ships `.d.ts` files.** `sdk/host.js` drives
`AgentSession`, `SessionManager` and `createAgentSessionFromServices`, and against real declarations
those calls are verified instead of guessed from JS source. Turning it on found four genuine bugs —
`err.code` read off a bare `Error`, a `SessionHost` option the server passed but the class never
declared, and a `#resolveTarget` call omitting an optional field — none of which `node --check`
(a pure syntax check) can see.

TypeScript was *not* adopted as the source language. Types do not survive to runtime, so a `.ts`
rewrite would not make anything faster (measured: `server.ts` via Node's type stripping boots in
361–372 ms versus 337–358 ms for `server.js`), and it would cost a build step plus `enum`/
parameter-property restrictions under `--experimental-strip-types`. `test/smoke.js` is deliberately
out of scope: it reads `await res.json()` ~120 times, which is `unknown`, and annotating those sites
would add casts without adding safety.

## Limitations

- **The SDK must match the installed `pi`.** It is resolved from the managed install, so this is
  normally automatic. A `pi` built from source without a managed install needs `--sdk`.
- **One process now serves every session.** A crash in the agent or an extension takes the whole UI
  down, where a subprocess would have taken only its own session. Every event and command is guarded
  to keep that from happening, but it is a real difference from the subprocess design.
- **`ctx.shutdown()` cannot be honoured.** An extension asking the host to exit would kill unrelated
  sessions, so it is reported to the browser instead.
- **Images are offloaded, not free.** Reopening an old image costs one round trip. The server keeps
  the most recent 200 MB of image data and drops the oldest beyond that; a placeholder whose bytes
  are gone renders as "image no longer available".
- Sessions are listed and searched from the session directory, so a session written by a different
  machine is visible only if its file is there.
