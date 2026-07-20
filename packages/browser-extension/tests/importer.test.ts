import { describe, expect, test } from "vitest";
import { mapConversationToEvents } from "../src/importer/mapper.js";
import type { ChatGPTConversation } from "../src/importer/types.js";

describe("ChatGPT Importer", () => {
  const mockConv: ChatGPTConversation = {
    id: "conv-1",
    title: "Test Conversation",
    create_time: 1700000000,
    update_time: 1700000100,
    mapping: {
      msg1: {
        message: {
          id: "msg1",
          author: { role: "user" },
          content: { content_type: "text", parts: ["Hello, how do I use memorai?"] },
          create_time: 1700000000,
        },
        children: ["msg2"],
      },
      msg2: {
        message: {
          id: "msg2",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Memorai is a memory layer for AI agents."] },
          create_time: 1700000060,
        },
        children: [],
      },
      sys: {
        message: {
          id: "sys",
          author: { role: "system" },
          content: { content_type: "text", parts: ["System prompt"] },
          create_time: 1700000000,
        },
        children: [],
      },
    },
  };

  test("maps conversation to events", () => {
    const events = mapConversationToEvents(mockConv, { id: "conv-1", title: "Test Conversation" });
    expect(events.length).toBe(2); // system message excluded
    expect(events[0].id).toBe("chatgpt-msg:msg1");
    expect(events[0].actor).toBe("user");
    expect(events[1].actor).toBe("assistant");
    expect(events[0].tags).toContain("chatgpt");
    expect(events[0].tags).toContain("Test Conversation");
  });

  test("filters by since timestamp", () => {
    const events = mapConversationToEvents(
      mockConv,
      { id: "conv-1", title: "Test Conversation" },
      { since: 1700000050 * 1000 },
    );
    expect(events.length).toBe(1); // only msg2
    expect(events[0].id).toBe("chatgpt-msg:msg2");
  });

  test("truncates long messages", () => {
    const longConv: ChatGPTConversation = {
      ...mockConv,
      mapping: {
        long: {
          message: {
            id: "long",
            author: { role: "user" },
            content: { content_type: "text", parts: ["x".repeat(9000)] },
            create_time: 1700000000,
          },
          children: [],
        },
      },
    };
    const events = mapConversationToEvents(longConv, { id: "conv-1", title: "Long" });
    expect(events[0].content.kind).toBe("observation");
    if (events[0].content.kind === "observation") {
      expect(events[0].content.text.length).toBe(8000);
    }
  });
});
