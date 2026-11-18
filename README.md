# pi-ui

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-none-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Backend](https://img.shields.io/badge/backend-pi%20SDK-6f42c1)](https://github.com/earendil-works/pi)

A local web UI for the [pi coding agent](https://github.com/earendil-works/pi), built on the
**pi SDK** — the agent runs in-process instead of behind a `pi --mode rpc` subprocess.

`pi` ships with a terminal UI. `pi-ui` puts the same agent in a browser and adds what a terminal is
bad at: browsing every past session across every project, and inspecting exactly what the model sent
and received — request arguments, live tool output, full responses, token usage and cost.

One Node process, three static frontend files, no npm dependencies and no build step. Embedding the
SDK instead of bridging RPC is what makes it fast:

| | `pi --mode rpc` (one process per session) | pi-ui (in-process SDK) |
| --- | --- | --- |
| New session | 1.33 s | **0.036 s** |
| Open a 30 MB session | 1.39 s | **0.75 s** |
| Read a 30 MB transcript | 2.80 s / 30.5 MB | **0.005 s / 1.9 MB** |
| Ten sessions in one workspace | ten process boots | one workspace build, ten × 46 ms |

## Contents

- [Features](#features)
  - [Transcript and inspector](#transcript-and-inspector)
  - [Subagent runs](#subagent-runs)
  - [Sessions, search and follow-ups](#sessions-search-and-follow-ups)
  - [Composer and appearance](#composer-and-appearance)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Performance](#performance)
  - [One workspace build, not one process per session](#one-workspace-build-not-one-process-per-session)
  - [Streaming renders text, not Markdown](#streaming-renders-text-not-markdown)
  - [Images are offloaded, not shipped](#images-are-offloaded-not-shipped)
- [Architecture](#architecture)
- [SDK command mapping](#sdk-command-mapping)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [Remote access](#remote-access)
- [Security](#security)
- [Development](#development)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

### Transcript and inspector

- Assistant text, thinking, tool calls, retries and compaction stream in as pi produces them. Links,
  tables, lists and syntax-highlighted code fences render once a message completes.
- Every tool call is one line in the transcript; clicking it opens a popup with the request
  arguments, live execution updates, the final response and a **Raw JSON** toggle. `edit` calls lead
  with a colored, line-numbered diff.
- Assistant turns carry model, provider, input/output/cache tokens, cost and stop reason. The header
  tracks context-window usage, session cost and token totals as each message completes.
- A prompt outline in the header lists every user prompt in the session; each entry jumps to that
  message, and an indented second row jumps to the answer that concluded that run.
- Extension UI requests (`select`, `confirm`, `input`, `editor`) surface as real dialogs; `notify`
  becomes a toast.

### Subagent runs

- A fan-out renders as its own transcript card, not an opaque tool row: the head names the shape
  (`single`, `parallel`, `chain`, `workflow`) and summarizes agents, live/failed counts, wall time
  and tokens; one row per child carries its live state and current tool.
- Clicking a child opens a **run inspector** — child list, task, progress reports, live activity,
  recorded tool calls, output, error, acceptance verdict, and a button that opens that child's own
  transcript.
- A background run's completion arrives as a card (completed / failed / stopped / paused) with
  retained output per child, instead of a grey status note.

### Sessions, search and follow-ups

- The sidebar lists every session under the pi session directory with title, repository, message
  count, cost and last activity, in three views: **Recent**, **Workspaces** (project → session) and
  **Follow-ups**.
- Opening a session rebuilds the transcript from its active branch, including history from before a
  compaction. Switches are optimistic and cached, so re-opening costs one incremental read.
- Each open session keeps its own `AgentSession` and its own run: switching sessions never stops a
  background run, and a tab can re-attach to it at any time. Sessions are addressable by URL hash.
- Search (`Cmd/Ctrl`+`K`) has three scopes: **Prompts** (only what you typed), **Summary** (the
  answer each run concluded with) and **Everything** (every prompt, response, tool request and tool
  result, including subagent child output). Clicking a hit jumps to the occurrence.
- **Follow-up** saves a run's concluding answer under `~/.pi/followups`; the tab groups them into a
  tree by **tag**, and lists, edits, copies and deletes them without replaying any session. Tags are
  added or removed on the open document and persist with the file, so the same summary can be filed
  under several branches. **Copy** puts an answer on the clipboard as rich text *and* Markdown at
  once.

### Composer and appearance

- Attach images, PDFs, `.docx`, `.html` or plain-text files; the server extracts text and shows the
  character cost on the chip before you send. Images and documents in a transcript open the same way.
- Queued steering / follow-up messages appear in a dock above the composer and can be undone
  individually or cleared. `Esc` or **Stop** aborts the current run.
- Model and thinking-level menus honor `enabledModels` from `~/.pi/agent/settings.json`.
- Six palettes (mono, sky, grove, ember, elegant, night), a resizable and collapsible sidebar, and
  tool-call state that reads twice over (rail plus worded chip) so it never depends on color alone.
- A settings inspector with four tabs: **Models**, **Skills**, **MCPs** and **Processes** — the last
  one listing long-running processes a session's bash calls left behind, each stoppable by pid.

## Requirements

- Node.js **18 or newer** (ESM and `node:` imports only).
- A working `pi` install, which is where the SDK comes from. The package is resolved from
  `~/.pi/agent/install/current-version`, so `pi-ui` always embeds the same version the `pi` command
  runs, and a `pi` upgrade is picked up without touching this code.
- `npm install @earendil-works/pi-coding-agent` also works and takes precedence, for a pinned or
  project-local SDK.

Nothing else is needed to run it: a bare checkout runs with `node server.js`.

## Quick start

```bash
git clone https://github.com/garrettlish/pi-ui.git
cd pi-ui
node server.js
```

Open <http://localhost:3220>. The agent starts in the directory `server.js` was launched from — use
the folder button in the sidebar to work elsewhere, or:

```bash
node server.js --cwd ~/code/my-project   # agent works in another project
node server.js --port 8080               # different port
node server.js --sdk /path/to/pkg        # explicit SDK package directory
node server.js --help                    # every option
```

## Performance

Every number below was measured on a real session; they are the reason the SDK migration exists.

### One workspace build, not one process per session

A `pi --mode rpc` process costs ~1.3 s, and 0.9 s of that is a single call: `createAgentSessionServices()`
discovering extensions, skills and MCP servers. That work depends only on the working directory, never
on the conversation, yet a process per session pays it once per session. pi-ui builds it **once per
workspace** and reuses it.

```text
services, cold cwd          ~0.78 s   (once per workspace)
services, cached cwd          0 ms
new session                 ~0.046 s
open a 30 MB session        ~0.088 s   (parse + extension bind)
```

### Streaming renders text, not Markdown

Parsing Markdown on every `text_delta` is quadratic in the answer's length *and* visibly wrong:
halfway through, an unterminated code fence is not Markdown, so the page re-flows under the reader.
A streaming turn therefore paints its source as literal text in one node and each delta is a single
`Text.appendData`; `message_end` renders the real Markdown once.

Measured on a 494 KB answer over 100 deltas in Chrome:

```text
re-render per delta (before)   15.1 ms median, 32.9 ms p95    1582 ms total
append per delta (after)        0.0 ms median,  0.1 ms p95       3 ms total
```

Prism highlighting follows the same rule: once per code block, at `message_end`, never per delta.
Highlighting is bounded — Prism runs at ~2.7 MB/s, so a block over `MAX_HIGHLIGHT_CHARS` (200 KB)
renders plain instead. Prism is vendored into `public/vendor/prism.min.js` (34 KB raw, 12.5 KB
gzipped) rather than declared as a dependency, so a bare checkout still runs;
`scripts/vendor-prism.sh` regenerates it.

### Images are offloaded, not shipped

A real 30 MB session was **28.7 MB of base64 PNG data** across 36 image blocks, and 1.7 MB of
everything else. Serializing that pipe is what made RPC reads slow: one 30 MB JSONL line, parsed by
the browser, to render a transcript where the images are collapsed until clicked.

pi-ui keeps image bytes on the server and sends a placeholder with an `imageId`; the browser fetches
a picture when it is actually on screen (`GET /api/image-block`). The transcript payload drops to
1.9 MB, so the same read goes from 2.8 s to 5 ms. The server keeps the most recent 200 MB of image
data and drops the oldest beyond that.

## Architecture

| File | Role |
| --- | --- |
| `server.js` | HTTP surface, SSE fan-out, session listing, follow-up store, background-process tracking, static files |
| `sdk/host.js` | The session pool: per-cwd services cache, one `AgentSession` per open session, the RPC command surface answered from memory |
| `sdk/load.js` | Resolves and imports the installed SDK |
| `sdk/events.js` | Converts `AgentSessionEvent` into the JSON shape the browser consumes |
| `sdk/images.js` | Image offload: placeholders out, base64 kept server-side |
| `sdk/ui-context.js` | The `ExtensionUIContext` the RPC bridge used to provide over stdout |
| `public/index.html`, `public/app.js`, `public/style.css` | The frontend shell, state and rendering, and the design tokens |
| `public/vendor/prism.min.js` | Syntax highlighting grammars, vendored |

`switch_session` inside a single process invalidates every extension context that captured `ctx`,
which is why the subprocess design existed at all. pi-ui keeps the same pool — a session per session
file — and only makes *creating* one cheap. Pool keys are `file:<abs path>`, with `slot:<uuid>` for a
session pi has not persisted yet; the slot learns its file on the first prompt and becomes attachable
by path, so a second tab clicking the new row attaches instead of opening a duplicate.

Everything in-process is guarded: a subprocess crash used to be contained by the OS, so every inbound
event runs through one guarded listener and every command through a `try/catch`, and an extension
throwing cannot take the UI down.

## SDK command mapping

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

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Server cwd, session directory, pi binary |
| `GET /api/health` | Liveness, live sessions, cached workspaces, tracked clients |
| `GET /api/events?client=<id>` | SSE stream of agent records for this client's session |
| `POST /api/open` | `{client, sessionFile?, cwd?}` — attach this client to a session, creating it if needed |
| `POST /api/cmd` | `{client, type, …}` — a pi command (`get_state`, `get_entries`, `prompt`, `steer`, `abort`, …) |
| `POST /api/ui-response` | Answer an extension UI dialog |
| `GET /api/image-block?id=<id>` | Bytes for an image the transcript carries as a placeholder |
| `GET /api/image?path=<file>` | Serve an image a tool call referenced by path (PNG/JPEG/GIF/WebP only) |
| `POST /api/extract` | `{name, data}` (base64) — extract a composer attachment's text |
| `GET /api/sessions` | List sessions with live active/streaming flags |
| `GET /api/followups` | List saved follow-ups: metadata only, no bodies |
| `POST /api/followups` | Save one summary |
| `GET /api/followups/<id>` | One saved follow-up, including its Markdown `text` |
| `PATCH /api/followups/<id>` | Rewrite a saved follow-up's title, body or `tags` |
| `DELETE /api/followups/<id>` | Delete a saved follow-up |
| `GET /api/search?q=&limit=&scope=<all\|prompts\|summary>` | Full-text search across every session |
| `GET /api/browse?path=<dir>` | Directory listing for the workspace picker |
| `GET /api/mcp?client=<id>` | MCP server state as `pi mcp list --json` reports it |
| `GET /api/processes?client=<id>` | Background processes that session's bash calls left running |
| `POST /api/processes/kill` | `{client, pid}` — stop one recorded leftover |

The browser never talks to the agent directly. If the server dies or wedges, the page says so — a
banner takes over the composer, keeps the transcript readable, blocks sending (so a draft is never
lost to a send that could not happen) and offers **Retry now**. A `/api/health` probe every 15 s
catches the case a hung server cannot report on its own: it still owns the SSE connection, so the
stream simply produces nothing.

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

## Remote access

**Do not expose this server to a network you do not control.** Anything that can reach the port can
drive the agent, and the agent runs shell commands as you. There is no login.

Keep the server on loopback and tunnel to it instead:

```bash
node server.js                                   # stays on 127.0.0.1
ssh -N -L 3220:127.0.0.1:3220 you@your-machine   # then browse http://localhost:3220
```

`--host 0.0.0.0` and `--allow-remote` exist for containers and reverse proxies, and both log a
warning because they remove the request guards. Put authentication in front of the port before it is
reachable by anyone else.

## Security

- The server can start the agent, which runs shell commands as you. It binds to `127.0.0.1` and
  rejects requests whose `Host` or `Origin` is not local, which blocks DNS rebinding and cross-origin
  requests from other browser tabs.
- Paths from the browser are resolved and checked against `public/` before being served; the
  workspace picker only lists existing directories.
- `GET /api/image` is the one route that reads an arbitrary absolute path, because a tool result can
  reference a picture anywhere on disk. It is restricted to image bytes verified by magic bytes,
  capped at 16 MB, and served with `no-store`.
- `GET /api/image-block` only resolves an opaque id against the server's own image stash, so it
  cannot be used as a file reader.
- `POST /api/processes/kill` only accepts a pid the session recorded during one of its own bash
  calls, so it cannot be turned into "kill anything I can name".
- Session files are read only from the configured session directory; request bodies are capped at
  32 MB. The smoke test asserts the traversal and cross-origin guards.

## Development

| Command | What it does |
| --- | --- |
| `npm run check` | Syntax check on the server, frontend, SDK modules and tests |
| `npm run typecheck` | `checkJs` over the server, SDK and frontend (needs `npm install` first) |
| `npm test` | End-to-end smoke test: HTTP surface, security guards, queue, dialogs, processes |

`npm install` is only needed for `npm run typecheck`; running and testing stay dependency-free.

`npm test` does not drive the UI, so for frontend changes also run the server and verify the changed
flow in a browser.

The source stays JavaScript and type checking is `checkJs` + `noEmit`: `sdk/host.js` drives
`AgentSession`, `SessionManager` and `createAgentSessionFromServices` against the SDK's real `.d.ts`
files, so those calls are verified instead of guessed from JS source. TypeScript is not the source
language because types do not survive to runtime — a `.ts` rewrite would not make anything faster —
and the current toolchain requires no build at all. If a build step lands for another reason, that
trade can be revisited. See [`AGENTS.md`](AGENTS.md) for the repo's engineering rules.

## Limitations

- **The SDK must match the installed `pi`.** It is resolved from the managed install, so this is
  normally automatic. A `pi` built from source without a managed install needs `--sdk`.
- **One process now serves every session.** A crash in the agent or an extension takes the whole UI
  down, where a subprocess would have taken only its own session.
- **`ctx.shutdown()` cannot be honoured.** An extension asking the host to exit would kill unrelated
  sessions, so it is reported to the browser instead.
- **Images are offloaded, not free.** Reopening an old image costs one round trip; a placeholder
  whose bytes have been dropped renders as "image no longer available".
- Sessions are listed and searched from the session directory, so a session written by a different
  machine is visible only if its file is there.

## Contributing

Issues and pull requests are welcome. Before opening one:

1. `npm run check && npm test` must pass — the smoke test is the regression net for the HTTP surface,
   the security guards, queue handling, extension dialogs and process tracking.
2. Performance claims need a measurement. If you change a hot path, measure before and after and
   state both numbers.
3. Comments explain *why*, not *what*. A decision a reader would otherwise reverse deserves one line.

`pi-ui` supersedes [`pi-web`](https://github.com/garrettlish/pi-web), which is archived. The frontend
and HTTP surface are unchanged; the backend now embeds the SDK.

## License

[MIT](LICENSE)
