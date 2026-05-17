import type {
  EventIdentifier,
  IdentifiedEvent,
  IdentifyContext,
  LLMService,
  MemoryEvent,
  MemoryEventKind,
  MemoryNode,
} from "../types.js";

const IDENTIFIER_VERSION = "llm-identifier-v1";

const SYSTEM_PROMPT = `You are a memory-event identifier. Given a batch of raw conversation turns and any related events the system already knows about, your job is to identify the semantically meaningful events that should be remembered.

There are three kinds of memory events:

- "state":      An assertion about how the world is, that may persist over time.
                Example: "Alice prefers tea over coffee". State assertions can
                be superseded by newer ones.

- "transition": A change from one state to another, optionally with a trigger.
                Example: "Alice developed a nut allergy after eating peanuts in
                March". The transition itself is fixed in time; the resulting
                state can be its own event.

- "happening":  A discrete occurrence anchored in time. Example: "There's an
                urgent meeting Wednesday evening that Bob must attend".

Rules:
- Use the raw node ids exactly as given.
- Only include "supersedesIds" if the event you're proposing IS a state
  assertion that conflicts with or updates an existing state event of the same
  participants + topic.
- Be precise. Do not invent events that aren't supported by the raw turns.
- If a turn contains no memorable event (greetings, filler, etc.), skip it.
- canonical lowercase names for participants and topics.
`;

interface RawIdentifiedEventJson {
  kind?: string;
  description?: string;
  participants?: string[];
  topics?: string[];
  occurredAtNodeId?: string;
  sourceNodeIds?: string[];
  supersedesIds?: string[];
  confidence?: number;
}

/**
 * LLM-powered event identifier.
 *
 * Takes a batch of raw MemoryNodes plus any related existing MemoryEvents
 * (for supersede context), asks the configured LLM to identify state /
 * transition / happening events, and returns IdentifiedEvent records the
 * Memorai pipeline can persist.
 *
 * Falls back to producing no events when the LLM is unavailable or returns
 * unparseable JSON — Tier 1 (raw nodes) is always preserved separately, so
 * a failed identification pass is non-destructive.
 */
export class LLMEventIdentifier implements EventIdentifier {
  readonly version: string = IDENTIFIER_VERSION;

  constructor(
    private readonly opts: {
      llm?: LLMService;
      systemPrompt?: string;
      temperature?: number;
      /** Max characters of raw text to send per call. Default 16000. */
      maxInputChars?: number;
      /**
       * Called when the LLM call or JSON parsing fails. Receives a short
       * `stage` label and the raw error. Defaults to `console.error`. Pass
       * a no-op to suppress.
       */
      onError?: (
        stage: string,
        err: unknown,
        ctx: { batchSize: number; rawSample?: string },
      ) => void;
    } = {},
  ) {}

  private reportError(stage: string, err: unknown, batchSize: number, rawSample?: string): void {
    if (this.opts.onError) {
      try {
        this.opts.onError(stage, err, { batchSize, rawSample });
      } catch {
        // swallow — error reporter itself should never break identification
      }
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const tail = rawSample ? ` raw=${JSON.stringify(rawSample)}` : "";
    console.error(`[LLMEventIdentifier] ${stage} (batchSize=${batchSize}): ${msg}${tail}`);
  }

  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    const llm = this.opts.llm ?? ctx.llm;
    if (!llm) return [];
    if (ctx.nodes.length === 0) return [];

    const maxChars = this.opts.maxInputChars ?? 16000;
    const prompt = buildPrompt(
      this.opts.systemPrompt ?? SYSTEM_PROMPT,
      ctx.nodes,
      ctx.relatedEvents,
      maxChars,
    );

    let raw: string;
    try {
      raw = await llm.complete(prompt, {
        temperature: this.opts.temperature ?? 0,
        maxTokens: 2048,
        responseFormat: "json",
        signal: ctx.signal,
      });
    } catch (err) {
      this.reportError("llm.complete failed", err, ctx.nodes.length);
      return [];
    }

    let parsed: RawIdentifiedEventJson[];
    try {
      parsed = parseJsonArray(raw);
    } catch (err) {
      this.reportError("JSON parse failed", err, ctx.nodes.length, raw.slice(0, 200));
      return [];
    }

    const nodesById = new Map(ctx.nodes.map((n) => [n.id, n]));
    const identified: IdentifiedEvent[] = [];

    for (const item of parsed) {
      const kind = normalizeKind(item.kind);
      if (!kind) continue;
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!description) continue;

      const sourceNodeIds = Array.isArray(item.sourceNodeIds)
        ? item.sourceNodeIds.filter(
            (id): id is string => typeof id === "string" && nodesById.has(id),
          )
        : [];
      if (sourceNodeIds.length === 0) continue;

      const anchorNode =
        (item.occurredAtNodeId ? nodesById.get(item.occurredAtNodeId) : undefined) ??
        nodesById.get(sourceNodeIds[0])!;

      const participants = Array.isArray(item.participants)
        ? item.participants
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.toLowerCase().trim())
            .filter(Boolean)
        : [];
      const topics = Array.isArray(item.topics)
        ? item.topics
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.toLowerCase().trim())
            .filter(Boolean)
        : [];

      const supersedes =
        kind === "state" && Array.isArray(item.supersedesIds)
          ? item.supersedesIds.filter((id): id is string => typeof id === "string")
          : undefined;

      identified.push({
        kind,
        description,
        participants,
        topics,
        occurredAt: anchorNode.timestamp,
        sourceNodeIds,
        supersedes,
        confidence: clampConfidence(item.confidence),
      });
    }

    return identified;
  }
}

function buildPrompt(
  systemPrompt: string,
  nodes: MemoryNode[],
  related: MemoryEvent[],
  maxChars: number,
): string {
  const lines: string[] = [systemPrompt, ""];

  if (related.length > 0) {
    lines.push("EXISTING RELATED EVENTS (you may supersede these):");
    lines.push(
      JSON.stringify(
        related.map((r) => ({
          id: r.id,
          kind: r.kind,
          description: r.description,
          participants: r.participants,
          topics: r.topics,
        })),
        null,
        2,
      ),
    );
    lines.push("");
  } else {
    lines.push("EXISTING RELATED EVENTS: (none)");
    lines.push("");
  }

  lines.push("RAW NODES TO ANALYZE:");
  let charBudget = maxChars;
  const nodeJson: Array<{
    id: string;
    occurredAt: number;
    text: string;
    actor?: string;
    target?: string;
  }> = [];
  for (const n of nodes) {
    const text = n.raw.text ?? "";
    if (text.length > charBudget) break;
    charBudget -= text.length;
    nodeJson.push({
      id: n.id,
      occurredAt: n.timestamp,
      text,
      actor: n.actor,
      target: n.target,
    });
  }
  lines.push(JSON.stringify(nodeJson, null, 2));
  lines.push("");
  lines.push(
    "Output a JSON array of identified events. Schema per element:",
    `{
  "kind": "state" | "transition" | "happening",
  "description": string,
  "participants": string[],
  "topics": string[],
  "occurredAtNodeId": string,
  "sourceNodeIds": string[],
  "supersedesIds"?: string[],
  "confidence"?: number
}`,
    "If nothing memorable: [].",
  );
  return lines.join("\n");
}

function parseJsonArray(raw: string): RawIdentifiedEventJson[] {
  const trimmed = raw.trim();
  // Strip leading/trailing code-fence noise.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
    return [];
  }
  const json = cleaned.slice(firstBracket, lastBracket + 1);
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as RawIdentifiedEventJson[]) : [];
}

function normalizeKind(raw: unknown): MemoryEventKind | undefined {
  if (typeof raw !== "string") return undefined;
  const k = raw.toLowerCase().trim();
  if (k === "state" || k === "transition" || k === "happening") return k;
  return undefined;
}

function clampConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}
