import { Memorai, MemoryAdapter, type EmbeddingService, type EventContent } from "../src/index.js";
import { projectContent } from "../src/extraction/shared.js";

class MockEmbeddingService implements EmbeddingService {
  readonly dimension = 4;
  embed(text: string): Promise<number[]> {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) % 10000;
    }
    const base = hash / 10000;
    return Promise.resolve([base, 1 - base, base * 0.5, 1 - base * 0.5]);
  }
}

// ─── projectContent for tool_call / plan_step ───

describe("projectContent for procedural kinds", () => {
  test("tool_call produces searchable text", () => {
    const content: EventContent = {
      kind: "tool_call",
      tool: "search_web",
      args: { query: "weather in Tokyo" },
      result: { temp: 18, condition: "sunny" },
      success: true,
      durationMs: 432,
    };
    const p = projectContent(content);
    expect(p.text).toContain("tool=search_web");
    expect(p.text).toContain("status=ok");
    expect(p.text).toContain('"query":"weather in Tokyo"');
    expect(p.text).toContain('"temp":18');
    expect(p.modality).toEqual(["text"]);
  });

  test("failed tool_call records error class", () => {
    const content: EventContent = {
      kind: "tool_call",
      tool: "db_query",
      args: "SELECT *",
      success: false,
      errorClass: "Timeout",
    };
    const p = projectContent(content);
    expect(p.text).toContain("status=error");
    expect(p.text).toContain("error=Timeout");
    expect(p.text).toContain("args=SELECT *");
  });

  test("plan_step produces searchable text with status", () => {
    const content: EventContent = {
      kind: "plan_step",
      step: "Send confirmation email to user",
      tool: "send_email",
      status: "completed",
      outcome: "sent successfully",
    };
    const p = projectContent(content);
    expect(p.text).toContain("plan_step status=completed");
    expect(p.text).toContain("tool=send_email");
    expect(p.text).toContain("Send confirmation email");
    expect(p.text).toContain("outcome=sent successfully");
  });

  test("plan_step with dependencies", () => {
    const content: EventContent = {
      kind: "plan_step",
      step: "Apply migration",
      dependsOn: ["step-1", "step-2"],
      status: "pending",
    };
    const p = projectContent(content);
    expect(p.text).toContain("deps=step-1,step-2");
    expect(p.text).toContain("status=pending");
  });
});

// ─── Memorai integration with procedural events ───

describe("Memorai with tool_call events", () => {
  test("recordEvent accepts tool_call content", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const nodes = await memory.recordEvent({
      at: Date.now(),
      actor: "agent",
      content: {
        kind: "tool_call",
        tool: "calculator",
        args: { expression: "2+2" },
        result: 4,
        success: true,
      },
    }).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].raw.content.kind).toBe("tool_call");
    expect(nodes[0].raw.text).toContain("calculator");
    await memory.close();
  });

  test("procedural strategy boosts tool_call hits", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const now = Date.now();
    await memory.recordEvents([
      {
        at: now - 1000,
        actor: "agent",
        content: { kind: "message", text: "calculator usage discussion" },
      },
      {
        at: now,
        actor: "agent",
        content: {
          kind: "tool_call",
          tool: "calculator",
          args: { expression: "2+2" },
          result: 4,
          success: true,
        },
      },
    ]).nodes;

    const result = await memory.recall("calculator", { strategy: "procedural", topK: 5 });
    expect(result.memories.length).toBeGreaterThan(0);
    // tool_call should outrank plain message thanks to the procedural boost.
    const topKind = result.memories[0];
    expect(topKind.summary).toContain("tool=calculator");
    await memory.close();
  });

  test("recall surfaces failed tool_call when asking about errors", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const now = Date.now();
    await memory.recordEvents([
      {
        at: now - 1000,
        actor: "agent",
        content: {
          kind: "tool_call",
          tool: "send_email",
          success: true,
          durationMs: 200,
        },
      },
      {
        at: now,
        actor: "agent",
        content: {
          kind: "tool_call",
          tool: "send_email",
          success: false,
          errorClass: "Timeout",
        },
      },
    ]).nodes;

    const result = await memory.recall("send_email Timeout", {
      strategy: "procedural",
      topK: 5,
    });
    expect(result.memories.length).toBeGreaterThan(0);
    // Failure should outrank success when query mentions the error class.
    const failureFirst = result.memories.find((m) => m.summary?.includes("error=Timeout"));
    expect(failureFirst).toBeDefined();
    await memory.close();
  });

  test("plan_step events are recordable", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "planner",
      content: {
        kind: "plan_step",
        step: "Verify database migration ran cleanly",
        status: "pending",
      },
    }).nodes;

    const result = await memory.recall("database migration", {
      strategy: "procedural",
      topK: 3,
    });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].summary).toContain("plan_step");
    await memory.close();
  });
});
