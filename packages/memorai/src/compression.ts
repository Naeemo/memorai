import type {
  AudioCompressConfig,
  CompressedAudio,
  CompressedImage,
  CompressedVideo,
  CompressionService,
  ImageCompressConfig,
  VideoCompressConfig,
} from './types.js'

/**
 * Compression service interface for multimodal memory.
 *
 * Handles raw media compression before storage.  The compressed result
 * is typically stored externally (blob storage, filesystem, CDN) and only
 * a reference is kept inside the MemoryNode.
 *
 * Implementations are runtime-specific:
 *   - Browser: Canvas-based image compression
 *   - Node.js: Sharp (images), ffmpeg (audio/video)
 *   - Users can provide custom implementations
 */

export type {
  AudioCompressConfig,
  CompressedAudio,
  CompressedImage,
  CompressedVideo,
  CompressionService,
  ImageCompressConfig,
  VideoCompressConfig,
} from './types.js'

// ─── Browser Image Compression (Canvas-based) ───

/**
 * Browser-only image compression using HTML Canvas.
 * Works in all modern browsers.  No external dependencies.
 */
export class BrowserImageCompressor implements CompressionService {
  async compressImage(
    image: ImageData,
    config: ImageCompressConfig = {},
  ): Promise<CompressedImage> {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    let { width, height } = image
    const maxW = config.maxWidth ?? width
    const maxH = config.maxHeight ?? height

    if (width > maxW || height > maxH) {
      const ratio = Math.min(maxW / width, maxH / height)
      width = Math.round(width * ratio)
      height = Math.round(height * ratio)
    }

    canvas.width = width
    canvas.height = height
    ctx.putImageData(image, 0, 0)

    const format = config.format ?? 'webp'
    const quality = config.quality ?? 0.8
    const mimeType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`

    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), mimeType, quality),
    )

    const arrayBuffer = await blob.arrayBuffer()
    // Store as data URL for inline use, or upload to blob storage
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
    const ref = `data:${mimeType};base64,${base64}`

    return {
      ref,
      width,
      height,
      format,
      sizeBytes: arrayBuffer.byteLength,
    }
  }

  compressVideo(
    frames: ImageData[],
    config?: VideoCompressConfig,
  ): Promise<CompressedVideo> {
    return Promise.reject(
      new Error(
        `Browser video compression not yet implemented (${frames.length} frames, format: ${config?.format ?? 'none'}). Use MediaRecorder API or ffmpeg.wasm.`,
      ),
    )
  }

  compressAudio(
    buffer: AudioBuffer,
    config?: AudioCompressConfig,
  ): Promise<CompressedAudio> {
    return Promise.reject(
      new Error(
        `Browser audio compression not yet implemented (buffer: ${buffer.duration}s, format: ${config?.format ?? 'none'}). Use MediaRecorder API or ffmpeg.wasm.`,
      ),
    )
  }
}

// ─── Passthrough / No-op Compressor ───

/**
 * No-op compression service.
 * Stores media as raw references without transformation.
 * Useful when compression is handled externally or not needed.
 */
export class PassthroughCompressor implements CompressionService {
  async compressImage(
    image: ImageData,
    config?: ImageCompressConfig,
  ): Promise<CompressedImage> {
    const format = config?.format ?? 'png'

    if (typeof document !== 'undefined' && document.createElement) {
      // Browser path — use Canvas for accurate encoding
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')!
      ctx.putImageData(image as ImageData, 0, 0)
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), `image/${format}`),
      )
      const buf = await blob.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      return {
        ref: `data:image/${format};base64,${base64}`,
        width: image.width,
        height: image.height,
        format,
        sizeBytes: buf.byteLength,
      }
    }

    // Node.js / server path — raw RGBA passthrough
    const base64 = btoa(String.fromCharCode(...image.data))
    return {
      ref: `data:image/${format};base64,${base64}`,
      width: image.width,
      height: image.height,
      format,
      sizeBytes: image.data.byteLength,
    }
  }

  async compressVideo(
    frames: ImageData[],
    config?: VideoCompressConfig,
  ): Promise<CompressedVideo> {
    const fps = config?.fps ?? 10
    // Store as sequence of image refs
    const refs: string[] = []
    for (const frame of frames) {
      const img = await this.compressImage(frame)
      refs.push(img.ref)
    }
    const first = frames[0]
    return {
      ref: JSON.stringify(refs),
      width: first.width,
      height: first.height,
      durationMs: (frames.length / fps) * 1000,
      format: 'frame-sequence',
      sizeBytes: refs.reduce((sum, r) => sum + r.length, 0),
    }
  }

  compressAudio(
    buffer: AudioBuffer,
    config?: AudioCompressConfig,
  ): Promise<CompressedAudio> {
    const format = config?.format ?? 'raw'
    // Store raw PCM as base64
    const ch0 = buffer.getChannelData(0)
    const bytes = new Uint8Array(ch0.buffer)
    const base64 = btoa(String.fromCharCode(...bytes))
    return Promise.resolve({
      ref: `data:audio/${format};base64,${base64}`,
      durationMs: buffer.duration * 1000,
      sampleRate: buffer.sampleRate,
      format,
      sizeBytes: bytes.byteLength,
    })
  }
}
