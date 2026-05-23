import { generateId } from "./utils.js";
import type {
  EventStore,
  IdentifiedEvent,
  LLMService,
  MemoryEvent,
  ReflectOptions,
  ReflectionResult,
} from "./types.js";

const REFLECTION_PROMPT = `You are a memory reflection engine. Given a set of events about people, their actions, and their preferences, generate high-level insights that are NOT directly stated in the events but can be inferred from patterns across them.

For each insight:
- description: a concise factual statement ("Alice consistently prefers tea over coffee in morning meetings")
- participants: who the insight is about
- topics: relevant topic tags
- confidence: 0.0-1.0 based on strength of evidence

Focus on:
1. Pattern summaries ("X consistently does Y when Z")
2. Causal inferences ("Bob's errors spike on Fridays — likely fatigue-related")
3. Contradiction resolutions ("Alice liked tea before March 2024, then switched to coffee")
4. Preference stabilization ("Over 5 observations, Bob's preference for dark mode is consistent")

Return JSON: { insights: [{ description, participants, topics, confidence }] }`;

/**
 * Generative reflection engine (S5).
 *
 * Unlike `evolve()` which is *extractive* (compresses existing nodes into
 * higher-level episodes), reflection is *generative*: it asks the LLM to
 * form new beliefs from patterns across events, producing insights that
 * were never explicitly stated in any single event.
 */
export class ReflectionEngine {
  constructor(
    private readonly opts: {
      eventStore: EventStore;
      llm: LLMService;
      /** Max events to feed the LLM. Default 30. */
      maxEvents?: number;
    },
  ) {}

  async reflect(opts: ReflectOptions = {}): Promise<ReflectionResult> {
    const since = opts.since ?? Date.now() - 86400000; // default 24h
    const maxEvents = opts.maxEvents ?? this.opts.maxEvents ?? 30;

    // Fetch candidate events.
    let candidates = await this.opts.eventStore.listEvents({
      orderBy: "occurredAt",
      order: "desc",
      limit: maxEvents * 2,
    });

    // Filter to window.
    candidates = candidates.filter((e) => e.occurredAt >= since);

    // Apply focus filters.
    if (opts.focus?.participants && opts.focus.participants.length > 0) {
      const ps = new Set(opts.focus.participants.map((p) => p.toLowerCase()));
      candidates = candidates.filter((e) =>
        e.participants.some((p) => ps.has(p.toLowerCase())),
      );
    }
    if (opts.focus?.topics && opts.focus.topics.length > 0) {
      const ts = new Set(opts.focus.topics.map((t) => t.toLowerCase()));
      candidates = candidates.filter((e) =>
        e.topics.some((t) => ts.has(t.toLowerCase())),
      );
    }

    if (candidates.length === 0) {
      return { insights: [], revisedEvents: [] };
    }

    // Sort oldest-first for the prompt.
    candidates.sort((a, b) => a.occurredAt - b.occurredAt);
    const toReflect = candidates.slice(0, maxEvents);

    // Build LLM prompt.
    const prompt = this.buildPrompt(toReflect);

    // Run LLM.
    let raw: string;
    try {
      raw = await this.opts.llm.complete(prompt, {
        temperature: 0.3,
        maxTokens: 1024,
        responseFormat: "json",
      });
    } catch {
      return { insights: [], revisedEvents: [] };
    }

    // Parse insights.
    const insights = this.parseInsights(raw, toReflect);

    // Detect revised interpretations.
    const revisedEvents = this.detectRevisions(insights, toReflect);

    return { insights, revisedEvents };
  }

  private buildPrompt(events: MemoryEvent[]): string {
    const lines = events
      .map((e) => {
        const date = new Date(e.occurredAt).toISOString().slice(0, 10);
        return `- [${date}] ${e.description} (participants: ${e.participants.join(", ")}, topics: ${e.topics.join(", ")})`;
      })
      .join("\n");

    return `${REFLECTION_PROMPT}\n\nEVENTS:\n${lines}\n\nINSIGHTS (JSON):`;
  }

  private parseInsights(raw: string, sourceEvents: MemoryEvent[]): MemoryEvent[] {
    let parsed: { insights?: Array<Partial<IdentifiedEvent> & { confidence?: number }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // Try extracting JSON from markdown code block.
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]!) as typeof parsed;
        } catch {
          return [];
        }
      } else {
        return [];
      }
    }

    if (!parsed.insights || !Array.isArray(parsed.insights)) return [];

    const now = Date.now();
    const events: MemoryEvent[] = [];

    for (const item of parsed.insights) {
      if (!item.description) continue;
      const participants = Array.isArray(item.participants) ? item.participants : [];
      const topics = Array.isArray(item.topics) ? item.topics : [];
      const confidence =
        typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.7;

      const event: MemoryEvent = {
        id: generateId(),
        kind: "state",
        description: item.description,
        participants,
        topics,
        occurredAt: now,
        sourceNodeIds: sourceEvents.map((e) => e.id),
        confidence,
        identifierVersion: "reflection-v1",
        meta: {
          identifiedAt: now,
          accessCount: 0,
          reflectedAt: now,
        },
      };
      events.push(event);
    }

    return events;
  }

  private detectRevisions(
    insights: MemoryEvent[],
    sourceEvents: MemoryEvent[],
  ): Array<{ eventId: string; reason: string }> {
    const revised: Array<{ eventId: string; reason: string }> = [];

    // Simple heuristic: if an insight contradicts a source event, mark the source as revised.
    for (const insight of insights) {
      for (const source of sourceEvents) {
        if (source.kind !== "state") continue;
        // Very naive: if insight description contains negation words and overlaps with source
        const negationWords = ["no longer", "switched", "changed", "stopped", "started", "instead"];
        const hasNegation = negationWords.some((w) => insight.description.toLowerCase().includes(w));
        if (hasNegation && this.sharesParticipant(insight, source)) {
          revised.push({
            eventId: source.id,
            reason: `Contradicted by reflection insight: "${insight.description}"`,
          });
        }
      }
    }

    return revised;
  }

  private sharesParticipant(a: MemoryEvent, b: MemoryEvent): boolean {
    const setA = new Set(a.participants.map((p) => p.toLowerCase()));
    return b.participants.some((p) => setA.has(p.toLowerCase()));
  }
}
