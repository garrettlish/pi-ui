/**
 * Extension UI context.
 *
 * Extensions ask the host to show things: `ui.select`, `ui.confirm`, `ui.input`,
 * `ui.editor`, plus fire-and-forget calls such as `ui.notify` and `ui.setStatus`.
 * Under `pi --mode rpc` those become `extension_ui_request` records on stdout and
 * the answer comes back on stdin. In-process there is no stdout, so this module
 * plays the same role: it emits the identical records to the browser and
 * resolves each dialog when the answer arrives at `/api/ui-response`.
 *
 * The TUI-only members (`setFooter`, `setWidget` component factories, theme
 * switching, raw terminal input) have no meaning in a browser panel. They are
 * implemented as no-ops rather than omitted, because an extension that calls one
 * must not crash on `undefined is not a function`.
 */
import { randomUUID } from "node:crypto";

/** A theme whose every style call returns its text unchanged.
 *
 *  Extensions colour TUI strings; a browser panel styles itself, so the escape
 *  codes a real theme would add are actively unwanted. Returning the input keeps
 *  `theme.fg("accent", s)` style calls from throwing while staying plain. */
function plainTheme() {
  const passthrough = (_color, text) => (text === undefined ? "" : String(text));
  const theme = {
    fg: passthrough,
    bg: passthrough,
    bold: passthrough,
    dim: passthrough,
    italic: passthrough,
    underline: passthrough,
    inverse: passthrough,
    strikethrough: passthrough,
    reset: (_text) => "",
    get name() {
      return "plain";
    },
  };
  return theme;
}

export class ExtensionUi {
  /** @param {(record: object) => void} emit send one record to attached clients */
  constructor(emit) {
    this.emit = emit;
    this.pending = new Map(); // id -> { resolve, timer }
    this.theme = plainTheme();
  }

  /** Resolve a dialog that was answered in the browser. Unknown ids are
   *  ignored: a client may answer twice, or after a timeout already fired. */
  answer(id, payload) {
    const p = this.pending.get(id);
    if (!p) return false;
    // resolve() removes the entry itself once it has settled the caller.
    try {
      p.resolve(payload || {});
    } catch {
      // a rejecting consumer must not break the response path
    }
    return true;
  }

  /** Drop dialogs nobody will answer (session closing, browser gone). */
  cancelAll() {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      try {
        p.resolve({ cancelled: true });
      } catch {
        // ignore
      }
    }
    this.pending.clear();
  }

  /** Emit a request and wait for its answer, mirroring RPC's dialog promise:
   *  a timeout or an abort resolves the default rather than rejecting. */
  #request(request, defaultValue, opts) {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = randomUUID();
    return new Promise((resolve) => {
      // `settled` guards double-resolution. It must not go through `pending`:
      // answer() removes the entry before resolving, so a check on the map
      // would see its own removal and swallow the value.
      let settled = false;
      let timer = null;
      const onAbort = () => finish(defaultValue);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener?.("abort", onAbort);
        resolve(value);
      };
      timer = opts?.timeout ? setTimeout(() => finish(defaultValue), opts.timeout) : null;
      opts?.signal?.addEventListener?.("abort", onAbort, { once: true });
      // The map holds the raw-answer resolver; its answer is parsed into the
      // API's return type before it resolves the caller.
      this.pending.set(id, {
        timer,
        resolve: (payload) => finish(request.parse(payload || {})),
      });
      this.emit({ type: "extension_ui_request", id, ...request.record });
    });
  }

  /** The value the RPC bridge passes to extensions. */
  context() {
    // Captured so the object literal's `theme` getter does not recurse into
    // itself: inside that literal `this` is the context, not this class.
    const plainThemeInstance = this.theme;
    return {
      select: (title, options, opts) =>
        this.#request(
          {
            record: { method: "select", title, options, timeout: opts?.timeout },
            parse: (r) => ("value" in r ? r.value : undefined),
          },
          undefined,
          opts
        ),
      confirm: (title, message, opts) =>
        this.#request(
          {
            record: { method: "confirm", title, message, timeout: opts?.timeout },
            parse: (r) => ("confirmed" in r ? r.confirmed : false),
          },
          false,
          opts
        ),
      input: (title, placeholder, opts) =>
        this.#request(
          {
            record: { method: "input", title, placeholder, timeout: opts?.timeout },
            parse: (r) => ("value" in r ? r.value : undefined),
          },
          undefined,
          opts
        ),
      editor: (title, prefill) =>
        this.#request(
          {
            record: { method: "editor", title, prefill },
            parse: (r) => (r.cancelled ? undefined : r.value),
          },
          undefined
        ),

      // Fire-and-forget: the browser renders `notify` as a toast and ignores
      // the rest, exactly as it ignores the same records from RPC mode.
      notify: (message, type) =>
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type }),
      setStatus: (key, text) =>
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text }),
      setTitle: (title) =>
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title }),
      setEditorText: (text) =>
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }),
      pasteToEditor: (text) =>
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }),

      // String widgets are the only shape RPC mode supports, so the browser
      // sees the same subset it always did.
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey: key,
            widgetLines: content,
            widgetPlacement: options?.placement,
          });
        }
      },

      // No TUI, so nothing to configure.
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      setToolsExpanded: () => {},
      getToolsExpanded: () => false,
      getEditorText: () => "",
      async custom() {
        return undefined;
      },

      get theme() {
        return plainThemeInstance;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "theme switching is not available in pi-ui" }),
    };
  }
}
