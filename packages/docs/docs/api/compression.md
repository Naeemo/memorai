# Compression Service

The `CompressionService` handles raw media compression before storage. It's **optional** — if you don't pass one, Memorai stores media references as-is.

Compression matters most for STM: streaming agents can produce a lot of frames per second, and an uncompressed IndexedDB fills up fast.

## Interface

```typescript
interface CompressionService {
  // Video: compress frame sequence → keyframes + delta
  compressVideo(frames: ImageData[], config: VideoCompressConfig): Promise<CompressedVideo>;

  // Audio: compress audio clip
  compressAudio(buffer: AudioBuffer, config: AudioCompressConfig): Promise<CompressedAudio>;

  // Image: compress single frame
  compressImage(image: ImageData, config: ImageCompressConfig): Promise<CompressedImage>;
}
```

Memorai calls these methods automatically when:

- The incoming `WritePayload.payload.media` contains raw data (not a reference string), **and**
- A `CompressionService` is configured.

The returned references replace the raw blobs before storage.

## Built-in compressors

```typescript
import { BrowserImageCompressor, PassthroughCompressor } from 'memorai';
```

### `BrowserImageCompressor`

Canvas-based image compression for the browser. Re-encodes `ImageData` into JPEG/WebP at a configurable quality, returning a data-URL reference.

```typescript
const compression = new BrowserImageCompressor({
  quality: 0.7,
  format: 'image/webp',
});
```

### `PassthroughCompressor`

A no-op compressor that hands back the raw input. Useful when you want to disable compression but keep the rest of the pipeline wiring consistent.

```typescript
const compression = new PassthroughCompressor();
```

## When to roll your own

Server-side video / audio compression is non-trivial — most projects reach for `sharp`, `ffmpeg-wasm`, or `wasm-vips`. The interface intentionally returns references so that your compressor can offload to a Web Worker, a worker thread, or a separate service entirely.

```typescript
class SharpImageCompressor implements CompressionService {
  async compressImage(image: ImageData) {
    // ...resize + re-encode via sharp, write to disk, return ref
  }
  // ...
}
```

Tips:

- **Always return a stable reference.** Re-running the pipeline on the same input should produce the same `ref` — that's what makes deduplication work.
- **Compress on a worker if you can.** Canvas-based JPEG encoding blocks the main thread; `OffscreenCanvas` in a Web Worker fixes that.
- **Treat compression as best-effort.** If a frame fails to compress, fall back to the raw reference rather than dropping the memory entirely.
