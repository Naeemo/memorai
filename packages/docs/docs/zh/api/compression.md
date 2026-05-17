# 压缩服务

`CompressionService` 负责在存储之前压缩原始媒体。它是**可选的** —— 如果你不传入，Memorai 会原样存储媒体引用。

压缩对 STM 最为重要：流式代理每秒可能产生很多帧，未压缩的 IndexedDB 会迅速填满。

## 接口

```typescript
interface CompressionService {
  // Video: compress frame sequence → keyframes + delta
  compressVideo(frames: ImageData[], config?: VideoCompressConfig): Promise<CompressedVideo>;

  // Audio: compress audio clip
  compressAudio(buffer: AudioBuffer, config?: AudioCompressConfig): Promise<CompressedAudio>;

  // Image: compress single frame
  compressImage(image: ImageData, config?: ImageCompressConfig): Promise<CompressedImage>;
}
```

Memorai 会在以下情况自动调用这些方法：

- 进入的 `WritePayload.raw.media` 包含原始数据（而非引用字符串），**并且**
- 已配置 `CompressionService`。

返回的引用会在存储前替换原始 blob。

## 内置压缩器

```typescript
import { BrowserImageCompressor, PassthroughCompressor } from 'memorai';
```

### `BrowserImageCompressor`

面向浏览器的基于 Canvas 的图像压缩。将 `ImageData` 以可配置质量重新编码为 JPEG/WebP，返回 data-URL 引用。

```typescript
const compression = new BrowserImageCompressor({
  quality: 0.7,
  format: 'image/webp',
});
```

### `PassthroughCompressor`

直通的无操作压缩器，原样返回输入。当你希望禁用压缩但仍保持流水线接线一致时很有用。

```typescript
const compression = new PassthroughCompressor();
```

## 何时自行实现

服务端的视频 / 音频压缩并不简单 —— 大多数项目会借助 `sharp`、`ffmpeg-wasm` 或 `wasm-vips`。该接口故意返回引用，以便你的压缩器可以将工作卸载到 Web Worker、工作线程或完全独立的服务。

```typescript
class SharpImageCompressor implements CompressionService {
  async compressImage(image: ImageData) {
    // ...resize + re-encode via sharp, write to disk, return ref
  }
  // ...
}
```

提示：

- **始终返回稳定的引用。** 对同一输入重新运行流水线应产生相同的 `ref` —— 这是去重得以工作的基础。
- **尽可能在 worker 中压缩。** 基于 Canvas 的 JPEG 编码会阻塞主线程；在 Web Worker 中使用 `OffscreenCanvas` 可以解决。
- **将压缩视为尽力而为。** 如果一帧无法压缩，请回退到原始引用，而不是整个丢弃这段记忆。
