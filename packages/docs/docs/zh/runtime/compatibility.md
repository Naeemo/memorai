# 运行时兼容性与生命周期

Memorai 通过单一代码库面向四种运行时：**Browser**、**Node.js**、**Bun** 和 **Deno**。核心代码不包含任何运行时特定逻辑——所有触及平台的部分都通过可插拔的适配器或服务进行。

## 各运行时的差异

| 特性 | Browser | Node.js | Bun | Deno |
|---|---|---|---|---|
| 默认存储 | [`IndexedDBAdapter`](/zh/api/storage#indexeddbadapter) | 基于 `better-sqlite3` 的 [`SQLiteAdapter`](/zh/api/storage#sqliteadapter) | 基于 `bun:sqlite` 的 [`SQLiteAdapter`](/zh/api/storage#sqliteadapter) | `MemoryAdapter` 或自定义（不支持 `better-sqlite3`） |
| 嵌入服务 | `OpenAIEmbeddingService`、transformers.js 等 | `OllamaEmbeddingService`、`OpenAIEmbeddingService` | 同 Node | 同 Node |
| 压缩 | `BrowserImageCompressor`（基于 Canvas） | `PassthroughCompressor` 或自定义（`sharp`、`ffmpeg-wasm`） | 同上 | 同上 |
| 后台定时器 | `setTimeout` / `setInterval`（标签页激活时运行） | `setTimeout` / `setInterval` | 同上 | 同上 |

Memorai 核心仅使用 Web 标准 API（`fetch`、`crypto`、`URL`、`Promise`、`Map`、`Set`、`ImageData` 类型）。打包器可以无障碍地对其重新打包。

## 选择配置

```typescript
// Browser
import { Memorai, IndexedDBAdapter, OpenAIEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: 'agent-memory' }),
  embedding: new OpenAIEmbeddingService({ apiKey }),
});

// Node.js
import Database from 'better-sqlite3';
import { Memorai, SQLiteAdapter, OllamaEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new SQLiteAdapter(new Database('./memory.db')),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
});
```

## 事件的生命周期

```
┌──────────┐    recordEvent     ┌──────────┐    extract     ┌─────────────┐
│  输入    │ ─────────────────► │  Event   │ ─────────────► │ MemoryNode  │
│  流      │                    │  (input) │                │ (level=seg) │
└──────────┘                    └──────────┘                └──────┬──────┘
                                                                   │
                                                                   ▼ processSegment (L1)
                                                            ┌─────────────┐
                                                            │ MemoryNode  │
                                                            │  atomic_    │
                                                            │  action     │
                                                            └──────┬──────┘
                                                                   │
                                                                   ▼ evolve (L2)
                                                            ┌─────────────┐
                                                            │ MemoryNode  │
                                                            │  episode    │
                                                            └──────┬──────┘
                                                                   │
                                                                   ▼ identify (Tier 2.5)
                                                            ┌─────────────┐
                                                            │ MemoryEvent │
                                                            │ state /     │
                                                            │ transition /│
                                                            │ happening   │
                                                            └─────────────┘

                          recall(question)
                          ─────────────────►
                          扇出 node-level + event-level 检索路径
                          → RRF 融合
                          → 可选 rerank
                          → RecallResult.memories
```

`recordEvent` 采用 fire-and-forget 模式以降低延迟；提取过程在后台进行。`evolve()` 是显式的边界，负责将 HME 情节和已识别的 MemoryEvent 同时发布到召回流程。

## 干净退出

```typescript
// Browser
window.addEventListener('beforeunload', () => memory.close());

// Node.js
process.on('SIGINT', async () => {
  await memory.close();
  process.exit(0);
});
```

`memory.close()` 的行为：

1. 停止后台演化定时器。
2. 当 `evolution.mode = 'auto'` 且 `triggers.onClose !== false`（默认 true）时，可选地执行最后一次 `evolve()` 刷写。
3. 如果你提供了事件存储，则调用 `eventStore.closeEventStore()`。
4. 调用 `storage.close()`。

务必在运行时拆除之前调用它——否则可能泄漏文件句柄，IndexedDB 事务也可能被中止。

## 浏览器专属说明

### 容量配额

IndexedDB 具有源级别的配额（通常为数百 MB；部分浏览器会提示申请更多）。请为长时间运行的浏览器代理规划淘汰策略：

- 使用 `salienceScore` 阈值修剪低重要性的片段。
- 借助 `meta.lastAccessed` 实现 LRU 淘汰。
- 配置 `CompressionService` 在存储前压缩图像 / 音频帧。

### 生命周期钩子

当标签页进入后台时，后台演化定时器会自然暂停（浏览器会限流非活动标签页中的 `setTimeout`）。对于长时间运行的代理，可改为在可见性变更时调度 `evolve()`：

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') memory.evolve();
});
```

## Node / Bun / Deno 说明

### Node + Bun

`SQLiteAdapter` 是推荐的持久化层。在 Node 上使用 `better-sqlite3`；在 Bun 上使用 `bun:sqlite`（可能需要一个小的适配器垫片以匹配 `SQLiteDatabase` 接口——参见 [`api/storage`](/zh/api/storage)）。

### Deno

`better-sqlite3` 无法在 Deno 上运行。可选方案：

- **仅内存** — 使用 `MemoryAdapter`；通过你自己的写出机制实现持久化。
- **自定义适配器** — 基于 Deno KV 或 Deno 原生的 SQLite 库实现 `StorageAdapter`。

包的其余部分（提取器、识别器、检索、演化、召回）在 Deno 上无需改动即可运行。

## 条件导出

Memorai 的 `package.json` 在一个入口下暴露核心，并提供便利的子路径导出（参见 [Subpath Exports](/zh/guide/subpath-exports)）。打包器和 Node 加载器会自动遵守这些配置。
