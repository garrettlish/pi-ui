/**
 * Event shaping.
 *
 * The browser consumes the same event objects `pi --mode rpc` writes to stdout.
 * `session.subscribe()` hands us `AgentSessionEvent` values instead, which carry
 * one field the JSON form does not: the in-flight `partial` message on every
 * `message_update`. Dropping it is the only difference between the two shapes,
 * and it is what the RPC sender does, so replicating it here keeps the frontend
 * unchanged.
 */

/** Strip `partial` from one assistant streaming sub-event. */
function jsonAssistantEvent(event) {
  if (event.type === "toolcall_start") {
    const call = event.partial.content[event.contentIndex];
    if (call?.type === "toolCall") {
      const { partial: _partial, ...delta } = event;
      return { ...delta, id: call.id, toolName: call.name };
    }
    return event;
  }
  if (!("partial" in event)) return event;
  const { partial: _partial, ...delta } = event;
  return delta;
}

/** Convert one session event into the shape the RPC mode streams. */
export function toJsonEvent(event) {
  if (event.type !== "message_update") return event;
  if (event.message.role !== "assistant") return event;
  return {
    type: "message_update",
    usage: event.message.usage,
    assistantMessageEvent: jsonAssistantEvent(event.assistantMessageEvent),
  };
}
