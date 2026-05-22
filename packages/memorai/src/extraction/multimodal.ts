import type { Event, ExtractContext, Extractor, WritePayload } from "../types.js";
import { WrapExtractor } from "./wrap.js";

/**
 * Optional captioner for image data. Receives an ImageData or a reference
 * string (URL / blob key) and returns a text caption. The caller decides
 * whether to use a local vision model, a cloud API, or a rule-based
 * heuristic.
 */
export type ImageCaptioner = (
  image: ImageData | string,
) => Promise<string | undefined>;

/**
 * Optional transcriber for audio data. Receives an AudioBuffer or a
 * reference string and returns a text transcript.
 */
export type AudioTranscriber = (
  audio: AudioBuffer | string,
) => Promise<string | undefined>;

export interface MultimodalExtractorOptions {
  /** Base extractor — captions are merged on top of its output. */
  base?: Extractor;
  /** Caption images that don't already have a caption. */
  captionImage?: ImageCaptioner;
  /** Transcribe audio that doesn't already have a transcript. */
  transcribeAudio?: AudioTranscriber;
}

/**
 * Extractor that bridges multimodal events into the text retrieval
 * pipeline by generating captions / transcripts for media.
 *
 * When an event contains an image without a caption, `captionImage` is
 * called and the result is added to the payload's `raw.text` and
 * `annotations.summary`. Audio without a transcript is handled the same
 * way via `transcribeAudio`.
 *
 * The generated text flows through the normal embedding + BM25 pathways,
 * so text queries can retrieve image/audio events without any special
 * cross-modal retrieval engine.
 *
 * Usage:
 * ```ts
 * const memory = new Memorai({
 *   extractor: new MultimodalExtractor({
 *     captionImage: async (img) => {
 *       const result = await visionModel.generate(img);
 *       return result.caption;
 *     },
 *   }),
 * });
 * ```
 */
export class MultimodalExtractor implements Extractor {
  private readonly base: Extractor;
  private readonly captionImage?: ImageCaptioner;
  private readonly transcribeAudio?: AudioTranscriber;

  constructor(opts: MultimodalExtractorOptions = {}) {
    this.base = opts.base ?? new WrapExtractor();
    this.captionImage = opts.captionImage;
    this.transcribeAudio = opts.transcribeAudio;
  }

  async extract(event: Event, ctx: ExtractContext): Promise<WritePayload[]> {
    const payloads = await this.base.extract(event, ctx);

    // Generate captions / transcripts if media is present and callbacks
    // are configured.
    const mediaTexts: string[] = [];

    if (event.content.kind === "image" && this.captionImage && !event.content.caption) {
      const caption = await this.captionImage(event.content.image);
      if (caption) mediaTexts.push(caption);
    }

    if (event.content.kind === "audio" && this.transcribeAudio && !event.content.transcript) {
      const transcript = await this.transcribeAudio(event.content.audio);
      if (transcript) mediaTexts.push(transcript);
    }

    if (event.content.kind === "video") {
      // Caption keyframes if available
      if (event.content.frames && this.captionImage) {
        for (const frame of event.content.frames) {
          const caption = await this.captionImage(frame);
          if (caption) mediaTexts.push(caption);
        }
      }
      // Transcribe audio track if available
      if (event.content.video && this.transcribeAudio && !event.content.transcript) {
        const transcript = await this.transcribeAudio(event.content.video);
        if (transcript) mediaTexts.push(transcript);
      }
    }

    if (mediaTexts.length === 0) return payloads;

    // Merge generated text into every payload so it gets indexed.
    const mergedText = mediaTexts.join("\n");
    for (const payload of payloads) {
      const existingText = payload.raw.text ?? "";
      payload.raw.text = existingText ? `${existingText}\n${mergedText}` : mergedText;

      // Also set summary if empty so the caption is retrievable.
      if (!payload.annotations?.summary) {
        payload.annotations = { ...payload.annotations };
        payload.annotations.summary = mergedText.slice(0, 500);
      }
    }

    return payloads;
  }
}
