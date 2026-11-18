#!/usr/bin/env node
/**
 * End-to-end smoke test for pi-ui. No dependencies, no test framework, so the file runs
 * on a bare checkout: `node test/smoke.js`.
 *
 *   node test/smoke.js
 *
 * Starts a throwaway server on a free port, then checks the things that have
 * actually broken before: the page and its assets are served, the HTTP API
 * answers, foreign hosts and cross-origin writes are rejected, and path
 * traversal cannot escape public/.
 *
 * It does NOT spawn a real pi agent — that needs credentials and a model, and
 * belongs in a manual check. When pi is installed the script additionally
 * verifies that a session can be opened.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT || 3300 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}`;

// A throwaway session directory keeps /api/sessions and /api/search
// deterministic and independent of whatever real sessions this machine has.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-smoke-"));
// Follow-ups live in their own directory, so the smoke test exercises the real
// save/list/read/delete path without touching ~/.pi/followups.
const FOLLOWUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-followups-"));
function writeFixture(dirName, file, lines) {
  const dir = path.join(FIXTURE_DIR, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** One-page PDF whose only content is one text run, built by hand so the test
 *  needs no fixture file. Object 4 is the page content stream. */
function minimalPdf(line) {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  objects.forEach((body, i) => {
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  // No xref table: the extractor scans for object headers, and a test fixture
  // with a hand-computed offset table would be more fragile than useful.
  return `${pdf}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF\n`;
}

/** An uncompressed .docx: a ZIP with the one part that carries the text. Written
 *  by hand for the same reason — no dependency, no binary fixture in the repo.
 *  `corrupt` writes document.xml as deflate-marked garbage, the shape a truncated
 *  or damaged file has. */
function minimalDocx(escapedText, { corrupt = false } = {}) {
  const files = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    [
      "word/document.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapedText}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ];
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    // document.xml can be written as a deflate-marked entry that is not deflate
    // data, which is what a damaged file looks like on disk
    const isCorrupt = corrupt && name === "word/document.xml";
    const data = isCorrupt ? Buffer.from([0xff, 0xff, 0xff, 0xff]) : Buffer.from(text, "utf8");
    const method = isCorrupt ? 8 : 0;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Status code of a raw request; needed because fetch() ignores a Host header override. */
function rawRequestStatus(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "GET", headers },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Two workspaces, each with one session. The fixture exercises every searchable
// channel and two of the exclusion rules (system prompt, thinking blocks).
writeFixture("--tmp-ws-alpha--", "2026-01-01T00-00-00-000Z_aaaa.jsonl", [
  { type: "session", version: 3, id: "aaaa", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/ws-alpha" },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "please inspect the flibbertigibbet module" }] },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SEARCHTHINKINGONLY private reasoning" },
        { type: "text", text: "the flibbertigibbet module exports nothing useful" },
        { type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "SEARCHTOOLARG flibbertigibbet" } },
      ],
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "grep", content: [{ type: "text", text: "SEARCHTOOLOUT flibbertigibbet.js:1" }] },
  },
  {
    type: "message",
    id: "a3",
    parentId: "r1",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-sub", name: "subagent", arguments: { agent: "reviewer", task: "SEARCHSUBTASK review auth" } }],
    },
  },
  // A subagent fan-out: the tool result text is the parent's combined answer,
  // while each child's own output lives only in details.results[].finalOutput.
  {
    type: "message",
    id: "r2",
    parentId: "a3",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-sub",
      toolName: "subagent",
      content: [{ type: "text", text: "combined answer" }],
      details: {
        mode: "single",
        results: [{ index: 0, agent: "reviewer", exitCode: 0, finalOutput: "SEARCHCHILDOUT the token check trusts the alg header" }],
      },
    },
  },
  // The run's last turn, and the only one that settles: the answer text above
  // (a1) was mid-loop, so the summary scope must not reach it.
  {
    type: "message",
    id: "a4",
    parentId: "r2",
    timestamp: "2026-01-01T00:00:06.000Z",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "SEARCHSUMMARYANSWER the module is unused, nothing to change" }],
    },
  },
]);
writeFixture("--tmp-ws-beta--", "2026-02-02T00-00-00-000Z_bbbb.jsonl", [
  { type: "session", version: 3, id: "bbbb", timestamp: "2026-02-02T00:00:00.000Z", cwd: "/tmp/ws-beta" },
  {
    type: "message",
    id: "u2",
    parentId: null,
    timestamp: "2026-02-02T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "unrelated request about widgets" }] },
  },
  {
    type: "message",
    id: "s1",
    parentId: null,
    timestamp: "2026-02-02T00:00:02.000Z",
    message: { role: "system", content: "SEARCHSYSTEMONLY system preamble" },
  },
  {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "2026-02-02T00:00:03.000Z",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "the widgets are fine, and so is flibbertigibbet SEARCHRESPONSEONLY" }],
    },
  },
  // A run cut off by the user has an answer, but it is an interruption rather
  // than a conclusion, so the summary scope must not reach it.
  {
    type: "message",
    id: "u4",
    parentId: "a2",
    timestamp: "2026-02-02T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: "now check the gadget" }] },
  },
  {
    type: "message",
    id: "a5",
    parentId: "u4",
    timestamp: "2026-02-02T00:00:05.000Z",
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "SEARCHABORTEDANSWER the gadget is" }],
    },
  },
]);

// A skill invocation is pi's expansion of a slash command: the whole SKILL.md
// wrapped in pi's own <skill> block, then the prompt the user typed. Its body is
// instruction text the agent reads, not something the user wrote, so the title
// and the prompt index must show the invocation and the prompt only.
writeFixture("--tmp-ws-gamma--", "2026-03-03T00-00-00-000Z_cccc.jsonl", [
  { type: "session", version: 3, id: "cccc", timestamp: "2026-03-03T00:00:00.000Z", cwd: "/tmp/ws-gamma" },
  {
    type: "message",
    id: "u3",
    parentId: null,
    timestamp: "2026-03-03T00:00:01.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            '<skill name="skill:review-helper" location="/tmp/skills/review-helper/SKILL.md">',
            "References are relative to /tmp/skills/review-helper.",
            "",
            "# Review Helper",
            "",
            "SKILLBODYONLY follow these steps when reviewing.",
            "</skill>",
            "",
            "SKILLPROMPTTERM please review the diff",
          ].join("\n"),
        },
      ],
    },
  },
]);

// A prompt the composer sent with a document carries the extracted text in a
// block of pi-web's own. That text is what the model read, not what the user
// typed, so the session title and the prompt index must show the file name and
// leave the body alone — a 100 KB PDF would otherwise match every query.
writeFixture("--tmp-ws-delta--", "2026-04-04T00-00-00-000Z_dddd.jsonl", [
  { type: "session", version: 3, id: "dddd", timestamp: "2026-04-04T00:00:00.000Z", cwd: "/tmp/ws-delta" },
  {
    type: "message",
    id: "u4",
    parentId: null,
    timestamp: "2026-04-04T00:00:01.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "DOCPROMPTTERM summarize this",
            "",
            '<attached-file name="quarterly &amp; report.pdf" kind="pdf" pages="2">',
            "ATTACHEDBODYONLY revenue rose twelve percent",
            "</attached-file>",
          ].join("\n"),
        },
      ],
    },
  },
]);

const server = spawn(
  process.execPath,
  [path.join(ROOT, "server.js"), "--port", String(PORT), "--session-dir", FIXTURE_DIR, "--followup-dir", FOLLOWUP_DIR],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  }
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

function stopServer() {
  if (!server.killed) server.kill("SIGTERM");
}

/** Open an SSE stream and expose records as they arrive, so one stream can be
 *  read across several assertions (a second reader on the same body throws). */
async function sseClient(url) {
  const ctl = new AbortController();
  const res = await fetch(url, { signal: ctl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const waiters = [];
  let buffer = "";
  let closed = false;
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            queue.push(JSON.parse(line.slice(6)));
          } catch {
            continue; // keepalive or malformed frame
          }
          wake();
        }
      }
    } catch {
      // aborted by close()
    }
    closed = true;
    wake();
  })();
  return {
    /** Records up to and including the first one `predicate` accepts; empty
     *  when the timeout expires or the stream ends first. */
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex(predicate);
        if (i >= 0) return queue.splice(0, i + 1);
        const left = deadline - Date.now();
        if (closed || left <= 0) return [];
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close() {
      ctl.abort();
    },
  };
}

/** Background processes a bash call leaves behind.
 * * The failure this pins: `nohup node server/x.js &` inside a bash tool call keeps
 * running after the call, the run and the agent process — reparented to init,
 * with nothing in the RPC stream ever mentioning it again. Without this the
 * server is invisible from the UI and can only be found with `ps`.
 *
 * The agent's bash bracketing runs on the live event path, and driving a real
 * tool call needs a model and credentials. So the server is started with
 * PI_UI_TEST_HOOKS=1 and the test injects the two `tool_execution_*` events a
 * real call would produce, around a genuinely detached child this test starts.
 * The code under test — the before/after process-table diff — is untouched. */
async function backgroundProcessChecks() {
  const port = PORT + 2;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "server.js"), "--port", String(port), "--session-dir", FIXTURE_DIR],
    {
      cwd: ROOT,
      env: { ...process.env, PI_UI_TEST_HOOKS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const post = async (pathname, body) =>
    (
      await fetch(`${base}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const spawnedPids = [];
  const killSpawned = () => {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

  };

  const exists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it is there but owned by someone else — alive either way.
      return err.code === "EPERM";
    }
  };

  try {
    const wsDir = path.join(FIXTURE_DIR, "--proc-ws--");
    const sessionFile = path.join(wsDir, "2026-05-05T00-00-00-000Z_pp.jsonl");
    writeFixture("--proc-ws--", path.basename(sessionFile), [
      { type: "session", version: 3, id: "pp", timestamp: "2026-05-05T00:00:00.000Z", cwd: FIXTURE_DIR },
    ]);

    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    const es = await sseClient(`${base}/api/events?client=p1`);
    await es.waitFor((r) => r?.event === "hello", 3000);
    await post("/api/open", { client: "p1", sessionFile });

    // Nothing left running yet: the panel must be empty, not merely unloaded.
    const none = await (await fetch(`${base}/api/processes?client=p1`)).json();
    check("/api/processes starts empty for a fresh session", Array.isArray(none.processes) && none.processes.length === 0, JSON.stringify(none).slice(0, 200));

    // Inject the two `tool_execution_*` events a real bash call produces, then
    // start a genuinely detached child between them so the server's before/after
    // process-table diff has something to find.
    const injected = await post("/api/test/inject", {
      client: "p1",
      event: { type: "tool_execution_start", toolCallId: "call_smoke_bash", toolName: "bash" },
    });
    check("the test hook is reachable", injected?.ok === true, JSON.stringify(injected).slice(0, 160));
    // Started exactly the way a real bash call starts one: an intermediate shell
    // in its own process group (pi spawns the tool's shell detached), which
    // backgrounds the child and exits. The child inherits that group and outlives
    // it, so the group id has no live leader left — the signature the diff looks
    // for. Launching it in the test's own group would keep that group alive and
    // make the child look independent.
    const shell = spawn("/bin/sh", ["-c", "nohup sleep 120 > /dev/null 2>&1 & echo $!"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let shellOut = "";
    shell.stdout.on("data", (d) => (shellOut += d));
    await new Promise((resolve) => shell.on("exit", resolve));
    const fakePid = Number(shellOut.trim());
    if (Number.isInteger(fakePid) && fakePid > 0) spawnedPids.push(fakePid);
    await post("/api/test/inject", {
      client: "p1",
      event: { type: "tool_execution_end", toolCallId: "call_smoke_bash", toolName: "bash" },
    });

    // Wait for the broadcast that actually carries the leftover: attaching to a
    // session also emits an empty snapshot, so matching the first one would read
    // that instead.
    const batch = await es.waitFor((r) => r?.event === "background_processes" && (r.processes || []).length > 0, 15000);
    const pushedList = batch.filter((r) => r?.event === "background_processes").at(-1)?.processes || [];
    check(
      "a leftover is broadcast to the attached tab",
      pushedList.length > 0,
      batch.length ? JSON.stringify(batch).slice(0, 300) : "no background_processes record"
    );
    check(
      "the broadcast names the process that was left running",
      fakePid ? pushedList.some((p) => p.pid === fakePid) : false,
      `fake pid ${fakePid} vs ${JSON.stringify(pushedList).slice(0, 300)}`
    );

    const listed = await (await fetch(`${base}/api/processes?client=p1`)).json();
    check(
      "/api/processes lists the leftover with a pid and command",
      listed.processes?.some((p) => p.pid === fakePid && typeof p.command === "string" && p.command.length > 0),
      JSON.stringify(listed).slice(0, 300)
    );

    // The route is an allow-list, not "kill any pid": the whole point of the
    // panel is that it cannot be turned into arbitrary process control.
    const foreign = await post("/api/processes/kill", { client: "p1", pid: 1 });
    check("killing a pid this session did not start is refused", foreign?.ok !== true, JSON.stringify(foreign).slice(0, 200));
    check("a refused kill leaves pid 1 alive", exists(1));

    const killed = await post("/api/processes/kill", { client: "p1", pid: fakePid });
    check("killing a recorded leftover is accepted", killed?.ok === true, JSON.stringify(killed).slice(0, 200));

    // SIGTERM lands immediately; the entry is dropped without waiting for the
    // SIGKILL backstop.
    let gone = false;
    for (let i = 0; i < 40; i++) {
      if (!exists(fakePid)) {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    check("the killed leftover is gone", gone, `pid ${fakePid} still alive`);

    const after = await (await fetch(`${base}/api/processes?client=p1`)).json();
    check(
      "/api/processes drops a stopped process",
      !(after.processes || []).some((p) => p.pid === fakePid),
      JSON.stringify(after).slice(0, 300)
    );

    // A page reload reconnects to a process that may still hold leftovers, and
    // nothing is broadcast until the next bash call — so the snapshot rides the
    // attach, exactly like the queue snapshot above.
    es.close();
    const reconnected = await sseClient(`${base}/api/events?client=p1`);
    const replayed = await reconnected.waitFor((r) => r?.event === "background_processes", 3000);
    check(
      "re-attaching replays the background process list",
      replayed.length > 0 && Array.isArray(replayed.at(-1)?.processes),
      JSON.stringify(replayed).slice(0, 300)
    );
    // A replayed list is a hand-over, not a change: the tab that arrives late
    // shows the rows but must not claim a process just started, or every reload
    // would raise the badge for a server that was already there.
    check(
      "a replayed process list is marked as a snapshot",
      replayed.at(-1)?.snapshot === true,
      JSON.stringify(replayed.at(-1)).slice(0, 200)
    );

    // A leftover can exit on its own — the user kills it from a terminal, or it
    // finishes. Nothing about that arrives as an event, so the server has to
    // notice and push. Without the sweep the row and its badge stayed until the
    // resources panel was opened, which re-read the list as a side effect: the
    // bug was that closing (or never opening) the panel kept a dead process on
    // screen forever.
    await post("/api/test/inject", {
      client: "p1",
      event: { type: "tool_execution_start", toolCallId: "call_sweep_bash", toolName: "bash" },
    });
    const sweepShell = spawn("/bin/sh", ["-c", "nohup sleep 600 > /dev/null 2>&1 & echo $!"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let sweepOut = "";
    sweepShell.stdout.on("data", (d) => (sweepOut += d));
    await new Promise((resolve) => sweepShell.on("exit", resolve));
    const sweepPid = Number(sweepOut.trim());
    if (Number.isInteger(sweepPid) && sweepPid > 0) spawnedPids.push(sweepPid);
    await post("/api/test/inject", {
      client: "p1",
      event: { type: "tool_execution_end", toolCallId: "call_sweep_bash", toolName: "bash" },
    });

    const sweepEs = await sseClient(`${base}/api/events?client=p1`);
    const appeared = await sweepEs.waitFor(
      (r) => r?.event === "background_processes" && (r.processes || []).some((p) => p.pid === sweepPid),
      20000
    );
    check("a second leftover is recorded", appeared.length > 0 && sweepPid > 0, `pid ${sweepPid}`);

    // Let it exit without touching /api/processes or the kill route: only the
    // server's own sweep can notice this.
    if (sweepPid > 0) {
      try {
        process.kill(sweepPid, "SIGTERM");
      } catch {}
    }
    const receded = await sweepEs.waitFor(
      (r) => r?.event === "background_processes" && !(r.processes || []).some((p) => p.pid === sweepPid),
      20000
    );
    check(
      "an exited leftover is swept and broadcast without a panel read",
      receded.length > 0 && (receded.at(-1).processes || []).length === 0,
      JSON.stringify(receded.at(-1)?.processes)
    );
    // The sweep must be a change, not a snapshot: the badge counts changes, so a
    // snapshot here would leave the mark lit for a process that is already gone.
    check(
      "the sweep broadcast is a change, not a snapshot",
      receded.length > 0 && receded.at(-1).snapshot === undefined,
      JSON.stringify(receded.at(-1))
    );
    sweepEs.close();

    reconnected.close();
  } finally {
    killSpawned();
    child.kill("SIGTERM");
    if (failures && log.trim()) console.error(`\nbackground-process server log:\n${log.trim()}`);
  }
}


/** Two sessions in one workspace must not share an extension runtime.
 *
 *  The regression this pins: `AgentSessionServices` bundles the resource loader,
 *  and behind it one extension runtime. Sessions built from a cached per-cwd
 *  services object therefore shared that runtime, and `AgentSession.dispose()`
 *  calls `extensionRunner.invalidate()` on it — so disposing any one session (the
 *  idle reaper, or the old session a new/fork/switch hands off from) left every
 *  other session in the workspace with handlers that throw "This extension ctx
 *  is stale", and every session opened afterwards reported that error on its own
 *  `session_start`. The stale ctx is observable directly, without any extension
 *  of the user's own: `runtime.assertActive()` throws once poisoned. */
async function workspaceIsolationChecks() {
  const { SessionHost } = await import(path.join(ROOT, "sdk", "host.js"));
  const { loadSdk } = await import(path.join(ROOT, "sdk", "load.js"));
  let sdk;
  try {
    ({ mod: sdk } = await loadSdk());
  } catch (err) {
    check("the SDK is loadable, so workspace isolation can be checked", false, err.message);
    return;
  }
  const clients = new Map();
  const host = new SessionHost({ sdk, cwd: ROOT, sessionDir: FIXTURE_DIR, clients });
  const open = async (client) => {
    clients.set(client, { res: null, key: null, detachedAt: 0 });
    await host.open({ client });
  };
  // Disposing the way `#drop` and `#replace` do, so the check covers the path the
  // server actually takes rather than only AgentSession.dispose() in isolation.
  const drop = async (key) => {
    const session = host.sessions.get(key);
    host.sessions.delete(key);
    for (const [file, k] of host.fileAlias) if (k === key) host.fileAlias.delete(file);
    await session.dispose();
  };
  const live = (session) => {
    try {
      session.session.extensionRunner.runtime.assertActive();
      return true;
    } catch {
      return false;
    }
  };

  await open("iso-a");
  await open("iso-b");
  const [firstKey, secondKey] = [...host.sessions.keys()];
  check("two sessions in one workspace are both live", live(host.sessions.get(firstKey)) && live(host.sessions.get(secondKey)));

  await drop(firstKey);
  check(
    "disposing one session does not invalidate its sibling's extension ctx",
    live(host.sessions.get(secondKey))
  );

  await open("iso-c");
  check(
    "a session opened after a sibling was disposed still has a live extension ctx",
    live([...host.sessions.values()].at(-1))
  );
  check("one workspace is shared, not one per session", host.workspaces.size === 1);
  // Sessions hold live model runtimes, MCP connections and extension event
  // buses. Leaving them bound keeps the event loop alive, so the process would
  // print "all smoke checks passed" and then hang instead of exiting — which is
  // what made this file look like it needed a manual kill.
  await host.disposeAll();
}

/** The in-process ExtensionUi replaces the RPC bridge's dialog plumbing. A
 *  resolution bug here would hang any extension that asks the user a question,
 *  so the promise contract is checked directly rather than through a dialog. */
async function extensionUiChecks() {
  const { ExtensionUi } = await import(path.join(ROOT, "sdk", "ui-context.js"));
  const emitted = [];
  const ui = new ExtensionUi((r) => emitted.push(r));
  const ctx = ui.context();
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  const pick = ctx.select("Pick one", ["a", "b"]);
  await settle();
  const selectReq = emitted.find((e) => e.method === "select");
  check("a dialog request carries method, title, options and an id", Boolean(selectReq?.id && selectReq?.title && selectReq?.options?.length === 2), JSON.stringify(selectReq).slice(0, 160));
  ui.answer(selectReq.id, { value: "b" });
  check("an answered select resolves with the chosen value", (await pick) === "b");

  const sure = ctx.confirm("Sure?", "do it");
  await settle();
  ui.answer(emitted.filter((e) => e.method === "confirm").at(-1).id, { confirmed: false });
  check("an answered confirm resolves with the boolean", (await sure) === false);

  const named = ctx.input("Name", "placeholder");
  await settle();
  ui.answer(emitted.filter((e) => e.method === "input").at(-1).id, { cancelled: true });
  check("a cancelled input resolves undefined", (await named) === undefined);

  const slow = ctx.select("Slow", ["x"], { timeout: 40 });
  check("a dialog that times out resolves its default", (await slow) === undefined);

  check("an unknown dialog id is refused, not crashed on", ui.answer("no-such-id", { value: "z" }) === false);

  // A question asked while no tab is attached is still pending when one comes
  // back. ask_user_question and every permission gate call select() with no
  // timeout, so without a replay the caller blocks until the server restarts.
  const stranded = ctx.select("Stranded", ["a", "b"]);
  await settle();
  const strandedReq = emitted.filter((e) => e.method === "select").at(-1);
  const snap = ui.snapshot();
  check("a pending dialog is included in the replay snapshot", snap.some((r) => r.id === strandedReq.id && r.method === "select"), JSON.stringify(snap));
  check("the snapshot carries the options the browser needs", (snap.find((r) => r.id === strandedReq.id)?.options || []).join(",") === "a,b");
  ui.answer(strandedReq.id, { value: "b" });
  check("a replayed dialog is still answerable by id", (await stranded) === "b");
  check("an answered dialog leaves the replay snapshot", !ui.snapshot().some((r) => r.id === strandedReq.id));

  // Answering is reported truthfully: the route tells "already answered" (a
  // retry) apart from "never seen here" (another session's dialog), because a
  // silent ok:true left the asking session blocked with nothing on screen.
  check("an answered id is remembered as answered", ui.wasAnswered(strandedReq.id) === true);
  check("an id this session never had is not reported as answered", ui.wasAnswered("no-such-id") === false);

  ctx.notify("hello", "info");
  ctx.setStatus("k", "v");
  check("notify and setStatus are emitted to the browser", emitted.some((e) => e.method === "notify") && emitted.some((e) => e.method === "setStatus"));

  // TUI-only members must be callable no-ops: an extension calling one must not
  // crash on "undefined is not a function".
  let tuiSafe = true;
  for (const member of ["setFooter", "setHeader", "setWorkingMessage", "onTerminalInput", "setEditorComponent"]) {
    try {
      ctx[member](() => {});
    } catch {
      tuiSafe = false;
    }
  }
  check("TUI-only extension calls are safe no-ops", tuiSafe);
  check("the theme returns text unchanged", ctx.theme.fg("accent", "text") === "text");
}

/** Queue snapshot on (re)attach. The SDK session really does queue a steer and
 *  emits `queue_update` for it, so this needs no credentials and no stand-in
 *  process: steer while idle is a genuine queue mutation. pi emits queue_update
 *  only when the queue changes, so without the snapshot a tab that switches away
 *  and back keeps an empty dock while the session still holds those messages. */
async function queueSnapshotChecks() {
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "server.js"), "--port", String(port), "--session-dir", FIXTURE_DIR],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const post = async (pathname, body) =>
    (await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
  const sessionA = path.join(FIXTURE_DIR, "--queue-ws-a--", "2026-03-01T00-00-00-000Z_qa.jsonl");
  const sessionB = path.join(FIXTURE_DIR, "--queue-ws-b--", "2026-03-02T00-00-00-000Z_qb.jsonl");
  // A session's process runs in the cwd its header records, so this fixture's
  // cwd has to exist — otherwise the fake binary cannot be spawned at all.
  writeFixture("--queue-ws-a--", path.basename(sessionA), [
    { type: "session", version: 3, id: "qa", timestamp: "2026-03-01T00:00:00.000Z", cwd: FIXTURE_DIR },
  ]);
  writeFixture("--queue-ws-b--", path.basename(sessionB), [
    { type: "session", version: 3, id: "qb", timestamp: "2026-03-02T00:00:00.000Z", cwd: FIXTURE_DIR },
  ]);
  const holdsQueued = (r) => Array.isArray(r?.steering) && r.steering.includes("QUEUED-ONE");

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // One stream for the whole scenario: the server keeps a single live stream
    // per client id, exactly like the app's one EventSource per tab.
    const es = await sseClient(`${base}/api/events?client=q1`);
    await es.waitFor((r) => r?.event === "hello", 3000);
    await post("/api/open", { client: "q1", sessionFile: sessionA });
    const steered = await post("/api/cmd", { client: "q1", type: "steer", message: "QUEUED-ONE" });
    check("steer is accepted as queued", steered?.data?.disposition === "queued", JSON.stringify(steered).slice(0, 160));
    const before = await es.waitFor(holdsQueued);
    check("queue_update reaches the attached tab", before.some(holdsQueued), JSON.stringify(before).slice(0, 200));

    // Switch to another session and back. The queue lives in session A's
    // process; nothing in the switch produces a queue_update, so the re-attach
    // has to replay the snapshot or the dock comes back empty.
    await post("/api/open", { client: "q1", sessionFile: sessionB });
    await post("/api/open", { client: "q1", sessionFile: sessionA });
    const replay = await es.waitFor(holdsQueued);
    check("re-attaching a session replays its pending queue", replay.some(holdsQueued), JSON.stringify(replay).slice(0, 200));

    // An EventSource reconnect uses the same client id on a new stream; the
    // tab missed nothing but must still be told what is pending.
    es.close();
    const reconnected = await sseClient(`${base}/api/events?client=q1`);
    const afterReconnect = await reconnected.waitFor(holdsQueued, 3000);
    check(
      "a reconnected event stream replays the pending queue",
      afterReconnect.some(holdsQueued),
      JSON.stringify(afterReconnect).slice(0, 200)
    );

    await post("/api/cmd", { client: "q1", type: "clear_queue" });
    const cleared = await reconnected.waitFor((r) => Array.isArray(r?.steering) && !r.steering.length, 5000);
    check("clearing the queue is broadcast", cleared.length > 0, JSON.stringify(cleared).slice(0, 200));

    // Nothing pending: a re-attach must stay silent rather than flash an
    // empty dock back onto the screen.
    reconnected.close();
    const quiet = await sseClient(`${base}/api/events?client=q1`);
    const snapshots = await quiet.waitFor((r) => Array.isArray(r?.steering), 800);
    check("an empty queue sends no snapshot", snapshots.length === 0, JSON.stringify(snapshots).slice(0, 200));
    quiet.close();
  } finally {
    child.kill("SIGTERM");
    if (failures && log.trim()) console.error(`\nqueue-snapshot server log:\n${log.trim()}`);
  }
}

try {
  check("server starts and answers /api/health", await waitForServer());

  const index = await fetch(`${BASE}/`);
  const html = await index.text();
  check("GET / returns 200", index.status === 200, `got ${index.status}`);
  check("page has the app title", html.includes("<title>pi-ui</title>"));
  check("page links the stylesheet", html.includes('href="/style.css"'));
  check("page loads the frontend script", html.includes('src="/app.js"'));

  for (const asset of ["/style.css", "/app.js", "/favicon.svg", "/vendor/prism.min.js", "/vendor/mermaid.min.js"]) {
    const res = await fetch(`${BASE}${asset}`);
    check(`GET ${asset} returns 200`, res.status === 200, `got ${res.status}`);
  }

  // Syntax highlighting is vendored, not a dependency: it has to be served from
  // a bare checkout, and the script has to load before app.js so the first
  // render finds `window.Prism`. `data-manual` matters — Prism's own
  // auto-highlight rescans every `code[class*=language-]` on the page, which
  // this app never wants because it highlights each block as it renders it.
  {
    const prism = await fetch(`${BASE}/vendor/prism.min.js`);
    check("the vendored Prism bundle is offered", prism.status === 200, `got ${prism.status}`);
    check("the Prism bundle is served as JavaScript", /javascript/.test(prism.headers.get("content-type") || ""));
    const body = await prism.text();
    check("the bundle carries a grammar the transcripts use", body.includes("languages.bash"));
    // diff is the one grammar that is not a language a model writes: every edit
    // tool result renders as a diff fence, so it must be in the bundle.
    check("the bundle carries the diff grammar", body.includes("languages.diff"));
    check("prism.min.js loads before app.js", html.indexOf("/vendor/prism.min.js") < html.indexOf('/app.js"'));
    check("Prism auto-highlight is disabled", /prism\.min\.js"[^>]*data-manual/.test(html));
  }

  // Mermaid renders the ```mermaid fences in an answer. It is far too large to
  // parse on every page load, so app.js injects it on the first diagram; the
  // bundle still has to be served from a bare checkout.
  {
    const mermaid = await fetch(`${BASE}/vendor/mermaid.min.js`);
    check("the vendored Mermaid bundle is offered", mermaid.status === 200, `got ${mermaid.status}`);
    check("the Mermaid bundle is served as JavaScript", /javascript/.test(mermaid.headers.get("content-type") || ""));
    const body = await mermaid.text();
    check("the Mermaid bundle registers its global", body.includes("globalThis[\"mermaid\"]"));
    check("the Mermaid bundle carries the flowchart renderer", body.includes("flowchart"));
    check("mermaid.min.js is not linked from index.html", !html.includes("/vendor/mermaid.min.js"));
  }

  // A file:// link used to fall through the inline parser and render as raw
  // "[text](url)". It is a separate branch because the click cannot navigate:
  // Chrome refuses to take an http page to a local path, so the handler copies
  // it. Both halves are pinned here — the parse and the styled outcome.
  const appJs = await (await fetch(`${BASE}/app.js`)).text();
  check("app.js parses file: links", appJs.includes('a class="local-link"'));
  check("app.js turns a local-link click into a copy", appJs.includes('closest?.("a.local-link")'));

  // A refresh() snapshots the persisted branch and adopts it wholesale. Anything
  // a live event painted while that get_entries round-trip was in flight is
  // absent from the snapshot, so adopting it deleted the turn from the page —
  // the "a prompt in an existing session never appears until you switch away and
  // back" report. The transcript has to remember what it appended, and refresh
  // has to carry those items past the rebuild.
  check("app.js stamps when an item reached the transcript", appJs.includes("let liveSeq = 0"));
  check(
    "app.js keeps what arrived while a refresh was in flight",
    /const cut = liveSeq;[\s\S]{0,1600}it\.appendedAt <= cut[\s\S]{0,300}rebuilt\.push\(it\)/.test(appJs)
  );
  check(
    "message_end keeps a turn's place in that boundary",
    /built\.appendedAt = item\.appendedAt;/.test(appJs)
  );
  const css = await (await fetch(`${BASE}/style.css`)).text();
  check("style.css gives rendered links a palette color", css.includes(".assistant-text a {"));

  // A nested list is structure, not decoration: "rule, then its two sub-rules"
  // flattened into three siblings reads as three peers. Every saved session
  // contains such a list, so the renderer has to keep the indent, and an
  // ordered list that starts at 3 must not be renumbered to 1.
  check("app.js nests lists by indentation", appJs.includes("function renderList(lines, start)") && appJs.includes("stack.push({ indent: item.indent, tag })"));
  check("app.js keeps an ordered list's start number", appJs.includes('` start='));

  // An inline triple backtick is not a fence, but it matches the fence *prefix*:
  // "```foo = 1```, so …" fails the closing-fence regex and the paragraph loop
  // skips it for the same reason, so neither branch consumed the line and
  // renderMarkdown spun forever — the whole tab froze on a session containing
  // one such line. Every branch that can decline a line needs a fallback.
  check(
    "renderMarkdown always consumes a line it cannot classify",
    /if \(!buf\.length\) buf\.push\(inlineMd\(lines\[i\+\+\]\)\)/.test(appJs)
  );

  // ```mermaid is a diagram, not a code sample. Mermaid is async and its bundle
  // is 3.4 MB, so the fence renders a placeholder at parse time and is painted
  // afterwards — never a blocking script in index.html.
  check("app.js recognises a mermaid fence", appJs.includes("function isMermaidFence(") && appJs.includes('name === "mermaid"'));
  check("a mermaid fence becomes a placeholder, not a code block", /md-mermaid" data-mermaid=/.test(appJs));
  check("mermaid is loaded on demand, not from index.html", appJs.includes("function loadMermaid(") && !html.includes("/vendor/mermaid.min.js"));
  check("every markdown render site hydrates diagrams", (appJs.match(/hydrateMermaid\(/g) || []).length >= 4);
  check("a diagram that cannot be drawn keeps its source", appJs.includes("diagram could not be drawn — showing the source"));
  check("style.css frames a diagram", css.includes(".assistant-text .md-mermaid {"));
  // app.js is a classic script, so a top-level `function mermaid()` becomes
  // window.mermaid and shadows the bundle's own global of that name — the
  // "already loaded?" check then passes before the script is ever fetched, and
  // every diagram silently degrades to its source. The helper must stay renamed
  // AND must validate the shape, so a same-named global cannot be mistaken for
  // a loaded bundle.
  check(
    "app.js does not shadow the vendored mermaid global",
    !/^function mermaid\(/m.test(appJs) && !/^\s*function mermaid\(\)/m.test(appJs)
  );
  check("app.js validates the mermaid API shape", /function mermaidApi\(\)[\s\S]{0,400}typeof g\?\.render === "function"/.test(appJs));
  check("a diagram draw is queued, not overlapped", appJs.includes("let mermaidQueue = Promise.resolve()"));
  // Mermaid scopes its whole inline stylesheet on the id it is handed
  // (`#mmd-3 .node rect{…}`), so an SVG inserted without that id loses every
  // rule and the diagram renders as black boxes on a black background. The id
  // must be unique per call and must survive into the DOM.
  check(
    "the mermaid render id reaches the DOM",
    appJs.includes("const id = `mmd-${nextMermaidId()}`") && appJs.includes("m.render(id, src)")
  );
  check("app.js does not strip the mermaid svg id", !appJs.includes('removeAttribute("id")'));

  // A hung child process was the one failure the transcript could not show: a
  // bash call whose command never returns kept the "running" chip forever, so
  // "started 2s ago" and "stuck for 43 minutes" looked identical and the only
  // way to tell was `ps`. The start time is now recorded and rendered, and the
  // status line names the tool so the answer is visible without scrolling.
  check("app.js records when a tool call started", /case "tool_execution_start"[\s\S]{0,400}ex\.startedAt = Date\.now\(\)/.test(appJs));
  check("app.js derives elapsed time for a running call", appJs.includes("function runningFor(exec)"));
  check("app.js flags a call that may be stuck", /STALL_AFTER_MS = \d[\d_]*/.test(appJs) && appJs.includes("tc-duration${stalled ? \" stalled\" : \"\"}"));
  check("the status line names the running tool", appJs.includes("toolName || \"tool\"} running ${fmtElapsed(slow.elapsed)}"));
  check("elapsed time keeps counting while a call is silent", appJs.includes("elapsedTimer = setInterval") && /elapsedTimer = setInterval[\s\S]{0,220}STALL_REPAINT_MS/.test(appJs));
  check("style.css marks a stalled call", css.includes(".tc-duration.stalled"));

  // A provider that accepts the request and then returns nothing is a different
  // failure from a hung tool: nothing is running, so the check above never fired
  // and the bar read a flat "pi is working…" for twelve minutes. The run's last
  // sign of life is stamped on every event and named once it goes quiet.
  check("app.js thresholds a run that sends nothing back", /STALL_FIRST_TOKEN_MS = \d[\d_]*/.test(appJs));
  // Walk the body of handleEvent instead of a character window: the stamp now
  // sits behind a guard (pi-ui's own silence notices are not signs of life), so
  // a fixed window measures how many comment lines were added above it, not
  // whether the stamp survived.
  const handleEventBody = (appJs.match(/function handleEvent\(record\) \{[\s\S]*?\n\}/) || [""])[0];
  check("app.js stamps a run's last sign of life", handleEventBody.includes("state.lastActivityAt = Date.now()"), `${handleEventBody.length} chars`);
  // Walk the case body for the same reason as above: a window measures how much
  // commentary sits in front of the stamp, not whether the stamp is there.
  const agentStartCase = /case "agent_start":([\s\S]*?)\n    case /.exec(appJs)?.[1] ?? "";
  check("app.js starts that clock when the run starts", agentStartCase.includes("state.lastActivityAt = Date.now()"), `${agentStartCase.length} chars`);
  check("app.js clears it when the run settles", /case "agent_settled":[\s\S]{0,200}state\.lastActivityAt = null/.test(appJs));
  check(
    "the status line names a silent provider",
    appJs.includes("No response for ${fmtElapsed(silent)}") && /state\.lastActivityAt != null[\s\S]{0,900}STALL_FIRST_TOKEN_MS/.test(appJs)
  );
  // Folded into the grey "pi is working…" sentence, the warning carried the same
  // size and colour as the sentence around it and went unnoticed. It is now its
  // own row in the dock, tinted danger, and the bar itself switches state.
  check("the dock has a dedicated alert row", html.includes('id="status-alert"'));
  check("the alert row is a sibling of the status bar, so it can wrap", /<\/div>\s*<!--[\s\S]{0,400}?<div id="status-alert"/.test(html) && !/id="status-bar"[^>]*>[\s\S]{0,200}id="status-alert"/.test(html));
  check("the alert row announces itself to assistive tech", /id="status-alert"[^>]*role="status"/.test(html));
  // A window, not a character count: the threshold checks between the two
  // mentions are what decide whether the warning fires at all.
  check(
    "a warning is painted on that row, not appended to the sentence",
    /let warning = ""[\s\S]{0,2500}alert\.textContent = warning/.test(appJs) &&
      !/text \+= ` · no response for/.test(appJs)
  );
  check("the bar enters an alerting state while the warning shows", /alert\.classList\.toggle\("hidden", !warning\)[\s\S]{0,120}bar\.classList\.toggle\("alerting"/.test(appJs));
  check("the alerting state is dropped when the run settles", /bar\.classList\.remove\("alerting"\)/.test(appJs));
  check(
    "style.css tints the alert row and lets it wrap",
    /#status-alert \{[\s\S]{0,400}background: var\(--danger-tint\)[\s\S]{0,400}white-space: normal/.test(css)
  );
  check("style.css recolours the bar and stills its dot while alerting", css.includes("#status-bar.alerting {") && /#status-bar\.alerting::before \{[\s\S]{0,160}animation: none/.test(css));
  // The silent-provider case must not repaint the transcript: nothing in it is
  // aging, so the loop would pay a full render every 5s for no visible change.
  check("a waiting run repaints only the status bar", /elapsedTimer = setInterval[\s\S]{0,320}if \(running\) scheduleRender\(\)/.test(appJs));

  // A dropped provider connection never errors, so a run could sit "streaming"
  // forever on a socket the kernel already closed. The server aborts it once the
  // silence passes a measured threshold, and says so on the event stream.
  const hostJs = fs.readFileSync(new URL("../sdk/host.js", import.meta.url), "utf8");
  check("host.js aborts a run whose provider went silent", hostJs.includes("reapStalled("));
  check("host.js waits past the healthy-gap distribution before aborting", /STALL_ABORT_AFTER_MS = 5 \* 60 \* 1000/.test(hostJs));
  // Reporting and aborting live on opposite sides, and the order is the point:
  // the page names the silence long before the server gives up on it, so a run
  // that recovers is never killed first. Assert the relationship, not the one
  // number a reader could edit in isolation.
  {
    const evaluate = (expr) => expr.split("*").reduce((acc, part) => acc * Number(part.trim().replace(/_/g, "")), 1);
    const abortMs = evaluate(/STALL_ABORT_AFTER_MS = ([^;]+)/.exec(hostJs)?.[1] ?? "0");
    const reportMs = evaluate(/STALL_FIRST_TOKEN_MS = ([^;]+)/.exec(appJs)?.[1] ?? "0");
    check("the page names the silence well before the server aborts", reportMs > 0 && abortMs >= reportMs * 3, `${reportMs} vs ${abortMs}`);
  }
  check("host.js reports the stall to the tab", hostJs.includes('event: "run_stalled"'));
  // One dead run must produce one notice, and a failed abort must not leave the
  // session permanently skipped by the sweeper.
  check("the sweeper reports a dead run once", /if \(session\.stallAborted\) continue;/.test(hostJs));
  // The abort is now bounded (a dead run is the thing that never goes idle), so
  // "did not settle" covers both a rejection and a timeout: either way the
  // verdict must be cleared, or the sweeper skips this run forever.
  check("a failed stall abort retries on the next sweep", /if \(!aborted\)[\s\S]{0,400}session\.stallAborted = false/.test(hostJs));
  check("a stall abort that rejects is logged, not thrown", /stall abort failed[\s\S]{0,200}return false/.test(hostJs));
  check("a new run clears the previous stall verdict", /agent_start[\s\S]{0,300}this\.stallAborted = false/.test(hostJs));
  check("the server sweeps for stalled runs", /setInterval\(\(\) => sessionHost\?\.reapStalled\(\)/.test(fs.readFileSync(new URL("../server.js", import.meta.url), "utf8")));
  check("app.js surfaces a stalled run to the user", appJs.includes('record.event === "run_stalled"'));

  // Silence alone cannot tell a dead connection from a slow model, so the host
  // asks the wire. Both halves are asserted here: that the evidence is
  // classified correctly (a pure function, driven with synthetic records rather
  // than a real socket), and that only a *proven* death can end a run early.
  // Silence alone cannot tell a dead connection from a slow model, so the host
  // asks the network. What it may *not* ask is the socket layer's opinion on a
  // closed socket: measured 2026-11-17, undici reports `error UND_ERR_INFO
  // "reset"` when it recycles a healthy idle connection, a real h1 drop reports
  // ECONNRESET, and a real h2 drop reports neither — so a close proves nothing
  // in either direction, and using it aborted healthy runs. Only an advancing
  // byte counter is evidence, and only of life.
  {
    const wire = await import(new URL("../sdk/wire.js", import.meta.url).href);
    const now = 1_000_000;
    const S = 1000;
    const cursor = (extra) => ({ cursor: true, openedAt: now - 100 * S, ...extra });

    const alive = wire.classifyWire([cursor({ lastBytesAt: now - 2 * S })], { now });
    check("a socket that moved bytes recently reads as alive", alive.state === "alive", alive.state);
    // The point of the distinction: an open socket with no recent bytes is not
    // evidence of death, it is no evidence at all — a run may be thinking.
    const quiet = wire.classifyWire([cursor({ lastBytesAt: now - 120 * S })], { now });
    check("an open but quiet socket reads as unknown, not dead", quiet.state === "unknown", quiet.state);
    // The regression this replaced: a socket that closed is not a verdict. The
    // shape a real drop leaves behind is exactly the shape a pool recycle
    // leaves, so `closedAt` must not reach the state at all.
    check(
      "a closed socket is not evidence of a dead connection",
      wire.classifyWire([cursor({ closedAt: now - 3 * S, closeKind: "error:ECONNRESET" })], { now }).state === "unknown"
    );
    check("sockets for other hosts are ignored", wire.classifyWire([{ cursor: false, lastBytesAt: now }], { now }).state === "unknown");
    // The probe's own connection must never count as the run's: it would make
    // the check prove itself healthy.
    const probe = wire.classifyWire([{ cursor: true, probe: true, lastBytesAt: now - S }], { now });
    check("the reachability probe's own socket is not evidence", probe.state === "unknown", probe.state);
    // With no records at all — a Node without the channel, or another provider —
    // every caller must land on the old, conservative behaviour.
    check("no socket records read as unknown", wire.classifyWire([], { now }).state === "unknown");
    check("wire.js has only the two verdicts it can prove", !/state: "dead"/.test(fs.readFileSync(new URL("../sdk/wire.js", import.meta.url), "utf8")));
  }
  // Early abort is gated on the wire on purpose: the frontend's first warning
  // is 60 s, so a check before that would spend a request on a run that is
  // about to answer (first token: 26 s median, 91 s p90 on this machine).
  {
    const ms = (expr) => expr.split("*").reduce((acc, part) => acc * Number(part.trim().replace(/_/g, "")), 1);
    const wireAfter = ms(/WIRE_CHECK_AFTER_MS = ([^;]+)/.exec(hostJs)?.[1] ?? "0");
    check("the wire is consulted after, not before, the first warning", wireAfter >= 60_000, String(wireAfter));
    check("no tool means no side effect, so a proven dead connection may re-send", /#canAutoRetry\(session\)[\s\S]{0,400}toolCallsThisRun > 0/.test(hostJs));
    check("the automatic re-send is capped", /AUTO_RETRY_MAX = 1\b/.test(hostJs));
    // Only an unreachable host is proof the prompt never arrived; silence plus a
    // closed socket is not, so the fallback keeps its old manual-retry message.
    check("only an unreachable host may re-send on its own", /const proven = reason === "network unreachable";/.test(hostJs));
    check("the tab is told a re-send is underway", hostJs.includes('event: "run_retrying"') && appJs.includes('record.event === "run_retrying"'));
    // A steer is mid-run text, not the turn's opening message: replaying it
    // would present an instruction as a prompt the user never re-sent.
    check("a steer is never recorded as the re-sendable prompt", /streamingBehavior !== "steer"/.test(hostJs));

    // Re-sending on top of the dead turn would hand the model the same prompt
    // twice, so the rewind has to happen before the tab is told to re-read the
    // branch — an announcement that races the rewind paints the turn it removes.
    const resendBody = /async #resendAfterStall\(session\) \{([\s\S]*?)\n  \}/.exec(hostJs)?.[1] ?? "";
    const rewindAt = resendBody.indexOf("#rewindToPromptStart");
    const announceAt = resendBody.indexOf('event: "run_retrying"');
    check("the dead turn is rewound before the re-send is announced", rewindAt >= 0 && announceAt > rewindAt, `${rewindAt} vs ${announceAt}`);
    // Anything the reader watched appear is not a message that never arrived.
    check("a run that produced output is never re-sent automatically", /runProducedOutput\) return false/.test(hostJs));
    check("streamed text counts as output", /hasVisibleDelta\(event\)\) this\.runProducedOutput = true/.test(hostJs));
    // Without a pre-send leaf there is nothing to rewind to, so `willRetry` must
    // not promise a re-send that would stack a second prompt on the dead turn.
    check("no rewind point means no automatic re-send", /lastPromptParentId\) return false/.test(hostJs));
    // The abort is bounded; when it does not settle the tab is told the re-send
    // it was promised is not happening.
    check(
      "a re-send that cannot happen is reported",
      /could not be stopped in time[\s\S]{0,400}/.test(hostJs) && /if \(!aborted\)[\s\S]{0,600}run_retry_failed/.test(hostJs)
    );
  }

  // Syntax highlighting: a fenced block with a known language is tokenized, an
  // unknown one stays plain rather than guessing, and an oversized block is
  // rendered plain so one paste cannot stall a render.
  check("app.js highlights a known fence language", appJs.includes("function highlightCode(raw, lang)"));
  check("app.js caps the text it will highlight", /MAX_HIGHLIGHT_CHARS = \d+/.test(appJs));
  check("app.js falls back to plain text if a grammar throws", /function highlightCode[\s\S]{0,400}catch \{[\s\S]{0,80}return ""/.test(appJs));
  check("style.css colors Prism tokens", css.includes(".assistant-text .token.comment") && css.includes(".assistant-text .token.keyword"));

  // A prompt image read back from a session file arrives as an `imageId`
  // placeholder, not inline base64 (sdk/images.js keeps the bytes out of the
  // transcript). Rendering it straight from `data` gave `data:image/png;base64,`
  // — a broken thumbnail that could not be enlarged. Prompt images have to go
  // through the same on-demand loader tool-result images use.
  check("app.js resolves a prompt image through the image-block loader", /function promptImage\(img\)[\s\S]{0,600}loadImageBlock\(img\)/.test(appJs));
  check(
    "app.js does not render a prompt image straight from placeholder bytes",
    !/data:\$\{img\.mimeType\};base64,\$\{img\.data\}/.test(appJs)
  );
  check("app.js shares one fetch per offloaded image", appJs.includes("const imageBlockPending = new Map()"));

  // A picture only reaches the popup as an image *block* when the tool inlined
  // it. When it did not, three text shapes are still a picture the popup can
  // serve from its path: the metadata stub, a first-line-too-long truncation
  // notice, and an "omitted" note. Only the metadata shape was recognised, so a
  // screenshot refused for its byte size showed no image at all — reported as
  // "JPEGs do not display", when the format was never the variable.
  check(
    "app.js recognises every text-only image result shape",
    /function imageBlockAbsence\(call, result\)[\s\S]{0,2600}reason: "metadata"[\s\S]{0,400}reason: "truncated"[\s\S]{0,300}reason: "omitted"/.test(appJs)
  );
  check(
    "app.js leads a text-only image result with the picture",
    /const missing = imageBlockAbsence\(call, result\);[\s\S]{0,400}imageResultSection\(/.test(appJs)
  );
  // A Cursor `read` names its target relative to the workspace, so an absolute
  // path requirement here meant no Cursor read of a picture ever produced the
  // fallback — the popup showed only `{content:"", totalLines:0, fileSize:N}`.
  // Relative targets are joined onto the session cwd; `..` is refused because
  // /api/image must stay restricted to the path the call actually named.
  check(
    "app.js resolves a relative read target against the session cwd",
    /function absoluteImagePath\(target\)[\s\S]{0,600}state\.cwd[\s\S]{0,400}seg === "\.\."\) return null/.test(appJs)
  );
  // A Cursor read's metadata stub is not always the whole text: when the file
  // has more lines than the display limit, pi-cursor-sdk appends "[N more lines
  // in file. Use offset=…]", so a plain JSON.parse of the text threw and the
  // picture was missed even for an absolute path. Observed 2026-11-17 in a real
  // session as `{content:"", totalLines:302, fileSize:16387}` + that notice.
  check(
    "app.js parses a metadata stub that carries a continuation notice",
    appJs.includes("function leadingJsonObject(text)") &&
      appJs.includes("const meta = leadingJsonObject(text)") &&
      !/JSON\.parse\(text\)/.test(appJs)
  );

  // The first paint cannot wait for app.js, so index.html decides the palette
  // inline — and it has to agree with firstVisitTheme(), or a dark desktop gets
  // a white flash and then a repaint.
  check("index.html picks the palette before paint", html.includes("document.documentElement.dataset.theme = theme"));
  check("a first visit follows the OS theme", /prefers-color-scheme: dark/.test(html) && appJs.includes("(prefers-color-scheme: dark)"));

  // The Follow-up control is a toggle: a second press removes what the first
  // press saved. Both halves have to be present — the pressed class the render
  // sets, the handler that deletes, and the fill that makes "kept" visible.
  check("app.js renders the Follow-up control as a toggle", appJs.includes('class: `turn-action followup-toggle'));
  check("app.js un-keeps a follow-up on a second press", appJs.includes("async function unsaveFollowup"));
  check("style.css paints the pressed Follow-up control", css.includes(".turn-action.kept {"));

  // Favorites is gone: the sidebar's third view used to be a flat list of
  // starred sessions, and leaving any of it behind would show a dead tab.
  check("Favorites is not a sidebar view", !appJs.includes('"favorites"') && !html.includes('id="tab-favorites"'));
  check("the header has no star control", !html.includes('id="btn-favorite"') && !appJs.includes("toggleFavorite"));
  check("no star styling survives in style.css", !css.includes("#btn-favorite") && !css.includes(".s-unstar"));

  // The Follow-ups view is a tree by tag: the grouping has to include the
  // untagged leftovers (a follow-up with no tag must not disappear), and the
  // body of a group is only built when the branch is open.
  check("app.js groups follow-ups by tag", appJs.includes("function followupTree(") && appJs.includes("const UNTAGGED ="));
  check("a tag branch folds", appJs.includes("function followupTagGroup(") && appJs.includes("function setFollowupTagClosed("));
  check(
    "a branch that is closed renders no rows",
    /open \? el\("div", \{ class: "fu-group-items" \}/.test(appJs)
  );
  check(
    "follow-up tags are edited on the document",
    appJs.includes("function followupTagBar(") &&
      appJs.includes("function updateFollowupTags(") &&
      appJs.includes('id: "fu-tag-input"')
  );
  check(
    "a tag save repaints the chips, not the input",
    appJs.includes("function repaintFollowupTagBar(") && appJs.includes('$("#fu-tag-chips")?.replaceChildren')
  );
  check(
    "tag writes for one follow-up are serialised",
    appJs.includes("const followupTagWrites = new Map()") && appJs.includes("function queueFollowupTagWrite(")
  );
  check("the filter matches on tags too", appJs.includes("function followupMatches("));
  check("style.css draws the tag tree", css.includes(".fu-group-head {") && css.includes(".s-tag {"));

  // The extension dialog used to be one slot: two sessions asking at once meant
  // the second record overwrote the first on screen, and the displaced question
  // had no button anywhere — its session blocked with nothing to see. It is a
  // queue now, and a refused answer goes back into it instead of vanishing.
  check("app.js queues extension dialogs instead of overwriting one slot", appJs.includes("const dialogQueue = [];"));
  check("a second dialog waits its turn", /dialogQueue\.push\(record\)[\s\S]{0,120}if \(!dialogOpen\) showNextDialog\(\)/.test(appJs));
  check("the waiting count is shown to the user", appJs.includes("dialogQueue.length ? `${dialogQueue.length} more waiting`"));
  check("a refused answer returns the dialog to the queue", /dialogQueue\.unshift\(record\)/.test(appJs));
  check("switching sessions drops the previous session's overlays", appJs.includes("function clearDialogs()"));
  // Both ways a tab can point at a different session must clear the overlay: a
  // sidebar switch AND "new session". Leaving it up over the new conversation is
  // how an answer got routed at the wrong session.
  check(
    "both switch and new-session clear the dialog overlay",
    (appJs.match(/clearDialogs\(\);/g) || []).length >= 2 && /async function newSession\(\)[\s\S]{0,900}clearDialogs\(\);/.test(appJs)
  );

  // Copying a summary used to offer only the rich flavour, which a Slack
  // message box drops: it pastes the rendered HTML or the raw Markdown, and
  // Slack renders neither as written. The Slack button must be its own path —
  // mrkdwn text on the clipboard — not a second label on the rich copy.
  check("app.js converts a document to Slack mrkdwn", appJs.includes("function slackMrkdwn("));
  check("the Slack button copies text, not the rich flavour", /function copySlackText\([\s\S]{0,300}clipboard\.writeText\(slackMrkdwn/.test(appJs));
  check("assistant turns offer the Slack copy", /function copyTurnAsSlack\([\s\S]{0,300}copySlackText/.test(appJs));
  check("a saved follow-up offers the Slack copy", /title: "Copy as Slack mrkdwn[\s\S]{0,300}copySlackText\(rec\.text\)/.test(appJs));
  // Slack's dialect is not Markdown's: **bold** has to leave as *bold*, and an
  // escaped `&` must not double-encode the entities the same pass writes.
  check(
    "Slack bold is a single asterisk",
    appJs.includes("replace(/\\*\\*([^*]+)\\*\\*/g, (m, bold) => hold(`*${bold}*`))")
  );
  check("Slack escaping handles the ampersand first", /\.replace\(\/&\/g, "&amp;"\)\.replace\(\/<\/g, "&lt;"\)/.test(appJs));

  // A dead or hung server used to look like a healthy page: the transcript and
  // sidebar stayed on screen, the composer still accepted text, and the only
  // sign was "connection lost — retrying…" in a sidebar corner (plus a bare
  // "prompt failed: Failed to fetch" if the user tried to send). The banner,
  // the composer block and the periodic health probe are what end that.
  check("the composer dock carries a connection banner", html.includes('id="conn-banner"'));
  check("the banner is an alert, not decoration", /id="conn-banner"[^>]*role="alert"/.test(html));
  check("the banner offers a retry", html.includes('id="conn-retry"'));
  check("app.js tracks an explicit connection state", appJs.includes('let connState = "live"'));
  check("a transport failure is told apart from an HTTP error", appJs.includes("function isTransportError(err)"));
  check("the composer refuses a send while unreachable", /if \(connState !== "live"\)[\s\S]{0,200}return;/.test(appJs));
  check("the send button is disabled while unreachable", /function renderConnState\(\)[\s\S]{0,2600}send\.disabled = bad/.test(appJs));
  check("the placeholder names the recovery step", appJs.includes("server unreachable — start it, then Retry now"));
  // A hung server holds the SSE connection open and never errors, so liveness
  // has to be probed rather than inferred from stream silence.
  check("a health probe runs for the life of the page", appJs.includes("function startConnProbe()"));
  check("the probe is started at boot", /connectEvents\(\);[\s\S]{0,300}startConnProbe\(\)/.test(appJs));
  check("recovery re-attaches the session", appJs.includes("async function resumeSession()"));
  check("style.css tints the banner", css.includes(".conn-banner {"));

  // Leftover background processes show in the composer dock as well as the
  // resources panel, each row with a Stop. The badge beside the resources icon
  // is a "go and look" mark: opening the panel clears it, and a process that
  // starts later raises it again, so it is counted against an acknowledgement
  // rather than being on whenever the list is non-empty.
  check("the dock reserves a row container for leftover processes", html.includes('id="process-bar"'));
  check("app.js renders one dock row per leftover process", appJs.includes("function renderProcessBar"));
  check("app.js gives each dock row a Stop", appJs.includes('text: "Stop", title: `Stop ${p.pid}'));
  // Assert the *body* of renderStatus rather than a character budget: a fixed
  // window broke twice as unrelated lines were added above it. Take everything
  // up to the next top-level function instead.
  const renderStatusBody = (appJs.match(/function renderStatus\(\) \{[\s\S]*?\n\}/) || [""])[0];
  check(
    "app.js re-renders the dock rows with the status bar",
    renderStatusBody.includes("renderProcessBar()") && renderStatusBody.includes("#queue-bar"),
    `${renderStatusBody.length} chars`
  );
  check("opening the resources panel acknowledges the badge", /function setResourcesOpen\(open\)[\s\S]{0,900}acknowledgeProcesses\(\)/.test(appJs));

  // Streaming must not parse Markdown per delta: it paints literal text into one
  // node and appends each delta to it. These are the three parts that make that
  // safe — the fast path, the message_end hand-back to real Markdown, and the
  // scroll follow that renderTranscript no longer provides for those deltas.
  check("a delta appends to a text node instead of re-rendering", appJs.includes("slot.text.appendData(delta)"));
  check("the delta path is abandoned when the node was replaced", /function applyStreamDelta[\s\S]{0,600}return false/.test(appJs));
  check("a streaming block paints literal text", /item\.streaming\) \{[\s\S]{0,700}appendPlainText\(d/.test(appJs));
  check(
    "the finished message is re-rendered as Markdown",
    /built\.node = item\.node;[\s\S]{0,120}built\.dirty = true;/.test(appJs)
  );
  check("a streaming delta keeps a pinned view at the bottom", /function applyStreamDelta[\s\S]{0,600}followViewIfPinned\(\)/.test(appJs));
  check("scrolling up during a stream stops the follow", /addEventListener\("scroll"[\s\S]{0,300}streamPinned = transcriptAtBottom\(\)/.test(appJs));

  // The sidebar filter is debounced so a typing burst rebuilds the list once.
  check("the session filter is debounced", /session-filter"\)\.addEventListener\("input", queueSidebarRender\)/.test(appJs));
  check("the badge counts only unacknowledged processes", appJs.includes("n - state.processesAcked"));
  check("style.css lays the dock rows out as a stack", css.includes("#process-bar {"));
  check("style.css styles a dock row", css.includes(".proc-row {"));

  const securityHeaders = (await fetch(`${BASE}/`)).headers;
  check("X-Content-Type-Options: nosniff", securityHeaders.get("x-content-type-options") === "nosniff");
  check("X-Frame-Options: DENY", securityHeaders.get("x-frame-options") === "DENY");
  check("Referrer-Policy: no-referrer", securityHeaders.get("referrer-policy") === "no-referrer");

  const config = await (await fetch(`${BASE}/api/config`)).json();
  check("/api/config reports a cwd", typeof config.cwd === "string" && config.cwd.length > 0);
  check("/api/config reports the pi binary", typeof config.piBin === "string" && config.piBin.length > 0);

  // The resources panel reads MCP state through `pi mcp list --json`, which pi
  // can answer with no servers configured, with servers that fail to connect,
  // or (when pi is missing) not at all. All three are 200s with a servers/errors
  // pair: a disconnected server is a state to display, not a failed request.
  const mcpRes = await fetch(`${BASE}/api/mcp`);
  const mcp = await mcpRes.json().catch(() => ({}));
  check("/api/mcp answers with a server list", mcpRes.status === 200 && Array.isArray(mcp.servers), `got ${mcpRes.status}`);
  check("/api/mcp answers with an errors list", Array.isArray(mcp.errors), JSON.stringify(mcp).slice(0, 200));

  // Follow-ups: a summary the user kept, stored under the configured directory
  // and readable without pi or the session it came from. The write is the real
  // one — there is no separate fixture path — and the read must not need the
  // session file to exist.
  const emptyFollowups = await (await fetch(`${BASE}/api/followups`)).json();
  check("/api/followups starts empty", Array.isArray(emptyFollowups.followups) && emptyFollowups.followups.length === 0);
  const followupText = "## Findings\n\nThe module is unused.\n\n| file | note |\n| --- | --- |\n| a.js | dead |\n";
  const saved = await fetch(`${BASE}/api/followups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "FollowupTitle", text: followupText, cwd: "/tmp/ws-alpha" }),
  });
  const savedBody = await saved.json().catch(() => ({}));
  check("/api/followups saves a summary", saved.ok && typeof savedBody.followup?.id === "string", JSON.stringify(savedBody).slice(0, 200));
  const followupId = savedBody.followup?.id;
  const savedFile = path.join(FOLLOWUP_DIR, `${followupId}.json`);
  check("a follow-up is one JSON file on disk", fs.existsSync(savedFile), savedFile);
  const listed = await (await fetch(`${BASE}/api/followups`)).json();
  check(
    "/api/followups lists the saved summary with metadata",
    listed.followups.length === 1 && listed.followups[0].title === "FollowupTitle" && listed.followups[0].chars === followupText.length,
    JSON.stringify(listed).slice(0, 200)
  );
  check(
    "/api/followups lists metadata without the body",
    listed.followups[0]?.text === undefined,
    JSON.stringify(listed.followups[0]).slice(0, 200)
  );
  const opened = await (await fetch(`${BASE}/api/followups/${followupId}`)).json();
  check(
    "/api/followups returns the stored Markdown",
    opened.followup?.text === followupText,
    JSON.stringify(opened).slice(0, 200)
  );
  check("/api/followups 404s an unknown id", (await fetch(`${BASE}/api/followups/${"-".repeat(10)}`)).status === 404);
  // Editing rewrites the same file and leaves everything that places the
  // follow-up alone, so an edit never reorders the list or loses its session.
  const editedText = "## Edited\n\nRewritten by hand.\n";
  const edited = await fetch(`${BASE}/api/followups/${followupId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "EditedTitle", text: editedText }),
  });
  const editedBody = await edited.json().catch(() => ({}));
  check("/api/followups PATCH updates title and text", edited.ok && editedBody.followup?.title === "EditedTitle", JSON.stringify(editedBody).slice(0, 200));
  const reread = await (await fetch(`${BASE}/api/followups/${followupId}`)).json();
  check(
    "/api/followups PATCH persists the new body under the same id",
    reread.followup?.id === followupId &&
      reread.followup?.text === editedText &&
      reread.followup?.cwd === "/tmp/ws-alpha" &&
      reread.followup?.createdAt === opened.followup?.createdAt,
    JSON.stringify(reread).slice(0, 200)
  );
  const relisted = await (await fetch(`${BASE}/api/followups`)).json();
  check(
    "/api/followups lists an edit with its new title and size",
    relisted.followups.length === 1 && relisted.followups[0].title === "EditedTitle" && relisted.followups[0].chars === editedText.length,
    JSON.stringify(relisted).slice(0, 200)
  );
  check(
    "/api/followups PATCH rejects an empty body",
    (await fetch(`${BASE}/api/followups/${followupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    })).status === 400
  );
  check(
    "/api/followups PATCH 404s an unknown id",
    (await fetch(`${BASE}/api/followups/${"-".repeat(10)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    })).status === 404
  );
  const editTraversal = (await fetch(`${BASE}/api/followups/${encodeURIComponent("..%2F..%2Fetc%2Fpasswd")}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  })).status;
  check("a follow-up id cannot escape the directory when editing", editTraversal === 404 || editTraversal === 400, `got ${editTraversal}`);
  check("/api/followups rejects an empty body", (await fetch(`${BASE}/api/followups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x", text: "   " }),
  })).status === 400);
  const traversal = await fetch(`${BASE}/api/followups/${encodeURIComponent("..%2F..%2Fetc%2Fpasswd")}`);
  check("a follow-up id cannot escape the follow-up directory", traversal.status === 404 || traversal.status === 400, `got ${traversal.status}`);
  const removed = await fetch(`${BASE}/api/followups/${followupId}`, { method: "DELETE" });
  check("/api/followups deletes a summary", removed.ok && !fs.existsSync(savedFile), `got ${removed.status}`);
  check("deleting a follow-up twice is not an error", (await fetch(`${BASE}/api/followups/${followupId}`, { method: "DELETE" })).ok);

  // Tags are the sidebar tree's branches, so they have to survive a round trip,
  // normalise away the near-duplicates that would split a branch in two, and
  // never be stripped by an edit that did not mention them.
  const tagged = await (await fetch(`${BASE}/api/followups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Tagged", text: "body text", tags: ["  Alpha ", "alpha", "Beta", ""] }),
  })).json();
  const taggedId = tagged.followup?.id;
  check(
    "a saved follow-up keeps its tags, trimmed and de-duplicated",
    Array.isArray(tagged.followup?.tags) &&
      tagged.followup.tags.length === 2 &&
      tagged.followup.tags[0] === "Alpha" &&
      tagged.followup.tags[1] === "Beta",
    JSON.stringify(tagged.followup).slice(0, 200)
  );
  const relistedTags = await (await fetch(`${BASE}/api/followups`)).json();
  const listedTags = relistedTags.followups.find((f) => f.id === taggedId);
  check("the list carries a follow-up's tags", Array.isArray(listedTags?.tags) && listedTags.tags.includes("Beta"));
  const openedTags = await (await fetch(`${BASE}/api/followups/${taggedId}`)).json();
  check("the record stores its tags", Array.isArray(openedTags.followup?.tags) && openedTags.followup.tags.length === 2);
  const retagged = await (await fetch(`${BASE}/api/followups/${taggedId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: ["Beta", "Gamma", "gamma "] }),
  })).json();
  check(
    "/api/followups PATCH rewrites tags",
    Array.isArray(retagged.followup?.tags) && retagged.followup.tags.join(",") === "Beta,Gamma",
    JSON.stringify(retagged.followup?.tags)
  );
  const untitled = await (await fetch(`${BASE}/api/followups/${taggedId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Renamed without tags" }),
  })).json();
  check(
    "a title-only edit leaves the tags alone",
    Array.isArray(untitled.followup?.tags) && untitled.followup.tags.join(",") === "Beta,Gamma",
    JSON.stringify(untitled.followup?.tags)
  );
  check(
    "/api/followups PATCH rejects a non-array tag list",
    (await fetch(`${BASE}/api/followups/${taggedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: "Beta" }),
    })).status === 400
  );
  await fetch(`${BASE}/api/followups/${taggedId}`, { method: "DELETE" });

  const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
  check("/api/sessions returns a list", Array.isArray(sessions.sessions));

  // Cross-session search: every channel (prompt, response, tool request, tool
  // result) is reachable, the system prompt and thinking blocks are not, and
  // the route sits behind the same localhost guards as everything else.
  const search = async (q, extra = "") => (await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}${extra}`)).json();
  const both = await search("flibbertigibbet");
  check("/api/search returns a hits list", Array.isArray(both.hits));
  check("/api/search reports truncation state", typeof both.truncated === "boolean");
  check(
    "/api/search reaches every workspace",
    new Set(both.hits.map((h) => h.cwd)).size === 2,
    JSON.stringify(both.hits.map((h) => h.cwd))
  );
  const channels = new Set(both.hits.map((h) => h.role));
  for (const role of ["user", "assistant", "tool", "toolResult"]) {
    check(`/api/search matches ${role} content`, channels.has(role), [...channels].join(","));
  }
  check("/api/search scopes hits to the matching entry", both.hits.every((h) => h.match.toLowerCase() === "flibbertigibbet"));
  check("/api/search returns a snippet around the match", both.hits.every((h) => h.before != null && h.after != null && h.entryId));

  const toolArg = await search("SEARCHTOOLARG");
  check("/api/search matches tool-call arguments", toolArg.hits.length > 0 && toolArg.hits.every((h) => h.role === "tool"));
  const toolOut = await search("SEARCHTOOLOUT");
  check("/api/search matches tool results", toolOut.hits.length > 0 && toolOut.hits.every((h) => h.role === "toolResult"));

  // Subagent child output is only in details.results[].finalOutput; searching it
  // must reach the child run even though the tool result text differs.
  const childOut = await search("SEARCHCHILDOUT");
  check("/api/search reaches subagent child output", childOut.hits.length === 1, JSON.stringify(childOut.hits.map((h) => h.toolName)));
  check("/api/search labels the subagent child by agent", childOut.hits[0]?.toolName === "subagent/reviewer", childOut.hits[0]?.toolName);
  check(
    "/api/search ignores the system prompt",
    (await search("SEARCHSYSTEMONLY")).hits.length === 0
  );
  check("/api/search ignores thinking blocks", (await search("SEARCHTHINKINGONLY")).hits.length === 0);
  check(
    "/api/search requires all terms",
    (await search("flibbertigibbet widgets")).hits.length === 1,
    JSON.stringify((await search("flibbertigibbet widgets")).hits.map((h) => h.role))
  );
  check("/api/search is case-insensitive", (await search("FLIBBERTIGIBBET")).hits.length === both.hits.length);
  const emptySearch = await search("");
  check("/api/search ignores an empty query", Array.isArray(emptySearch.hits) && emptySearch.hits.length === 0);

  // scope=prompts narrows the same index to user prompts: agent-authored
  // channels (responses, tool requests, tool results, subagent child output)
  // must disappear, and prompts from every workspace must still be reachable.
  const promptHits = await search("flibbertigibbet", "&scope=prompts");
  check(
    "/api/search scope=prompts returns only user prompts",
    promptHits.hits.length > 0 && promptHits.hits.every((h) => h.role === "user"),
    JSON.stringify(promptHits.hits.map((h) => h.role))
  );
  check(
    "/api/search scope=prompts is narrower than the full corpus",
    promptHits.hits.length < both.hits.length,
    `${promptHits.hits.length} of ${both.hits.length}`
  );
  check(
    "/api/search scope=prompts reaches prompts in every workspace",
    new Set([...(await search("flibbertigibbet", "&scope=prompts")).hits, ...(await search("widgets", "&scope=prompts")).hits].map((h) => h.cwd))
      .size === 2,
    JSON.stringify(promptHits.hits.map((h) => h.cwd))
  );
  for (const [label, q] of [["tool-call arguments", "SEARCHTOOLARG"], ["tool results", "SEARCHTOOLOUT"], ["subagent child output", "SEARCHCHILDOUT"], ["responses", "SEARCHRESPONSEONLY"]]) {
    check(`/api/search scope=prompts skips ${label}`, (await search(q, "&scope=prompts")).hits.length === 0);
  }
  check(
    "/api/search scope=prompts finds a prompt in the other workspace",
    (await search("widgets", "&scope=prompts")).hits.some((h) => h.cwd === "/tmp/ws-beta")
  );

  // scope=summary narrows the same index to the answer each run concluded with:
  // the last turn of the run, and only when it settled. Answer text from a mid
  // tool loop (a1), a prompt, a tool request/result and a run cut off by the
  // user (a5) must all stay out.
  const summaryHits = await search("SEARCHSUMMARYANSWER", "&scope=summary");
  check(
    "/api/search scope=summary finds a settled run's answer",
    summaryHits.hits.length === 1 && summaryHits.hits[0].role === "assistant",
    JSON.stringify(summaryHits.hits.map((h) => [h.role, h.before]))
  );
  check(
    "/api/search scope=summary skips answer text from mid tool loop",
    (await search("exports nothing useful", "&scope=summary")).hits.length === 0
  );
  check(
    "/api/search scope=summary skips an aborted run",
    (await search("SEARCHABORTEDANSWER", "&scope=summary")).hits.length === 0
  );
  check(
    "/api/search scope=summary finds the summary in every workspace",
    new Set([...summaryHits.hits, ...(await search("SEARCHRESPONSEONLY", "&scope=summary")).hits].map((h) => h.cwd)).size === 2,
    JSON.stringify((await search("SEARCHRESPONSEONLY", "&scope=summary")).hits.map((h) => h.cwd))
  );
  for (const [label, q] of [["prompts", "unrelated request"], ["tool-call arguments", "SEARCHTOOLARG"], ["tool results", "SEARCHTOOLOUT"], ["subagent child output", "SEARCHCHILDOUT"]]) {
    check(`/api/search scope=summary skips ${label}`, (await search(q, "&scope=summary")).hits.length === 0);
  }
  check("/api/search reports scope=summary truncation state", typeof summaryHits.truncated === "boolean");

  // A skill invocation is pi's expansion of a slash command: the whole SKILL.md
  // inside pi's <skill> block, then the prompt. The body is instruction text the
  // agent reads, not something the user wrote, so it must not join the prompt
  // index — one definition would otherwise match every query, in every session
  // that ever used that skill, and outrank the prompts that asked for anything.
  const skillPrompt = await search("SKILLPROMPTTERM", "&scope=prompts");
  check("/api/search scope=prompts finds the prompt after a skill block", skillPrompt.hits.length === 1);
  check(
    "/api/search skips a skill body in the prompt index",
    (await search("SKILLBODYONLY", "&scope=prompts")).hits.length === 0
  );
  check(
    "/api/search names the skill in a prompt snippet instead of the raw tag",
    !skillPrompt.hits[0]?.before.includes("<skill name=") && skillPrompt.hits[0]?.before.includes("review-helper"),
    JSON.stringify(skillPrompt.hits[0]?.before)
  );
  check(
    "/api/sessions titles a skill session by the skill and the prompt",
    (() => {
      const title = sessions.sessions.find((s) => s.cwd === "/tmp/ws-gamma")?.title || "";
      return title.includes("review-helper") && title.includes("SKILLPROMPTTERM") && !title.includes("SKILLBODYONLY");
    })(),
    JSON.stringify(sessions.sessions.find((s) => s.cwd === "/tmp/ws-gamma")?.title)
  );
  const unknownScope = await search("flibbertigibbet", "&scope=bogus");
  check("/api/search treats an unknown scope as the full corpus", unknownScope.hits.length === both.hits.length);

  // A document the composer attached is quoted into the prompt, so its text is
  // in the session file. It must not become a prompt: the title and the prompt
  // scope name the file, the body stays out.
  const docPrompt = await search("DOCPROMPTTERM", "&scope=prompts");
  check("/api/search finds the prompt that carried an attachment", docPrompt.hits.length === 1);
  check(
    "/api/search skips an attached document's body",
    (await search("ATTACHEDBODYONLY")).hits.length === 0
  );
  check(
    "/api/search names the attached file in the prompt snippet",
    !`${docPrompt.hits[0]?.before}${docPrompt.hits[0]?.after}`.includes("<attached-file") &&
      `${docPrompt.hits[0]?.before}${docPrompt.hits[0]?.after}`.includes("quarterly"),
    JSON.stringify([docPrompt.hits[0]?.before, docPrompt.hits[0]?.after])
  );
  check(
    "/api/sessions titles an attachment session by the prompt and the file name",
    (() => {
      const title = sessions.sessions.find((s) => s.cwd === "/tmp/ws-delta")?.title || "";
      return title.includes("DOCPROMPTTERM") && title.includes("quarterly & report.pdf") && !title.includes("ATTACHEDBODYONLY");
    })(),
    JSON.stringify(sessions.sessions.find((s) => s.cwd === "/tmp/ws-delta")?.title)
  );

  const searchCrossOrigin = await fetch(`${BASE}/api/search?q=flibbertigibbet`, {
    headers: { Origin: "https://evil.example.com" },
  });
  check("cross-origin search is rejected", searchCrossOrigin.status === 403, `got ${searchCrossOrigin.status}`);

  const browse = await (await fetch(`${BASE}/api/browse?path=${encodeURIComponent(ROOT)}`)).json();
  check("/api/browse lists directories", Array.isArray(browse.dirs) && browse.dirs.includes("public"));

  // Guards: a foreign Host (DNS rebinding) and a foreign Origin (CSRF) must fail.
  // `fetch` refuses to override Host, so the Host case needs a raw request.
  const badHostStatus = await rawRequestStatus("/", { Host: "evil.example.com" });
  check("foreign Host is rejected", badHostStatus === 403, `got ${badHostStatus}`);

  const badOrigin = await fetch(`${BASE}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ client: "smoke" }),
  });
  check("cross-origin POST is rejected", badOrigin.status === 403, `got ${badOrigin.status}`);

  // Traversal: encoded and literal attempts must not serve files outside public/.
  for (const attempt of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/server.js", "/../server.js"]) {
    const res = await fetch(`${BASE}${attempt}`, { redirect: "manual" });
    const body = res.status === 200 ? await res.text() : "";
    check(
      `traversal ${attempt} is not served`,
      res.status !== 200 || !body.includes('"name": "pi-ui"'),
      `got ${res.status}`
    );
  }

  // A malformed command must be a clean 4xx, never a stack trace or a crash.
  const badCmd = await fetch(`${BASE}/api/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "smoke" }),
  });
  check("command without a type is rejected", badCmd.status === 400, `got ${badCmd.status}`);
  check("no stack trace leaks in the error body", !(await badCmd.text()).includes("at Object."));

  // /api/image must serve images only: a traversal-ish path, a relative path,
  // a non-image file and a missing file are all refused.
  const img = (q) => fetch(`${BASE}/api/image?${q}`);
  check("/api/image rejects a relative path", (await img("path=package.json")).status === 400);
  check("/api/image rejects an empty path", (await img("path=")).status === 400);
  check("/api/image-block rejects an empty id", (await fetch(`${BASE}/api/image-block?id=`)).status === 404);
  check("/api/image-block 404s an unknown id", (await fetch(`${BASE}/api/image-block?id=img-does-not-exist`)).status === 404);

  // A prompt image read back from a session file must be recoverable: the
  // transcript carries only the placeholder, so this route is the only way its
  // bytes reach the browser. An offloaded entry is what the session file holds.
  {
    const { ImageStash, offloadEntries } = await import(path.join(ROOT, "sdk", "images.js"));
    const stash = new ImageStash();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    const [offloaded] = offloadEntries(
      [{ type: "message", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: png }] } }],
      stash
    );
    const image = offloaded.message.content.find((b) => b.type === "image");
    check("an offloaded prompt image keeps an id and no inline bytes", Boolean(image.imageId) && image.data === "", JSON.stringify(image).slice(0, 120));
    check("the stash holds the bytes for that id", stash.get(image.imageId) === png);
  }

  const notImage = await img(`path=${encodeURIComponent(path.join(ROOT, "server.js"))}`);
  check("/api/image refuses a non-image file", notImage.status === 415, `got ${notImage.status}`);
  const realPng = path.join(ROOT, "public", "favicon.svg");
  check("/api/image refuses SVG (no script-bearing types)", (await img(`path=${encodeURIComponent(realPng)}`)).status === 415);

  // /api/extract turns a dropped document into prompt text. pi's RPC prompt only
  // takes text and images, so a PDF, .docx or HTML page has to be readable here
  // or it cannot be attached at all. The three fixtures are written by hand: a
  // PDF small enough to read in the test, an uncompressed .docx, and a page.
  const extract = async (name, data) =>
    fetch(`${BASE}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data: Buffer.from(data).toString("base64") }),
    });
  const textOf = async (res) => {
    const body = await res.json().catch(() => ({}));
    return body.text || "";
  };
  const pdfRes = await extract("report.pdf", minimalPdf("EXTRACTEDPDFTERM"));
  const pdfBody = await pdfRes.json().catch(() => ({}));
  check("/api/extract reads a PDF's text layer", pdfRes.ok && pdfBody.text?.includes("EXTRACTEDPDFTERM"), JSON.stringify(pdfBody).slice(0, 200));
  check("/api/extract reports a PDF's page count", pdfBody.pages === 1, `pages=${pdfBody.pages}`);
  const docxRes = await extract("notes.docx", minimalDocx("EXTRACTEDDOCXTERM &amp; 报告"));
  const docxText = await textOf(docxRes);
  check("/api/extract reads a .docx", docxRes.ok && docxText.includes("EXTRACTEDDOCXTERM"), docxText.slice(0, 120));
  check("/api/extract decodes a .docx XML entity", docxText.includes("EXTRACTEDDOCXTERM & 报告"), docxText.slice(0, 120));
  const htmlRes = await extract("page.html", "<html><body><h1>EXTRACTEDHTMLTERM</h1><p>one</p><ul><li>two</li></ul><script>BADSCRIPT</script></body></html>");
  const htmlOut = await textOf(htmlRes);
  check("/api/extract reads an .html file", htmlRes.ok && htmlOut.includes("EXTRACTEDHTMLTERM"), htmlOut.slice(0, 120));
  check("/api/extract keeps list items as bullets", htmlOut.includes("- two"), JSON.stringify(htmlOut));
  check("/api/extract drops script bodies", !htmlOut.includes("BADSCRIPT"), JSON.stringify(htmlOut));
  const txtRes = await extract("notes.md", "# EXTRACTEDMDTERM\n\nbody line");
  check("/api/extract passes a text file through", txtRes.ok && (await textOf(txtRes)).includes("EXTRACTEDMDTERM"));
  check("/api/extract refuses an unsupported type", (await extract("archive.zip", "PK\u0003\u0004nothing")).status === 415);
  check("/api/extract explains a legacy .doc", (await (await extract("old.doc", "text")).json()).error?.includes(".docx"), "");
  check("/api/extract refuses an empty body", (await fetch(`${BASE}/api/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status === 400);
  // A file merely named .pdf must fail loudly: sending the model a binary blob
  // as if it were a document is worse than refusing the attachment.
  const fakePdf = await extract("fake.pdf", "this is not a pdf at all");
  check("/api/extract refuses a .pdf with no text layer", fakePdf.status === 415, `got ${fakePdf.status}`);
  // A container that lies about its contents must be refused, not walked: a
  // .docx whose document.xml is not deflate data and a zip whose directory
  // points past the end of the file both have to fail as a 415 with a reason.
  const corruptDocx = await extract("broken.docx", minimalDocx("x", { corrupt: true }));
  check("/api/extract refuses a corrupt .docx", corruptDocx.status === 415, `got ${corruptDocx.status}`);
  const lyingZip = minimalDocx("x");
  lyingZip.writeUInt32LE(0xffffff00, lyingZip.length - 6); // directory offset past EOF
  check("/api/extract refuses a .docx with a bad zip directory", (await extract("lying.docx", lyingZip)).status === 415);
  const extractCrossOrigin = await fetch(`${BASE}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ name: "a.txt", data: "aGk=" }),
  });
  check("cross-origin extract is rejected", extractCrossOrigin.status === 403, `got ${extractCrossOrigin.status}`);


  // Only run the agent-backed check when pi is actually installed: /api/open
  // succeeds either way, so ask the agent for its state and treat a 503 as
  // "no agent here" rather than a pass.
  const openRes = await fetch(`${BASE}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "smoke" }),
  });
  check("/api/open attaches a client", openRes.ok, `got ${openRes.status}`);

  const stateRes = await fetch(`${BASE}/api/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "smoke", type: "get_state" }),
  });
  if (stateRes.status === 503) {
    console.log("  skip  agent round-trip (pi not available)");
  } else {
    const body = await stateRes.json().catch(() => ({}));
    check("agent answers get_state", stateRes.ok && body?.success !== false, JSON.stringify(body).slice(0, 200));
  }

  check("server still alive after the request matrix", (await fetch(`${BASE}/api/health`)).ok);

  // A new session must land in pi's per-cwd directory
  // (`<sessionDir>/--<encoded-cwd>--/`), not directly under the session root.
  // Writing it at the root makes the file unfindable by cwd and hands the
  // browser a path that a later open cannot resolve.
  {
    const openRes = await fetch(`${BASE}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "cwdcheck", cwd: FIXTURE_DIR }),
    });
    const opened = await openRes.json();
    await fetch(`${BASE}/api/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "cwdcheck", type: "set_session_name", name: "layout-probe" }),
    });
    const stateRes = await fetch(`${BASE}/api/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "cwdcheck", type: "get_state" }),
    });
    const state = await stateRes.json();
    const file = state?.data?.sessionFile || "";
    const expectedDir = `${FIXTURE_DIR}/--${path.resolve(FIXTURE_DIR).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    check("a new session opens in the requested cwd", opened?.cwd === path.resolve(FIXTURE_DIR), JSON.stringify(opened).slice(0, 160));
    check(
      "a new session is written under the per-cwd session directory",
      file.startsWith(expectedDir + path.sep),
      `expected under ${expectedDir}, got ${file || "(none)"}`
    );
    // The reported path itself must not be a direct child of the root: that is
    // the exact shape of the bug, and it holds whatever directory is in use.
    check(
      "the session path is not a direct child of the session root",
      path.dirname(file) !== FIXTURE_DIR,
      `reported ${file || "(none)"}, which sits directly under ${FIXTURE_DIR}`
    );
    check(
      "no session file is written at the session root",
      !fs.readdirSync(FIXTURE_DIR, { withFileTypes: true }).some((e) => e.isFile() && e.name.endsWith(".jsonl")),
      "a .jsonl file appeared directly under the session root"
    );
  }

  // pi persists a new session lazily: `sessionFile` is reported before anything
  // is written. A reload (or a second tab) naming that path must attach to the
  // live session, not be rejected for a file that does not exist yet.
  {
    await fetch(`${BASE}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "lazy", cwd: FIXTURE_DIR }),
    });
    const stateRes = await fetch(`${BASE}/api/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "lazy", type: "get_state" }),
    });
    const state = await stateRes.json();
    const lazyFile = state?.data?.sessionFile || "";
    check("a new session reports a path before writing it", Boolean(lazyFile) && !fs.existsSync(lazyFile), `file ${lazyFile} (exists: ${fs.existsSync(lazyFile)})`);

    const reopen = await fetch(`${BASE}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "lazy2", sessionFile: lazyFile }),
    });
    const reopened = await reopen.json().catch(() => ({}));
    check("a reload attaches to a session whose file is not written yet", reopen.status === 200, `status ${reopen.status} ${JSON.stringify(reopened).slice(0, 160)}`);
    check("the reload reuses the live session, not a duplicate", reopened?.sessionId === state?.data?.sessionId, `${reopened?.sessionId} vs ${state?.data?.sessionId}`);
  }

  // A session path that no longer exists must be refused, not silently turned
  // into a new conversation that overwrites it.
  {
    const gone = path.join(FIXTURE_DIR, "--tmp-ws-alpha--", "2099-01-01T00-00-00-000Z_gone.jsonl");
    const res = await fetch(`${BASE}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "missing", sessionFile: gone }),
    });
    const body = await res.json().catch(() => ({}));
    // pi opens an empty session for a path that does not exist yet, because a new
    // session is persisted lazily. Matching that keeps a reloaded bookmark on the
    // same (still empty) conversation instead of a dead link.
    check("a session path with no file opens an empty session", res.status === 200 && body?.ok === true, `status ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    check("a missing session file is left to be written by pi", !fs.existsSync(gone));
    // The path in the URL must stay the session's own path, or the next reload
    // lands on a different (also empty) conversation and the bookmark never sticks.
    check(
      "a session opened from a path keeps that path",
      body?.sessionFile === gone,
      `reported ${body?.sessionFile}, expected ${gone}`
    );
    // And the pieces that make a reload work: the same path opened twice is the
    // same session, not a second empty one.
    const again = await (
      await fetch(`${BASE}/api/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "missing2", sessionFile: gone }),
      })
    ).json();
    check("opening the same path twice reuses the session", again?.sessionId === body?.sessionId, `${again?.sessionId} vs ${body?.sessionId}`);
  }

  // Static assets must revalidate: a conditional request for an unchanged file
  // has to be a bodyless 304, otherwise every reload re-downloads app.js.
  const asset = await fetch(`${BASE}/app.js`);
  const etag = asset.headers.get("etag");
  await asset.text();
  check("static assets carry an ETag", !!etag, `etag=${etag}`);
  const revalidated = await fetch(`${BASE}/app.js`, { headers: { "If-None-Match": etag } });
  check("unchanged asset revalidates as 304", revalidated.status === 304, `got ${revalidated.status}`);
  const stale = await fetch(`${BASE}/app.js`, { headers: { "If-None-Match": '"0-0"' } });
  check("stale ETag still returns the file", stale.status === 200 && (await stale.text()).length > 0, `got ${stale.status}`);

  // A closed event stream must not leak its client entry: every page load used
  // to leave one behind, and every broadcast walked all of them. Each stream
  // here reads its first chunk, because a request aborted before the response
  // headers never registers a client at all. The grace period keeps a
  // reconnecting EventSource attached, so this asserts the map stays bounded
  // rather than that it drops to zero immediately.
  const openThenClose = async (id) => {
    const ctl = new AbortController();
    const res = await fetch(`${BASE}/api/events?client=${id}`, { signal: ctl.signal });
    await res.body.getReader().read();
    ctl.abort();
  };
  for (let i = 0; i < 260; i++) await openThenClose(`churn-${i}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const healthAfter = await (await fetch(`${BASE}/api/health`)).json();
  check(
    "closed event streams do not accumulate past the cap",
    healthAfter.clients <= 200,
    `clients=${healthAfter.clients} after 260 closed streams`
  );

  // Queue snapshot on re-attach: pi emits queue_update only when the queue
  // changes, so a tab that switches away and back must be told what its session
  // still holds — otherwise the dock looks empty while messages are pending.
  await queueSnapshotChecks();
  await backgroundProcessChecks();
  // Extension dialogs resolve through the in-process UI context, which the RPC
  // bridge used to provide by writing to stdout. No server or credentials needed.
  await extensionUiChecks();
  // Two sessions in one workspace must not share an extension runtime: disposing
  // one used to poison the other's ctx, and every session opened after that
  // reported the stale-ctx error on session_start.
  await workspaceIsolationChecks();
} finally {
  stopServer();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(FOLLOWUP_DIR, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  if (serverLog.trim()) console.error(`\nserver log:\n${serverLog.trim()}`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
// Exit explicitly rather than waiting for the event loop to drain. Extensions
// loaded by the workspace-isolation check can leave auxiliary child processes
// running (pi-lens spawns opengrep and madge, which keep a handle open), so
// without this the process prints "all smoke checks passed" and then sits there
// forever — `npm test` looks hung and has to be killed by hand even though every
// check passed. Nothing here needs a graceful shutdown: the servers it started
// are already stopped in the `finally` above.
process.exit(0);
