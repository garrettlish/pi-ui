/**
 * Image offload.
 *
 * A session's tool results can hold base64 screenshots, and those are what make
 * a transcript huge: one real 30 MB session was 28.7 MB of PNG data across 36
 * blocks and 1.7 MB of everything else. The browser never shows a historical
 * image until it is opened, so shipping the bytes with the transcript is almost
 * all waste — it inflates the JSON the server has to build, the bytes it has to
 * frame, and the browser's parse.
 *
 * So an entry sent to a client keeps a placeholder, and the bytes stay here,
 * addressed by `imageId` and fetched by `GET /api/image-block` on demand.
 *
 * Placeholders are immutable for a given id (an entry's content never changes),
 * which is why the cache can be a plain size-bounded map with no invalidation
 * beyond its budget.
 */

/** Placeholder assigned to a block whose media type the browser can render. */
const RENDERABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class ImageStash {
  constructor({ maxChars = 200_000_000 } = {}) {
    this.maxChars = maxChars;
    this.entries = new Map(); // imageId -> base64 data
    this.total = 0;
    this.seq = 0;
  }

  put(data) {
    const id = `img-${++this.seq}`;
    this.entries.set(id, data);
    this.total += data.length;
    this.evict();
    return id;
  }

  get(id) {
    return this.entries.get(id);
  }

  /** Oldest first, and only enough to get back under budget: an image a user
   *  just opened stays resident instead of being dropped by a full flush. */
  evict() {
    while (this.total > this.maxChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const id = oldest.value;
      this.total -= this.entries.get(id).length;
      this.entries.delete(id);
    }
  }
}

/**
 * Replace image payloads in one session entry with placeholders.
 *
 * Returns the entry unchanged when it carries no renderable image, so the
 * common path allocates nothing. Anything already stashed (a placeholder that
 * came back through the tree) is passed through untouched.
 */
export function offloadImages(entry, stash) {
  const message = entry?.message;
  const content = message?.content;
  if (!Array.isArray(content)) return entry;
  if (!content.some((b) => b && b.type === "image" && b.data)) return entry;
  const nextContent = content.map((b) => {
    if (!b || b.type !== "image" || !b.data) return b;
    if (!RENDERABLE.has(b.mimeType)) {
      // A media type the browser cannot draw is only ever metadata; dropping
      // the bytes loses nothing visible and keeps the transcript honest.
      return { ...b, data: "", imageOmitted: "unsupported" };
    }
    return { ...b, data: "", imageId: stash.put(b.data) };
  });
  return { ...entry, message: { ...message, content: nextContent } };
}

/** Offload a whole entry list in place-free fashion. */
export function offloadEntries(entries, stash) {
  return entries.map((e) => offloadImages(e, stash));
}
