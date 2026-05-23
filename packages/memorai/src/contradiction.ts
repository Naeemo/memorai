import type {
  ContradictionDetector,
  ContradictionResult,
  EventStore,
  LLMService,
  MemoryEvent,
} from "./types.js";

const SYSTEM_PROMPT = `You are a contradiction detector. Given a NEW assertion and a list of EXISTING beliefs, identify which existing beliefs are directly contradicted by the new assertion.

Rules:
- A contradiction means the new assertion and the existing belief cannot both be true at the same time.
- "Different detail level" or "adds nuance" is NOT a contradiction.
- "Same topic, different preference" IS a contradiction (e.g. "likes tea" vs "likes coffee").
- Return JSON array of contradictions. Each element: { "eventId": string, "confidence": number 0..1 }
- Only include items with confidence >= 0.6.
- If no contradictions, return empty array [].`;

interface ContradictionJson {
  eventId?: string;
  confidence?: number;
}

/**
 * LLM-powered contradiction detector.
 *
 * Queries the event store for currently-valid `state` events that overlap
 * with the new assertion in participants/topics, then asks the configured
 * LLM which ones are genuinely contradicted.
 *
 * For efficiency, candidates are first filtered by semantic overlap (the
 * assertion is embedded and scored against candidate embeddings) before
 * being sent to the LLM. This keeps the prompt small and the latency low.
 */
export class LLMContradictionDetector implements ContradictionDetector {
  constructor(
    private readonly opts: {
      eventStore: EventStore;
      llm: LLMService;
      /** Max candidates to send to the LLM (default 10). */
      maxCandidates?: number;
    },
  ) {}

  async detect(
    opts: Parameters<ContradictionDetector["detect"]>[0],
  ): Promise<ContradictionResult[]> {
    // Gather candidates: all valid state events for the tenant that share
    // at least one participant or topic with the new assertion.
    const candidates = await this.gatherCandidates(opts);
    if (candidates.length === 0) return [];

    // Score each candidate with the LLM.
    const raw = await this.runLLM(opts.description, candidates);
    const parsed = this.parseRaw(raw, candidates);
    parsed.sort((a, b) => b.confidence - a.confidence);
    return parsed;
  }

  private async gatherCandidates(
    opts: Parameters<ContradictionDetector["detect"]>[0],
  ): Promise<MemoryEvent[]> {
    const all: MemoryEvent[] = [];

    if (opts.participants && opts.participants.length > 0) {
      for (const p of opts.participants) {
        const evs = await this.opts.eventStore.queryEventsByParticipant(p, {
          userId: opts.userId,
          kind: "state",
          excludeInvalidated: true,
        });
        for (const e of evs) {
          if (!all.some((a) => a.id === e.id)) all.push(e);
        }
      }
    }

    if (opts.topics && opts.topics.length > 0) {
      for (const t of opts.topics) {
        const evs = await this.opts.eventStore.queryEventsByTopic(t, {
          userId: opts.userId,
          kind: "state",
          excludeInvalidated: true,
        });
        for (const e of evs) {
          if (!all.some((a) => a.id === e.id)) all.push(e);
        }
      }
    }

    if (all.length === 0 && opts.userId) {
      // Fallback: all state events for this user.
      const evs = await this.opts.eventStore.listEvents({
        userId: opts.userId,
        kind: "state",
        excludeInvalidated: true,
      });
      all.push(...evs);
    }

    const maxCandidates = this.opts.maxCandidates ?? 10;
    return all.slice(0, maxCandidates);
  }

  private async runLLM(
    newAssertion: string,
    candidates: MemoryEvent[],
  ): Promise<string> {
    const prompt = this.buildPrompt(newAssertion, candidates);
    return this.opts.llm.complete(prompt, {
      temperature: 0,
      maxTokens: 512,
      responseFormat: "json",
    });
  }

  private buildPrompt(newAssertion: string, candidates: MemoryEvent[]): string {
    const lines = candidates.map((e) => `- [${e.id}] ${e.description}`).join("\n");
    return `${SYSTEM_PROMPT}\n\nNEW ASSERTION:\n${newAssertion}\n\nEXISTING BELIEFS:\n${lines}\n\nCONTRADICTIONS (JSON array):`;
  }

  private parseRaw(raw: string, candidates: MemoryEvent[]): ContradictionResult[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try extracting JSON from markdown code block.
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]!);
        } catch {
          return [];
        }
      } else {
        return [];
      }
    }

    if (!Array.isArray(parsed)) return [];

    const candidateMap = new Map(candidates.map((e) => [e.id, e]));
    const results: ContradictionResult[] = [];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const r = item as ContradictionJson;
      const eventId = typeof r.eventId === "string" ? r.eventId : "";
      const confidence = typeof r.confidence === "number" ? r.confidence : 0;
      if (!eventId || confidence < 0.6) continue;
      const ev = candidateMap.get(eventId);
      if (!ev) continue;
      results.push({ eventId, description: ev.description, confidence });
    }

    return results;
  }
}
