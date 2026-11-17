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
 * Two things survive, and both only ever *shorten* a wait they can prove wrong:
 *
 *  - `alive`  a Cursor socket's `bytesRead` advanced within `RECENT_BYTES_MS`.
 *             Bytes arrived, so the transport is carrying frames; the silence
 *             belongs to the provider, not the network.
 *  - `unreachable`  a plain reachability probe to the host the run actually
 *             talks to got no answer. Nothing can be streaming over a route
 *             that cannot carry a packet. This is the only case that aborts on
 *             evidence, and it is the one no socket event can report: dropping
 *             the network sends no FIN, and this machine's TCP keepalive is two
 *             hours (`net.inet.tcp.keepidle: 7200000`).
 *
 * Everything else is `unknown`, which every caller must treat as "behave exactly
 * as before". That is what keeps a Node without the diagnostics channel, or a
 * provider whose transport is not observable here, on the old path.
 *
 * Nothing here opens a connection on its own, patches `fetch`, or reads a
 * payload: it observes sockets the SDK opened, and asks the network one question.
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

/** socket -> record, kept only while the socket is open. */
const records = new Map();
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

/** Subscribe once. Idempotent, and safe on a Node that does not publish the
 *  channel: `subscribe` on an unused channel name simply never fires. */
export function watchWire() {
  if (subscribed) return;
  subscribed = true;
  diagnosticsChannel.subscribe("net.client.socket", ({ socket }) => {
    if (socket) track(socket);
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
 * @param {Array<{cursor?: boolean, probe?: boolean, openedAt?: number, lastBytesAt?: number}>} list
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
};
