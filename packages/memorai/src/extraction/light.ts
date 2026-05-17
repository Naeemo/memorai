import type { Event, ExtractContext, Extractor, WritePayload } from "../types.js";
import { buildBaseWrite, rawIndexableText } from "./shared.js";

const EXTRACTOR_VERSION = "light-v1";

/**
 * Heuristic-based extractor — no LLM required.
 *
 * Writes:
 *   - Tier 1 `raw` unchanged from the upstream Event
 *   - Tier 2 `annotations.tags` (proper-noun + hashtag + mention)
 *           `annotations.salienceScore` (heuristic mix of emphasis tokens,
 *                                        date-likes, length, proper-noun density)
 */
export class LightExtractor implements Extractor {
  async extract(event: Event, ctx: ExtractContext): Promise<WritePayload[]> {
    const base = buildBaseWrite(event, ctx.now());
    const text = rawIndexableText(base.raw);
    const tags = extractTags(text);
    const salience = event.salienceHint ?? scoreSalience(text);

    const annotations = base.annotations ?? {};
    annotations.tags = mergeTags(annotations.tags, tags);
    annotations.salienceScore = salience;
    base.annotations = annotations;
    base.annotationVersion = EXTRACTOR_VERSION;
    return [base];
  }
}

function mergeTags(a: string[] | undefined, b: string[]): string[] {
  const set = new Set<string>();
  for (const t of a ?? []) set.add(t.toLowerCase());
  for (const t of b) set.add(t.toLowerCase());
  return [...set];
}

const EMPHASIS =
  /\b(important|critical|urgent|asap|remember|don'?t forget|note that|warning|alert)\b/i;
const INVERSION =
  /\b(actually|but|however|instead|previously|originally|now|update[ds]?|change[ds]?)\b/i;
const DATE_LIKE =
  /\b\d{1,2}[:/-]\d{1,2}([:/-]\d{2,4})?\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|yesterday|today|tonight|next (week|month|year)|last (week|month|year))\b/i;
const QUESTION = /\?/;
const PROPER_NOUN = /\b[A-Z][a-zA-Z]{1,}\b/g;
const HASHTAG = /#([a-zA-Z][a-zA-Z0-9_]*)/g;
const MENTION = /@([a-zA-Z][a-zA-Z0-9_]*)/g;

export function scoreSalience(text: string): number {
  if (!text) return 0;
  let score = 0.4;
  const len = text.length;

  // Length: middle is best
  if (len < 16) score -= 0.1;
  else if (len > 256) score -= 0.05;
  else score += 0.05;

  if (EMPHASIS.test(text)) score += 0.2;
  if (INVERSION.test(text)) score += 0.1;
  if (DATE_LIKE.test(text)) score += 0.1;
  if (QUESTION.test(text)) score += 0.05;

  const nounMatches = text.match(PROPER_NOUN);
  if (nounMatches) {
    const density = nounMatches.length / Math.max(1, text.split(/\s+/).length);
    score += Math.min(0.15, density * 0.5);
  }

  return clamp01(score);
}

export function extractTags(text: string): string[] {
  if (!text) return [];
  const tags = new Set<string>();

  for (const m of text.matchAll(HASHTAG)) tags.add(m[1].toLowerCase());
  for (const m of text.matchAll(MENTION)) tags.add(m[1].toLowerCase());
  for (const m of text.matchAll(PROPER_NOUN)) {
    const w = m[0];
    if (w.length >= 2 && !STOPWORD_CAPS.has(w)) tags.add(w.toLowerCase());
  }

  return [...tags].slice(0, 8);
}

const STOPWORD_CAPS = new Set([
  "I",
  "The",
  "A",
  "An",
  "And",
  "Or",
  "But",
  "Yes",
  "No",
  "OK",
  "Ok",
  "It",
  "We",
  "You",
  "They",
  "He",
  "She",
  "Hi",
  "Hello",
  "Hey",
]);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
