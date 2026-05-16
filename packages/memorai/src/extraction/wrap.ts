import type { Event, ExtractContext, Extractor, WritePayload } from "../types.js";
import { buildBaseWrite } from "./shared.js";

/**
 * The simplest possible extractor. Takes the event's textual content as the
 * memory summary, attaches actor/target as tags, and uses the salience hint
 * (or 0.5) directly. No LLM. Useful for:
 *   - text-only agents that already do extraction upstream
 *   - benchmarks where you want to measure the storage/retrieval layer in
 *     isolation, without an LLM extractor in the loop
 */
export class WrapExtractor implements Extractor {
  async extract(event: Event, ctx: ExtractContext): Promise<WritePayload[]> {
    return [buildBaseWrite(event, ctx.now())];
  }
}
