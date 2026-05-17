import type { Event, ExtractContext, Extractor, WritePayload } from "../types.js";
import { buildBaseWrite } from "./shared.js";

const EXTRACTOR_VERSION = "wrap-v1";

/**
 * The simplest possible extractor — Tier 1 only.
 *
 * Writes the raw event content into `raw` and a minimal annotations layer
 * (tags from actor/target/event.tags, salience from hint-or-default 0.5,
 * modality inferred from the content kind). Performs no summarisation, no
 * paraphrasing, no LLM calls.
 *
 * Useful for:
 *   - text-only agents that already do extraction upstream
 *   - benchmarks where you want to measure the storage/retrieval layer in
 *     isolation, without an LLM extractor in the loop
 *   - the canonical "verbatim recorder" mode of Memorai
 */
export class WrapExtractor implements Extractor {
  async extract(event: Event, ctx: ExtractContext): Promise<WritePayload[]> {
    const base = buildBaseWrite(event, ctx.now());
    base.annotationVersion = EXTRACTOR_VERSION;
    return [base];
  }
}
