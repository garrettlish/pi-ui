# AGENTS.md

Instructions for coding agents working in this repo. Read this before running anything.

## Never kill the pi-ui server on port 3220

`http://localhost:3220/` is the live instance this repo is normally being developed *from*. Killing it
ends the session that is doing the work: the browser UI goes dead, the SSE stream drops, and there is
no way back from inside the agent.

This happened once with a broad pattern:

```bash
pkill -f "node server.js"   # WRONG — matches the production instance too
```

`server.js` is also the name of the file under test, so any pattern containing `node server.js`
matches the instance you are trying to protect. Run tests and benchmarks on an **explicit port**
instead, and only ever stop those:

```bash
# start a throwaway server on a port you chose
PI_WEB_PORT=3297 node server.js --session-dir /tmp/pi-ui-scratch &

# stop it by PORT, never by pattern
lsof -ti :3297 | xargs kill
```

`npm test` already picks its own port (`3300 + random`, or `SMOKE_PORT`) and starts its own servers, so
it needs no cleanup pattern at all. If a port is genuinely stuck, check what owns it before killing:

```bash
lsof -ti :3220            # is this the protected instance?
ps -o pid,lstart,command -p <pid>
```

The same applies to `pkill node`, `killall node`, and any `pkill -f` whose pattern does not include the
specific port you started.

## Verify the protected instance is still up

After any cleanup, confirm rather than assume:

```bash
curl -s -m 2 -o /dev/null -w '%{http_code}\n' http://localhost:3220/api/health   # expect 200
```

## Commands

```bash
node server.js        # the UI (defaults to 127.0.0.1:3220)
npm run check         # syntax check: server, frontend, SDK modules, tests
npm run typecheck     # checkJs over server + SDK + frontend (needs `npm install`)
npm test              # end-to-end smoke test on its own port
```

## Conventions this repo holds itself to

- **No build step, no runtime dependencies.** The source is JavaScript and stays that way; `node
  server.js` runs the files directly. Type checking is `checkJs` + `noEmit` (`jsconfig.json`,
  `jsconfig.web.json`) — it catches API misuse, it does not compile anything. Do not introduce a
  bundler or a transpile step.
- **Do not convert the source to TypeScript.** It buys nothing at runtime (measured: a `.ts` server
  boots ~20 ms *slower* under Node's type stripping, because types are erased and nothing else
  changes) and costs the no-build-step property plus Node 18 compatibility. Add JSDoc where a type
  helps; the typecheck already reads it.
- **Performance claims need a measurement.** This repo's README publishes numbers. If you change a
  hot path, measure before and after on a real session and state both — do not assert "faster".
  Streaming, session listing and process tracking all have benchmarks in their history; a plausible
  argument is not a substitute for the number.
- **Streaming renders text, not Markdown.** A `text_delta` appends to one text node
  (`applyStreamDelta`); Markdown is parsed once at `message_end`. Re-parsing per delta is quadratic
  and also re-flows the page under the reader, because half-written Markdown is not Markdown.
- **Comments explain why, not what.** Several non-obvious behaviours are pinned by a comment (why
  images are offloaded, why a process group must have no leader, why the SSE list mirrors pushes).
  Preserve them when editing, and add one when you introduce a decision a reader would otherwise
  reverse.
- **A failure the page can detect must be shown on the page.** The connection state is the case that
  motivated this: a dead server used to leave a readable transcript, a full sidebar and an enabled
  composer over a process that could not accept a single command. When you add a path that can fail
  in a way the user cannot see, surface it (a banner, a disabled control naming the fix) rather than
  letting a `catch {}` swallow it. Transport failures and HTTP errors are different events here: a
  `TypeError` from `fetch` means the server is unreachable, an `HTTP 4xx/5xx` does not.
- **The smoke test is the regression net.** `npm test` covers the HTTP surface, the security guards,
  queue handling, extension dialogs and background-process tracking. Frontend behaviour is asserted by
  reading `public/app.js` for the constructs that implement it, so a test may legitimately need
  updating when you rename or restructure something — update the assertion, keep its intent.

## Security model is load-bearing
The server can start the agent, which runs shell commands as the user. It binds to loopback and
rejects non-local `Host`/`Origin`. Do not loosen that to make a test or a proxy easier: `--allow-remote`
and a non-loopback bind both log a warning because they are genuinely dangerous. Paths from the browser
are resolved under `public/`; `/api/processes/kill` only signals a pid the session itself recorded.
