import type {
  Event,
  EventContent,
  MediaPayload,
  MemoryPayloadInput,
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
 * Convert `EventContent` into the textual + media parts of a MemoryPayload.
 * Used by extractors as a common building block — the textual `summary`
 * may be further refined (e.g. by an LLM) downstream.
 */
export function contentToTextAndMedia(content: EventContent): {
  summary: string;
  description?: string;
  media?: MediaPayload;
  modality: MemoryPayloadInput["modality"];
} {
  switch (content.kind) {
    case "message":
      return { summary: content.text, modality: ["text"] };
    case "speech": {
      const media = content.audio
        ? ({ audio: content.audio } satisfies MediaPayload)
        : undefined;
      return {
        summary: content.text,
        media,
        modality: media ? ["audio", "text"] : ["text"],
      };
    }
    case "image": {
      const summary = content.caption ?? "[image]";
      const media: MediaPayload = { frames: [content.image] };
      return { summary, media, modality: ["vision"] };
    }
    case "audio": {
      const summary = content.transcript ?? "[audio]";
      const media: MediaPayload = { audio: content.audio };
      return { summary, media, modality: content.transcript ? ["audio", "text"] : ["audio"] };
    }
    case "video": {
      const summary = content.transcript ?? "[video]";
      const media: MediaPayload = {
        video: content.video,
        frames: content.frames,
      };
      return {
        summary,
        media,
        modality: ["vision", content.transcript ? "text" : "audio"],
      };
    }
    case "file":
      return {
        summary: content.text ?? `[file ${content.mime}]`,
        description: content.text ? `file ref=${content.ref}` : undefined,
        modality: ["text"],
      };
    case "observation":
      return { summary: content.text, modality: ["text"] };
    case "custom":
      return {
        summary: content.text,
        description: content.data ? JSON.stringify(content.data) : undefined,
        modality: ["text"],
      };
  }
}

/**
 * Build a `WritePayload` skeleton from an Event. Extractors then enrich
 * the payload with tags, salience, and (optionally) embeddings.
 */
export function buildBaseWrite(
  event: Event,
  now: number,
  extras: { tags?: string[]; salienceScore?: number } = {},
): WritePayload {
  const { timestamp, duration } = resolveTimeAnchor(event, now);
  const { summary, description, media, modality } = contentToTextAndMedia(
    event.content,
  );

  const tagSet = new Set<string>();
  if (event.actor) tagSet.add(event.actor);
  if (event.target) tagSet.add(event.target);
  if (event.tags) for (const t of event.tags) tagSet.add(t);
  if (extras.tags) for (const t of extras.tags) tagSet.add(t);

  return {
    timestamp,
    duration,
    payload: {
      summary,
      description,
      media,
      modality,
      tags: [...tagSet],
      salienceScore: extras.salienceScore ?? event.salienceHint ?? 0.5,
    },
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
