/**
 * What the network layer can still say about a silent run.
 *
 * ## Why this exists
 *
 * A Cursor run can legitimately emit nothing for minutes, and the Cursor SDK
 * throws the transport's own heartbeat frames away (`case "heartbeat": break`
 * in its stream handler). From the event stream, "the model is thinking" and
 * "the connection died a while ago" are the *same* observation, so the host had
 * one defence: a wall-clock guess (5 minutes). Measured over this machine's 791
 * Cursor turns, that guess is wrong in both directions — a first token takes
 * 26 s at the median but 320 s at p99, and nine turns waited past 300 s and
 * then answered.
 *
 * ## What is *not* evidence (measured, 2026-11-17)
 *
 * A closed socket looks identical whether the connection broke or Node simply
 * retired an idle one, so it cannot be used to declare a run dead:
 *
 * | situation                                   | what the socket reports              |
 * |---------------------------------------------|--------------------------------------|
 * | undici finishes a request, then recycles it | `error UND_ERR_INFO "reset"` ~3 s later |
 * | real h1 drop mid-body                       | `ECONNRESET`                          |
 * | real h2 drop mid-stream                     | clean `end` + `close hadError=false`  |
 *
 * The harmless case is the one that produces an *error*, and the harmful h2 case
 * produces none. `dead`-from-socket was therefore removed: it would have aborted
 * healthy runs every time a pooled connection was reaped.
 *
 * ## What is evidence
 *
 * Four things survive. None of them can start or extend a run's life; each only
 * *shortens* a wait it can prove is wasted, or *softens* wording it can prove is
 * unfair:
 *
 *  - `alive`  a Cursor socket's `bytesRead` advanced, or a provider request's
 *             response body delivered a chunk, within `RECENT_BYTES_MS`. Bytes
 *             arrived, so the transport is carrying frames; the silence belongs
 *             to the provider, not the network. The request-level half is
 *             provider-agnostic and is what lets a non-Cursor run be described
 *             honestly instead of only being waited out.
 *  - `broken`  a *long-lived* request to a non-local origin failed with a
 *             transport code after this run's last event, and nothing has been
 *             received on that origin since. Two facts make this sound rather
 *             than a guess: the request was open longer than any short call
 *             (`LONG_REQUEST_MS`), so it is the streaming one and not a model
 *             listing or a health check; and pi reacts to its own provider
 *             failures by emitting an event (`auto_retry_start`, `agent_end`,
 *             `agent_settled`), so an error with no event *after* it means the
 *             run is wedged — the exact state that made a stall unkillable.
 *             Measured 2026-11-18: a mid-body `socket.destroy()` yields
 *             `UND_ERR_SOCKET` at the drop, and a peer that stops sending
 *             without any FIN yields `UND_ERR_BODY_TIMEOUT` when the
 *             dispatcher's own `bodyTimeout` expires (300 s by default).
 *  - `unreachable`  a plain reachability probe to the host the run actually
 *             talks to got no answer. Nothing can be streaming over a route
 *             that cannot carry a packet. This is the case no socket event can
 *             report: dropping the network sends no FIN, and this machine's TCP
 *             keepalive is two hours (`net.inet.tcp.keepidle: 7200000`).
 *
 * Everything else is `unknown`, which every caller must treat as "behave exactly
 * as before". That is what keeps a Node without the diagnostics channel, or a
 * provider whose transport is not observable here, on the old path.
 *
 * The request level is deliberately *not* used the way the socket level is not:
 * an `UND_ERR_ABORTED` (a user's Stop) is never evidence, and a failure of a
 * *short* request is never attributed to a run. Only a long-lived request's
 * transport failure, on a host that is not local, in the window after the run's
 * own last event, counts.
 *
 * Nothing here opens a connection on its own, patches `fetch`, or reads a
 * payload: it observes sockets and requests the SDK opened, and asks the network
 * one question.
 */
import diagnosticsChannel from "node:diagnostics_channel";

/** Hosts whose sockets belong to the Cursor backend. `cursor.com` covers
 *  `api.cursor.com`; `cursor.sh` covers `api2.cursor.sh`, the run transport.
 *  Matching is on the suffix so a regional or proxy hostname still counts. */
const CURSOR_HOST_SUFFIXES = ["cursor.sh", "cursor.com"];

/** How often open sockets are sampled. `bytesRead` is cumulative, so a sample
 *  only has to bound *when* bytes last arrived, not catch every frame. */
const SAMPLE_MS = 5_000;
/** A socket counts as carrying traffic if its counter advanced this recently.
 *  Generous on purpose: it only ever *prevents* an abort and softens a warning,
 *  so a false "alive" costs wording, while a false "silent" would cost a turn. */
const RECENT_BYTES_MS = 30_000;

/** How long a request must have been open before its transport failure can be
 *  read as *this run's* streaming request.
 *
 *  This is the identity argument, and it is what makes a process-wide record
 *  usable for an abort rather than only for wording. Every other HTTP call this
 *  process makes — a model-catalog refresh, an MCP handshake, an extension's
 *  fetch — finishes in milliseconds to seconds. A failure on a request that was
 *  still open after a minute is a provider stream that was waiting for its
 *  answer, and the wire is only consulted after `WIRE_CHECK_AFTER_MS` (90 s) of
 *  a run's own silence, so the failing request has already outlived that.
 *
 *  Not lower: a long-polling MCP endpoint or an extension's slow fetch could sit
 *  open for tens of seconds, and blaming the run for one of those is the one
 *  mistake this layer must not make. */
const LONG_REQUEST_MS = 60_000;

/** Transport failure codes that mean the connection died under the request.
 *
 *  An allow-list, not a pattern match, because the inverse mistake is the one
 *  that costs a turn: `UND_ERR_ABORTED` (and the DOMException `code: 20` that
 *  reaches the channel when the user presses Stop) means *we* cancelled the
 *  request, and must never be read as a broken connection. Codes are what npm
 *  undici and Node's bundled undici both put on the error, so both transports
 *  are covered by the same set. */
const TRANSPORT_FAILURE_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** How many request records are kept. A bound rather than a timeout: the table
 *  only has to cover the longest silence a caller asks about, and a leaked entry
 *  would otherwise live for the life of the process. */
const REQUESTS_MAX = 128;
/** How long a finished request stays readable. Long enough to describe a silence
 *  a caller is still asking about, short enough that a busy process does not
 *  accumulate them. */
const REQUEST_TTL_MS = 10 * 60_000;

/** socket -> record, kept only while the socket is open. */
const records = new Map();
/** request -> record, for the request level. Keyed by the transport's own request
 *  object so a chunk and its request are joined without any id of our own. */
const requests = new Map();
let sampler = null;
let subscribed = false;
/** Set while a reachability probe is opening its connection, so `track()` can
 *  mark that socket as the probe's own. Declared before `track` because a socket
 *  event can fire on the first tick. */
let probeWindow = null;
/** The Cursor host that most recently carried this process's traffic.
 *
 *  Needed because the probe must ask the host the *run* actually talks to.
 *  `model.baseUrl` is not it: pi-cursor-sdk registers the provider with
 *  `baseUrl: "https://cursor.com"` (the web host) while the run transport is
 *  `api2.cursor.sh`, and the SDK honours `CURSOR_BACKEND_URL` on top of that.
 *  A probe of the wrong host would answer a question nobody asked. */
let lastCursorHost = "";

function isCursorHost(servername) {
  if (typeof servername !== "string" || !servername) return false;
  const host = servername.toLowerCase();
  return CURSOR_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Is this origin on this machine?
 *
 *  A loopback failure is a different incident (the pi-ui server's own port, an
 *  MCP server on localhost, a local model) and must never be reported as "the
 *  provider connection broke". Anything we cannot parse is treated as local, so
 *  an unexpected shape fails towards saying nothing. */
function isLocalOrigin(origin) {
  if (typeof origin !== "string" || !origin) return true;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return true;
  }
  if (!host) return true;
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "0.0.0.0" ||
    name.endsWith(".localhost") ||
    /^127\./.test(name)
  );
}

/** Advance every open record's byte counter. Cheap: one property read each. */
function sample(now = Date.now()) {
  for (const record of records.values()) {
    const read = record.socket.bytesRead;
    if (typeof read === "number" && read !== record.lastBytes) {
      record.lastBytes = read;
      record.lastBytesAt = now;
    }
  }
}

function stopSamplerIfIdle() {
  if (!sampler) return;
  if (records.size) return;
  clearInterval(sampler);
  sampler = null;
}

function ensureSampler() {
  if (sampler) return;
  // unref: watching sockets must never be the reason the process stays alive.
  sampler = setInterval(() => {
    sample();
    // Closed sockets are dropped rather than remembered: a close is not
    // evidence of anything (see the table above), and keeping them would make
    // the sampler run for the life of the process.
    dropClosed();
    stopSamplerIfIdle();
  }, SAMPLE_MS);
  sampler.unref?.();
}

function dropClosed() {
  for (const [socket, record] of records) if (record.socket.destroyed) records.delete(socket);
}

function track(socket) {
  if (records.has(socket)) return;
  // Only TLS sockets can belong to the provider transport, and only they emit
  // `secureConnect` — which is what decides `cursor` and, otherwise, deletes the
  // record. A plain-HTTP socket (any localhost call) would therefore sit in the
  // map forever and keep the sampler alive for nothing.
  if (!socket.encrypted) return;
  const record = {
    socket,
    servername: null,
    cursor: false,
    // A socket opened while a reachability probe was in flight is almost always
    // the probe's own. Counting it as evidence would let the check prove itself
    // healthy: "bytes just arrived" would then describe the probe, not the run.
    probe: Boolean(probeWindow),
    openedAt: Date.now(),
    lastBytes: 0,
    lastBytesAt: 0,
  };
  records.set(socket, record);
  socket.on("secureConnect", () => {
    record.servername = socket.servername || null;
    record.cursor = isCursorHost(record.servername);
    if (record.cursor) {
      lastCursorHost = record.servername;
      ensureSampler();
    } else {
      // Not a provider transport: nothing to watch, and holding the record
      // would keep the sampler busy for another host's traffic.
      records.delete(socket);
    }
  });
  socket.on("close", () => {
    records.delete(socket);
    stopSamplerIfIdle();
  });
}

/** Bound the request table: drop whatever finished longest ago.
 *
 *  Called on every create, so the table cannot grow past the cap even under a
 *  burst, and the sort stays over a bounded list. */
function pruneRequests(now = Date.now()) {
  if (requests.size <= REQUESTS_MAX) return;
  const finished = [];
  for (const [key, record] of requests) {
    const endedAt = record.completedAt || record.erroredAt || 0;
    if (endedAt && now - endedAt > 0) finished.push([key, endedAt]);
  }
  finished.sort((a, b) => a[1] - b[1]);
  for (const [key] of finished.slice(0, requests.size - REQUESTS_MAX)) requests.delete(key);
}

/** Record one request the transport opened. */
function trackRequest(request) {
  if (!request || typeof request !== "object" || requests.has(request)) return;
  const origin = typeof request.origin === "string" ? request.origin : "";
  requests.set(request, {
    origin,
    method: typeof request.method === "string" ? request.method : "",
    startedAt: Date.now(),
    lastChunkAt: 0,
    completedAt: 0,
    erroredAt: 0,
    code: "",
    aborted: false,
    // The reachability probe's own request must never become evidence about the
    // run: a failing probe would otherwise prove itself.
    probe: Boolean(probeWindow),
    local: isLocalOrigin(origin),
  });
  pruneRequests();
}

/** Forget requests that finished long enough ago to describe nothing. */
function pruneStaleRequests(now = Date.now()) {
  for (const [key, record] of requests) {
    const endedAt = record.completedAt || record.erroredAt || 0;
    if (endedAt && now - endedAt > REQUEST_TTL_MS) requests.delete(key);
  }
}

/** Subscribe once. Idempotent, and safe on a Node that does not publish the
 *  channels: `subscribe` on an unused channel name simply never fires, which is
 *  what keeps a Node or a transport without them on the old path. */
export function watchWire() {
  if (subscribed) return;
  subscribed = true;
  diagnosticsChannel.subscribe("net.client.socket", ({ socket }) => {
    if (socket) track(socket);
  });
  // Request level: the same evidence `net.client.socket` cannot give. A socket's
  // close proves nothing (see the table above), but a request that failed with a
  // transport code proves the connection died *under that request*, and a body
  // chunk proves frames are arriving without needing to know who the provider is.
  diagnosticsChannel.subscribe("undici:request:create", ({ request }) => trackRequest(request));
  diagnosticsChannel.subscribe("undici:request:bodyChunkReceived", ({ request }) => {
    const record = requests.get(request);
    if (record) record.lastChunkAt = Date.now();
  });
  diagnosticsChannel.subscribe("undici:request:trailers", ({ request }) => {
    const record = requests.get(request);
    // A completed response is not evidence of a fault; it is kept only so its
    // buffered chunks still count as recent life until the TTL drops it.
    if (record && !record.completedAt) record.completedAt = Date.now();
  });
  diagnosticsChannel.subscribe("undici:request:error", ({ request, error }) => {
    const record = requests.get(request);
    if (!record) return;
    record.erroredAt = Date.now();
    record.code = typeof error?.code === "string" ? error.code : "";
    // `AbortError` arrives as a DOMException whose `code` is the number 20 and
    // whose `name` is what actually identifies it; the request's own flag is the
    // third spelling. Any of them means we cancelled it, so it is not evidence.
    record.aborted = Boolean(request?.aborted) || error?.name === "AbortError";
  });
}

/**
 * Reduce the recorded sockets to one verdict.
 *
 * Pure, so the smoke test can drive it with synthetic records instead of a real
 * connection. There are deliberately only two states: `alive` is positive
 * evidence that the transport works, and everything else is `unknown`, which
 * every caller must treat as "no information".
 *
 * The records are process-wide, because the diagnostics channel does not say
 * which session opened a socket. A socket carrying another session's traffic
 * therefore reads as `alive` here, which only keeps this session's warning
 * factual-sounding and never aborts: the conservative direction.
 *
 * @param {Iterable<{cursor?: boolean, probe?: boolean, openedAt?: number, lastBytesAt?: number}>} list
 * @param {{ now?: number, recentMs?: number }} [options]
 * @returns {{ state: "alive"|"unknown", lastBytesAgoMs: number|null }}
 */
export function classifyWire(list, options = {}) {
  const now = options.now ?? Date.now();
  const recentMs = options.recentMs ?? RECENT_BYTES_MS;
  let lastBytesAgoMs = null;
  for (const record of list) {
    if (!record || record.cursor === false || record.probe) continue;
    // A socket that never produced a byte still bounds its own age; that reads
    // as "recently opened", which is when a retry is in flight.
    const at = record.lastBytesAt || record.openedAt || 0;
    const age = Math.max(0, now - at);
    if (lastBytesAgoMs == null || age < lastBytesAgoMs) lastBytesAgoMs = age;
  }
  if (lastBytesAgoMs != null && lastBytesAgoMs <= recentMs) return { state: "alive", lastBytesAgoMs };
  return { state: "unknown", lastBytesAgoMs };
}

/** The verdict for the connection a silent run is waiting on. */
export function wireVerdict(options = {}) {
  watchWire();
  const now = Date.now();
  sample(now);
  return classifyWire(records.values(), { ...options, now });
}

/**
 * Reduce the recorded requests to one verdict about the transport.
 *
 * Pure, so the smoke test can drive it with synthetic records instead of a real
 * connection. Three states, and only one of them may end a run early:
 *
 *  - `broken`   a long-lived request to a non-local origin failed with a
 *               transport code after `since`, and no bytes arrived on any
 *               request afterwards. `since` is the run's own last event, which
 *               is what keeps a *recovered* run out of this state: pi emits
 *               `auto_retry_start` before it retries, so a retry moves `since`
 *               past the failure and the failure stops describing the silence.
 *  - `alive`    a response body delivered a chunk within `recentMs`.
 *  - `unknown`  anything else, including a short request's failure and every
 *               failure that predates `since`.
 *
 * `lastChunkAgoMs` is reported in every state because a caller may want to say
 * how long the silence has been measurable on the wire, not just whether it is.
 *
 * @param {Iterable<{origin?: string, startedAt?: number, lastChunkAt?: number, erroredAt?: number, code?: string, aborted?: boolean, probe?: boolean, local?: boolean}>} list
 * @param {{ now?: number, since?: number, minOpenMs?: number, recentMs?: number }} [options]
 * @returns {{ state: "broken"|"alive"|"unknown", lastChunkAgoMs: number|null, code?: string, at?: number, origin?: string, openMs?: number }}
 */
export function classifyTransport(list, options = {}) {
  const now = options.now ?? Date.now();
  const since = options.since ?? 0;
  const minOpenMs = options.minOpenMs ?? LONG_REQUEST_MS;
  const recentMs = options.recentMs ?? RECENT_BYTES_MS;
  let failure = null;
  let lastChunkAt = 0;
  for (const record of list) {
    if (!record || record.probe || record.local) continue;
    if (record.lastChunkAt > lastChunkAt) lastChunkAt = record.lastChunkAt;
    if (!record.erroredAt || record.aborted) continue;
    if (!TRANSPORT_FAILURE_CODES.has(record.code)) continue;
    // Before the run went quiet: the SDK has already said what happened, and
    // `since` moving past it is exactly how a retry clears this.
    if (record.erroredAt <= since) continue;
    const openMs = record.erroredAt - (record.startedAt || record.erroredAt);
    if (openMs < minOpenMs) continue;
    if (!failure || record.erroredAt > failure.at) {
      failure = { code: record.code, at: record.erroredAt, origin: record.origin || "", openMs };
    }
  }
  const lastChunkAgoMs = lastChunkAt ? Math.max(0, now - lastChunkAt) : null;
  // Bytes arriving after the failure mean a later request is carrying the run:
  // the failure describes a request the run already left behind.
  if (failure && lastChunkAt > failure.at) failure = null;
  if (failure) return { state: "broken", lastChunkAgoMs, ...failure };
  if (lastChunkAt && lastChunkAgoMs != null && lastChunkAgoMs <= recentMs) {
    return { state: "alive", lastChunkAgoMs };
  }
  return { state: "unknown", lastChunkAgoMs };
}

/**
 * The live transport verdict for one run's silence.
 *
 * `since` is the run's last event. The records are process-wide because the
 * diagnostics channels carry no session id, so the identity argument lives in
 * `classifyTransport`: only a request that was open longer than any short call
 * is attributed to a run, and only failures newer than that run's own last event
 * are considered.
 *
 * @param {{ since?: number, now?: number, minOpenMs?: number }} [options]
 */
export function transportVerdict(options = {}) {
  watchWire();
  const now = options.now ?? Date.now();
  pruneStaleRequests(now);
  return classifyTransport(requests.values(), { ...options, now });
}

/**
 * Is the machine's route to `host` working right now?
 *
 * Socket events cannot answer this. Unplugging the network (or losing the VPN)
 * sends no FIN and no RST, so the kernel holds the socket open and Node reports
 * nothing — and this machine's TCP keepalive is two hours, far longer than any
 * run. The only way to see it is to ask the network, which is what this does.
 *
 * Reachability only: any HTTP response at all counts (a 404 from the root path
 * proves the packets arrived), so this never depends on an endpoint's
 * semantics. `redirect: "manual"` keeps it to one round trip. Measured on a
 * healthy link: ~1.0 s; a black-holed address aborts at the timeout; a dead DNS
 * name fails in ~335 ms.
 *
 * One probe at a time per host, and the answer is reused for `cacheMs`: several
 * sessions going quiet at once must not become several requests, and a route
 * that is still down does not need re-proving on every sweep.
 */
const probes = new Map(); // host -> { at, promise }
const PROBE_TIMEOUT_MS = 4000;
/** Longer than the host's own re-check interval on purpose: one long silence
 *  then costs a handful of requests rather than one per sweep, and the caller
 *  only reads this to decide whether the *route* is up. */
const PROBE_CACHE_MS = 45000;

/** @returns {Promise<{ reachable: boolean, error?: string }>} never rejects */
export function probeHost(host, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? PROBE_CACHE_MS;
  if (typeof host !== "string" || !host) return Promise.resolve({ reachable: false, error: "no host" });
  const cached = probes.get(host);
  const now = Date.now();
  if (cached && now - cached.at < cacheMs) return cached.promise;
  const entry = { at: now, promise: null };
  entry.promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    // Held only around the request itself, and cleared in `finally`, so a socket
    // the run opens afterwards is not mislabelled as the probe's.
    probeWindow = entry;
    try {
      await fetch(host, { method: "HEAD", signal: controller.signal, redirect: "manual" });
      return { reachable: true };
    } catch (err) {
      // An abort means the probe timed out: the packets left and nothing came
      // back, which is exactly the condition being tested for. A DNS or connect
      // failure is the same verdict reached sooner.
      return {
        reachable: false,
        error: err?.name === "AbortError" ? `no answer in ${timeoutMs / 1000}s` : err?.message || "unreachable",
      };
    } finally {
      clearTimeout(timer);
      probeWindow = null;
    }
  })();
  probes.set(host, entry);
  return entry.promise;
}

/** The hostname a reachability probe should ask, or "" when nothing has observed
 *  a Cursor connection yet. Exposed so the caller never guesses a URL from
 *  `model.baseUrl`, which for Cursor is the web host, not the run transport. */
export function wireHost() {
  return lastCursorHost;
}

/** Test hook: drop everything, so a test does not inherit a previous case. */
export function __resetWireForTests() {
  records.clear();
  requests.clear();
  probes.clear();
  lastCursorHost = "";
  if (sampler) clearInterval(sampler);
  sampler = null;
}

export const __wireConstants = {
  SAMPLE_MS,
  RECENT_BYTES_MS,
  CURSOR_HOST_SUFFIXES,
  PROBE_TIMEOUT_MS,
  PROBE_CACHE_MS,
  LONG_REQUEST_MS,
  TRANSPORT_FAILURE_CODES,
};
