import type {
  Event,
  EventContent,
  MediaPayload,
  MemoryAnnotationsInput,
  Modality,
  RawContent,
  WritePayload,
} from "../types.js";

/**
 * Normalize Event time anchor to a (timestamp, duration) pair.
 */
export function resolveTimeAnchor(
  event: Event,
  now: number,
): { timestamp: number; duration: number } {
  if (event.during) {
    const start = toMs(event.during.start);
    const end = toMs(event.during.end);
    return { timestamp: end, duration: Math.max(0, end - start) };
  }
  if (event.at !== undefined) {
    return { timestamp: toMs(event.at), duration: 0 };
  }
  return { timestamp: now, duration: 0 };
}

function toMs(t: number | Date): number {
  return t instanceof Date ? t.getTime() : t;
}

/**
 * Project `EventContent` into the textual + media + modality parts that get
 * stored in the Tier 1 `raw` field. Returns:
 *   - `text`:    flat textual projection for indexing (optional for binary-only events)
 *   - `media`:   multimodal references
 *   - `modality`: which modalities are present
 *   - `descriptionText`: a richer secondary description, only when the event
 *                       carries one (file contents, custom-payload JSON)
 *
 * This is purely a *flattening* of the original content — no extraction,
 * no summarization. The `content` itself stays untouched in `raw.content`.
 */
export function projectContent(content: EventContent): {
  text?: string;
  media?: MediaPayload;
  modality: Modality[];
  descriptionText?: string;
} {
  switch (content.kind) {
    case "message":
      return { text: content.text, modality: ["text"] };
    case "speech": {
      const media = content.audio ? ({ audio: content.audio } satisfies MediaPayload) : undefined;
      return {
        text: content.text,
        media,
        modality: media ? ["audio", "text"] : ["text"],
      };
    }
    case "image": {
      const media: MediaPayload = { frames: [content.image] };
      return {
        text: content.caption,
        media,
        modality: ["vision"],
      };
    }
    case "audio": {
      const media: MediaPayload = { audio: content.audio };
      return {
        text: content.transcript,
        media,
        modality: content.transcript ? ["audio", "text"] : ["audio"],
      };
    }
    case "video": {
      const media: MediaPayload = {
        video: content.video,
        frames: content.frames,
      };
      return {
        text: content.transcript,
        media,
        modality: ["vision", content.transcript ? "text" : "audio"],
      };
    }
    case "file":
      return {
        text: content.text,
        modality: ["text"],
        descriptionText: content.text ? `file ref=${content.ref}` : undefined,
      };
    case "observation":
      return { text: content.text, modality: ["text"] };
    case "custom":
      return {
        text: content.text,
        descriptionText: content.data ? JSON.stringify(content.data) : undefined,
        modality: ["text"],
      };
  }
}

/**
 * Best-effort flattening of `RawContent` to a single indexable string.
 * Used by storage adapters' BM25 indexing and by `Memorai.write()` to
 * compute embeddings.
 */
export function rawIndexableText(raw: RawContent): string {
  if (raw.text) return raw.text;
  // Fall back to a placeholder so the node is still findable by other paths.
  switch (raw.content.kind) {
    case "image":
      return raw.content.caption ?? "[image]";
    case "audio":
      return raw.content.transcript ?? "[audio]";
    case "video":
      return raw.content.transcript ?? "[video]";
    case "file":
      return `[file ${raw.content.mime}]`;
    default:
      return "";
  }
}

/**
 * Combine the Tier 1 raw text with the Tier 2 derived text (summary, facts,
 * description, tags) into a single indexable string for BM25 + embedding.
 *
 * Retrieval becomes Tier-1-and-Tier-2 simultaneously: BM25 hits literal
 * tokens from the original event AND canonicalised phrasings, and the
 * embedding sits in a semantic space that covers both.
 */
export function composeIndexableText(
  raw: RawContent,
  annotations?: MemoryAnnotationsInput,
): string {
  const parts: string[] = [];
  const rawText = rawIndexableText(raw);
  if (rawText) parts.push(rawText);
  if (annotations) {
    if (annotations.summary) parts.push(annotations.summary);
    if (annotations.facts) parts.push(...annotations.facts);
    if (annotations.description) parts.push(annotations.description);
    if (annotations.tags && annotations.tags.length > 0) {
      parts.push(annotations.tags.join(" "));
    }
  }
  // Dedup repeated lines.
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].join(" — ");
}

/**
 * Build a `WritePayload` skeleton from an Event. Returns:
 *   - Tier 1: `raw` carrying the original content + flat text + media refs
 *   - Tier 2: `annotations` pre-populated with tags / salience / modality
 *
 * Subclassing extractors can call this, then enrich `annotations` further
 * (e.g. with LLM-generated `summary` / `facts` / `triples`).
 */
export function buildBaseWrite(
  event: Event,
  now: number,
  extras: { tags?: string[]; salienceScore?: number } = {},
): WritePayload {
  const { timestamp, duration } = resolveTimeAnchor(event, now);
  const projection = projectContent(event.content);

  const tagSet = new Set<string>();
  if (event.actor) tagSet.add(event.actor);
  if (event.target) tagSet.add(event.target);
  if (event.tags) for (const t of event.tags) tagSet.add(t);
  if (extras.tags) for (const t of extras.tags) tagSet.add(t);

  const raw: RawContent = {
    content: event.content,
    text: projection.text,
    media: projection.media,
  };

  const annotations: MemoryAnnotationsInput = {
    tags: [...tagSet],
    salienceScore: extras.salienceScore ?? event.salienceHint ?? 0.5,
    modality: projection.modality,
    description: projection.descriptionText,
  };

  return {
    timestamp,
    duration,
    raw,
    annotations,
    actor: event.actor,
    target: event.target,
    userId: event.userId,
    meta: {
      eventId: event.id,
      writeContext: event.context,
      participants: event.participants,
    },
  };
}

/**
 * @deprecated Use `projectContent` / `rawIndexableText` directly. Kept for
 * back-compat with extractors that still call `contentToTextAndMedia`.
 */
export function contentToTextAndMedia(content: EventContent): {
  summary: string;
  description?: string;
  media?: MediaPayload;
  modality: Modality[];
} {
  const p = projectContent(content);
  return {
    summary: p.text ?? rawIndexableText({ content }),
    description: p.descriptionText,
    media: p.media,
    modality: p.modality,
  };
}
