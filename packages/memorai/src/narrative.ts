import type {
  LLMService,
  NarrativeEvent,
  NarrativeRecall,
  RecalledMemory,
  RecallResult,
} from "./types.js";

const NARRATIVE_PROMPT = `You are a narrative structuring engine. Given a set of chronologically ordered events, assign each event a role in the narrative arc and identify causal connections between them.

Narrative roles:
- setup: background context that sets the stage
- trigger: the event that initiated the sequence
- response: reactions or actions taken in response
- climax: the turning point or peak moment
- resolution: the outcome or conclusion
- context: supporting information (default)

Causal relations:
- causes: event A directly caused event B
- responds_to: event B is a reaction to event A
- enables: event A made event B possible
- contradicts: event B contradicts or reverses event A

Return JSON:
{
  summary: "One-sentence summary of the narrative",
  events: [
    { eventId: string, role: "setup|trigger|response|climax|resolution|context", connections: [{ toEventId: string, relation: "causes|responds_to|enables|contradicts" }] }
  ],
  participants: ["Alice", "Bob"],
  themes: ["budget", "deployment"]
}`;

/**
 * Narrative builder (S8).
 *
 * Takes a flat list of recalled memories and structures them into a
 * narrative arc with roles, causal connections, and a summary.
 * Falls back to a simple chronological ordering when no LLM is available.
 */
export class NarrativeBuilder {
  private readonly llm: LLMService | undefined;

  constructor(llm: LLMService | undefined) {
    this.llm = llm;
  }

  async build(
    recallResult: RecallResult,
    _question: string,
  ): Promise<NarrativeRecall> {
    const memories = recallResult.memories;
    if (memories.length === 0) {
      return {
        summary: "No memories found.",
        events: [],
        participants: [],
        themes: [],
        timeSpan: { start: 0, end: 0 },
      };
    }

    // Sort chronologically.
    const sorted = [...memories].sort((a, b) => a.at - b.at);

    // Extract participants and themes.
    const participantSet = new Set<string>();
    const themeSet = new Set<string>();
    for (const m of sorted) {
      if (m.actor) participantSet.add(m.actor);
      if (m.target) participantSet.add(m.target);
      for (const t of m.tags) themeSet.add(t.toLowerCase());
    }

    const timeSpan = {
      start: sorted[0].at,
      end: sorted[sorted.length - 1].at,
    };

    // If no LLM, do a simple fallback assignment.
    if (!this.llm) {
      return this.fallbackNarrative(sorted, participantSet, themeSet, timeSpan);
    }

    // Use LLM for narrative structuring.
    return this.llmNarrative(sorted, participantSet, themeSet, timeSpan);
  }

  private fallbackNarrative(
    sorted: RecalledMemory[],
    participantSet: Set<string>,
    themeSet: Set<string>,
    timeSpan: { start: number; end: number },
  ): NarrativeRecall {
    const events: NarrativeEvent[] = sorted.map((m, i) => {
      let role: NarrativeEvent["role"] = "context";
      if (i === 0) role = "setup";
      else if (i === 1) role = "trigger";
      else if (i === sorted.length - 1) role = "resolution";
      else if (i === Math.floor(sorted.length / 2)) role = "climax";
      else if (i > 1 && i < sorted.length - 1) role = "response";
      return { memory: m, role };
    });

    return {
      summary: `Sequence of ${sorted.length} events involving ${[...participantSet].join(", ") || "unknown participants"}.`,
      events,
      participants: [...participantSet],
      themes: [...themeSet],
      timeSpan,
    };
  }

  private async llmNarrative(
    sorted: RecalledMemory[],
    participantSet: Set<string>,
    themeSet: Set<string>,
    timeSpan: { start: number; end: number },
  ): Promise<NarrativeRecall> {
    const lines = sorted
      .map((m) => `- [${m.id}] ${m.summary} (at: ${new Date(m.at).toISOString()})`)
      .join("\n");

    const prompt = `${NARRATIVE_PROMPT}\n\nEVENTS:\n${lines}\n\nNARRATIVE (JSON):`;

    let raw: string;
    try {
      raw = await this.llm!.complete(prompt, {
        temperature: 0.2,
        maxTokens: 1024,
        responseFormat: "json",
      });
    } catch {
      return this.fallbackNarrative(sorted, participantSet, themeSet, timeSpan);
    }

    let parsed: {
      summary?: string;
      events?: Array<{
        eventId: string;
        role?: string;
        connections?: Array<{ toEventId: string; relation?: string }>;
      }>;
      participants?: string[];
      themes?: string[];
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]!);
        } catch {
          return this.fallbackNarrative(sorted, participantSet, themeSet, timeSpan);
        }
      } else {
        return this.fallbackNarrative(sorted, participantSet, themeSet, timeSpan);
      }
    }

    const summary = parsed.summary || `Sequence of ${sorted.length} events.`;
    const participants = parsed.participants || [...participantSet];
    const themes = parsed.themes || [...themeSet];

    // Map parsed events to NarrativeEvent.
    const byId = new Map(sorted.map((m) => [m.id, m]));
    const events: NarrativeEvent[] = [];

    for (const item of parsed.events || []) {
      const memory = byId.get(item.eventId);
      if (!memory) continue;

      const role = this.parseRole(item.role);
      const connections: NarrativeEvent["connections"] = [];
      for (const c of item.connections || []) {
        const relation = this.parseRelation(c.relation);
        if (relation) {
          connections.push({ toEventId: c.toEventId, relation });
        }
      }

      events.push({
        memory,
        role,
        connections: connections.length > 0 ? connections : undefined,
      });
    }

    // Ensure all memories are represented (fill gaps with context role).
    const seen = new Set(events.map((e) => e.memory.id));
    for (const m of sorted) {
      if (!seen.has(m.id)) {
        events.push({ memory: m, role: "context" });
      }
    }

    // Re-sort by original chronology.
    events.sort((a, b) => a.memory.at - b.memory.at);

    return { summary, events, participants, themes, timeSpan };
  }

  private parseRole(raw: string | undefined): NarrativeEvent["role"] {
    switch (raw?.toLowerCase()) {
      case "setup":
        return "setup";
      case "trigger":
        return "trigger";
      case "response":
        return "response";
      case "climax":
        return "climax";
      case "resolution":
        return "resolution";
      default:
        return "context";
    }
  }

  private parseRelation(raw: string | undefined): NonNullable<NarrativeEvent["connections"]> [number]["relation"] | null {
    switch (raw?.toLowerCase()) {
      case "causes":
        return "causes";
      case "responds_to":
      case "respondsto":
        return "responds_to";
      case "enables":
        return "enables";
      case "contradicts":
        return "contradicts";
      default:
        return null;
    }
  }
}
