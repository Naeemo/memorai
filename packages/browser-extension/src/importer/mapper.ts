import type { Event } from "memorai";
import type { ChatGPTConversation, ChatGPTConversationMeta } from "./types.js";

const MAX_TEXT_LENGTH = 8000;

/**
 * Convert a ChatGPT conversation into Memorai events.
 * Skips system messages and empty text nodes.
 */
export function mapConversationToEvents(
  conv: ChatGPTConversation,
  meta: ChatGPTConversationMeta,
  opts: { since?: number } = {},
): Event[] {
  const events: Event[] = [];

  for (const node of Object.values(conv.mapping)) {
    if (!node.message) continue;
    const msg = node.message;
    if (msg.author.role === "system") continue;

    const at = msg.create_time * 1000;
    if (opts.since !== undefined && at < opts.since) continue;

    const text = msg.content.parts[0] ?? "";
    if (!text.trim()) continue;

    events.push({
      at,
      actor: msg.author.role,
      content: { kind: "observation", text: text.slice(0, MAX_TEXT_LENGTH) },
      tags: ["chatgpt", meta.title],
      id: `chatgpt-msg:${msg.id}`,
      context: `conversation:${meta.id}`,
      salienceHint: 0.7,
    });
  }

  return events;
}
